const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const crypto=require('node:crypto');
const {projectPath}=require('./support/paths.cjs');
const config=require('../assets/resources/art/hud/config.json');
const core=require('./.build/core/index.js');

function fixture(){
  class Events {
    events=new Map();
    on(name,fn,owner){const list=this.events.get(name)||[];list.push({fn,owner});this.events.set(name,list);}
    off(name,fn,owner){this.events.set(name,(this.events.get(name)||[]).filter(e=>e.fn!==fn||e.owner!==owner));}
    emit(name,event){for(const {fn,owner}of this.events.get(name)||[])fn.call(owner,event);}
  }
  class Vec3{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}}
  class UITransform{
    setContentSize(width,height){Object.assign(this,{width,height});}
    convertToNodeSpaceAR(point){const p=this.node.worldPosition,s=this.node.worldScale;return new Vec3((point.x-p.x)/s.x,(point.y-p.y)/s.y);}
  }
  class Node extends Events{
    static EventType={TOUCH_START:'start',TOUCH_MOVE:'move',TOUCH_END:'end',TOUCH_CANCEL:'cancel'};
    constructor(name){super();Object.assign(this,{name,children:[],components:new Map(),position:new Vec3(),scale:new Vec3(1,1,1),active:true,isValid:true});}
    addChild(node){node.parent=this;this.children.push(node);}
    addComponent(T){const c=new T();c.node=this;this.components.set(T,c);return c;}
    getComponent(T){return this.components.get(T);}
    setPosition(x,y,z){this.position=new Vec3(x,y,z);}
    setScale(x,y,z){this.scale=new Vec3(x,y,z);}
    get worldScale(){const p=this.parent?.worldScale||new Vec3(1,1,1);return new Vec3(this.scale.x*p.x,this.scale.y*p.y,1);}
    get worldPosition(){const p=this.parent?.worldPosition||new Vec3(),s=this.parent?.worldScale||new Vec3(1,1,1);return new Vec3(p.x+this.position.x*s.x,p.y+this.position.y*s.y);}
    setSiblingIndex(i){const a=this.parent.children;a.splice(a.indexOf(this),1);a.splice(i,0,this);}
    destroy(){this.isValid=false;this.active=false;this.events.clear();}
  }
  const makeNode=(name,parent)=>{const n=new Node(name);n.addComponent(UITransform);parent?.addChild(n);return n;};
  const input=new Events(),browser=new Events();
  browser.addEventListener=browser.on.bind(browser);browser.removeEventListener=browser.off.bind(browser);
  const cc={Node,UITransform,Vec3,input,Input:{EventType:Node.EventType}};
  const art={image(name,spec,parent){const n=makeNode(name,parent);n.getComponent(UITransform).setContentSize(...spec.sizeUnits);n.spec=spec;return n;}};
  function load(file,imports){const module={exports:{}};const source=fs.readFileSync(projectPath('assets/scripts/view',file+'.ts'),'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,
      {module,exports:module.exports,window:browser,require:name=>{assert.ok(name in imports,name);return imports[name];}});return module.exports;}
  const joystickModule=load('FloatingJoystick',{cc,'./ArtLibrary':{makeNode},'../core/ManualMovement':core});
  class Transition{constructor(parent){this.node=makeNode('Transition',parent);}resize(){}update(){}showExternalLoading(){}destroy(){this.node.destroy();}}
  const {GameHud}=load('GameHud',{cc,'./ArtLibrary':{makeNode},'./FloatingJoystick':joystickModule,
    './HudMath':{usesStageHud:()=>false},'./UpgradeHud':{},'./OriginalStageTransition':{OriginalStageTransition:Transition},
    './FontPolicyLabel':require('./support/font-policy-handle.cjs')});
  const world=new core.CombatWorld(42),samples=[];
  const hud=new GameHud(makeNode('Canvas'),art,{config},()=>{},()=>false,undefined,()=>{},(direction,cancelled)=>{
    samples.push({x:direction.x,y:direction.y,cancelled});if(cancelled)world.clearMovementInput();else world.setMovementInput(direction);
  });
  const joystick=hud.joystick,node=joystick.node;
  const state={mode:'Boss',paused:false,phase:'playing'};hud.update(state);
  function event(id,x=0,y=0){return {getID:()=>id,getUILocation:()=>({x,y}),propagationStopped:false};}
  const send=(type,id,x=0,y=0)=>node.emit(type,event(id,x,y));
  return {hud,joystick,node,world,samples,state,send,input,browser,event,UITransform};
}

test('original joystick sprites, geometry and serialized input settings are fixed',()=>{
  assert.equal(config.referenceWidth,1080);
  assert.deepEqual(config.images.joystick_background.sizeUnits,[256,256]);
  assert.deepEqual(config.images.joystick_handle.sizeUnits,[128,128]);
  assert.equal(config.joystick.handleRange,1);assert.equal(config.joystick.deadZone,0);
  assert.equal(config.joystick.axisOptions,0);assert.equal(config.joystick.snapX,false);assert.equal(config.joystick.snapY,false);
  for(const key of ['joystick_background','joystick_handle']){
    const image=config.images[key],bytes=fs.readFileSync(projectPath('assets/resources',image.path+'.png'));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),image.sourceSha256);
  }
});

for(const [width,height,top,bottom]of [[720,1280,0,0],[720,1600,44,24],[1080,1920,100,60]]){
  test(`floating origin and analog travel use original scale at ${width}x${height} with safe area`,()=>{
    const h=fixture();h.hud.resize(width,height,top,bottom);h.hud.update(h.state);
    const scale=width/1080;
    assert.equal(h.joystick.background.active,false);
    h.send('start',7,50,-100);assert.equal(h.joystick.background.active,true);
    const p=h.joystick.background.worldPosition;assert.equal(p.x,50);assert.equal(p.y,-100);
    h.send('move',7,50+64*scale,-100);assert.equal(h.world.currentMovementInput.x,.5);
    assert.equal(h.joystick.handle.position.x,64);
    h.send('move',7,50+300*scale,-100+400*scale);
    assert.ok(Math.abs(h.world.currentMovementInput.x-.6)<1e-12);assert.ok(Math.abs(h.world.currentMovementInput.y-.8)<1e-12);
    assert.equal(h.joystick.background.worldPosition.x,p.x);assert.equal(h.joystick.background.worldPosition.y,p.y);
    h.send('end',7);assert.equal(h.joystick.background.active,false);assert.deepEqual(h.world.currentMovementInput,{x:0,y:0});
    assert.equal(h.samples.at(-1).cancelled,false);
  });
}

test('second finger cannot steal the joystick or release the first finger',()=>{
  const h=fixture();h.send('start',1);h.send('move',1,64,0);const p={...h.world.currentMovementInput};
  h.send('start',2,400,400);h.send('move',2,-50,30);h.input.emit('end',h.event(2));
  assert.deepEqual(h.world.currentMovementInput,p);assert.equal(h.joystick.background.active,true);
  h.input.emit('end',h.event(1));assert.equal(h.joystick.background.active,false);
});

for(const [name,action]of [
  ['modal',h=>h.hud.setModalOpen(true)],['loading',h=>h.hud.setLoadingOverlay(0)],
  ['pause',h=>h.hud.update({...h.state,paused:true})],['resize',h=>h.hud.resize(720,1500,44,24)],
  ['background or round change',h=>h.hud.cancelInteractions()],['blur',h=>h.browser.emit('blur')],
  ['external mouse release',h=>h.browser.emit('mouseup',{button:0,target:{}})],
  ['touch cancellation',h=>h.input.emit('cancel',h.event(1))],['destroy',h=>h.hud.destroy()],
])test(`${name} clears captured input and velocity; stale movement cannot resume it`,()=>{
  const h=fixture();h.send('start',1);h.send('move',1,64,0);h.world.step(.01);assert.ok(h.world.player.moving);
  action(h);assert.deepEqual(h.world.currentMovementInput,{x:0,y:0});assert.deepEqual(h.world.player.velocity,{x:0,z:0});
  h.send('move',1,200,0);assert.deepEqual(h.world.currentMovementInput,{x:0,y:0});
});

test('HUD toggling re-enables only fresh touches and keeps joystick below transition nodes',()=>{
  const h=fixture();assert.equal(h.hud.node.children[0],h.node);
  h.hud.setModalOpen(true);h.send('start',1);assert.equal(h.joystick.background.active,false);
  h.hud.setModalOpen(false);h.hud.update(h.state);h.send('move',1,100,0);assert.deepEqual(h.world.currentMovementInput,{x:0,y:0});
  h.send('start',2);assert.equal(h.joystick.background.active,true);
  h.hud.setLoadingOverlay(1);h.hud.setLoadingOverlay(null);h.hud.update(h.state);
  assert.equal(h.hud.node.children[0],h.node);
});

test('input subscriptions are released on destruction',()=>{
  const h=fixture();h.hud.destroy();const count=h.samples.length;
  h.input.emit('end',h.event(1));h.browser.emit('blur');h.hud.destroy();assert.equal(h.samples.length,count);
  assert.ok([...h.input.events.values(),...h.browser.events.values()].every(list=>list.length===0));
});
