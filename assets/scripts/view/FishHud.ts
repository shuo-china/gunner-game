import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Font, Mask, Node, UITransform, Vec3 } from 'cc';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { DecimalAmount } from '../core/DecimalAmount';
import { FISH_CAPACITY, FISH_CATALOG, FISH_COUNT, FISH_DRAW_PRICE } from '../session/FishSystem';
import type { FishActionResult, FishDrawKind, FishSnapshot } from '../session/FishSystem';
import type { ContentState } from '../session/ContentUnlockManager';
import type { RewardedAdOutcome, RewardedAdPresenter } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';
import { loadResourceBatch } from './ResourceBatch';

type Role = Record<string, any>;
export interface FishUiConfig extends WeaponUiConfig {
  portraits: string[]; fishSprites: string[]; outlines: string[];
  fills?: { node: string; direction: number }[];
  newFishAnimation: NonNullable<WeaponUiConfig['newGunAnimation']> & { destroyDelay: number };
}
export interface FishHudAssets extends WeaponHudAssets { config: FishUiConfig; }
export interface FishHudCallbacks {
  getState(): FishSnapshot;
  getContentState(): ContentState;
  getDailyAdState?(): ContentState;
  draw(kind: FishDrawKind): FishActionResult;
  merge(from: number, to: number, grade: number, automatic: boolean, revision?: number): FishActionResult;
  remove(index: number, grade: number, revision?: number): FishActionResult;
  setAuto(enabled: boolean): FishActionResult;
  beginAd?(): FishActionResult & { token?: string };
  completeAd?(token: string, outcome: RewardedAdOutcome): FishActionResult;
  cancelAd?(): void;
  onBeforeOpen?(): void;
  onVisibilityChanged?(visible: boolean): void;
  alert?(message: string): void;
  playSfx?(id: number): void;
}
interface FishView {
  role: Role; node: Node; grade: number; index: number;
  direction: Vec3; speed: number; directionTime: number; swimTime: number;
  scale: [number, number]; size: [number, number];
}
interface Drag {
  fish: FishView; pointer: number; grade: number; index: number; revision: number;
  start: Vec3; origin: Vec3; moved: boolean; target: FishView | null;
}
interface AutoMerge { from: FishView; to: FishView; grade: number; revision: number; elapsed: number; origin: Vec3; }
interface ScaleMotion { elapsed: number; from: number; target: number; duration: number; }

export async function loadFishHudAssets(art: ArtLibrary): Promise<FishHudAssets> {
  const config = await art.json<FishUiConfig>('art/fish-system/config');
  if (config.version !== 1 || config.portraits.length !== FISH_COUNT || config.fishSprites.length !== FISH_COUNT ||
      config.outlines.length !== FISH_COUNT || !config.bitmapFonts || !config.roots.main) throw new Error('Invalid original fish UI');
  const paths = Object.values(config.images).map(image => image.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await loadResourceBatch(Array.from(new Set(paths)).map(path => () => art.loadFrame(path)));
  const font = new Font(); return { config, chineseFont: font, originalFont: font, numberFont: font };
}

/** The source Fish_UI is a free swimming tank. Inventory indices are session
 * identities for each command; visual positions never alter ownership or stats. */
export class FishHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui: OriginalWeaponUi;
  private readonly colors?: SkinHudColorPipeline;
  private readonly roots = new Map<string, Node>();
  private readonly manager: Role;
  private readonly tank: Role;
  private readonly detail: Role;
  private readonly deletePopup: Role;
  private readonly deleteZone: Role;
  private readonly drawButton: Role;
  private readonly newFish: Role;
  private fishes!: FishView[];
  private readonly feedback = new OriginalWeaponFeedback(undefined);
  private readonly pointers = new Map<Node, number>();
  private readonly scales = new Map<FishView, ScaleMotion>();
  private readonly bounces = new Map<FishView, number>();
  private readonly fills = new Map<string, { width: number; height: number; x: number; y: number }>();
  private drag: Drag | null = null;
  private automatic: AutoMerge | null = null;
  private autoDelay = 0;
  private pendingDelete: { fish: FishView; index: number; grade: number; revision: number } | null = null;
  private adToken: string | null = null;
  private noticeTime: number | null = null;
  private detailId: number | null = null;
  private spawnPosition: Vec3 | null = null;
  private revision = '';
  private entryVisible = true;
  private entryBlocked = false;
  private entryOffset = 605;
  private destroyed = false;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: FishHudAssets,
    private readonly callbacks: FishHudCallbacks, presentation?: SkinHudPresentation, private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalFishHud', parent);
    if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
    this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
    const roles = Object.values(assets.config.roles);
    const role = (type: string): Role => { const found = roles.find(value => value.type === type); if (!found) throw new Error(`Original fish role missing: ${type}`); return found; };
    this.manager = role('Fish_manager'); this.tank = role('Fish_Tank'); this.detail = role('Fish_Info_UI');
    this.deletePopup = role('Fish_DeletePopup'); this.deleteZone = role('Fish_DeleteZone');
    this.drawButton = role('Fish_Draw_Btn'); this.newFish = role('New_Fish_UI');
    const initialize = function* (this: FishHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = this.ui.get(id) ?? (yield* this.ui.createSteps(id, name === 'entry' ? this.node : this.colors?.content ?? this.node));
        root.active = name === 'entry'; this.roots.set(name, root);
        if (name !== 'entry' && name !== 'newFish') {
          if (!root.getComponent(BlockInputEvents)) root.addComponent(BlockInputEvents);
          // Unity's raycastTarget panels intercept empty-space clicks as well as
          // their controls. Cocos needs an input listener on these visual nodes;
          // the root alone sits behind the sibling dismiss-background button.
          for (const child of assets.config.nodes[id].children) {
            const spec = assets.config.nodes[child];
            if (!spec.image || spec.image.raycast === false || spec.button) continue;
            const panel = this.ui.node(child);
            if (!panel.getComponent(BlockInputEvents)) panel.addComponent(BlockInputEvents);
          }
        }
      }
      const tankNode = this.ui.node(this.tank.node);
      if (!tankNode.getComponent(BlockInputEvents)) tankNode.addComponent(BlockInputEvents);
      this.fishes = this.tank.fishPool.map((key: string): FishView => {
        const item = assets.config.roles[key], node = this.ui.node(item.node), rect = assets.config.nodes[item.node].rect;
        return { role: item, node, grade: -1, index: -1, direction: new Vec3(), speed: 25,
          directionTime: 0, swimTime: 0, scale: [...rect.scale], size: [...rect.size] };
      });
      for (const spec of Object.values(assets.config.nodes)) if (spec.button) { this.bindButton(spec); yield; }
      this.fishes.forEach(fish => this.bindFish(fish));
      this.ui.setText('level0:9296', assets.config.translations['Menu/생선']);
      this.ui.setText('level0:36409', assets.config.translations['Fish/무료 생선 뽑기']);
      // Source manager arrays predate its final three/six ranks; the authored
      // hierarchy contains all thirteen badges, including the high-rank artwork.
      for (const item of [this.detail,this.deletePopup,this.newFish]) {
        const badges: string[] = [];
        const visit = (key: string): void => {
          const spec = assets.config.nodes[key];
          const grade = FISH_CATALOG.findIndex(fish => fish.grade === spec.name && fish.grade === spec.text?.value);
          if (grade >= 0) badges[grade] = key;
          spec.children.forEach(visit);
        };
        visit(item.node); item.Degree_objs = badges;
      }
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps()); if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }

  get isOpen(): boolean { return !this.destroyed && this.roots.get('main')!.active; }
  setEntryVisible(value: boolean): void { this.entryVisible = value; this.syncAccess(); }
  setEntryOffset(y: number): void {
    if (this.destroyed) return;
    this.entryOffset = y;
    const { width, height } = this.node.getComponent(UITransform)!;
    this.roots.get('entry')!.setPosition(-width / 2, -height / 2 + y);
  }
  setEntryBlocked(value: boolean): void {
    this.entryBlocked = value;
    if (value) { const entry = this.roots.get('entry')!; this.pointers.delete(entry); this.feedback.cancelButton(entry); }
  }
  open(): void {
    if (this.destroyed || this.isOpen || !this.entryVisible) return;
    const access = this.callbacks.getContentState();
    if (!access.visible || !access.unlocked) { if (access.message) this.callbacks.alert?.(access.message); return; }
    this.callbacks.onBeforeOpen?.(); this.cancelInteractions(); this.detailId = null;
    // Fish_Tank.OnEnable reloads its pool and chooses new separated positions.
    this.fishes.forEach(fish => { fish.grade = -1; fish.node.active = false; });
    this.roots.get('main')!.active = true; this.colors?.setActive(true);
    this.revision = ''; this.refresh(); this.callbacks.onVisibilityChanged?.(true);
  }
  close(): void {
    if (this.destroyed) return;
    const wasOpen = this.isOpen; this.cancelInteractions(); this.detailId = null; this.noticeTime = null;
    for (const [name, root] of this.roots) if (name !== 'entry') root.active = false;
    this.colors?.setActive(false); if (wasOpen) this.callbacks.onVisibilityChanged?.(false);
  }
  openDetail(grade: number): void {
    if (!this.isOpen || !Number.isInteger(grade) || grade < 0 || grade >= FISH_COUNT) return;
    this.cancelInteractions(); this.detailId = grade; this.roots.get('detail')!.active = true;
    this.revision = ''; this.refresh();
  }
  cancelInteractions(): void {
    this.feedback.clear(); this.pointers.clear(); this.stopAuto();
    this.cancelDrag();
    this.scales.clear(); this.bounces.clear();
    this.fishes?.forEach(fish => fish.node.setScale(...fish.scale, 1));
    this.cancelDelete(); this.clearTargets();
    if (this.adToken) {
      const token = this.adToken; this.adToken = null;
      this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd?.();
    }
    this.colors?.invalidate();
  }
  resizePrepared(prepare: UiPreparation, width: number, height: number, top = 0, bottom = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, top, bottom), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, top = 0, bottom = 0): void {
    for (const _ of this.resizeSteps(width, height, top, bottom)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, top = 0, bottom = 0, refresh = true): Generator<void> {
    if (this.destroyed || width <= 0 || height <= top + bottom) return;
    this.cancelInteractions();
    const positions = this.fishes.map(fish => fish.node.position.clone());
    const scale = width / 1080, h = (height - top - bottom) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottom - top) / 2);
    this.node.getComponent(UITransform)!.setContentSize(1080, h);
    for (const [name, id] of Object.entries(this.assets.config.roots)) {
      const root = this.roots.get(name)!;
      if (root.parent !== this.node && root.parent !== this.colors?.content) continue;
      yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : 1080, name === 'entry' ? 120 : h,
        name === 'entry' ? 0 : top / scale, name === 'entry' ? 0 : bottom / scale);
    }
    this.setEntryOffset(this.entryOffset);
    this.fills.clear();
    const fillKeys = new Set([this.drawButton.Fill]);
    for (const key of fillKeys) {
      const node = this.ui.get(key); if (!node) continue;
      const tr = node.getComponent(UITransform)!;
      this.fills.set(key, { width: tr.width, height: tr.height, x: node.position.x, y: node.position.y });
      const mask = node.getComponent(Mask) ?? node.addComponent(Mask); mask.type = Mask.Type.GRAPHICS_RECT;
    }
    this.fishes.forEach((fish, index) => {
      if (fish.grade >= 0) { this.paintFish(fish, fish.grade); fish.node.setPosition(this.clamp(fish, positions[index])); }
    });
    this.colors?.resize(width, height); this.revision = ''; if (refresh) yield* this.refreshSteps();
  }
  update(dt: number): void {
    if (this.destroyed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(dt); this.syncAccess();
    if (!this.isOpen) return;
    this.refresh();
    this.updateSwimming(dt); this.updateScale(dt); this.updateNotice(dt);
    if (!this.drag && !this.pendingDelete && !this.adToken && this.frontName() === 'main') this.updateAuto(dt);
    this.sortFish(); this.colors?.invalidate();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    } this.close(); this.destroyed = true; this.colors?.destroy(); this.ui.destroy(); this.node.destroy(); }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    this.colors?.destroy();
  }


  private syncAccess(): void {
    if (this.destroyed) return;
    const access = this.callbacks.getContentState(); this.roots.get('entry')!.active = this.entryVisible && access.visible;
    for (const spec of Object.values(this.assets.config.nodes)) if (spec.name === 'Locked_obj') this.ui.show(spec.id, !access.unlocked);
    if (!access.unlocked && this.isOpen) this.close();
  }
  private refresh(): void {
    for (const _ of this.refreshSteps()) { /* synchronous state refresh */ }
  }

  private *refreshSteps(): Generator<void> {
    const state = this.callbacks.getState(), ads = !!this.callbacks.getDailyAdState?.().unlocked;
    const key = `${state.revision}:${state.diamonds}:${state.freeDrawRemaining}:${state.freeWithoutAdRemaining}:${state.freeDrawNeedsAd}:${state.autoAvailable}:${this.detailId}:${ads}`;
    if (key === this.revision) return;
    this.revision = key;
    if (this.drag && this.drag.revision !== state.revision) this.cancelDrag();
    if (this.automatic && this.automatic.revision !== state.revision) this.stopAuto();
    if (this.pendingDelete && this.pendingDelete.revision !== state.revision) this.cancelDelete();
    this.reconcile(state.inventory);
    this.ui.setText(this.tank.Count_txt, `${state.inventory.length}<size=30>/${FISH_CAPACITY}`);
    this.ui.setText(this.manager.All_Damage_txt, `+${DecimalAmount.from(state.damagePercent).format()}%`);
    this.ui.setText(this.manager.All_CriPer_txt, `${Math.min(100, state.criticalChancePercent)}%`);
    this.ui.setText(this.manager.All_CriVal_txt, `${DecimalAmount.from(state.criticalDamagePercent).format()}%`);
    this.ui.setText(this.drawButton.Price_txt, String(FISH_DRAW_PRICE));
    this.ui.tint(this.drawButton.Price_txt, state.diamonds < FISH_DRAW_PRICE ? this.color(this.drawButton.Disable_Color) : [255,255,255,255]);
    this.setFill(this.drawButton.Fill, state.diamonds / FISH_DRAW_PRICE);
    const freeRemaining = ads ? state.freeDrawRemaining : state.freeWithoutAdRemaining;
    this.ui.setText(this.manager.AD_Gacha_Count_txt, `x${freeRemaining}`);
    this.ui.show(this.manager.AD_Gacha_Btn_obj, ads || state.freeWithoutAdRemaining > 0);
    this.layoutDrawButtons();
    this.ui.tint('level0:124727', freeRemaining > 0 ? [255,255,255,255] : this.color(this.manager.Color_Disable_Btn));
    this.ui.show(this.manager.AD_Draw_Icon_obj, state.freeDrawNeedsAd && ads);
    this.ui.show(this.manager.Auto_Btn_obj, state.autoAvailable);
    this.ui.show(this.manager.Auto_Explain_obj, state.autoEnabled && state.autoAvailable);
    this.ui.show(this.manager.NonAuto_Explain_obj, !state.autoEnabled || !state.autoAvailable);
    const onOff = this.assets.config.roles[this.manager.OnOff_UI];
    if (onOff) {
      this.ui.show(onOff.On_obj, state.autoEnabled && state.autoAvailable);
      this.ui.show(onOff.Off_obj, !state.autoEnabled || !state.autoAvailable);
    }
    for (const spec of Object.values(this.assets.config.nodes)) {
      if (spec.text && /^(Dia|Diamond)(mond)?(_txt)?$/i.test(spec.name)) this.ui.setText(spec.id, String(state.diamonds));
    }
    if (this.detailId !== null) this.paintDetail(this.detail, this.detailId);
    // Both probability columns derive from the same configured draw table.
    const rows = [['level0:940','level0:11403','level0:8018'],['level0:929','level0:14161','level0:28260'],
      ['level0:973','level0:2411','level0:15847'],['level0:1878','level0:21120','level0:4194'],
      ['level0:8909','level0:23144','level0:2474'],['level0:15236','level0:24915','level0:14062'],
      ['level0:22795','level0:23370','level0:20545'],['level0:34738','level0:3798','level0:12110']];
    for (const [grade, [label,normal,premium]] of rows.entries()) {
      this.ui.setText(label,FISH_CATALOG[grade].grade);
      for (const [id,base] of [[normal,ECONOMY_CONFIG.fish.freeBaseGrade],[premium,ECONOMY_CONFIG.fish.premiumBaseGrade]] as const) {
        const rate = ECONOMY_CONFIG.fish.drawGradePercents[grade-base] ?? 0; this.ui.setText(id,rate > 0 ? `${rate}%` : '-');
      }
      yield;
    }
    this.colors?.invalidate();
  }
  private layoutDrawButtons(): void {
    const buttons = [this.manager.AD_Gacha_Btn_obj, this.drawButton.node]
      .map(id => this.ui.node(id)).filter(node => node.active);
    if (!buttons.length) return;
    const parent = buttons[0].parent!.getComponent(UITransform)!;
    // Keep the authored 50-unit gap, but centre only the currently visible
    // controls. Use layout widths so press animations cannot shift the row.
    const gap = 50, widths = buttons.map(node => node.getComponent(UITransform)!.width);
    const width = widths.reduce((sum, value) => sum + value, 0) + gap * (buttons.length - 1);
    let x = (.5 - parent.anchorX) * parent.width - width / 2;
    buttons.forEach((node, index) => {
      const transform = node.getComponent(UITransform)!;
      node.setPosition(x + widths[index] * transform.anchorX, node.position.y, node.position.z);
      x += widths[index] + gap;
    });
  }
  private reconcile(inventory: number[]): void {
    const used = new Set<FishView>();
    inventory.forEach((grade, index) => {
      const fish = this.fishes.find(item => !used.has(item) && item.index === index && item.grade === grade) ??
        this.fishes.find(item => !used.has(item) && item.grade === grade) ??
        this.fishes.find(item => !used.has(item) && item.grade < 0) ??
        this.fishes.find(item => !used.has(item))!;
      const fresh = fish.grade !== grade || !fish.node.active;
      used.add(fish); fish.index = index;
      if (fresh) {
        this.paintFish(fish, grade);
        fish.node.setPosition(this.spawnPosition ? this.clamp(fish, this.spawnPosition) : this.emptyPosition(fish));
        this.spawnPosition = null; this.pickDirection(fish);
      }
      fish.node.active = true;
    });
    for (const fish of this.fishes) if (!used.has(fish)) { fish.grade = -1; fish.index = -1; fish.node.active = false; this.bounces.delete(fish); this.scales.delete(fish); }
    this.sortFish();
  }
  private paintFish(fish: FishView, grade: number): void {
    fish.grade = grade; fish.swimTime = 0;
    const skin = this.assets.config.images[this.assets.config.fishSprites[grade]];
    fish.size = [...skin.sizePx];
    this.ui.layout(fish.role.node, ...fish.size);
    this.ui.image(fish.role.skinImage, this.assets.config.fishSprites[grade]);
    this.ui.image(fish.role.FusionAlert_img, this.assets.config.outlines[grade]);
    // Unity SetNativeSize changes the skin rectangle, then its stretch-anchored
    // outline and Upgrade label inherit the new size without changing borders.
    this.ui.layout(fish.role.skinImage, ...fish.size);
    this.ui.show(fish.role.FusionAlert_img, false); this.ui.show(fish.role.AutoMerge_obj, false);
    fish.node.setScale(...fish.scale, 1);
  }
  private paintDetail(role: Role, grade: number): void {
    this.ui.image(role.Fish_img, this.assets.config.portraits[grade]);
    this.ui.tint(role.Panel_img, this.color(role.Degree_Colors?.[grade] ?? this.assets.config.degreeColors[grade]));
    role.Degree_objs?.forEach((key: string, id: number) => this.ui.show(key, id === grade));
    const fish = FISH_CATALOG[grade];
    this.ui.setText(role.Name_txt, fish.name);
    this.ui.setText(role.Damage_txt, `+${DecimalAmount.from(fish.damagePercent).format()}%`);
    this.ui.setText(role.CriPer_txt, `+${Math.min(100, fish.criticalChancePercent)}%`);
    this.ui.setText(role.CriVal_txt, `+${DecimalAmount.from(fish.criticalDamagePercent).format()}%`);
    this.ui.show(role.LeftBtn_obj, grade > 0); this.ui.show(role.RightBtn_obj, grade < FISH_COUNT - 1);
  }
  private color(value?: number[] | { r: number; g: number; b: number; a: number }): number[] {
    if (!value) return [255,255,255,255];
    return Array.isArray(value) ? value : [value.r * 255, value.g * 255, value.b * 255, value.a * 255];
  }
  private setFill(key: string, amount: number): void {
    const size = this.fills.get(key), node = this.ui.get(key); if (!size || !node) return;
    const ratio = Math.max(0, Math.min(1, amount)), tr = node.getComponent(UITransform)!;
    tr.setAnchorPoint(0,.5); tr.setContentSize(size.width*ratio,size.height); node.setPosition(size.x-size.width/2,size.y);
    const image = node.children.find(child => child.name === 'OriginalImage');
    if (image) {
      image.active = ratio > 0; image.getComponent(UITransform)!.setAnchorPoint(.5,.5);
      image.getComponent(UITransform)!.setContentSize(size.width,size.height); image.setPosition(size.width/2,0);
    }
  }
  private frontName(): string { return ['delete','detail','drawInfo','main','entry'].find(name => this.roots.get(name)?.active && visibleInHierarchy(this.roots.get(name)!)) ?? 'entry'; }
  private front(node: Node): boolean {
    if (this.destroyed || this.adToken) return false;
    const name = this.frontName(); if (name === 'entry' && this.entryBlocked) return false;
    const root = this.roots.get(name);
    for (let current: Node | null = node; current; current = current.parent) if (current === root) return true;
    return false;
  }
  private contains(node: Node, point: {x: number; y: number}): boolean {
    const tr = node.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(point.x, point.y));
    return p.x >= -tr.width*tr.anchorX && p.x <= tr.width*(1-tr.anchorX) && p.y >= -tr.height*tr.anchorY && p.y <= tr.height*(1-tr.anchorY);
  }
  private bindButton(spec: OriginalUiNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id);
    node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true; if (!this.front(node) || this.pointers.has(node)) return;
      this.pointers.set(node, event.getID() ?? -1); this.feedback.press(node, spec);
    });
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.pointers.get(node) !== (event.getID() ?? -1)) return;
      this.pointers.delete(node); this.feedback.release(node);
      if (!click || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node, event.getUILocation())) return;
      for (const action of spec.button!) this.invoke(action.method, action.target, !!action.arguments.m_BoolArgument);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound); this.refresh();
    };
    node.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
    node.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, false));
  }
  private invoke(method: string, target: string, active: boolean): void {
    if (method === 'Content_Btn_Fish' || method === 'ReloadFishUI') this.open();
    else if (method === 'SetActive') {
      const name = Object.keys(this.assets.config.roots).find(name => this.assets.config.roots[name] === target);
      if (!name) return;
      if (name === 'main') { if (active) this.open(); else this.close(); }
      else {
        this.cancelInteractions(); this.roots.get(name)!.active = active;
        if (name === 'newFish') this.noticeTime = null;
        if (name === 'detail' && !active) this.detailId = null;
      }
    } else if (method === 'PremiumGacha') this.draw('diamonds');
    else if (method === 'FreeGacha') this.draw('free');
    else if (method === 'AutoMerge_Change') { this.stopAuto(); this.check(this.callbacks.setAuto(!this.callbacks.getState().autoEnabled)); }
    else if (method === 'Show_LowerFish' && this.detailId !== null) this.openDetail(this.detailId - 1);
    else if (method === 'Show_HigherFish' && this.detailId !== null) this.openDetail(this.detailId + 1);
    else if (method === 'OnConfirm') this.confirmDelete();
    else if (method === 'OnCancel' || method === 'Close') this.cancelDelete();
  }
  private draw(kind: FishDrawKind): void {
    this.stopAuto();
    const state = this.callbacks.getState();
    if (kind === 'free' && state.freeDrawNeedsAd) {
      if (!this.callbacks.getDailyAdState?.().unlocked || !this.callbacks.beginAd || !this.callbacks.completeAd) return;
      const result = this.callbacks.beginAd();
      if (!result.ok || !result.token) { this.check(result); return; }
      const token = result.token; this.adToken = token;
      const complete = (outcome: RewardedAdOutcome): void => {
        if (this.destroyed || this.adToken !== token) return;
        this.adToken = null;
        const result = this.callbacks.completeAd!(token, outcome);
        if (outcome === 'cancel') { this.refresh(); return; }
        if (outcome === 'failure') { this.callbacks.alert?.('广告加载失败，请重试。'); this.refresh(); return; }
        if (this.check(result,true)) this.callbacks.playSfx?.(2);
      };
      if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, 'fish-daily', complete); else complete('failure');
      return;
    }
    const result = this.callbacks.draw(kind);
    if (this.check(result,true)) this.callbacks.playSfx?.(2);
    else if (kind === 'diamonds' && result.reason === 'currency') this.callbacks.playSfx?.(5);
  }
  private check(result: FishActionResult, showFish = false): boolean {
    if (!result.ok) {
      const messages: Record<string, string> = { full: '鱼缸已满。', currency: '钻石不足。', maxGrade: '已达到最高阶。',
        stale: '鱼的位置已变化，请重试。', saveFailed: '保存失败，本次操作未生效。', busy: '请稍后再试。', dailyLimit: '今日免费抽取次数已用完。' };
      if (result.reason !== 'cancelled') this.callbacks.alert?.(messages[result.reason ?? ''] ?? '当前无法进行此操作。');
      this.revision = ''; this.refresh(); return false;
    }
    this.revision = ''; this.refresh();
    if (showFish && result.index !== undefined) { const fish = this.fishes.find(fish => fish.index === result.index); if (fish) this.bounces.set(fish, 0); }
    if (showFish && result.grade !== undefined) {
      this.paintDetail(this.newFish, result.grade); this.roots.get('newFish')!.active = true; this.noticeTime = 0; this.updateNotice(0);
    }
    return true;
  }
  private bindFish(fish: FishView): void {
    fish.node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true;
      if (fish.grade < 0 || this.drag || !this.front(fish.node) || this.automatic?.from === fish || this.automatic?.to === fish) return;
      const state = this.callbacks.getState(), p = event.getUILocation();
      this.stopAuto(); this.drag = { fish, pointer: event.getID() ?? -1, grade: fish.grade, index: fish.index,
        revision: state.revision, start: new Vec3(p.x, p.y), origin: fish.node.position.clone(), moved: false, target: null };
      this.bounces.delete(fish); this.scaleTo(fish, fish.role.PressScale ?? .9, fish.role.PressAnimDuration ?? .08);
    });
    fish.node.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
      const drag = this.drag; if (!drag || drag.fish !== fish || drag.pointer !== (event.getID() ?? -1)) return;
      event.propagationStopped = true; const p = event.getUILocation(), dx = p.x-drag.start.x, dy = p.y-drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; this.scales.delete(fish); fish.node.setScale(...fish.scale, 1);
      const scale = this.ui.node(this.tank.node).worldScale;
      fish.node.setPosition(this.clamp(fish, new Vec3(drag.origin.x + dx/scale.x, drag.origin.y + dy/scale.y)));
      this.ui.show(this.deleteZone.node, true); this.highlightDelete(this.contains(this.ui.node(this.deleteZone.node), p));
      drag.target = this.fusionTarget(fish); this.clearFusion();
      if (drag.target) { this.ui.show(fish.role.FusionAlert_img, true); this.ui.show(drag.target.role.FusionAlert_img, true); }
      this.sortFish();
    });
    const finish = (event: EventTouch, cancelled: boolean): void => {
      const drag = this.drag; if (!drag || drag.fish !== fish || drag.pointer !== (event.getID() ?? -1)) return;
      event.propagationStopped = true;
      if (cancelled || !this.isOpen || this.callbacks.getState().revision !== drag.revision) {
        this.cancelDrag(); return;
      }
      this.drag = null; this.clearTargets();
      if (!drag.moved) { this.scaleTo(fish, 1, .08); this.openDetail(drag.grade); return; }
      if (this.contains(this.ui.node(this.deleteZone.node), event.getUILocation())) {
        this.pendingDelete = { fish, index: drag.index, grade: drag.grade, revision: drag.revision };
        this.paintDetail(this.deletePopup, drag.grade); this.roots.get('delete')!.active = true;
      } else { const target = this.fusionTarget(fish); if (target) this.merge(fish, target, false, drag.revision); }
      this.sortFish();
    };
    fish.node.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, false));
    fish.node.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, true));
  }
  private merge(from: FishView, to: FishView, automatic: boolean, revision: number): void {
    const position = to.node.position.clone(), result = this.callbacks.merge(from.index, to.index, from.grade, automatic, revision);
    if (result.ok) {
      from.grade = to.grade = -1; from.node.active = to.node.active = false;
      this.spawnPosition = position; this.scales.delete(from); this.scales.delete(to);
    }
    if (this.check(result,true)) this.callbacks.playSfx?.(3);
  }
  private confirmDelete(): void {
    const pending = this.pendingDelete; if (!pending) return;
    const result = this.callbacks.remove(pending.index, pending.grade, pending.revision);
    if (result.ok) { pending.fish.grade = -1; pending.fish.node.active = false; }
    this.cancelDelete(); this.check(result);
  }
  private cancelDelete(): void {
    this.pendingDelete = null; const root = this.roots.get('delete'); if (root) root.active = false;
    this.ui.show(this.deleteZone?.node, false);
  }
  private cancelDrag(): void {
    const drag = this.drag; this.drag = null;
    if (drag) {
      this.scales.delete(drag.fish); this.bounces.delete(drag.fish);
      drag.fish.node.setPosition(drag.origin); drag.fish.node.setScale(...drag.fish.scale, 1);
    }
    this.clearTargets();
  }
  private clearFusion(): void { this.fishes?.forEach(fish => this.ui.show(fish.role.FusionAlert_img, false)); }
  private clearTargets(): void { this.clearFusion(); this.ui.show(this.deleteZone?.node, false); this.highlightDelete(false); }
  private highlightDelete(on: boolean): void { if (this.deleteZone) this.ui.tint(this.deleteZone.zoneImage, this.color(on ? this.deleteZone.highlightColor : this.deleteZone.normalColor)); }
  private fusionTarget(from: FishView): FishView | null {
    if (from.grade < 0 || from.grade >= FISH_COUNT - 1) return null;
    for (const fish of this.fishes) {
      if (fish === from || fish.grade !== from.grade || !fish.node.active ||
          this.automatic?.from === fish || this.automatic?.to === fish) continue;
      const dx = from.node.position.x - fish.node.position.x, dy = from.node.position.y - fish.node.position.y;
      const radius = (item: FishView, axis: 0 | 1): number => item.size[axis] * Math.abs(item.scale[axis]) * .5 *
        (item.role.ellipseHitScale ?? .8) * (axis === 0 ? item.role.ellipseXScale ?? 1 : item.role.ellipseYScale ?? .7);
      const rx = radius(from, 0) + radius(fish, 0), ry = radius(from, 1) + radius(fish, 1);
      // Fish_Tank.FindFusionTarget returns the first matching pool entry.
      if (rx > 0 && ry > 0 && (dx/rx)**2 + (dy/ry)**2 <= 1) return fish;
    }
    return null;
  }
  private clamp(fish: FishView, point: Vec3): Vec3 {
    const tr = this.ui.node(this.tank.node).getComponent(UITransform)!;
    const halfWidth = fish.size[0] * Math.abs(fish.scale[0]) * .5, halfHeight = fish.size[1] * Math.abs(fish.scale[1]) * .5;
    const minX = -tr.width*tr.anchorX+halfWidth, maxX = tr.width*(1-tr.anchorX)-halfWidth;
    const minY = -tr.height*tr.anchorY+halfHeight, maxY = tr.height*(1-tr.anchorY)-halfHeight;
    return new Vec3(minX > maxX ? (minX+maxX)/2 : Math.max(minX,Math.min(maxX,point.x)), minY > maxY ? (minY+maxY)/2 : Math.max(minY,Math.min(maxY,point.y)));
  }
  private emptyPosition(fish: FishView): Vec3 {
    const tr = this.ui.node(this.tank.node).getComponent(UITransform)!;
    let best = new Vec3(), bestDistance = -1;
    for (let i=0; i<(this.tank.spawnMaxAttempts ?? 30); i++) {
      const p = this.clamp(fish, new Vec3((Math.random()-tr.anchorX)*tr.width, (Math.random()-tr.anchorY)*tr.height));
      let nearest = Infinity;
      for (const other of this.fishes) if (other !== fish && other.grade >= 0 && other.node.active) nearest = Math.min(nearest, Vec3.distance(p,other.node.position));
      if (nearest > bestDistance) { best = p; bestDistance = nearest; }
      if (nearest >= (this.tank.spawnMinDistance ?? 100)) return p;
    }
    return best;
  }
  private pickDirection(fish: FishView): void {
    const x = Math.random() > .5 ? 1 : -1, y = (Math.random()*2-1)*.3, magnitude = Math.hypot(x,y);
    fish.direction.set(x/magnitude,y/magnitude,0); fish.speed = 15+Math.random()*20; fish.directionTime = 2+Math.random()*3;
  }
  private updateSwimming(dt: number): void {
    for (const fish of this.fishes) {
      if (fish.grade < 0 || !fish.node.active) continue;
      fish.swimTime += dt;
      const skin = this.ui.node(fish.role.skinImage), phase = fish.swimTime % 2, t = phase > 1 ? 2-phase : phase;
      const wave = t < .5 ? 2*t*t : 1-(-2*t+2)**2/2;
      const sign = fish.direction.x < 0 ? -1 : 1;
      skin.setScale(sign*(1-.1*wave), .95+.05*wave, 1);
      const text = this.ui.get(fish.role.FusionAlert_txt_trans); if (text) text.setScale(sign,1/.95,1);
      if (this.drag?.fish === fish || this.pendingDelete?.fish === fish || this.automatic?.from === fish || this.automatic?.to === fish) continue;
      fish.directionTime -= dt; if (fish.directionTime <= 0) this.pickDirection(fish);
      const current = fish.node.position, wanted = new Vec3(current.x+fish.direction.x*fish.speed*dt,current.y+fish.direction.y*fish.speed*dt), p = this.clamp(fish,wanted);
      if (p.x !== wanted.x) fish.direction.x *= -1;
      if (p.y !== wanted.y) fish.direction.y *= -1;
      fish.node.setPosition(p);
    }
  }
  private sortFish(): void {
    const active = this.fishes.filter(fish => fish.grade >= 0 && fish.node.active).sort((a,b) => this.sortOrder(a)-this.sortOrder(b));
    for (const fish of active) fish.node.setSiblingIndex(fish.node.parent!.children.length-1);
    if (this.drag) this.drag.fish.node.setSiblingIndex(this.drag.fish.node.parent!.children.length-1);
    if (this.automatic) this.automatic.from.node.setSiblingIndex(this.automatic.from.node.parent!.children.length-1);
  }
  private sortOrder(fish: FishView): number {
    // Fish_Item.UpdateSortOrder uses Mathf.RoundToInt (ties to even), then a
    // grade offset; smaller fish at the same height are drawn in front.
    const value = 300-fish.node.position.y, floor = Math.floor(value), fraction = value-floor;
    const rounded = fraction < .5 ? floor : fraction > .5 ? floor+1 : floor%2 === 0 ? floor : floor+1;
    return Math.max(0,Math.min(2000,rounded+(12-Math.max(fish.grade,0))*10));
  }
  private scaleTo(fish: FishView, target: number, duration: number): void {
    this.scales.set(fish, { from: fish.node.scale.x / fish.scale[0], target, elapsed: 0, duration });
  }
  private updateScale(dt: number): void {
    for (const [fish, motion] of this.scales) {
      motion.elapsed += dt; const t = Math.min(1,motion.elapsed/Math.max(.001,motion.duration)), v = motion.from+(motion.target-motion.from)*t*t*(3-2*t);
      fish.node.setScale(fish.scale[0]*v,fish.scale[1]*v,1); if (t===1) this.scales.delete(fish);
    }
    for (const [fish, elapsed] of this.bounces) {
      const time = elapsed+dt; let remaining=time, from=0, scale=1;
      for (const [to,duration] of [[1.1,.15],[.95,.08],[1.02,.06],[1,.05]]) {
        const t=Math.min(1,remaining/duration); scale=from+(to-from)*t*t*(3-2*t);
        if (remaining<duration) break; remaining-=duration; from=to;
      }
      fish.node.setScale(fish.scale[0]*scale,fish.scale[1]*scale,1); if (time>=.34) this.bounces.delete(fish); else this.bounces.set(fish,time);
    }
  }
  private stopAuto(): void {
    this.automatic = null; this.autoDelay = this.tank?.AutoMerge_PairDelay ?? .15;
    this.fishes?.forEach(fish => this.ui.show(fish.role.AutoMerge_obj, false));
  }
  private updateAuto(dt: number): void {
    const state = this.callbacks.getState();
    if (!state.autoEnabled || !state.autoAvailable) { if (this.automatic) this.stopAuto(); return; }
    if (!this.automatic) {
      this.autoDelay-=dt; if (this.autoDelay>0 || !state.autoPair) return;
      // The source chooses the lowest eligible grade, then its fixed pool's
      // first fish as anchor and second as mover. Pool order survives compact
      // inventory removal/reuse, so snapshot inventory indices cannot select it.
      const [to,from] = this.fishes.filter(fish => fish.grade === state.autoPair!.grade && fish.node.active);
      if (!from || !to) return;
      this.automatic = { from, to, grade: state.autoPair.grade, revision: state.revision, elapsed: 0, origin: from.node.position.clone() };
      for (const fish of [from,to]) { this.ui.show(fish.role.AutoMerge_obj,true); this.scales.delete(fish); this.bounces.delete(fish); fish.node.setScale(...fish.scale,1); }
    }
    const pair = this.automatic; pair.elapsed+=dt;
    const from=pair.origin,to=pair.to.node.position,t=Math.min(1,pair.elapsed/(this.tank.AutoMerge_MoveDuration || .4)),smooth=t*t*(3-2*t);
    pair.from.direction.x = to.x-from.x >= 0 ? 1 : -1;
    pair.from.node.setPosition(from.x+(to.x-from.x)*smooth,from.y+(to.y-from.y)*smooth,0);
    if (Vec3.distance(pair.from.node.position,to) > (this.tank.AutoMerge_MergeDistance ?? 20)) return;
    this.stopAuto(); this.merge(pair.from,pair.to,true,pair.revision);
  }
  private updateNotice(dt: number): void {
    if (this.noticeTime === null) return;
    this.noticeTime += dt; const clip=this.assets.config.newFishAnimation;
    if (clip) for (const track of clip.tracks) {
      const values=track.curves.map(curve => {
        let key=curve[0]; for (const frame of curve) { if (frame.time>this.noticeTime!) break; key=frame; }
        const t=this.noticeTime!-key.time,[a,b,c,d]=key.coefficients; return ((a*t+b)*t+c)*t+d;
      }); this.ui.node(track.node).setScale(values[0],values[1],values[2]);
    }
    this.ui.node('level0:31276').angle = this.noticeTime * clip.glowRotationSpeed;
    if (this.noticeTime >= clip.destroyDelay) { this.noticeTime=null; this.roots.get('newFish')!.active=false; }
  }
}
