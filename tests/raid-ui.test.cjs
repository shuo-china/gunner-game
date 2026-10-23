const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require('../assets/resources/art/raid-system/config.json');

// Run the real source renderer, particle simulation and HUD against minimal Cocos primitives.
function harness(overrides = {}) {
  const atlases = [], borrowedFrames = [], bitmapFrames = [];
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    clone() { return new Vec3(this.x, this.y, this.z); }
  }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
    convertToNodeSpaceAR(at) { const p = this.node.worldPosition, s = this.node.worldScale; return new Vec3((at.x - p.x) / s.x, (at.y - p.y) / s.y); }
    getBoundingBoxToWorld() {
      const p = this.node.worldPosition, s = this.node.worldScale;
      const x = p.x - this.width * this.anchorX * s.x, y = p.y - this.height * this.anchorY * s.y;
      return { contains: at => at.x >= x && at.y >= y && at.x <= x + this.width * s.x && at.y <= y + this.height * s.y };
    }
  }
  class Node {
    static EventType = { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel', TOUCH_MOVE: 'move', MOUSE_ENTER: 'enter', MOUSE_LEAVE: 'leave' };
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), events: new Map(), active: true, position: new Vec3(), scale: new Vec3(1, 1, 1) }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = new Vec3(x, y, z); }
    setScale(x, y, z = 1) { this.scale = new Vec3(x, y, z); }
    on(event, callback) { this.events.set(event, callback); }
    destroy() { this.destroyed = true; }
    setSiblingIndex(index) { const siblings = this.parent?.children; if (!siblings) return; siblings.splice(siblings.indexOf(this), 1); siblings.splice(index, 0, this); }
    get worldScale() { const p = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(this.scale.x * p.x, this.scale.y * p.y, this.scale.z * p.z); }
    get worldPosition() { const p = this.parent?.worldPosition || new Vec3(), s = this.parent?.worldScale || new Vec3(1, 1, 1); return new Vec3(p.x + this.position.x * s.x, p.y + this.position.y * s.y, p.z + this.position.z * s.z); }
  }
  class Color { static WHITE = new Color(255, 255, 255, 255); constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
  class Graphics { clear() {} rect() {} roundRect() {} fill() {} moveTo() {} lineTo() {} close() {} stroke() {} }
  class Label { static HorizontalAlign = { LEFT: 0, RIGHT: 1, CENTER: 2 }; static VerticalAlign = { TOP: 0, BOTTOM: 1, CENTER: 2 }; static Overflow = { SHRINK: 0, CLAMP: 1 }; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; static Type = { SLICED: 0, TILED: 1, SIMPLE: 2 }; }
  class SpriteAtlas {
    spriteFrames = {}; destroyCalls = 0;
    constructor() { atlases.push(this); }
    destroy() { this.destroyCalls++; }
  }
  class SpriteFrame {
    destroyCalls = 0;
    constructor() { bitmapFrames.push(this); }
    reset(value) { Object.assign(this, value); }
    destroy() { this.destroyCalls++; }
  }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Mask { static Type = { GRAPHICS_RECT: 0 }; }
  class Font {}
  class RichText {}
  class LabelOutline {}
  class LabelShadow {}
  const cc = { Node, Vec3, Vec2: Vec3, UITransform, Color, Graphics, Label, Sprite, SpriteAtlas, SpriteFrame, Rect, Size, Mask, Font, RichText,
    LabelOutline, LabelShadow, BlockInputEvents: class {}, resources: {} };
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const paths = [...Object.values(config.images).map(image => image.path), ...Object.values(config.bitmapFonts).flatMap(font => font.pages)];
  const art = { frames: new Map(paths.map(path => {
    const frame = { texture: { path }, destroyCalls: 0, destroy() { this.destroyCalls++; } }; borrowedFrames.push(frame); return [path, frame];
  })), image: (name, spec, parent) => makeNode(name, parent) };
  const modules = { cc, './ArtLibrary': { makeNode }, '../core/WeaponCatalog': require('./.build/session/core/WeaponCatalog.js') };
  for (const file of ['ResourceLoadingPolicy', 'ResourceBatch', 'OriginalBitmapText', 'OriginalWeaponUi', 'OriginalWeaponFeedback', 'OriginalWeaponConfettiNoise', 'OriginalWeaponConfettiMath', 'OriginalWeaponConfetti', 'RewardedAdModal', 'RaidHud']) {
    const module = { exports: {} }, source = fs.readFileSync(path.join(root, `assets/scripts/view/${file}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText,
      { module, exports: module.exports, require: key => { assert.ok(key in modules, `Unexpected import ${key}`); return modules[key]; } });
    modules[`./${file}`] = module.exports;
  }
  const amount = value => ({ format: () => String(value) });
  const weapon = (sourceIndex, raidSlot = null) => ({ sourceIndex, weaponId: 0, name: 'gun', type: 'SINGLE', grade: 0, weak: false, damage: amount(10), attackInterval: 1, raidSlot, starLevel: 0, selected: raidSlot !== null, canSelect: raidSlot === null });
  const state = { unlocked: true, phase: 'idle', seasonIndex: 1, bossIndex: 0, weakness: 'LASER', seasonRemainingSeconds: 90061,
    freeRemaining: 2, freeLimit: 2, adEnabled: false, adAvailable: false, canEnter: true, starGems: 0,
    seasonTryCount: 1, seasonBestLevel: 5, bestByType: [0,5,0,0,0,0,0], remainingSeconds: 60, durationSeconds: 60,
    clearedLevels: 0, level: 1, health: amount(100), maxHealth: amount(100), healthRatio: 1, reward: 0, newRecord: false, resultElapsed: 0, loadingElapsed: null,
    slots: [null,null,null], candidates: [weapon(0),weapon(3)],
    missions: [1,4,7,1,5,10,20,30].map((target, index) => ({index, type: index < 3 ? 'tries' : 'best', target, progress: index === 0 ? 1 : 0, reward: 300, complete: index === 0, claimed: false, claimable: index === 0})), hasClaimable: true, ...overrides };
  const records = { alerts: [], sounds: [], visibility: [], starts: 0, exits: 0, ads: 0, results: [], selection: [], stars: [], claims: [] };
  const canvas = makeNode('Canvas'); let request = null;
  const presenter = { showRewardedAd(token, placement, complete) { request = { token, placement, complete }; }, cancelRewardedAd() { request = null; } };
  const hud = new modules['./RaidHud'].RaidHud(canvas, art,
    { config, chineseFont: new Font(), originalFont: new Font(), numberFont: new Font() }, {
      getState: () => state, getWallet: () => ({money:'123',diamonds:'456'}),
      getSlotStars: () => state.slotStars ?? state.slots.map(item=>item?.starLevel ?? 0), getStarUnlocked: () => state.starUnlocked ?? state.unlocked,
      open: () => { state.phase = 'preparing'; return {ok:true}; }, close: () => {state.phase = 'idle'; return {ok:true};},
      start: () => { records.starts++; state.phase = 'entering'; return { ok: true }; },
      exit: () => { records.exits++; state.phase = 'exiting'; return { ok: true }; },
      selectWeapon: (slot,source) => {records.selection.push([slot,source]);state.slots[slot] = weapon(source,slot);return {ok:true};},
      unselectWeapon: slot => {state.slots[slot] = null;return {ok:true};},
      openStarUpgrade: slot => records.stars.push(slot),
      claimMission: index => {records.claims.push(index);state.missions[index].claimed=true;state.missions[index].claimable=false;return {ok:true};},
      beginAd: () => { records.ads++; state.phase = 'adPending'; return { ok: true, token: 'raid-ad' }; },
      completeAd: (token, outcome) => { records.results.push({ token, outcome }); state.phase = outcome === 'success' ? 'entering' : 'preparing'; return { ok: true }; },
      cancelAd: () => { records.results.push({ outcome: 'cancel' }); state.phase = 'preparing'; },
      alert: value => records.alerts.push(value), playSfx: id => records.sounds.push(id), onVisibilityChanged: value => records.visibility.push(value),
    }, presenter);
  const node = id => hud.ui.node(`level0:${id}`);
  const event = (target, id = 1, at, originalType) => ({ getID: () => id, getUILocation: () => at || target.worldPosition, getEventCode: () => originalType });
  const emit = (target, type, id, at, originalType = type) => target.events.get(type)?.(event(target, id, at, originalType));
  const clickNode = target => { emit(target, 'start'); emit(target, 'end'); };
  const click = id => clickNode(node(id));
  const button = (method, target) => { const spec = Object.values(config.nodes).find(n => n.button?.some(a => a.method === method && (!target || a.target === target))); assert.ok(spec, method); return hud.graphics.get(node(spec.id.replace('level0:', '')))[0]; };
  const action = (method, target) => clickNode(button(method,target));
  const text = id => node(id).getComponent(Label).string;
  return { hud, presenter, state, records, node, action, button, click, clickNode, emit, text, UITransform, Label, RichText, Sprite, atlases, borrowedFrames, bitmapFrames, weapon, LabelOutline, LabelShadow, Node, makeNode, art, modules, cc, completeAd: outcome => request.complete(outcome) };
}

test('Raid export retains original geometry, five animated bosses and free controls only', () => {
  assert.equal(Object.keys(config.nodes).length, 983);
  assert.deepEqual(config.nodes['level0:346'].rect.size, [1050, 1271.03173828125]);
  assert.deepEqual(config.nodes['level0:346'].rect.position, [0, -116.51593017578125]);
  assert.equal(config.roots.entry, 'level0:595');
  assert.equal(config.animation.duration, 1.5);
  assert.equal(config.rotations.some(t=>t.node==='level0:1084'),false);
  assert.deepEqual(config.sizeTweens.map(t=>[t.node,t.endValue,t.duration,t.easeType,t.loopType,t.loops]),[['level0:1084',[700,90],1,7,1,-1]]);
  assert.equal(config.nodes['level0:10299'].text.spriteAsset, '1015');
  assert.equal(config.nodes['level0:10149'].text.spriteAsset, 'raid-upgrade');
  assert.notEqual(config.inlineSprites['1015-0'],config.inlineSprites['1017-0']);
  assert.ok(Object.values(config.nodes).every(n => !/IAP|Helper_Slot|Helper_Purchase|StarPig|StarGem_Pig|Mission_Ticket|Re Claimable|Rank \(|Test_obj/.test(n.name)));
  for (const image of Object.values(config.images)) assert.ok(fs.existsSync(path.join(root, 'assets/resources', image.path + '.png')), image.path);
  for (const font of Object.values(config.bitmapFonts)) for (const page of font.pages) assert.ok(fs.existsSync(path.join(root, 'assets/resources', page + '.png')), page);
  const visuals = require('../assets/resources/art/raid-system/visuals.json');
  assert.equal(visuals.skins.length, 5); assert.ok(visuals.skins.every(s => s.parts.length === 4));
  assert.equal(visuals.idle.duration, 2); assert.equal(visuals.ground.path, 'art/raid-system/images/s457');
  assert.equal(visuals.portalParticles[0].timeEmissionRate, 30); assert.equal(visuals.bossDeathParticles[0].bursts[0].count, 50);
});

test('Raid slots and candidate cards reuse one exact authored grade label through all 65 weapon changes', () => {
  const h=harness(),{getWeapon,getWeaponGrade}=require('./.build/session/core/WeaponCatalog.js');
  const {gradeBadgeRendering}=require('./support/grade-badge-rendering.cjs');
  const {OriginalWeaponUi}=h.modules['./OriginalWeaponUi'],full=new OriginalWeaponUi(h.art,h.hud.ui.assets),parent=h.makeNode('FullRaidReference');
  for(const id of Object.values(config.roots)){full.create(id,parent);full.layout(id,1080,1920);}
  h.hud.resize(1080,1920);
  const roles=Object.values(config.roles).filter(role=>['Raid_GunSlot','Gun_Item_Demo'].includes(role.type));
  assert.equal(Object.keys(config.nodes).filter(id=>h.hud.ui.get(id)).length,707,'276 inactive grade labels are omitted');
  const targets=roles.map(role=>h.hud.ui.node(role.Degree_objs[0]));
  for(const id of [...Array.from({length:65},(_,i)=>i),...Array.from({length:65},(_,i)=>64-i)])for(const role of roles){
    const weapon=getWeapon(id),grade=getWeaponGrade(id),item={...h.weapon(0),weaponId:id,grade,type:weapon.type};
    h.hud.updateGun(role,null);assert.equal(h.hud.ui.node(role.Degree_objs[0]).active,false);
    h.hud.updateGun(role,item);
    const target=h.hud.ui.node(role.Degree_objs[0]);assert.equal(target.active,true);
    assert.deepEqual(gradeBadgeRendering(target,h),gradeBadgeRendering(full.node(role.Degree_objs[grade]),h),`${role.type} ${role.node} weapon ${id}`);
    assert.ok(role.Degree_objs.slice(1).every(key=>!h.hud.ui.get(key)));
  }
  assert.deepEqual(roles.map(role=>h.hud.ui.node(role.Degree_objs[0])),targets);
  full.destroy();parent.destroy();h.hud.destroy();
});

test('Raid opens with original localized labels, two daily entries, balances and slot panel', () => {
  const h = harness(); h.action('Content_Btn_Raid'); h.hud.update(.31);
  assert.equal(h.node(1862).active, false);
  assert.equal(h.state.phase, 'preparing'); assert.equal(h.hud.isOpen, true); assert.equal(h.hud.blocksUpgrades, true);
  assert.equal(h.node(346).scale.x, 1); assert.equal(h.text(117717), '123'); assert.equal(h.text(119568), '456');
  const role = config.roles['level0:124505'];
  assert.equal(h.hud.ui.node(role.MaxScore_txt).getComponent(h.Label).string, 'Score 5');
  assert.equal(h.hud.ui.node(role.Enter_Normal_obj).active, true); assert.equal(h.hud.ui.node(role.Enter_AD_obj).active, false);
  assert.equal(h.hud.ui.node(role.Enter_Ticket_txt).getComponent(h.Label).string, '2/2');
  assert.match(h.hud.ui.node(role.WeakType_txt).getComponent(h.Label).string, /扇子/);
  const weakNode = h.hud.ui.node(role.WeakType_txt), bitmap = h.hud.ui.bitmapTexts.get(weakNode);
  const chinese = bitmap.systemNodes.find(label => label.node.active && label.string.includes('扇子'));
  assert.ok(chinese); assert.equal(chinese.useSystemFont, true); assert.equal(chinese.font, null);
  assert.deepEqual([chinese.color.r,chinese.color.g,chinese.color.b],[255,255,0]);
  assert.deepEqual(h.records.visibility, [true]);
});

test('all Raid category labels use system Chinese with white/yellow styles and the seven-family mapping', () => {
  const h = harness(), catalog = require('./.build/session/core/WeaponCatalog.js');
  const refs = [...new Set(Object.values(config.roles).flatMap(role => [role.Type_txt, role.WeakType_txt]).filter(Boolean))];
  assert.equal(refs.length, 24);
  for (const ref of refs) {
    const node = h.hud.ui.node(ref), bitmap = h.hud.ui.bitmapTexts.get(node);
    assert.ok(bitmap, `packaged bitmap label ${ref}`);
    for (const category of Object.values(catalog.WEAPON_CATEGORY_NAMES)) {
      for (const color of ['#ffffff', '#ffff00']) {
        h.hud.ui.setText(ref, `<color=${color}>${category}</color>`);
        const labels = bitmap.systemNodes.filter(label => label.node.active);
        assert.equal(labels.map(label => label.string).join(''), category);
        assert.ok(labels.every(label => label.useSystemFont && label.font === null));
        assert.ok(labels.every(label => label.color.b === (color === '#ffffff' ? 255 : 0)));
      }
    }
  }
  h.hud.open(); h.hud.update(.31);
  const weakLabel = h.hud.ui.node(config.roles['level0:124505'].WeakType_txt).getComponent(h.Label);
  for (const [type, category] of Object.entries(catalog.WEAPON_CATEGORY_BY_TYPE)) {
    h.state.weakness = type; h.hud.update(0);
    assert.ok(weakLabel.string.includes(catalog.WEAPON_CATEGORY_NAMES[category]));
    assert.ok(weakLabel.string.includes('10'));
  }
});

test('locked entry alerts and underlying pressed buttons cancel when star modal opens', () => {
  const locked = harness({unlocked: false, unlockMessage:'第40关解锁'}); locked.action('Content_Btn_Raid');
  assert.equal(locked.node(1862).active, true);
  locked.hud.setEntryVisible(false); assert.equal(locked.node(595).active,false);
  locked.hud.setEntryVisible(true); assert.equal(locked.node(595).active,true);
  assert.equal(locked.state.phase, 'idle'); assert.deepEqual(locked.records.alerts, ['第40关解锁']);
  locked.state.unlocked=true;locked.hud.update(0);assert.equal(locked.node(1862).active,false);
  const h = harness(); h.hud.open(); h.hud.update(.31);
  const start = h.button('Game_Enter_Normal'); h.emit(start, 'start', 8);
  h.hud.setExternalModalOpen(true); h.hud.setExternalModalOpen(false); h.emit(start, 'end', 8);
  assert.equal(h.records.starts, 0); h.clickNode(start); assert.equal(h.records.starts, 1);
});

test('Raid selects source index into a raid slot and star action retains slot identity', () => {
  const h = harness(); h.state.slots[0]=h.weapon(0,0); h.hud.open(); h.hud.update(.31);
  const slot = Object.entries(config.roles).find(([,r]) => r.type === 'Raid_GunSlot' && r.SlotNum === 1)[0];
  h.action('SelectPanel_Open', slot); h.hud.update(.31);
  const visible = h.modules['./OriginalWeaponFeedback'].visibleInHierarchy;
  for (let index=0;index<h.state.candidates.length;index++) {
    const candidateRole=config.roles[config.roles['level0:124204'].item_list[index]], demo=config.roles[candidateRole.gun_item_demo];
    assert.equal(config.nodes[demo.node].active,false,'source Gun_Item_Demo starts inactive');
    assert.equal(config.nodes[demo.node].button,undefined,'source disabled inspector button must not intercept selection');
    assert.equal(h.hud.graphics.has(h.hud.ui.node(demo.node)),false);
    assert.equal(visible(h.hud.ui.node(demo.Gun_img)),true,'candidate gun and ancestor template must be visible');
    assert.equal(visible(h.hud.ui.node(demo.Type_txt)),true,'candidate type and ancestor template must be visible');
    assert.equal(h.hud.ui.node(demo.Type_txt).getComponent(h.Label).string,'弓');
    const image=h.hud.ui.imageChildren.get(h.hud.ui.node(demo.Gun_img));
    assert.equal(image.getComponent(h.Sprite).spriteFrame.texture.path,config.images[config.gunIcons[0]].path);
  }
  const unused=config.roles[config.roles['level0:124204'].item_list[2]], unusedDemo=config.roles[unused.gun_item_demo];
  assert.equal(visible(h.hud.ui.node(unused.node)),true,'empty authored grid cell stays visible');
  assert.equal(h.hud.ui.node(unused.Disable_obj).active,false); assert.equal(h.hud.ui.node(unused.Weak_obj).active,false);
  assert.equal(visible(h.hud.ui.node(unusedDemo.Gun_img)),false);
  const candidate = config.roles['level0:124204'].item_list[1];
  const candidateDemo=config.roles[config.roles[candidate].gun_item_demo];
  h.clickNode(h.hud.ui.node(candidateDemo.Gun_img)); assert.deepEqual(h.records.selection, [[1,3]],'clicking gun graphic routes to the enabled parent selection button');
  assert.equal(h.hud.selectionSlot, null); h.action('onClick_StarUpgrade', slot);
  assert.deepEqual(h.records.stars, [1]); h.action('Gun_UnSelect', slot); assert.equal(h.state.slots[1], null);
});

test('last equipped weapon cannot show an unequip action; empty slots retain shared star controls', () => {
  const h=harness({slotStars:[2,7,9]});h.state.slots[0]=h.weapon(0,0);h.hud.open();h.hud.update(.31);
  const slots=config.roles['level0:124505'].Gun_Slot_list.map(key=>config.roles[key]);
  assert.equal(h.hud.ui.node(slots[0].UnEquip_Btn_obj).active,false);
  assert.equal(h.hud.ui.node(slots[1].StarUpgrade_obj).active,true);
  assert.equal(h.hud.ui.node(slots[1].StarUpgrade_Lv_txt).getComponent(h.Label).string,'7');
  h.action('onClick_StarUpgrade',config.roles['level0:124505'].Gun_Slot_list[1]);assert.deepEqual(h.records.stars,[1]);
  h.state.slots[1]=h.weapon(3,1);h.hud.update(0);
  assert.equal(h.hud.ui.node(slots[0].UnEquip_Btn_obj).active,true);assert.equal(h.hud.ui.node(slots[1].UnEquip_Btn_obj).active,true);
  h.state.starUnlocked=false;h.hud.update(0);assert.ok(slots.every(role=>!h.hud.ui.node(role.StarUpgrade_obj).active));
});

test('both weekly countdowns retain all four original units below an hour and at rollover', () => {
  const h=harness({seasonRemainingSeconds:61.9});h.hud.open();h.hud.update(.31);
  const start=config.roles['level0:124505'],mission=config.roles['level0:123135'];
  for(const key of [start.Remain_Time_txt,mission.Season_Remain_txt])assert.equal(h.hud.ui.node(key).getComponent(h.Label).string,'0d 0h 1m 1s');
  h.state.seasonRemainingSeconds=0;h.hud.update(0);
  assert.equal(h.hud.ui.node(start.Remain_Time_txt).getComponent(h.Label).string,'0d 0h 0m 0s');
});

test('new record banner uses original size delta OutQuad yoyo without scaling its label or moving its anchor', () => {
  const h=harness({phase:'playing',newRecord:false}),banner=h.node(1084),label=h.node(10217);
  const originalPosition={...banner.position},labelWidth=label.getComponent(h.UITransform).width;
  h.hud.update(7.5);h.state.newRecord=true;h.hud.update(0);
  assert.equal(banner.getComponent(h.UITransform).width,720);
  h.hud.update(.5);assert.equal(banner.getComponent(h.UITransform).width,705);assert.equal(banner.getComponent(h.UITransform).height,92.5);
  assert.equal(label.position.x,352.5);assert.equal(label.getComponent(h.UITransform).width,labelWidth);assert.equal(banner.scale.x,1);
  assert.deepEqual({...banner.position},originalPosition);
  h.hud.update(.5);assert.equal(banner.getComponent(h.UITransform).width,700);
  h.hud.update(.5);assert.equal(banner.getComponent(h.UITransform).width,705);
  h.hud.update(.5);assert.equal(banner.getComponent(h.UITransform).width,720);
  h.state.newRecord=false;h.hud.update(.25);h.state.newRecord=true;h.hud.update(.25);
  assert.equal(banner.getComponent(h.UITransform).width,705,'DOTween keeps its phase while hidden after first Awake');
});

test('missions use source reward actions, claim state and drag suppression without trapping close', () => {
  const h = harness(); h.hud.open(); h.hud.update(.31); h.action('onClick_Open'); h.hud.update(.31);
  const mission = config.roles['level0:123135'].Mission_item_list[0];
  h.action('onClick_Reward', mission); assert.deepEqual(h.records.claims, [0]);
  const role = config.roles[mission]; assert.equal(h.hud.ui.node(role.Done_obj).active, true); assert.equal(h.hud.ui.node(role.Claimable_obj).active, false);
  const viewport = h.node(634); h.emit(viewport, 'start', 11, {x:0,y:0}); h.emit(viewport, 'move', 11, {x:0,y:100});
  assert.equal(h.hud.scrollTouch.moved, true); h.action('SetActive', config.roots.mission); assert.equal(h.hud.missionOpen, false);
});

test('disabled ads expose source unavailable branch; enabled successful ad enters once', () => {
  const h = harness({freeRemaining:0}); h.hud.open(); h.hud.update(.31);
  const role = config.roles['level0:124505']; assert.equal(h.hud.ui.node(role.Enter_Disable_obj).active, true); assert.equal(h.hud.ui.node(role.Enter_AD_obj).active, false);
  h.state.adEnabled = true; h.state.adAvailable = true; h.hud.update(0);
  h.action('Game_Enter_AD'); assert.equal(h.records.ads,1); assert.equal(h.state.phase,'adPending');
  h.completeAd('success'); assert.equal(h.state.phase,'entering'); assert.deepEqual(h.records.results,[{token:'raid-ad',outcome:'success'}]);
  h.hud.cancelInteractions(); assert.equal(h.records.results.length,1);
});

test('battle health and timer fill update, result is timed, active exit bypasses result', () => {
  const h = harness({phase:'playing',remainingSeconds:29.5,healthRatio:.25,health:{format:()=> '25'}});
  const battle = config.roles['level0:125222']; assert.equal(h.hud.blocksUpgrades, false);
  assert.equal(h.hud.ui.node(battle.Time_txt).getComponent(h.Label).string,'30s');
  const fill = h.hud.ui.node(battle.HP_Fill), size = h.hud.fillSizes.get(battle.HP_Fill);
  assert.equal(fill.getComponent(h.UITransform).width,size.width*.25);
  h.action('Game_Exit'); assert.equal(h.state.phase,'exiting'); assert.equal(h.node(1268).active,false);
  h.state.phase='result'; h.state.clearedLevels=7; h.state.reward=175; h.state.resultElapsed=2; h.hud.update(0);
  assert.equal(h.node(1268).active,true); assert.equal(h.text(117203),'Lv.7'); assert.equal(h.text(117317),'175');
  assert.equal(h.records.sounds.filter(s=>s===11).length,1); h.hud.update(.1); assert.equal(h.records.sounds.filter(s=>s===11).length,1);
});

test('disabled ads keep one confirmation action in Raid results without requesting another reward', () => {
  const h = harness({phase:'result',adEnabled:false,clearedLevels:7,reward:175,resultElapsed:2});
  const visible = h.modules['./OriginalWeaponFeedback'].visibleInHierarchy;
  const resultButtons = [];
  const collect = id => {
    const spec = config.nodes[id];
    if (spec.button && visible(h.hud.ui.node(id))) resultButtons.push(id);
    spec.children.forEach(collect);
  };
  collect(config.roots.result);
  assert.deepEqual(resultButtons, ['level0:830']);
  assert.equal(h.text(10288), '确定'); assert.equal(h.text(117317), '175');
  h.clickNode(h.hud.graphics.get(h.node(830))[0]);
  assert.equal(h.records.exits, 1); assert.equal(h.state.phase, 'exiting');
  assert.equal(h.node(1268).active, false); assert.equal(h.records.ads, 0);
  assert.deepEqual(h.records.claims, []); assert.deepEqual(h.records.results, []);
});

test('five source boss skins animate in XYZ, original hit bounce and level-clear particles', () => {
  const h = harness(), visuals = require('../assets/resources/art/raid-system/visuals.json');
  const modules = {...h.modules}; modules.cc.gfx = {BlendFactor:{ONE:1,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}};
  const simulations = [];
  modules['./OriginalParticleSimulation'] = {OriginalParticleSimulation: class {
    particles=[]; hits=0; constructor(specs) {this.specs=specs;simulations.push(this);} hit() {this.hits++;} update() {}
  }};
  for (const [file, key] of [['core/projection','../core/projection'],['view/OriginalCatAnimation','./OriginalCatAnimation'],['view/RaidBossView','./RaidBossView']]) {
    const module={exports:{}},source=fs.readFileSync(path.join(root,`assets/scripts/${file}.ts`),'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
      {module,exports:module.exports,require:key=>{assert.ok(key in modules,key);return modules[key];}}); modules[key]=module.exports;
  }
  h.art.catalog={raid:visuals};
  const boss={position:{x:-120,z:20},alive:true,level:1}, parent=h.makeNode('BossLayer');
  const view=new modules['./RaidBossView'].RaidBossView(h.art,boss,parent,0);
  const project=modules['../core/projection'].projectWorld, sample=modules['./OriginalCatAnimation'].sampleCatChannel;
  assert.deepEqual({...view.node.position},{...project(boss.position),z:0});
  view.update(.5,boss);
  const head=view.parts.find(part=>part.spec.name==='Head'), binding=visuals.idle.bindings.find(b=>b.part==='Head'&&b.property==='position');
  const p=[0,1,2].map(axis=>sample(visuals.idle.channels[binding.firstChannel+axis],.5)), projected=project({x:p[0],z:p[2]},p[1]);
  assert.equal(head.plane.position.x,projected.x); assert.equal(head.plane.position.y,projected.y);
  view.hit(); view.update(0,boss); assert.equal(view.bounce.scale.x,1);
  view.update(.1,boss); assert.ok(view.bounce.scale.x < 1); view.update(.2,boss); assert.equal(view.bounce.scale.x,1);
  boss.level=4;view.update(.016,boss);assert.equal(simulations[0].hits,3);view.update(.016,boss);assert.equal(simulations[0].hits,3);
  for(let skin=1;skin<5;skin++){view.update(0,boss,skin);assert.equal(view.parts[0].spec.image.path,visuals.skins[skin].parts[0].image.path);}
});




test('Raid parts and death particles use global Default5/6 without changing all five skins or leaking external nodes', () => {
  const h = harness(), visuals = require('../assets/resources/art/raid-system/visuals.json');
  Object.defineProperty(h.modules.cc.Node.prototype, 'isValid', {get() {return !this.destroyed;}});
  const modules = {...h.modules}; modules.cc.gfx = {BlendFactor:{ONE:1,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}};
  modules['./OriginalParticleSimulation'] = {OriginalParticleSimulation: class {
    particles=[]; constructor(specs) {this.specs=specs;} hit() {} update() {}
  }};
  for (const [file, key] of [['core/projection','../core/projection'],['view/OriginalCatAnimation','./OriginalCatAnimation'],['view/RaidBossView','./RaidBossView']]) {
    const module={exports:{}},source=fs.readFileSync(path.join(root,`assets/scripts/${file}.ts`),'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
      {module,exports:module.exports,require:key=>{assert.ok(key in modules,key);return modules[key];}}); modules[key]=module.exports;
  }
  h.art.catalog={raid:visuals};
  const world=h.makeNode('World'), layers=new Map(), layer=order=>{
    if(!layers.has(order))layers.set(order,h.makeNode('Default'+order,world));return layers.get(order);
  };
  const state={position:{x:-120,z:20},alive:true,level:1}, View=modules['./RaidBossView'].RaidBossView;
  const reference=new View(h.art,state,world,0), view=new View(h.art,state,world,0,layer);
  assert.deepEqual([...layers.keys()].sort((a,b)=>a-b),[5,6]);
  assert.equal(view.deathRoot.parent,layer(5));
  for(let skin=0;skin<5;skin++)for(const dt of [0,.13,.21]){
    reference.hit();view.hit();reference.update(dt,state,skin);view.update(dt,state,skin);
    for(let i=0;i<view.parts.length;i++){
      const part=view.parts[i],old=reference.parts[i];
      assert.equal(part.plane.parent.parent,layer(part.spec.order));
      for(const axis of ['x','y']){
        assert.ok(Math.abs(part.plane.worldPosition[axis]-old.plane.worldPosition[axis])<1e-10,'parent translation/bounce is applied once');
        assert.ok(Math.abs(part.image.worldScale[axis]-old.image.worldScale[axis])<1e-10,'world image scale unchanged');
      }
      assert.equal(part.image.angle,old.image.angle);assert.equal(part.plane.angle,old.plane.angle);
    }
    assert.deepEqual({...view.deathRoot.position},{...modules['../core/projection'].projectWorld(state.position),z:0});
  }
  view.setActive(false);view.update(.1,state);assert.equal(view.node.active,false);assert.equal(view.deathRoot.active,false);
  assert.ok([...view.partRoots.values()].every(n=>!n.active));
  view.setActive(true);assert.ok([...view.partRoots.values()].every(n=>n.active));
  state.alive=false;view.update(0,state);assert.equal(view.deathRoot.active,false);assert.ok([...view.partRoots.values()].every(n=>!n.active));
  const external=[view.deathRoot,...view.partRoots.values()];view.destroy();assert.ok(external.every(n=>n.destroyed));
  assert.ok([...layers.values()].every(n=>n.isValid),'shared global layers survive view destruction');reference.destroy();
});


test('idle Raid skips hidden tables and phase queries avoid full state construction', () => {
  const h = harness(); let reads = 0, paints = 0;
  h.hud.callbacks.getPhase = () => h.state.phase;
  h.hud.callbacks.getState = () => { reads++; return h.state; };
  const updateGun = h.hud.updateGun;
  h.hud.updateGun = function (...args) { paints++; return updateGun.apply(this, args); };
  for (let i = 0; i < 60; i++) {
    assert.equal(h.hud.isOpen, false); assert.equal(h.hud.blocksUpgrades, false);
    h.hud.setEntryVisible(true); h.hud.update(1 / 60, h.state);
  }
  assert.equal(reads, 0); assert.equal(paints, 0);
  h.hud.open(); assert.ok(paints > 0); assert.equal(h.hud.isOpen, true);
});

test('unchanged Raid candidate and mission data do not repaint or reorder, and changes remain live', () => {
  const h = harness(); h.hud.open();
  const candidateImages = new Set(h.hud.candidates.map(role => config.roles[role.gun_item_demo].Gun_img));
  const missionTexts = new Set(h.hud.missions.map(role => role.Reward_txt));
  let images = 0, texts = 0;
  const image = h.hud.ui.image, setText = h.hud.ui.setText;
  h.hud.ui.image = function (id, ...rest) { if (candidateImages.has(id)) images++; return image.call(this, id, ...rest); };
  h.hud.ui.setText = function (id, ...rest) { if (missionTexts.has(id)) texts++; return setText.call(this, id, ...rest); };
  h.hud.update(.1); assert.equal(images, 0); assert.equal(texts, 0);
  h.state.candidates[0].canSelect = false; h.state.missions[0].claimed = true; h.state.missions[0].claimable = false;
  h.hud.update(.1); assert.ok(images > 0); assert.ok(texts > 0);
  images = 0; texts = 0; h.hud.resize(720, 1600, 72, 36);
  assert.ok(images > 0); assert.ok(texts > 0, 'resize invalidates cached row geometry');
});
