import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Input, Node, ScrollView, UITransform, Vec2, Vec3 } from 'cc';
import type { RewardedAdPresenter } from '../session/RewardedAds';
import { DecimalAmount } from '../core/DecimalAmount';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { DRAW_PRICE, DRAW_PROBABILITIES, getWeapon, getWeaponGrade, getWeaponGradeName, WEAPON_CATEGORY_NAMES, WEAPON_GRADES } from '../core/WeaponCatalog';
import { BattleSession } from '../session/BattleSession';
import { WEAPON_TUTORIAL_RULES } from '../session/ContentConfig';
import { AdKind, AdOutcome, getWeaponStarDamage, WeaponActionResult, WeaponInventorySnapshot, WeaponItem, WeaponLocation, WeaponNotice } from '../session/WeaponInventory';
import type { AutoMergePair } from '../session/WeaponInventory';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { applyWeaponUiDisplay, loadWeaponCollectionAssets, OriginalGradeBadgePool, OriginalWeaponUi, OriginalUiNode, WeaponHudAssets, weaponCollectionWindow } from './OriginalWeaponUi';
import { OriginalWeaponConfetti } from './OriginalWeaponConfetti';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponScroll } from './OriginalWeaponScroll';
import type { OriginalAlerts } from './OriginalAlerts';
import type { OriginalSfx } from './OriginalSfx';
export { loadWeaponHudAssets } from './OriginalWeaponUi';
export type { WeaponHudAssets } from './OriginalWeaponUi';
export interface WeaponTutorialTargets {
  entry: Node; buy: Node; from: Node | null; to: Node | null; blocked: boolean;
}

type Role = Record<string, any>;
interface DragState {
  location: WeaponLocation; pointer: number; start: Vec2; last: Vec2; moved: boolean; node: Node;
  origin: Vec3; offset: Vec2; revision: number; overlap: number | null; displacedTo: number | null;
  fusion: number | null; slot: number | null;
}
interface CardScale { elapsed: number; from: number; to: number; duration: number; next: [number, number][]; }
interface AutoMotion extends AutoMergePair {
  from: Node; to: Node;
  start: Vec3; end: Vec3; elapsed: number;
}
const ERROR_TEXT: Record<string, string> = {
  notEnoughDiamonds: '钻石不足。',
  differentGrade: '拖动相同等级的武器进行合成。', pendingAd: '观看广告后领取武器。',
  max: '已达满级。', dailyUsed: '今日已领取。', adFailed: '广告加载失败。',
  noAdWeapon: '领取时间已结束。', adInProgress: '广告进行中。', unavailable: '广告未接入。',
  adsDisabled: '广告功能暂未开放。', locked: '当前功能尚未开放。',
};
const ERROR_TERM: Record<string, string> = {
  lastWeapon: 'Alarm/UnSelectError', backpackFull: 'Gun/InventoryFull', protected: 'Gun/PauseMergeError',
  maxGrade: 'Alarm/MaxGradeError', notEnoughGem: 'StarUpgrade/NotEnoughGem',
};

/** Original popup hierarchy and artwork, with session-owned atomic inventory commands. */
export class WeaponHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private destroyed = false;
  private readonly ui: OriginalWeaponUi;
  private readonly gradeBadges: OriginalGradeBadgePool;
  private collectionUi: OriginalWeaponUi;
  private collectionRequest?: Promise<void>;
  private collectionAssetsRequest?: Promise<void>;
  private collectionGeneration = 0;
  private collectionScroll?: OriginalWeaponScroll;
  private collectionContent?: Node;
  private collectionViewport?: Node;
  private readonly collectionPool: { role: Role; target: string; index: number }[] = [];
  private readonly collectionBindings = new Map<string, number>();
  private collectionWindowKey = '';
  private collectionOpening = false;
  private collectionOpenVersion = 0;
  private layoutVersion = 0;
  private topOverflow = 0;
  private bottomOverflow = 0;
  private readonly roots = new Map<string, Node>();
  private confetti!: OriginalWeaponConfetti;
  private feedback!: OriginalWeaponFeedback;
  private readonly buttonTouches = new Map<Node, { pointer: number; weapon?: number }>();
  private readonly backpack: Role[];
  private readonly slots: Role[];
  private readonly collection: Role[];
  private readonly list: Role;
  private readonly detail: Role;
  private readonly newGun: Role;
  private readonly star: Role;
  private adToken: string | null = null;
  private shownNotice: WeaponNotice | null = null;
  private noticeTime = 0;
  private readonly spawnBounces = new Map<Node, { elapsed: number; scale: [number, number] }>();
  private readonly cardBaseScales = new Map<Node, [number, number]>();
  private readonly cardScales = new Map<Node, CardScale>();
  private detailId = 0;
  private detailLocation: WeaponLocation | null = null;
  private starIndex = 0;
  private starPreview: ((level: number) => string | null) | null = null;
  private lastRevision = -1;
  private collectionRevision = '';
  private lastPolicy = '';
  private lastVisible = false;
  private entryBlocked = false;
  private entryOffset = 355;
  private drag: DragState | null = null;
  private autoElapsed = 0;
  private clock = 0;
  private width = 1080;
  private height = 1920;
  private scrolls: ScrollView[] = [];
  private autoMotion: AutoMotion | null = null;
  private tutorialNeedsRefresh = false;
  private readonly notification: (visible: boolean) => void;

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: WeaponHudAssets,
    private readonly session: BattleSession, private readonly alerts: OriginalAlerts, onVisibilityChanged?: (visible: boolean) => void,
    private readonly sfx?: Pick<OriginalSfx, 'play'>, private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation,
    private readonly prepareCollection?: UiPreparation) {
    this.notification = onVisibilityChanged || (() => {});
    this.node = makeNode('OriginalWeaponHud', parent); this.ui = new OriginalWeaponUi(art, assets);
    this.collectionUi = this.ui;
    const roles = Object.values(assets.config.roles);
    this.list = roles.find(r => r.type === 'Gun_Item_List')!;
    this.backpack = this.list.Gun_Item_Pool.map((key: string) => assets.config.roles[key]);
    this.slots = roles.filter(r => r.type === 'Gun_Slot').sort((a, b) => a.SlotNum - b.SlotNum);
    this.gradeBadges = new OriginalGradeBadgePool([...this.backpack, ...this.slots]);
    const collectionRoot = roles.find(r => r.type === 'Gun_Collection_UI')!;
    this.collection = collectionRoot.Gun_Item_list.map((key: string) => assets.config.roles[key]);
    this.detail = roles.find(r => r.type === 'Gun_Info_UI')!;
    this.newGun = roles.find(r => r.type === 'NewGun_UI')!;
    this.star = roles.find(r => r.type === 'StarUpgrade_popup')!;
    const initialize = function* (this: WeaponHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        if (name === 'collection') continue;
        const root = (yield* this.ui.createSteps(id, this.node, undefined, this.gradeBadges.include)); this.roots.set(name, root); root.active = name === 'entry';
        if (name !== 'entry' && name !== 'newGun') root.addComponent(BlockInputEvents);
        if (name !== 'entry' && name !== 'newGun') root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
      }
      // The source's 89.5% black mask blends in Unity's linear color space.
      // This HUD blends in display space; 65% matches the original collection's
      // visible gun details and grade colors without making cards nearly black.
      this.collection.forEach(role => this.ui.tint(role.Locked_obj, [0, 0, 0, 166]));
      this.confetti = new OriginalWeaponConfetti(this.ui, assets.config.starConfetti || []);
      this.feedback = new OriginalWeaponFeedback(assets.config.mergeTutorial, this.ui.get(assets.config.mergeTutorial?.node));
      for (const spec of Object.values(assets.config.nodes)) {
        if (!spec.button?.length || !this.ui.get(spec.id)) continue;
        this.bindButton(spec); yield;
      }
      this.backpack.forEach((role, index) => this.bindDrag(this.ui.node(role.node), { kind: 'backpack', index }));
      this.slots.forEach((role, index) => this.bindDrag(this.ui.node(role.node), { kind: 'equipment', index }));
      // The original new-gun background is disabled. Only the visible card's
      // Graphic consumes hits; the rest of the inventory remains interactive.
      this.ui.node('level0:8964').addComponent(BlockInputEvents);
      this.installScrolls();
      this.ui.show('level0:483', false); // Vault and its take-out action have no entry in this version.
      this.ui.show('level0:2027', false);
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps());
      // Standalone tools retain synchronous preparation, with the same pooled
      // renderer as the scene-owned background path.
      if (!this.prepareCollection && !assets.collectionImagesDeferred) {
        this.collectionUi = new OriginalWeaponUi(this.art, this.assets);
        yield* this.createCollectionSteps(this.collectionUi);
        this.roots.set('collection', this.collectionUi.node(assets.config.roots.collection));
      }
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }

  get isOpen(): boolean { return this.adToken !== null || Array.from(this.roots.entries()).some(([name, root]) => name !== 'entry' && name !== 'newGun' && root.active); }
  get preparingCollection(): boolean { return this.collectionOpening; }
  get collectionReady(): boolean { return this.roots.has('collection'); }
  /** Bootstrap promotes the same background module when a player opens it. */
  onCollectionRequested?: () => Promise<void>;

  /** Asset readiness is separate from constructing the optional pooled view. */
  prepareCollectionAssets(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Weapon HUD destroyed'));
    if (this.collectionAssetsRequest) return this.collectionAssetsRequest;
    const request = loadWeaponCollectionAssets(this.art, this.assets.config).catch(error => {
      if (this.collectionAssetsRequest === request) this.collectionAssetsRequest = undefined;
      throw error;
    });
    this.collectionAssetsRequest = request; return request;
  }

  /** The usable backpack is published before the 65-card collection is built. */
  warmCollection(): Promise<void> {
    return this.initialized && !this.destroyed ? this.ensureCollection() : Promise.resolve();
  }

  /** Drop optional UI nodes under memory pressure; the inventory stays usable.
   * Borrowed textures remain ArtLibrary-owned and are never released here. */
  releaseCollection(): void {
    this.collectionGeneration++; this.collectionOpenVersion++; this.collectionOpening = false;
    const scroll = this.collectionScroll;
    if (scroll) scroll.onPositionChanged = undefined;
    const owned = new Set(this.collectionUi !== this.ui ? this.collectionUi.nodes.values() : []);
    for (const node of this.buttonTouches.keys()) if (owned.has(node)) { this.buttonTouches.delete(node); this.feedback?.cancelButton(node); }
    const root = this.collectionUi.get(this.assets.config.roots.collection);
    if (root) { root.active = false; root.destroy(); }
    if (this.collectionUi !== this.ui) this.collectionUi.destroy();
    this.roots.delete('collection'); this.collectionRequest = undefined; this.collectionAssetsRequest = undefined;
    this.assets.collectionImagesDeferred = true;
    this.collectionPool.length = 0; this.collectionBindings.clear(); this.collectionWindowKey = ''; this.collectionRevision = '';
    this.collectionScroll = undefined; this.collectionContent = undefined; this.collectionViewport = undefined;
    this.scrolls = this.scrolls.filter(item => item !== scroll && item.node.isValid);
  }

  private *createCollectionSteps(ui: OriginalWeaponUi): Generator<void> {
    const config = this.assets.config, id = config.roots.collection, cardRoots = new Set(this.collection.map(role => role.node as string));
    const root = yield* ui.createSteps(id, this.node, false, key => !cardRoots.has(key));
    root.addComponent(BlockInputEvents);
    root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
    for (const spec of Object.values(config.nodes)) if (spec.button?.length && ui.get(spec.id)) { this.bindButton(spec, ui); yield; }
    yield* ui.layoutSteps(id, this.width, this.height, this.topOverflow, this.bottomOverflow);
    const scrollSpec = Object.values(config.nodes).find(spec => spec.layoutType === 'ScrollRect' && ui.get(spec.id))!;
    this.collectionContent = ui.node(scrollSpec.layout!.m_Content);
    this.collectionViewport = ui.node(scrollSpec.layout!.m_Viewport);
    // Fixed authored five-column grid. Spare partial-row capacity avoids any
    // node allocation during a fling or an overscroll.
    const capacity = Math.min(this.collection.length, (Math.ceil(this.collectionViewport.getComponent(UITransform)!.height / 240) + 3) * 5);
    for (let index = 0; index < capacity; index++) {
      const source = this.collection[index], unusedGrades = new Set<string>(source.Degree_objs.slice(1));
      yield* ui.createSteps(source.node, this.collectionContent, false, key => !unusedGrades.has(key));
      const target = Object.keys(config.roles).find(key => config.roles[key] === source)!;
      const role = { ...source, Degree_objs: [source.Degree_objs[0]] };
      this.collectionPool.push({ role, target, index: -1 });
      const spec = config.nodes[source.node]; this.bindButton(spec, ui); yield;
    }
    let version: number;
    do {
      version = this.layoutVersion; this.collectionRevision = ''; this.collectionWindowKey = '';
      yield* ui.layoutSteps(id, this.width, this.height, this.topOverflow, this.bottomOverflow);
      yield* this.refreshCollectionSteps();
    } while (version !== this.layoutVersion);
    const scroll = this.collectionScroll = ui.node(scrollSpec.id).addComponent(OriginalWeaponScroll);
    scroll.content = this.collectionContent; scroll.configure(scrollSpec.layout!);
    scroll.onPositionChanged = () => { if (this.roots.get('collection')?.active) for (const _ of this.refreshCollectionSteps()) { /* visible rows only */ } };
    this.scrolls.push(scroll);
  }

  private ensureCollection(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Weapon HUD destroyed'));
    if (this.roots.has('collection')) return Promise.resolve();
    if (this.collectionRequest) return this.collectionRequest;
    const generation = this.collectionGeneration;
    const ui = this.collectionUi = new OriginalWeaponUi(this.art, this.assets);
    const id = this.assets.config.roots.collection;
    const steps = this.createCollectionSteps(ui);
    const guarded = function* (this: WeaponHud): Generator<void> {
      try {
        for (;;) {
          if (this.destroyed || !this.node.isValid || generation !== this.collectionGeneration) throw new Error('Weapon collection cancelled');
          const step = steps.next(); if (step.done) return; yield;
        }
      } finally { steps.return(undefined); }
    };
    const request = this.prepareCollectionAssets().then(() => {
      if (this.destroyed || generation !== this.collectionGeneration) throw new Error('Weapon collection cancelled');
      const work = guarded.call(this);
      if (this.prepareCollection) return this.prepareCollection(work);
      for (const _ of work) { /* synchronous standalone HUD */ }
    }).then(() => {
      if (this.destroyed || !this.node.isValid || generation !== this.collectionGeneration) throw new Error('Weapon collection cancelled');
      this.roots.set('collection', ui.node(id));
    }).catch(error => {
      const root = ui.get(id); if (root) { root.active = false; root.destroy(); }
      ui.destroy();
      this.scrolls = this.scrolls.filter(scroll => scroll.node.isValid);
      if (this.collectionRequest === request) { this.collectionRequest = undefined; this.collectionPool.length = 0; this.collectionBindings.clear(); this.collectionScroll = undefined; this.collectionContent = undefined; this.collectionViewport = undefined; this.collectionWindowKey = ''; }
      throw error;
    });
    this.collectionRequest = request;
    return request;
  }

  private openCollection(): void {
    if (this.destroyed || this.collectionOpening) return;
    this.cancelInteractions();
    if (this.roots.has('collection')) {
      this.roots.get('collection')!.active = true; this.refresh(); this.notifyVisibility(); return;
    }
    this.collectionOpening = true;
    const version = ++this.collectionOpenVersion;
    this.alerts.show('正在准备武器图鉴…'); this.notifyVisibility();
    void (this.onCollectionRequested?.() ?? this.ensureCollection()).then(() => {
      if (this.destroyed || version !== this.collectionOpenVersion) return;
      this.collectionOpening = false;
      if (this.roots.get('inventory')!.active) this.openCollection();
    }, () => {
      if (this.destroyed || version !== this.collectionOpenVersion) return;
      this.collectionOpening = false;
      this.alerts.show('武器图鉴准备失败，请重新点击'); this.notifyVisibility();
    });
  }
  setEntryOffset(y: number): void {
    this.entryOffset = y; this.roots.get('entry')!.setPosition(-this.width / 2, -this.height / 2 + y);
  }
  setEntryBlocked(blocked: boolean): void {
    this.entryBlocked = blocked;
    if (!blocked) return;
    const entry = this.roots.get('entry')!;
    this.buttonTouches.delete(entry); this.feedback.cancelButton(entry);
  }
  getTutorialTargets(): WeaponTutorialTargets {
    const snapshot = this.session.weapons.snapshot(), inventoryVisible = visibleInHierarchy(this.roots.get('inventory')!);
    const tutorial = this.session.getTutorialState();
    let from: Node | null = null, to: Node | null = null;
    if (inventoryVisible && tutorial.active && tutorial.step === 'gunMerge') {
      const pair = snapshot.backpack.map((item, index) => ({ item, index })).filter(({ item }) =>
        item && !item.locked && !item.pendingAd && getWeaponGrade(item.weaponId) === WEAPON_TUTORIAL_RULES.drawGrade).slice(0, 2);
      if (pair.length === 2) {
        from = this.ui.node(this.backpack[pair[0].index].node); to = this.ui.node(this.backpack[pair[1].index].node);
      }
    } else if (inventoryVisible && tutorial.active && tutorial.step === 'gunEquip') {
      const index = snapshot.backpack.findIndex(item => item !== null && !item.pendingAd && item.weaponId === WEAPON_TUTORIAL_RULES.mergeWeaponId);
      if (index >= 0) { from = this.ui.node(this.backpack[index].node); to = this.ui.node(this.slots[1].node); }
    }
    return { entry: this.roots.get('entry')!, buy: this.ui.node('level0:802'),
      from, to,
      blocked: this.hasNestedModal() || this.roots.get('newGun')!.active || snapshot.pendingAd !== null || this.drag !== null };
  }
  open(): void {
    const snapshot = this.session.weapons.snapshot();
    if (!snapshot.unlocked) { this.alerts.show(snapshot.unlockMessage || '武器功能尚未开放。'); return; }
    this.roots.get('inventory')!.active = true;
    this.session.onWeaponPanelOpened(); this.refresh(this.session.weapons.snapshot()); this.notifyVisibility();
  }
  close(): void {
    this.cancelInteractions(); for (const [name, root] of this.roots) if (name !== 'entry') root.active = false;
    this.shownNotice = null; this.notifyVisibility();
  }
  /** Raid shares permanent slot upgrades without opening or mutating inventory. */
  openStarUpgrade(slot: number, preview?: (level: number) => string | null): void {
    const snapshot = this.session.weapons.snapshot();
    if (!Number.isInteger(slot) || slot < 0 || slot >= snapshot.stars.length) return;
    if (!snapshot.starUnlocked) { this.alerts.show(snapshot.starMessage || '升星尚未开放。'); return; }
    this.cancelInteractions();
    // Bootstrap orders feature dialogs below global overlays, including when
    // this shared star dialog is opened from Raid.
    if (preview) this.close();
    this.starPreview = preview ?? null; this.starIndex = slot;
    this.roots.get('star')!.active = true;
    this.refreshStar(snapshot); this.sound(1); this.notifyVisibility();
  }
  cancelInteractions(): void {
    this.cancelCollectionOpening();
    this.tutorialNeedsRefresh = true;
    this.buttonTouches.clear(); this.feedback?.clear(); this.clearDrag(); this.stopAutoMotion(); this.scrolls.forEach(scroll => scroll.stopAutoScroll());
    for (const node of this.cardScales.keys()) this.setCardScale(node, 1, 0);
    for (const [node, bounce] of this.spawnBounces) node.setScale(...bounce.scale, 1);
    this.spawnBounces.clear();
    this.confetti.clear();
    const pending = this.session.weapons.snapshot().pendingAd, token = this.adToken; this.adToken = null;
    if (token !== null) {
      this.rewardedAds?.cancelRewardedAd(token);
      if (pending?.token === token) this.session.weapons.completeAd(token, 'cancel');
    }
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.cancelInteractions(); this.releaseCollection(); this.destroyed = true; this.confetti.destroy(); this.node.destroy(); this.ui.destroy();
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.releaseCollection();
    this.destroyed = true; this.node.active = false;
    this.confetti?.destroy();
  }


  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0, refresh = true): Generator<void> {
    this.cancelInteractions(); this.collectionRevision = '';
    const scale = width / this.assets.config.referenceWidth;
    this.width = width / scale; this.height = (height - topInset - bottomInset) / scale;
    this.layoutVersion++; this.topOverflow = topInset / scale; this.bottomOverflow = bottomInset / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(this.width, this.height);
    for (const [name, id] of Object.entries(this.assets.config.roots)) {
      if (name === 'entry' || !this.roots.has(name)) continue;
      yield* (name === 'collection' ? this.collectionUi : this.ui).layoutSteps(id, this.width, this.height, this.topOverflow, this.bottomOverflow);
    }
    yield* this.ui.layoutSteps(this.assets.config.roots.entry, 130, 120);
    // Original Btn_list / Left_Menu place the button's bottom 295 above the safe edge.
    // Gun_Btn has a left-center pivot, so its 120-high layout adds another 60.
    this.setEntryOffset(this.entryOffset);
    this.alignBackpack();
    if (refresh) yield* this.refreshSteps();
  }

  update(dt: number): void {
    this.clock += dt;
    const mainTutorialActive = this.session.getTutorialState().active;
    if (mainTutorialActive) { this.feedback.clearTutorial(); this.stopAutoMotion(); }
    let snapshot = this.session.weapons.snapshot();
    if (this.tutorialNeedsRefresh && this.adToken === null) this.refreshTutorial(snapshot);
    this.feedback.update(dt); this.cancelHiddenButtons();
    this.updateAnimations(dt);
    if (this.roots.get('star')!.active) this.confetti.update(dt); else this.confetti.clear();
    if (this.session.weapons.revision !== snapshot.revision) snapshot = this.session.weapons.snapshot();
    if (!snapshot.unlocked && this.isOpen) this.close();
    if (this.adToken !== null && snapshot.pendingAd?.token !== this.adToken) {
      const token = this.adToken; this.adToken = null; this.rewardedAds?.cancelRewardedAd(token);
    }
    this.roots.get('entry')!.active = snapshot.unlocked;
    if (this.isOpen && (snapshot.revision !== this.lastRevision || this.policyKey(snapshot) !== this.lastPolicy)) {
      if (this.drag && this.drag.revision !== snapshot.revision) this.clearDrag();
      this.refresh(snapshot);
    }
    for (const notice of this.session.weapons.drainNotifications()) this.showNotice(notice);
    if (this.session.weapons.revision !== snapshot.revision) snapshot = this.session.weapons.snapshot();
    if (this.autoMotion && !this.validAutoPair()) this.stopAutoMotion();
    if (this.autoMotion) {
      const motion = this.autoMotion; motion.elapsed += dt;
      const distance = this.paintAutoMotion();
      if (distance <= this.list.AutoMerge_MergeDistance * this.node.scale.x) {
        motion.from.setWorldPosition(motion.end);
        // Original AutoMergeRoutine waits for an unrelated backpack drag to end
        // before FuseItems refreshes the list. Drawing does not interrupt it.
        if (!(this.drag?.moved && this.drag.location.kind === 'backpack')) {
          this.stopAutoMotion();
          const result = this.session.weapons.autoMergePair(motion.fromIndex, motion.toIndex, motion.fromWeaponId, motion.toWeaponId);
          this.result(result, false); if (result.ok) { this.spawnBounce(motion.to); this.sound(3); }
          this.autoElapsed = -this.list.AutoMerge_PairDelay;
        }
      }
    } else if (!mainTutorialActive && this.roots.get('inventory')!.active && this.adToken === null && snapshot.auto.enabled) {
      this.autoElapsed += dt; if (this.autoElapsed >= 0) this.startAutoMotion();
    }
    if (Math.floor(this.clock) !== Math.floor(this.clock - dt)) this.refreshTimers(snapshot);
    if (this.roots.get('inventory')!.active) this.ui.setText('level0:117722', this.session.moneyBalance.format());
    this.notifyVisibility();
  }

  private notifyVisibility(): void {
    if (this.starPreview && !this.roots.get('star')!.active) {
      this.starPreview = null;
    }
    if (this.drag && this.hasNestedModal()) this.clearDrag();
    this.cancelHiddenButtons();
    const visible = this.isOpen; if (visible !== this.lastVisible) { this.lastVisible = visible; this.notification(visible); }
  }
  /** A resource wait has no visible modal. A new inventory action cancels only
   * its pending navigation; the shared collection preparation remains reusable. */
  private cancelCollectionOpening(): void {
    if (!this.collectionOpening) return;
    this.collectionOpening = false; this.collectionOpenVersion++;
  }
  private hasNestedModal(): boolean { return this.adToken !== null || ['detail', 'collection', 'probability', 'star'].some(name => this.roots.get(name)?.active); }
  private sound(id: number): void { this.sfx?.play(id); }
  private canUseButton(node: Node): boolean {
    if (this.entryBlocked && node === this.roots.get('entry')) return false;
    if (!visibleInHierarchy(node) || this.adToken !== null) return false;
    let root = node;
    while (root.parent && root.parent !== this.node) root = root.parent;
    // Cocos delivers END to the node that claimed START even if another finger
    // has since opened a popup. Honor the original popup's blocking backdrop.
    const roots = Array.from(this.roots.values());
    for (let index = this.node.children.length - 1; index >= 0; index--) {
      const child = this.node.children[index];
      if (child.active && roots.includes(child) && child !== this.roots.get('entry') && child !== this.roots.get('newGun')) return root === child;
    }
    return true;
  }
  private cancelHiddenButtons(): void {
    for (const node of this.buttonTouches.keys()) if (!this.canUseButton(node)) { this.buttonTouches.delete(node); this.feedback.cancelButton(node); }
    this.feedback.cancelHiddenButtons();
  }

  private bindButton(spec: OriginalUiNode, ui = this.ui): void {
    if (!spec.button?.length || spec.id === 'level0:2027' || spec.id === 'level0:483') return;
    const node = ui.node(spec.id);
    node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true; if (this.buttonTouches.has(node) || !this.canUseButton(node)) return;
      const opensCollection = spec.button!.some(call => call.method === 'UI_Reload' ||
        call.method === 'SetActive' && call.target === this.assets.config.roots.collection && call.arguments.m_BoolArgument);
      if (!opensCollection) this.cancelCollectionOpening();
      const target = spec.button!.find(call => call.method === 'Touch')?.target;
      this.buttonTouches.set(node, { pointer: event.getID() ?? -1, weapon: target ? this.collectionBindings.get(target) : undefined }); this.feedback.press(node, spec);
    });
    node.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
      if (this.buttonTouches.get(node)?.pointer !== (event.getID() ?? -1)) return;
      this.buttonTouches.delete(node); this.feedback.cancelButton(node);
    });
    node.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
      event.propagationStopped = true; const begin = this.buttonTouches.get(node);
      if (!begin || begin.pointer !== (event.getID() ?? -1)) return; this.buttonTouches.delete(node);
      this.feedback.release(node);
      if (!this.canUseButton(node) || !node.getComponent(UITransform)!.getBoundingBoxToWorld().contains(event.getUILocation())) return;
      const target = spec.button!.find(call => call.method === 'Touch')?.target;
      if (target && begin.weapon !== this.collectionBindings.get(target)) return;
      spec.button!.forEach(call => this.invoke(call.target, call.method, call.arguments));
      if (spec.clickSound !== undefined) this.sound(spec.clickSound);
      this.cancelHiddenButtons(); this.notifyVisibility();
    });
  }

  private invoke(target: string, method: string, args: Record<string, any>): void {
    if (method === 'SetActive') {
      const name = Object.keys(this.assets.config.roots).find(name => this.assets.config.roots[name] === target);
      if (name === 'inventory' && args.m_BoolArgument) this.open();
      else if (name === 'inventory') this.close();
      else if (name === 'newGun' && !args.m_BoolArgument) this.dismissNotice();
      else if (name === 'collection') {
        if (args.m_BoolArgument) this.openCollection();
        else { this.cancelCollectionOpening(); this.collectionUi.show(target, false); }
      }
      else this.ui.show(target, !!args.m_BoolArgument);
    } else if (method === 'ReloadGunUI') this.refresh();
    else if (method === 'DrawRandom_Normal') { if (!this.hasNestedModal()) this.draw(); }
    else if (method === 'UI_Reload') this.openCollection();
    else if (method === 'AD_Draw_Btn_Click') this.beginAd('daily');
    else if (method === 'AutoMerge_Change') {
      const auto = this.session.weapons.snapshot().auto;
      this.result(this.session.weapons.setAutoMerge(!auto.enabled));
    } else if (method === 'onClick_Pause' || method === 'onClick_Unpause') {
      if (this.detailLocation) this.result(this.session.weapons.toggleLock(this.detailLocation));
    } else if (method === 'onClick_PauseLock') { this.alerts.show(this.session.weapons.snapshot().lockMessage || '保护锁尚未开放。'); this.sound(5); }
    else if (method === 'Touch') {
      const id = this.collectionBindings.get(target) ?? this.assets.config.roles[target]?.GunNum;
      if (typeof id === 'number') this.openDetail(id, null);
    } else if (method === 'Unequip') { const result = this.session.weapons.unequip(this.assets.config.roles[target].SlotNum); this.result(result); if (result.ok) this.sound(13); }
    else if (method === 'onClick_StarUpgrade') {
      this.openStarUpgrade(this.assets.config.roles[target].SlotNum);
    } else if (method === 'onClick_Upgrade') {
      const result = this.session.weapons.upgradeStar(this.starIndex); this.result(result);
      if (result.ok) {
        this.alerts.showLocalized(`StarUpgrade/${result.status === 'success' ? 'StarUpgradeSuccess' : 'StarUpgradeFail'}`);
        this.sound(result.status === 'success' ? 15 : 16);
        if (result.status === 'success') this.confetti.play();
      }
    }
  }

  private draw(): boolean {
    const index = this.session.weapons.snapshot().backpack.findIndex(item => !item);
    const result = this.session.weapons.draw(); this.result(result);
    if (result.ok) { this.spawnBounce(this.ui.node(this.backpack[index].node)); this.sound(2); }
    else if (result.reason === 'notEnoughDiamonds' || result.reason === 'backpackFull') this.sound(5);
    return result.ok;
  }
  private result(result: WeaponActionResult, showError = true): void {
    if (!result.ok && showError && result.reason !== 'adCancelled') {
      const term = ERROR_TERM[result.reason || ''];
      if (result.reason === 'weaponsLocked') this.alerts.show(this.session.weapons.snapshot().unlockMessage || '武器功能尚未开放。');
      else if (result.reason === 'tutorialStep') {
        const tutorial = this.session.getTutorialState();
        this.alerts.show(tutorial.step === 'gunBuy' ? `请先抽取 ${WEAPON_TUTORIAL_RULES.drawCount} 次武器（${tutorial.drawCount}/${WEAPON_TUTORIAL_RULES.drawCount}）。`
          : tutorial.step === 'gunMerge' ? '请先将两把 D 级武器拖到一起合成。'
          : tutorial.step === 'gunEquip' ? '请先穿戴刚合成的 C 级弩。' : '请先完成当前的新手引导。');
      }
      else if (term) this.alerts.showLocalized(term);
      else this.alerts.show(ERROR_TEXT[result.reason || ''] || '当前无法进行此操作。');
    }
    this.refresh();
  }
  private beginAd(kind: AdKind): void {
    const result = this.session.weapons.beginAd(kind); this.result(result); if (!result.ok) return;
    const pending = this.session.weapons.snapshot().pendingAd; if (!pending) return;
    const token = pending.token; this.adToken = token;
    this.buttonTouches.clear(); this.feedback.clear(); this.stopAutoMotion();
    const complete = (outcome: AdOutcome): void => { if (this.adToken === token) this.completeAd(outcome); };
    if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, ({ daily: 'weapon-daily', weapon: 'weapon-unlock' } as const)[kind], complete);
    else complete('failure');
    this.notifyVisibility();
  }
  private completeAd(outcome: AdOutcome): void {
    const snapshot = this.session.weapons.snapshot(), pending = snapshot.pendingAd, token = this.adToken; this.adToken = null;
    if (token !== null) this.rewardedAds?.cancelRewardedAd(token);
    if (pending && pending.token === token) {
      const result = this.session.weapons.completeAd(pending.token, outcome); this.result(result);
      if (result.ok && outcome === 'success' && pending.kind === 'daily') {
        const index = snapshot.backpack.findIndex(item => !item); if (index >= 0) this.spawnBounce(this.ui.node(this.backpack[index].node)); this.sound(2);
      }
    } this.notifyVisibility();
  }
  private showNotice(notice: WeaponNotice): void {
    // Original Reload replaces the single active notice and restarts its clip.
    this.shownNotice = notice;
    this.applyNoticeLayout();
    this.updateRole(this.newGun, { weaponId: this.shownNotice.weaponId, locked: false, pendingAd: false });
    this.noticeTime = 0; this.roots.get('newGun')!.active = true; this.roots.get('newGun')!.setSiblingIndex(this.node.children.length - 1);
    this.updateNoticeAnimation();
  }
  private dismissNotice(): void { this.shownNotice = null; this.roots.get('newGun')!.active = false; this.notifyVisibility(); }
  private applyNoticeLayout(): void {
    const config = this.assets.config, shadow = this.ui.node(this.newGun.Shadow_img);
    const specs = Object.values(config.nodes);
    const gunRect = specs.find(spec => spec.components.includes(this.newGun.Gun_img))!.rect;
    const shadowRect = specs.find(spec => spec.components.includes(this.newGun.Shadow_img))!.rect;
    // Size and foreground offset come from the shared table in updateRole.
    // This popup only owns its card centre and label layout.
    const [x, y] = gunRect.position;
    const authoredAngle = shadowRect.angle * Math.PI / 180;
    const offsetX = (Math.cos(authoredAngle) * x - Math.sin(authoredAngle) * y) * shadowRect.scale[0];
    const offsetY = (Math.sin(authoredAngle) * x + Math.cos(authoredAngle) * y) * shadowRect.scale[0];
    shadow.setPosition(7 - offsetX, 4 - offsetY, 0);
    // Reserve the two corners for even three-letter grades and category names.
    const grade = this.ui.node(this.newGun.Degree_objs[0]).parent!;
    grade.setScale(.7, .7, 1); grade.setPosition(-68, 54, 0);
    const type = this.ui.node(this.newGun.Type_txt);
    type.setScale(.75, .75, 1); type.setPosition(8.5, -51, 0);
  }
  private openDetail(id: number, location: WeaponLocation | null): void {
    this.detailId = id; this.detailLocation = location;
    this.roots.get('detail')!.active = true; this.roots.get('detail')!.setSiblingIndex(this.node.children.length - 1);
    this.refreshDetail(this.session.weapons.snapshot()); this.notifyVisibility();
  }

  private policyKey(snapshot: WeaponInventorySnapshot): string {
    const tutorial = this.session.getTutorialState();
    return [snapshot.unlocked, snapshot.lockUnlocked, snapshot.starUnlocked, snapshot.auto.unlocked,
      snapshot.dailyAdUnlocked, snapshot.dailyAdAvailable, tutorial.active, tutorial.step, tutorial.drawCount].join(':');
  }
  private refresh(snapshot = this.session.weapons.snapshot()): void {
    for (const _ of this.refreshSteps(snapshot)) { /* synchronous state refresh */ }
  }

  private *refreshSteps(snapshot = this.session.weapons.snapshot()): Generator<void> {
    if (this.drag && this.drag.revision !== snapshot.revision) this.clearDrag();
    if (this.autoMotion && (this.session.getTutorialState().active || !this.validAutoPair())) this.stopAutoMotion();
    this.lastRevision = snapshot.revision;
    this.lastPolicy = this.policyKey(snapshot);
    this.roots.get('entry')!.active = snapshot.unlocked;
    for (const [index, role] of this.backpack.entries()) {
      this.ui.show(role.node, !!snapshot.backpack[index]); this.updateRole(role, snapshot.backpack[index]);
      yield;
    }
    for (const [index, role] of this.slots.entries()) {
      this.updateRole(role, snapshot.equipment[index]); this.ui.show(role.Selected_obj, !!snapshot.equipment[index]);
      this.ui.show(role.UnSelected_obj, !snapshot.equipment[index]); this.ui.show(role.StarUpgrade_obj, snapshot.starUnlocked);
      this.ui.setText(role.StarUpgrade_Lv_txt, String(snapshot.stars[index].level));
      this.ui.show(role.UnEquip_Btn_obj, !!snapshot.equipment[index] && snapshot.equipment.filter(Boolean).length > 1);
      const item = snapshot.equipment[index];
      if (item) {
        this.ui.setText(role.Damage_txt, getWeaponStarDamage(item.weaponId, snapshot.stars[index].level).format());
        this.ui.tint(role.Damage_txt, snapshot.stars[index].level > 0 ? [255, 241, 81, 255] : [255, 255, 255, 255]);
      }
      yield;
    }
    if (this.roots.has('collection') && (!this.initialized || this.roots.get('collection')!.active)) yield* this.refreshCollectionSteps(snapshot);
    this.ui.setText('level0:119569', DecimalAmount.from(snapshot.diamonds).format());
    this.ui.show('level0:1491', snapshot.dailyAdUnlocked && snapshot.dailyAdAvailable);
    this.ui.show('level0:17341', snapshot.auto.unlocked); this.ui.show('level0:11925', snapshot.auto.enabled); this.ui.show('level0:30327', !snapshot.auto.enabled);
    this.ui.show('level0:10362', snapshot.auto.enabled); this.ui.show('level0:10186', !snapshot.auto.enabled);
    this.ui.setText('level0:117256', `<sprite=1>${DRAW_PRICE}`);
    const tutorial = this.session.getTutorialState(), drawBlocked = tutorial.active && tutorial.step !== 'gunBuy';
    this.ui.tint('level0:117256', drawBlocked ? [160, 160, 160, 255]
      : snapshot.diamonds >= DRAW_PRICE ? [255, 255, 255, 255] : [255, 109, 109, 255]);
    this.ui.setText('level0:1747', WEAPON_GRADES[ECONOMY_CONFIG.weapons.dailyAd.grade]);
    ['level0:9885', 'level0:9830', 'level0:9827', 'level0:9879'].forEach((id, index) =>
      this.ui.setText(id, `${DRAW_PROBABILITIES[index].percent}%`));
    this.refreshDetail(snapshot); this.refreshStar(snapshot); this.refreshTimers(snapshot);
    this.restoreAutoPair();
    this.refreshTutorial(snapshot);
  }
  private refreshTutorial(snapshot: WeaponInventorySnapshot): void {
    this.tutorialNeedsRefresh = false;
    const pair = snapshot.backpack.map((item, index) => ({ item, index })).filter(({ item }) => item && getWeaponGrade(item.weaponId) === 0 && !item.locked && !item.pendingAd).slice(0, 2);
    if (this.session.getTutorialState().active || !this.roots.get('inventory')!.active || snapshot.firstMerge || pair.length < 2) this.feedback.clearTutorial();
    else this.feedback.setTutorialTargets(this.ui.node(this.backpack[pair[0].index].node), this.ui.node(this.backpack[pair[1].index].node));
  }
  private *refreshCollectionSteps(snapshot = this.session.weapons.snapshot()): Generator<void> {
    if (!this.collectionContent || !this.collectionViewport || !this.collectionPool.length) return;
    const revision = this.collection.map(role => `${role.GunNum}:${Number(snapshot.collection[role.GunNum])}`).join(',');
    const indices = weaponCollectionWindow(this.collection.length, 5, 240, 20, this.collectionContent.position.y,
      this.collectionViewport.getComponent(UITransform)!.height);
    const key = indices.join(','), force = this.collectionWindowKey === '';
    if (revision === this.collectionRevision && key === this.collectionWindowKey) return;
    const used = new Set<number>();
    for (const index of indices) {
      const slotIndex = index % this.collectionPool.length, slot = this.collectionPool[slotIndex], source = this.collection[index];
      const id: number = source.GunNum, role = slot.role;
      used.add(slotIndex);
      const changed = force || slot.index !== index || this.collectionBindings.get(slot.target) !== id;
      if (changed) {
        const node = this.collectionUi.node(role.node); this.buttonTouches.delete(node); this.feedback.cancelButton(node);
        this.collectionUi.rebindTree(role.node, source.node, new Map([[role.Degree_objs[0], source.Degree_objs[getWeaponGrade(id)]]]));
        slot.index = index; this.collectionBindings.set(slot.target, id);
      }
      this.collectionUi.show(role.node, true);
      if (changed || revision !== this.collectionRevision) {
        this.updateRole(role, { weaponId: id, locked: false, pendingAd: false }, this.collectionUi);
        this.collectionUi.tint(role.Locked_obj, [0, 0, 0, 166]);
        this.collectionUi.show(role.Locked_obj, !snapshot.collection[id]);
      }
      yield;
    }
    this.collectionPool.forEach((slot, index) => { if (!used.has(index)) this.collectionUi.show(slot.role.node, false); });
    this.collectionRevision = revision; this.collectionWindowKey = key;
  }
  private updateRole(role: Role, item: WeaponItem | null, ui = this.ui): void {
    ui.show(role.Gun_img, !!item); ui.show(role.Shadow_img, !!item); ui.show(role.Pause_obj, !!item?.locked);
    ui.show(role.AD_Reward_obj, !!item?.pendingAd); ui.show(role.AutoMerge_obj, false); ui.show(role.FusionAble_obj, false);
    const grade = item ? getWeaponGrade(item.weaponId) : -1;
    if (ui !== this.ui || !this.gradeBadges.update(ui, role.Degree_objs, grade))
      (role.Degree_objs || []).forEach((key: string, index: number) => ui.show(key, item !== null && (index === grade || (grade >= role.Degree_objs.length && index === 0))));
    if (!item) { ui.setText(role.Type_txt, ''); ui.setText(role.Damage_txt, ''); ui.setText(role.Speed_txt, ''); return; }
    const weapon = getWeapon(item.weaponId), icon = this.assets.config.gunIcons[item.weaponId];
    applyWeaponUiDisplay(this.assets.config, role as { type: string; Gun_img: string; Shadow_img: string }, item.weaponId, key => ui.node(key));
    ui.image(role.Gun_img, icon); ui.image(role.Shadow_img, icon); ui.tint(role.Panel_img, this.assets.config.degreeColors[grade]);
    ui.setText(role.Type_txt, WEAPON_CATEGORY_NAMES[weapon.category]);
    ui.setText(role.Damage_txt, DecimalAmount.from(weapon.damage).format()); ui.setText(role.Speed_txt, `${Number(weapon.attackInterval.toFixed(2))}s`);
    if (role.Degree_objs?.length < 13) ui.setText(role.Degree_objs[0], grade >= role.Degree_objs.length ? getWeaponGradeName(item.weaponId) : 'D');
  }
  private refreshDetail(snapshot: WeaponInventorySnapshot): void {
    if (!this.roots.get('detail')!.active) return;
    const selected = this.detailLocation ? snapshot[this.detailLocation.kind][this.detailLocation.index] : null;
    if (this.detailLocation && (!selected || selected.weaponId !== this.detailId)) { this.roots.get('detail')!.active = false; return; }
    const item = selected || { weaponId: this.detailId, locked: false, pendingAd: false }, weapon = getWeapon(this.detailId);
    this.updateRole(this.detail, item);
    this.ui.setText(this.detail.Explain_txt, this.assets.config.translations[`${weapon.type}_ex`]);
    this.ui.show(this.detail.TakeOut_Btn_obj, false);
    this.ui.show(this.detail.Unpause_Btn_obj, !!this.detailLocation && snapshot.lockUnlocked && item.locked);
    this.ui.show(this.detail.Pause_Btn_obj, !!this.detailLocation && snapshot.lockUnlocked && !item.locked);
    this.ui.show(this.detail.Pause_Btn_Locked_obj, !!this.detailLocation && !snapshot.lockUnlocked);
  }
  private refreshStar(snapshot: WeaponInventorySnapshot): void {
    if (!this.roots.get('star')!.active) return;
    const star = snapshot.stars[this.starIndex], role = this.star;
    this.ui.setText(role.SlotNum_txt, this.assets.config.translations.SlotUpgrade.replace('{0}', String(this.starIndex + 1))); this.ui.setText(role.StarGem_txt, String(snapshot.starGems));
    this.ui.setText(role.StarLv_txt_Now, String(star.level)); this.ui.setText(role.StarValue_txt_Now, `+${star.bonusPercent.format()}%`);
    this.ui.setText(role.StarLv_txt_After, star.level === 20 ? 'MAX' : String(star.level + 1));
    this.ui.setText(role.StarValue_txt_After, star.nextBonusPercent ? `+${star.nextBonusPercent.format()}%` : 'MAX');
    this.ui.setText(role.Percent_txt, star.successPercent === null ? 'MAX' : `${star.successPercent}%`);
    this.ui.setText(role.UpgradePrice_txt, star.cost === null ? 'MAX' : `<sprite=0>${star.cost}`);
    const item = snapshot.equipment[this.starIndex];
    const damage = this.starPreview ? this.starPreview(star.level) : item ? getWeaponStarDamage(item.weaponId, star.level).format() : null;
    this.ui.show(role.Damage_Value_obj, damage !== null);
    if (damage !== null) {
      this.ui.setText(role.DamageValue_txt_Now, damage);
      this.ui.setText(role.DamageValue_txt_After, !star.nextBonusPercent ? 'MAX' :
        this.starPreview ? this.starPreview(star.level + 1) ?? '' : getWeaponStarDamage(item!.weaponId, star.level + 1).format());
    }
    const colorIndex = star.cost !== null && snapshot.starGems >= star.cost ? 1 : 0;
    for (const [target, colors] of [[role.Upgrade_Btn_img, role.UpgradeBtn_Colors], [role.UpgradePrice_txt, role.UpgradePrice_Colors]]) {
      const color = colors[colorIndex]; this.ui.tint(target, [color.r, color.g, color.b, color.a].map(value => Math.round(value * 255)));
    }
  }
  private refreshTimers(snapshot: WeaponInventorySnapshot): void {
    const left = Math.max(0, Math.floor((snapshot.adGunExpiresAt - this.session.weapons.now) / 1000));
    this.backpack.forEach((role, index) => {
      if (snapshot.backpack[index]?.pendingAd) this.ui.setText(role.AD_Time_txt, `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
    });
  }

  private bindDrag(node: Node, location: WeaponLocation): void {
    const role = location.kind === 'backpack' ? this.backpack[location.index] : this.slots[location.index];
    this.cardBaseScales.set(node, this.assets.config.nodes[role.node].rect.scale);
    node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true; if (this.drag || this.hasNestedModal()) return;
      if (location.kind === 'backpack' && this.isAutoSlot(location.index)) return;
      const snapshot = this.session.weapons.snapshot(), item = snapshot[location.kind][location.index]; if (!item) return;
      this.cancelCollectionOpening();
      const start = event.getUILocation();
      this.spawnBounces.delete(node); this.setCardScale(node, 1, 0);
      const origin = node.worldPosition.clone();
      this.drag = { location, pointer: event.getID() ?? -1, start, last: start, moved: false, node,
        origin, offset: new Vec2(start.x - origin.x, start.y - origin.y), revision: snapshot.revision,
        overlap: null, displacedTo: null, fusion: null, slot: null };
      this.setCardScale(node, role.PressScale ?? .9, role.PressAnimDuration ?? .08);
    });
    node.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => { event.propagationStopped = true; this.moveDrag(event); });
    node.on(Node.EventType.TOUCH_END, (event: EventTouch) => { event.propagationStopped = true; this.finishDrag(event); });
    node.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
      event.propagationStopped = true;
      // Cocos 3.8.8 rewrites .type when releasing outside the claimed node;
      // the constructor's event code still distinguishes END from platform CANCEL.
      if (event.getEventCode() === Input.EventType.TOUCH_END) this.finishDrag(event); else this.cancelDrag(event);
    });
  }
  private moveDrag(event: EventTouch): void {
    const drag = this.drag; if (!drag || drag.pointer !== (event.getID() ?? -1)) return;
    if (this.hasNestedModal()) { this.clearDrag(); return; }
    const snapshot = this.session.weapons.snapshot();
    if (drag.revision !== snapshot.revision) { this.clearDrag(); return; }
    drag.last = event.getUILocation();
    if (!drag.moved && Vec2.distance(drag.start, drag.last) > 14) {
      drag.moved = true; this.setCardScale(drag.node, 1, 0);
      drag.node.setSiblingIndex(drag.node.parent!.children.length - 1);
    }
    if (!drag.moved) return;
    // Move the original card at full opacity, preserving where it was grabbed.
    drag.node.setWorldPosition(drag.last.x - drag.offset.x, drag.last.y - drag.offset.y, drag.origin.z);
    this.updateDragFeedback(drag, snapshot);
  }
  private finishDrag(event: EventTouch): void {
    const drag = this.drag; if (!drag || drag.pointer !== (event.getID() ?? -1)) return;
    if (this.hasNestedModal()) { this.clearDrag(); return; }
    const snapshot = this.session.weapons.snapshot();
    if (snapshot.revision !== drag.revision) { this.clearDrag(); return; }
    if (drag.moved) this.moveDrag(event);
    if (this.drag !== drag) return;
    const position = event.getUILocation(), cardPosition = drag.node.worldPosition.clone();
    const item = snapshot[drag.location.kind][drag.location.index];
    const inBackpack = this.ui.node(this.list.node).getComponent(UITransform)!.getBoundingBoxToWorld().contains(position);
    this.clearDrag(true);
    if (!item) return;
    if (!drag.moved) {
      this.setCardScale(drag.node, 1.05, .08, [[.98, .06], [1, .05]]);
      if (!drag.node.getComponent(UITransform)!.getBoundingBoxToWorld().contains(position)) return;
      if (item.pendingAd) this.beginAd('weapon'); else { this.openDetail(item.weaponId, drag.location); this.sound(1); } return;
    }
    if (drag.slot !== null) { this.drop(drag.location, { kind: 'equipment', index: drag.slot }); return; }
    if (drag.location.kind === 'equipment') {
      if (inBackpack) { const result = this.session.weapons.unequip(drag.location.index); this.result(result); if (result.ok) this.sound(13); }
      return;
    }
    if (drag.overlap !== null) {
      const other = snapshot.backpack[drag.overlap]!;
      if (getWeaponGrade(item.weaponId) === getWeaponGrade(other.weaponId)) {
        if (item.locked || other.locked) { this.result({ ok: false, reason: 'protected' }); this.sound(5); }
        else if (item.pendingAd || other.pendingAd) this.beginAd('weapon');
        else this.drop(drag.location, { kind: 'backpack', index: drag.overlap });
      } else this.result(this.session.weapons.moveBackpack(drag.location.index, drag.overlap, drag.displacedTo!));
    } else {
      const nearest = this.nearestEmptySlot(cardPosition, snapshot, drag.location.index);
      if (nearest !== drag.location.index) this.result(this.session.weapons.moveBackpack(drag.location.index, nearest));
    }
  }
  private cancelDrag(event: EventTouch): void { if (this.drag?.pointer === (event.getID() ?? -1)) this.clearDrag(); }
  private clearDrag(animate = false): void {
    const drag = this.drag;
    if (drag) {
      drag.node.setWorldPosition(drag.origin); this.setCardScale(drag.node, 1, animate ? .15 : 0);
      if (drag.fusion !== null) this.setCardScale(this.ui.node(this.backpack[drag.fusion].node), 1, animate ? .15 : 0);
      if (drag.slot !== null) this.setCardScale(this.ui.node(this.slots[drag.slot].node), 1, animate ? .15 : 0);
      this.alignBackpack();
    }
    this.drag = null; this.backpack?.forEach(role => this.ui.show(role.FusionAble_obj, false));
  }
  private nearestEmptySlot(position: Vec3, snapshot: WeaponInventorySnapshot, source: number, exclude = -1): number {
    let nearest = source, distance = Infinity;
    for (let index = 0; index < this.backpack.length; index++) {
      if (index === exclude || (index !== source && snapshot.backpack[index])) continue;
      const at = this.ui.node(this.list.SlotTransforms[index]).worldPosition;
      const d = (position.x - at.x) ** 2 + (position.y - at.y) ** 2;
      if (d < distance) { distance = d; nearest = index; }
    }
    return nearest;
  }
  private updateDragFeedback(drag: DragState, snapshot: WeaponInventorySnapshot): void {
    let slot: number | null = null;
    this.slots.forEach((role, index) => {
      if (drag.location.kind === 'equipment' && drag.location.index === index) return;
      if (this.ui.node(role.node).getComponent(UITransform)!.getBoundingBoxToWorld().contains(drag.last)) slot = index;
    });
    if (slot !== drag.slot) {
      if (drag.slot !== null) this.setCardScale(this.ui.node(this.slots[drag.slot].node), 1, .15);
      if (slot !== null) this.setCardScale(this.ui.node(this.slots[slot].node), 1.05, .15);
      drag.slot = slot;
    }
    if (drag.location.kind !== 'backpack') return;
    // Gun_Item.CheckOverlap uses logical grid positions, never the displaced view.
    const from = snapshot.backpack[drag.location.index]!, position = drag.node.worldPosition;
    const sourceSpec = this.assets.config.nodes[this.backpack[drag.location.index].node];
    const shrink = this.backpack[drag.location.index].OverlapShrink;
    const scale = this.node.scale.x;
    let overlap: number | null = null, distance = Infinity;
    this.backpack.forEach((role, index) => {
      if (index === drag.location.index || !snapshot.backpack[index] || this.isAutoSlot(index)) return;
      const at = this.ui.node(this.list.SlotTransforms[index]).worldPosition;
      const targetSpec = this.assets.config.nodes[role.node];
      const dx = position.x - at.x, dy = position.y - at.y;
      const halfWidth = (sourceSpec.rect.size[0] / 2 + targetSpec.rect.size[0] / 2 - shrink * 2) * scale;
      const halfHeight = (sourceSpec.rect.size[1] / 2 + targetSpec.rect.size[1] / 2 - shrink * 2) * scale;
      if (Math.abs(dx) < halfWidth && Math.abs(dy) < halfHeight && dx * dx + dy * dy < distance) {
        overlap = index; distance = dx * dx + dy * dy;
      }
    });
    if (overlap !== drag.overlap) {
      if (drag.overlap !== null && drag.displacedTo !== null) {
        this.ui.node(this.backpack[drag.overlap].node).setWorldPosition(this.ui.node(this.list.SlotTransforms[drag.overlap]).worldPosition);
      }
      drag.overlap = overlap; drag.displacedTo = null;
      if (overlap !== null && getWeaponGrade(from.weaponId) !== getWeaponGrade(snapshot.backpack[overlap]!.weaponId)) {
        const at = this.ui.node(this.list.SlotTransforms[overlap]).worldPosition;
        drag.displacedTo = this.nearestEmptySlot(at, snapshot, drag.location.index, overlap);
        this.ui.node(this.backpack[overlap].node).setWorldPosition(this.ui.node(this.list.SlotTransforms[drag.displacedTo]).worldPosition);
      }
    }
    const other = overlap === null ? null : snapshot.backpack[overlap];
    const fusion = other && !from.locked && !other.locked && getWeaponGrade(from.weaponId) === getWeaponGrade(other.weaponId) ? overlap : null;
    if (fusion !== drag.fusion) {
      if (drag.fusion !== null) this.setCardScale(this.ui.node(this.backpack[drag.fusion].node), 1, .15);
      this.setCardScale(drag.node, fusion === null ? 1 : 1.05, .15);
      if (fusion !== null) {
        this.setCardScale(this.ui.node(this.backpack[fusion].node), 1.05, .15);
        const device = globalThis as unknown as { navigator?: { vibrate?: (milliseconds: number) => boolean } };
        device.navigator?.vibrate?.(30);
      }
      drag.fusion = fusion;
    }
    this.backpack.forEach((role, index) => this.ui.show(role.FusionAble_obj, fusion !== null && (index === fusion || index === drag.location.index)));
  }
  private drop(from: WeaponLocation, to: WeaponLocation): void {
    if (from.kind === to.kind && from.index === to.index) return;
    const inventory = this.session.weapons, snapshot = inventory.snapshot(); let result: WeaponActionResult, merged = false;
    if (from.kind === 'backpack' && to.kind === 'equipment') {
      // Source EquipToSlot offers the ad when its unclaimed gun is dropped on
      // an equipment slot; claiming leaves it in the backpack until equipped.
      if (snapshot.backpack[from.index]?.pendingAd) { this.beginAd('weapon'); return; }
      result = inventory.equip(from.index, to.index);
    }
    else if (from.kind === 'equipment' && to.kind === 'equipment') result = inventory.swapEquipment(from.index, to.index);
    else if (from.kind === 'equipment') result = inventory.unequip(from.index);
    else {
      const a = snapshot.backpack[from.index], b = snapshot.backpack[to.index];
      merged = !!(a && b && getWeaponGrade(a.weaponId) === getWeaponGrade(b.weaponId));
      result = merged ? inventory.merge(from.index, to.index) : inventory.moveBackpack(from.index, to.index);
    }
    this.result(result); if (result.ok) {
      if (merged || to.kind === 'equipment') this.sound(merged ? 3 : 9);
      if (merged) this.spawnBounce(this.ui.node(this.backpack[to.index].node));
      // EquipToSlot and PerformSlotSwap exchange even equal-grade guns, then
      // explain that equipped guns must be removed before they can be fused.
      const source = snapshot[from.kind][from.index], target = snapshot[to.kind][to.index];
      if (to.kind === 'equipment' && source && target && getWeaponGrade(source.weaponId) === getWeaponGrade(target.weaponId)) {
        this.alerts.showLocalized('Alarm/SelectedFusionError');
      }
    } else this.sound(5);
  }
  private setCardScale(node: Node, to: number, duration: number, next: [number, number][] = []): void {
    const base = this.cardBaseScales.get(node)!;
    if (duration === 0) { this.cardScales.delete(node); node.setScale(base[0] * to, base[1] * to, 1); return; }
    this.cardScales.set(node, { elapsed: 0, from: node.scale.x / base[0], to, duration, next });
  }
  private spawnBounce(node: Node): void {
    if (this.autoMotion && (node === this.autoMotion.from || node === this.autoMotion.to)) return;
    const spec = Object.values(this.assets.config.nodes).find(spec => this.ui.get(spec.id) === node)!;
    this.cardScales.delete(node);
    this.spawnBounces.set(node, { elapsed: 0, scale: spec.rect.scale }); node.setScale(0, 0, 1);
  }
  private updateAnimations(dt: number): void {
    for (const [node, motion] of this.cardScales) {
      motion.elapsed += dt;
      while (motion.elapsed >= motion.duration && motion.next.length) {
        motion.elapsed -= motion.duration; motion.from = motion.to;
        [motion.to, motion.duration] = motion.next.shift()!;
      }
      const p = Math.min(1, motion.elapsed / motion.duration), scale = motion.from + (motion.to - motion.from) * p * p * (3 - 2 * p);
      const base = this.cardBaseScales.get(node)!; node.setScale(base[0] * scale, base[1] * scale, 1);
      if (p === 1) this.cardScales.delete(node);
    }
    // _SpawnBounceCoroutine_d__74: source four SmoothStep segments, .34 s total.
    const segments = [[.15, 0, 1.1], [.08, 1.1, .95], [.06, .95, 1.02], [.05, 1.02, 1]];
    for (const [node, bounce] of this.spawnBounces) {
      bounce.elapsed += dt; let t = bounce.elapsed, scale = 1;
      for (const [duration, start, end] of segments) {
        if (t < duration) { const p = t / duration; scale = start + (end - start) * p * p * (3 - 2 * p); break; }
        t -= duration;
      }
      node.setScale(bounce.scale[0] * scale, bounce.scale[1] * scale, 1);
      if (bounce.elapsed >= .34) this.spawnBounces.delete(node);
    }
    if (this.shownNotice) {
      this.noticeTime += dt; this.updateNoticeAnimation();
      if (this.noticeTime >= (this.assets.config.newGunAnimation?.duration || 2)) this.dismissNotice();
    }
  }
  private updateNoticeAnimation(): void {
    const clip = this.assets.config.newGunAnimation; if (!clip) return;
    for (const track of clip.tracks) {
      const values = track.curves.map(curve => {
        let key = curve[0]; for (const candidate of curve) { if (candidate.time > this.noticeTime) break; key = candidate; }
        const t = this.noticeTime - key.time, [a, b, c, d] = key.coefficients; return ((a * t + b) * t + c) * t + d;
      });
      this.ui.node(track.node).setScale(values[0], values[1], values[2]);
    }
    const glow = this.ui.node('level0:19309'); glow.angle = this.assets.config.nodes['level0:19309'].rect.angle + this.noticeTime * clip.glowRotationSpeed;
  }
  private alignBackpack(): void {
    if (!this.backpack) return;
    this.backpack.forEach((role, index) => this.ui.node(role.node).setWorldPosition(this.ui.node(this.list.SlotTransforms[index]).worldPosition));
    this.paintAutoMotion();
  }
  private startAutoMotion(): void {
    if (this.session.getTutorialState().active) return;
    // FindAutoMergePair skips the dragged card and its fusion/swap target;
    // unrelated pairs still move, then wait for the drag before transacting.
    const drag = this.drag, excluded: number[] = [];
    if (drag?.location.kind === 'backpack') {
      excluded.push(drag.location.index);
      if (drag.overlap !== null) excluded.push(drag.overlap);
    }
    const pair = this.session.weapons.findAutoMergePair(excluded);
    if (!pair) { this.autoElapsed = -this.list.AutoMerge_PairDelay; return; }
    const { fromIndex, toIndex } = pair;
    const from = this.ui.node(this.backpack[fromIndex].node), to = this.ui.node(this.backpack[toIndex].node);
    this.autoMotion = { ...pair, from, to,
      start: this.ui.node(this.list.SlotTransforms[fromIndex]).worldPosition.clone(),
      end: this.ui.node(this.list.SlotTransforms[toIndex]).worldPosition.clone(), elapsed: 0 };
    this.restoreAutoPair();
  }
  private isAutoSlot(index: number): boolean { return !!this.autoMotion && (index === this.autoMotion.fromIndex || index === this.autoMotion.toIndex); }
  private validAutoPair(): boolean { return !!this.autoMotion && this.session.weapons.isAutoMergePairValid(this.autoMotion); }
  private restoreAutoPair(): void {
    const motion = this.autoMotion; if (!motion) return;
    for (const index of [motion.fromIndex, motion.toIndex]) {
      const role = this.backpack[index], node = this.ui.node(role.node);
      this.spawnBounces.delete(node); this.setCardScale(node, 1, 0);
      this.ui.show(role.FusionAble_obj, false); this.ui.show(role.AutoMerge_obj, true);
    }
    this.paintAutoMotion();
  }
  private paintAutoMotion(): number {
    const motion = this.autoMotion; if (!motion) return Infinity;
    const p = Math.min(1, motion.elapsed / this.list.AutoMerge_MoveDuration), t = p * p * (3 - 2 * p);
    motion.from.setWorldPosition(motion.start.x + (motion.end.x - motion.start.x) * t,
      motion.start.y + (motion.end.y - motion.start.y) * t, motion.start.z);
    motion.from.setSiblingIndex(motion.from.parent!.children.length - 1);
    return Math.hypot(motion.from.worldPosition.x - motion.end.x, motion.from.worldPosition.y - motion.end.y);
  }
  private stopAutoMotion(): void {
    const motion = this.autoMotion; if (!motion) return; this.autoMotion = null;
    for (const index of [motion.fromIndex, motion.toIndex]) {
      const role = this.backpack[index]; this.ui.show(role.AutoMerge_obj, false);
      this.ui.node(role.node).setWorldPosition(this.ui.node(this.list.SlotTransforms[index]).worldPosition);
    }
  }
  private installScrolls(ui = this.ui): void {
    for (const spec of Object.values(this.assets.config.nodes)) {
      if (spec.layoutType !== 'ScrollRect' || !ui.get(spec.id)) continue;
      const node = ui.node(spec.id), scroll = node.addComponent(OriginalWeaponScroll);
      scroll.content = ui.node(spec.layout!.m_Content); scroll.configure(spec.layout!); this.scrolls.push(scroll);
    }
  }
}
