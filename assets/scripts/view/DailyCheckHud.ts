import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Font, Node, UITransform, Vec3 } from 'cc';
import type { DailyCheckResult, DailyCheckSnapshot } from '../session/DailyCheckSystem';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, UiPreparation, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { loadResourceBatch } from './ResourceBatch';
import { SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';
import { OriginalDiamondAttraction } from './OriginalDiamondAttraction';
import type { DiamondBounceConfig, DiamondFxConfig } from './OriginalDiamondAttraction';

interface ButtonColors { target: string; transition: number; normal: number[]; pressed: number[];
  highlighted: number[]; selected: number[]; disabled: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean; }
type DailyNode = OriginalUiNode & { buttonColors?: ButtonColors; entryLayout?: { parentSizeDelta: [number, number] } };
interface DailyCard { index: number; root: string; amount: string; getable: string; claimed: string; glow: string; date: string; }
export interface DailyCheckUiConfig extends WeaponUiConfig {
  nodes: Record<string, DailyNode>;
  dailyCheckUi: { panel: string; entry: string; background: string; close: string; cards: DailyCard[];
    moneyText: string; diamondText: string; diamondTarget: string; diamondBounce: DiamondBounceConfig;
    entryPlacement: { position: [number, number]; size: [number, number] }; };
  diamondFx: DiamondFxConfig;
  rotations: { node: string; duration: number; angle: number; end: [number, number, number];
    relative: boolean; rotationMode: number; delay: number }[];
}
export interface DailyCheckHudAssets extends WeaponHudAssets { config: DailyCheckUiConfig; }
export interface DailyCheckHudCallbacks {
  getState(): DailyCheckSnapshot;
  claim(dayIndex: number): DailyCheckResult | Promise<DailyCheckResult>;
  getWallet(): { money: string; diamonds: number | string };
  getFallbackDiamondTarget?(): Node | null;
  onBeforeOpen?(): void;
  onVisibilityChanged?(visible: boolean): void;
  playSfx?(id: number): void;
  alert?(text: string): void;
}

async function loadAssets(art: ArtLibrary, path: string): Promise<DailyCheckHudAssets> {
  const config = await art.json<DailyCheckUiConfig>(path);
  if (config.version !== 1 || !config.roots.entry) throw new Error('Invalid original daily-check UI');
  const entryLayout = config.nodes[config.roots.entry]?.entryLayout?.parentSizeDelta;
  if (!Array.isArray(entryLayout) || entryLayout.length !== 2 || !entryLayout.every(Number.isFinite))
    throw new Error('Missing original daily-check entry parent layout');
  if (path.includes('daily-check-system') && (!config.roots.panel || config.dailyCheckUi?.cards.length !== 7 || !config.diamondFx))
    throw new Error('Incomplete original daily-check UI');
  const paths = new Set(Object.values(config.images).map(image => image.path));
  for (const font of Object.values(config.bitmapFonts ?? {})) font.pages.forEach(page => paths.add(page));
  await loadResourceBatch(Array.from(paths, path => () => art.loadFrame(path)));
  const font = new Font(); return { config, chineseFont: null, originalFont: font, numberFont: font };
}
export const loadDailyCheckHudAssets = (art: ArtLibrary): Promise<DailyCheckHudAssets> => loadAssets(art, 'art/daily-check-system/config');
export const loadDailyCheckEntryAssets = (art: ArtLibrary): Promise<DailyCheckHudAssets> => loadAssets(art, 'art/feature-entries/dailyCheck');

/** Shared source BounceBtn, ColorTint and pointer ownership for the small
 * independently loaded entry and the full reward panel. */
class DailyButtons {
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private readonly touches = new Map<Node, number>();
  private readonly hovered = new Set<Node>();
  private selected: Node | null = null;
  private readonly buttons = new Map<Node, { spec: DailyNode; current: number[]; from: number[]; to: number[]; time: number; duration: number }>();
  constructor(private readonly ui: OriginalWeaponUi, private readonly config: DailyCheckUiConfig, private readonly dirty: () => void) {}
  bind(id: string, enabled: () => boolean, click: () => void): void {
    const spec = this.config.nodes[id], node = this.ui.node(id), graphics: Node[] = [];
    const collect = (part: DailyNode): void => {
      if (part !== spec && part.button) return;
      if ((part.image && part.image.raycast !== false) || (part.text && part.text.raycast !== false)) graphics.push(this.ui.node(part.id));
      part.children.forEach(key => collect(this.config.nodes[key]));
    };
    collect(spec);
    const normal = spec.buttonColors?.normal ?? [255, 255, 255, 255];
    this.buttons.set(node, { spec, current: normal.slice(), from: normal.slice(), to: normal.slice(), time: 0, duration: 0 });
    const contains = (point: { x: number; y: number }): boolean => graphics.some(graphic => {
      if (!visibleInHierarchy(graphic)) return false;
      const tr = graphic.getComponent(UITransform)!, at = tr.convertToNodeSpaceAR(new Vec3(point.x, point.y, 0));
      return at.x >= -tr.width * tr.anchorX && at.x <= tr.width * (1 - tr.anchorX)
        && at.y >= -tr.height * tr.anchorY && at.y <= tr.height * (1 - tr.anchorY);
    });
    const finish = (event: EventTouch, released: boolean): void => {
      event.propagationStopped = true;
      if (this.touches.get(node) !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node); this.tint(node);
      if (released && enabled() && visibleInHierarchy(node) && contains(event.getUILocation())) click();
      this.dirty();
    };
    for (const graphic of graphics) {
      graphic.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        if (!enabled() || !visibleInHierarchy(node) || this.touches.has(node) || !contains(event.getUILocation())) return;
        this.touches.set(node, event.getID() ?? -1); this.selected = node; this.feedback.press(node, spec); this.tint(node); this.dirty();
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.tint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.tint(node); });
    }
  }
  update(dt: number): void {
    const before = Array.from(this.buttons.keys(), node => [node.scale.x, node.scale.y]);
    this.feedback.update(dt);
    let i = 0;
    for (const [node, state] of this.buttons) {
      if (before[i][0] !== node.scale.x || before[i][1] !== node.scale.y) this.dirty();
      i++;
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.tint(node, true); }
      if (!state.duration) continue;
      state.time += dt; const t = Math.min(1, state.time / state.duration);
      state.current = state.from.map((value, index) => value + (state.to[index] - value) * t);
      this.render(node); if (t === 1) state.duration = 0;
    }
  }
  clear(): void {
    this.touches.clear(); this.hovered.clear(); this.selected = null; this.feedback.clear();
    for (const node of this.buttons.keys()) this.tint(node, true);
    this.dirty();
  }
  private tint(node: Node, immediate = false): void {
    const state = this.buttons.get(node)!, colors = state.spec.buttonColors;
    if (!colors || colors.transition !== 1) return;
    const to = this.touches.has(node) ? colors.pressed : this.selected === node ? colors.selected : this.hovered.has(node) ? colors.highlighted : colors.normal;
    if (!immediate && state.to.every((value, i) => value === to[i])) return;
    if (immediate && !state.duration && state.current.every((value, i) => value === to[i])) return;
    state.from = state.current.slice(); state.to = to.slice(); state.time = 0; state.duration = immediate ? 0 : colors.fadeDuration;
    if (!state.duration) { state.current = to.slice(); this.render(node); }
  }
  private render(node: Node): void {
    const state = this.buttons.get(node)!, colors = state.spec.buttonColors!, base = state.spec.image?.color ?? [255, 255, 255, 255];
    this.ui.tint(colors.target, base.map((value, i) => Math.round(Math.min(255, value * state.current[i] * colors.colorMultiplier / 255))));
    this.dirty();
  }
}

/** One authored badge, available before the heavier modal is prepared. */
export class DailyCheckEntry {
  readonly node: Node;
  readonly prepared = Promise.resolve();
  private readonly ui!: OriginalWeaponUi;
  private readonly buttons: DailyButtons;
  private readonly entry: Node;
  private blocked = false;
  private destroyed = false;
  constructor(parent: Node, art: ArtLibrary, private readonly assets: DailyCheckHudAssets, open: () => void, playSfx?: (id: number) => void) {
    this.node = makeNode('DailyCheckEntry', parent);
    try {
      this.ui = new OriginalWeaponUi(art, assets); this.entry = this.ui.create(assets.config.roots.entry, this.node);
      this.buttons = new DailyButtons(this.ui, assets.config, () => {});
      this.buttons.bind(assets.config.roots.entry, () => !this.destroyed && !this.blocked,
        () => { open(); playSfx?.(assets.config.nodes[assets.config.roots.entry].clickSound ?? 1); });
      this.resize(1080, 1920);
    } catch (error) { this.ui?.destroy(); this.node.destroy(); throw error; }
  }
  setVisible(value: boolean): void { if (!this.destroyed) { this.node.active = value; if (!value) this.cancelInteractions(); } }
  setBlocked(value: boolean): void { this.blocked = value; if (value) this.cancelInteractions(); }
  update(dt: number): void { if (!this.destroyed) this.buttons.update(Number.isFinite(dt) ? Math.max(0, dt) : 0); }
  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    if (this.destroyed || !(width > 0) || !(height > topInset + bottomInset)) return;
    this.cancelInteractions(); const scale = width / this.assets.config.referenceWidth;
    const w = width / scale, h = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    const rect = this.assets.config.nodes[this.assets.config.roots.entry].rect;
    this.ui.layout(this.assets.config.roots.entry, rect.size[0], rect.size[1]);
    const [x, y] = rect.position;
    const [dx, dy] = this.assets.config.nodes[this.assets.config.roots.entry].entryLayout!.parentSizeDelta;
    this.entry.setPosition(-w / 2 - dx / 2 + x, h / 2 + dy / 2 + y);
  }
  cancelInteractions(): void { this.buttons?.clear(); }
  destroy(): void { if (!this.destroyed) { this.cancelInteractions(); this.destroyed = true; this.ui.destroy(); this.node.destroy(); } }
}

export class DailyCheckHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private readonly ui!: OriginalWeaponUi;
  private readonly colors?: SkinHudColorPipeline;
  private readonly buttons: DailyButtons;
  private root?: Node;
  private particles?: OriginalDiamondAttraction;
  private blocked = false;
  private destroyed = false;
  private claimPending = false;
  private refreshKey = '';
  private readonly glowElapsed = new Map<string, number>();
  constructor(parent: Node, art: ArtLibrary, private readonly assets: DailyCheckHudAssets,
    private readonly callbacks: DailyCheckHudCallbacks, presentation?: SkinHudPresentation, prepare?: UiPreparation) {
    this.node = makeNode('OriginalDailyCheckHud', parent);
    try {
      if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
      this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
      this.buttons = new DailyButtons(this.ui, assets.config, () => this.colors?.invalidate());
    } catch (error) { this.colors?.destroy(); this.ui?.destroy(); this.node.destroy(); throw error; }
    const initialize = function* (this: DailyCheckHud): Generator<void> {
      const config = assets.config, ids = config.dailyCheckUi;
      this.root = yield* this.ui.createSteps(config.roots.panel, this.colors?.content ?? this.node);
      this.root.active = false; this.root.addComponent(BlockInputEvents); this.ui.node(ids.background).addComponent(BlockInputEvents);
      this.buttons.bind(ids.close, () => this.isOpen, () => { this.callbacks.playSfx?.(1); this.close(); });
      for (const card of ids.cards) { this.buttons.bind(card.root, () => this.isOpen && !this.claimPending, () => this.claim(card.index)); yield; }
      this.particles = new OriginalDiamondAttraction(art, this.node, config.images[config.diamondFx.image], config.diamondFx,
        ids.diamondBounce, () => this.isOpen ? this.ui.node(ids.diamondTarget) : callbacks.getFallbackDiamondTarget?.() ?? null,
        () => callbacks.playSfx?.(14), Math.random,
        () => this.isOpen ? this.ui.node(ids.diamondBounce.node) : callbacks.getFallbackDiamondTarget?.() ?? null);
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare)));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps()); if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.release());
  }
  get isOpen(): boolean { return !this.destroyed && !!this.root?.active; }
  setEntryBlocked(value: boolean): void { this.blocked = value; }
  open(): void {
    if (this.destroyed || !this.root || this.isOpen || this.blocked) return;
    this.callbacks.onBeforeOpen?.(); this.cancelInteractions(); this.root.active = true;
    this.refreshKey = ''; this.colors?.setActive(true);
    this.particles?.setPresentation(this.colors?.content ?? this.node, this.colors?.materials.sprite ?? null);
    this.update(0); this.callbacks.onVisibilityChanged?.(true);
  }
  close(): void {
    if (!this.isOpen) return;
    this.cancelInteractions(); this.root!.active = false;
    this.particles?.setPresentation(this.node); this.colors?.setActive(false); this.callbacks.onVisibilityChanged?.(false);
  }
  cancelInteractions(): void { this.buttons.clear(); }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.release());
  }
  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous layout */ }
  }
  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0): Generator<void> {
    if (this.destroyed || !this.root || !(width > 0) || !(height > topInset + bottomInset)) return;
    this.cancelInteractions(); const scale = width / this.assets.config.referenceWidth;
    const w = width / scale, h = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    yield* this.ui.layoutSteps(this.assets.config.roots.panel, w, h, topInset / scale, bottomInset / scale);
    this.colors?.resize(width, height);
  }
  update(dt: number): void {
    if (this.destroyed || !this.root) return;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.buttons.update(delta);
    const animating = this.particles?.active; this.particles?.update(delta);
    if (animating && delta > 0) this.colors?.invalidate();
    if (this.isOpen) this.refresh();
    for (const tween of this.assets.config.rotations) {
      const node = this.ui.node(tween.node);
      const visible = visibleInHierarchy(node), previous = this.glowElapsed.get(tween.node);
      // Unity delays Awake until first activation. The source DOTween then keeps
      // running through inactive parents, with no OnDisable pause or restart.
      if (previous === undefined && !visible) continue;
      const elapsed = previous === undefined ? 0 : previous + delta; this.glowElapsed.set(tween.node, elapsed);
      const initial = this.assets.config.nodes[tween.node].rect.angle;
      const authoredDelta = tween.relative ? tween.end[2] : tween.end[2] - initial;
      const rotation = tween.rotationMode === 0 ? ((authoredDelta % 360) + 540) % 360 - 180 : authoredDelta;
      // The original uses Fast local rotation to an absolute end, followed by
      // Incremental loops: each loop adds the shortest end-minus-start delta.
      node.angle = initial + Math.max(0, elapsed - tween.delay) / tween.duration * rotation;
      if (visible && delta > 0) this.colors?.invalidate();
    }
  }
  destroy(): void {
    if (this.destroyed) return;
    if (this.isOpen) this.close();
    this.release(); this.ui.destroy(); this.node.destroy();
  }
  private release(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.buttons.clear(); this.particles?.destroy(); this.colors?.destroy();
  }
  private refresh(): void {
    for (const _ of this.refreshSteps()) { /* synchronous state refresh */ }
  }
  private *refreshSteps(): Generator<void> {
    const state = this.callbacks.getState(), wallet = this.callbacks.getWallet();
    const key = JSON.stringify([state.days, state.blocked, wallet]);
    if (key === this.refreshKey) return;
    this.refreshKey = key; const ids = this.assets.config.dailyCheckUi;
    for (const card of ids.cards) {
      const day = state.days[card.index];
      this.ui.setText(card.amount, String(day.diamonds));
      this.ui.show(card.getable, day.status === 'getable'); this.ui.show(card.claimed, day.status === 'geted'); yield;
    }
    const active = ids.cards.find(card => state.days[card.index].status === 'getable');
    if (active) { const node = this.ui.node(active.root); node.setSiblingIndex(node.parent!.children.length - 1); }
    this.ui.setText(ids.moneyText, wallet.money); this.ui.setText(ids.diamondText, String(wallet.diamonds));
    this.colors?.invalidate();
  }
  private claim(index: number): void {
    if (!this.isOpen || this.claimPending) return;
    this.claimPending = true;
    try {
      const result = this.callbacks.claim(index);
      if ('then' in result) {
        void result.then(value => this.finishClaim(index, value), () => this.failClaim());
      } else this.finishClaim(index, result);
    } catch { this.failClaim(); }
  }
  private failClaim(): void {
    this.claimPending = false;
    if (this.destroyed) return;
    this.callbacks.playSfx?.(5);
    this.callbacks.alert?.('签到核验失败，请检查网络后重试。');
  }
  private finishClaim(index: number, result: DailyCheckResult): void {
    this.claimPending = false;
    if (this.destroyed) return;
    if (result.ok) {
      this.particles?.spawn(this.ui.node(this.assets.config.dailyCheckUi.cards[index].root));
      this.callbacks.playSfx?.(7); this.refresh();
    } else {
      this.callbacks.playSfx?.(5);
      if (result.message) this.callbacks.alert?.(result.message);
      else if (result.reason === 'saveFailed' || result.reason === 'invalidSave') this.callbacks.alert?.('保存失败，本次领取未生效。');
      else if (result.reason === 'walletLimit' || result.reason === 'counterLimit') this.callbacks.alert?.('已达到保存上限，暂时无法领取。');
      else if (result.reason !== 'invalidDay' && result.reason !== 'notClaimable') this.callbacks.alert?.('签到核验失败，请检查网络后重试。');
    }
  }
}
