import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, Color, EventTouch, Font, Graphics, Mask, Node, UITransform, Vec3 } from 'cc';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import type { RewardedAdPresenter, RewardedAdOutcome } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponConfetti } from './OriginalWeaponConfetti';
import type { ConfettiRecord } from './OriginalWeaponConfettiMath';

interface Curve { time: number; coefficients: number[]; }
interface Bounce { duration: number; scale: number; middle?: number; }
interface Animation { duration: number; tracks: { node: string; property: 'active' | 'alpha' | 'scale' | 'y'; curves: Curve[]; channels: Curve[][]; bounce?: Bounce }[]; }
interface ButtonColors { target: string; transition: number; normal: number[]; disabled: number[]; highlighted: number[]; pressed: number[]; selected: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean; }
type MineNode = OriginalUiNode & { bounceStart?: Bounce; buttonColors?: ButtonColors };
interface ButtonTint { spec: MineNode; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; }
export interface MineUiConfig extends WeaponUiConfig {
  nodes: Record<string, MineNode>;
  animations: { result: Animation };
  confetti: ConfettiRecord[];
  rotations: { node: string; duration: number; angle: number; delay: number; type: number; end: number[]; loopType: number; ease: number; relative: boolean }[];
  fills: { node: string; direction: number }[];
  ticketDisabledColor: number[];
}
export interface MineHudAssets extends WeaponHudAssets { config: MineUiConfig; }
export interface MineHudState {
  phase: 'idle' | 'preparing' | 'entering' | 'playing' | 'result' | 'adPending' | 'exiting';
  adKind: 'entry' | 'reward' | null;
  visible: boolean; unlocked: boolean; requiredStage: number;
  remainingTickets: number; usedEntries: number; freeEntriesPerDay: number;
  bestReward: number; score: number; rewardDiamonds: number; additionalRewardDiamonds: number;
  timeRemaining: number; timeLimit: number; oreCountNow: number; oreCountMax: number;
  loadingElapsed: number | null; resultElapsed: number;
  adsEnabled: boolean; speedAdAvailable: boolean; bonusAdAvailable: boolean;
  speedBuffRemainingSeconds: number; speedBuffMultiplier: number;
  settlementPending: boolean;
}
interface ActionResult { ok: boolean; reason?: string; token?: string; }
export interface MineHudCallbacks {
  getState(): MineHudState;
  getPhase?(): MineHudState['phase'];
  open(): ActionResult;
  close(): ActionResult;
  start(): ActionResult;
  exit(): ActionResult;
  beginAd(kind: 'entry' | 'reward'): ActionResult;
  completeAd(token: string, outcome: RewardedAdOutcome): ActionResult;
  cancelAd(): void;
  retrySettlement?(): ActionResult;
  onBeforeOpen?(): void;
  onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void;
  playSfx?(id: number): void;
}

export async function loadMineHudAssets(art: ArtLibrary): Promise<MineHudAssets> {
  const config = await art.json<MineUiConfig>('art/mine-system/config');
  if (config.version !== 1 || !config.roots.start || !config.roots.result || !config.bitmapFonts) throw new Error('Invalid original Mine UI');
  const paths = Object.values(config.images).map(spec => spec.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await Promise.all(paths.map(path => art.loadFrame(path)));
  const placeholder = new Font();
  return { config, chineseFont: placeholder, originalFont: placeholder, numberFont: placeholder };
}

/** Original Mine layouts, bitmap lettering and animations. Session owns entry,
 * tickets, score, settlement and both rewarded-ad transactions. */
export class MineHud {
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
  private readonly basePositions = new Map<string, { x: number; y: number }>();
  private selected: Node | null = null;
  private adToken: string | null = null;
  private startElapsed = 0;
  private battleElapsed = 0;
  private entryVisible = true;
  private entryBlocked = false;
  private entryOffset = 480;
  private lastVisible = false;
  private previousPhase: MineHudState['phase'] = 'idle';
  private previousResult = false;
  private destroyed = false;
  private width = 1080;
  private height = 1920;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: MineHudAssets, private readonly callbacks: MineHudCallbacks,
    private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalMineHud', parent);
    this.ui = new OriginalWeaponUi(art, assets);
    const initialize = function* (this: MineHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, this.node)); root.active = name === 'entry'; this.roots.set(name, root);
        if (['start', 'result'].includes(name)) {
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

  get isOpen(): boolean { return this.adToken !== null || (this.callbacks.getPhase?.() ?? this.callbacks.getState().phase) !== 'idle'; }
  get blocksUpgrades(): boolean { const phase = this.callbacks.getPhase?.() ?? this.callbacks.getState().phase; return this.adToken !== null || (phase !== 'idle' && phase !== 'playing'); }
  setEntryVisible(visible: boolean): void { if (this.entryVisible === visible) return; this.entryVisible = visible; this.refreshEntry(this.callbacks.getState()); }
  setEntryOffset(y: number): void { this.entryOffset = y; this.roots.get('entry')!.setPosition(this.width / 2, -this.height / 2 + y); }
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
    const state = this.callbacks.getState();
    if (!state.unlocked) { this.callbacks.alert?.(this.assets.config.translations['Alarm/StageUnlock'].replace('{0}', String(state.requiredStage))); return; }
    this.callbacks.onBeforeOpen?.();
    const result = this.callbacks.open(); if (!result.ok) this.failure(result.reason);
    this.startElapsed = 0; this.update(0);
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions();
    if (this.callbacks.getState().phase === 'preparing') { const result = this.callbacks.close(); if (!result.ok) this.failure(result.reason); }
    this.update(0);
  }
  cancelInteractions(): void {
    this.touches.clear(); this.feedback.clear(); this.selected = null; this.hovered.clear();
    if (this.adToken !== null) {
      const token = this.adToken; this.adToken = null;
      this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd();
    }
    for (const node of this.tints.keys()) this.setTint(node, true);
  }
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
    this.setEntryOffset(this.entryOffset);
    this.basePositions.clear();
    for (const key of Object.keys(this.assets.config.nodes)) { const p = this.ui.node(key).position; this.basePositions.set(key, { x: p.x, y: p.y }); yield; }
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
  private updateState(dt: number, state: MineHudState, refresh: boolean): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed); this.updateTints(elapsed, state);
    const preparing = state.phase === 'preparing' || state.phase === 'adPending' && state.adKind === 'entry';
    const result = this.isResult(state);
    if (preparing) this.startElapsed += elapsed;
    if (state.phase === 'playing' && this.previousPhase !== 'playing') this.battleElapsed = 0;
    if (state.phase === 'playing') this.battleElapsed += elapsed;
    if (result && !this.previousResult) { this.touches.clear(); this.feedback.clear(); this.confetti.play(); this.callbacks.playSfx?.(11); }
    else if (!result && this.previousResult) this.confetti.clear();
    if (state.phase !== 'adPending' && this.adToken !== null) {
      const token = this.adToken; this.adToken = null; this.touches.clear(); this.rewardedAds?.cancelRewardedAd(token);
    }
    if (refresh) this.refresh(state);
    if (preparing) this.bounce(this.ui.node('level0:1358'), this.assets.config.nodes['level0:1358'].bounceStart!, this.startElapsed);
    if (result) { this.animate(this.assets.config.animations.result, state.resultElapsed); this.confetti.update(elapsed); }
    for (const tween of this.assets.config.rotations) {
      const node = this.ui.node(tween.node); if (!visibleInHierarchy(node)) continue;
      const clock = result ? state.resultElapsed : preparing ? this.startElapsed : this.battleElapsed;
      const t = Math.max(0, clock - tween.delay) / tween.duration;
      const cycle = tween.loopType === 1 ? (Math.floor(t) % 2 ? 1 - t % 1 : t % 1) : t % 1;
      const eased = tween.ease === 6 ? 1 - (1 - cycle) * (1 - cycle) : tween.ease === 7 ? (cycle < .5 ? 2 * cycle * cycle : 1 - Math.pow(-2 * cycle + 2, 2) / 2) : cycle;
      const spec = this.assets.config.nodes[tween.node];
      if (tween.type === 3) node.angle = spec.rect.angle + t * tween.angle;
      else if (tween.type === 5) node.setScale(spec.rect.scale[0] + (tween.end[0] - spec.rect.scale[0]) * eased,
        spec.rect.scale[1] + (tween.end[1] - spec.rect.scale[1]) * eased, 1);
      else if (tween.type === 1) {
        const base = this.basePositions.get(tween.node)!;
        node.setPosition(base.x + (tween.end[0] - (tween.relative ? 0 : spec.rect.position[0])) * eased,
          base.y + (tween.end[1] - (tween.relative ? 0 : spec.rect.position[1])) * eased, 0);
      }
    }
    this.applyAdVisibility(state);
    this.previousResult = result; this.previousPhase = state.phase; this.notify();
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

  private isResult(state: MineHudState): boolean { return state.phase === 'result' || state.phase === 'adPending' && state.adKind === 'reward'; }
  private refreshEntry(state: MineHudState): void {
    this.roots.get('entry')!.active = this.entryVisible && state.visible && state.phase === 'idle';
  }

  private refresh(state: MineHudState): void {
    for (const _ of this.refreshSteps(state)) { /* synchronous state refresh */ }
  }

  private *refreshSteps(state: MineHudState): Generator<void> {
    const result = this.isResult(state);
    this.roots.get('entry')!.active = this.entryVisible && state.visible && state.phase === 'idle';
    this.ui.show('level0:2246', !state.unlocked); yield;
    this.roots.get('start')!.active = state.phase === 'preparing' || state.phase === 'adPending' && state.adKind === 'entry';
    this.roots.get('battle')!.active = state.phase === 'playing' || result;
    this.roots.get('result')!.active = result;
    if (this.initialized && state.phase === 'idle') return;
    this.ui.setText('level0:1973', `${state.remainingTickets}/${state.freeEntriesPerDay}`); yield;
    this.ui.tint('level0:1973', state.remainingTickets > 0 ? this.assets.config.nodes['level0:1973'].text!.color : this.assets.config.ticketDisabledColor); yield;
    // Only the removed sweep branch previews the stored best reward.
    this.ui.setText('level0:1527', '?'); yield;
    // Mine_Slider.Reload casts remaining + 1; the original starts at 61s.
    this.ui.setText('level0:1965', `${Math.trunc(Math.max(0, state.timeRemaining) + 1)}s`); yield;
    this.ui.setText('level0:9837', (state.score / ECONOMY_CONFIG.mine.scorePerDiamond).toFixed(1)); yield;
    this.ui.setText('level0:231', String(state.rewardDiamonds + (state.adsEnabled && !state.settlementPending ? state.additionalRewardDiamonds : 0))); yield;
    this.ui.setText('level0:10352', state.settlementPending ? '重试领取' : this.assets.config.translations['Mine/Ok']); yield;
    this.ui.setText('level0:645', String(state.rewardDiamonds)); yield;
    this.ui.setText('level0:1913', `x${ECONOMY_CONFIG.mine.speedBuffMultiplier}`); yield;
    this.ui.setText('level0:1827', `x${1 + ECONOMY_CONFIG.mine.adAdditionalMultiplier}`); yield;
    this.fill('level0:73', state.oreCountMax > 0 ? state.oreCountNow / state.oreCountMax : 0);
    this.fill('level0:1377', state.timeLimit > 0 ? state.timeRemaining / state.timeLimit : 0);
    for (const node of this.tints.keys()) { this.setTint(node, false, state); yield; }
    this.applyAdVisibility(state);
  }
  private applyAdVisibility(state: MineHudState): void {
    this.ui.show('level0:1058', state.adsEnabled && (state.speedAdAvailable || state.phase === 'adPending' && state.adKind === 'entry'));
    this.ui.show('level0:131', state.adsEnabled && !state.settlementPending);
    this.ui.show('level0:928', !state.adsEnabled || state.settlementPending);
    this.ui.show('level0:1749', state.adsEnabled && !state.settlementPending);
    if (!state.adsEnabled && this.adToken !== null) this.cancelInteractions();
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
  private animate(animation: Animation, elapsed: number): void {
    for (const track of animation.tracks) {
      const node = this.ui.node(track.node), value = curveValue(track.curves, elapsed);
      if (track.property === 'scale') {
        node.setScale(curveValue(track.channels[0], elapsed), curveValue(track.channels[1], elapsed), 1);
      } else if (track.property === 'y') {
        const base = this.basePositions.get(track.node)!;
        node.setPosition(base.x, base.y + value - this.assets.config.nodes[track.node].rect.position[1]);
      } else if (track.property === 'alpha') {
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
    if (animation === this.assets.config.animations.result) for (const [key, start] of [['level0:510', .5833333134651184], ['level0:1749', 1.5]] as const) {
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
    const front = ['result', 'start', 'battle', 'entry'].map(name => this.roots.get(name)!).find(root => root.active);
    for (let current: Node | null = node; current; current = current.parent) if (current === front) return true;
    return false;
  }
  private interactable(spec: MineNode, snapshot?: MineHudState): boolean {
    if (spec.buttonColors?.interactable === false) return false;
    const state = snapshot ?? this.callbacks.getState(), phase = state.phase;
    if (state.settlementPending) return spec.id === 'level0:928';
    if (phase === 'entering' || phase === 'exiting' || phase === 'adPending') return false;
    if (spec.button?.some(call => call.method === 'Game_Enter')) return phase === 'preparing';
    if (spec.button?.some(call => call.method === 'AD_SpeedBuff_Watch')) return phase === 'preparing' && state.speedAdAvailable;
    if (spec.button?.some(call => call.method === 'Bonus_AD_Show')) return phase === 'result' && state.bonusAdAvailable;
    return true;
  }
  private contains(node: Node, at: { x: number; y: number }): boolean {
    return (this.graphics.get(node) ?? []).some(graphic => {
      if (!visibleInHierarchy(graphic)) return false;
      const tr = graphic.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return p.x >= -tr.width * tr.anchorX && p.x <= tr.width * (1 - tr.anchorX) && p.y >= -tr.height * tr.anchorY && p.y <= tr.height * (1 - tr.anchorY);
    });
  }
  private bindButton(spec: MineNode): void {
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
        if (!this.front(node) || !this.interactable(spec) || this.touches.has(node)) return;
        this.touches.set(node, { id: event.getID() ?? -1 }); this.selected = node; this.feedback.press(node, spec); this.setTint(node);
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.setTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.setTint(node); });
    }
  }
  private setTint(node: Node, immediate = false, snapshot?: MineHudState): void {
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
  private updateTints(dt: number, snapshot?: MineHudState): void {
    for (const [node, state] of this.tints) {
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.setTint(node, true, snapshot); }
      if (!state.duration) continue;
      state.elapsed += dt; const t = Math.min(1, state.elapsed / state.duration);
      state.current = state.from.map((value, i) => value + (state.to[i] - value) * t); this.renderTint(state);
      if (t === 1) state.duration = 0;
    }
  }
  private invoke(method: string, target: string): void {
    if (this.callbacks.getState().settlementPending && method === 'Game_Exit') {
      const result = this.callbacks.retrySettlement?.();
      if (!result?.ok) this.failure(result?.reason ?? 'saveFailed');
      return;
    }
    if (method === 'Content_Btn_Mine') this.open();
    else if (method === 'SetActive' && target === this.assets.config.roots.start) this.close();
    else if (method === 'Game_Enter') { const result = this.callbacks.start(); if (!result.ok) this.failure(result.reason); }
    else if (method === 'Game_Exit') { const result = this.callbacks.exit(); if (!result.ok) this.failure(result.reason); }
    else if (method === 'AD_SpeedBuff_Watch') this.beginAd('entry');
    else if (method === 'Bonus_AD_Show') this.beginAd('reward');
  }
  private beginAd(kind: 'entry' | 'reward'): void {
    const state = this.callbacks.getState();
    if (!state.adsEnabled || state.settlementPending || this.adToken !== null || (kind === 'entry' ? state.phase !== 'preparing' || !state.speedAdAvailable : state.phase !== 'result' || !state.bonusAdAvailable)) return;
    const result = this.callbacks.beginAd(kind);
    if (!result.ok || !result.token) { this.failure(result.reason); return; }
    const token = result.token; this.adToken = token;
    const complete = (outcome: RewardedAdOutcome): void => {
      if (this.destroyed || this.adToken !== token) return;
      this.adToken = null;
      const result = this.callbacks.completeAd(token, outcome);
      if (!result.ok && outcome !== 'cancel') this.failure(outcome === 'failure' ? 'adFailed' : result.reason);
      this.update(0);
    };
    if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, kind === 'entry' ? 'mine-entry' : 'mine-reward', complete);
    else complete('failure');
  }
  private failure(reason?: string): void {
    if (reason === 'saveFailed') this.callbacks.alert?.('进度保存失败，请重试。');
    if (reason === 'failure' || reason === 'adFailed') this.callbacks.alert?.('广告加载失败。');
    if (reason === 'dailyLimit' || reason === 'noTickets') this.callbacks.alert?.('今日入场次数已用完。');
  }
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
