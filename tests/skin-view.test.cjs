const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectPath } = require('./support/paths.cjs');
const visualConfig = require('../assets/resources/art/skin-system/visuals.json');
const rig = require('../assets/resources/art/characters/cat_basic/rig.json');
const catalog = require('../assets/resources/art/catalog.json');
const animation = require('./.build/character/OriginalCatAnimation.js');
const attackAnimation = require('./.build/character/WeaponAttackAnimation.js');
const weaponCatalog = require('./.build/core/WeaponCatalog.js');
const weaponVisuals = require('../assets/resources/art/weapon-system/visuals.json');

function load(name, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(projectPath(`assets/scripts/view/${name}.ts`), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, require: key => imports[key] ?? {} });
  return module.exports;
}

const { SkinVisualAssets } = load('SkinVisualAssets');

test('SkinVisualAssets starts with default and saved skin parts while preserving all appearance definitions', async () => {
  const requests = [];
  const art = { json: async path => { assert.equal(path, 'art/skin-system/visuals'); return visualConfig; },
    loadFrame: path => new Promise(resolve => requests.push({ path, resolve })) };
  const waiting = SkinVisualAssets.load(art, 7);
  await new Promise(setImmediate);
  const expected = [visualConfig.bodyContour.path, visualConfig.bodyContour.path,
    ...[...visualConfig.skins[0].parts, ...visualConfig.skins[7].parts].map(part => part.path)];
  assert.equal(requests.length, expected.length);
  assert.deepEqual(requests.map(request => request.path).sort(), expected.sort());
  assert.equal(art.skinVisuals, undefined, 'partially loaded skins cannot escape');
  requests.slice(1).forEach(request => request.resolve({}));
  await Promise.resolve();
  assert.equal(art.skinVisuals, undefined);
  requests[0].resolve({});
  const assets = await waiting;
  assert.equal(art.skinVisuals, assets);
  assert.equal(assets.isLoaded(0), true); assert.equal(assets.isLoaded(7), true); assert.equal(assets.isLoaded(1), false);
  for (let id = 0; id < 25; id++) assert.equal(assets.appearance(id), visualConfig.skins[id]);
  for (const id of [-1, 25, .5, NaN, Infinity, '1']) assert.throws(() => assets.appearance(id), /Unknown original skin/);
});

test('a missing skin frame rejects loading without replacing a previously valid appearance set', async () => {
  const previous = new SkinVisualAssets(visualConfig), art = { skinVisuals: previous,
    json: async () => visualConfig, loadFrame: async path => { if (path === visualConfig.skins[24].parts.find(part => part.id === 'tail').path) throw new Error('missing tail'); } };
  await assert.rejects(SkinVisualAssets.load(art, 24), /missing tail/);
  assert.equal(art.skinVisuals, previous);
  for (const config of [{ ...visualConfig, version: 2 }, { ...visualConfig, skins: visualConfig.skins.slice(1) },
    { ...visualConfig, skins: visualConfig.skins.map((skin, id) => id === 24 ? { ...skin, validation: { ...skin.validation, allTrianglesSingleBone: false } } : skin) }]) {
    assert.throws(() => new SkinVisualAssets(config), /Invalid original skin artwork/);
  }
});

test('on-demand skin requests coalesce by ID, publish readiness only after every part, and retry failures', async () => {
  const requests = [], art = { json: async () => visualConfig,
    loadFrame: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })) };
  const assets = new SkinVisualAssets(visualConfig, art);
  const partCount = visualConfig.skins[3].parts.length + 1;
  const first = assets.ensureLoaded(3), same = assets.ensureLoaded(3);
  assert.equal(first, same); assert.equal(requests.length, partCount); assert.equal(assets.isLoaded(3), false);
  const failed = assert.rejects(first, /missing part/);
  requests[0].reject(new Error('missing part')); requests.slice(1).forEach(r => r.resolve({})); await failed;
  assert.equal(assets.isLoaded(3), false);
  const retry = assets.ensureLoaded(3); assert.notEqual(retry, first); assert.equal(requests.length, partCount * 2);
  requests.slice(partCount, partCount * 2 - 1).forEach(r => r.resolve({})); await Promise.resolve();
  assert.equal(assets.isLoaded(3), false); requests[partCount * 2 - 1].resolve({}); await retry;
  assert.equal(assets.isLoaded(3), true); await assets.ensureLoaded(3); assert.equal(requests.length, partCount * 2);
});

test('default saved selection downloads only one skin and never duplicates the default', async () => {
  const requests = [], art = { json: async () => visualConfig, loadFrame: async path => requests.push(path) };
  await SkinVisualAssets.load(art, 0);
  assert.equal(requests.length, 10);
  assert.deepEqual(requests.sort(), [visualConfig.bodyContour.path, ...visualConfig.skins[0].parts.map(part => part.path)].sort());
});

test('a missing shared body contour rejects readiness even when all costume frames load', async () => {
  const art = { json: async () => visualConfig, loadFrame: async path => {
    if (path === visualConfig.bodyContour.path) throw Error('missing original contour');
  } };
  await assert.rejects(SkinVisualAssets.load(art, 0), /missing original contour/);
  assert.equal(art.skinVisuals, undefined);
});

function viewHarness({overlay=false}={}) {
  const nodes = [];
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const inversePoint=(matrix,point)=>{
    const d=matrix[0]*matrix[3]-matrix[1]*matrix[2],x=point.x-matrix[4],y=point.y-matrix[5];
    return {x:(matrix[3]*x-matrix[2]*y)/d,y:(matrix[0]*y-matrix[1]*x)/d,z:point.z??0};
  };
  class Color { constructor(r, g, b, a) { this.rgba = [r, g, b, a]; } }
  class Sprite {}
  class Graphics { clear() {} moveTo() {} lineTo() {} stroke() {} }
  class UITransform {
    setContentSize(...size) { this.size = size; }
    setAnchorPoint(...anchor) { this.anchor = anchor; }
    convertToNodeSpaceAR(point,out={}) { return Object.assign(out,inversePoint(this.node.worldMatrix,point)); }
    convertToWorldSpaceAR(point,out={}) {
      const m=this.node.worldMatrix;return Object.assign(out,{x:m[0]*point.x+m[2]*point.y+m[4],y:m[1]*point.x+m[3]*point.y+m[5],z:point.z??0});
    }
  }
  class Node {
    constructor(name) {
      this.name = name; this.children = []; this.components = new Map(); this.active = this.isValid = true;
      this.position = { x: 0, y: 0, z: 0 }; this.scale = { x: 1, y: 1, z: 1 }; this.angle = 0; nodes.push(this);
    }
    addComponent(Type) { const component = new Type(); component.node=this;this.components.set(Type, component); return component; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y, z = 0) { this.position = { x, y, z }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    get worldMatrix() {
      const a=this.angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
      const local=[c*this.scale.x,s*this.scale.x,-s*this.scale.y,c*this.scale.y,this.position.x,this.position.y];
      return this.parent?multiply(this.parent.worldMatrix,local):local;
    }
    get worldPosition(){const m=this.worldMatrix;return {x:m[4],y:m[5],z:this.position.z};}
    get worldRotation(){return {angle:this.angle+(this.parent?.worldRotation.angle??0)};}
    get worldScale(){const p=this.parent?.worldScale??{x:1,y:1,z:1};return {x:p.x*this.scale.x,y:p.y*this.scale.y,z:p.z*this.scale.z};}
    setWorldPosition(point){const p=this.parent?inversePoint(this.parent.worldMatrix,point):point;this.setPosition(p.x,p.y,p.z);}
    setWorldRotation(value){this.angle=value.angle-(this.parent?.worldRotation.angle??0);}
    setWorldScale(value){const p=this.parent?.worldScale??{x:1,y:1,z:1};this.setScale(value.x/p.x,value.y/p.y,value.z/p.z);}
    addChild(node) { node.removeFromParent(); this.children.push(node); node.parent = this; }
    setParent(node) { node.addChild(this); }
    setSiblingIndex(index) {
      if (!this.parent) return;
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this), 1);
      siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, this);
    }
    removeFromParent() { if (this.parent) { const siblings = this.parent.children; siblings.splice(siblings.indexOf(this), 1); this.parent = undefined; } }
    destroy() { this.isValid = false; this.destroyed = (this.destroyed || 0) + 1; this.children.slice().forEach(child => child.destroy()); }
  }
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); parent?.addChild(node); return node; };
  class Effects {
    setColor(color) { this.color = color; }
    updates = []; shots = 0; resets = 0;
    update(...args) { this.updates.push(args); }
    fire() { this.shots++; }
    reset() { this.resets++; }
    setWeapon(id) { this.weaponId = id; }
    setActive() {}
    destroy() {}
  }
  const modules = { cc: { Node, Sprite, Graphics, Color, UITransform, Vec3: class {} }, './ArtLibrary': { makeNode },
    './OriginalCatAnimation': animation, './OriginalMuzzleEffect': { OriginalMuzzleEffect: Effects },
    './OriginalWeaponGradeEffects': { OriginalWeaponGradeEffects: Effects }, './WeaponAttackAnimation': attackAnimation,
    './StaffCastEffect': { StaffCastEffect: Effects },
    '../core/WeaponCatalog': weaponCatalog, '../core/projection': require('./.build/core/projection.js') };
  const { CatView } = load('CatView', modules);
  // World projection/particle math is covered by cat-animation and particle tests.
  // Retain the real constructor, skin replacement, hierarchy and animator here.
  CatView.prototype.update = function () {};
  CatView.prototype.muzzleEmitterPose = () => ({ origin: { x: 0, y: 0 } });
  const art = { rig, catalog, frames: new Map(weaponVisuals.weapons.map(weapon=>[weapon.image.path,weapon.image.path])),
    weaponVisuals: { config: weaponVisuals, appearance: id => weaponVisuals.weapons[id] }, skinVisuals: new SkinVisualAssets(visualConfig),
    image(name, spec, parent) {
      const node = makeNode(name, parent); node.imageSpec = spec;
      const sprite = node.addComponent(Sprite); sprite.spriteFrame = spec.path;
      sprite.color = new Color(...(spec.color ?? [255, 255, 255, 255]));
      if (spec.localPosition) node.setPosition(...spec.localPosition);
      if (spec.localScale) node.setScale(...spec.localScale);
      node.angle = spec.localRotationDeg ?? 0;
      return node;
    } };
  const parent=makeNode('World'),overlayParent=overlay?makeNode('OverlayPass'):undefined;
  const cat = new CatView(art,parent,undefined,overlayParent);
  return { cat, art, CatView, makeNode, nodes, Sprite,parent,overlayParent };
}

test('new characters start with the authored bow and each skin supplies its own support palm center', () => {
  const {cat,art}=viewHarness();
  assert.equal(cat.weaponId,0);assert.equal(cat.weaponCategory,'bow');
  assert.equal(cat.gunImage.imageSpec.path,art.weaponVisuals.appearance(0).image.path);
  for(const skin of visualConfig.skins) {
    cat.setSkin(skin.id);
    assert.deepEqual(Array.from(cat.supportPalmCenter),skin.parts.find(part=>part.id==='hand_left').localPosition);
  }
});

test('preview and battle groups keep weapons above every skin and face while glove cuffs cover the holding hands',()=>{
  for(const overlay of [false,true]) {
    const {cat}=viewHarness({overlay}),root=cat.skinLayer.parent;
    // Serialized Cat sorting layer 26813799: body88628=0, face88442/glow75722=1,
    // sparks77061=2, gun89036=3, hand87086=4, outline88590=5. These are renderer
    // orders, not direction-dependent depths or the skin mesh triangle order.
    const expected=['Cat_Order0','Cat_Order1','Cat_Order2','Cat_Order3','Cat_Order4','Cat_Order5'];
    const gloveExpected=['Cat_Order0','Cat_Order1','Cat_Order2','Cat_Order4','Cat_Order5','Cat_Order3'];
    const layer=node=>{while(node.parent!==root){node=node.parent;assert.ok(node,'render node must stay under the rig');}return root.children.indexOf(node);};
    const check=()=>{
      const glove=cat.weaponCategory==='glove';
      assert.deepEqual(root.children.map(node=>node.name),glove?gloveExpected:expected);
      assert.equal(layer(cat.skinLayer),0);assert.equal(layer(cat.face),1);
      assert.equal(layer(cat.glowLayer),1);assert.equal(layer(cat.sparkLayer),2);
      assert.equal(layer(cat.gunImage),glove?5:3,'body and face must never cover the weapon');
      assert.equal(layer(cat.hands[0].node),glove?3:4);assert.equal(layer(cat.hands[1].node),glove?4:5);
    };
    const weapons=weaponCatalog.getWeaponCatalog();
    const firstOfEach=[...new Map(weapons.map(weapon=>[weapon.category,weapon])).values()];
    const probes=[...new Set([...weapons.filter(weapon=>weapon.category==='crossbow').map(weapon=>weapon.id),...firstOfEach.map(weapon=>weapon.id)])];
    for(const skin of visualConfig.skins) {
      cat.setSkin(skin.id);check();
      for(const id of probes) {
        cat.setWeapon(id);check();
        for(const facing of [-1,1])for(const elevation of [-90,0,5,7,11,13,45,90,180])for(const firing of [true,false]) {
          cat.aimAngle=elevation-cat.poses[0].r;
          cat.setAttackState({attackInterval:.3,attackProgress:.2,willFire:firing,hasTarget:true},firing?0:.05);
          cat.updatePose(0,skin.id%2===0,facing);check();
          cat.updateEffects(.01);check();
        }
      }
    }
    for(const weapon of weapons){cat.setWeapon(weapon.id);cat.aimAngle=90-cat.poses[0].r;cat.updatePose(0,false,-1);check();}
    cat.setWeapon(14);
    for(const facing of [-1,1])for(const side of [-1,0,1]) {
      cat.setAimTarget({x:-4+side,z:4+side});
      for(let frame=0;frame<60;frame++) {
        cat.setAttackState({attackInterval:.3,attackProgress:(frame%18)/18,willFire:frame%18===0,hasTarget:true},1/60);
        cat.updatePose(1/60,true,facing);cat.updateEffects(1/60);check();
      }
    }
    cat.reset();check();
  }
});

test('battle overlay owns every skin, face, hand and weapon through skin and lifecycle changes without duplicating sprites',()=>{
  const {cat,Sprite}=viewHarness({overlay:true});
  const belongs=(node,ancestor)=>{while(node&&node!==ancestor)node=node.parent;return node===ancestor;};
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  const overlayRig=cat.skinLayer.parent;
  assert.deepEqual(overlayRig.children.map(node=>node.name),['Cat_Order0','Cat_Order1','Cat_Order2','Cat_Order3','Cat_Order4','Cat_Order5']);
  assert.deepEqual(flatten(cat.node).filter(node=>node.getComponent(Sprite)),[cat.shadow],
    'only the ground shadow stays in the ordinary render pass');
  const overlayParts=[cat.skinLayer,cat.face,cat.glowLayer,cat.sparkLayer,cat.gunImage,cat.muzzle,...cat.hands.map(hand=>hand.node),cat.bowStringNode];
  for(const node of overlayParts)assert.ok(belongs(node,cat.overlayNode));
  for(const skin of visualConfig.skins) {
    cat.setSkin(skin.id);
    for(const node of overlayParts)assert.ok(node.isValid&&belongs(node,cat.overlayNode),'skin replacement must not rebuild overlay parts');
    const sprites=flatten(cat.overlayNode).filter(node=>node.getComponent(Sprite));
    for(const part of skin.parts) {
      const matches=sprites.filter(node=>node.name===part.id&&node.imageSpec.path===part.path);
      assert.equal(matches.length,1,`skin ${skin.id} ${part.id} must render exactly once in the overlay`);
      assert.ok(belongs(matches[0],cat.skinLayer));
    }
    assert.equal(sprites.length,skin.parts.length+4,'only skin parts, face, weapon, hand and outline have sprites');
  }
  for(const facing of [-1,1]) {
    cat.node.setPosition(facing*7,4);cat.node.setScale(.9,1.1,1);cat.node.angle=facing*23;
    cat.setFacing(facing);
    assert.deepEqual(cat.overlayBody.scale,cat.body.scale);
    assert.deepEqual(cat.overlayNode.worldPosition,cat.node.worldPosition);
    assert.deepEqual(cat.overlayNode.worldRotation,cat.node.worldRotation);
    assert.deepEqual(cat.overlayNode.worldScale,cat.node.worldScale);
  }
  cat.setActive(false);assert.equal(cat.node.active,false);assert.equal(cat.overlayNode.active,false);
  cat.setActive(true);assert.equal(cat.node.active,true);assert.equal(cat.overlayNode.active,true);
  cat.node.setPosition(-8,12);cat.reset();assert.deepEqual(cat.overlayNode.worldPosition,cat.node.worldPosition);
  cat.node.setPosition(9,-4);cat.updateEffects(.02);assert.deepEqual(cat.overlayNode.worldPosition,cat.node.worldPosition);
  cat.destroy();assert.equal(cat.node.destroyed,1);assert.equal(cat.overlayNode.destroyed,1);
  for(const node of overlayParts)assert.equal(node.isValid,false);
  assert.equal(viewHarness().cat.overlayNode,undefined,'standalone previews retain one combined tree');
});

test('whole-character overlay preserves skin, face, hand, weapon and muzzle transforms under independently transformed passes',()=>{
  const normal=viewHarness(),split=viewHarness({overlay:true});
  const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
  for(const h of [normal,split]){h.parent.setPosition(3,-2);h.parent.setScale(.75,.75,1);h.parent.angle=17;}
  split.overlayParent.setPosition(-6,9);split.overlayParent.setScale(1.25,1.25,1);split.overlayParent.angle=-20;
  for(const weapon of weaponCatalog.getWeaponCatalog())for(const facing of [-1,1])for(const direction of [0,1,2,3]) {
    for(const h of [normal,split]) {
      const cat=h.cat;cat.setSkin(weapon.id%visualConfig.skins.length);cat.setWeapon(weapon.id);cat.node.setPosition(4,-3);cat.node.setScale(.85,1.15,1);cat.node.angle=13;
      cat.aimAngle=direction*90-cat.poses[0].r;
      cat.setAttackState({attackInterval:.3,attackProgress:.96,willFire:false,hasTarget:true},0);
      cat.updatePose(0,false,facing);
      // Movement can happen after pose preparation. Reading the real muzzle
      // must synchronize the detached pass before returning its socket.
      cat.node.setPosition(7+direction,-5+weapon.id*.01);
    }
    const before=normal.cat.getMuzzleProjectionOffset(),after=split.cat.getMuzzleProjectionOffset();
    close(before.x,after.x);close(before.y,after.y);
    const renderedParts=cat=>[cat.face,cat.gunImage,...cat.hands.map(hand=>hand.node),
      ...cat.skinLayer.children.map(group=>{let node=group;while(node.children.length)node=node.children[0];return node;})];
    const normalParts=renderedParts(normal.cat),overlayParts=renderedParts(split.cat);
    assert.deepEqual(normalParts.map(node=>node.imageSpec.path),overlayParts.map(node=>node.imageSpec.path));
    normalParts.forEach((node,index)=>node.worldMatrix.forEach((value,axis)=>close(value,overlayParts[index].worldMatrix[axis])));
    const normalWorld=normal.cat.muzzle.worldPosition,overlayWorld=split.cat.muzzle.worldPosition;
    close(normalWorld.x,overlayWorld.x);close(normalWorld.y,overlayWorld.y);
    const a=normal.cat.getBulletSpawnOffset(2),b=split.cat.getBulletSpawnOffset(2);
    close(a.x,b.x);close(a.z,b.z);
    close(normal.cat.sortingDepth,split.cat.sortingDepth);
  }
});

test('all staff grips and casting centers stay registered through the complete rendered character chain',()=>{
  const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
  const worldPoint=(node,p)=>{const m=node.worldMatrix;return {x:m[0]*p[0]+m[2]*p[1]+m[4],y:m[1]*p[0]+m[3]*p[1]+m[5]};};
  const staves=weaponCatalog.getWeaponCatalog().filter(weapon=>weapon.category==='staff');
  for(const overlay of [false,true]) {
    const {cat,parent,overlayParent,nodes}=viewHarness({overlay});
    parent.setPosition(5,-3);parent.setScale(.8,.8);parent.angle=17;
    if(overlayParent){overlayParent.setPosition(-9,2);overlayParent.setScale(1.3,1.3);overlayParent.angle=-21;}
    cat.node.setPosition(2,4);cat.node.setScale(.85,1.15);cat.node.angle=13;
    for(const skin of [0,12,24])for(const staff of staves)for(const facing of [-1,1]) {
      cat.setSkin(skin);cat.setWeapon(staff.id);
      const support=nodes.find(node=>node.isValid&&node.name==='hand_left');
      for(const [progress,willFire,elapsed] of [[0,false,Infinity],[.91,false,Infinity],[1,true,0],[0,false,.1],[0,false,.3]]) {
        cat.attackPose=attackAnimation.sampleWeaponAttack('staff',{attackInterval:.6,attackProgress:progress,willFire,hasTarget:true},elapsed);
        cat.aimAngle=staff.id*7-cat.poses[0].r;cat.updatePose(0,false,facing);
        const grip=worldPoint(cat.gunImage,[0,0]),palm=cat.hands[0].node.worldPosition;
        close(grip.x,palm.x);close(grip.y,palm.y);
        for(const hand of cat.hands) {
          close(hand.node.angle,hand.node.imageSpec.localRotationDeg+cat.attackPose.staffCast.holdingRotation);
          close(hand.node.position.x,hand.node.imageSpec.localPosition[0]);
          close(hand.node.position.y,hand.node.imageSpec.localPosition[1]);
        }
        close(support.angle,support.imageSpec.localRotationDeg??0);
        close(support.position.x,support.imageSpec.localPosition[0]);close(support.position.y,support.imageSpec.localPosition[1]);
        const image=cat.weaponAppearance.image,muzzle=cat.weaponAppearance.muzzle.localPosition;
        const gripPx=[image.anchor[0]*image.sizePx[0],(1-image.anchor[1])*image.sizePx[1]];
        const tipPx=[gripPx[0]+muzzle[0]*image.ppu,gripPx[1]-muzzle[1]*image.ppu];
        const tipLocal=[(tipPx[0]/image.sizePx[0]-image.anchor[0])*image.sizeUnits[0],
          (1-tipPx[1]/image.sizePx[1]-image.anchor[1])*image.sizeUnits[1]];
        const tip=worldPoint(cat.gunImage,tipLocal),actual=cat.muzzle.worldPosition;
        close(tip.x,actual.x);close(tip.y,actual.y);
        // Rendering the original body animation must preserve the registered
        // grip while casting rotates only the holding palm at its source socket.
        cat.updateEffects(1/60);
        const rendered=worldPoint(cat.gunImage,[0,0]),renderedPalm=cat.hands[0].node.worldPosition;
        close(rendered.x,renderedPalm.x);close(rendered.y,renderedPalm.y);
        close(support.angle,support.imageSpec.localRotationDeg??0);
        for(const hand of cat.hands)close(hand.node.angle,hand.node.imageSpec.localRotationDeg+cat.attackPose.staffCast.holdingRotation);
      }
    }
  }
});

test('staff holding palm and outline rotations restore immediately on target loss, weapon switches and reset',()=>{
  const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
  for(const overlay of [false,true]) {
    const {cat,nodes}=viewHarness({overlay});cat.setWeapon(8);
    const support=nodes.find(node=>node.isValid&&node.name==='hand_left');
    const check=rotation=>{
      for(const hand of cat.hands) {
        close(hand.node.angle,hand.node.imageSpec.localRotationDeg+rotation);
        close(hand.node.position.x,hand.node.imageSpec.localPosition[0]);
        close(hand.node.position.y,hand.node.imageSpec.localPosition[1]);
      }
      close(support.angle,support.imageSpec.localRotationDeg??0);
    };
    const sample=(attackProgress,willFire,hasTarget=true)=>{
      cat.setAttackState({attackInterval:.6,attackProgress,willFire,hasTarget},0);
      cat.updatePose(0,false,-1);
    };
    check(0);sample(.52/.6,false);check(6);
    sample(0,false,false);check(0);
    for(const nextWeapon of [12,1,4,0]) {
      cat.setWeapon(8);sample(0,true);check(52);
      cat.setWeapon(nextWeapon);check(0);
    }
    cat.setWeapon(8);sample(0,true);check(52);
    cat.setWeapon(8);check(52);
    cat.reset();check(0);
    sample(0,false,false);check(0);
    sample(0,true);check(52);
    sample(0,true);check(52);
    cat.reset();check(0);
  }
});

test('gloves replace the whole holding paw in both render passes and other weapons restore its visibility', () => {
  for(const overlay of [false,true]) {
    const {cat,nodes}=viewHarness({overlay}),layer=cat.weaponDrawLayer.parent;
    const sourceOrder=layer.children.map(node=>node.name);
    const glove=weaponCatalog.getWeaponCatalog().find(weapon=>weapon.category==='glove');
    cat.setWeapon(glove.id);
    for(const skin of visualConfig.skins) {
      cat.setSkin(skin.id);
      assert.equal(cat.hands.length,2,'holding palm and outline are separate render layers');
      assert.ok(cat.hands.every(hand=>!hand.node.active));
      assert.equal(cat.holdingSkinParts.length,1);assert.equal(cat.holdingSkinParts[0].active,false);
      const support=nodes.find(node=>node.isValid&&node.name==='hand_left');
      assert.ok(support?.active,`skin ${skin.id} retains its visible support paw`);
      assert.equal(layer.children.at(-1),cat.weaponDrawLayer,'glove stays in the foreground while its covered paw is hidden');
    }
    for(const weapon of weaponCatalog.getWeaponCatalog().filter(weapon=>weapon.category!=='glove')) {
      cat.setWeapon(weapon.id);
      assert.deepEqual(layer.children.map(node=>node.name),sourceOrder);
      assert.ok(cat.hands.every(hand=>hand.node.active));assert.equal(cat.holdingSkinParts[0].active,true);
    }
  }
});

test('all authored glove cuffs stay at the source paw base through mirrored aiming and recoil', () => {
  const registration=require('./fixtures/glove-cuff-registration.json').weapons;
  const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
  const worldPoint=(node,p)=>{const m=node.worldMatrix;return {x:m[0]*p[0]+m[2]*p[1]+m[4],y:m[1]*p[0]+m[3]*p[1]+m[5]};};
  const localPoint=(image,p)=>[(p[0]/image.sizePx[0]-image.anchor[0])*image.sizeUnits[0],
    (1-p[1]/image.sizePx[1]-image.anchor[1])*image.sizeUnits[1]];
  assert.equal(registration.length,12);
  for(const overlay of [false,true]) {
    const {cat}=viewHarness({overlay});
    for(const skin of visualConfig.skins) {
      cat.setSkin(skin.id);
      for(const item of registration) {
        cat.setWeapon(item.id);
        const image=weaponVisuals.weapons[item.id].image;
        assert.ok(item.attackPointPx[0]>item.wristEntryPx[0],'artwork fires rightward from its cuff');
        for(const facing of [-1,1])for(const angle of [0,90,180,270])for(const elapsed of [0,.1,.2]) {
          cat.aimAngle=angle-cat.poses[0].r;
          const state={attackInterval:.6,attackProgress:0,willFire:true,hasTarget:true};
          cat.setAttackState(state,0);
          if(elapsed)cat.setAttackState({...state,willFire:false},elapsed);
          cat.updatePose(0,false,facing);
          const cuff=worldPoint(cat.gunImage,localPoint(image,item.wristEntryPx));
          const socket=cat.gunPivot.worldPosition,tip=worldPoint(cat.gunImage,localPoint(image,item.attackPointPx));
          const handBase=worldPoint(cat.hands[0].node,localPoint(rig.attachments.hand,[179,34.5941698919845]));
          close(cuff.x,socket.x);close(cuff.y,socket.y);
          close(cuff.x,handBase.x);close(cuff.y,handBase.y);
          close(tip.x,cat.muzzle.worldPosition.x);close(tip.y,cat.muzzle.worldPosition.y);
          close(cat.gunPivot.position.x,-0.33605452920024226+cat.attackPose.weaponOffset[0]);
          close(cat.gunPivot.position.y,-0.0690003+cat.attackPose.weaponOffset[1]);
          assert.ok(cat.hands.every(hand=>!hand.node.active));assert.ok(cat.holdingSkinParts.every(part=>!part.active));
          cat.updateEffects(1/60);
          const renderedCuff=worldPoint(cat.gunImage,localPoint(image,item.wristEntryPx));
          const renderedBase=worldPoint(cat.hands[0].node,localPoint(rig.attachments.hand,[179,34.5941698919845]));
          close(renderedCuff.x,renderedBase.x);close(renderedCuff.y,renderedBase.y);
        }
      }
    }
  }
});

test('hot-swapping every skin preserves active animation, recoil, weapon, face and outline', () => {
  const { cat, Sprite } = viewHarness();
  cat.setWeapon(9); cat.animator.update(.61, true); cat.animator.update(.13, true);
  cat.poses.forEach((pose, index) => { cat.animator.pose(index, pose); cat.setBone(index, pose); });
  cat.fire(); cat.recoil = .071; cat.aimAngle = 41; cat.faceAngle = 12; cat.targetOffset = { x: 2, z: -3 };
  cat.gunBounce.setScale(.7, 1.1, 1); cat.gunPivot.angle = 41;
  const preservedNodes = [cat.node, cat.shadow, cat.face, cat.gunPivot, cat.gunImage, cat.muzzle, ...cat.hands.map(value => value.node)];
  const hand = cat.hands.find(value => value.node.name === 'hand').node;
  const outline = cat.hands.find(value => value.node.name === 'handOutline').node;
  const originalOutline = outline.getComponent(Sprite).color;
  const originalFace = cat.face.getComponent(Sprite).color;
  const state = () => JSON.stringify({ animation: cat.animator, poses: cat.poses, recoil: cat.recoil,
    recoilJustStarted: cat.recoilJustStarted, weaponId: cat.weaponId, aimAngle: cat.aimAngle, faceAngle: cat.faceAngle,
    target: cat.targetOffset, gunPosition: cat.gunPivot.position, gunAngle: cat.gunPivot.angle, gunScale: cat.gunBounce.scale,
    muzzleShots: cat.muzzleEffect.shots, muzzleResets: cat.muzzleEffect.resets, gradeResets: cat.gradeEffects.resets });
  const before = state(), persistentFollowers = cat.poseFollowers.flat().filter(node => !cat.skinFollowers.has(node));
  for (const id of [...Array(25).keys(), ...Array(25).keys()].reverse()) {
    cat.setSkin(id);
    assert.equal(state(), before, `skin ${id} must not rewind an in-flight shot or pose`);
    assert.equal(cat.skinLayer.children.length, visualConfig.skins[id].parts.length);
    assert.deepEqual(hand.getComponent(Sprite).color.rgba, visualConfig.skins[id].handColor);
    assert.equal(outline.getComponent(Sprite).color, originalOutline);
    assert.equal(cat.face.getComponent(Sprite).color, originalFace);
    assert.ok(preservedNodes.every(node => node.isValid));
    const followers = cat.poseFollowers.flat();
    assert.equal(followers.length, persistentFollowers.length + cat.skinFollowers.size);
    assert.equal(new Set(followers).size, followers.length);
    assert.ok(followers.every(node => node.isValid), 'old bone followers are removed before destruction');
    for (const follower of persistentFollowers) assert.ok(followers.includes(follower));
    for (let index = 0; index < cat.poses.length; index++) for (const node of cat.poseFollowers[index]) {
      const pose = cat.poses[index];
      assert.deepEqual(node.position, { x: pose.p[0], y: pose.p[1], z: 0 });
      assert.equal(node.angle, pose.r);
      assert.deepEqual(node.scale, { x: pose.s[0], y: pose.s[1], z: 1 });
    }
    const images = cat.skinLayer.children.map(group => {
      let node = group; while (node.children.length) node = node.children[0]; return node.imageSpec.path;
    });
    assert.deepEqual(images, visualConfig.skins[id].parts.slice().sort((a, b) => a.drawOrder - b.drawOrder).map(part => part.path));
  }
});

test('reselect and invalid skin requests leave the current body intact; old bodies are detached once', () => {
  const { cat, nodes } = viewHarness(), first = cat.skinLayer.children.slice();
  const count = nodes.length, followers = Array.from(cat.skinFollowers);
  cat.setSkin(0); assert.equal(nodes.length, count);
  assert.deepEqual(Array.from(cat.skinFollowers), followers);
  assert.throws(() => cat.setSkin(25), /Unknown original skin/);
  assert.deepEqual(cat.skinLayer.children, first);
  cat.setSkin(24);
  for (const node of first) {
    assert.equal(node.parent, undefined); assert.equal(node.active, false); assert.equal(node.destroyed, 1);
  }
  assert.ok(followers.every(node => !node.isValid));
});

test('all fox costumes join original animated feet to one costume body', () => {
  const { cat } = viewHarness();
  for (let id = 1; id < visualConfig.skins.length; id++) {
    cat.setSkin(id);
    const skin = visualConfig.skins[id], body = skin.parts.find(part => part.id === 'body');
    assert.equal(skin.parts.length, 9, `skin ${id} must not add a naked torso bridge`);
    assert.ok(!skin.parts.some(part => part.id === 'garment'));
    const order = cat.skinLayer.children.map(node => node.name);
    for (const foot of ['foot_left', 'foot_right']) {
      assert.ok(order.indexOf('PartOrder_body') < order.indexOf(`PartOrder_${foot}`));
      assert.ok(skin.parts.find(part => part.id === foot).drawOrder > body.drawOrder,
        'original open-top feet connect over the native costume hem');
    }
    assert.ok(order.indexOf('PartOrder_body') < order.indexOf('PartOrder_head'));
  }
  cat.setSkin(0);
  assert.ok(!cat.skinLayer.children.some(node => node.name === 'PartOrder_garment'));
});

test('Battlefield skin selection updates hidden cats and is inherited by newly added squad members', () => {
  const h = viewHarness();
  const { BattlefieldView } = load('BattlefieldView', { './CatView': { CatView: h.CatView } });
  const field = Object.create(BattlefieldView.prototype);
  Object.assign(field, { art: h.art, cats: new Map(), skinId: 0, catLayer: h.makeNode('Cats'),
    map: { shadowLayer: h.makeNode('Shadows') }, layerForOrder: undefined, world: { players: [{ actorId: 0, weaponId: 0 }] } });
  const leader = field.getCat(0); field.setSkin(8);
  assert.equal(leader.skinId, 8);
  field.world.players.push({ actorId: 2, weaponId: 7 }); field.syncCharacters();
  const follower = field.cats.get(2);
  assert.equal(follower.skinId, 8); assert.equal(follower.weaponId, 7);
  follower.node.active = false; field.setSkin(24);
  assert.equal(leader.skinId, 24); assert.equal(follower.skinId, 24);
  field.world.players.push({ actorId: 3, weaponId: 12 }); field.syncCharacters();
  assert.equal(field.cats.get(3).skinId, 24);
  assert.equal(field.cats.get(3).weaponId, 12);
  assert.equal(field.cats.get(3).shadow.parent, field.map.shadowLayer);
});
