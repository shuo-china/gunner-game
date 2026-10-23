import { BlockInputEvents, EventTouch, Font, Label, LabelOutline, Mask, Node, Quat, Sprite, UIOpacity, UITransform } from 'cc';
import type { BattleHudState } from '../session/BattleSession';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi, sourceColor } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponConfetti } from './OriginalWeaponConfetti';
import { OriginalWeaponFeedback } from './OriginalWeaponFeedback';
import type { ConfettiRecord } from './OriginalWeaponConfettiMath';
import type { OriginalSfx } from './OriginalSfx';
import { sampleStageCurve, stageAnimationTime, stageTextureOffset } from './OriginalStageTransitionMath';
import type { StageAnimation } from './OriginalStageTransitionMath';

type Kind = 'win' | 'fail' | 'skip';
interface StageUiNode extends OriginalUiNode {
  rotation: [number, number, number, number];
  raycast?: boolean;
  canvasGroup?: { alpha: number; blocksRaycasts: boolean };
  scroll?: { uv: { x: number; y: number; width: number; height: number }; speed: [number, number]; tileSize: number | null };
}
export interface OriginalStageTransitionConfig extends WeaponUiConfig {
  nodes: Record<string, StageUiNode>;
  roots: { win: string; fail: string; skip: string; loading: string; replay: string; explain: string };
  replayIndicator: string; replayExplain: string;
  replayMotion: { node: string; duration: number; ease: number; loop: number; end: number[]; source: string }[];
  bannerAnimation: StageAnimation; loadingAnimation: StageAnimation;
  confetti: ConfettiRecord[]; loadingFade: number; loadingCanvasGroup: string; skipDuration: number;
  sounds: { win: number; fail: number };
  fontSource: { face: { m_Scale: number; m_PointSize: number; m_LineHeight: number } };
}
export interface OriginalStageTransitionAssets { config: OriginalStageTransitionConfig; font: Font; }
interface ScrollView { node: Node; tile: Node; spec: StageUiNode; width: number; height: number; tileWidth: number; tileHeight: number; }

/** Main_UI's original hierarchy, animation clips and automatic transition views.
 * Session snapshots own all timers; this view never advances or restarts a round. */
export class OriginalStageTransition {
  readonly node: Node;
  readonly ui: OriginalWeaponUi;
  private readonly confetti: OriginalWeaponConfetti;
  private readonly fade: UIOpacity;
  private readonly replayNode: Node;
  private readonly explainNode: Node;
  private readonly feedback = new OriginalWeaponFeedback(undefined);
  private readonly scrolls: ScrollView[] = [];
  private transitionId = -1;
  private confettiElapsed = 0;
  private current?: BattleHudState;
  private destroyed = false;
  private replayElapsed = 0;
  private replayActive = false;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: OriginalStageTransitionAssets,
    private readonly sfx?: Pick<OriginalSfx, 'play'>) {
    this.node = makeNode('OriginalStageTransitions', parent);
    const config = assets.config;
    this.ui = new OriginalWeaponUi(art, { config, chineseFont: assets.font, originalFont: assets.font, numberFont: assets.font });
    for (const kind of ['win', 'fail', 'skip', 'loading'] as const) this.ui.create(config.roots[kind], this.node);
    this.replayNode = this.ui.create(config.roots.replay, parent);
    this.explainNode = this.ui.create(config.roots.explain, parent);
    // Unity's root Canvas gets its runtime transform from CanvasScaler.
    this.explainNode.getComponent(UITransform)!.setAnchorPoint(.5, .5);
    const buttonNodes = new Set(Object.values(config.nodes).filter(spec => spec.button).map(spec => this.ui.node(spec.id)));
    for (const spec of Object.values(config.nodes)) {
      const node = this.ui.node(spec.id);
      // Source Y-axis 180° rotations mirror the loading cat/text horizontally.
      // Reducing that quaternion to a Z angle would turn the entire cat upside down.
      node.setRotation(new Quat(...spec.rotation));
      let buttonParent = false;
      for (let p = node.parent; p; p = p.parent) if (buttonNodes.has(p)) buttonParent = true;
      if ((spec.raycast && !buttonParent) || spec.button) node.addComponent(BlockInputEvents);
      // Unity children raycast beyond the disabled button graphic's small rect.
      // Register their touch region and let the event bubble to the source Button.
      if (spec.raycast && buttonParent) {
        node.on(Node.EventType.TOUCH_START, () => {});
        node.on(Node.EventType.TOUCH_END, () => {});
      }
      if (spec.button) {
        let pressed = false;
        const hitRegions = Object.values(config.nodes).filter(candidate => {
          if (!candidate.raycast) return false;
          for (let at: Node | null = this.ui.node(candidate.id); at; at = at.parent) {
            if (at === node) return true;
            if (buttonNodes.has(at)) return false;
          }
          return false;
        }).map(candidate => this.ui.node(candidate.id));
        node.on(Node.EventType.TOUCH_START, () => { pressed = true; this.feedback.press(node, spec); });
        node.on(Node.EventType.TOUCH_END, (event?: EventTouch) => {
          if (!pressed) return;
          pressed = false; this.feedback.release(node);
          if (event && !hitRegions.some(region => region.activeInHierarchy && region.getComponent(UITransform)!.hitTest(event.getLocation()))) return;
          if (spec.clickSound !== undefined) this.sfx?.play(spec.clickSound);
          for (const action of spec.button!) if (action.method === 'SetActive') this.ui.show(action.target, !!action.arguments.m_BoolArgument);
        });
        node.on(Node.EventType.TOUCH_CANCEL, () => { pressed = false; this.feedback.cancelButton(node); });
      }
      if (spec.text) {
        const label = node.getComponent(Label)!;
        label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif';
        label.fontSize = spec.text.size * config.fontSource.face.m_Scale;
        label.lineHeight = label.fontSize * config.fontSource.face.m_LineHeight / config.fontSource.face.m_PointSize;
        // Match the same CN outline material adapter as the original upgrade/weapon UI.
        const outline = node.getComponent(LabelOutline);
        if (outline) outline.color = sourceColor([101, 69, 45, 255]);
      }
      if (spec.scroll) {
        node.getChildByName('OriginalImage')!.active = false;
        const clip = makeNode('OriginalUVClip', node);
        clip.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
        const tile = makeNode('OriginalUVTiles', clip);
        tile.getComponent(UITransform)!.setAnchorPoint(0, 0);
        const image = config.images[spec.image!.sprite!];
        const sprite = tile.addComponent(Sprite);
        sprite.spriteFrame = art.frames.get(image.path)!;
        sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.type = Sprite.Type.TILED; sprite.trim = false;
        sprite.color = sourceColor(spec.image!.color);
        this.scrolls.push({ node, tile, spec, width: 0, height: 0, tileWidth: 0, tileHeight: 0 });
      }
    }
    this.fade = this.ui.node(config.loadingCanvasGroup).addComponent(UIOpacity);
    this.confetti = new OriginalWeaponConfetti(this.ui, config.confetti);
    this.resize(1080, 1920);
    this.clear();
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    if (this.destroyed) return;
    const config = this.assets.config, scale = width / config.referenceWidth;
    const safeHeight = Math.max(0, height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(0, (bottomInset - topInset) / 2, 0);
    for (const kind of ['win', 'fail', 'skip', 'loading', 'replay'] as const) this.ui.layout(config.roots[kind], config.referenceWidth, safeHeight,
      topInset / scale, bottomInset / scale);
    this.replayNode.setScale(scale, scale, 1); this.replayNode.setPosition(0, (bottomInset - topInset) / 2, 0);
    this.ui.layout(config.roots.explain, config.referenceWidth, height / scale);
    this.explainNode.setScale(scale, scale, 1);
    for (const scroll of this.scrolls) {
      const tr = scroll.node.getComponent(UITransform)!, cfg = scroll.spec.scroll!;
      scroll.width = tr.width; scroll.height = tr.height;
      scroll.tileWidth = cfg.tileSize ?? tr.width / cfg.uv.width;
      scroll.tileHeight = cfg.tileSize ?? tr.height / cfg.uv.height;
      const clip = scroll.tile.parent!, image = config.images[scroll.spec.image!.sprite!];
      clip.getComponent(UITransform)!.setContentSize(tr.width, tr.height);
      clip.getComponent(UITransform)!.setAnchorPoint(tr.anchorX, tr.anchorY);
      const sx = scroll.tileWidth / image.sizePx[0], sy = scroll.tileHeight / image.sizePx[1];
      scroll.tile.setScale(sx, sy, 1);
      scroll.tile.getComponent(UITransform)!.setContentSize((tr.width + scroll.tileWidth) / sx, (tr.height + scroll.tileHeight) / sy);
    }
    if (this.current) this.paint(this.current);
  }

  update(state: BattleHudState, dt = 0): void {
    if (this.destroyed) return;
    this.current = state;
    if (state.mode !== 'Main') { this.clear(); return; }
    if (state.stageReplay && !this.replayActive) this.replayElapsed = 0;
    this.replayActive = state.stageReplay;
    if (this.replayActive && !state.paused) this.replayElapsed += Math.max(0, dt);
    this.feedback.update(Math.max(0, dt));
    const transition = state.stageTransition;
    if (transition && transition.id !== this.transitionId) {
      this.transitionId = transition.id;
      this.confettiElapsed = 0; this.confetti.clear();
      this.sfx?.play(this.assets.config.sounds[transition.kind]);
      if (transition.kind === 'win') this.confetti.play();
    }
    if (transition?.kind === 'win') {
      this.confetti.update(Math.max(0, transition.elapsed - this.confettiElapsed));
      this.confettiElapsed = transition.elapsed;
    } else if (!transition) {
      this.confetti.clear(); this.transitionId = -1;
    }
    this.paint(state);
  }

  clear(): void {
    if (this.destroyed) return;
    for (const root of Object.values(this.assets.config.roots)) this.ui.show(root, false);
    this.ui.show(this.assets.config.replayExplain, false);
    this.feedback.clear(); this.replayActive = false; this.replayElapsed = 0;
    this.confetti.clear(); this.transitionId = -1; this.confettiElapsed = 0;
  }

  /** SpeedRun enters/exits through the same global Loading object. This only
   * paints source animation data; the session remains the owner of its clock. */
  showExternalLoading(elapsed: number): void {
    if (this.destroyed) return;
    const config = this.assets.config;
    for (const kind of ['win', 'fail', 'skip', 'replay', 'explain'] as const) this.ui.show(config.roots[kind], false);
    this.ui.show(config.roots.loading, true);
    this.fade.opacity = Math.min(1, Math.max(0, elapsed / config.loadingFade)) * 255;
    this.animate(config.loadingAnimation, elapsed);
    for (const scroll of this.scrolls) {
      if (this.rootKind(scroll.spec.id) !== 'loading') continue;
      const cfg = scroll.spec.scroll!, tr = scroll.node.getComponent(UITransform)!;
      scroll.tile.setPosition(-scroll.width * tr.anchorX + stageTextureOffset(cfg.speed[0], elapsed, scroll.tileWidth, cfg.uv.x),
        -scroll.height * tr.anchorY + stageTextureOffset(cfg.speed[1], elapsed, scroll.tileHeight, cfg.uv.y), 0);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.clear(); this.destroyed = true;
    this.confetti.destroy(); this.ui.destroy(); this.node.destroy(); this.replayNode.destroy(); this.explainNode.destroy();
  }

  private paint(state: BattleHudState): void {
    if (state.mode !== 'Main') { this.clear(); return; }
    const config = this.assets.config, transition = state.stageTransition, skip = state.stageSkip;
    this.replayNode.active = true; this.explainNode.active = true;
    this.ui.show(config.replayIndicator, !!state.stageReplay);
    for (const motion of config.replayMotion) {
      const node = this.ui.node(motion.node), spec = config.nodes[motion.node], cycle = this.replayElapsed / motion.duration;
      if (motion.ease === 7 && motion.loop === 1) {
        const phase = cycle % 2, p = phase < 1 ? phase : 2 - phase;
        const eased = p < .5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        node.setPosition(spec.rect.position[0], spec.rect.position[1] + (motion.end[1] - spec.rect.position[1]) * eased, 0);
      } else if (motion.ease === 1 && motion.loop === 2) node.angle = spec.rect.angle + motion.end[2] * cycle;
    }
    for (const kind of ['win', 'fail'] as const) {
      const active = transition?.kind === kind;
      this.ui.show(config.roots[kind], active);
      if (active) this.animateBanner(kind, transition!.elapsed);
    }
    const skipActive = !!skip && skip.elapsed < config.skipDuration;
    this.ui.show(config.roots.skip, skipActive);
    if (skipActive) this.animateBanner('skip', skip!.elapsed);
    const loadingTime = transition?.loadingElapsed;
    const loading = loadingTime !== null && loadingTime !== undefined;
    this.ui.show(config.roots.loading, loading);
    if (loading) {
      this.fade.opacity = Math.min(1, Math.max(0, loadingTime! / config.loadingFade)) * 255;
      this.animate(config.loadingAnimation, loadingTime!);
    }
    for (const scroll of this.scrolls) {
      const path = scroll.spec.id, cfg = scroll.spec.scroll!;
      const root = this.rootKind(path);
      const elapsed = root === 'loading' ? loadingTime ?? 0 : root === 'skip' ? skip?.elapsed ?? 0 : transition?.elapsed ?? 0;
      const tr = scroll.node.getComponent(UITransform)!;
      scroll.tile.setPosition(-scroll.width * tr.anchorX + stageTextureOffset(cfg.speed[0], elapsed, scroll.tileWidth, cfg.uv.x),
        -scroll.height * tr.anchorY + stageTextureOffset(cfg.speed[1], elapsed, scroll.tileHeight, cfg.uv.y), 0);
    }
  }

  private rootKind(id: string): Kind | 'loading' {
    const node = this.ui.node(id);
    for (const kind of ['win', 'fail', 'skip', 'loading'] as const) {
      const root = this.ui.node(this.assets.config.roots[kind]);
      for (let parent: Node | null = node; parent; parent = parent.parent) if (parent === root) return kind;
    }
    throw new Error(`Stage UI node outside a source root: ${id}`);
  }

  private animateBanner(kind: Kind, elapsed: number): void {
    const config = this.assets.config;
    const panel = config.nodes[config.roots[kind]].children.find(id => config.nodes[id].name === 'Panel')!;
    this.animate(config.bannerAnimation, elapsed, panel);
  }

  private animate(animation: StageAnimation, elapsed: number, target?: string): void {
    const time = stageAnimationTime(animation, elapsed);
    for (const binding of animation.bindings) {
      const node = this.ui.node(target ?? binding.node), values = binding.curves.map(curve => sampleStageCurve(curve, time));
      if (binding.property === 'scale') node.setScale(values[0], values[1], values[2]);
      else if (binding.property === 'euler') node.setRotationFromEuler(values[0], values[1], values[2]);
      else if (binding.property === 'x') node.setPosition(values[0], node.position.y, node.position.z);
      else node.setPosition(node.position.x, values[0], node.position.z);
    }
  }
}
