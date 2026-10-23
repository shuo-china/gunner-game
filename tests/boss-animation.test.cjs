const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const config=require('../assets/resources/art/boss-system/visuals.json');
function modules(extra={}) {
 const all={...extra};for(const name of ['OriginalCatAnimation','BossAnimation']){
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../assets/scripts/view',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,{module,exports:module.exports,require:id=>all[id]});all['./'+name]=module.exports;
 }return all;
}
test('Nine original skins retain all limbs, readable frames and all four exact clips',()=>{
 assert.deepEqual(config.skins.map(x=>x.name),['BlackDragon','EmeraldDragon','GoldenDragon','GreenDragon','GreyDragon','IceDragon','MechanicalDragon','PurpleDragon','RedDragon']);
 for(const skin of config.skins){
  assert.equal(skin.parts.length,9);assert.ok(skin.bones.every(b=>!b.parent||skin.bones.some(p=>p.path===b.parent)));
  for(const part of skin.parts)assert.ok(fs.existsSync(path.join(__dirname,'../assets/resources',part.image.path+'.png')));
  assert.ok(skin.idleHead.path!==skin.deadHead.path);
 }
 assert.equal(config.clips.idle.duration,1.5);assert.equal(config.clips.walk.duration,.5);
 assert.equal(config.clips.death.duration,Math.fround(2/3));assert.equal(config.clips.attack.duration,.5);
 const bindings=config.clips.walk.bindings.filter(b=>b.property==='position'&&b.bone.includes('LegFront'));
 assert.equal(bindings.length,2);assert.ok(bindings.every(b=>config.clips.walk.channels[b.firstChannel].length===1));
});
test('All dragon bone samples stay finite over original loops and death; constants do not vanish',()=>{
 const {sampleBossBone}=modules()['./BossAnimation'];
 for(const skin of config.skins)for(const clip of Object.values(config.clips))for(const bone of skin.bones)for(const time of [0,.125,.3,.7,2,100]){
  const pose=sampleBossBone(clip,time,bone);assert.ok(Object.values(pose).every(Number.isFinite),skin.name+bone.path);
 }
 const bone=config.skins[0].bones.find(b=>b.path==='Body/LegFrontL');
 assert.equal(sampleBossBone(config.clips.walk,.1,bone).y,-1.25);
});
test('Boss transitions blend for a quarter second, preserving corpse animation at final frame',()=>{
 const {BossAnimator,sampleBossBone}=modules()['./BossAnimation'],a=new BossAnimator(config.clips,.25),bone=config.skins[0].bones.find(b=>b.path==='Body');
 a.update(.4,false,true);const before=a.pose(bone);a.update(0,true,true);
 assert.equal(a.state,'walk');assert.deepEqual(a.pose(bone),before);
 a.update(.25,true,true);assert.equal(a.previous,null);
 a.update(0,false,false);assert.equal(a.state,'death');a.update(4,false,false);
 assert.deepEqual(a.pose(bone),sampleBossBone(config.clips.death,config.clips.death.duration,bone));
});
test('Boss keeps nine dragon parts inside one Default0 group, retaining facing, hit bounce and corpse',()=>{
 class Node{constructor(name){this.name=name;this.active=true;this.isValid=true;this.children=[];this.scale={x:1,y:1};this.position={x:0,y:0};this.components=new Map();}setPosition(x,y){this.position={x,y};}setScale(x,y){this.scale={x,y};}setSiblingIndex(index){const children=this.parent.children;children.splice(children.indexOf(this),1);children.splice(index,0,this);}getComponent(c){return this.components.get(c);}destroy(){this.isValid=false;}}
 class Sprite{};class UITransform{setContentSize(...size){this.size=size;}setAnchorPoint(...anchor){this.anchor=anchor;}}
 const makeNode=(name,parent)=>{const n=new Node(name);n.parent=parent;parent?.children.push(n);return n;};
 const projectWorld=({x,z},h=0)=>({x:.7071067796452598*x+.7071068328480861*z,y:-.4082444121793012*x+.4082444440367463*z+.8165004704498066*h});
 const CAMERA_BASIS={forwardX:-.5773530748033027,forwardY:-.5773448069936156,forwardZ:.5773530143110772};
 const all=modules({'cc':{Node,Sprite,UITransform},'./ArtLibrary':{makeNode},'../core/projection':{projectWorld,CAMERA_BASIS}}),module={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../assets/scripts/view/BossView.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,{module,exports:module.exports,require:id=>all[id]});
 const layers=new Map(),layer=order=>{if(!layers.has(order))layers.set(order,new Node('Default'+order));return layers.get(order);};
 const frames=new Map(),walk=v=>{if(v&&typeof v==='object'){if(v.path)frames.set(v.path,{path:v.path});Object.values(v).forEach(walk);}};walk(config);
 const art={catalog:{boss:config},frames,image(name,spec,parent){const n=makeNode(name,parent),sp=new Sprite(),tr=new UITransform();sp.spriteFrame=frames.get(spec.path);n.components.set(Sprite,sp);n.components.set(UITransform,tr);return n;}};
 const default0=layer(0),shadowLayer=new Node('ShadowLayer');
 const state={position:{x:-115,z:15},alive:true,stageIndex:0,facing:-1,moving:false},view=new module.exports.BossView(art,state,default0,shadowLayer,layer);
 assert.deepEqual([...layers.keys()],[0], 'No dragon limb allocates a global projectile layer');
 assert.equal(default0.children.length,1);assert.equal(view.node.parent,default0);
 assert.deepEqual(view.node.children.map(n=>Number(n.name.match(/GroupOrder(\d+)/)[1])),[0,5,10,20,25]);
 const plane=view.node.children.find(n=>n.name.endsWith('GroupOrder25'));assert.ok(Math.abs(plane.angle)<.001);assert.ok(plane.scale.x>0&&plane.scale.y>0);
 assert.deepEqual(config.skins[0].idleHead.boundsCenter,[.10390621423721313,.5165433287620544,0]);
 assert.deepEqual(plane.children.map(n=>n.name),['Body/Head','Body/WingL','Body/LegBackL','Body/LegFrontL']);
 view.update(.5,state);
 assert.deepEqual(plane.children.map(n=>n.name),['Body/WingL','Body/Head','Body/LegBackL','Body/LegFrontL']);
 view.update(.9,state);
 assert.deepEqual(plane.children.map(n=>n.name),['Body/Head','Body/WingL','Body/LegBackL','Body/LegFrontL']);
 const head=plane.children.find(n=>n.name==='Body/Head');assert.equal(head.getComponent(Sprite).spriteFrame.path,config.skins[0].idleHead.path);
 const normalY=view.node.position.y;view.hit();view.update(0,state);view.update(.1,state);assert.notEqual(view.node.position.y,normalY);
 state.facing=1;view.update(.3,state);assert.ok(Math.abs(Math.abs(plane.angle)-180)<.001);assert.ok(plane.scale.y<0);
 state.alive=false;state.moving=false;view.update(1,state);assert.equal(view.node.active,true);assert.equal(head.getComponent(Sprite).spriteFrame.path,config.skins[0].deadHead.path);
 view.setActive(false);assert.equal(view.node.active,false);assert.equal(shadowLayer.children[0].active,false);
 view.destroy();assert.equal(view.node.isValid,false);assert.ok(view.node.children.every(p=>!p.isValid));
 for(let skin=0;skin<9;skin++){
  const boss={position:{x:0,z:0},alive:true,stageIndex:skin,facing:-1,moving:true};
  const v=new module.exports.BossView(art,boss,default0,shadowLayer,layer);
  assert.deepEqual(v.node.children.map(n=>Number(n.name.match(/GroupOrder(\d+)/)[1])),[0,5,10,20,25]);
  const before=v.sortingDepth,at={...v.node.position};boss.position={x:4,z:-3};v.update(0,boss);
  assert.ok(Math.abs(v.sortingDepth-before-(4*CAMERA_BASIS.forwardX-3*CAMERA_BASIS.forwardZ))<1e-12);
  const shift=projectWorld(boss.position);assert.ok(Math.abs(v.node.position.x-at.x-shift.x)<1e-12);assert.ok(Math.abs(v.node.position.y-at.y-shift.y)<1e-12);
  assert.ok(Number.isFinite(v.sortingDepth));assert.deepEqual([...layers.keys()],[0]);v.destroy();
 }
});
