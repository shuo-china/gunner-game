import { initialUiLayout, OriginalGradeBadgePool, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, EventTouch, Font, Node, UITransform, Vec3 } from 'cc';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';
import { PET_CATALOG, PET_DRAW_PRICE, PetActionResult, PetCurrency, PetSlotRef, PetSnapshot } from '../session/PetSystem';
import type { ContentState } from '../session/ContentUnlockManager';
import type { RewardedAdOutcome, RewardedAdPresenter } from '../session/RewardedAds';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi, OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { SkinHudColorPipeline, SkinHudPresentation } from './SkinHudColorPipeline';
import { loadResourceBatch } from './ResourceBatch';

type Role = Record<string, any>;
interface PetUiConfig extends WeaponUiConfig { portraits: string[]; }
export interface PetHudAssets extends WeaponHudAssets { config: PetUiConfig; }
export interface PetHudCallbacks {
  getState(): PetSnapshot; getContentState(): ContentState; getDailyAdState(): ContentState;
  draw(currency: PetCurrency): PetActionResult;
  move(from: PetSlotRef, to: PetSlotRef, expected: number, swapVacancy?: number): PetActionResult;
  unequip(index: number): PetActionResult;
  merge(from: number, to: number, grade: number, automatic: boolean): PetActionResult;
  setAuto(enabled: boolean): PetActionResult; prepare(grades: number[]): Promise<void>;
  beginAd?(): PetActionResult; completeAd?(token: string, outcome: RewardedAdOutcome): PetActionResult; cancelAd?(): void;
  onBeforeOpen?(): void; onVisibilityChanged?(value: boolean): void;
  alert?(message: string): void; playSfx?(id: number): void;
}
export async function loadPetHudAssets(art: ArtLibrary): Promise<PetHudAssets> {
  const config = await art.json<PetUiConfig>('art/pet-system/config');
  if (config.version !== 1 || config.portraits.length !== 13 || !config.bitmapFonts) throw new Error('Invalid original pet UI');
  const paths = Object.values(config.images).map(image => image.path);
  for (const font of Object.values(config.bitmapFonts)) paths.push(...font.pages);
  await loadResourceBatch(Array.from(new Set(paths)).map(path => () => art.loadFrame(path)));
  const font = new Font(); return { config, chineseFont: font, originalFont: font, numberFont: font };
}

/** Authored Pet_UI, PetInfo_UI, Draw_Info_UI and NewPet_UI. Commands are the only
 * mutation path. A pending resource load never reserves, removes or pays for a pet. */
export class PetHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui: OriginalWeaponUi;
  private readonly gradeBadges: OriginalGradeBadgePool;
  private readonly colors?: SkinHudColorPipeline;
  private readonly roots = new Map<string, Node>();
  private readonly manager: Role;
  private readonly list: Role;
  private readonly owned: Role[];
  private readonly selected: Role[];
  private readonly feedback = new OriginalWeaponFeedback(undefined);
  private readonly pointers = new Map<Node, number>();
  private drag: { ref: PetSlotRef; grade: number; pointer: number; start: Vec3; origin: Vec3; node: Node; moved: boolean; sibling: number; target: PetSlotRef | null } | null = null;
  private auto: { from: number; to: number; grade: number; elapsed: number; revision: number; sibling: number } | null = null;
  private autoDelay = 0;
  private noticeTime: number | null = null;
  private detailId: number | null = null;
  private readonly bounces = new Map<Node, number>();
  private readonly cardPresses = new Map<Node, {elapsed:number;pressed:boolean}>();
  private readonly highlights = new Set<Node>();
  private readonly highlightMotion = new Map<Node,{from:number;to:number;elapsed:number}>();
  private revision = '';
  private walletRevision = '';
  private accessRevision = '';
  private token = 0;
  private preparing = false;
  private entryVisible = true;
  private entryBlocked = false;
  private entryOffset = 730;
  private destroyed = false;
  private adToken: string | null = null;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: PetHudAssets, private readonly callbacks: PetHudCallbacks, presentation?: SkinHudPresentation,
    private readonly rewardedAds?: RewardedAdPresenter, prepare?: UiPreparation) {
    this.node = makeNode('OriginalPetHud', parent);
    if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
    this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
    const roles = assets.config.roles;
    this.gradeBadges = new OriginalGradeBadgePool(Object.values(roles));
    this.manager = roles['level0:123446']; this.list = roles[this.manager.gunItemList];
    this.owned = this.list.Pet_Item_Pool.map((key: string) => roles[key]);
    this.selected = this.manager.Pet_Slot_List.map((key: string) => roles[key]);
    const initialize = function* (this: PetHud): Generator<void> {
      for (const [name, id] of Object.entries(assets.config.roots)) {
        const root = (yield* this.ui.createSteps(id, name === 'entry' ? this.node : this.colors?.content ?? this.node, undefined, this.gradeBadges.include));
        root.active = name === 'entry'; this.roots.set(name, root);
        if (name !== 'entry') {
          root.addComponent(BlockInputEvents);
          root.children.filter(child => child.name === 'Panel').forEach(panel => panel.addComponent(BlockInputEvents));
        }
      }
      for (const spec of Object.values(assets.config.nodes)) if (spec.button) { this.bindButton(spec); yield; }
      this.owned.forEach((role, index) => this.bindCard(role, { kind: 'owned', index }));
      this.selected.forEach((role, index) => this.bindCard(role, { kind: 'selected', index }));
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare), false));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps()); if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }
  get isOpen(): boolean { return !this.destroyed && this.roots.get('main')!.active; }
  setEntryVisible(value: boolean): void { if (this.entryVisible === value) return; this.entryVisible = value; this.syncAccess(); }
  setEntryOffset(y: number): void {
    if (this.destroyed) return;
    this.entryOffset = y;
    const { width, height } = this.node.getComponent(UITransform)!;
    this.roots.get('entry')!.setPosition(-width / 2, -height / 2 + y);
  }
  setEntryBlocked(value: boolean): void {
    this.entryBlocked = value;
    if (value && !this.destroyed) {
      const entry = this.roots.get('entry')!;
      this.pointers.delete(entry); this.feedback.cancelButton(entry);
    }
  }
  open(): void {
    if (this.destroyed || this.isOpen || !this.entryVisible) return;
    const access = this.callbacks.getContentState();
    if (!access.unlocked) { if (access.message) this.callbacks.alert?.(access.message); return; }
    this.callbacks.onBeforeOpen?.(); this.cancelInteractions();
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
    if (!this.isOpen || !Number.isInteger(grade) || grade < 0 || grade >= 10) return;
    this.cancelInteractions(); this.detailId = grade; this.roots.get('detail')!.active = true; this.revision = ''; this.refresh();
  }
  cancelInteractions(): void {
    if (this.adToken) { const token = this.adToken; this.adToken = null; this.rewardedAds?.cancelRewardedAd(token); this.callbacks.cancelAd?.(); }
    this.token++; this.preparing = false; this.stopAuto();
    this.feedback.clear(); this.pointers.clear();
    if (this.drag) { this.drag.node.setWorldPosition(this.drag.origin); this.drag.node.setSiblingIndex(this.drag.sibling); this.drag = null; }
    for (const node of this.bounces.keys()) node.setScale(1, 1, 1);
    for (const node of this.cardPresses.keys()) node.setScale(1,1,1); this.cardPresses.clear();
    this.bounces.clear(); this.align(); this.clearTargets(); this.colors?.invalidate();
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
    const scale = width / 1080, h = (height - top - bottom) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottom - top) / 2);
    this.node.getComponent(UITransform)!.setContentSize(1080, h);
    for (const [name, id] of Object.entries(this.assets.config.roots)) yield* this.ui.layoutSteps(id, name === 'entry' ? 130 : 1080, name === 'entry' ? 120 : h, top / scale, bottom / scale);
    this.setEntryOffset(this.entryOffset);
    this.colors?.resize(width, height); this.align(); this.revision = ''; if (refresh) yield* this.refreshSteps();
  }
  update(dt: number): void {
    if (this.destroyed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const feedbackMoving = this.feedback.hasActiveMotion;
    this.feedback.update(dt); this.syncAccess();
    if (!this.isOpen) return;
    this.refresh();
    const moving = this.highlightMotion.size > 0 || this.cardPresses.size > 0 || this.bounces.size > 0 || this.noticeTime !== null || this.auto !== null;
    for (const [node,motion] of this.highlightMotion) {
      motion.elapsed+=dt; const t=Math.min(1,motion.elapsed/Math.fround(.15)),s=t*t*(3-2*t),scale=motion.from+(motion.to-motion.from)*s;
      node.setScale(scale,scale,scale); if(t===1)this.highlightMotion.delete(node);
    }
    for (const [node,motion] of this.cardPresses) {
      motion.elapsed+=dt; const t=Math.min(1,motion.elapsed/.08),s=t*t*(3-2*t),scale=motion.pressed?1-.1*s:.9+.1*s;
      node.setScale(scale,scale,1); if (!motion.pressed&&t===1) this.cardPresses.delete(node);
    }
    for (const [node, elapsed] of this.bounces) {
      const t = elapsed + dt; let remaining=t,from=0,scale=1;
      for (const [to,duration] of [[1.1,.15],[.95,.08],[1.02,.06],[1,.05]]) {
        const v=Math.min(1,remaining/duration),s=v*v*(3-2*v);scale=from+(to-from)*s;
        if (remaining<duration) break; remaining-=duration;from=to;
      }
      node.setScale(scale, scale, 1); if (t >= .34) this.bounces.delete(node); else this.bounces.set(node, t);
    }
    if (this.noticeTime !== null) {
      this.noticeTime += dt; const clip = this.assets.config.newGunAnimation!;
      for (const track of clip.tracks) {
        const values = track.curves.map(curve => {
          let key = curve[0]; for (const frame of curve) { if (frame.time > this.noticeTime!) break; key = frame; }
          const t = this.noticeTime! - key.time, [a,b,c,d] = key.coefficients; return ((a*t+b)*t+c)*t+d;
        }); this.ui.node(track.node).setScale(values[0], values[1], values[2]);
      }
      this.ui.node('level0:515').angle = this.noticeTime * clip.glowRotationSpeed;
      if (this.noticeTime >= clip.duration) { this.noticeTime = null; this.roots.get('newPet')!.active = false; }
    }
    if (!this.adToken && !this.drag && !this.preparing && this.noticeTime === null && this.frontName() === 'main') this.updateAuto(dt);
    if (feedbackMoving || moving || this.auto !== null) this.colors?.invalidate();
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
    const access = this.callbacks.getContentState();
    this.roots.get('entry')!.active = this.entryVisible && access.visible;
    const key = `${access.visible}:${access.unlocked}`;
    if (key !== this.accessRevision) {
      this.accessRevision = key;
      for (const spec of Object.values(this.assets.config.nodes)) if (spec.name === 'Locked_obj') this.ui.show(spec.id, !access.unlocked);
    }
    if (!access.unlocked && this.isOpen) this.close();
  }
  private paint(role: Role, grade: number, locked = false): void {
    if (role.type === 'Pet_Item') this.ui.show(role.node, grade >= 0);
    this.ui.show(role.Selected_obj, grade >= 0); this.ui.show(role.UnSelected_obj, grade < 0);
    this.ui.show(role.Lock_obj, locked);
    if (!this.gradeBadges.update(this.ui, role.Degree_objs, grade))
      role.Degree_objs?.forEach((key: string, id: number) => this.ui.show(key, id === grade));
    if (grade < 0) return;
    const pet = PET_CATALOG[grade], portrait = this.assets.config.portraits[grade];
    this.ui.image(role.Pet_img, portrait); this.ui.image(role.Shadow_img, portrait);
    this.ui.tint(role.Panel_img, this.assets.config.degreeColors[grade]);
    this.ui.setText(role.Money_txt, `+${pet.money.amount.format()}%`); this.ui.setText(role.MoveSpeed_txt, `+${pet.moveSpeed}%`);
  }
  private refresh(): void {
    for (const _ of this.refreshSteps()) { /* synchronous state refresh */ }
  }

  private *refreshSteps(): Generator<void> {
    const state = this.callbacks.getState(), daily = this.callbacks.getDailyAdState();
    const wallet = `${state.diamonds}:${state.coins}:${state.gold}`;
    if (wallet !== this.walletRevision) {
      this.walletRevision = wallet;
      this.ui.setText('level0:9866',String(state.diamonds)); this.ui.setText('level0:9849',String(state.coins)); this.ui.setText('level0:9850',state.gold);
      this.colors?.invalidate();
    }
    const key = `${state.revision}:${state.autoAvailable}:${this.detailId}:${daily.unlocked}:${state.dailyAdRemaining}`;
    if (key === this.revision) return;
    this.revision = key;
    this.ui.setText('level0:411', `<sprite=0>${PET_DRAW_PRICE}`);
    this.ui.setText('level0:175', `<sprite=1>${PET_DRAW_PRICE}`);
    // The authored panel has four rows. Its last row also represents a configured higher grade.
    const drawGrade = ECONOMY_CONFIG.pets.drawGrade;
    ['level0:9891', 'level0:9863', 'level0:9865', 'level0:9862'].forEach((id, index) =>
      this.ui.setText(id, index === Math.min(3, drawGrade) ? '100%' : '0%'));
    this.ui.setText('level0:185', PET_CATALOG[Math.max(3, drawGrade)].grade);
    for (const [i, role] of this.owned.entries()) {
      this.paint(role,state.owned[i],state.ownedLocked[i]); this.ui.show(role.AutoMerge_obj, !!this.auto && (this.auto.from===i||this.auto.to===i));
      yield;
    }
    for (const [i, role] of this.selected.entries()) {
      this.paint(role,state.selected[i],state.selectedLocked[i]);
      yield;
    }
    const autoActive = state.autoEnabled && state.autoAvailable;
    this.ui.show('level0:11041',autoActive); this.ui.show('level0:30494',!autoActive);
    this.ui.show(this.manager.Auto_Btn_obj,state.autoAvailable);
    this.ui.show(this.manager.Auto_Explain_obj,autoActive); this.ui.show(this.manager.NonAuto_Explain_obj,!autoActive);
    this.ui.show(this.manager.AD_Draw_Btn_obj,daily.unlocked && state.dailyAdRemaining > 0);
    this.ui.image('level0:1295', this.assets.config.portraits[ECONOMY_CONFIG.pets.dailyAd.grade]);
    this.ui.setText('level0:1583', PET_CATALOG[ECONOMY_CONFIG.pets.dailyAd.grade].grade);
    if (this.detailId !== null) {
      const detail = this.assets.config.roles[this.manager.pet_info_ui]; this.paint(detail,this.detailId);
      this.ui.show(detail.LeftBtn_obj,this.detailId > 0); this.ui.show(detail.RightBtn_obj,this.detailId < 9);
    }
    this.colors?.invalidate();
  }
  private align(): void {
    this.owned.forEach((role,index) => { const node = this.ui.get(role.node), slot = this.ui.get(this.list.SlotTransforms[index]); if (node && slot && node !== this.drag?.node) node.setWorldPosition(slot.worldPosition); });
  }
  private check(result: PetActionResult, bounce?: number): boolean {
    if (!result.ok) {
      const messages: Record<string,string> = {locked:'宠物正在旅行中。',full:'宠物背包已满。',currency:'货币不足。',maxGrade:'已达到最高阶。',saveFailed:'保存失败，本次操作未生效。',busy:'请稍后再试。',stale:'宠物位置已变化，请重试。',dailyLimit:'今日奖励已领取。',staleAd:'领取状态已变化，请重试。'};
      this.callbacks.alert?.(messages[result.reason ?? ''] ?? '当前无法进行此操作。'); return false;
    }
    this.refresh(); this.align();
    if (bounce !== undefined) this.bounces.set(this.ui.node(this.owned[bounce].node),0);
    if (result.discovered !== undefined) {
      this.paint(this.assets.config.roles[this.manager.newPet_ui],result.discovered);
      this.roots.get('newPet')!.active = true; this.noticeTime = 0;
    }
    return true;
  }
  private frontName(): string { return ['newPet','drawInfo','detail','main','entry'].find(name => this.roots.get(name)!.active)!; }
  private front(node: Node): boolean {
    if (this.destroyed || this.preparing || this.adToken) return false;
    const root = this.roots.get(this.frontName());
    if (root === this.roots.get('entry') && this.entryBlocked) return false;
    for (let current: Node | null = node; current; current = current.parent) if (current === root) return true;
    return false;
  }
  private contains(node: Node, point: {x: number; y: number}): boolean {
    const tr = node.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(point.x,point.y));
    return p.x >= -tr.width*tr.anchorX && p.x <= tr.width*(1-tr.anchorX) && p.y >= -tr.height*tr.anchorY && p.y <= tr.height*(1-tr.anchorY);
  }
  private bindButton(spec: OriginalUiNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id);
    node.on(Node.EventType.TOUCH_START,(event: EventTouch) => {
      event.propagationStopped = true;
      if (!this.front(node) || this.pointers.has(node)) return;
      this.pointers.set(node,event.getID() ?? -1); this.feedback.press(node,spec);
    });
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.pointers.get(node) !== (event.getID() ?? -1)) return;
      this.pointers.delete(node); this.feedback.release(node);
      if (!click || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node,event.getUILocation())) return;
      for (const action of spec.button!) this.invoke(action.method,action.target,!!action.arguments.m_BoolArgument);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound); this.refresh();
    };
    node.on(Node.EventType.TOUCH_END,(e: EventTouch) => finish(e,true)); node.on(Node.EventType.TOUCH_CANCEL,(e: EventTouch) => finish(e,false));
  }
  private invoke(method: string, target: string, value: boolean): void {
    if (method === 'Content_Btn_Pet') this.open();
    else if (method === 'SetActive') {
      const name = Object.keys(this.assets.config.roots).find(name => this.assets.config.roots[name] === target);
      if (!name) return;
      if (name === 'main') this.close();
      else { this.cancelInteractions(); this.roots.get(name)!.active = value; if (name === 'newPet') this.noticeTime = null; if (name === 'detail' && !value) this.detailId = null; }
    } else if (method === 'AD_Draw_Btn_Click') this.drawDailyAd();
    else if (method === 'DrawPet_Normal' || method === 'DrawPet_Dia') {
      this.stopAuto(); const index = this.callbacks.getState().owned.indexOf(-1);
      this.callbacks.playSfx?.(this.check(this.callbacks.draw(method === 'DrawPet_Dia' ? 'diamonds' : 'petCoins'),index >= 0 ? index : undefined)?2:5);
    } else if (method === 'AutoMerge_Change') { this.stopAuto(); this.check(this.callbacks.setAuto(!this.callbacks.getState().autoEnabled)); }
    else if (method === 'Unequip') { this.stopAuto(); if (this.check(this.callbacks.unequip(this.selected.indexOf(this.assets.config.roles[target])))) this.callbacks.playSfx?.(13); }
    else if (method === 'Show_LowerPet' && this.detailId !== null) this.openDetail(this.detailId-1);
    else if (method === 'Show_HigherPet' && this.detailId !== null) this.openDetail(this.detailId+1);
  }
  private drawDailyAd(): void {
    if (!this.callbacks.getDailyAdState().unlocked || !this.callbacks.beginAd || !this.callbacks.completeAd || this.adToken) return;
    this.stopAuto();
    const index = this.callbacks.getState().owned.indexOf(-1), result = this.callbacks.beginAd();
    if (!result.ok || !result.token) { this.check(result); return; }
    const token = result.token; this.adToken = token;
    const complete = (outcome: RewardedAdOutcome): void => {
      if (this.destroyed || this.adToken !== token) return;
      this.adToken = null;
      const result = this.callbacks.completeAd!(token, outcome);
      if (outcome === 'cancel') { this.refresh(); return; }
      if (outcome === 'failure') { this.callbacks.alert?.('广告加载失败，请重试。'); this.refresh(); return; }
      if (this.check(result, index >= 0 ? index : undefined)) this.callbacks.playSfx?.(2);
    };
    if (this.rewardedAds) this.rewardedAds.showRewardedAd(token, 'pet-daily', complete); else complete('failure');
  }
  private bindCard(role: Role, ref: PetSlotRef): void {
    const node = this.ui.node(role.node);
    node.on(Node.EventType.TOUCH_START,(event: EventTouch) => {
      event.propagationStopped = true;
      const state = this.callbacks.getState(), grade = state[ref.kind][ref.index];
      if ((ref.kind === 'owned' ? state.ownedLocked : state.selectedLocked)[ref.index] || grade < 0 || this.drag || !this.front(node)) return;
      this.stopAuto(); const p = event.getUILocation();
      this.drag = {ref,grade,pointer:event.getID() ?? -1,start:new Vec3(p.x,p.y),origin:node.worldPosition.clone(),node,moved:false,sibling:node.getSiblingIndex(),target:null};
      this.bounces.delete(node); this.cardPresses.set(node,{elapsed:0,pressed:true});
    });
    node.on(Node.EventType.TOUCH_MOVE,(event: EventTouch) => {
      const drag = this.drag; if (!drag || drag.pointer !== (event.getID() ?? -1)) return;
      event.propagationStopped = true; const p = event.getUILocation(), dx = p.x-drag.start.x, dy = p.y-drag.start.y;
      if (!drag.moved && Math.hypot(dx,dy) < 5) return;
      this.cardPresses.delete(node); if(!drag.moved)node.setScale(1,1,1);
      drag.moved = true; node.setSiblingIndex(node.parent!.children.length-1);
      node.setWorldPosition(drag.origin.x+dx,drag.origin.y+dy,drag.origin.z);
      this.owned.forEach(role=>this.ui.show(role.FusionAble_obj,false)); this.align(); drag.target = this.dropTarget(p,ref);
      const highlights:Node[]=[];
      if (drag.target?.kind === 'selected') highlights.push(this.ui.node(this.selected[drag.target.index].node));
      if (drag.target?.kind === 'owned' && ref.kind === 'owned') {
        const id = drag.target.index, grade = this.callbacks.getState().owned[id];
        if (grade === drag.grade && grade < 9) for (const i of [ref.index,id]) {
          this.ui.show(this.owned[i].FusionAble_obj,true); highlights.push(this.ui.node(this.owned[i].node));
        }
        else if (grade >= 0) this.ui.node(this.owned[id].node).setWorldPosition(this.ui.node(this.list.SlotTransforms[this.nearestVacancy(this.ui.node(this.list.SlotTransforms[id]).worldPosition,ref.index)]).worldPosition);
      }
      this.setHighlights(highlights);
      // Position changes must reach the cached UI even after highlight motion settles.
      this.colors?.invalidate();
    });
    const finish = (event: EventTouch, cancelled: boolean): void => {
      const drag = this.drag; if (!drag || drag.pointer !== (event.getID() ?? -1)) return;
      event.propagationStopped = true; this.drag = null;
      if (!drag.moved) this.cardPresses.set(node,{elapsed:0,pressed:false});
      node.setWorldPosition(drag.origin); node.setSiblingIndex(drag.sibling); this.clearTargets(); this.align();
      this.colors?.invalidate();
      if (cancelled || !this.isOpen) return;
      if (!drag.moved) { this.callbacks.playSfx?.(1); this.openDetail(drag.grade); return; }
      const target = drag.target;
      if (ref.kind === 'selected' && target?.kind !== 'selected') {
        if (this.contains(this.ui.node(this.list.node),event.getUILocation()) && this.check(this.callbacks.unequip(ref.index))) this.callbacks.playSfx?.(13);
        return;
      }
      if (!target) return;
      if (target.kind===ref.kind && target.index===ref.index) return;
      const state = this.callbacks.getState();
      if (ref.kind === 'owned' && target.kind === 'owned' && state.owned[target.index] === drag.grade && drag.grade < 9) {
        if (this.check(this.callbacks.merge(ref.index,target.index,drag.grade,false),target.index)) this.callbacks.playSfx?.(3);
      } else void this.movePrepared(ref,target,drag.grade,state);
    };
    node.on(Node.EventType.TOUCH_END,(e: EventTouch) => finish(e,false)); node.on(Node.EventType.TOUCH_CANCEL,(e: EventTouch) => finish(e,true));
  }
  private dropTarget(p: {x:number;y:number}, from: PetSlotRef): PetSlotRef | null {
    for (let index=0;index<3;index++) if (!this.callbacks.getState().selectedLocked[index] && !(from.kind==='selected' && from.index===index) && this.contains(this.ui.node(this.selected[index].node),p)) return {kind:'selected',index};
    if (from.kind === 'selected') return null;
    const node = this.ui.node(this.owned[from.index].node), position=node.worldPosition, tr=node.getComponent(UITransform)!;
    const scale=this.node.worldScale.x, shrink=this.owned[from.index].OverlapShrink;
    let best=-1, distance=Infinity;
    const state=this.callbacks.getState();
    for (let index=0;index<16;index++) if (index!==from.index && !state.ownedLocked[index] && state.owned[index]>=0) {
      const at=this.ui.node(this.list.SlotTransforms[index]).worldPosition, dx=Math.abs(at.x-position.x)/scale, dy=Math.abs(at.y-position.y)/scale;
      if (dx<tr.width-2*shrink && dy<tr.height-2*shrink && Math.hypot(dx,dy)<distance) {best=index;distance=Math.hypot(dx,dy);}
    }
    return {kind:'owned',index:best>=0?best:this.nearestVacancy(position,from.index)};
  }
  private nearestVacancy(position: {x:number;y:number}, origin: number): number {
    let best=origin,distance=Infinity; const state=this.callbacks.getState();
    this.list.SlotTransforms.forEach((id:string,index:number)=>{
      if (state.owned[index]>=0 && index!==origin) return;
      const at=this.ui.node(id).worldPosition, d=Math.hypot(at.x-position.x,at.y-position.y);
      if (d<distance) {best=index;distance=d;}
    }); return best;
  }
  private async movePrepared(from: PetSlotRef, to: PetSlotRef, grade: number, state: PetSnapshot): Promise<void> {
    const token = ++this.token; this.preparing = true;
    try {
      const selected = state.selected.slice();
      if (to.kind === 'selected') selected[to.index] = grade;
      if (from.kind === 'selected') selected[from.index] = state[to.kind][to.index];
      await this.callbacks.prepare(selected.filter(id => id >= 0));
      if (this.destroyed || token !== this.token || !this.isOpen || this.callbacks.getState().revision !== state.revision) return;
      const vacancy=from.kind==='owned'&&to.kind==='owned'&&state.owned[to.index]>=0?this.nearestVacancy(this.ui.node(this.list.SlotTransforms[to.index]).worldPosition,from.index):undefined;
      if (this.check(this.callbacks.move(from,to,grade,vacancy))) this.callbacks.playSfx?.(from.kind==='selected'&&to.kind==='owned'?13:9);
    } catch (_error) { if (!this.destroyed && token === this.token) this.callbacks.alert?.('宠物资源加载失败，请重试。'); }
    finally { if (token === this.token) this.preparing = false; }
  }
  private clearTargets(): void {
    this.highlightMotion.clear();this.highlights.clear();
    this.owned.forEach(role => this.ui.show(role.FusionAble_obj,false));
    for (const role of [...this.owned,...this.selected]) {const node=this.ui.node(role.node);if (!this.cardPresses.has(node)&&!this.bounces.has(node)) node.setScale(1,1,1);}
  }
  private setHighlights(nodes:Node[]):void {
    for(const node of new Set(Array.from(this.highlights).concat(nodes))) {
      const active=nodes.includes(node);if(active===this.highlights.has(node))continue;
      this.bounces.delete(node);this.cardPresses.delete(node);
      this.highlightMotion.set(node,{from:node.scale.x,to:active?Math.fround(1.05):1,elapsed:0});
      if(active)this.highlights.add(node);else this.highlights.delete(node);
    }
  }
  private stopAuto(): void {
    if (this.auto) this.ui.node(this.owned[this.auto.from].node).setSiblingIndex(this.auto.sibling);
    this.auto = null; this.autoDelay = this.list.AutoMerge_PairDelay; this.align();
    this.owned.forEach(role=>this.ui.show(role.AutoMerge_obj,false));
  }
  private updateAuto(dt: number): void {
    const state = this.callbacks.getState();
    if (!state.autoEnabled || !state.autoAvailable) { this.stopAuto(); return; }
    if (this.auto && this.auto.revision !== state.revision) this.stopAuto();
    if (!this.auto) {
      this.autoDelay -= dt; if (this.autoDelay > 0 || !state.autoPair) return;
      const node=this.ui.node(this.owned[state.autoPair.from].node);
      this.auto = {...state.autoPair,elapsed:0,revision:state.revision,sibling:node.getSiblingIndex()};
      node.setSiblingIndex(node.parent!.children.length-1);
      for (const i of [this.auto.from,this.auto.to]) {this.ui.show(this.owned[i].AutoMerge_obj,true);this.bounces.delete(this.ui.node(this.owned[i].node));this.ui.node(this.owned[i].node).setScale(1,1,1);}
    }
    const pair = this.auto; pair.elapsed += dt;
    const from = this.ui.node(this.list.SlotTransforms[pair.from]).worldPosition, to = this.ui.node(this.list.SlotTransforms[pair.to]).worldPosition;
    const t = Math.min(1,pair.elapsed/this.list.AutoMerge_MoveDuration), smooth = t*t*(3-2*t);
    const node = this.ui.node(this.owned[pair.from].node);
    node.setWorldPosition(from.x+(to.x-from.x)*smooth,from.y+(to.y-from.y)*smooth,from.z);
    if (Math.hypot(node.worldPosition.x-to.x,node.worldPosition.y-to.y) / this.node.worldScale.x > this.list.AutoMerge_MergeDistance) return;
    this.stopAuto(); this.clearTargets();
    if (this.check(this.callbacks.merge(pair.from,pair.to,pair.grade,true),pair.to)) this.callbacks.playSfx?.(3);
    this.align();
  }
}
