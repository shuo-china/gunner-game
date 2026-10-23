import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, Color, EventMouse, EventTouch, Font, Graphics, Mask, Node, UITransform, Vec3 } from 'cc';
import { WEAPON_CATEGORY_BY_TYPE, WEAPON_CATEGORY_NAMES } from '../core/WeaponCatalog';
import type { RaidSnapshot, RaidWeaponSnapshot } from '../session/RaidSystem';
import type { RewardedAdPresenter, RewardedAdOutcome } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { applyWeaponUiDisplay, OriginalGradeBadgePool, OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { OriginalWeaponConfetti } from './OriginalWeaponConfetti';
import type { ConfettiRecord } from './OriginalWeaponConfettiMath';

interface Curve { time: number; coefficients: number[]; }
interface Bounce { duration: number; scale: number; middle?: number; }
interface Animation { duration: number; tracks: { node: string; property: 'active' | 'alpha'; curves: Curve[]; bounce?: Bounce }[]; }
interface ButtonColors { target: string; transition: number; normal: number[]; disabled: number[]; highlighted: number[]; pressed: number[]; selected: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean; }
type RaidNode = OriginalUiNode & { bounceStart?: Bounce; buttonColors?: ButtonColors };
interface ButtonTint { spec: RaidNode; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; }
interface SizeTween { node: string; duration: number; delay: number; loopType: number; loops: number; easeType: number; endValue: [number, number]; }
type Role = Record<string, any>;
export interface RaidUiConfig extends WeaponUiConfig {
  nodes: Record<string, RaidNode>; bossSprites: string[]; animation: Animation;
  confetti: ConfettiRecord[]; rotations: { node: string; duration: number; angle: number; delay: number }[];
  fills: { node: string; direction: number }[];
  sizeTweens?: SizeTween[];
}
export interface RaidHudAssets extends WeaponHudAssets { config: RaidUiConfig; }
interface ActionResult { ok: boolean; reason?: string; token?: string; }
export interface RaidHudCallbacks {
  getState(): RaidSnapshot;
  getPhase?(): RaidSnapshot['phase'];
  getWallet?(): { money: string; diamonds: string };
  getSlotStars?(): readonly number[];
  getStarUnlocked?(): boolean;
  open(): ActionResult; close(): ActionResult; start(): ActionResult; exit(): ActionResult;
  selectWeapon(raidSlot: number, sourceIndex: number): ActionResult;
  unselectWeapon(raidSlot: number): ActionResult;
  autoSelectWeapons?(): ActionResult;
  claimMission(index: number): ActionResult;
  openStarUpgrade(raidSlot: number): void;
  beginAd?(): ActionResult; completeAd?(token: string, outcome: RewardedAdOutcome): ActionResult; cancelAd?(): void;
  onBeforeOpen?(): void; onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void; playSfx?(id: number): void;
}
export async function loadRaidHudAssets(art: ArtLibrary): Promise<RaidHudAssets> {
  const config = await art.json<RaidUiConfig>('art/raid-system/config');
  if (config.version !== 1 || !config.roots.start || !config.bitmapFonts || config.bossSprites.length !== 5) throw new Error('Invalid original Raid UI');
  const paths = Object.values(config.images).map(spec => spec.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await Promise.all(paths.map(path => art.loadFrame(path)));
  const placeholder = new Font();
  return { config, chineseFont: placeholder, originalFont: placeholder, numberFont: placeholder };
}

/** UI for Raid（突袭）, separate from the Boss gameplay module.
 * View of the session-owned weekly Raid. Source node IDs are retained for
 * traceability, including each gun slot and every mission progress graphic. */
export class RaidHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private candidatesKey: string | number | null = null;
  private missionsKey: string | number | null = null;
  private readonly ui: OriginalWeaponUi;
  private readonly gradeBadges: OriginalGradeBadgePool;
  private readonly roots = new Map<string, Node>();
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private confetti!: OriginalWeaponConfetti;
  private readonly touches = new Map<Node, number>();
  private readonly graphics = new Map<Node, Node[]>();
  private readonly tints = new Map<Node, ButtonTint>();
  private readonly hovered = new Set<Node>();
  private selected: Node | null = null;
  private readonly fillSizes = new Map<string, { width: number; height: number; x: number; y: number }>();
  private readonly sizeTweenTimes = new Map<string, number>();
  private readonly slots: Role[];
  private readonly candidates: Role[];
  private readonly missions: Role[];
  private readonly startRole: Role;
  private readonly battleRole: Role;
  private readonly missionRole: Role;
  private selectionSlot: number | null = null;
  private missionOpen = false;
  private entryVisible = true;
  private entryBlocked = false;
  private lastVisible = false;
  private previousPhase: RaidSnapshot['phase'] = 'idle';
  private adToken: string | null = null;
  private destroyed = false;
  private externalModalOpen = false;
  private scale = 1;
  private startElapsed = 0;
  private popupElapsed = 0;
  private scrollOffset = 0;
  private scrollTouch: { id: number; y: number; moved: boolean } | null = null;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: RaidHudAssets,
    private readonly callbacks: RaidHudCallbacks, private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalRaidHud', parent); this.ui = new OriginalWeaponUi(art, assets);
    const roles = assets.config.roles;
    this.startRole = roles['level0:124505']; this.battleRole = roles['level0:125222']; this.missionRole = roles['level0:123135'];
    this.slots = this.startRole.Gun_Slot_list.map((key: string) => roles[key]);
    this.candidates = roles['level0:124204'].item_list.map((key: string) => roles[key]);
    this.gradeBadges = new OriginalGradeBadgePool([...this.slots, ...this.candidates.map(role => roles[role.gun_item_demo])]);
    this.missions = this.missionRole.Mission_item_list.map((key: string) => roles[key]);
    const initialize = function* (this: RaidHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, this.node, undefined, this.gradeBadges.include)); root.active = name === 'entry'; this.roots.set(name, root);
        if (['start', 'selection', 'mission', 'result'].includes(name)) {
          root.addComponent(BlockInputEvents);
          root.children.filter(child => ['Panel', 'Mission_Panel'].includes(child.name)).forEach(panel => panel.addComponent(BlockInputEvents));
        }
      }
      // HUD stays behind modal roots despite its later serialized export order.
      ['entry', 'battle', 'start', 'selection', 'mission', 'result'].forEach((name, i) => this.roots.get(name)!.setSiblingIndex(i));
      this.confetti = new OriginalWeaponConfetti(this.ui, assets.config.confetti);
      for (const spec of Object.values(assets.config.nodes)) if (spec.button) { this.bindButton(spec); yield; }
      this.bindMissionScroll(); yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps(this.callbacks.getState()));
      const state = this.callbacks.getState();
      if (state.phase !== 'idle') this.updateState(0, state, false);
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }
  get isOpen(): boolean { return (this.callbacks.getPhase?.() ?? this.callbacks.getState().phase) !== 'idle'; }
  get blocksUpgrades(): boolean { const phase = this.callbacks.getPhase?.() ?? this.callbacks.getState().phase; return phase !== 'idle' && phase !== 'playing'; }
  setExternalModalOpen(open: boolean): void {
    if (this.externalModalOpen === open) return;
    this.externalModalOpen = open; this.clearTouches();
  }
  setEntryVisible(value: boolean): void { if (this.entryVisible === value) return; this.entryVisible = value; this.refreshEntry(this.callbacks.getState()); }
  setEntryBlocked(blocked: boolean): void {
    this.entryBlocked = blocked;
    if (!blocked || this.destroyed) return;
    const entry = this.roots.get('entry')!;
    this.touches.delete(entry); this.feedback.cancelButton(entry);
  }
  open(): void {
    if (this.destroyed) return;
    const state = this.callbacks.getState();
    if (!state.unlocked) { this.callbacks.alert?.(state.unlockMessage || '第40关解锁'); return; }
    if (state.phase !== 'idle') return;
    this.callbacks.onBeforeOpen?.(); this.check(this.callbacks.open());
    this.startElapsed = 0; this.selectionSlot = null; this.missionOpen = false; this.update(0);
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.selectionSlot = null; this.missionOpen = false;
    this.check(this.callbacks.close()); this.update(0);
  }
  cancelInteractions(): void {
    this.clearTouches();
    if (this.adToken !== null) {
      const token = this.adToken; this.adToken = null; this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd?.();
    }
  }
  private entryOffset = 855;
  private entryWidth = 1080;
  private entryHeight = 1920;
  setEntryOffset(y: number): void { this.entryOffset = y; this.roots.get('entry')!.setPosition(this.entryWidth / 2, -this.entryHeight / 2 + y); }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0, refresh = true): Generator<void> {
    if (this.destroyed || width <= 0 || height <= 0) return;
    this.clearTouches(); this.candidatesKey = null; this.missionsKey = null;
    this.scale = width / this.assets.config.referenceWidth;
    const w = width / this.scale, h = (height - topInset - bottomInset) / this.scale;
    this.node.setScale(this.scale, this.scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    for (const [name, id] of Object.entries(this.assets.config.roots)) yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : w, name === 'entry' ? 120 : h,
      name === 'entry' ? 0 : topInset / this.scale, name === 'entry' ? 0 : bottomInset / this.scale);
    // The original fourth column held the paid helper. Center the three retained
    // slots as a group, preserving their authored sizes, spacing and child controls.
    const slotNodes = this.slots.map(role => this.ui.node(role.node));
    const slotCenter = (slotNodes[0].position.x + slotNodes[slotNodes.length - 1].position.x) / 2;
    for (const slot of slotNodes) slot.setPosition(slot.position.x - slotCenter, slot.position.y);
    // Original Right_Menu VerticalLayoutGroup: active entries are 120 high with
    // 5 spacing. Raid follows SpeedRun, Boss and Hunt in the original menu order.
    this.entryWidth = w; this.entryHeight = h;
    this.roots.get('entry')!.setPosition(w / 2, -h / 2 + this.entryOffset);
    this.fillSizes.clear();
    for (const spec of this.assets.config.fills) {
      const node = this.ui.node(spec.node), tr = node.getComponent(UITransform)!;
      const size = { width: tr.width, height: tr.height, x: node.position.x, y: node.position.y };
      this.fillSizes.set(spec.node, size);
      for (const component of this.assets.config.nodes[spec.node].components) this.fillSizes.set(component, size);
      (node.getComponent(Mask) || node.addComponent(Mask)).type = Mask.Type.GRAPHICS_RECT;
    }
    if (refresh) yield* this.refreshSteps(this.callbacks.getState());
  }
  update(dt: number, state = this.callbacks.getState()): void {
    this.updateState(dt, state, true);
  }
  private updateState(dt: number, state: RaidSnapshot, refresh: boolean): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed);
    if (state.phase === 'preparing' || state.phase === 'adPending') { this.startElapsed += elapsed; this.popupElapsed += elapsed; }
    else { this.selectionSlot = null; this.missionOpen = false; }
    if (state.phase === 'result' && this.previousPhase !== 'result') { this.confetti.play(); this.callbacks.playSfx?.(11); }
    if (state.phase !== 'result' && this.previousPhase === 'result') this.confetti.clear();
    if (this.adToken !== null && state.phase !== 'adPending') { const token = this.adToken; this.adToken = null; this.rewardedAds?.cancelRewardedAd(token); }
    if (refresh) this.refresh(state);
    if (state.phase === 'preparing' || state.phase === 'adPending') {
      this.animatePopup('start', this.startElapsed);
      if (this.selectionSlot !== null) this.animatePopup('selection', this.popupElapsed);
      if (this.missionOpen) this.animatePopup('mission', this.popupElapsed);
    }
    if (state.phase === 'result') { this.animateResult(state.resultElapsed); this.confetti.update(elapsed); }
    for (const rotation of this.assets.config.rotations) {
      const node = this.ui.node(rotation.node); if (!visibleInHierarchy(node) || !rotation.duration) continue;
      const time = state.phase === 'result' ? state.resultElapsed : this.startElapsed;
      node.angle = this.assets.config.nodes[rotation.node].rect.angle + Math.max(0, time - rotation.delay) / rotation.duration * rotation.angle;
    }
    this.animateSizes(elapsed); this.updateTints(elapsed); this.previousPhase = state.phase; this.notify();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.cancelInteractions(); this.confetti.destroy(); this.destroyed = true;
    this.node.destroy(); this.ui.destroy(); this.graphics.clear();
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    this.confetti?.destroy();
  }

  private refreshEntry(state: RaidSnapshot): void {
    this.roots.get('entry')!.active = this.entryVisible && state.phase === 'idle';
    this.ui.show('level0:1862', !state.unlocked);
  }

  private refresh(state: RaidSnapshot): void {
    for (const _ of this.refreshSteps(state)) { /* synchronous state refresh */ }
  }

  private *refreshSteps(state: RaidSnapshot): Generator<void> {
    const preparing = state.phase === 'preparing' || state.phase === 'adPending';
    this.roots.get('entry')!.active = this.entryVisible && state.phase === 'idle';
    this.ui.show('level0:1862', !state.unlocked);
    this.roots.get('start')!.active = preparing;
    this.roots.get('selection')!.active = preparing && this.selectionSlot !== null;
    this.roots.get('mission')!.active = preparing && this.missionOpen;
    this.roots.get('battle')!.active = state.phase === 'playing' || state.phase === 'result';
    this.roots.get('result')!.active = state.phase === 'result';
    if (this.initialized && state.phase === 'idle') return;
    const start = this.startRole, battle = this.battleRole;
    this.ui.image(start.Boss_img, this.assets.config.bossSprites[state.bossIndex]);
    this.ui.setText(start.MaxScore_txt, `Score ${state.seasonBestLevel}`);
    this.ui.setText(start.Remain_Time_txt, raidRemainingTime(state.seasonRemainingSeconds));
    this.ui.setText(start.WeakType_txt, this.term('Raid/Raid_Weak').replace('{0}', WEAPON_CATEGORY_NAMES[WEAPON_CATEGORY_BY_TYPE[state.weakness]]));
    this.ui.show(start.Enter_Normal_obj, state.freeRemaining > 0);
    this.ui.show(start.Enter_AD_obj, state.freeRemaining === 0 && state.adEnabled && state.adAvailable);
    this.ui.show(start.Enter_Disable_obj, state.freeRemaining === 0 && !(state.adEnabled && state.adAvailable));
    this.ui.setText(start.Enter_Ticket_txt, `${state.freeRemaining}/${state.freeLimit}`);
    this.ui.setText('level0:117187', `Lv.${state.level}`);
    this.ui.setText(battle.Time_txt, `${state.phase === 'result' ? 0 : Math.max(0, Math.trunc(state.remainingSeconds + 1))}s`);
    this.ui.setText(battle.Health_txt, state.health.format());
    this.ui.show(battle.HighScore_obj, state.newRecord);
    this.ui.setText(battle.HighScore_txt, this.term('Raid/HighScore_History').replace('{0}', `Lv.${Math.max(state.clearedLevels, state.seasonBestLevel)}`));
    this.fill(battle.Time_Fill, state.remainingSeconds / state.durationSeconds); this.fill(battle.HP_Fill, state.healthRatio);
    const colors = battle.Level_Colors.map((value: Record<string, number>) => ['r', 'g', 'b', 'a'].map(c => Math.round(value[c] * 255)));
    this.ui.tint(battle.HP_Fill, colors[Math.max(0, state.level - 1) % colors.length]);
    this.ui.tint(battle.HP_Background_img, colors[Math.max(0, state.level) % colors.length]);
    this.ui.setText('level0:117203', `Lv.${state.clearedLevels}`);
    this.ui.setText('level0:117219', `Lv.${state.seasonBestLevel}`); this.ui.setText('level0:117317', String(state.reward));
    const wallet = this.callbacks.getWallet?.();
    if (wallet) { this.ui.setText('level0:117717', wallet.money); this.ui.setText('level0:119568', wallet.diamonds); }
    const equippedCount = state.slots.filter(Boolean).length;
    const starUnlocked = this.callbacks.getStarUnlocked?.() ?? state.unlocked;
    const slotStars = this.callbacks.getSlotStars?.();
    for (const [index, role] of this.slots.entries()) {
      const item = state.slots[index] || null; this.updateGun(role, item);
      this.ui.show(role.UnEquip_Btn_obj, !!item && equippedCount > 1);
      // Source Raid_GunSlot.Reload ties stars to the slot, including empty slots.
      this.ui.show(role.StarUpgrade_obj, starUnlocked);
      this.ui.setText(role.StarUpgrade_Lv_txt, String(slotStars?.[index] ?? item?.starLevel ?? 0));
      yield;
    }
    const candidatesKey = state.candidatesRevision ?? state.candidates.map(item => `${item.sourceIndex}:${item.weaponId}:${item.damage.format()}:${item.starLevel}:${item.canSelect}:${item.weak}`).join(',');
    if (candidatesKey !== this.candidatesKey) {
      for (const [index, role] of this.candidates.entries()) {
        // Reload(-1) preserves the original empty grid cell and hides its contents.
        const item = state.candidates[index] || null;
        this.updateGun(this.assets.config.roles[role.gun_item_demo], item);
        this.ui.show(role.Disable_obj, !!item && !item.canSelect); this.ui.show(role.Weak_obj, !!item?.weak);
        yield;
      }
      this.candidatesKey = candidatesKey;
    }
    this.ui.show(this.assets.config.roles['level0:125286'].Alert_obj, state.hasClaimable);
    this.ui.setText(this.missionRole.Season_Remain_txt, raidRemainingTime(state.seasonRemainingSeconds));
    yield* this.refreshMissionsSteps(state);
  }
  private updateGun(role: Role, item: RaidWeaponSnapshot | null): void {
    // Gun_Item_Demo is an inactive source template. Its Reload activates the
    // whole card; enabling the icon children alone leaves all contents hidden.
    if (role.type === 'Gun_Item_Demo') this.ui.show(role.node, !!item);
    this.ui.show(role.Selected_obj, !!item); this.ui.show(role.UnSelected_obj, !item);
    this.ui.show(role.Gun_img, !!item); this.ui.show(role.Shadow_img, !!item);
    this.ui.show(role.Weak_obj, !!item?.weak); this.ui.show(role.Weak_Icon_obj, !!item?.weak); this.ui.show(role.Weak_Dmg_Panel, !!item?.weak);
    if (!this.gradeBadges.update(this.ui, role.Degree_objs, item?.grade ?? -1))
      (role.Degree_objs || []).forEach((key: string, grade: number) => this.ui.show(key, !!item && item.grade === grade));
    if (!item) { this.ui.setText(role.Type_txt, ''); this.ui.setText(role.Damage_txt, ''); this.ui.setText(role.Speed_txt, ''); return; }
    const icon = this.assets.config.gunIcons[item.weaponId];
    applyWeaponUiDisplay(this.assets.config, role as { type: string; Gun_img: string; Shadow_img: string }, item.weaponId, key => this.ui.node(key));
    this.ui.image(role.Gun_img, icon); this.ui.image(role.Shadow_img, icon); this.ui.tint(role.Panel_img, this.assets.config.degreeColors[item.grade]);
    this.ui.setText(role.Type_txt, WEAPON_CATEGORY_NAMES[WEAPON_CATEGORY_BY_TYPE[item.type]]); this.ui.setText(role.Damage_txt, item.damage.format());
    this.ui.setText(role.Speed_txt, `${Number(item.attackInterval.toFixed(2))}s`); this.ui.setText(role.StarUpgrade_Lv_txt, String(item.starLevel));
    this.ui.tint(role.Damage_txt, item.starLevel > 0 ? [255, 241, 81, 255] : [255, 255, 255, 255]);
  }
  private *refreshMissionsSteps(state: RaidSnapshot): Generator<void> {
    const key = state.missionsRevision ?? state.missions.map(mission => `${mission.index}:${mission.type}:${mission.target}:${mission.progress}:${mission.reward}:${mission.complete}:${mission.claimed}:${mission.claimable}`).join(',');
    if (key === this.missionsKey) return;
    for (const mission of state.missions) {
      const role = this.missions[mission.index]; if (!role) continue;
      this.ui.setText(role.Reward_txt, String(mission.reward));
      this.ui.setText(role.Explain_txt, this.term(mission.type === 'tries' ? 'Raid/Mission_TryCount' : 'Raid/Mission_BestLevel').replace('{0}', String(mission.target)));
      this.ui.setText(role.Value_txt, `${mission.progress}/${mission.target}`);
      this.fill(role.Value_Fill, mission.progress / mission.target);
      this.ui.show(role.Locked_obj, !mission.complete); this.ui.show(role.Claimable_obj, mission.claimable); this.ui.show(role.Done_obj, mission.claimed); yield;
    }
    const sorted = state.missions.slice().sort((a, b) => (a.claimable ? 0 : a.claimed ? 2 : 1) - (b.claimable ? 0 : b.claimed ? 2 : 1) || a.index - b.index);
    const content = this.ui.node('level0:563'), spec = this.assets.config.nodes['level0:563'];
    const padding = spec.layout!.m_Padding, spacing = spec.layout!.m_Spacing; let y = padding.m_Top;
    for (let order = 0; order < sorted.length; order++) {
      const item = sorted[order];
      const role = this.missions[item.index], node = this.ui.node(role.node), tr = node.getComponent(UITransform)!;
      node.setSiblingIndex(order); node.setPosition(node.position.x, -y - tr.height * (1 - tr.anchorY), 0); y += tr.height + spacing; yield;
    }
    content.getComponent(UITransform)!.setContentSize(content.getComponent(UITransform)!.width, y - spacing + padding.m_Bottom);
    this.applyScroll(); this.missionsKey = key;
  }
  private bindMissionScroll(): void {
    const viewport = this.ui.node('level0:634');
    viewport.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      if (!this.missionOpen) return; this.scrollTouch = { id: event.getID() ?? -1, y: event.getUILocation().y, moved: false };
    }, this, true);
    viewport.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
      const touch = this.scrollTouch; if (!touch || touch.id !== (event.getID() ?? -1)) return;
      const y = event.getUILocation().y, delta = (y - touch.y) / this.scale;
      if (Math.abs(delta) > 3) touch.moved = true;
      if (touch.moved) { this.scrollOffset += delta; touch.y = y; this.applyScroll(); event.propagationStopped = true; }
    }, this, true);
    viewport.on(Node.EventType.MOUSE_WHEEL, (event: EventMouse) => { if (this.missionOpen) { this.scrollOffset += event.getScrollY() / this.scale; this.applyScroll(); event.propagationStopped = true; } });
  }
  private applyScroll(): void {
    const content = this.ui.node('level0:563'), viewport = this.ui.node('level0:634');
    const max = Math.max(0, content.getComponent(UITransform)!.height - viewport.getComponent(UITransform)!.height);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset)); content.setPosition(content.position.x, this.scrollOffset, 0);
  }
  private fill(key: string, value: number): void {
    const size = this.fillSizes.get(key); if (!size) return;
    const node = this.ui.node(key), tr = node.getComponent(UITransform)!;
    tr.setAnchorPoint(0, .5); tr.setContentSize(size.width * clamp(value), size.height); node.setPosition(size.x - size.width / 2, size.y);
    const image = node.children.find(child => child.name === 'OriginalImage');
    if (image) { image.active = value > 0; image.getComponent(UITransform)!.setAnchorPoint(.5, .5); image.getComponent(UITransform)!.setContentSize(size.width, size.height); image.setPosition(size.width / 2, 0); }
  }
  private animatePopup(name: string, elapsed: number): void {
    const root = this.roots.get(name)!;
    for (const node of root.children) {
      const spec = Object.values(this.assets.config.nodes).find(value => value.id === this.assets.config.roots[name] ? false : this.ui.get(value.id) === node);
      if (spec?.bounceStart && node.active) this.bounce(node, spec.bounceStart, elapsed);
    }
  }
  private animateResult(elapsed: number): void {
    for (const track of this.assets.config.animation.tracks) {
      const node = this.ui.node(track.node), value = curveValue(track.curves, elapsed);
      if (track.property === 'alpha') {
        const spec = this.assets.config.nodes[track.node], child = node.children.find(n => n.name === 'OriginalImage'), graphic = child?.getComponent(Graphics);
        if (graphic && child) { graphic.fillColor = new Color(...[...(spec.image?.color.slice(0, 3) ?? [0, 0, 0]), Math.round(clamp(value) * 255)] as [number, number, number, number]); const tr = child.getComponent(UITransform)!; graphic.clear(); graphic.rect(-tr.width * tr.anchorX, -tr.height * tr.anchorY, tr.width, tr.height); graphic.fill(); }
      } else { node.active = value >= .5; if (track.bounce) this.bounce(node, track.bounce, elapsed - (track.curves.find(key => key.coefficients[3] >= .5)?.time ?? Infinity)); }
    }
    // Dia receives OnEnable together with the animated Reward parent.
    const reward = this.assets.config.animation.tracks.find(track => track.node === 'level0:98');
    const start = reward?.curves.find(key => key.coefficients[3] >= .5)?.time ?? Infinity;
    const gem = this.ui.node('level0:441'), bounce = this.assets.config.nodes['level0:441'].bounceStart;
    if (bounce && visibleInHierarchy(gem)) this.bounce(gem, bounce, elapsed - start);
  }
  private bounce(node: Node, bounce: Bounce, elapsed: number): void {
    const split = bounce.duration * (bounce.middle ?? .6), t = Math.max(0, elapsed);
    const value = t < split ? bounce.scale * t / split : t < bounce.duration ? bounce.scale + (1 - bounce.scale) * (t - split) / (bounce.duration - split) : 1;
    node.setScale(value, value, 1);
  }
  private animateSizes(dt: number): void {
    for (const tween of this.assets.config.sizeTweens ?? []) {
      const node = this.ui.node(tween.node), visible = visibleInHierarchy(node);
      const previous = this.sizeTweenTimes.get(tween.node);
      if (previous === undefined && !visible) continue;
      // DOTweenAnimation creates on first Awake and keeps playing while hidden.
      const time = previous === undefined ? 0 : previous + dt; this.sizeTweenTimes.set(tween.node, time);
      if (!visible || tween.duration <= 0) continue;
      const elapsed = Math.max(0, time - tween.delay), total = tween.loops < 0 ? elapsed : Math.min(elapsed, tween.duration * Math.max(1, tween.loops));
      const cycle = Math.floor(total / tween.duration), fraction = total / tween.duration - cycle;
      const atEnd = tween.loops >= 0 && total >= tween.duration * Math.max(1, tween.loops);
      let p = atEnd ? (tween.loopType === 1 && tween.loops % 2 === 0 ? 0 : 1) : tween.loopType === 1 && cycle % 2 === 1 ? 1 - fraction : fraction;
      if (tween.easeType === 7) p = 1 - (1 - p) * (1 - p); // DOTween Ease.OutQuad.
      const spec = this.assets.config.nodes[tween.node], base = spec.rect.size, position = node.position.clone();
      this.ui.layout(tween.node, base[0] + (tween.endValue[0] - base[0]) * p, base[1] + (tween.endValue[1] - base[1]) * p);
      node.setPosition(position.x, position.y, position.z);
    }
  }
  private front(node: Node): boolean {
    if (this.entryBlocked && node === this.roots.get('entry')) return false;
    if (this.adToken !== null || this.externalModalOpen) return false;
    const front = ['result', 'mission', 'selection', 'start', 'battle', 'entry'].map(name => this.roots.get(name)!).find(root => root.active);
    for (let current: Node | null = node; current; current = current.parent) if (current === front) return true;
    return false;
  }
  private contains(node: Node, at: { x: number; y: number }): boolean {
    // Unity GraphicRaycaster clips a button against its ancestor RectMask2D.
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!parent.getComponent(Mask)) continue;
      const tr = parent.getComponent(UITransform)!, point = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      if (point.x < -tr.width * tr.anchorX || point.x > tr.width * (1 - tr.anchorX) || point.y < -tr.height * tr.anchorY || point.y > tr.height * (1 - tr.anchorY)) return false;
    }
    return (this.graphics.get(node) ?? []).some(graphic => {
      if (!visibleInHierarchy(graphic)) return false;
      const tr = graphic.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return p.x >= -tr.width * tr.anchorX && p.x <= tr.width * (1 - tr.anchorX) && p.y >= -tr.height * tr.anchorY && p.y <= tr.height * (1 - tr.anchorY);
    });
  }
  private bindButton(spec: RaidNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id), graphics: Node[] = [];
    const collect = (entry: OriginalUiNode): void => { if (!this.ui.get(entry.id) || (entry !== spec && entry.button)) return; if ((entry.image && entry.image.raycast !== false) || (entry.text && entry.text.raycast !== false)) graphics.push(this.ui.node(entry.id)); entry.children.forEach(key => collect(this.assets.config.nodes[key])); };
    collect(spec); this.graphics.set(node, graphics);
    if (spec.buttonColors?.transition === 1) {
      const normal = spec.buttonColors.normal.slice(); this.tints.set(node, { spec, current: normal, from: normal, to: normal, elapsed: 0, duration: 0 }); this.setTint(node, true);
    }
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.touches.get(node) !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node); this.setTint(node);
      const scrolled = this.inMissionViewport(node) && this.scrollTouch?.id === (event.getID() ?? -1) && this.scrollTouch.moved;
      if (!click || scrolled || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node, event.getUILocation()) || !this.interactable(spec)) return;
      for (const action of spec.button!) this.invoke(action.method, action.target);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound); this.update(0);
    };
    for (const graphic of graphics) {
      graphic.on(Node.EventType.TOUCH_START, (event: EventTouch) => { event.propagationStopped = true; if (!this.front(node) || this.touches.has(node) || !this.interactable(spec)) return; this.touches.set(node, event.getID() ?? -1); this.selected = node; this.feedback.press(node, spec); this.setTint(node); });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.setTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.setTint(node); });
    }
  }
  private inMissionViewport(node: Node): boolean { const viewport = this.ui.node('level0:634'); for (let p: Node | null = node; p; p = p.parent) if (p === viewport) return true; return false; }
  private interactable(spec: RaidNode): boolean {
    const phase = this.callbacks.getPhase?.() ?? this.callbacks.getState().phase;
    return spec.buttonColors?.interactable !== false && !['entering', 'exiting', 'adPending'].includes(phase);
  }
  private clearTouches(): void {
    this.touches.clear(); this.feedback.clear(); this.scrollTouch = null; this.hovered.clear(); this.selected = null;
    for (const node of this.tints.keys()) this.setTint(node, true);
  }
  private setTint(node: Node, immediate = false): void {
    const state = this.tints.get(node), colors = state?.spec.buttonColors; if (!state || !colors) return;
    const to = !this.interactable(state.spec) ? colors.disabled : this.touches.has(node) ? colors.pressed : this.selected === node ? colors.selected : this.hovered.has(node) ? colors.highlighted : colors.normal;
    if (!immediate && state.to.every((value, i) => value === to[i])) return;
    if (immediate && !state.duration && state.current.every((value, i) => value === to[i])) return;
    state.from = state.current.slice(); state.to = to.slice(); state.elapsed = 0; state.duration = immediate ? 0 : colors.fadeDuration;
    if (!state.duration) { state.current = state.to.slice(); this.renderTint(state); }
  }
  private renderTint(state: ButtonTint): void {
    const colors = state.spec.buttonColors!, base = state.spec.image?.color ?? [255, 255, 255, 255];
    this.ui.tint(colors.target, base.map((value, i) => Math.round(Math.min(255, value * state.current[i] * colors.colorMultiplier / 255))));
  }
  private updateTints(dt: number): void {
    for (const [node, state] of this.tints) {
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.setTint(node, true); }
      if (!state.duration) continue;
      state.elapsed += dt; const t = Math.min(1, state.elapsed / state.duration);
      state.current = state.from.map((value, i) => value + (state.to[i] - value) * t); this.renderTint(state);
      if (t === 1) state.duration = 0;
    }
  }
  private invoke(method: string, target: string): void {
    const role = this.assets.config.roles[target];
    if (method === 'Content_Btn_Raid') this.open();
    else if (method === 'SetActive') {
      if (target === this.assets.config.roots.start) this.close();
      else if (target === this.assets.config.roots.selection) this.selectionSlot = null;
      else if (target === this.assets.config.roots.mission) this.missionOpen = false;
    } else if (method === 'SelectPanel_Open' && role) { this.selectionSlot = role.SlotNum; this.popupElapsed = 0; }
    else if (method === 'Gun_UnSelect' && role) this.check(this.callbacks.unselectWeapon(role.SlotNum));
    else if (method === 'onClick_StarUpgrade' && role) this.callbacks.openStarUpgrade(role.SlotNum);
    else if (method === 'OnClick' && role) {
      const index = this.candidates.findIndex(item => item === role), item = this.callbacks.getState().candidates[index];
      if (item?.canSelect && this.selectionSlot !== null && this.check(this.callbacks.selectWeapon(this.selectionSlot, item.sourceIndex))) this.selectionSlot = null;
    } else if (method === 'onClick_Open') { this.missionOpen = true; this.selectionSlot = null; this.popupElapsed = 0; this.scrollOffset = 0; }
    else if (method === 'onClick_Reward' && role) this.check(this.callbacks.claimMission(this.missions.indexOf(role)));
    else if (method === 'Game_Enter_Normal') this.check(this.callbacks.start());
    else if (method === 'Game_Enter_AD') this.showAd();
    else if (method === 'Game_Exit') this.check(this.callbacks.exit());
  }
  private showAd(): void {
    const state = this.callbacks.getState(); if (!state.adEnabled || !state.adAvailable) return;
    const result = this.callbacks.beginAd?.(); if (!result || !this.check(result) || !result.token) return;
    const token = result.token; this.adToken = token;
    const complete = (outcome: RewardedAdOutcome): void => { if (this.destroyed || this.adToken !== token) return; this.adToken = null; const result = this.callbacks.completeAd?.(token, outcome); if (result) this.check(result); this.update(0); };
    if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, 'raid-entry', complete); else complete('failure');
  }
  private term(key: string): string { return this.assets.config.translations[key] ?? key; }
  private check(result: ActionResult): boolean {
    if (!result.ok) {
      const reason = result.reason || '';
      if (/gun|weapon|loadout|empty/i.test(reason)) this.callbacks.alert?.(this.term('Raid/SelectGun'));
      else if (/entry|ticket|limit|exhaust/i.test(reason)) this.callbacks.alert?.(this.term('Raid/Raid_Ticket_Zero'));
      else if (/ad.*fail|failure/i.test(reason)) this.callbacks.alert?.('广告加载失败。');
    }
    return result.ok;
  }
  private notify(): void { const value = this.isOpen; if (value !== this.lastVisible) { this.lastVisible = value; this.callbacks.onVisibilityChanged?.(value); } }
}

export function raidRemainingTime(seconds: number): string {
  const value = Math.max(0, Math.trunc(seconds)), d = Math.floor(value / 86400), h = Math.floor(value % 86400 / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}
function clamp(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function curveValue(keys: Curve[], time: number): number { let key = keys[0]; for (const next of keys) { if (next.time > time) break; key = next; } if (!key) return 0; const t = Math.max(0, time - key.time), c = key.coefficients; return ((c[0] * t + c[1]) * t + c[2]) * t + c[3]; }
