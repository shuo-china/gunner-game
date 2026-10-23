const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {projectPath}=require('./support/paths.cjs');
const math=require('./.build/feedback/view/WeaponGradeEffectSimulation.js');
const particleMath=require('./.build/feedback/view/OriginalParticleSimulation.js');
const {getWeaponIdsForGrade}=require('./.build/feedback/core/WeaponCatalog.js');
const {CAMERA_BASIS:C}=require('./.build/feedback/core/projection.js');
const source=require(projectPath('assets/resources/art/weapon-grade-effects/config.json'));

function harness(){
  class UITransform {setContentSize(width,height){this.width=width;this.height=height;}}
  class Sprite {updateMaterial(){}}
  class Node {
    constructor(name){this.name=name;this.active=true;this.isValid=true;this.children=[];this.parts=new Map([[UITransform,new UITransform],[Sprite,new Sprite]]);}
    getComponent(type){return this.parts.get(type);}
    setPosition(x,y,z){this.position={x,y,z};}
    destroy(){this.active=false;this.isValid=false;}
  }
  class Color {set(r,g,b,a){this.r=r;this.g=g;this.b=b;this.a=a;}}
  class SpriteFrame {reset(options){this.options=options;}destroy(){}}
  class Mesh {
    constructor(sprite,geometry){this.sprite=sprite;this.geometry=geometry;this.updates=0;}
    update(transform){this.transform=transform;this.updates++;}
    setTint(color){this.tint=Array.from(color);}
  }
  const imports={
    cc:{Node,Sprite,UITransform,Color,SpriteFrame,Rect:class {},Size:class {},gfx:{BlendFactor:{ONE:1,ZERO:0,SRC_ALPHA:5,ONE_MINUS_SRC_ALPHA:10}}},
    './ArtLibrary':{makeNode:(name,parent)=>{const node=new Node(name);parent.children.push(node);return node;}},
    './OriginalParticleMesh':{OriginalParticleMesh:Mesh},'./OriginalParticleSimulation':particleMath,
    './WeaponGradeEffectSimulation':math,'../core/projection':{CAMERA_BASIS:C},
  };
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(projectPath('assets/scripts/view/OriginalWeaponGradeEffects.ts'),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,
    {module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];}});
  const art={weaponVisuals:{config:{gradeEffects:source}},frames:new Map(Object.values(source.images).map(spec=>[spec.path,{texture:{}}])),
    image:(name,_spec,parent)=>{const node=new Node(name);parent.children.push(node);return node;}};
  const view=new module.exports.OriginalWeaponGradeEffects(art,new Node('root'));
  let seed=0x417d83;
  view.simulation.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  return view;
}

// Preserve the previous renderer's allocation-heavy formula as a numeric oracle.
// This fixture is local to the test and does not read an external checkout.
function referenceTrail(p,capacity,pose){
  const trail=p.spec.trail,points=[...p.trail,{x:p.x,y:p.y,z:p.z,age:p.age}];
  const lengths=[0];
  for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y,points[i].z-points[i-1].z));
  const total=lengths[lengths.length-1]||1,positions=[],uv=[],colors=[];
  for(let i=0;i<capacity;i++){
    const index=Math.min(i,points.length-1),at=points[index],previous=points[Math.max(0,index-1)],next=points[Math.min(points.length-1,index+1)];
    const dx=next.x-previous.x,dy=next.y-previous.y,dz=next.z-previous.z;
    const x=C.rightX*dx+C.rightZ*dz,y=C.upX*dx+C.upY*dy+C.upZ*dz,norm=Math.hypot(x,y)||1;
    const fraction=lengths[index]/total;
    const width=particleMath.evaluateParticleCurve(trail.width,1-fraction,p.random)*(trail.sizeAffectsWidth?pose.width:1)*.5;
    const nx=-y/norm*width,ny=x/norm*width;
    const world=[C.rightX*nx+C.upX*ny,C.upY*ny,C.rightZ*nx+C.upZ*ny];
    for(let side=0;side<2;side++){
      const sign=side===0?-1:1,color=trail.colorOverLifetime.maxColor,end=trail.colorOverTrail.maxColor;
      positions.push([at.x+world[0]*sign,at.y+world[1]*sign,at.z+world[2]*sign]);
      uv.push([fraction,side]);colors.push([color.r*end.r,color.g*end.g,color.b*end.b,color.a*end.a]);
    }
  }
  return {positions,uv,colors,active:points.length>1,tint:trail.inheritParticleColor?Array.from(pose.color):[1,1,1,1]};
}
const matrix=rows=>Array.from(rows,row=>Array.from(row));
function assertGeometry(slot,expected){
  assert.deepEqual(matrix(slot.geometry.positions),expected.positions);
  assert.deepEqual(matrix(slot.geometry.uv),expected.uv);
  assert.deepEqual(matrix(slot.geometry.colors),expected.colors);
  assert.equal(slot.node.active,expected.active);
  assert.deepEqual(slot.mesh.tint,expected.tint);
}

test('high grade ribbon geometry matches the previous formula exactly through movement, expiry and reuse',()=>{
  const view=harness();let compared=0;
  for(let grade=10;grade<13;grade++){
    view.setWeapon(getWeaponIdsForGrade(grade)[0]);
    for(let frame=0;frame<240;frame++){
      const dt=frame%41===0?0:frame%37===0?.09:1/60;
      view.update(dt,[Math.sin(frame*.09)*7,Math.cos(frame*.03)*.3,frame*.04]);
      for(const particle of view.simulation.particles)if(particle.active&&particle.spec.trail){
        const slot=view.views[particle.index],pose=view.simulation.pose(particle);
        assertGeometry(slot,referenceTrail(particle,slot.capacity,pose));compared++;
      }
    }
    view.reset();view.update(.2,[100,0,-100]);
    for(const particle of view.simulation.particles)if(particle.active&&particle.spec.trail){
      const slot=view.views[particle.index];assertGeometry(slot,referenceTrail(particle,slot.capacity,view.simulation.pose(particle)));
    }
  }
  assert.ok(compared>500,'exercise many actual frames of all three trail grades');
  view.destroy();
});

test('ribbons reuse fixed vertex, UV, color and distance buffers including empty and coincident trails',()=>{
  const view=harness();view.setWeapon(getWeaponIdsForGrade(10)[0]);view.update(.2,[0,0,0]);
  const particle=view.simulation.particles.find(p=>p.active&&p.spec.trail);
  assert.ok(particle);
  const slot=view.createView(particle,128),geometry=slot.geometry,lengths=slot.lengths;
  const positions=Array.from(geometry.positions),uv=Array.from(geometry.uv),colors=Array.from(geometry.colors),indices=geometry.indices;
  const pose={x:0,y:0,width:2.7,height:1,angle:0,color:[1.8,.3,.7,.4]};
  const originalSpec=particle.spec;
  for(const inheritParticleColor of [true,false])for(const sizeAffectsWidth of [true,false]){
    particle.spec={...originalSpec,trail:{...originalSpec.trail,inheritParticleColor,sizeAffectsWidth,
      colorOverLifetime:{maxColor:{r:1.8,g:.4,b:0,a:.6}},colorOverTrail:{maxColor:{r:.5,g:1.2,b:1,a:.7}}}};
    for(let frame=0;frame<120;frame++){
      const count=frame%4===0?0:frame%4===1?1:frame%4===2?73:127;
      particle.x=3;particle.y=-.5;particle.z=7;
      particle.trail=Array.from({length:count},(_,i)=>frame%3===0?{x:3,y:-.5,z:7,age:i*.01}:
        {x:Math.sin(i*.2+frame*.01),y:i*.03,z:Math.cos(i*.13)*5,age:i*.01});
      view.renderTrail(particle,slot,pose);
      assertGeometry(slot,referenceTrail(particle,slot.capacity,pose));
      assert.equal(slot.geometry,geometry);assert.equal(slot.lengths,lengths);assert.equal(geometry.indices,indices);
      assert.equal(lengths.length,128);
      for(let i=0;i<256;i++){
        assert.equal(geometry.positions[i],positions[i]);assert.equal(geometry.uv[i],uv[i]);assert.equal(geometry.colors[i],colors[i]);
      }
    }
  }
  assert.equal(slot.mesh.updates,480);slot.node.destroy();view.destroy();
});
