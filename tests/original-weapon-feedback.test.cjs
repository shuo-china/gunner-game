const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript');
const root=path.resolve(__dirname, '..'),config=require(path.join(root,'assets/resources/art/weapon-system/config.json'));
class Vec3{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new Vec3(this.x,this.y,this.z);}}
class Node{
  active=true;parent=null;scale=new Vec3(1,1,1);worldPosition=new Vec3();worldScale=new Vec3(1,1,1);
  setScale(x,y,z){this.scale=new Vec3(x,y,z);}setWorldPosition(x,y,z){this.worldPosition=typeof x==='object'?x.clone():new Vec3(x,y,z);}
}
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'assets/scripts/view/OriginalWeaponFeedback.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
  {module:mod,exports:mod.exports,require:key=>{assert.equal(key,'cc');return{Node,Vec3};}});
const {OriginalWeaponFeedback}=mod.exports;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);

test('all exported button effects and tutorial timings come from the original enabled components',()=>{
  assert.equal(Object.values(config.nodes).filter(n=>n.bounceButton).length,20 + config.gunIcons.length);
  assert.equal(Object.values(config.nodes).filter(n=>n.clickSound!==undefined).length,13 + config.gunIcons.length);
  assert.equal(config.nodes['level0:624'].clickSound,1);
  assert.equal(config.nodes['level0:8964'].image.raycast,true);assert.equal(config.nodes['level0:19309'].image.raycast,false);
  const c=config.mergeTutorial;assert.equal(c.node,'level0:730');near(c.moveDuration,1.2);near(c.pauseAtTarget,.15);near(c.scaleDuration,.15);near(c.scaleSmall,.8);
  assert.equal(config.nodes[c.root].active,true);assert.equal(config.nodes[c.node].active,false);
});

test('original button press/release are linear, preserve nonunit scale, and a short press releases from compressed scale',()=>{
  const f=new OriginalWeaponFeedback(),node=new Node(),spec=config.nodes['level0:802'];node.setScale(1.2,.8,1);
  const c=spec.bounceButton;f.press(node,spec);f.update(c.duration*.25);
  near(node.scale.x,1.2*(1+(c.scale-1)*.25));
  f.release(node);f.update(c.duration*.25);near(node.scale.x,1.2*(c.scale+(1-c.scale)*.25));
  f.update(c.duration);near(node.scale.x,1.2);near(node.scale.y,.8);
  f.press(node,spec);f.update(c.duration*2);near(node.scale.x,1.2*c.scale);
  f.cancelButton(node);near(node.scale.x,1.2);
  f.press(node,spec);f.update(c.duration);const parent=new Node();node.parent=parent;parent.active=false;
  f.update(0);near(node.scale.x,1.2);parent.active=true;f.update(c.duration);near(node.scale.x,1.2);
});

test('tutorial follows source shrink, fixed-start/live-target SmoothStep movement, release, pause and snap loop',()=>{
  const c=config.mergeTutorial,arrow=new Node(),from=new Node(),to=new Node(),f=new OriginalWeaponFeedback(c,arrow);
  from.setWorldPosition(10,20,0);to.setWorldPosition(110,20,0);f.setTutorialTargets(from,to);
  assert.equal(arrow.active,true);near(arrow.worldPosition.x,10);
  f.update(c.scaleDuration/2);near(arrow.scale.x,.9);f.update(c.scaleDuration/2);near(arrow.scale.x,.8);
  from.setWorldPosition(-100,20,0);to.setWorldPosition(210,20,0);
  f.update(c.moveDuration/4);near(arrow.worldPosition.x,41.25);near(arrow.scale.x,.8);
  to.setWorldPosition(310,20,0);f.update(c.moveDuration/4);near(arrow.worldPosition.x,160);
  f.update(c.moveDuration/2);near(arrow.worldPosition.x,310);
  f.update(c.scaleDuration);near(arrow.scale.x,1);near(arrow.worldPosition.x,310);
  f.update(c.pauseAtTarget*.99);near(arrow.worldPosition.x,310);
  f.update(c.pauseAtTarget*.01+1e-8);near(arrow.worldPosition.x,-100);
  to.active=false;f.update(.01);assert.equal(arrow.active,false);
  to.active=true;f.setTutorialTargets(from,to);f.update(.05);f.clear();assert.equal(arrow.active,false);near(arrow.scale.x,1);
});


test('motion activity includes release until its final frame and clears after cancellation', () => {
  const f = new OriginalWeaponFeedback(), node = new Node(), spec = config.nodes['level0:802'];
  assert.equal(f.hasActiveMotion, false);
  f.press(node, spec); f.update(spec.bounceButton.duration); assert.equal(f.hasActiveMotion, true);
  f.release(node); assert.equal(f.hasActiveMotion, true);
  f.update(spec.bounceButton.duration); assert.equal(f.hasActiveMotion, false); near(node.scale.x, 1);
  f.press(node, spec); f.clear(); assert.equal(f.hasActiveMotion, false);
});
