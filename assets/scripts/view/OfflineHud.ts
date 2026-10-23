import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Font, Node, UITransform, Vec3 } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, UiPreparation, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { loadResourceBatch } from './ResourceBatch';
import { SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';

export interface OfflineHudProgress {
  /** Original zero-based chapter and substage indices. */
  stageIndex: number; stageLevel: number;
  powerLevel: number; speedLevel: number; moneyLevel: number;
  /** Original Money rows are retained but inactive. */
  money?: string;
}
export interface OfflineHudState {
  visible: boolean; before: OfflineHudProgress; after: OfflineHudProgress;
  elapsedSeconds: number; absentSeconds: number; maxStage: number;
}
export interface OfflineHudCallbacks {
  getState(): OfflineHudState | null;
  close(): void;
  playSfx?(id: number): void;
  onVisibilityChanged?(visible: boolean): void;
}
interface Bounce { duration: number; scale: number; middle: number; }
export interface OfflineUiConfig extends WeaponUiConfig {
  nodes: Record<string, OriginalUiNode & { bounceStart?: Bounce }>;
  offlineUi: Record<string, string>;
}
export interface OfflineHudAssets extends WeaponHudAssets { config: OfflineUiConfig; }

/** OfflineResult.FormatTime: truncated units, no zero padding, at most two units. */
export function formatOfflineTime(seconds: number): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = Math.floor(value % 60);
  return hours >= 1 ? `${hours}h ${minutes}m` : minutes >= 1 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export async function loadOfflineHudAssets(art: ArtLibrary): Promise<OfflineHudAssets> {
  const config = await art.json<OfflineUiConfig>('art/offline-system/config');
  if (config.version !== 1 || !config.roots.offline || !config.offlineUi?.close || !config.bitmapFonts?.['1006:75'])
    throw new Error('Invalid original offline UI');
  const paths = new Set(Object.values(config.images).map(image => image.path));
  for (const font of Object.values(config.bitmapFonts)) font.pages.forEach(path => paths.add(path));
  await loadResourceBatch(Array.from(paths, path => () => art.loadFrame(path)));
  const placeholder = new Font();
  return { config, chineseFont: null, originalFont: placeholder, numberFont: placeholder };
}

/** A receipt for already-committed offline progress. Closing only dismisses it;
 * this UI never grants rewards, launches ads or pauses the background battle. */
export class OfflineHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private readonly ui: OriginalWeaponUi;
  private readonly colors?: SkinHudColorPipeline;
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private root?: Node;
  private panel?: Node;
  private pressed: number | null = null;
  private lastVisible = false;
  private refreshKey = '';
  private elapsed = 0;
  private destroyed = false;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: OfflineHudAssets,
    private readonly callbacks: OfflineHudCallbacks, presentation?: SkinHudPresentation, prepare?: UiPreparation) {
    this.node = makeNode('OriginalOfflineHud', parent);
    try {
      if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
      this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
    } catch (error) {
      this.colors?.destroy(); this.node.destroy(); throw error;
    }
    const initialize = function* (this: OfflineHud): Generator<void> {
      this.root = yield* this.ui.createSteps(assets.config.roots.offline, this.colors?.content ?? this.node);
      this.root.active = false; this.root.addComponent(BlockInputEvents);
      this.panel = this.ui.node(assets.config.offlineUi.panel); this.panel.addComponent(BlockInputEvents);
      this.bindClose();
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare)));
      if (prepare?.managed) {
        // A hidden prepared owner must not borrow the screen's presentation target.
        // Bootstrap activates the receipt after its measured commit.
        const state = this.callbacks.getState();
        if (state) yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps(state));
      } else yield* uiPreparationPhase(prepare, 'initialRefresh', this.updateSteps(0));
      if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare,
      () => { this.destroyed = true; this.colors?.destroy(); this.feedback.clear(); });
  }

  get isOpen(): boolean { return !this.destroyed && !!this.root?.active; }
  close(): void {
    if (!this.isOpen) return;
    this.cancelInteractions(); this.callbacks.close(); this.update(0);
  }
  cancelInteractions(): void { this.pressed = null; this.feedback.clear(); this.colors?.invalidate(); }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare,
      () => { this.destroyed = true; this.colors?.destroy(); this.feedback.clear(); });
  }
  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous layout */ }
  }
  *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0): Generator<void> {
    if (this.destroyed || !this.root || !(width > 0) || !(height > topInset + bottomInset)) return;
    this.cancelInteractions();
    const scale = width / this.assets.config.referenceWidth;
    const w = width / scale, h = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    yield* this.ui.layoutSteps(this.assets.config.roots.offline, w, h, topInset / scale, bottomInset / scale);
    this.applyBounce(); this.colors?.resize(width, height);
  }
  update(dt: number): void {
    for (const _ of this.updateSteps(dt)) { /* synchronous state refresh and animation */ }
  }
  private *updateSteps(dt: number): Generator<void> {
    if (this.destroyed || !this.root || !this.panel) return;
    const state = this.callbacks.getState(), visible = !!state?.visible;
    if (visible !== this.lastVisible) {
      this.cancelInteractions(); this.root.active = visible; this.lastVisible = visible;
      this.elapsed = 0; this.colors?.setActive(visible);
      this.callbacks.onVisibilityChanged?.(visible); this.colors?.invalidate();
    }
    if (!visible || !state) return;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const close = this.ui.node(this.assets.config.offlineUi.close), previousScale = close.scale.x;
    const wasBouncing = this.elapsed < this.assets.config.nodes[this.assets.config.offlineUi.panel].bounceStart!.duration;
    this.elapsed += delta; this.feedback.update(delta);
    this.applyBounce();
    yield* this.refreshSteps(state);
    // The original button coroutine can keep releasing after TOUCH_END.
    if ((wasBouncing && delta > 0) || previousScale !== close.scale.x) this.colors?.invalidate();
  }
  private *refreshSteps(state: OfflineHudState): Generator<void> {
    const key = JSON.stringify(state);
    if (key !== this.refreshKey) {
      this.refreshKey = key;
      const ids = this.assets.config.offlineUi;
      const seconds = state.elapsedSeconds + 1 < state.absentSeconds ? state.elapsedSeconds : state.absentSeconds;
      this.ui.setText(ids.Time_txt, formatOfflineTime(seconds));
      this.ui.show(ids.MaxStage_obj, state.after.stageIndex * 10 + state.after.stageLevel >= state.maxStage);
      for (const [suffix, progress] of [['Before', state.before], ['After', state.after]] as const) {
        this.ui.setText(ids[`Stage_${suffix}_txt`], `Stage ${progress.stageIndex + 1}-${progress.stageLevel + 1}`);
        this.ui.setText(ids[`PowerLv_${suffix}_txt`], `Lv.${progress.powerLevel}`);
        this.ui.setText(ids[`SpeedLv_${suffix}_txt`], `Lv.${progress.speedLevel}`);
        this.ui.setText(ids[`MoneyLv_${suffix}_txt`], `Lv.${progress.moneyLevel}`);
        this.ui.setText(ids[`Money_${suffix}_txt`], progress.money ?? '0'); yield;
      }
      this.colors?.invalidate();
    }
  }
  destroy(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.destroyed = true;
    if (this.lastVisible) this.callbacks.onVisibilityChanged?.(false);
    this.colors?.destroy(); this.ui.destroy(); this.node.destroy();
  }

  private applyBounce(): void {
    if (!this.panel) return;
    const bounce = this.assets.config.nodes[this.assets.config.offlineUi.panel].bounceStart!;
    const up = bounce.duration * bounce.middle;
    const scale = this.elapsed <= up ? bounce.scale * Math.min(1, this.elapsed / up)
      : bounce.scale + (1 - bounce.scale) * Math.min(1, (this.elapsed - up) / (bounce.duration - up));
    this.panel.setScale(scale, scale, 1);
  }
  private bindClose(): void {
    const id = this.assets.config.offlineUi.close, button = this.ui.node(id), spec = this.assets.config.nodes[id];
    const contains = (at: { x: number; y: number }): boolean => {
      const transform = button.getComponent(UITransform)!;
      const point = transform.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return point.x >= -transform.width * transform.anchorX && point.x <= transform.width * (1 - transform.anchorX)
        && point.y >= -transform.height * transform.anchorY && point.y <= transform.height * (1 - transform.anchorY);
    };
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.pressed === null || this.pressed !== (event.getID() ?? -1)) return;
      this.pressed = null; this.feedback.release(button);
      if (click && this.isOpen && visibleInHierarchy(button) && contains(event.getUILocation())) {
        if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound);
        this.close();
      }
      this.colors?.invalidate();
    };
    button.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true;
      if (!this.isOpen || !visibleInHierarchy(button) || this.pressed !== null || !contains(event.getUILocation())) return;
      this.pressed = event.getID() ?? -1; this.feedback.press(button, spec); this.colors?.invalidate();
    });
    button.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
    button.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
  }
}
