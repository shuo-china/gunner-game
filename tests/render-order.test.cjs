const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./.build/core/index.js');

function harness() {
  class Node {
    constructor(name) { this.name=name;this.children=[];this.active=this.isValid=true;this.position={x:0,y:0,z:0}; }
    setPosition(x,y,z=0){this.position={x,y,z};}
    setParent(parent){if(this.parent)this.parent.children.splice(this.getSiblingIndex(),1);this.parent=parent;parent.children.push(this);}
    getSiblingIndex(){return this.parent.children.indexOf(this);}
    setSiblingIndex(i){const p=this.parent;p.children.splice(this.getSiblingIndex(),1);p.children.splice(i,0,this);}
    destroy(){this.isValid=false;this.active=false;this.children.forEach(c=>c.destroy());}
  }
  const makeNode=(name,parent)=>{const n=new Node(name);if(parent)n.setParent(parent);return n;};
  const nodeDepth=node=>{
    const p=core.unprojectGround(node.position),c=core.CAMERA_BASIS;
    return p.x*c.forwardX+p.z*c.forwardZ;
  };
  class Cat {
    constructor(art,parent,layer,overlay) {
      this.node=makeNode('Cat',parent);this.shadow=makeNode('Shadow',this.node);
      this.overlayNode=makeNode('CatOverlay',overlay);
      this.skin=makeNode('Skin',this.overlayNode);this.face=makeNode('Face',this.overlayNode);
      this.weapon=makeNode('Weapon',this.overlayNode);this.hand=makeNode('Hand',this.overlayNode);
    }
    get sortingDepth(){return nodeDepth(this.node);}
    impactPosition(point){return point;}
    setWeapon(id){this.weaponId=id;} setSkin(){} setAimTarget(){} setAttackState(){}
    updatePose(){this.overlayNode.setPosition(this.node.position.x,this.node.position.y);}
    setFacing(){} getBulletSpawnOffset(){return {x:0,z:0};} updateEffects(){} fire(){}
    setActive(v){this.node.active=this.overlayNode.active=v;} reset(){}
    destroy(){this.node.destroy();this.overlayNode.destroy();}
  }
  class MapView {
    constructor(art,map,parent){this.node=makeNode('Map',parent);this.shadowLayer=makeNode('Shadows',this.node);}
    setBattlefield(){} cameraCenter(){return {x:0,y:0};} updateCamera(){} setBattlefieldActive(){} destroy(){this.node.destroy();}
  }
  class Tree {
    constructor(art,state,parent,config,hp,hpf){this.node=makeNode('Tree'+state.id,parent);this.healthRoot=makeNode('HP',hp);this.healthFillRoot=makeNode('HPFill',hpf);this.update(0,state);}
    get sortingDepth(){return nodeDepth(this.node);}
    update(dt,state){const p=core.projectWorld(state.position);this.node.setPosition(p.x,p.y);this.node.active=state.alive;}
    destroy(){this.node.destroy();this.healthRoot.destroy();this.healthFillRoot.destroy();} hit(){}
  }
  class Reticle {
    constructor(art,parent){this.node=makeNode('Target',parent);this.node.active=false;}
    update(dt,t){this.node.active=!!t;} reset(){this.node.active=false;}
  }
  class Pool {
    constructor(art,parent,layer){this.layer=typeof layer==='function'?layer:undefined;}
    setColliders(){} setWalls(){} prepareWeapons(){} update(){} reset(){} destroy(){} diagnostics(){return {active:0};}
    emit(order){return makeNode('Effect'+order,this.layer(order));}
  }
  class Boss {
    constructor(art,state,parent){this.node=makeNode('BossGroup',parent);this.update(0,state);}
    get sortingDepth(){return nodeDepth(this.node);}
    update(dt,state){const p=core.projectWorld(state.position);this.node.setPosition(p.x,p.y);}
    setActive(v){this.node.active=v;} destroy(){this.node.destroy();}
  }
  class Raid {
    constructor(art,state,parent,skin,layer){this.node=makeNode('RaidLogic',parent);this.parts=[makeNode('Raid5',layer(5)),makeNode('Raid6',layer(6))];}
    update(){} setActive(v){this.parts.forEach(p=>p.active=v);} destroy(){this.node.destroy();this.parts.forEach(p=>p.destroy());}
  }
  const imports={cc:{Node},'../core':core,'../core/projection':core,'./ArtLibrary':{makeNode},
    './CatView':{CatView:Cat},'./OriginalMapView':{OriginalMapView:MapView},'./TreeAppearance':{TreeAppearance:Tree},
    './TargetReticle':{TargetReticle:Reticle},'./OriginalProjectiles':{OriginalProjectiles:Pool},
    './OriginalMoneyBurst':{OriginalMoneyBurst:Pool},'./DamageNumbers':{DamageNumbers:Pool},
    './OriginalImpactFxThrottle':{OriginalImpactFxThrottle:class{}},'./BossView':{BossView:Boss},
    './RaidBossView':{RaidBossView:Raid},'./OriginalTreeAmbient':{OriginalTreeAmbient:Pool}};
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../assets/scripts/view/BattlefieldView.ts'),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,
    {module,exports:module.exports,require:key=>imports[key]??{}});
  const players=[0,1,2].map(actorId=>({actorId,weaponId:[6,0,7][actorId],position:{x:0,z:[0,10,-10][actorId]},facing:1,moving:false,targetId:null}));
  const world={petFollowers:{pets:[]},players,player:players[0],trees:[{id:1,alive:true,position:{x:0,z:5}}],damageTargets:[],stage:{},bullets:[],bulletWalls:[],simulationTime:0};
  const art={catalog:{raid:{portalParticles:[{sortingOrder:100}]}}};
  const field=new module.exports.BattlefieldView(art,world,makeNode('Root'),{tree:{},reticle:{height:3}},{},{},{});
  const pose=()=>{for(const p of world.players)field.prepareCatPose({dt:.02,player:p,actorId:p.actorId,weaponId:p.weaponId,attackInterval:.3,attackProgress:0,willFire:false});field.update(.02);};
  pose();
  const flatten=n=>[n,...n.children.flatMap(flatten)];
  return {field,world,pose,flatten};
}

test('complete cats remain above dense effects after arbitrarily ordered first-use layers, below health bars',()=>{
  const {field,flatten}=harness();
  assert.equal(field.cat.node.parent.name,'Default_Order0');
  assert.equal(field.target.node.parent.name,'Overlay_Default0');
  assert.equal(field.target.node.parent.parent.name,'OriginalOverlayPass600');
  const effects=[];
  for(const order of [41,14,-15,100,6,12,5,40,11,13,10]) {
    for(let i=0;i<32;i++)effects.push(field.projectiles.emit(order));
    const all=flatten(field.node);
    for(const cat of field.cats.values())for(const fx of effects) {
      for(const part of [cat.skin,cat.face,cat.weapon,cat.hand])
        assert.ok(all.indexOf(fx)<all.indexOf(part),'every squad member stays fully visible above all ordinary effects');
      assert.ok(all.indexOf(cat.shadow)<all.indexOf(fx),'the ground shadow retains its original lower layer');
    }
    const bands=field.node.children.filter(n=>n.name.startsWith('Default_Order')).map(n=>Number(n.name.slice(13)));
    assert.deepEqual(bands,bands.slice().sort((a,b)=>a-b));
  }
  const all=flatten(field.node);
  for(const tree of field.trees.values()) {
    assert.equal(tree.healthRoot.parent.name,'Overlay_Default10');
    assert.equal(tree.healthFillRoot.parent.name,'Overlay_Default11');
    for(const cat of field.cats.values())for(const part of [cat.skin,cat.face,cat.weapon,cat.hand])
      assert.ok(all.indexOf(tree.healthRoot)>all.indexOf(part),'GO3 health bars remain above every complete actor');
    assert.ok(all.indexOf(tree.healthFillRoot)>all.indexOf(tree.healthRoot));
  }
});

test('moving cats reorder whole groups by camera depth in both passes, with trees interleaved',()=>{
  const {field,world,pose}=harness();
  const names=parent=>parent.children.filter(n=>n.active&&n.isValid&&(/^(Cat|Tree)/.test(n.name))).map(n=>n.name);
  assert.deepEqual(names(field.catLayer),['Cat_1','Tree1','Cat','Cat_2']);
  assert.deepEqual(names(field.overlayLayer),['CatOverlay_1','CatOverlay','CatOverlay_2']);
  world.players[1].position.z=-20;world.players[2].position.z=20;pose();
  assert.deepEqual(names(field.catLayer),['Cat_2','Tree1','Cat','Cat_1']);
  assert.deepEqual(names(field.overlayLayer),['CatOverlay_2','CatOverlay','CatOverlay_1']);
  world.players.splice(1,1);pose();
  assert.equal(field.cats.get(1).overlayNode.active,false);
  assert.ok(!names(field.catLayer).includes('Cat_1'));
});

test('Boss/Raid rebuild and map hiding retain pass ownership without hiding surviving actors',()=>{
  const {field,world,pose,flatten}=harness();
  world.stage={boss:{position:{x:0,z:6}}};field.reset();pose();
  assert.equal(field.bossView.node.parent,field.catLayer);
  const oldBoss=field.bossView.node;
  world.stage={raidBoss:{position:{x:0,z:8},bossIndex:0},mapOrigin:{x:0,z:0}};field.reset();pose();
  assert.equal(oldBoss.isValid,false);
  assert.deepEqual(field.raidBossView.parts.map(n=>n.parent.name),['Default_Order5','Default_Order6']);
  assert.equal(field.raidPortal.parent.name,'Default_Order100');
  const all=flatten(field.node);
  assert.ok(all.indexOf(field.raidBossView.parts[1])<all.indexOf(field.cat.overlayNode));
  field.setBattlefieldActive(false);
  assert.ok(field.raidBossView.parts.every(n=>!n.active));assert.equal(field.raidPortal.active,false);
  assert.ok([...field.trees.values()].every(t=>!t.node.active));
  assert.equal(field.cat.node.active,true);assert.equal(field.cat.overlayNode.active,true);
  field.setBattlefieldActive(true);pose();assert.ok(field.raidBossView.parts.every(n=>n.active));
  const overlays=[...field.cats.values()].map(c=>c.overlayNode);field.destroy();assert.ok(overlays.every(n=>!n.isValid));
});

test('camera-depth permutation never shifts interleaved unowned pooled effects',()=>{
  const {field,world,pose}=harness();
  const fx=field.projectiles.emit(0);fx.setSiblingIndex(1);
  const money=field.catLayer.children.find(n=>n.name==='MoneyBurst');
  const slots=[fx.getSiblingIndex(),money.getSiblingIndex()];
  for(const order of [[30,40,50],[50,30,40],[-30,50,10],[-40,-20,-30],[0,10,-10]]) {
    world.players.forEach((p,i)=>p.position.z=order[i]);pose();
    assert.deepEqual([fx.getSiblingIndex(),money.getSiblingIndex()],slots,'pooled effects retain their source ownership slot');
    const visible=field.catLayer.children.filter(n=>n.active&&n.isValid&&/^(Cat|Tree)/.test(n.name));
    const depths=visible.map(n=>n.name.startsWith('Tree')?field.trees.get(1).sortingDepth:[...field.cats.values()].find(c=>c.node===n).sortingDepth);
    assert.deepEqual(depths,depths.slice().sort((a,b)=>b-a));
  }
});

test('cached ordering matches the original permutation through dense moves, ties and pool activation',()=>{
  const {field,world,pose}=harness();
  world.trees=Array.from({length:501},(_,id)=>({id,alive:true,position:{x:id%9,z:Math.floor(id/9)*4}}));
  field.reset();
  const original=field.sortRenderGroups.bind(field),c=core.CAMERA_BASIS;
  // Freeze the old per-frame sort/permutation as an independent reference.
  const expected=entries=>{
    const live=entries.filter(e=>e.node.active&&e.node.isValid),parent=live[0]?.node.parent;
    if(!parent)return [];
    const owned=new Set(live.map(e=>e.node));live.sort((a,b)=>b.depth-a.depth);
    let at=0;return parent.children.map(node=>owned.has(node)?live[at++].node:node);
  };
  field.sortRenderGroups=()=>{
    const normal=[],overlay=[];
    for(const player of world.players){const cat=field.cats.get(player.actorId);normal.push({node:cat.node,depth:cat.sortingDepth});overlay.push({node:cat.overlayNode,depth:cat.sortingDepth});}
    for(const state of world.trees){const view=field.trees.get(state.id);normal.push({node:view.node,depth:view.sortingDepth});}
    const target=world.damageTargets.find(t=>t.id===world.player.targetId);
    if(target&&field.target.node.active)overlay.push({node:field.target.node,depth:
      (target.collider.minX+target.collider.maxX)/2*c.forwardX+3*c.forwardY+(target.collider.minZ+target.collider.maxZ)/2*c.forwardZ});
    const n=expected(normal),o=expected(overlay);original();
    assert.deepEqual(field.catLayer.children,n);assert.deepEqual(field.overlayLayer.children,o);
  };
  let seed=93;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  world.damageTargets=[{id:99,collider:{minX:0,maxX:0,minZ:0,maxZ:0}}];
  for(let frame=0;frame<240;frame++){
    for(const player of world.players)player.position.z=Math.floor(random()*30)*4;
    for(let i=0;i<5;i++){const tree=world.trees[Math.floor(random()*world.trees.length)];tree.alive=random()>.2;tree.position.z=Math.floor(random()*30)*4;}
    world.player.targetId=frame%3===0?99:null;
    if(frame%17===0){const fx=field.projectiles.emit(0);fx.setSiblingIndex(Math.floor(random()*field.catLayer.children.length));}
    pose();
  }
  const entries=field.normalOrder.entries.slice();let writes=0;
  for(const node of field.catLayer.children){const set=node.setSiblingIndex.bind(node);node.setSiblingIndex=i=>{writes++;set(i);};}
  for(let frame=0;frame<60;frame++)pose();
  assert.equal(writes,0,'stationary frames never write sibling order');
  assert.ok(field.normalOrder.entries.every((entry,i)=>entry===entries[i]),'stable frames reuse group entries');
});
