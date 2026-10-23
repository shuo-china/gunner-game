import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, Color, EventTouch, Font, Mask, Node, UITransform, Vec3 } from 'cc';
import type { SkinActionResult, SkinSnapshot } from '../session/SkinSystem';
import type { ContentState } from '../session/ContentUnlockManager';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponScroll } from './OriginalWeaponScroll';
import { SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';
import { SkinPreview } from './SkinPreview';
export type { SkinHudPresentation } from './SkinHudColorPipeline';

interface ButtonColors {
  target: string; transition: number; normal: number[]; disabled: number[]; highlighted: number[];
  pressed: number[]; selected: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean;
}
type SkinNode = OriginalUiNode & { buttonColors?: ButtonColors; skinPreviewTint?: number[] };
interface ButtonTint { spec: SkinNode; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; rendered?: number[]; }
type Role = Record<string, any>;
export interface SkinUiConfig extends WeaponUiConfig { nodes: Record<string, SkinNode>; skinCount: number; previewMode: 'battle-parts'; colors: number[][]; }
export interface SkinHudAssets extends WeaponHudAssets { config: SkinUiConfig; }
export interface SkinHudCallbacks {
  getState(): SkinSnapshot;
  getContentState(): ContentState;
  purchase(id: number): SkinActionResult; equip(id: number): SkinActionResult;
  prepare?(id: number): Promise<void>;
  onBeforeOpen?(): void; onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void; playSfx?(id: number): void;
}
export async function loadSkinHudAssets(art: ArtLibrary): Promise<SkinHudAssets> {
  const config = await art.json<SkinUiConfig>('art/skin-system/config');
  if (config.version !== 1 || config.skinCount !== 25 || config.previewMode !== 'battle-parts' || !config.roots.list || !config.roots.detail || !config.bitmapFonts) {
    throw new Error('Invalid original skin UI');
  }
  const paths = Object.values(config.images).map(image => image.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  if (!art.skinVisuals) throw new Error('Battle skin appearances must load before the skin menu');
  await Promise.all([
    ...Array.from(new Set(paths), path => art.loadFrame(path)),
    ...Array.from({ length: config.skinCount }, (_, id) => art.skinVisuals!.ensureLoaded(id)),
    art.loadFrame(art.rig.attachments.face.path),
  ]);
  const placeholder = new Font();
  return { config, chineseFont: placeholder, originalFont: placeholder, numberFont: placeholder };
}

/** Source SkinList_UI and SkinInfo_UI. Ownership/selection are session transactions;
 * opening a preview never purchases or equips the displayed skin. */
export class SkinHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui: OriginalWeaponUi;
  private readonly colors?: SkinHudColorPipeline;
  private readonly roots = new Map<string, Node>();
  private readonly previews = new Map<string, SkinPreview>();
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private readonly touches = new Map<Node, number>();
  private readonly graphics = new Map<Node, Node[]>();
  private readonly tints = new Map<Node, ButtonTint>();
  private readonly hovered = new Set<Node>();
  private readonly buttonScales = new Map<Node, number[]>();
  private readonly scrollPosition = [NaN, NaN, NaN];
  private refreshKey: string | null = null;
  private selected: Node | null = null;
  private readonly manager: Role;
  private readonly detail: Role;
  private readonly items: Role[];
  private scroll!: OriginalWeaponScroll;
  private detailId: number | null = null;
  private entryVisible = true;
  private entryBlocked = false;
  private entryOffset = 480;
  private lastVisible = false;
  private destroyed = false;
  private equipVersion = 0;
  private preparingId: number | null = null;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: SkinHudAssets, private readonly callbacks: SkinHudCallbacks, presentation?: SkinHudPresentation, prepare?: UiPreparation) {
    this.node = makeNode('OriginalSkinHud', parent);
    if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
    this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
    this.manager = assets.config.roles['level0:123519']; this.detail = assets.config.roles[this.manager.skin_info_ui];
    this.items = this.manager.Skin_item_list.map((key: string) => assets.config.roles[key]);
    const initialize = function* (this: SkinHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, name === 'entry' ? this.node : this.colors?.content ?? this.node)); root.active = name === 'entry'; this.roots.set(name, root);
        if (name !== 'entry') {
          root.addComponent(BlockInputEvents);
          root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
        }
      }
      // Without a compositor, retain the source order of entry, list and detail.
      if (!this.colors) ['entry', 'list', 'detail'].forEach((name, i) => this.roots.get(name)!.setSiblingIndex(i));
      for (const role of [...this.items, this.detail]) {
        for (const key of [role.Cat_img, role.Shadow_img, role.Locked_img].filter(Boolean)) {
          const parent = this.ui.node(key);
          const spec = Object.values(assets.config.nodes).find(spec => spec.components.includes(key))!;
          const rgba = spec.skinPreviewTint ?? [255, 255, 255, 255];
          const placeholder = parent.children.find(node => node.name === 'OriginalImage');
          if (placeholder) placeholder.active = false;
          this.previews.set(key, new SkinPreview(parent, art, this.colors?.materials.sprite,
            new Color(rgba[0], rgba[1], rgba[2], rgba[3])));
          yield;
        }
      }
      for (const spec of Object.values(assets.config.nodes)) if (spec.button) { this.bindButton(spec); yield; }
      const scrollSpec = Object.values(assets.config.nodes).find(spec => spec.layoutType === 'ScrollRect')!;
      this.scroll = this.ui.node(scrollSpec.id).addComponent(OriginalWeaponScroll);
      this.scroll.content = this.ui.node(scrollSpec.layout!.m_Content); this.scroll.configure(scrollSpec.layout!);
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps(this.callbacks.getState()));
      if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
      // ScrollView runs as its own component. Sample its final position immediately
      // before drawing, after every component update and pointer cancellation.
      this.colors?.setInvalidationSource(() => this.hasVisualChanges());
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }
  get isOpen(): boolean { return !this.destroyed && this.roots.get('list')!.active; }
  setEntryVisible(visible: boolean): void { this.entryVisible = visible; if (!this.destroyed) this.syncContentAccess(); }
  setEntryOffset(y: number): void {
    if (this.destroyed) return;
    this.entryOffset = y;
    const { width, height } = this.node.getComponent(UITransform)!;
    this.roots.get('entry')!.setPosition(-width / 2, -height / 2 + y);
  }
  setEntryBlocked(blocked: boolean): void {
    this.entryBlocked = blocked;
    if (!blocked || this.destroyed) return;
    const entry = this.roots.get('entry')!; this.touches.delete(entry); this.feedback.cancelButton(entry);
  }
  open(): void {
    if (this.destroyed) return;
    const access = this.syncContentAccess();
    if (this.isOpen || !this.entryVisible) return;
    if (!access.visible || !access.unlocked) { if (access.message) this.callbacks.alert?.(access.message); return; }
    this.callbacks.onBeforeOpen?.(); this.cancelInteractions(); this.detailId = null;
    this.roots.get('list')!.active = true; this.colors?.setActive(true); this.refresh(this.callbacks.getState()); this.notify();
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.detailId = null;
    this.roots.get('list')!.active = false; this.roots.get('detail')!.active = false; this.notify();
    this.colors?.setActive(false);
  }
  /** Diagnostics use the same preview operation as a real card click. */
  openDetail(id: number): void {
    if (!this.isOpen || !Number.isInteger(id) || id < 0 || id >= this.items.length) return;
    if (id !== this.detailId) this.cancelEquip();
    this.scroll.stopAutoScroll(); this.detailId = id; this.refresh(this.callbacks.getState());
  }
  cancelInteractions(): void {
    this.cancelEquip();
    this.touches.clear(); this.feedback.clear(); this.scroll?.stopAutoScroll(); this.hovered.clear(); this.selected = null;
    for (const node of this.tints.keys()) this.setTint(node, true);
  }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0, refresh = true): Generator<void> {
    if (this.destroyed || !(width > 0) || !(height > topInset + bottomInset)) return;
    const offset = this.scroll.content?.position.y ?? 0;
    this.cancelInteractions();
    const scale = width / this.assets.config.referenceWidth, w = width / scale, h = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    for (const [name, id] of Object.entries(this.assets.config.roots)) yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : w, name === 'entry' ? 120 : h,
      name === 'entry' ? 0 : topInset / scale, name === 'entry' ? 0 : bottomInset / scale);
    for (const preview of this.previews.values()) { preview.resize(); yield; }
    // Preserve the compact menu slot across viewport and safe-area changes.
    this.setEntryOffset(this.entryOffset);
    const content = this.scroll.content!, view = content.parent!.getComponent(UITransform)!;
    content.setPosition(content.position.x, Math.max(0, Math.min(offset, content.getComponent(UITransform)!.height - view.height)));
    this.colors?.resize(width, height);
    this.refreshKey = null;
    if (refresh) yield* this.refreshSteps(this.callbacks.getState());
  }
  update(dt: number, state = this.callbacks.getState()): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed); this.syncContentAccess();
    if (this.isOpen) this.refresh(state);
    this.updateTints(elapsed, state); this.notify();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.close(); this.destroyed = true; this.node.active = false;
    this.colors?.destroy();
    this.node.destroy(); this.ui.destroy(); this.graphics.clear(); this.tints.clear();
    this.buttonScales.clear(); this.previews.clear();
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    this.colors?.destroy(); this.previews.clear();
  }

  private refresh(state: SkinSnapshot): void {
    for (const _ of this.refreshSteps(state)) { /* synchronous state refresh */ }
  }

  private *refreshSteps(state: SkinSnapshot): Generator<void> {
    this.syncContentAccess();
    const detailRoot = this.roots.get('detail')!, detailVisible = this.isOpen && this.detailId !== null;
    if (detailRoot.active !== detailVisible) { detailRoot.active = detailVisible; this.colors?.invalidate(); }
    const key = `${state.revision}:${state.diamonds}:${this.detailId}`;
    if (key === this.refreshKey) return;
    this.refreshKey = key;
    this.colors?.invalidate();
    for (const [field, value] of [['Damage_Accum_txt', state.totals.damagePercent], ['Speed_Accum_txt', state.totals.speedPercent], ['Money_Accum_txt', state.totals.moneyPercent]] as const) {
      this.ui.setText(this.manager[field], `+${value}%`);
    }
    for (const [id, role] of this.items.entries()) {
      this.previews.get(role.Cat_img)!.setSkin(id);
      this.previews.get(role.Shadow_img)!.setSkin(id);
      this.ui.show(role.Locked_obj, !state.owned[id]); this.ui.show(role.Selected_obj, state.selectedId === id);
      yield;
    }
    if (this.detailId === null) return;
    const item = state.items[this.detailId], role = this.detail;
    for (const key of [role.Cat_img, role.Shadow_img, role.Locked_img]) this.previews.get(key)!.setSkin(this.detailId);
    this.ui.show(role.Locked_img, !item.owned); this.ui.show(role.Before_Btn_obj, this.detailId > 0);
    this.ui.show(role.Next_Btn_obj, this.detailId < this.items.length - 1);
    this.ui.setText(role.Num_txt, String(item.number)); this.ui.setText(role.Damage_txt, `+${item.damagePercent}%`);
    this.ui.setText(role.Speed_txt, `+${item.speedPercent}%`); this.ui.setText(role.Money_txt, `+${item.moneyPercent}%`);
    this.ui.show(role.Purchase_Btn_obj, !item.owned); this.ui.show(role.Select_Btn_obj, item.owned && !item.equipped);
    this.ui.show(role.Selected_obj, item.equipped); this.ui.setText(role.Price_txt, `<sprite=1>${item.price}`);
    const disabled = role.Color_Disable;
    this.ui.tint(role.Price_txt, item.affordable ? [255, 255, 255, 255] : ['r', 'g', 'b', 'a'].map(key => Math.round(disabled[key] * 255)));
    for (const node of this.tints.keys()) this.setTint(node, false, state);
  }
  private front(node: Node): boolean {
    if (this.destroyed || (node === this.roots.get('entry') && this.entryBlocked)) return false;
    if (!this.syncContentAccess().unlocked) return false;
    const front = ['detail', 'list', 'entry'].map(name => this.roots.get(name)!).find(root => root.active);
    for (let current: Node | null = node; current; current = current.parent) if (current === front) return true;
    return false;
  }
  private contains(node: Node, at: { x: number; y: number }): boolean {
    const inside = (target: Node): boolean => {
      const tr = target.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return p.x >= -tr.width * tr.anchorX && p.x <= tr.width * (1 - tr.anchorX) && p.y >= -tr.height * tr.anchorY && p.y <= tr.height * (1 - tr.anchorY);
    };
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.getComponent(Mask) && !inside(parent)) return false;
    return (this.graphics.get(node) ?? []).some(graphic => visibleInHierarchy(graphic) && inside(graphic));
  }
  private bindButton(spec: SkinNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id), graphics: Node[] = [];
    const collect = (entry: OriginalUiNode): void => {
      if (entry !== spec && entry.button) return;
      if ((entry.image && entry.image.raycast !== false) || (entry.text && entry.text.raycast !== false)) graphics.push(this.ui.node(entry.id));
      entry.children.forEach(key => collect(this.assets.config.nodes[key]));
    };
    collect(spec); this.graphics.set(node, graphics);
    if (spec.bounceButton) this.buttonScales.set(node, [NaN, NaN, NaN]);
    if (spec.buttonColors?.transition === 1) {
      const normal = spec.buttonColors.normal.slice(); this.tints.set(node, { spec, current: normal, from: normal, to: normal, elapsed: 0, duration: 0 });
    }
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.touches.get(node) !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node); this.setTint(node);
      if (!click || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node, event.getUILocation()) || !this.interactable(spec)) return;
      for (const action of spec.button!) this.invoke(action.method, action.target);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound); this.update(0);
    };
    for (const graphic of graphics) {
      graphic.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        if (!visibleInHierarchy(node) || !this.front(node) || this.touches.has(node) || !this.contains(node, event.getUILocation()) || !this.interactable(spec)) return;
        this.touches.set(node, event.getID() ?? -1); this.selected = node; this.feedback.press(node, spec); this.setTint(node);
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      // ScrollView cancels the child as soon as a drag wins pointer capture.
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.setTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.setTint(node); });
    }
  }
  private interactable(spec: SkinNode, snapshot?: SkinSnapshot): boolean {
    if (spec.buttonColors?.interactable === false) return false;
    if (spec.id === this.detail?.Purchase_Btn_obj && this.detailId !== null) {
      // Source Reload sets affordability even while the owned skin hides this button.
      // Keeping its normal tint lets the next locked preview fade to disabled.
      return (snapshot ?? this.callbacks.getState()).items[this.detailId].affordable;
    }
    return true;
  }
  private setTint(node: Node, immediate = false, snapshot?: SkinSnapshot): void {
    const state = this.tints.get(node), colors = state?.spec.buttonColors; if (!state || !colors) return;
    const to = !this.interactable(state.spec, snapshot) ? colors.disabled : this.touches.has(node) ? colors.pressed : this.selected === node ? colors.selected : this.hovered.has(node) ? colors.highlighted : colors.normal;
    if (!immediate && state.to.every((value, i) => value === to[i])) return;
    if (immediate && !state.duration && state.current.every((value, i) => value === to[i])) return;
    state.from = state.current.slice(); state.to = to.slice(); state.elapsed = 0; state.duration = immediate ? 0 : colors.fadeDuration;
    if (!state.duration) { state.current = state.to.slice(); this.renderTint(state); }
  }
  private renderTint(state: ButtonTint): void {
    const colors = state.spec.buttonColors!, base = state.spec.image?.color ?? [255, 255, 255, 255];
    const tint = base.map((value, i) => Math.round(Math.min(255, value * state.current[i] * colors.colorMultiplier / 255)));
    if (state.rendered?.every((value, i) => value === tint[i])) return;
    state.rendered = tint;
    this.ui.tint(colors.target, tint);
    if (visibleInHierarchy(this.ui.node(colors.target))) this.colors?.invalidate();
  }
  private hasVisualChanges(): boolean {
    if (!this.isOpen) return false;
    let changed = false;
    const remember = (previous: number[], x: number, y: number, z: number): void => {
      if (previous[0] === x && previous[1] === y && previous[2] === z) return;
      previous[0] = x; previous[1] = y; previous[2] = z; changed = true;
    };
    const position = this.scroll.content!.position;
    remember(this.scrollPosition, position.x, position.y, position.z);
    for (const [node, previous] of this.buttonScales) {
      // The entry stays in the live main HUD, outside the cached modal image.
      if (node === this.roots.get('entry') || !visibleInHierarchy(node)) continue;
      const scale = node.scale;
      remember(previous, scale.x, scale.y, scale.z);
    }
    return changed;
  }
  private updateTints(dt: number, snapshot?: SkinSnapshot): void {
    for (const [node, state] of this.tints) {
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.setTint(node, true, snapshot); }
      if (!state.duration) continue;
      state.elapsed += dt; const t = Math.min(1, state.elapsed / state.duration);
      state.current = state.from.map((value, i) => value + (state.to[i] - value) * t); this.renderTint(state);
      if (t === 1) state.duration = 0;
    }
  }
  private invoke(method: string, target: string): void {
    if (method === 'UI_Reload') this.open();
    else if (method === 'SetActive') {
      if (target === this.assets.config.roots.list) this.close();
      else if (target === this.assets.config.roots.detail) { this.cancelInteractions(); this.detailId = null; }
    } else if (method === 'Touch') this.openDetail(this.items.indexOf(this.assets.config.roles[target]));
    else if (method === 'Panel_Next' && this.detailId !== null) this.openDetail(this.detailId + 1);
    else if (method === 'Panel_Before' && this.detailId !== null) this.openDetail(this.detailId - 1);
    else if (method === 'Purchase' && this.detailId !== null) { if (this.check(this.callbacks.purchase(this.detailId))) this.callbacks.playSfx?.(7); }
    else if (method === 'Skin_Select' && this.detailId !== null) {
      if (this.callbacks.prepare) void this.selectPreparedSkin(this.detailId);
      else if (this.check(this.callbacks.equip(this.detailId))) this.callbacks.playSfx?.(9);
    }
  }
  private async selectPreparedSkin(id: number): Promise<void> {
    if (this.preparingId === id) return;
    const version = ++this.equipVersion;
    this.preparingId = id;
    this.callbacks.alert?.('正在加载皮肤资源…');
    try {
      await this.callbacks.prepare!(id);
      if (this.destroyed || version !== this.equipVersion || !this.isOpen || this.detailId !== id) return;
      if (!this.syncContentAccess().unlocked) return;
      if (this.check(this.callbacks.equip(id))) this.callbacks.playSfx?.(9);
      this.update(0);
    } catch (_error) {
      if (!this.destroyed && version === this.equipVersion && this.isOpen && this.detailId === id) {
        this.callbacks.alert?.('皮肤加载失败，请再次点击重试');
      }
    } finally {
      if (version === this.equipVersion) this.preparingId = null;
    }
  }
  private cancelEquip(): void { this.equipVersion++; this.preparingId = null; }
  private syncContentAccess(): ContentState {
    const access = this.callbacks.getContentState(), entry = this.roots.get('entry')!, wasVisible = entry.active;
    entry.active = this.entryVisible && access.visible;
    if (!access.unlocked && this.isOpen) this.close();
    else if (wasVisible && !entry.active) this.cancelInteractions();
    return access;
  }
  private check(result: SkinActionResult): boolean {
    if (!result.ok && result.reason === 'diamonds') this.callbacks.alert?.('钻石不足。');
    if (!result.ok && result.reason === 'contentLocked') {
      const access = this.syncContentAccess();
      if (access.message) this.callbacks.alert?.(access.message);
    }
    return result.ok;
  }
  private notify(): void { const value = this.isOpen; if (value !== this.lastVisible) { this.lastVisible = value; this.callbacks.onVisibilityChanged?.(value); } }
}
