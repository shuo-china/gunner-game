const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');
const definition = require('../assets/resources/art/maps/forest/map.json');
const hunt = require('../assets/resources/art/hunt-system/visuals.json');

test('Hunt switches the exact ground texture, plane, unlit material and clipping, then restores Main and challenge', () => {
  class Sprite {}
  class UITransform {}
  class Vec4 { constructor(...values) { this.values = values; } }
  const Texture2D = { WrapMode: { REPEAT: 1 } };
  const context = { exports: {}, require: id => id === 'cc' ? { Sprite, UITransform, Vec4, Texture2D } :
    id === '../core' ? core : {} };
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/OriginalMapView.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, context);
  const map = Object.create(context.exports.OriginalMapView.prototype);
  const node = () => ({ active: true, position: { x: 0, y: 0 }, sprite: {}, transform: {
    setContentSize(...size) { this.size = size; }, setAnchorPoint(...anchor) { this.anchor = anchor; },
  }, getComponent(Type) { return Type === Sprite ? this.sprite : this.transform; },
  setPosition(x, y) { this.position = { x, y }; }, setScale(x, y) { this.scale = { x, y }; } });
  const frame = spec => ({ rect: { x: 0, y: 0, width: spec.sizePx[0], height: spec.sizePx[1] }, rotated: false,
    texture: { width: spec.sizePx[0], height: spec.sizePx[1], setWrapMode() {} } });
  map.definition = definition; map.skinIndex = 0; map.origin = { x: 0, z: 0 }; map.arena = map.raid = map.hunt = false;
  map.fillItems = []; map.shadowLayer = node(); map.material = { setProperty(name, value) { this[name] = value; } };
  map.art = { catalog: { hunt }, frames: new Map([definition.sprites.ground, hunt.ground].map(spec => [spec.path, frame(spec)])) };
  map.spriteItems = ['ground', definition.borders[0].asset].map((asset, index) => {
    const item = { node: node(), asset, basis: index ? definition.borders[0] : definition.ground };
    item.visible = { node: item.node }; return item;
  });
  map.visibleItems = map.spriteItems.map(item => item.visible);
  const ground = map.spriteItems[0].node;
  map.setBattlefield({skinIndex:0,mapLayout:'hunt',mapOrigin:{x:-100,z:0}});
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(hunt.ground.path));
  assert.deepEqual(ground.transform.size, hunt.ground.sizeUnits);
  assert.deepEqual(ground.position, core.projectWorld({ x: -100, z: 0 }));
  assert.ok(Math.abs(ground.scale.x - 15) < 1e-5); assert.ok(Math.abs(ground.scale.y - 8.66017) < 1e-4);
  assert.deepEqual(map.material.irradiance.values, [1, 1, 1, 1]);
  assert.deepEqual(map.material.uvTransform.values, [7, 3.740000009536743, 0, 0]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1]);
  assert.equal(map.spriteItems[1].node.active, false); assert.deepEqual(map.shadowLayer.position, { x: 0, y: 0 });
  map.setBattlefieldActive(false); map.updateCamera(core.projectWorld({ x: -100, z: 0 }), 100, 100);
  assert.equal(ground.active, false);
  map.setBattlefield(core.createStageDefinition(0, 0, 1));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(definition.sprites.ground.path));
  assert.deepEqual(map.material.irradiance.values, [...definition.ground.lighting.irradiance, 1]);
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 0]);
  assert.equal(map.spriteItems[1].node.active, true);
  map.setBattlefield(core.createSpeedRunDefinition(0, 1));
  assert.equal(ground.sprite.spriteFrame, map.art.frames.get(definition.sprites.ground.path));
  assert.deepEqual(map.material.groundClip.values, [.5, .5, .25, 1]);
});

test('Hunt assets are lazy and all twenty skins are ready before entering', async () => {
  const loaded=[],requested=[];
  const art={catalog:{},frames:new Map(),json:async path=>{requested.push(path);return hunt;},loadFrame:async path=>{loaded.push(path);art.frames.set(path,{});}};
  const batch = require('./support/resource-modules.cjs').resourceModules()('ResourceBatch');
  const context={exports:{},require:id=>id==='./OriginalMapView'?{OriginalMapView:{stageFrames:()=>[]}}:id==='./ResourceBatch'?batch:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../assets/scripts/view/BattleAssetLoader.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,context);
  const loader=new context.exports.BattleAssetLoader(art,definition);
  assert.equal(loader.ready({skinIndex:0}),true);assert.equal(requested.length,0);
  const stage={skinIndex:0,hunt:{},mapLayout:'hunt'};assert.equal(loader.ready(stage),false);
  await loader.load(stage);assert.deepEqual(requested,['art/hunt-system/visuals']);assert.equal(loader.ready(stage),true);
  for(const sprite of hunt.monsterSprites)assert.ok(loaded.includes(sprite.path));
  for(const spec of hunt.barrierParticles)assert.ok(loaded.includes(spec.image.path));
  assert.ok(loaded.includes(hunt.innerGround.image.path));
});

test('Hunt pool reuse restarts spawn animation, resets revealed health and changes original sprite', () => {
  class Node {
    constructor(name){Object.assign(this,{name,children:[],components:new Map(),position:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},active:true});}
    addComponent(Type){const component=new Type();component.node=this;this.components.set(Type,component);return component;}
    getComponent(Type){return this.components.get(Type);}
    setPosition(x,y,z=0){this.position={x,y,z};}setScale(x,y,z=1){this.scale={x,y,z};}
    setSiblingIndex(index){if(!this.parent)return;const a=this.parent.children;a.splice(a.indexOf(this),1);a.splice(index,0,this);}
    destroy(){this.destroyed=true;}
  }
  class UITransform {setContentSize(...size){this.size=size;}setAnchorPoint(...anchor){this.anchor=anchor;}}
  class Sprite {static Type={FILLED:1};static FillType={HORIZONTAL:1};}
  class Graphics {clear(){}moveTo(){}lineTo(){}close(){}fill(){}}
  class Color {constructor(...rgba){this.rgba=rgba;}}
  const makeNode=(name,parent)=>{const node=new Node(name);node.addComponent(UITransform);if(parent){node.parent=parent;parent.children.push(node);}return node;};
  const cc={Node,Sprite,UITransform,Graphics,Color,gfx:{BlendFactor:{ONE:1}}};
  const modules={cc,'../core':core,'../core/projection':core,'./ArtLibrary':{makeNode},
    './OriginalParticleSimulation':{OriginalParticleSimulation:class {particles=[];update(){}reset(){}hit(){}}},'./OriginalParticleMesh':{}};
  for(const file of ['OriginalFeedbackMath','HuntView']){
    const context={exports:{},require:id=>{assert.ok(id in modules,id);return modules[id];}};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,`../assets/scripts/view/${file}.ts`),'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,context);modules['./'+file]=context.exports;
  }
  const root=makeNode('root'),map=makeNode('map'),health=makeNode('health'),fill=makeNode('fill');
  const art={catalog:{hunt},frames:new Map(hunt.monsterSprites.map(s=>[s.path,{path:s.path}])),image:(name,spec,parent)=>{
    const n=makeNode(name,parent);n.addComponent(Sprite).spriteFrame=art.frames.get(spec.path);return n;}};
  const monster={id:1,alive:true,spawnGeneration:1,skinIndex:0,visualScale:1,position:{x:-120,z:20},health:core.DecimalAmount.from(500),maxHealth:core.DecimalAmount.from(500)};
  const state={enemies:[monster],barrierHp:1,wave:0};
  let innerGround;
  const view=new modules['./HuntView'].HuntView(art,state,root,{node:map,configureOverlayGround:(node,spec)=>{innerGround=spec;}},health,fill,()=>root);
  assert.equal(innerGround.path,hunt.innerGround.image.path);
  const actor=view.monsters.get(1);assert.equal(actor.sprite.scale.x,0);view.update(.31);assert.ok(Math.abs(actor.sprite.scale.x-5)<1e-5);
  view.hit(1);view.update(.01);assert.equal(actor.health.active,true);
  monster.alive=false;view.update(.01);assert.equal(actor.node.active,false);
  Object.assign(monster,{alive:true,spawnGeneration:2,skinIndex:3,visualScale:1.5});view.update(.01);
  assert.equal(actor.sprite.scale.x,0);assert.equal(actor.health.active,false);assert.equal(actor.skin,3);
  view.update(.31);assert.ok(Math.abs(actor.sprite.scale.x-7.5)<1e-5);
  assert.equal(actor.sprite.getComponent(Sprite).spriteFrame.path,hunt.monsterSprites[3].path);
  Object.assign(monster,{spawnGeneration:3});view.hit(1);view.update(.01);
  assert.equal(actor.sprite.scale.x,0);assert.equal(actor.health.active,true,'hit preceding the first render of a reused slot is retained');
  const next={...monster,id:2,spawnGeneration:1};state.enemies.push(next);view.hit(2);view.update(.01);
  assert.equal(view.monsters.get(2).health.active,true,'hit before allocating a newly spawned visual is retained');
  view.setActive(false);assert.equal(actor.node.active,false);assert.equal(actor.health.active,false);
  view.destroy();assert.equal(actor.node.destroyed,true);
});
