import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Font, Node, UITransform, Vec3 } from 'cc';
import type { RewardedAdPresenter, RewardedAdOutcome } from '../session/RewardedAds';
import type { DecimalAmount } from '../core/DecimalAmount';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';

type UpgradeType = 'power' | 'speed' | 'money';
type Confirmation = 'normal' | 'ad';
interface Curve { time: number; coefficients: number[]; }
interface ButtonColors {
  target: string; transition: number; normal: number[]; disabled: number[];
  highlighted?: number[]; pressed?: number[]; selected?: number[];
  colorMultiplier?: number; fadeDuration?: number; interactable?: boolean;
}
type RebirthButton = OriginalUiNode & { buttonColors?: ButtonColors };
interface ButtonTint { spec: RebirthButton; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; }
export interface RebirthUiConfig extends WeaponUiConfig {
  animation: { duration: number; tracks: { node: string; active: Curve[]; bounce: { duration: number; scale: number } }[] };
}
export interface RebirthHudAssets extends WeaponHudAssets { config: RebirthUiConfig; }
export interface RebirthHudState {
  ruby: DecimalAmount; count: number;
  upgrades: readonly { type: UpgradeType; level: number; value: DecimalAmount; price: DecimalAmount | null; affordable: boolean }[];
  reward: DecimalAmount; enhancedReward: DecimalAmount;
  unlocked: boolean; canRebirth: boolean; adAvailable: boolean; adEnabled: boolean;
  unlockMessage?: string; actionMessage?: string;
  phase: 'idle' | 'adPending' | 'animating'; animationElapsed: number;
}
export interface RebirthHudCallbacks {
  getState(): RebirthHudState;
  requestRebirth(mode: 'normal' | 'ad'): { ok: boolean; reason?: string; token?: string };
  completeAd(token: string, outcome: 'success' | 'cancel' | 'failure'): { ok: boolean; reason?: string };
  cancelAd(): void;
  purchaseUpgrade(type: UpgradeType): boolean;
  onBeforeOpen?(): void;
  onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void;
  playSfx?(id: number): void;
}

export async function loadRebirthHudAssets(art: ArtLibrary): Promise<RebirthHudAssets> {
  const config = await art.json<RebirthUiConfig>('art/rebirth-system/config');
  if (config.version !== 1 || config.animation.tracks.length !== 10 || !config.bitmapFonts) throw new Error('Invalid original rebirth UI');
  const paths = Object.values(config.images).map(spec => spec.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await Promise.all(paths.map(path => art.loadFrame(path)));
  // Every rebirth label is atlas based; no legacy TTF fallback is shipped.
  const placeholder = new Font();
  return { config, chineseFont: placeholder, originalFont: placeholder, numberFont: placeholder };
}

/** Source RectTransforms and graphics, including ordinary and rewarded confirmation
 * dialogs. Session callbacks own currency, daily limits and the atomic reset. */
export class RebirthHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui: OriginalWeaponUi;
  private readonly roots = new Map<string, Node>();
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private readonly touches = new Map<Node, { pointer: number; at: { x: number; y: number }; elapsed: number; nextRepeat: number; upgrade?: Record<string, any> }>();
  private readonly buttonGraphics = new Map<Node, Node[]>();
  private readonly buttonTints = new Map<Node, ButtonTint>();
  private readonly hoveredButtons = new Set<Node>();
  private selectedButton: Node | null = null;
  private readonly panel: Record<string, any>;
  private readonly upgradeRoles: Record<string, any>[];
  private readonly mainPanelRect: OriginalUiNode['rect'];
  private layoutAdsEnabled: boolean | null = null;
  private adToken: string | null = null;
  private confirmation: Confirmation | null = null;
  private wasAnimating = false;
  private lastVisible = false;
  private contentBlocked = false;
  private entryBlocked = false;
  private entryOffset = 855;
  private destroyed = false;
  private width = 1080;
  private height = 1920;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: RebirthHudAssets,
    private readonly callbacks: RebirthHudCallbacks, private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalRebirthHud', parent);
    // Only this HUD instance changes the panel height; shared source geometry
    // stays intact for other instances and for restoring the advertising layout.
    const mainPanel = assets.config.nodes['level0:949'];
    this.mainPanelRect = { ...mainPanel.rect, size: [...mainPanel.rect.size], position: [...mainPanel.rect.position] };
    this.ui = new OriginalWeaponUi(art, { ...assets, config: { ...assets.config, nodes: {
      ...assets.config.nodes, 'level0:949': { ...mainPanel, rect: this.mainPanelRect },
    } } });
    this.panel = Object.values(assets.config.roles).find(role => role.type === 'Rebirth_Panel_UI')!;
    this.upgradeRoles = this.panel.Upgrade_item_list.map((key: string) => assets.config.roles[key]);
    const initialize = function* (this: RebirthHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, this.node)); root.active = name === 'entry'; this.roots.set(name, root);
        if (name !== 'entry') {
          root.addComponent(BlockInputEvents);
          root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
        }
      }
      for (const spec of Object.values(assets.config.nodes)) { this.bindButton(spec); yield; }
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare)));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps(this.callbacks.getState()));
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }

  get isOpen(): boolean { return this.adToken !== null || Array.from(this.roots.entries()).some(([name, root]) => name !== 'entry' && root.active); }
  setEntryOffset(y: number): void {
    if (this.destroyed) return;
    this.entryOffset = y; this.roots.get('entry')!.setPosition(-this.width / 2, -this.height / 2 + y);
  }
  setEntryBlocked(blocked: boolean): void {
    this.entryBlocked = blocked;
    if (!blocked || this.destroyed) return;
    const entry = this.roots.get('entry')!;
    this.touches.delete(entry); this.feedback.cancelButton(entry); this.hoveredButtons.delete(entry);
    if (this.selectedButton === entry) this.selectedButton = null;
    this.setButtonTint(entry, true);
  }
  setContentBlocked(blocked: boolean): void {
    if (this.destroyed || this.contentBlocked === blocked) return;
    // Closing can synchronously notify Bootstrap and re-enter this setter.
    this.contentBlocked = blocked;
    this.roots.get('entry')!.active = !blocked;
    if (blocked && this.isOpen && this.callbacks.getState().phase !== 'animating') this.close();
  }
  open(): void {
    if (this.destroyed || this.contentBlocked) return;
    const state = this.callbacks.getState();
    if (!state.unlocked) { this.callbacks.alert?.(state.unlockMessage || '转生尚未开放。'); return; }
    if (state.phase !== 'idle') return;
    this.callbacks.onBeforeOpen?.();
    this.roots.get('main')!.active = true; this.refresh(state); this.notify();
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions();
    // A running transaction cannot be dismissed through another menu's close.
    if (this.callbacks.getState().phase === 'animating') return;
    for (const [name, root] of this.roots) if (name !== 'entry') root.active = false;
    this.confirmation = null; this.notify();
  }
  cancelInteractions(): void {
    this.touches.clear(); this.feedback.clear();
    this.clearButtonSelection();
    if (this.adToken !== null) {
      const token = this.adToken; this.adToken = null;
      this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd();
    }
    this.notify();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.cancelInteractions(); this.destroyed = true; this.node.active = false;
    this.node.destroy(); this.ui.destroy();
    this.buttonTints.clear(); this.buttonGraphics.clear();
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    
  }

  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0): Generator<void> {
    if (this.destroyed || width <= 0 || height <= 0) return;
    this.touches.clear(); this.feedback.clear();
    this.clearButtonSelection();
    const scale = width / this.assets.config.referenceWidth;
    this.width = width / scale; this.height = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(this.width, this.height);
    for (const [name, id] of Object.entries(this.assets.config.roots)) {
      yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : this.width, name === 'entry' ? 120 : this.height,
        name === 'entry' ? 0 : topInset / scale, name === 'entry' ? 0 : bottomInset / scale);
    }
    // Bootstrap compacts the left menu whenever content visibility changes.
    this.setEntryOffset(this.entryOffset);
    // Root FX has a serialized offset unlike the other full-canvas roots.
    const fx = this.assets.config.nodes[this.assets.config.roots.fx].rect.position;
    this.roots.get('fx')!.setPosition(fx[0], fx[1]);
    this.applyAdVisibility(this.callbacks.getState());
  }
  update(dt: number, state = this.callbacks.getState()): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed);
    this.updateButtonTints(elapsed, state);
    this.ui.show('level0:2136', !state.unlocked);
    this.applyAdVisibility(state);
    for (const [node, touch] of this.touches) {
      if (!visibleInHierarchy(node)) {
        this.touches.delete(node); this.feedback.cancelButton(node); this.setButtonTint(node);
        continue;
      }
      if (!this.isFrontLayer(node) || state.phase !== 'idle') {
        this.stopHoldOnExit(node);
        continue;
      }
      if (touch.upgrade) {
        // Unity raycasts every frame, including a stationary finger which the
        // shrinking BounceBtn rectangle has moved out from underneath.
        if (!this.buttonContains(node, touch.at)) this.stopHoldOnExit(node);
        touch.elapsed += elapsed;
        // Original WaitForSeconds coroutine performs at most one repeat per
        // rendered frame; slow frames must not synthesize a burst of purchases.
        if (touch.elapsed + 1e-8 >= touch.nextRepeat) {
          // HoldUpgradeRoutine tests UpgradeAble before invoking Upgrade.
          // A stopped hold must not reload the reward snapshot as stages advance.
          const available = state.upgrades[touch.upgrade._num];
          const purchased = !!available?.affordable && !!available.price && this.upgrade(touch.upgrade);
          touch.nextRepeat = purchased ? touch.elapsed + touch.upgrade.holdInterval : Infinity;
        }
      }
    }
    if (state.phase === 'animating') {
      if (!this.wasAnimating) {
        this.releaseTouches(); this.dismissAd();
        this.callbacks.playSfx?.(6);
      }
      this.roots.get('fx')!.active = true;
      for (const track of this.assets.config.animation.tracks) {
        const enabledAt = track.active.find(key => key.coefficients[3] > .5)?.time ?? Infinity;
        const node = this.ui.node(track.node), time = state.animationElapsed - enabledAt;
        node.active = time >= 0;
        const scale = Math.max(0, Math.min(1, time / track.bounce.duration)) * track.bounce.scale;
        node.setScale(scale, scale, scale);
      }
    } else if (this.wasAnimating) {
      for (const [name, root] of this.roots) if (name !== 'entry') root.active = false;
      this.confirmation = null; this.refresh(state);
    }
    if (state.phase !== 'adPending') this.dismissAd();
    this.wasAnimating = state.phase === 'animating'; this.notify();
  }

  private refresh(state: RebirthHudState): void {
    for (const _ of this.refreshSteps(state)) { /* synchronous state refresh */ }
  }
  private *refreshSteps(state: RebirthHudState): Generator<void> {
    this.ui.show('level0:2136', !state.unlocked);
    this.ui.setText(this.panel.Ruby_txt, state.ruby.format());
    this.ui.setText(this.panel.Reward_txt, state.reward.format());
    this.ui.setText(this.panel.UpgradeReward_txt, state.enhancedReward.format());
    this.applyAdVisibility(state);
    for (const role of this.upgradeRoles) {
      const upgrade = state.upgrades[role._num]; if (!upgrade) continue;
      this.ui.setText(role.Value_txt, `+${upgrade.value.format()}%`);
      this.ui.setText(role.Lv_txt, `Lv.${upgrade.level}`);
      this.ui.setText(role.Price_txt, upgrade.price ? upgrade.price.format() : 'Max');
      const enabled = !!upgrade.price && upgrade.affordable;
      this.ui.tint(role.Price_txt, enabled ? [255, 255, 255, 255] : color(role.Color_Disable));
      this.setButtonTint(this.ui.node(role.Upgrade_btn), false, state); yield;
    }
  }
  private nestedOpen(): boolean { return this.adToken !== null || ['normal', 'ad'].some(name => this.roots.get(name)!.active); }
  private bindButton(spec: RebirthButton): void {
    // SFX_BtnScript subscribes at runtime even when the serialized OnClick list
    // is empty (the exhausted daily button). BounceBtn is also independent of
    // Selectable.interactable, so unavailable upgrades still compress on press.
    if (!spec.button) return;
    const node = this.ui.node(spec.id), call = spec.button.find(call => call.method === 'Upgrade');
    const upgrade = call && this.assets.config.roles[call.target];
    const graphics: Node[] = [];
    const collectGraphics = (entry: OriginalUiNode) => {
      if (entry !== spec && entry.button) return;
      if ((entry.image && entry.image.raycast !== false) || (entry.text && entry.text.raycast !== false)) graphics.push(this.ui.node(entry.id));
      entry.children.forEach(id => collectGraphics(this.assets.config.nodes[id]));
    };
    collectGraphics(spec); this.buttonGraphics.set(node, graphics);
    if (spec.buttonColors?.transition === 1) {
      const normal = spec.buttonColors.normal.slice();
      this.buttonTints.set(node, { spec, current: normal, from: normal, to: normal, elapsed: 0, duration: 0 });
      this.setButtonTint(node, true);
    }
    const start = (event: EventTouch) => {
      event.propagationStopped = true;
      if (this.callbacks.getState().phase !== 'idle' || this.touches.has(node) || !this.isFrontLayer(node)) return;
      const at = event.getUILocation();
      this.touches.set(node, { pointer: event.getID() ?? -1, at: { x: at.x, y: at.y }, elapsed: 0, nextRepeat: upgrade?.holdDelay ?? Infinity, upgrade });
      if (this.buttonInteractable(spec)) {
        const previous = this.selectedButton; this.selectedButton = node;
        if (previous && previous !== node) this.setButtonTint(previous);
      }
      this.setButtonTint(node);
      this.feedback.press(node, spec);
    };
    const finish = (event: EventTouch, allowClick: boolean) => {
      event.propagationStopped = true;
      if (this.touches.get(node)?.pointer !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node);
      this.setButtonTint(node);
      if (!allowClick || !visibleInHierarchy(node) || !this.isFrontLayer(node) || this.callbacks.getState().phase !== 'idle' || !this.buttonContains(node, event.getUILocation())) return;
      if (!this.buttonInteractable(spec)) return;
      for (const action of spec.button!) this.invoke(action.target, action.method, action.arguments);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound);
      this.notify();
    };
    // Unity finds a Button in the ancestors of each raycast Graphic. Register
    // the source graphics, including text extending outside the button image,
    // and route once to the owning button instead of bubbling a second click.
    for (const graphic of graphics) {
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hoveredButtons.add(node); this.setButtonTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, (event: EventTouch) => {
        if (!this.buttonContains(node, event.getUILocation())) { this.hoveredButtons.delete(node); this.stopHoldOnExit(node); }
        this.setButtonTint(node);
      });
      graphic.on(Node.EventType.TOUCH_START, start);
      graphic.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
        event.propagationStopped = true;
        const touch = this.touches.get(node);
        if (touch?.pointer !== (event.getID() ?? -1)) return;
        const at = event.getUILocation(); touch.at = { x: at.x, y: at.y };
        // PointerExit only calls OnHoldEnd: returning still permits the click,
        // but never restarts the stopped continuous-upgrade coroutine.
        if (!this.buttonContains(node, at)) this.stopHoldOnExit(node);
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
        // Cocos changes type to CANCEL when release leaves the particular
        // graphic which claimed the touch. Its original event code preserves
        // END, allowing a release over a sibling graphic of the same Button.
        finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END);
      });
    }
  }
  private buttonContains(node: Node, at: { x: number; y: number }): boolean {
    return (this.buttonGraphics.get(node) ?? []).some(graphic => {
      if (!visibleInHierarchy(graphic)) return false;
      const tr = graphic.getComponent(UITransform)!, point = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return point.x >= -tr.width * tr.anchorX && point.x <= tr.width * (1 - tr.anchorX) &&
        point.y >= -tr.height * tr.anchorY && point.y <= tr.height * (1 - tr.anchorY);
    });
  }
  private isFrontLayer(node: Node): boolean {
    if (this.entryBlocked && node === this.roots.get('entry')) return false;
    if (this.adToken !== null) return false;
    const front = ['ad', 'normal', 'main', 'entry'].map(name => this.roots.get(name)!).find(root => root.active);
    for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parent) if (ancestor === front) return true;
    return false;
  }
  private stopHoldOnExit(node: Node): void {
    const touch = this.touches.get(node);
    if (touch?.upgrade) touch.nextRepeat = Infinity;
  }
  private releaseTouches(): void {
    for (const node of this.touches.keys()) this.feedback.release(node);
    this.touches.clear();
    for (const node of this.buttonTints.keys()) this.setButtonTint(node);
  }
  private buttonInteractable(spec: RebirthButton, snapshot?: RebirthHudState): boolean {
    if (spec.buttonColors?.interactable === false) return false;
    const call = spec.button?.find(action => action.method === 'Upgrade');
    if (!call) return true;
    const role = this.assets.config.roles[call.target], upgrade = (snapshot ?? this.callbacks.getState()).upgrades[role._num];
    return !!upgrade?.affordable && !!upgrade.price;
  }
  private setButtonTint(node: Node, immediate = false, snapshot?: RebirthHudState): void {
    const motion = this.buttonTints.get(node), colors = motion?.spec.buttonColors;
    if (!motion || !colors) return;
    const target = !this.buttonInteractable(motion.spec, snapshot) ? colors.disabled : this.touches.has(node) ?
      colors.pressed ?? colors.normal : this.selectedButton === node ? colors.selected ?? colors.normal :
        this.hoveredButtons.has(node) ? colors.highlighted ?? colors.normal : colors.normal;
    if (!immediate && motion.to.every((value, index) => value === target[index])) return;
    if (immediate && !motion.duration && motion.current.every((value, index) => value === target[index])) return;
    motion.from = motion.current.slice(); motion.to = target.slice(); motion.elapsed = 0;
    motion.duration = immediate ? 0 : colors.fadeDuration ?? .1;
    if (motion.duration === 0) { motion.current = motion.to.slice(); this.renderButtonTint(motion); }
  }
  private renderButtonTint(motion: ButtonTint): void {
    const colors = motion.spec.buttonColors!, base = motion.spec.image?.color ?? [255, 255, 255, 255];
    this.ui.tint(colors.target, base.map((channel, index) => Math.round(Math.min(255,
      channel * motion.current[index] * (colors.colorMultiplier ?? 1) / 255))));
  }
  private clearButtonSelection(): void {
    this.selectedButton = null; this.hoveredButtons.clear();
    for (const node of this.buttonTints.keys()) this.setButtonTint(node, true);
  }
  private updateButtonTints(dt: number, snapshot?: RebirthHudState): void {
    for (const [node, motion] of this.buttonTints) {
      if (!visibleInHierarchy(node)) {
        if (this.selectedButton === node) this.selectedButton = null;
        this.hoveredButtons.delete(node);
        this.touches.delete(node); this.setButtonTint(node, true, snapshot); continue;
      }
      if (motion.duration === 0) continue;
      motion.elapsed += dt; const t = Math.min(1, motion.elapsed / motion.duration);
      motion.current = motion.from.map((value, index) => value + (motion.to[index] - value) * t);
      this.renderButtonTint(motion);
      if (t === 1) motion.duration = 0;
    }
  }
  private invoke(target: string, method: string, args: Record<string, any>): void {
    if (method === 'Content_Btn_Rebirth') this.open();
    else if (method === 'Rebirth_Popup_Open') this.openConfirmation('normal');
    else if (method === 'UpgradeRebirth_Popup_Open') this.openConfirmation('ad');
    else if (method === 'Rebirth_Start') this.start();
    else if (method === 'Upgrade') this.upgrade(this.assets.config.roles[target]);
    else if (method === 'SetActive') {
      if (target === this.assets.config.roots.main && !args.m_BoolArgument) this.close();
      else { this.ui.show(target, !!args.m_BoolArgument); if (!args.m_BoolArgument) this.confirmation = null; }
    }
  }
  private openConfirmation(kind: Confirmation): void {
    const state = this.callbacks.getState();
    if (state.phase !== 'idle') return;
    if (kind === 'ad' && (!state.adEnabled || !state.adAvailable)) { this.refresh(state); return; }
    if (!state.canRebirth) { this.warnStage(); return; }
    // The source only activates the confirmation; already released buttons
    // underneath it finish their normal BounceBtn recovery and retain selection.
    this.releaseTouches(); this.confirmation = kind;
    for (const name of ['normal', 'ad']) this.roots.get(name)!.active = name === kind;
    const text = kind === 'normal' ? this.panel.Reward_Popup_txt : this.panel.UpgradeReward_Popup_txt;
    this.ui.setText(text, (kind === 'normal' ? state.reward : state.enhancedReward).format()); this.notify();
  }
  private start(): void {
    if (!this.confirmation) return;
    const result = this.callbacks.requestRebirth(this.confirmation);
    if (!result.ok) { this.failure(result.reason); return; }
    if (result.token) {
      const token = result.token; this.adToken = token;
      const complete = (outcome: RewardedAdOutcome): void => {
        if (this.destroyed || this.adToken !== token) return;
        this.adToken = null;
        const result = this.callbacks.completeAd(token, outcome);
        if (!result.ok && outcome !== 'cancel') this.failure(outcome === 'failure' ? 'adFailed' : result.reason);
        this.update(0, this.callbacks.getState()); this.notify();
      };
      if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, 'rebirth', complete); else complete('failure');
    }
    this.update(0, this.callbacks.getState());
  }
  private upgrade(role: Record<string, any>): boolean {
    if (!role || this.nestedOpen() || this.callbacks.getState().phase !== 'idle') return false;
    const upgrade = this.callbacks.getState().upgrades[role._num];
    if (!upgrade || !upgrade.affordable || !upgrade.price) { this.refresh(this.callbacks.getState()); return false; }
    const success = this.callbacks.purchaseUpgrade(upgrade.type);
    this.callbacks.playSfx?.(success ? 4 : 5); this.refresh(this.callbacks.getState()); return success;
  }
  private failure(reason?: string): void {
    const state = this.callbacks.getState();
    if (!state.canRebirth) this.warnStage();
    else if (reason === 'adFailed' || reason === 'failure') this.callbacks.alert?.('广告加载失败。');
    this.refresh(state);
  }
  private warnStage(): void { this.callbacks.alert?.(this.callbacks.getState().actionMessage || '当前无法转生。'); }
  private applyAdVisibility(state: RebirthHudState): void {
    if (this.layoutAdsEnabled !== state.adEnabled) {
      this.layoutAdsEnabled = state.adEnabled;
      this.touches.clear(); this.feedback.clear(); this.clearButtonSelection();
      const nodes = this.assets.config.nodes, source = nodes['level0:949'].rect;
      const removedHeight = state.adEnabled ? 0 : nodes['level0:170'].rect.position[1] - nodes['level0:754'].rect.position[1];
      // Collapse one reward row and its spacing while keeping the bottom edge.
      // Bottom-anchored upgrades stay in place; top-anchored art and the normal
      // reward move down with the shorter panel, leaving no reserved ad slot.
      this.mainPanelRect.size[1] = source.size[1] - removedHeight;
      this.mainPanelRect.position[1] = source.position[1] - removedHeight * source.pivot[1];
      this.ui.layout(this.assets.config.roots.main, this.width, this.height);
    }
    this.ui.show('level0:754', state.adEnabled);
    this.ui.show(this.panel.UpgradeRebirth_Able_obj, state.adEnabled && state.adAvailable);
    this.ui.show(this.panel.UpgradeRebirth_Disable_obj, state.adEnabled && !state.adAvailable);
    if (!state.adEnabled) {
      this.roots.get('ad')!.active = false;
      if (this.confirmation === 'ad') this.confirmation = null;
      if (this.adToken !== null) { this.dismissAd(); this.callbacks.cancelAd(); }
    }
  }
  private notify(): void {
    if (this.destroyed) return;
    const visible = this.isOpen;
    if (visible !== this.lastVisible) { this.lastVisible = visible; this.callbacks.onVisibilityChanged?.(visible); }
  }
  private dismissAd(): void {
    const token = this.adToken; this.adToken = null;
    if (token !== null) this.rewardedAds?.cancelRewardedAd(token);
  }

}

function color(value: { r: number; g: number; b: number; a: number }): number[] {
  return [value.r, value.g, value.b, value.a].map(channel => Math.round(channel * 255));
}
