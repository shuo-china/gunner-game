import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, Color, EventTouch, Font, Graphics, Mask, Node, UITransform, Vec3 } from 'cc';
import type { RewardedAdPresenter, RewardedAdOutcome } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponConfetti } from './OriginalWeaponConfetti';
import type { ConfettiRecord } from './OriginalWeaponConfettiMath';

interface Curve { time: number; coefficients: number[]; }
interface Bounce { duration: number; scale: number; middle?: number; }
interface Animation { duration: number; tracks: { node: string; property: 'active' | 'alpha'; curves: Curve[]; bounce?: Bounce }[]; }
interface ButtonColors { target: string; transition: number; normal: number[]; disabled: number[]; highlighted: number[]; pressed: number[]; selected: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean; }
type ChallengeNode = OriginalUiNode & { bounceStart?: Bounce; buttonColors?: ButtonColors };
interface ButtonTint { spec: ChallengeNode; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; }
export interface SpeedRunUiConfig extends WeaponUiConfig {
  nodes: Record<string, ChallengeNode>;
  treeIcons: string[];
  animations: { win: Animation; fail: Animation };
  confetti: ConfettiRecord[];
  rotations: { node: string; duration: number; angle: number; delay: number }[];
  fills: { node: string; direction: number }[];
}
export interface SpeedRunHudAssets extends WeaponHudAssets { config: SpeedRunUiConfig; }
export interface SpeedRunHudState {
  unlocked: boolean; stage: number; reward: number; additionalReward: number; totalReward: number; money: string; diamonds: string;
  phase: 'idle' | 'entering' | 'playing' | 'won' | 'failed' | 'adPending' | 'exiting';
  progress: number; remainingSeconds: number; resultElapsed: number; adAvailable: boolean; adEnabled: boolean;
  loadingElapsed?: number | null;
}
interface ActionResult { ok: boolean; reason?: string; token?: string; }
export interface SpeedRunHudCallbacks {
  getState(): SpeedRunHudState;
  getPhase?(): SpeedRunHudState['phase'];
  start(): ActionResult;
  exit(): ActionResult;
  beginAd(): ActionResult;
  completeAd(token: string, outcome: 'success' | 'cancel' | 'failure'): ActionResult;
  cancelAd(): void;
  onBeforeOpen?(): void;
  onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void;
  playSfx?(id: number): void;
}

export async function loadSpeedRunHudAssets(art: ArtLibrary): Promise<SpeedRunHudAssets> {
  const config = await art.json<SpeedRunUiConfig>('art/speedrun-system/config');
  if (config.version !== 1 || !config.roots.start || !config.bitmapFonts) throw new Error('Invalid original challenge UI');
  const paths = Object.values(config.images).map(spec => spec.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await Promise.all(paths.map(path => art.loadFrame(path)));
  const placeholder = new Font();
  return { config, chineseFont: placeholder, originalFont: placeholder, numberFont: placeholder };
}

/** The retained ordinary challenge uses original Unity graphics and geometry.
 * The session alone owns progression, reward claims and advertising tokens. */
export class SpeedRunHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui: OriginalWeaponUi;
  private readonly roots = new Map<string, Node>();
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private confetti!: OriginalWeaponConfetti;
  private readonly touches = new Map<Node, { id: number }>();
  private readonly graphics = new Map<Node, Node[]>();
  private readonly tints = new Map<Node, ButtonTint>();
  private readonly hovered = new Set<Node>();
  private readonly fillSizes = new Map<string, { width: number; height: number; x: number; y: number }>();
  private selected: Node | null = null;
  private adToken: string | null = null;
  private startOpen = false;
  private startElapsed = 0;
  private entryVisible = true;
  private entryBlocked = false;
  private lastVisible = false;
  private previousPhase: SpeedRunHudState['phase'] = 'idle';
  private destroyed = false;
  private width = 1080;
  private height = 1920;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: SpeedRunHudAssets, private readonly callbacks: SpeedRunHudCallbacks,
    private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalSpeedRunHud', parent);
    this.ui = new OriginalWeaponUi(art, assets);
    const initialize = function* (this: SpeedRunHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, this.node)); root.active = name === 'entry'; this.roots.set(name, root);
        if (['start', 'win', 'fail'].includes(name)) {
          root.addComponent(BlockInputEvents);
          root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
        }
      }
      this.confetti = new OriginalWeaponConfetti(this.ui, assets.config.confetti);
      for (const spec of Object.values(assets.config.nodes)) { this.bindButton(spec); yield; }
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps(this.callbacks.getState()));
      const state = this.callbacks.getState();
      if (state.phase !== 'idle') this.updateState(0, state, false);
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }

  get isOpen(): boolean { return this.startOpen || this.adToken !== null || (this.callbacks.getPhase?.() ?? this.callbacks.getState().phase) !== 'idle'; }
  get blocksUpgrades(): boolean { const phase = this.callbacks.getPhase?.() ?? this.callbacks.getState().phase; return this.startOpen || this.adToken !== null || (phase !== 'idle' && phase !== 'playing'); }
  setEntryVisible(visible: boolean): void { if (this.entryVisible === visible) return; this.entryVisible = visible; this.refreshEntry(this.callbacks.getState()); }
  setEntryBlocked(blocked: boolean): void {
    this.entryBlocked = blocked;
    if (!blocked || this.destroyed) return;
    const entry = this.roots.get('entry')!;
    this.touches.delete(entry); this.feedback.cancelButton(entry); this.hovered.delete(entry);
    if (this.selected === entry) this.selected = null;
    this.setTint(entry, true);
  }
  open(): void {
    if (this.destroyed || this.callbacks.getState().phase !== 'idle') return;
    if (!this.callbacks.getState().unlocked) return;
    this.callbacks.onBeforeOpen?.(); this.startOpen = true; this.startElapsed = 0;
    this.update(0); this.notify();
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.startOpen = false; this.refresh(this.callbacks.getState()); this.notify();
  }
  cancelInteractions(): void {
    this.touches.clear(); this.feedback.clear(); this.selected = null; this.hovered.clear();
    if (this.adToken !== null) {
      const token = this.adToken; this.adToken = null;
      this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd();
    }
    for (const node of this.tints.keys()) this.setTint(node, true);
  }
  private entryOffset = 355;
  setEntryOffset(y: number): void { this.entryOffset = y; this.roots.get('entry')!.setPosition(this.width / 2, -this.height / 2 + y); }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0, refresh = true): Generator<void> {
    if (this.destroyed || width <= 0 || height <= 0) return;
    this.touches.clear(); this.feedback.clear();
    const scale = width / this.assets.config.referenceWidth;
    this.width = width / scale; this.height = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(this.width, this.height);
    for (const [name, id] of Object.entries(this.assets.config.roots)) yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : this.width, name === 'entry' ? 120 : this.height,
      name === 'entry' ? 0 : topInset / scale, name === 'entry' ? 0 : bottomInset / scale);
    // Source Right_Menu begins at the lower right, opposite the weapon entry.
    this.roots.get('entry')!.setPosition(this.width / 2, -this.height / 2 + this.entryOffset);
    this.fillSizes.clear();
    for (const spec of this.assets.config.fills) {
      const node = this.ui.node(spec.node), tr = node.getComponent(UITransform)!;
      this.fillSizes.set(spec.node, { width: tr.width, height: tr.height, x: node.position.x, y: node.position.y });
      const mask = node.getComponent(Mask) || node.addComponent(Mask); mask.type = Mask.Type.GRAPHICS_RECT; yield;
    }
    if (refresh) yield* this.refreshSteps(this.callbacks.getState());
  }
  update(dt: number, state = this.callbacks.getState()): void {
    this.updateState(dt, state, true);
  }
  private updateState(dt: number, state: SpeedRunHudState, refresh: boolean): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed); this.updateTints(elapsed, state);
    if (this.startOpen) this.startElapsed += elapsed;
    if (state.phase !== 'idle') this.startOpen = false;
    const result = state.phase === 'won' || state.phase === 'failed' || state.phase === 'adPending';
    const wasResult = ['won', 'failed', 'adPending'].includes(this.previousPhase);
    if (result && !wasResult) {
      this.touches.clear(); this.feedback.clear();
      if (state.phase !== 'failed') this.confetti.play();
      this.callbacks.playSfx?.(state.phase === 'failed' ? 12 : 11);
    } else if (!result && wasResult) this.confetti.clear();
    if (state.phase !== 'adPending') {
      if (this.adToken !== null) {
        const token = this.adToken; this.adToken = null;
        this.touches.clear(); this.rewardedAds?.cancelRewardedAd(token);
      }
    }
    if (refresh) this.refresh(state);
    if (this.startOpen) this.bounce(this.ui.node('level0:1825'), this.assets.config.nodes['level0:1825'].bounceStart!, this.startElapsed);
    if (result) {
      const animation = state.phase === 'failed' ? this.assets.config.animations.fail : this.assets.config.animations.win;
      this.animateResult(animation, state.resultElapsed);
      this.confetti.update(elapsed);
      for (const rotation of this.assets.config.rotations) {
        const node = this.ui.node(rotation.node);
        if (visibleInHierarchy(node)) node.angle = this.assets.config.nodes[rotation.node].rect.angle + Math.max(0, state.resultElapsed - rotation.delay) / rotation.duration * rotation.angle;
      }
    }
    // Keep the main button's reveal animation in both advertising modes.
    // Apply the mode-specific decorations and skip area after animated tracks.
    this.applyAdVisibility(state);
    this.previousPhase = state.phase; this.notify();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.cancelInteractions(); this.confetti.destroy(); this.destroyed = true;
    this.node.destroy(); this.ui.destroy(); this.tints.clear(); this.graphics.clear();
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    this.confetti?.destroy();
  }


  private refreshEntry(state: SpeedRunHudState): void {
    this.roots.get('entry')!.active = this.entryVisible && state.unlocked && state.phase === 'idle';
  }

  private refresh(state: SpeedRunHudState): void {
    for (const _ of this.refreshSteps(state)) { /* synchronous state refresh */ }
  }

  private *refreshSteps(state: SpeedRunHudState): Generator<void> {
    const result = state.phase === 'won' || state.phase === 'failed' || state.phase === 'adPending';
    this.roots.get('entry')!.active = this.entryVisible && state.unlocked && state.phase === 'idle';
    this.roots.get('start')!.active = this.startOpen && state.phase === 'idle';
    this.roots.get('battle')!.active = state.phase === 'playing' || result;
    this.roots.get('win')!.active = state.phase === 'won' || state.phase === 'adPending';
    this.roots.get('fail')!.active = state.phase === 'failed';
    if (this.initialized && state.phase === 'idle' && !this.startOpen) return;
    this.ui.setText('level0:121392', `Stage ${state.stage + 1}`); yield;
    const trees = this.assets.config.treeIcons;
    this.ui.image('level0:123236', trees[(Math.max(0, state.stage) * 4) % trees.length]); yield;
    this.ui.setText('level0:117170', String(state.reward)); yield;
    // The large win amount advertises the optional total only while ads are
    // enabled; an ad-free release must show the reward actually granted.
    this.ui.setText('level0:117223', String(state.adEnabled ? state.totalReward : state.reward)); yield;
    this.ui.setText('level0:117137', String(state.reward)); yield;
    this.ui.setText('level0:117389', '0'); yield;
    this.ui.setText('level0:117195', `${Math.floor(clamp(state.progress) * 100)}%`); yield;
    // Native Time_Reload truncates remaining + 1; failure's terminal update
    // displays zero after the timer crossed below zero.
    this.ui.setText('level0:117305', `${state.phase === 'failed' ? 0 : Math.max(0, Math.trunc(state.remainingSeconds + 1))}s`); yield;
    this.ui.setText('level0:117723', state.money); yield;
    this.ui.setText('level0:119571', state.diamonds); yield;
    this.fill('level0:1318', state.remainingSeconds / 60);
    this.fill('level0:2051', state.progress);
    for (const node of this.tints.keys()) { this.setTint(node, false, state); yield; }
    this.applyAdVisibility(state);
  }
  private applyAdVisibility(state: SpeedRunHudState): void {
    this.ui.show('level0:857', state.adEnabled);
    this.ui.show('level0:1144', state.adEnabled);
    this.ui.show('level0:934', state.adEnabled);
    if (!state.adEnabled && this.adToken !== null) this.cancelInteractions();
  }
  private fill(key: string, value: number): void {
    const size = this.fillSizes.get(key); if (!size) return;
    const node = this.ui.node(key), tr = node.getComponent(UITransform)!;
    tr.setAnchorPoint(0, .5); tr.setContentSize(size.width * clamp(value), size.height);
    node.setPosition(size.x - size.width / 2, size.y);
    const image = node.children.find(child => child.name === 'OriginalImage');
    if (image) {
      image.active = value > 0; image.getComponent(UITransform)!.setAnchorPoint(.5, .5);
      image.getComponent(UITransform)!.setContentSize(size.width, size.height); image.setPosition(size.width / 2, 0);
    }
  }
  private animateResult(animation: Animation, elapsed: number): void {
    for (const track of animation.tracks) {
      const node = this.ui.node(track.node), value = curveValue(track.curves, elapsed);
      if (track.property === 'alpha') {
        const spec = this.assets.config.nodes[track.node], child = node.children.find(n => n.name === 'OriginalImage');
        const graphic = child?.getComponent(Graphics);
        if (graphic) { graphic.fillColor = new Color(...[...(spec.image?.color.slice(0, 3) ?? [0, 0, 0]), Math.round(clamp(value) * 255)] as [number, number, number, number]); this.redrawSolid(child!); }
      } else {
        node.active = value >= .5;
        if (track.bounce) {
          const start = track.curves.find(key => key.coefficients[3] >= .5)?.time ?? Infinity;
          this.bounce(node, track.bounce, elapsed - start);
        }
      }
    }
    // These nested components receive OnEnable with their parent, including
    // Dia's own spring and Skip_obj before its timed child becomes active.
    for (const [key, start] of [['level0:1671', .5833333134651184], ['level0:114', .5833333134651184], ['level0:934', 0]] as const) {
      const node = this.ui.node(key), bounce = this.assets.config.nodes[key].bounceStart;
      if (bounce && visibleInHierarchy(node)) this.bounce(node, bounce, elapsed - start);
    }
  }
  private bounce(node: Node, bounce: Bounce, elapsed: number): void {
    const split = bounce.duration * (bounce.middle ?? .6), t = Math.max(0, elapsed);
    const value = t < split ? bounce.scale * t / split : t < bounce.duration ? bounce.scale + (1 - bounce.scale) * (t - split) / (bounce.duration - split) : 1;
    node.setScale(value, value, 1);
  }
  private redrawSolid(node: Node): void {
    const tr = node.getComponent(UITransform)!, graphics = node.getComponent(Graphics);
    if (!graphics) return; graphics.clear(); graphics.rect(-tr.width * tr.anchorX, -tr.height * tr.anchorY, tr.width, tr.height); graphics.fill();
  }
  private front(node: Node): boolean {
    if (this.entryBlocked && node === this.roots.get('entry')) return false;
    if (this.adToken !== null) return false;
    const front = ['fail', 'win', 'start', 'battle', 'entry'].map(name => this.roots.get(name)!).find(root => root.active);
    for (let current: Node | null = node; current; current = current.parent) if (current === front) return true;
    return false;
  }
  private interactable(spec: ChallengeNode, snapshot?: SpeedRunHudState): boolean {
    if (spec.buttonColors?.interactable === false) return false;
    const state = snapshot ?? this.callbacks.getState(), phase = state.phase;
    if (phase === 'entering' || phase === 'exiting' || phase === 'adPending') return false;
    if (spec.button?.some(call => call.method === 'Bonus_AD_Show')) return phase === 'won' && (!state.adEnabled || state.adAvailable);
    return true;
  }
  private contains(node: Node, at: { x: number; y: number }): boolean {
    return (this.graphics.get(node) ?? []).some(graphic => {
      if (!visibleInHierarchy(graphic)) return false;
      const tr = graphic.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return p.x >= -tr.width * tr.anchorX && p.x <= tr.width * (1 - tr.anchorX) && p.y >= -tr.height * tr.anchorY && p.y <= tr.height * (1 - tr.anchorY);
    });
  }
  private bindButton(spec: ChallengeNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id), graphics: Node[] = [];
    const collect = (entry: OriginalUiNode): void => {
      if (entry !== spec && entry.button) return;
      if ((entry.image && entry.image.raycast !== false) || (entry.text && entry.text.raycast !== false)) graphics.push(this.ui.node(entry.id));
      entry.children.forEach(key => collect(this.assets.config.nodes[key]));
    };
    collect(spec); this.graphics.set(node, graphics);
    if (spec.buttonColors?.transition === 1) {
      const normal = spec.buttonColors.normal.slice(); this.tints.set(node, { spec, current: normal, from: normal, to: normal, elapsed: 0, duration: 0 });
      this.setTint(node, true);
    }
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.touches.get(node)?.id !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node); this.setTint(node);
      if (!click || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node, event.getUILocation()) || !this.interactable(spec)) return;
      for (const action of spec.button!) this.invoke(action.method, action.target);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound);
      this.update(0);
    };
    for (const graphic of graphics) {
      graphic.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        if (!this.front(node) || this.touches.has(node)) return;
        this.touches.set(node, { id: event.getID() ?? -1 }); this.selected = node; this.feedback.press(node, spec); this.setTint(node);
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.setTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.setTint(node); });
    }
  }
  private setTint(node: Node, immediate = false, snapshot?: SpeedRunHudState): void {
    const state = this.tints.get(node), colors = state?.spec.buttonColors; if (!state || !colors) return;
    const to = !this.interactable(state.spec, snapshot) ? colors.disabled : this.touches.has(node) ? colors.pressed : this.selected === node ? colors.selected : this.hovered.has(node) ? colors.highlighted : colors.normal;
    if (!immediate && state.to.every((value, i) => value === to[i])) return;
    if (immediate && !state.duration && state.current.every((value, i) => value === to[i])) return;
    state.from = state.current.slice(); state.to = to.slice(); state.elapsed = 0; state.duration = immediate ? 0 : colors.fadeDuration;
    if (!state.duration) { state.current = state.to.slice(); this.renderTint(state); }
  }
  private renderTint(state: ButtonTint): void {
    const colors = state.spec.buttonColors!, base = state.spec.image?.color ?? [255, 255, 255, 255];
    this.ui.tint(colors.target, base.map((value, i) => Math.round(Math.min(255, value * state.current[i] * colors.colorMultiplier / 255))));
  }
  private updateTints(dt: number, snapshot?: SpeedRunHudState): void {
    for (const [node, state] of this.tints) {
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.setTint(node, true, snapshot); }
      if (!state.duration) continue;
      state.elapsed += dt; const t = Math.min(1, state.elapsed / state.duration);
      state.current = state.from.map((value, i) => value + (state.to[i] - value) * t); this.renderTint(state);
      if (t === 1) state.duration = 0;
    }
  }
  private invoke(method: string, target: string): void {
    if (method === 'Reload' && target === 'level0:124103') this.open();
    else if (method === 'SetActive' && target === this.assets.config.roots.start) { this.startOpen = false; }
    else if (method === 'Game_Enter') { const result = this.callbacks.start(); if (!result.ok) this.failure(result.reason); }
    else if (method === 'Game_Exit') { const result = this.callbacks.exit(); if (!result.ok) this.failure(result.reason); }
    else if (method === 'Bonus_AD_Show') {
      const state = this.callbacks.getState();
      if (state.phase !== 'won') return;
      if (!state.adEnabled) {
        // Victory already saved the base reward; this only confirms and exits.
        const result = this.callbacks.exit(); if (!result.ok) this.failure(result.reason);
        return;
      }
      if (!state.adAvailable) return;
      const result = this.callbacks.beginAd();
      if (result.ok && result.token) {
        const token = result.token; this.adToken = token;
        const complete = (outcome: RewardedAdOutcome): void => {
          if (this.destroyed || this.adToken !== token) return;
          this.adToken = null;
          const result = this.callbacks.completeAd(token, outcome);
          if (!result.ok && outcome !== 'cancel') this.failure(outcome === 'failure' ? 'adFailed' : result.reason);
          this.update(0);
        };
        if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, 'speedrun', complete); else complete('failure');
      }
      else this.failure(result.reason);
    }
  }
  private failure(reason?: string): void { if (reason === 'failure' || reason === 'adFailed') this.callbacks.alert?.('广告加载失败。'); }
  private notify(): void {
    if (this.destroyed) return;
    const visible = this.isOpen;
    if (visible !== this.lastVisible) { this.lastVisible = visible; this.callbacks.onVisibilityChanged?.(visible); }
  }

}

function clamp(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function curveValue(keys: Curve[], time: number): number {
  let key = keys[0]; for (const next of keys) { if (next.time > time) break; key = next; }
  if (!key) return 0; const t = Math.max(0, time - key.time), c = key.coefficients;
  return ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
}
