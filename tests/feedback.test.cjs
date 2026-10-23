const { projectPath } = require('./support/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const feedbackMath = require(path.resolve(__dirname, './.build/feedback/view/OriginalFeedbackMath.js'));
const { projectedSpritePlane, decomposeProjectedPlane, originalBounceScale, sampleOriginalDamageCurve, originalDamageDirtyKeys, originalDamageBucket } = feedbackMath;
const { CAMERA_BASIS: camera } = require(path.resolve(__dirname, './.build/feedback/core/projection.js'));
const feedback = require(projectPath('assets/resources/art/effects/original_feedback/config.json'));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('original tree bounce reaches exact source peak at half duration and returns linearly', () => {
  const { duration, peakScale: peak } = feedback.tree.hit;
  const expected = [[0, 1, 1], [.25, (1 + peak[0]) / 2, (1 + peak[1]) / 2],
    [.5, peak[0], peak[1]], [.75, (1 + peak[0]) / 2, (1 + peak[1]) / 2], [1, 1, 1], [2, 1, 1]];
  for (const [time, x, y] of expected) {
    const scale = originalBounceScale(time * duration, duration, peak);
    close(scale.x, x); close(scale.y, y);
  }
});

test('damage baked samples interpolate while dirty keys preserve native cast boundaries', () => {
  const samples=Array.from({length:65},(_,i)=>i*i);
  close(sampleOriginalDamageCurve(samples,10.25/64),100+(121-100)*.25);
  close(sampleOriginalDamageCurve(samples,-1),0);
  close(sampleOriginalDamageCurve(samples,2),4096);
  assert.deepEqual(originalDamageDirtyKeys(-.126,.124,1.015),[65535,0,64]);
  assert.deepEqual(originalDamageDirtyKeys(-.124,.126,1.016),[0,1,65]);
  assert.deepEqual(originalDamageDirtyKeys(0,0,10),[0,0,255]);
});

test('damage cooldown buckets use source world XY and half-to-even rounding', () => {
  assert.equal(originalDamageBucket(.75,2),'0,1');
  assert.equal(originalDamageBucket(2.25,2),'2,1');
  assert.equal(originalDamageBucket(-.75,2),'0,1');
  assert.equal(originalDamageBucket(-2.25,2),'-2,1');
});

function feedbackViewHarness(filename) {
  const fs=require('node:fs'),vm=require('node:vm');
  const ts=require('typescript');
  class UITransform {
    setContentSize(width,height){Object.assign(this,{width,height});}
    setAnchorPoint(x,y){this.anchor={x,y};}
  }
  class Sprite {updateMaterial(){}}
  Sprite.Type={FILLED:1};Sprite.FillType={HORIZONTAL:0};
  class UIOpacity {opacity=255;}
  class Color {constructor(...rgba){this.rgba=rgba;}set(...rgba){this.rgba=rgba;}}
  class Node {
    static EventType={NODE_DESTROYED:'destroyed'};
    once() {}
    constructor(name){this.name=name;this.children=[];this.components=new Map();this.active=true;this.scale={x:1,y:1,z:1};this.position={x:0,y:0,z:0};}
    addChild(node){this.children.push(node);node.parent=this;}
    addComponent(type){const c=new type();this.components.set(type,c);return c;}
    getComponent(type){return this.components.get(type);}
    setPosition(x,y,z){this.position={x,y,z};}
    setScale(x,y,z){this.scale={x,y,z};}
  }
  const makeNode=(name,parent)=>{const n=new Node(name);n.addComponent(UITransform);parent?.addChild(n);return n;};
  const config=require(projectPath('assets/resources/art/effects/original-feedback.json'));
  const treeSprite=require(projectPath('assets/resources/art/stages/config.json')).treeSprites[0];
  const art={catalog:{feedback:config,enemies:{tree_pine:{displayScale:[1,1],sprite:treeSprite},tree_round:{displayScale:[1,1],sprite:treeSprite}}},
    frames:new Map(Object.values(config.damage.glyphs).map(g=>[g.path,g.path])),
    image:(name,spec,parent)=>{const n=makeNode(name,parent);const sprite=n.addComponent(Sprite);sprite.spriteFrame=spec.path;return n;}};
  const core=require('./.build/feedback/core/index.js'),calls={projections:0};
  const viewCore={...core,projectWorld:(...args)=>{calls.projections++;return core.projectWorld(...args);}};
  function load(filename) {
    const module={exports:{}};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath(`assets/scripts/view/${filename}.ts`),'utf8'),
      {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
      {exports:module.exports,module,require:name=>name==='cc'?{Node,Sprite,UIOpacity,UITransform,Color,gfx:{BlendFactor:{ONE:1,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}}}:
        name==='./ArtLibrary'?{makeNode}:name==='./OriginalFeedbackMath'?feedbackMath:
        name==='./OrderedQuadBatch'?{OrderedQuadBatch:require('./support/number-batch-harness.cjs').NumberBatchHarness}:
        name==='./NumberGlyphAtlas'?{retainNumberGlyphAtlas:()=>()=>{},numberGlyphFrame:(art,path)=>art.frames.get(path)}:
        name==='./OriginalTreeAmbient'?load('OriginalTreeAmbient'):
        name==='./OriginalParticleSimulation'?require('./.build/feedback/view/OriginalParticleSimulation.js'):
        name==='../core'?viewCore:name==='../core/projection'?core:{} });
    return module.exports;
  }
  return {View:load(filename)[filename],art,parent:makeNode('Root'),Sprite,UIOpacity,calls};
}

test('damage glyphs follow the requested number and pool grows instead of dropping the 25th object', () => {
  const {View,art,parent,Sprite}=feedbackViewHarness('DamageNumbers');
  const view=new View(art,parent);
  for(let i=0;i<25;i++)view.spawn({x:i*3,z:0},i===0?275:100,0);
  assert.equal(view.diagnostics().active,25);
  assert.equal(parent.children.length,0,'number slots and glyphs are data, not individual scene nodes');
  assert.deepEqual(Array.from(view.slots[0].digits,digit=>digit.frame),
    ['2','7','5'].map(c=>art.catalog.feedback.damage.glyphs[c].path));
  view.update(1.1,1.1);view.spawn({x:0,z:0},9,1.1);
  const digits=view.slots[0].digits;
  assert.equal(digits[0].frame,art.catalog.feedback.damage.glyphs['9'].path);
  assert.equal(view.slots[0].glyphCount,1,'reusing a shorter number hides excess glyphs');
});

test('damage cooldown and initial age use hit physics time versus render-frame time', () => {
  const {View,art,parent}=feedbackViewHarness('DamageNumbers');
  const view=new View(art,parent);
  view.spawn({x:0,z:0},100,.02);
  view.spawn({x:0,z:10},100,.03);
  assert.equal(view.diagnostics().active,1,'world Z is not part of the source cooldown bucket');
  view.update(1/30,1/30);
  close(view.slots[0].time,1-(1/30-.02));
  view.spawn({x:0,z:10},100,.14);
  assert.equal(view.diagnostics().active,2,'0.12 seconds since the last accepted number permits another');
  view.reset();view.spawn({x:0,z:0},100,0);
  assert.equal(view.diagnostics().active,1);
  close(view.slots[0].time,art.catalog.feedback.damage.duration);
});

test('Raid damage numbers project and throttle by the actual impact height while ordinary calls retain y2', () => {
  const {View,art,parent}=feedbackViewHarness('DamageNumbers');
  const {projectWorld}=require('./.build/feedback/core/index.js');
  const view=new View(art,parent),position={x:-120,z:10};
  view.spawn(position,100,0,false,8);
  view.spawn(position,100,0,false,8);
  view.spawn(position,100,0);
  assert.equal(view.diagnostics().active,2,'different height buckets can show together; matching surface hits are throttled');
  assert.deepEqual({...view.slots[0].origin},projectWorld(position,8));
  assert.deepEqual({...view.slots[1].origin},projectWorld(position,2));
});

test('damage animation retains its spawn projection and refreshes it when the slot is reused', () => {
  const {View,art,parent,calls}=feedbackViewHarness('DamageNumbers');
  const view=new View(art,parent),position={x:3,z:4};
  view.spawn(position,100,0);assert.equal(calls.projections,1);
  const origin={...view.slots[0].origin};position.x=999;
  for(let frame=1;frame<=30;frame++)view.update(1/60,frame/60);
  assert.equal(calls.projections,1,'stationary number origin is not projected each draw');
  assert.deepEqual({...view.slots[0].origin},origin,'caller position cannot move an existing number');
  view.update(1,1.5);view.spawn({x:12,z:8},20,1.5);
  assert.equal(calls.projections,2);assert.notDeepEqual({...view.slots[0].origin},origin);
});

test('a new tree bounce yields its first frame, while retrigger resets the existing coroutine timer', () => {
  const {View,art,parent}=feedbackViewHarness('TreeAppearance');
  const tree={id:1,degree:0,alive:true,health:900,maxHealth:1000,position:{x:0,z:0}};
  const view=new View(art,tree,parent,feedback.tree);
  view.hit();view.update(.05,tree);
  close(view.bounce.scale.x,1);
  view.update(.05,tree);
  close(view.bounce.scale.x,originalBounceScale(.05,feedback.tree.hit.duration,feedback.tree.hit.peakScale).x);
  view.hit();view.update(.05,tree);
  close(view.bounce.scale.x,originalBounceScale(.05,feedback.tree.hit.duration,feedback.tree.hit.peakScale).x);
  view.update(.2,tree);close(view.bounce.scale.x,1);
  tree.alive=false;view.update(.016,tree);
  assert.equal(view.node.active,false);assert.equal(view.healthRoot.active,false);
});

test('tree positions project only on changes and keep both independent health layers aligned', () => {
  const {View,art,parent,calls}=feedbackViewHarness('TreeAppearance');
  const tree={id:1,degree:0,alive:true,health:900,maxHealth:1000,position:{x:0,z:0}};
  const view=new View(art,tree,parent,feedback.tree);
  assert.equal(calls.projections,1);
  view.hit();for(let i=0;i<60;i++)view.update(1/60,tree);
  assert.equal(calls.projections,1,'bounce and health updates do not reproject an unchanged tree');
  tree.position={x:3,z:8};view.update(1/60,tree);
  assert.equal(calls.projections,2);
  assert.deepEqual(view.node.position,view.healthRoot.position);
  assert.deepEqual(view.node.position,view.healthFillRoot.position);
  tree.position={x:-1,z:10};view.reset(tree);assert.equal(calls.projections,3);
  assert.deepEqual(view.node.position,view.healthFillRoot.position);
});

test('tree health ratios update only on health changes and reset invalidates the cache', () => {
  const {View,art,parent}=feedbackViewHarness('TreeAppearance');
  const {DecimalAmount:D}=require('./.build/feedback/core/index.js');
  const original=D.prototype.ratio;let calls=0;
  D.prototype.ratio=function(value){calls++;return original.call(this,value);};
  try {
    const tree={id:1,degree:0,alive:true,health:D.from('9e5000'),maxHealth:D.from('1e5001'),position:{x:0,z:0}};
    const view=new View(art,tree,parent,feedback.tree);
    assert.equal(calls,1);close(view.fill.fillRange,.9);
    for(let i=0;i<60;i++)view.update(1/60,tree);
    assert.equal(calls,1);
    tree.health=D.from('8e5000');view.update(1/60,tree);assert.equal(calls,2);close(view.fill.fillRange,.8);
    tree.maxHealth=D.from('2e5001');view.update(1/60,tree);assert.equal(calls,3);close(view.fill.fillRange,.4);
    view.hit();view.update(1/60,tree);assert.equal(calls,3);assert.equal(view.healthRoot.active,true);
    tree.alive=false;tree.health=D.from(0);view.update(1/60,tree);assert.equal(calls,3);
    tree.alive=true;tree.health=tree.maxHealth;view.reset(tree);
    assert.equal(calls,4);close(view.fill.fillRange,1);assert.equal(view.healthRoot.active,false);
    view.reset(tree);assert.equal(calls,5,'an identical revived value must still initialize a new life');
  } finally {D.prototype.ratio=original;}
});

test('tree sorting follows source billboard mesh-center depth through bounce and movement', () => {
  const {View,art,parent}=feedbackViewHarness('TreeAppearance');
  const state={id:1,degree:0,alive:true,health:900,maxHealth:1000,position:{x:4,z:7}};
  const view=new View(art,state,parent,feedback.tree),image=art.catalog.enemies.tree_pine.sprite;
  // Independent source quaternion oracle, rather than screen Y or ground-only depth.
  const [x,y,z,w]=[.31598538,-.35960481,.13088542,.86816287];
  for(const time of [0,.05,.1,.15,.3]) {
    view.hit();view.update(0,state);view.update(time,state);
    const cx=(.5-image.anchor[0])*image.sizeUnits[0]*view.sprite.scale.x*view.bounce.scale.x;
    const cy=(.5-image.anchor[1])*image.sizeUnits[1]*view.sprite.scale.y*view.bounce.scale.y;
    const worldX=state.position.x+(1-2*(y*y+z*z))*cx+2*(x*y-z*w)*cy;
    const worldY=2*(x*y+z*w)*cx+(1-2*(x*x+z*z))*cy;
    const worldZ=state.position.z+2*(x*z-y*w)*cx+2*(y*z+x*w)*cy;
    close(view.sortingDepth,worldX*camera.forwardX+worldY*camera.forwardY+worldZ*camera.forwardZ);
  }
  const before=view.sortingDepth;state.position.z+=9;view.update(0,state);
  close(view.sortingDepth-before,9*camera.forwardZ);
});

test('stage props scale their artwork, health position and ambient parent together without shrinking the health bar', () => {
  const {View,art,parent}=feedbackViewHarness('TreeAppearance');
  const source=JSON.parse(JSON.stringify(require(projectPath('assets/resources/art/stages/config.json'))));
  const slot=source.treeSprites[0];
  source.treeSprites[0]={...slot,localScale:[.5,.6]};
  source.normal.skinScale=[1.6,1.6];
  art.catalog.stageTrees=source;
  const state={id:1,stageIndex:0,degree:0,alive:true,health:900,maxHealth:1000,position:{x:4,z:7}};
  const view=new View(art,state,parent,feedback.tree);
  close(view.sprite.scale.x,.8);close(view.sprite.scale.y,.96);
  close(view.bar.position.y,source.normal.healthBar.position[1]*.6);
  assert.equal(view.bar.scale.x,source.normal.healthBar.scale[0]);
  const fillBar=view.healthFillRoot.children[0].children[0].children[0];
  close(fillBar.position.y,view.bar.position.y);
  view.hit();view.update(0,state);view.update(.05,state);
  assert.equal(view.healthRoot.active,true);assert.equal(view.healthFillRoot.active,true);
  close(view.sprite.scale.x,.8);
  // Missing per-prop scaling preserves the original imported display size.
  delete source.treeSprites[0].localScale;
  const unscaled=new View(art,{...state,id:2},parent,feedback.tree);
  close(unscaled.sprite.scale.x,1.6);
  close(unscaled.bar.position.y,source.normal.healthBar.position[1]);
  source.treeSprites[3]={...source.treeSprites[3],localScale:[.55,.55]};
  const boss=new View(art,{...state,id:3,degree:3},parent,feedback.tree);
  const ambient=boss.node.children.find(n=>n.name==='PropAmbientScale');
  assert.ok(ambient);close(ambient.scale.x,.55);close(ambient.scale.y,.55);
  close(boss.bar.position.y,source.boss.healthBar.position[1]*.55);
});

test('accepted weak damage reveals a full tree health bar, while timeout hits and pool reuse do not', () => {
  const {View,art,parent}=feedbackViewHarness('TreeAppearance');
  const {CombatWorld,DecimalAmount:D}=require('./.build/core/index.js');
  const world=new CombatWorld(42),tree=world.trees[0];
  tree.health=tree.maxHealth=D.from(1700);tree.healthPrecision=2;
  const view=new View(art,tree,parent,feedback.tree);
  const dispatch=()=>{
    const events=world.drainEvents();
    for(const event of events)if(event.type==='hit')view.hit();
    view.update(.02,tree);
    return events;
  };
  assert.equal(view.healthRoot.active,false);
  world.hitTree(tree,tree.position,D.from(1));
  assert.equal(dispatch().filter(event=>event.type==='hit').length,1);
  assert.equal(tree.health.compare(tree.maxHealth),0,'the original p2 subtraction cannot retain this weak hit');
  assert.equal(view.healthRoot.active,true);assert.equal(view.healthFillRoot.active,true);
  close(view.fill.fillRange,1);
  view.update(2,tree);assert.equal(view.healthRoot.active,true,'the revealed bar outlives its hit bounce');
  view.reset(tree);assert.equal(view.healthRoot.active,false);assert.equal(view.healthFillRoot.active,false);
  world.stopCombat();world.hitTree(tree,tree.position,D.from(1));
  assert.equal(dispatch().filter(event=>event.type==='damageText').length,1);
  assert.equal(view.healthRoot.active,false,'is_Play=false emits a number but Enemy rejects the damage');
  world.startCombat();world.hitTree(tree,tree.position,D.from(1700));dispatch();
  assert.equal(tree.alive,false);assert.equal(view.healthRoot.active,false);assert.equal(view.healthFillRoot.active,false);
  tree.alive=true;tree.health=tree.maxHealth;view.reset(tree);
  assert.equal(view.healthRoot.active,false,'reusing the tree must not retain its old reveal state');
});

test('Boss uses stage skin, separate health transform, huge-number ratio and its looping ambient system', () => {
  const {View,art,parent,Sprite}=feedbackViewHarness('TreeAppearance');
  art.catalog.stageTrees=require(projectPath('assets/resources/art/stages/config.json'));
  const {DecimalAmount}=require('./.build/feedback/core/index.js');
  const tree={id:500,degree:3,stageIndex:12,alive:true,health:DecimalAmount.from('5e+5000'),
    maxHealth:DecimalAmount.from('1e+5001'),position:{x:0,z:282}};
  const view=new View(art,tree,parent,feedback.tree);
  assert.equal(view.sprite.getComponent(Sprite).spriteFrame,art.catalog.stageTrees.treeSprites[11].path);
  const propScale=art.catalog.stageTrees.treeSprites[11].localScale??[1,1];
  close(view.sprite.scale.x,2.5*propScale[0]);close(view.bar.position.y,16.55999947*propScale[1]);
  close(view.fill.fillRange,.5);
  view.hit();view.update(.05,tree);view.update(.05,tree);
  assert.notEqual(view.bounce.scale.x,1);close(view.healthBounce.scale.x,1);close(view.healthFillBounce.scale.x,1);
  const ambient=view.ambient;
  assert.ok(ambient.simulation.particles.some(p=>p.active));
  view.update(1.3,tree);
  assert.ok(ambient.simulation.particles.some(p=>p.active),'one-second loop continues emitting');
  tree.alive=false;view.update(.1,tree);assert.equal(view.node.active,false);
  tree.alive=true;view.reset(tree);assert.equal(ambient.simulation.particles.some(p=>p.active),false);
});

test('reticle node transform matches direct 3D quaternion projection at every sampled rotation', () => {
  const q = feedback.reticle.planeQuaternion;
  const decomposition = decomposeProjectedPlane(projectedSpritePlane(q));
  const rotate2 = (x, y, degrees) => {
    const angle = degrees * Math.PI / 180;
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
  };
  const rotate3 = (point, quaternion) => {
    const [x, y, z, w] = quaternion, [px, py, pz] = point;
    // Independent quaternion-vector product, rather than the view's matrix formula.
    const tx = 2 * (y * pz - z * py), ty = 2 * (z * px - x * pz), tz = 2 * (x * py - y * px);
    return [px + w * tx + y * tz - z * ty, py + w * ty + z * tx - x * tz,
      pz + w * tz + x * ty - y * tx];
  };
  for (let degrees = 0; degrees >= -720; degrees -= 15) {
    for (const [x, y] of [[1, 0], [0, 1], [-.73, .73], [.73, -.73]]) {
      const spun = rotate2(x, y, degrees);
      const world = rotate3([spun[0], spun[1], 0], q);
      const expected = [world[0] * camera.rightX + world[2] * camera.rightZ,
        world[0] * camera.upX + world[1] * camera.upY + world[2] * camera.upZ];
      const inner = rotate2(x, y, decomposition.inner + degrees);
      const actual = rotate2(inner[0] * decomposition.x, inner[1] * decomposition.y, decomposition.outer);
      close(actual[0], expected[0]); close(actual[1], expected[1]);
    }
  }
  assert.ok(Math.abs(decomposition.x - decomposition.y) > .05,
    'the original tilted target plane must not collapse to a plain screen-space circle');
});
