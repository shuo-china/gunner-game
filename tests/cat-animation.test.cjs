const { fixturePath } = require('./support/paths.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const animationMath = require('./.build/character/OriginalCatAnimation.js');
const { OriginalCatAnimator, sampleCatPose, catRecoilWeight, catAngleDelta, originalBulletSpawnOffset, CAT_DIRECTION_SQUARED_THRESHOLD } = animationMath;
const root = path.resolve(__dirname, '..');
const rig = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/art/characters/cat_basic/rig.json'), 'utf8'));
// Frozen alpha/ray intersection from the original hand.png, transformed into HandR coordinates.
const gloveHandBase = [-0.33605452920024226, -0.0690003];
const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const player = () => new OriginalCatAnimator(rig.animations, rig.dynamics.animator);

test('Cat runtime uses source streamed coefficients at off-grid times, including loop seam', () => {
  for (const clip of Object.values(rig.animations)) {
    const source = JSON.parse(fs.readFileSync(fixturePath('characters/cat_basic', path.basename(clip.sourceCurveData)), 'utf8'));
    assert.deepEqual(clip.cubicCurves.bindings, source.bindings);
    assert.deepEqual(clip.cubicCurves.channels, source.channels);
    assert.equal(clip.cubicCurves.loopBlend, false);
    for (const clock of [0, .0173, .33333335, .517, 1.997, 2.0173, 21.2345]) {
      const time = clock % clip.duration;
      for (const binding of source.bindings) {
        const pose = sampleCatPose(clip, clock, binding.bone);
        for (const component of binding.property === 'euler' ? [2] : [0, 1]) {
          const keys = source.channels[binding.firstChannel + component];
          const key = keys.filter(k => k.time <= time).at(-1);
          const [a, b, c, d] = key.coefficients, t = time - key.time;
          const expected = a * t ** 3 + b * t ** 2 + c * t + d;
          const actual = binding.property === 'euler' ? pose.r : (binding.property === 'position' ? pose.p : pose.s)[component];
          close(actual, expected);
        }
      }
    }
  }
});

test('Cat sampling reuses caller pose buffers through clips, transitions and reset without aliasing snapshots', () => {
  const out={p:[0,0],r:0,s:[1,1]},position=out.p,scale=out.s;
  for (const clip of Object.values(rig.animations)) {
    const baked={...clip,cubicCurves:undefined};
    for (const source of [clip,baked]) for (const clock of [0,.0173,.517,1.997,2.0173]) {
      for (let bone=0;bone<rig.bones.length;bone++) {
        const snapshot=sampleCatPose(source,clock,bone), saved=structuredClone(snapshot);
        assert.equal(sampleCatPose(source,clock,bone,out),out);
        assert.equal(out.p,position);assert.equal(out.s,scale);
        assert.deepEqual(out,snapshot);
        sampleCatPose(source,clock+.08,(bone+1)%rig.bones.length,out);
        assert.deepEqual(snapshot,saved,'allocating API keeps independent snapshots');
      }
    }
  }
  const animator=player();
  for (const [dt,walk] of [[.1,true],[.15,true],[.07,false],[.18,false],[.5,false]]) {
    animator.update(dt,walk);
    for(let bone=0;bone<rig.bones.length;bone++) {
      const snapshot=animator.pose(bone),saved=structuredClone(snapshot);
      assert.equal(animator.pose(bone,out),out);assert.deepEqual(out,snapshot);
      assert.equal(out.p,position);assert.equal(out.s,scale);
      animator.pose((bone+1)%rig.bones.length,out);
      assert.deepEqual(snapshot,saved,'outgoing blend scratch cannot escape to returned poses');
    }
  }
  animator.reset();animator.pose(0,out);
  assert.deepEqual(out,sampleCatPose(rig.animations.idle,0,0));
});

test('Walk stop uses a quarter second blend while the outgoing feet continue at 1.5 speed', () => {
  const animator = player();
  animator.update(.25, true);
  animator.update(.42, true);
  const phaseBeforeStop = animator.clock;
  animator.update(.125, false);
  assert.equal(animator.animation, 'idle');
  assert.equal(animator.previousAnimation, 'walk');
  close(animator.clock, .125);
  close(animator.previousClock, phaseBeforeStop + .125 * 1.5);
  const foot = animator.pose(3), old = sampleCatPose(rig.animations.walk, animator.previousClock, 3);
  const idle = sampleCatPose(rig.animations.idle, .125, 3);
  close(foot.p[0], (old.p[0] + idle.p[0]) / 2);
  close(foot.p[1], (old.p[1] + idle.p[1]) / 2);
  animator.update(.125, false);
  assert.equal(animator.previousAnimation, null);
  const settled = animator.pose(3);
  animator.update(.77, false);
  assert.deepEqual(animator.pose(3), settled, 'Idle does not keep a residual walking foot curve');
});

test('Cat transition cannot be interrupted and a later walk starts at zero phase', () => {
  const animator = player();
  animator.update(.1, true);
  animator.update(.1, false);
  assert.equal(animator.animation, 'walk');
  assert.equal(animator.previousAnimation, 'idle');
  close(animator.clock, .3);
  animator.update(.05, false);
  animator.update(0, false);
  assert.equal(animator.animation, 'idle');
  assert.equal(animator.previousAnimation, 'walk');
  close(animator.clock, 0);
  animator.update(.25, false);
  animator.update(.8, false);
  animator.update(0, true);
  close(animator.clock, 0);
  animator.reset();
  assert.equal(animator.animation, 'idle');
  assert.equal(animator.previousAnimation, null);
  close(animator.clock, 0);
});

test('Cat animation fixed duration is independent of walk speed and update frequency', () => {
  for (const hz of [30, 60, 120]) {
    const animator = player();
    animator.update(1, true);
    for (let i = 0; i < Math.ceil(.25 * hz); i++) animator.update(1 / hz, false);
    // Decimal frame steps may leave the exact boundary one floating-point ulp short.
    animator.update(1e-12, false);
    assert.equal(animator.previousAnimation, null);
  }
});

test('Source recoil is linear over two 0.1 second legs and returns to its exact rest', () => {
  const duration = rig.dynamics.recoil.duration;
  for (const [fraction, expected] of [[0, 0], [.25, .5], [.5, 1], [.75, .5], [1, 0], [2, 0]]) {
    close(catRecoilWeight(duration * fraction, duration), expected);
  }
  close(catRecoilWeight(Infinity, duration), 0);
  close(CAT_DIRECTION_SQUARED_THRESHOLD, Math.fround(.0001), 0);
});

test('Battlefield runs procedural Update before Attack and post-Update animation/effects once', () => {
  const ts = require('typescript');
  const core = require('./.build/core/index.js');
  const source = fs.readFileSync(path.join(root, 'assets/scripts/view/BattlefieldView.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } }).outputText;
  const moduleObject = { exports: {} };
  vm.runInNewContext(js, { exports: moduleObject.exports, require: name => name === '../core' ? core : {} });
  const battlefield = Object.create(moduleObject.exports.BattlefieldView.prototype);
  const world = new core.CombatWorld(42), position = { x: 2, z: 10 };
  world.trees.splice(0, world.trees.length, { id: 1000, position, health: 1e6, maxHealth: 1e6,
    degree: 0, alive: true, collider: core.treeCollider(position) });
  world.stats.totalTrees = 1;
  const noop = () => {}, operations = [];
  let poseCount = 0, poseTime = 0, effectTime = 0, sampledOffset = 0, shots = 0;
  Object.assign(battlefield, {
    pets: new Map(), retiredMineViews: [],
    // This fixture verifies Update/Attack sequencing; actual render-group
    // hierarchy and camera-depth sorting are covered by render-order.test.cjs.
    sortRenderGroups: noop,
    world, aspect: 9 / 16, node: { setPosition: noop }, shadowOffset: { x: 0, y: 0 },
    impactTimeOffset: 0, lastImpactSourceTime: 0, impactFx: { beginFrame: noop, canSpawn: () => true },
    map: { cameraCenter: () => ({ x: 0, y: 0 }), updateCamera: noop },
    trees: new Map([[1000, { update: noop, hit: noop }]]),
    target: { update: noop }, projectiles: { update: noop, shot: noop, hit: noop }, numbers: { update: noop, spawn: noop },
    moneyBurst: { update: noop },
    art: {},
    cat: {
      node: { setPosition: noop }, shadow: { setPosition: noop }, setAimTarget: noop, setWeapon: noop,
      setFacing: () => { operations.push('facing'); },
      update: () => assert.fail('legacy update must not advance the character again'),
      updatePose: dt => { poseCount++; poseTime += dt; sampledOffset = 1 + poseCount * .01; operations.push('pose'); },
      getMuzzleProjectionOffset: () => core.projectWorld({ x: sampledOffset, z: 0 }, core.WEAPON_CONFIG.bulletHeight),
      getBulletSpawnOffset: height => { assert.equal(height, core.WEAPON_CONFIG.bulletHeight); return { x: sampledOffset, z: 0 }; },
      fire: () => { operations.push('fire'); },
      updateEffects: dt => { effectTime += dt; operations.push('effects'); },
    },
  });
  battlefield.cats = new Map([[0,battlefield.cat]]);
  world.setMuzzleProvider(context => battlefield.prepareCatPose(context));
  for (let frame = 0; frame < 90; frame++) {
    operations.length = 0;
    world.step(1 / 60);
    const events = world.drainEvents();
    for (const event of events) if (event.type === 'shot') {
      shots++;
      close(event.position.x - world.player.position.x, sampledOffset);
      close(event.position.z - world.player.position.z, 0);
    }
    battlefield.handleEvents(events, []);
    battlefield.update(1 / 60);
    assert.equal(operations[0], 'pose');
    assert.equal(operations.at(-1), 'effects');
    assert.equal(operations.filter(x => x === 'pose').length, 1);
    assert.equal(operations.filter(x => x === 'effects').length, 1);
  }
  assert.ok(shots > 0);
  assert.equal(poseCount, 90);
  close(poseTime, 1.5); close(effectTime, 1.5);
});

function proceduralCat() {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, 'assets/scripts/view/CatView.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } }).outputText;
  const moduleObject = { exports: {} };
  vm.runInNewContext(js, { exports: moduleObject.exports, require: name => name === './OriginalCatAnimation' ? animationMath :
    name === './WeaponAttackAnimation' ? require('./.build/character/WeaponAttackAnimation.js') :
    name === '../core/WeaponCatalog' ? require('./.build/core/WeaponCatalog.js') :
    name === '../core/projection' ? require('./.build/core/projection.js') : {} });
  const cat = Object.create(moduleObject.exports.CatView.prototype);
  const transform = () => ({ position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
    setPosition(x, y) { this.position = { x, y }; }, setScale(x, y) { this.scale = { x, y }; } });
  Object.assign(cat, { rig, dynamics: rig.dynamics, animator: player(),
    poses: rig.bones.map((_, i) => sampleCatPose(rig.animations.idle, 0, i)),
    node: transform(), shadow: transform(), body: transform(), face: transform(), gunPivot: transform(), gunBounce: transform(), hands: [],
    gunPosition: rig.attachments.gun.localPosition, recoil: Infinity, recoilJustStarted: false, walking: false,
    aimAngle: 130, faceAngle: 90, targetOffset: null, bodyMirror: 1,
    setBone() {}, muzzleEmitterPose: () => ({}), muzzleEffect: { update() {}, fire() {}, reset() {} },
    gradeEffects: { setWeapon() {}, update() {}, setActive() {}, reset() {}, destroy() {} },
  });
  cat.gunPivot.setPosition(...cat.gunPosition);
  return cat;
}

function rootParentPoint(cat,point) {
  const root=cat.poses[0],angle=root.r*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  return [root.p[0]+c*point[0]*root.s[0]-s*point[1]*root.s[1],
    root.p[1]+s*point[0]*root.s[0]+c*point[1]*root.s[1]];
}

function drawingPalm(cat,rest=false) {
  if(rest)return cat.bowDrawingStart();
  const pose=cat.poses[rig.dynamics.leftHandBone];
  const p=pose.p,a=pose.r*Math.PI/180;
  const center=cat.supportPalmCenter??rig.parts.find(part=>part.id==='hand_left').localPosition;
  return [p[0]+Math.cos(a)*center[0]*pose.s[0]-Math.sin(a)*center[1]*pose.s[1],
    p[1]+Math.sin(a)*center[0]*pose.s[0]+Math.cos(a)*center[1]*pose.s[1]];
}

function drawingOffset(cat) {
  const palm=drawingPalm(cat),start=cat.bowDrawingStart();
  return [palm[0]-start[0],palm[1]-start[1]];
}

function assertBowBodyCenter(cat,pivot=cat.bowRotationPivot()) {
  const body=rootParentPoint(cat,cat.skinBodyCenter??rig.parts.find(part=>part.id==='body').localPosition);
  const before=rootParentPoint(cat,[2.60,0]),actual=rootParentPoint(cat,pivot);
  close(actual[0],body[0]+.16);close(actual[1],before[1]+.22+.20);
  // Facing mirrors both body and orbit center through the same parent.
  close(actual[0]*cat.bodyMirror,(body[0]+.16)*cat.bodyMirror);
}

test('bow tuning clamps invalid input and stays isolated to the preview instance',()=>{
  const preview=proceduralCat(),battle=proceduralCat(),defaults={...battle.getBowPoseTuning()};
  preview.setBowPoseTuning({pivotX:Infinity,pivotY:20,drawDistanceScale:-1,drawHandAngle:'90',unknown:5});
  const settings=preview.getBowPoseTuning();
  close(settings.pivotX,defaults.pivotX);close(settings.pivotY,5);close(settings.drawDistanceScale,0);
  close(settings.drawHandAngle,defaults.drawHandAngle);assert.equal(settings.unknown,undefined);
  settings.pivotY=-3;close(preview.getBowPoseTuning().pivotY,5);
  assert.deepEqual({...battle.getBowPoseTuning()},defaults);
  preview.setBowPoseTuning();assert.deepEqual({...preview.getBowPoseTuning()},defaults);
});

test('custom bow tuning keeps the drawing start fixed while aiming and preserves it through walking',()=>{
  const appearance=require('../assets/resources/art/weapon-system/visuals.json').weapons.find(weapon=>weapon.bowString);
  const {WeaponAttackAnimator}=require('./.build/character/WeaponAttackAnimation.js');
  const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
  cat.weaponAppearance=appearance;cat.bowStringDefinition=appearance.bowString;
  cat.bowStringNode={active:false};cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
  const settings={pivotX:.7,pivotY:-.3,holdingRadiusScale:1.2,drawHandX:.45,drawHandY:.6,drawDistanceScale:0,drawHandAngle:20};
  for(const facing of [-1,1])for(const moving of [false,true])for(const angle of [0,60,180,270]) {
    cat.setBowPoseTuning({pivotX:0,pivotY:0});cat.updateEffects(.031);
    const original=rootParentPoint(cat,cat.bowRotationPivot());
    cat.setBowPoseTuning(settings);cat.aimAngle=angle;
    cat.setAttackState({attackInterval:.6,attackProgress:.96,willFire:false,hasTarget:true},0);
    cat.updatePose(0,moving,facing);
    const center=rootParentPoint(cat,cat.bowRotationPivot());
    close(center[0]-original[0],settings.pivotX);close(center[1]-original[1],settings.pivotY);
    for(const dt of [0,.05,.12]) {
      cat.updateEffects(dt);
      const pivot=rootParentPoint(cat,cat.bowRotationPivot()),palm=rootParentPoint(cat,drawingPalm(cat));
      close(palm[0]-pivot[0],settings.drawHandX);close(palm[1]-pivot[1],settings.drawHandY);
      const right=cat.poses[6],a=right.r*Math.PI/180,p=cat.gunPivot.position;
      const grip=[right.p[0]+Math.cos(a)*p.x*right.s[0]-Math.sin(a)*p.y*right.s[1],
        right.p[1]+Math.sin(a)*p.x*right.s[0]+Math.cos(a)*p.y*right.s[1]];
      const anchor=cat.bowRotationPivot();
      close(Math.hypot(grip[0]-anchor[0],grip[1]-anchor[1]),Math.hypot(...cat.bowDrawnGrip)*right.s[0]*settings.holdingRadiusScale);
    }
  }
});

test('Cat grade effects receive ground origin independent of body facing and clear on reset or deactivate',()=>{
  const cat=proceduralCat(),calls=[],projection=require('./.build/core/projection.js');cat.art={};
  cat.gradeEffects={setWeapon:id=>calls.push(['weapon',id]),update:(dt,origin)=>calls.push(['update',dt,...origin]),
    setActive:active=>calls.push(['active',active]),reset:()=>calls.push(['reset'])};
  const position=projection.projectWorld({x:7,z:-4});cat.node.setPosition(position.x,position.y);
  cat.setWeapon(20);cat.setWeapon(20);assert.deepEqual(calls,[['weapon',20]],'same equipped gun does not restart grade effects');
  cat.setFacing(-1);cat.updateEffects(.1);cat.setFacing(1);cat.updateEffects(.2);
  for(const call of calls.filter(call=>call[0]==='update')){close(call[2],7);close(call[3],0);close(call[4],-4);}
  const count=calls.length;cat.reset();assert.equal(calls[count][0],'reset');
  assert.equal(calls.at(-1)[0],'update');assert.equal(calls.at(-1)[1],0,'reset samples fresh effects at the reset pose');cat.setActive(false);
  assert.deepEqual(calls.at(-1),['active',false]);assert.equal(cat.node.active,false);assert.equal(cat.shadow.active,false);
});

test('sorting depth uses the original Cat_Bone group origin rather than animated body or weapon bounds',()=>{
  const fixture=require('./fixtures/original-muzzle-position-source.json'),projection=require('./.build/core/projection.js');
  const cat=proceduralCat(),sourcePivot=fixture.chain[2].position;
  const camera=projection.CAMERA_BASIS;
  for(const facing of [-1,1])for(const position of [{x:0,z:0},{x:7,z:-4},{x:-3,z:9}]) {
    cat.node.setPosition(...Object.values(projection.projectWorld(position)));cat.setFacing(facing);
    const [rx,ry,rz]=fixture.runtimePivotEuler[facing<0?'left':'right'].map(value=>value*Math.PI/180);
    // Unity's source Euler order is Y * X * Z. Rotate the serialized group
    // translation before adding the actor's ground position, without using
    // the procedural root or any descendant sprite rectangle.
    const zx=Math.cos(rz)*sourcePivot[0]-Math.sin(rz)*sourcePivot[1];
    const zy=Math.sin(rz)*sourcePivot[0]+Math.cos(rz)*sourcePivot[1];
    const xy=Math.cos(rx)*zy-Math.sin(rx)*sourcePivot[2];
    const xz=Math.sin(rx)*zy+Math.cos(rx)*sourcePivot[2];
    const gx=position.x+Math.cos(ry)*zx+Math.sin(ry)*xz;
    const gz=position.z-Math.sin(ry)*zx+Math.cos(ry)*xz;
    const expected=gx*camera.forwardX+xy*camera.forwardY+gz*camera.forwardZ;
    close(cat.sortingDepth,expected);
    const before=cat.sortingDepth;
    cat.poses[0].p=[13,-8];cat.poses[0].r=42;cat.aimAngle=120;cat.gunPivot.setPosition(12,20);
    close(cat.sortingDepth,before,0.000000001);
  }
});

test('Original LerpAngle takes positive 180-degree ties, including negative and repeated turns', () => {
  for (const [a, b, expected] of [[0,180,180],[180,0,180],[0,-180,180],[720,-180,180],[179,-179,2],[-179,179,-2]]) {
    close(catAngleDelta(a,b),expected,0);
  }
});

test('Muzzle transform scratch buffers preserve independent emission snapshots', () => {
  const cat=proceduralCat(),point=()=>({x:0,y:0,z:0,set(x,y,z){Object.assign(this,{x,y,z});}});
  delete cat.muzzleEmitterPose;
  const emitter={localScale:5,gunScale:.4,rigScale:.55,projectionGapDegrees:4.735};
  cat.art={catalog:{effects:{muzzle:{emitter}}}};
  cat.muzzleDefinition={emitter};
  cat.node={position:{x:4,y:8},getComponent:()=>assert.fail('component lookup must stay out of the frame path')};
  cat.muzzle={worldPosition:{x:102,y:203},getComponent:cat.node.getComponent};
  const matrix={a:-2,b:.5,c:1,d:3};
  cat.rootTransform={convertToNodeSpaceAR(p,out){out.set(p.x-100,p.y-200,0);return out;}};
  cat.muzzleTransform={convertToWorldSpaceAR(p,out){out.set(cat.muzzle.worldPosition.x+matrix.a*p.x+matrix.b*p.y,
    cat.muzzle.worldPosition.y+matrix.c*p.x+matrix.d*p.y,0);return out;}};
  cat.muzzleLocal=point();cat.axisLocal=point();cat.axisWorld=point();cat.axisProjected=point();
  const pose=cat.muzzleEmitterPose(),snapshot=structuredClone(pose);
  close(pose.origin.x,6);close(pose.origin.y,11);
  close(pose.zAxis.x,-10);close(pose.zAxis.y,5);
  close(pose.yAxis.x,2.5);close(pose.yAxis.y,15);
  matrix.a=7;cat.muzzle.worldPosition.x=110;cat.bodyMirror=-1;
  const next=cat.muzzleEmitterPose();
  close(next.origin.x,14);close(next.zAxis.x,35);
  assert.deepEqual(structuredClone(pose),snapshot,'world-space particles retain the original fire transform');
});

test('Face uses signed CamCorrection angle and current facing while retreating', () => {
  for (const [offset, facing, expected] of [
    [{x:10,z:10},1,90],[{x:10,z:10},-1,20],
    [{x:-10,z:-10},-1,90],[{x:-10,z:-10},1,20],
    [{x:-10,z:10},1,20],[{x:-10,z:10},-1,20],
    [{x:10,z:-10},1,160],
  ]) {
    const cat=proceduralCat();cat.setAimTarget(offset);
    cat.updatePose(1,false,facing,{x:0,y:0});close(cat.faceAngle,expected);
  }
  const cat=proceduralCat();cat.faceAngle=20;
  cat.updatePose(1,false,-1,{x:0,y:0});close(cat.faceAngle,90);
});

test('manual look rotates the face without aiming the hands and yields to an attack target', () => {
  const { manualLookDirection } = require('./.build/core/ManualMovement.js');
  const cat=proceduralCat();
  cat.setManualLookDirection(manualLookDirection({x:1,y:-1}));
  cat.updatePose(1,true,1);close(cat.faceAngle,125);
  assert.equal(cat.targetOffset,null,'movement does not create a weapon target');
  const idle=proceduralCat();idle.updatePose(1,true,1);close(cat.aimAngle,idle.aimAngle);
  cat.setAimTarget({x:-10,z:10});cat.updatePose(1,true,1);close(cat.faceAngle,20);
  cat.setAimTarget(null);cat.setManualLookDirection(undefined);cat.updatePose(1,false,1);close(cat.faceAngle,90);
});

test('Missile hands follow the source arc tangent from HandR while crossbows aim horizontally', () => {
  const { getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
  const missileId = getWeaponCatalog().find(weapon => weapon.type === 'MISSILE').id;
  const crossbowId = getWeaponCatalog().find(weapon => weapon.category === 'crossbow').id;
  const pitch = 40 * Math.PI / 180, height = 4;
  for (const facing of [-1, 1]) for (const planarDistance of [6, 20, 40]) {
    const cat = proceduralCat(); cat.art = {};
    cat.rig = { ...rig, display: { ...rig.display, scale: 1, pivotOffset: [0, height / Math.cos(pitch)] } };
    Object.assign(cat.poses[0], { p: [0, 0], r: 0, s: [1, 1] }); cat.poses[6].p = [0, 0];
    const handX = -Math.SQRT1_2 * Math.tan(pitch) * height, handZ = -handX;
    const sign = facing === -1 ? 1 : -1;
    cat.setAimTarget({ x: handX + sign * planarDistance * Math.SQRT1_2, z: handZ + sign * planarDistance * Math.SQRT1_2 });
    cat.setWeapon(missileId); cat.updatePose(1, false, facing);
    // ELF's 0x0106c21c=0.4f; UpdateHandRotation adds 4*arcHeight
    // to targetY-handY, unlike the horizontal ordinary-gun aim.
    const dy = -height + planarDistance * Math.fround(.4) * 4;
    close(cat.aimAngle, Math.atan2(Math.cos(pitch) * dy, planarDistance) * 180 / Math.PI);
    cat.setWeapon(crossbowId);
    // Equipping restores source arm positions; this projection-only fixture
    // intentionally places HandR at its synthetic origin afterward.
    cat.poses[6].p=[0,0];cat.updatePose(1, false, facing);close(cat.aimAngle, 0);
  }
});

test('Missile aiming retains the source ten-unit virtual target gate and shares Y=2 firing projection', () => {
  const cat = proceduralCat(); cat.weaponType = 'MISSILE';
  cat.rig = { ...rig, display: { ...rig.display, scale: 1, pivotOffset: [0, 15] } };
  Object.assign(cat.poses[0], { p: [0, 0], r: 0, s: [1, 1] }); cat.poses[6].p = [0, 0];
  cat.setAimTarget({ x: 50, z: 50 }); cat.updatePose(1, false, -1);
  close(cat.aimAngle, 130, 0);
  Object.defineProperty(cat, 'muzzleOffset', { value: { x: 3, y: 7 } });
  const missile = cat.getBulletSpawnOffset(2); cat.weaponType = 'SINGLE';
  assert.deepEqual(cat.getBulletSpawnOffset(2), missile);
});

test('Attack observes previous animation transforms; Normal Animator renders later without erasing arm rotations', () => {
  for (const hz of [30,60,120]) {
    const cat=proceduralCat(),dt=1/hz;
    cat.setAimTarget({x:15,z:20});
    const initial=structuredClone(cat.poses[0]);
    cat.updatePose(dt,true,1,{x:0,y:0});
    close(cat.animator.clock,0);
    assert.deepEqual(cat.poses[0],initial,'GetFirePosition inside Update sees prior Animator pose');
    const right=cat.poses[6].r,left=cat.poses[5].r;
    cat.updateEffects(dt);
    close(cat.animator.clock,dt*rig.dynamics.animator.walkSpeed);
    assert.notDeepEqual(cat.poses[0],initial,'Normal Animator changes rendered parent after Attack');
    close(cat.poses[6].r,right);close(cat.poses[5].r,left);
    const displayed=structuredClone(cat.poses[0]);
    cat.updatePose(dt,true,1,{x:0,y:0});
    assert.deepEqual(cat.poses[0],displayed,'next Update uses last displayed parent pose');
  }
});

test('Recoil yields on first fire, resumes after next Update, and active retrigger does not yield again', () => {
  const cat=proceduralCat(),dt=.025,rest=cat.gunPosition[0];
  cat.updatePose(dt,false,-1,{x:0,y:0});cat.fire();cat.updateEffects(dt);
  close(cat.recoil,0);close(cat.gunPivot.position.x,rest);close(cat.gunBounce.scale.x,1);
  cat.updatePose(dt,false,-1,{x:0,y:0});
  close(cat.recoil,0);assert.equal(cat.gunPivot.position.x,rest,'Update precedes resumed recoil');
  const supportBefore=cat.poses[5].r;
  cat.updateEffects(dt);
  close(cat.recoil,dt);assert.ok(cat.gunPivot.position.x<rest);
  assert.equal(cat.poses[5].r,supportBefore,'late recoil does not recompute procedural support arm');
  cat.updatePose(dt,false,-1,{x:0,y:0});
  assert.notEqual(cat.poses[5].r,supportBefore,'support arm follows previous coroutine transform next Update');
  const preFire=cat.gunPivot.position.x;cat.fire();close(cat.gunPivot.position.x,preFire);
  cat.updateEffects(dt);close(cat.recoil,dt);
  cat.updateEffects(rig.dynamics.recoil.duration);
  assert.equal(cat.recoil,Infinity);close(cat.gunPivot.position.x,rest);close(cat.gunBounce.scale.x,1);
  cat.fire();cat.updateEffects(dt);close(cat.recoil,0);
  cat.reset();assert.equal(cat.recoil,Infinity);close(cat.gunPivot.position.x,rest);
});

test('gauntlets replace the holding paw from its base and compress around the cuff without an extra arm swing', () => {
  const { WeaponAttackAnimator } = require('./.build/character/WeaponAttackAnimation.js');
  const { getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
  const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();
  cat.holdingSkinParts=[{active:true}];
  const hand={active:true,setPosition(x,y){this.p=[x,y];}};
  cat.hands=[{node:hand,position:[...rig.attachments.hand.localPosition],rotation:rig.attachments.hand.localRotationDeg}];
  const glove=getWeaponCatalog().find(weapon=>weapon.category==='glove');
  const cannon=getWeaponCatalog().find(weapon=>weapon.category==='cannon');
  cat.setWeapon(glove.id);
  assert.equal(hand.active,false);assert.equal(cat.holdingSkinParts[0].active,false);
  cat.setAttackState({attackInterval:.6,attackProgress:1,willFire:true,hasTarget:true},0);
  cat.updatePose(0,false,-1);
  close(cat.gunPivot.position.x,gloveHandBase[0]);
  close(cat.gunPivot.position.y,gloveHandBase[1]);
  const release=cat.poses[6].r;
  cat.setAttackState({attackInterval:.6,attackProgress:.05,willFire:false,hasTarget:true},.03);
  cat.updatePose(.03,false,-1);
  close(cat.poses[6].r,release);
  assert.ok(cat.gunBounce.scale.x<1);assert.ok(cat.gunBounce.scale.y>1);
  close(cat.gunPivot.position.x-hand.p[0],gloveHandBase[0]-rig.attachments.hand.localPosition[0]);
  close(cat.gunPivot.position.y-hand.p[1],gloveHandBase[1]-rig.attachments.hand.localPosition[1]);
  cat.setAttackState({attackInterval:.6,attackProgress:.5,willFire:false,hasTarget:true},.3);
  cat.updatePose(0,false,-1);
  close(cat.gunBounce.scale.x,1);close(cat.gunBounce.scale.y,1);
  close(cat.gunPivot.position.x,gloveHandBase[0]);
  close(cat.gunPivot.position.y,gloveHandBase[1]);
  cat.attackPose=undefined;cat.fire();cat.updateEffects(.01);cat.updateEffects(.1);
  const pulse=catRecoilWeight(cat.recoil,rig.dynamics.recoil.duration);
  close(cat.gunPivot.position.x,gloveHandBase[0]+rig.dynamics.recoil.position[0]*pulse);
  close(cat.gunPivot.position.y,gloveHandBase[1]);
  assert.equal(hand.active,false);assert.equal(cat.holdingSkinParts[0].active,false);
  cat.reset();close(cat.gunPivot.position.x,gloveHandBase[0]);close(cat.gunPivot.position.y,gloveHandBase[1]);
  cat.setWeapon(cannon.id);
  assert.equal(hand.active,true);assert.equal(cat.holdingSkinParts[0].active,true);
  cat.setAttackState({attackInterval:.6,attackProgress:1,willFire:true,hasTarget:true},0);
  cat.updatePose(0,false,-1);
  close(cat.gunPivot.position.x,cat.gunPosition[0]);
});

test('all weapons retain their authored PNG structure through equipment switches', () => {
  const { getWeaponCatalog } = require('./.build/core/WeaponCatalog.js');
  const cat=proceduralCat(),normal=Object.freeze({name:'normal'});
  const component={setContentSize(){},setAnchorPoint(){}};
  cat.gunImage={getComponent(){return component;},setPosition(){},setScale(){}};
  cat.muzzle={setPosition(){},setScale(){}};
  cat.art={linearSpriteMaterial:normal,frames:new Map(),weaponVisuals:{
    appearance(id){return {image:{path:`weapon-${id}`,sizeUnits:[1,1],anchor:[.5,.5]},
      muzzle:{localPosition:[0,0]},muzzleSkin:'none'};},config:{muzzleSkins:{}}}};
  const catalog=getWeaponCatalog(),bows=catalog.filter(weapon=>weapon.category==='bow');
  for(const bow of bows) {
    cat.setWeapon(bow.id);assert.equal(component.customMaterial,normal);
    for(const weapon of catalog.filter(weapon=>weapon.category!=='bow')) {
      cat.setWeapon(weapon.id);
      assert.equal(component.customMaterial,normal,`${weapon.category} ${weapon.id}`);
      cat.setWeapon(bow.id);assert.equal(component.customMaterial,normal);
    }
  }
  delete cat.art.linearSpriteMaterial;
  cat.setWeapon(catalog.find(weapon=>weapon.category==='crossbow').id);
  assert.equal(component.customMaterial,null,'missing pipeline resets any previous material');
});

test('bow drawing arm retains its sampled pull through idle/walk evaluation', () => {
  const { WeaponAttackAnimator } = require('./.build/character/WeaponAttackAnimation.js');
  const cat=proceduralCat();cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
  cat.setAimTarget({x:15,z:20});
  for(const moving of [false,true]) {
    cat.setAttackState({attackInterval:.6,attackProgress:.9,willFire:false,hasTarget:true},.02);
    cat.updatePose(.02,moving,-1);
    const left=structuredClone(cat.poses[rig.dynamics.leftHandBone]),offset=drawingOffset(cat);
    cat.updateEffects(.02);
    close(drawingOffset(cat)[0],offset[0]);close(drawingOffset(cat)[1],offset[1]);
    close(cat.poses[rig.dynamics.leftHandBone].r,left.r);
    assert.equal(cat.gunBounce.scale.x,1,'bow grip remains fixed without squashing the artwork');
  }
});

test('all crossbows and gloves match frozen original gun arm poses through aiming, recoil and source animation for every skin',()=>{
  const fixture=require('./fixtures/original-gun-hand-poses.json');
  const {getWeapon}=require('./.build/core/WeaponCatalog.js');
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons
    .filter(weapon=>['crossbow','glove'].includes(getWeapon(weapon.id).category));
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const {sampleWeaponAttack}=require('./.build/character/WeaponAttackAnimation.js');
  assert.equal(appearances.length,20);assert.equal(fixture.samples.length,40);
  for(const appearance of appearances) {
    const weapon=getWeapon(appearance.id),cat=proceduralCat();cat.art={};
    cat.weaponCategory=weapon.category;cat.weaponType=weapon.type;cat.weaponAppearance=appearance;
    const drawOffset=weapon.category==='glove'?gloveHandBase.map((value,axis)=>value-rig.attachments.gun.localPosition[axis]):[0,0];
    const mainHand={position:[...rig.attachments.hand.localPosition],rotation:rig.attachments.hand.localRotationDeg,node:{setPosition(x,y){this.p=[x,y];}}};cat.hands=[mainHand];
    for(const skin of skins)for(const sample of fixture.samples) {
      cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
      cat.animator=player();cat.animator.update(sample.warmup,sample.moving);
      cat.poses=rig.bones.map((_,i)=>cat.animator.pose(i));cat.aimAngle=sample.initialAim;
      cat.setAimTarget(sample.target);
      cat.attackPose=sampleWeaponAttack(weapon.category,{attackInterval:.6,attackProgress:0,willFire:false,hasTarget:!!sample.target},sample.elapsed,rig.dynamics.recoil);
      assert.equal(cat.attackPose.supportGripOffset,null,'source gun poses must not translate the support arm to a sprite point');
      cat.updatePose(sample.dt,sample.moving,sample.facing);
      const compare=expected=>[6,5].forEach((bone,index)=>{
        for(const axis of [0,1]){close(cat.poses[bone].p[axis],expected[index].p[axis]);close(cat.poses[bone].s[axis],expected[index].s[axis]);}
        close(cat.poses[bone].r,expected[index].r);
      });
      compare(sample.before);
      assert.equal(cat.holdingHandPosition,undefined);assert.equal(cat.supportHandPosition,undefined);
      close(cat.gunPivot.position.x,sample.gunPivot.x+drawOffset[0]);close(cat.gunPivot.position.y,sample.gunPivot.y+drawOffset[1]);
      close(cat.gunBounce.scale.x,sample.gunScale.x);close(cat.gunBounce.scale.y,sample.gunScale.y);
      close(mainHand.node.p[0],rig.attachments.hand.localPosition[0]+sample.gunPivot.x-rig.attachments.gun.localPosition[0]);
      close(mainHand.node.p[1],rig.attachments.hand.localPosition[1]);
      if(weapon.category==='glove') {
        close(cat.gunPivot.position.x-mainHand.node.p[0],gloveHandBase[0]-rig.attachments.hand.localPosition[0]);
        close(cat.gunPivot.position.y-mainHand.node.p[1],gloveHandBase[1]-rig.attachments.hand.localPosition[1]);
        assert.equal(cat.attackPose.hideHoldingHand,true);
      }
      cat.updateEffects(sample.dt);compare(sample.after);
    }
  }
});

test('equipping a crossbow, glove or staff restores original sampled arms after any other weapon stance',()=>{
  const {WeaponAttackAnimator}=require('./.build/character/WeaponAttackAnimation.js');
  for(const previousCategory of ['bow','crossbow','glove','staff','fan','handgun','cannon'])for(const weaponId of [1,4,8]) {
    const cat=proceduralCat();cat.art={};cat.animator.update(.317,true);cat.weaponCategory=previousCategory;
    cat.attackAnimator=new WeaponAttackAnimator();
    cat.poses[6].p=[8,9];cat.poses[5].p=[6,7];cat.poses[6].s=[2,3];cat.poses[5].s=[4,5];
    cat.holdingHandPosition=[8,9];cat.supportHandPosition=[6,7];
    cat.setAttackState({attackInterval:.6,attackProgress:1,willFire:true,hasTarget:true},0);
    cat.setWeapon(weaponId);
    for(const bone of [5,6])assert.deepEqual(cat.poses[bone],cat.animator.pose(bone));
    assert.equal(cat.holdingHandPosition,undefined);assert.equal(cat.supportHandPosition,undefined);
    cat.setAttackState({attackInterval:.6,attackProgress:0,willFire:false,hasTarget:false},0);
    assert.equal(cat.attackPose.phase,'idle');assert.deepEqual(cat.attackPose.weaponScale,[1,1]);
    cat.updatePose(0,true,-1);cat.updateEffects(.02);
    for(const bone of [5,6])assert.deepEqual(cat.poses[bone].p,cat.animator.pose(bone).p);
  }
});

test('every staff keeps both original gun arm poses throughout casting, aiming, walking and facing changes',()=>{
  const {sampleWeaponAttack}=require('./.build/character/WeaponAttackAnimation.js');
  const samples=require('./fixtures/original-gun-hand-poses.json').samples;
  const {getWeapon}=require('./.build/core/WeaponCatalog.js');
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons.filter(w=>getWeapon(w.id).category==='staff');
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const staff=proceduralCat(),gun=proceduralCat();
  const phases=[[0,false,Infinity],[.65,false,Infinity],[.91,false,Infinity],[1,false,Infinity],[0,true,0],[0,false,.0325],[0,false,.15],[0,false,.28]];
  for(const appearance of appearances)for(const skin of skins)for(const sample of samples)for(const [progress,willFire,elapsed] of phases) {
    for(const cat of [staff,gun]) {
      cat.art={};cat.animator=player();cat.animator.update(sample.warmup,sample.moving);
      cat.poses=rig.bones.map((_,i)=>cat.animator.pose(i));cat.aimAngle=sample.initialAim;
      cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
      cat.setAimTarget(sample.target);cat.weaponType='EXPLOSIVE';
    }
    staff.weaponCategory='staff';staff.weaponAppearance=appearance;
    staff.attackPose=sampleWeaponAttack('staff',{attackInterval:.6,attackProgress:progress,willFire,hasTarget:!!sample.target},elapsed);
    gun.weaponCategory='crossbow';gun.attackPose=sampleWeaponAttack('crossbow',{attackInterval:.6,attackProgress:0,willFire:false,hasTarget:!!sample.target});
    for(const cat of [staff,gun])cat.updatePose(sample.dt,sample.moving,sample.facing);
    for(const afterUpdate of [false,true]) {
      if(afterUpdate)for(const cat of [staff,gun])cat.updateEffects(sample.dt);
      for(const bone of [5,6]) {
        for(const axis of [0,1]) {
          close(staff.poses[bone].p[axis],gun.poses[bone].p[axis]);
          close(staff.poses[bone].s[axis],gun.poses[bone].s[axis]);
        }
        close(staff.poses[bone].r,gun.poses[bone].r);
      }
    }
  }
});

test('staff rotates only the holding palm about its fixed grip throughout the cast',()=>{
  const {sampleWeaponAttack}=require('./.build/character/WeaponAttackAnimation.js');
  for(const facing of [-1,1])for(const moving of [false,true])for(const alternatePivot of [false,true]) {
    const cat=proceduralCat();cat.art={};cat.weaponCategory='staff';cat.weaponType='EXPLOSIVE';
    cat.rig=structuredClone(rig);
    if(alternatePivot) {
      Object.assign(cat.rig.attachments.gun,{localPosition:[1.1,-.37],localScale:[.8,1.3],localRotationDeg:37});
      cat.gunPosition=cat.rig.attachments.gun.localPosition;
    }
    cat.animator.update(.31,moving);cat.poses=rig.bones.map((_,i)=>cat.animator.pose(i));
    cat.setAimTarget({x:10*facing,z:8*facing});
    cat.hands=['hand','handOutline'].map(id=>({position:[...rig.attachments[id].localPosition],rotation:rig.attachments[id].localRotationDeg,
      node:{setPosition(x,y){this.p=[x,y];}}}));
    const q=cat.staffGripPivot(),gun=cat.rig.attachments.gun;
    let baseline;
    for(const [progress,release,elapsed] of [[0,false,Infinity],[.9,false,Infinity],[1,true,0],[0,false,.08],[0,false,.28]]) {
      cat.attackPose=sampleWeaponAttack('staff',{attackInterval:.6,attackProgress:progress,willFire:release,hasTarget:true},elapsed);
      cat.updatePose(0,moving,facing);
      const positions=[...cat.poses[5].p,...cat.poses[6].p],angle=cat.gunBounce.angle*Math.PI/180;
      baseline??={positions,freeRotation:cat.poses[5].r,holdingArmRotation:cat.poses[6].r};
      positions.forEach((v,i)=>close(v,baseline.positions[i]));
      close(cat.poses[5].r,baseline.freeRotation);close(cat.poses[6].r,baseline.holdingArmRotation);
      for(const hand of cat.hands) {
        assert.deepEqual(hand.node.p,hand.position);
        close(hand.node.angle,hand.rotation+cat.attackPose.staffCast.holdingRotation);
      }
      const pivot=cat.gunBounce.position;
      const gx=pivot.x+Math.cos(angle)*q[0]-Math.sin(angle)*q[1];
      const gy=pivot.y+Math.sin(angle)*q[0]+Math.cos(angle)*q[1];
      const ga=gun.localRotationDeg*Math.PI/180;
      close(cat.gunPivot.position.x+Math.cos(ga)*gx*gun.localScale[0]-Math.sin(ga)*gy*gun.localScale[1],rig.attachments.hand.localPosition[0]);
      close(cat.gunPivot.position.y+Math.sin(ga)*gx*gun.localScale[0]+Math.cos(ga)*gy*gun.localScale[1],rig.attachments.hand.localPosition[1]);
      for(let frame=0;frame<6;frame++) {
        cat.updatePose(0,moving,facing);cat.updateEffects(0);
        [...cat.poses[5].p,...cat.poses[6].p].forEach((v,i)=>close(v,positions[i]));
        close(cat.poses[5].r,baseline.freeRotation);
        for(const hand of cat.hands) {
          assert.deepEqual(hand.node.p,hand.position);
          close(hand.node.angle,hand.rotation+cat.attackPose.staffCast.holdingRotation);
        }
      }
    }
  }
});

test('staff glow samples only staff poses and clears when switched, reset or deactivated',()=>{
  const {WeaponAttackAnimator}=require('./.build/character/WeaponAttackAnimation.js');
  const cat=proceduralCat(),calls=[];cat.art={};cat.attackAnimator=new WeaponAttackAnimator();
  cat.staffCastEffect={update:pose=>calls.push(['update',pose.charge]),reset:()=>calls.push(['reset'])};
  cat.setWeapon(8);cat.setAttackState({attackInterval:.6,attackProgress:.95,willFire:false,hasTarget:true},0);
  cat.updatePose(0,false,-1);cat.updateEffects(0);
  assert.equal(calls.at(-1)[0],'update');assert.ok(calls.at(-1)[1]>.9);
  cat.setWeapon(1);assert.deepEqual(calls.at(-1),['reset']);
  cat.setWeapon(8);cat.reset();assert.deepEqual(calls.at(-1),['reset']);
  cat.setActive(false);assert.deepEqual(calls.at(-1),['reset']);
});

test('bow holding arm stays forward through idle/walk evaluation and never accumulates reach', () => {
  const { WeaponAttackAnimator } = require('./.build/character/WeaponAttackAnimation.js');
  const cat=proceduralCat();cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
  cat.art={};cat.weaponAppearance=require('../assets/resources/art/weapon-system/visuals.json').weapons.find(w=>w.id===0);
  cat.bowStringDefinition=cat.weaponAppearance.bowString;cat.bowStringNode={active:false};
  cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
  cat.setAttackState({attackInterval:.6,attackProgress:0,willFire:false,hasTarget:false},0);
  cat.updatePose(1,false,-1);
  const right=cat.poses[6],pivot=cat.bowRotationPivot(),extended=[right.p[0]-pivot[0],right.p[1]-pivot[1]],rootAngle=cat.poses[0].r*Math.PI/180;
  const palm=rig.attachments.hand.localPosition,a=right.r*Math.PI/180;
  const palmX=right.p[0]+Math.cos(a)*palm[0]-Math.sin(a)*palm[1];
  const palmY=right.p[1]+Math.sin(a)*palm[0]+Math.cos(a)*palm[1];
  assert.ok(Math.cos(rootAngle)*palmX-Math.sin(rootAngle)*palmY < -1.8,'authored left-facing paw is visibly ahead of the body');
  for(let frame=0;frame<3;frame++) {
    cat.updatePose(0,false,-1);
    for(const dt of [0,.02]) {
      cat.updateEffects(dt);const center=cat.bowRotationPivot();
      close(right.p[0]-center[0],extended[0]);close(right.p[1]-center[1],extended[1]);
    }
  }
  assert.equal(cat.gunPivot.position.x,palm[0]);assert.equal(cat.gunPivot.position.y,palm[1]);
});

test('the bow string stays on the rotating palm and releases across every skin and both facings', () => {
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const { WeaponAttackAnimator }=require('./.build/character/WeaponAttackAnimation.js');
  const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
  const image={sizePx:[256,143],sizeUnits:[12.8,7.15],anchor:[.375,71/143],localPosition:[.12,-.08],localScale:[.4,-.4],localRotationDeg:7};
  cat.weaponAppearance={image,bowString:{upperPx:[84,14],lowerPx:[86,132],bracePx:[85,72],drawPx:29}};
  cat.bowStringDefinition=cat.weaponAppearance.bowString;
  cat.bowStringNode={active:false};
  const stroke=[];cat.bowStringGraphic={clear(){stroke.length=0;},moveTo(x,y){stroke.push([x,y]);},lineTo(x,y){stroke.push([x,y]);},stroke(){}};
  const transform=(point,scale,angle,offset=[0,0])=>{
    const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
    return [offset[0]+c*point[0]*scale[0]-s*point[1]*scale[1],offset[1]+s*point[0]*scale[0]+c*point[1]*scale[1]];
  };
  for(const skin of skins)for(const facing of [-1,1]) {
    cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
    cat.attackAnimator.reset();cat.setAimTarget({x:15*facing,z:20*facing});
    cat.setAttackState({attackInterval:.6,attackProgress:.9,willFire:false,hasTarget:true},0);
    cat.updatePose(.03,true,facing);
    const right=cat.poses[6],left=cat.poses[rig.dynamics.leftHandBone];
    const gun=rig.attachments.gun;
    const angle=right.r+rig.bones[rig.dynamics.leftHandBone].rotationDeg-rig.bones[6].rotationDeg;
    close(left.r,angle,1e-6);
    const assertHeld=()=>{
      const stringImage=transform(stroke[1],image.localScale,image.localRotationDeg,image.localPosition);
      const stringArm=transform(stringImage,gun.localScale,gun.localRotationDeg,rig.attachments.hand.localPosition);
      const stringRoot=transform(stringArm,right.s,right.r,right.p);
      const palm=transform(cat.supportPalmCenter,left.s,left.r,left.p);
      close(stringRoot[0],palm[0],1e-6);close(stringRoot[1],palm[1],1e-6);
    };
    assertHeld();cat.updateEffects(.02);assertHeld();close(left.r,angle,1e-6);
    cat.setAttackState({attackInterval:.6,attackProgress:1,willFire:true,hasTarget:true},0);
    cat.updatePose(0,true,facing);cat.updateEffects(.02);
    const brace=cat.weaponAppearance.bowString.bracePx;
    close(stroke[1][0],(brace[0]/image.sizePx[0]-image.anchor[0])*image.sizeUnits[0]);
    close(stroke[1][1],(1-brace[1]/image.sizePx[1]-image.anchor[1])*image.sizeUnits[1]);
    cat.setAttackState({attackInterval:.6,attackProgress:.3,willFire:false,hasTarget:true},.2);
    cat.updatePose(0,true,facing);cat.updateEffects(.02);assertHeld();
    assert.equal(cat.bowStringNode.active,true);assert.equal(stroke.length,3);
  }
});

test('bow hand pulls back and returns to the same palm starting point regardless of aiming', () => {
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const { WeaponAttackAnimator }=require('./.build/character/WeaponAttackAnimation.js');
  for(const skin of skins)for(const facing of [-1,1])for(const moving of [false,true]) {
    const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
    cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
    cat.weaponAppearance={image:{sizePx:[256,143],sizeUnits:[12.8,7.15],anchor:[.375,71/143],
      localPosition:[.12,-.08],localScale:[.4,-.4],localRotationDeg:7},
      bowString:{upperPx:[84,14],lowerPx:[86,132],bracePx:[85,72],drawPx:29}};
    cat.bowStringDefinition=cat.weaponAppearance.bowString;cat.bowStringNode={active:false};
    cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
    const snapshots=[];
    for(const [progress,willFire,dt] of [[0,false,0],[.68,false,0],[.96,false,0],
      [1,true,0],[.05,false,.03],[.2,false,.08],[.3,false,.2]]) {
      cat.setAttackState({attackInterval:.6,attackProgress:progress,willFire,hasTarget:true},dt);
      // Hold the aim still while testing the attack, so wrist rotation cannot
      // be mistaken for the separate operation of aiming at a moving target.
      cat.updatePose(0,moving,facing);cat.updateEffects(.02);
      const left=cat.poses[rig.dynamics.leftHandBone];
      if(progress===0) {
        const palm=rootParentPoint(cat,drawingPalm(cat)),pivot=rootParentPoint(cat,cat.bowRotationPivot());
        close(palm[0]-pivot[0],0);close(palm[1]-pivot[1],-.06);
      }
      snapshots.push({angle:left.r,palm:drawingOffset(cat)});
    }
    const start=snapshots[0],drawn=snapshots[2];
    const dx=drawn.palm[0]-start.palm[0],dy=drawn.palm[1]-start.palm[1];
    assert.ok(Math.hypot(dx,dy)>.1,'the hand must visibly pull back');
    close(start.palm[0],0);close(start.palm[1],0);
    const axis=cat.poses[6].r*Math.PI/180;
    assert.ok(dx*Math.cos(axis)+dy*Math.sin(axis)<-.1,'pull travels behind the aiming direction');
    close(dx*Math.sin(axis)-dy*Math.cos(axis),0);
    for(const pose of snapshots) {
      close(pose.angle,start.angle);
      close((pose.palm[0]-start.palm[0])*dy-(pose.palm[1]-start.palm[1])*dx,0);
    }
    close(snapshots[3].palm[0],drawn.palm[0]);close(snapshots[3].palm[1],drawn.palm[1]);
    close(snapshots.at(-1).palm[0],start.palm[0]);close(snapshots.at(-1).palm[1],start.palm[1]);
    const previousAngle=cat.poses[rig.dynamics.leftHandBone].r;
    cat.aimAngle+=40;cat.updatePose(0,moving,facing);
    close(catAngleDelta(previousAngle,cat.poses[rig.dynamics.leftHandBone].r),40);
    close(drawingOffset(cat)[0],start.palm[0]);close(drawingOffset(cat)[1],start.palm[1]);
    cat.poses[rig.dynamics.leftHandBone].p=[8,9];
    cat.supportHandPosition=[8,9];
    cat.updatePose(0,moving,facing);cat.updateEffects(.02);
    close(drawingOffset(cat)[0],start.palm[0]);close(drawingOffset(cat)[1],start.palm[1]);
  }
});

test('bow hand retreat leaves the bow grip and muzzle chain unchanged in every attack phase',()=>{
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons.filter(weapon=>weapon.bowString);
  const {sampleWeaponAttack}=require('./.build/character/WeaponAttackAnimation.js');
  const state={attackInterval:.6,attackProgress:0,willFire:false,hasTarget:true};
  const phases=[sampleWeaponAttack('bow',{...state,hasTarget:false}),
    ...[0,.6,.96].map(attackProgress=>sampleWeaponAttack('bow',{...state,attackProgress})),
    sampleWeaponAttack('bow',{...state,willFire:true},0),
    ...[.05,.12,.16].map(elapsed=>sampleWeaponAttack('bow',state,elapsed))];
  for(const appearance of appearances) {
    const cat=proceduralCat();cat.art={};cat.weaponCategory='bow';
    cat.bowStringNode={active:false};cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
    const reference={...appearance,bowString:{...appearance.bowString,handRetreatPx:0}};
    const retreated={...appearance,bowString:{...appearance.bowString,handRetreatPx:12}};
    for(const facing of [-1,1])for(let direction=0;direction<8;direction++)for(const phase of phases) {
      cat.aimAngle=direction*45-cat.poses[0].r;cat.attackPose=phase;
      cat.weaponAppearance=reference;cat.bowStringDefinition=reference.bowString;
      cat.updatePose(0,false,facing);
      const right=cat.poses[6],left=cat.poses[rig.dynamics.leftHandBone];
      const before={position:[...right.p],angle:right.r,scale:[...right.s],pivot:{...cat.gunPivot.position},
        bounce:{...cat.gunBounce.scale},reference:[...cat.bowDrawnGrip],support:[...cat.bowSupportGrip],
        hand:[...left.p]};
      cat.weaponAppearance=retreated;cat.bowStringDefinition=retreated.bowString;
      cat.updatePose(0,false,facing);
      assert.deepEqual([...right.p],before.position);close(right.r,before.angle);assert.deepEqual([...right.s],before.scale);
      assert.deepEqual(cat.gunPivot.position,before.pivot);assert.deepEqual(cat.gunBounce.scale,before.bounce);
      assert.deepEqual([...cat.bowDrawnGrip],before.reference,'retreat must never move the bow registration');
      const distance=12*appearance.image.sizeUnits[0]/appearance.image.sizePx[0]*Math.abs(appearance.image.localScale[0]);
      close(Math.hypot(cat.bowSupportGrip[0]-before.support[0],cat.bowSupportGrip[1]-before.support[1]),distance);
      close(left.p[0],before.hand[0]);close(left.p[1],before.hand[1]);
    }
  }
});

test('bow holding palm follows the approved radius and torso offset in every attack phase',()=>{
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons.filter(weapon=>weapon.bowString);
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const {sampleWeaponAttack}=require('./.build/character/WeaponAttackAnimation.js');
  const phases=[{attackProgress:0,hasTarget:false},{attackProgress:0},{attackProgress:.96},{attackProgress:1,willFire:true}];
  for(const appearance of appearances) {
    const cat=proceduralCat();cat.art={};cat.weaponCategory='bow';cat.weaponAppearance=appearance;
    cat.bowStringDefinition=appearance.bowString;cat.bowStringNode={active:false};
    cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
    for(const skin of skins)for(const facing of [-1,1])for(const moving of [false,true])for(const phase of phases) {
      cat.skinBodyCenter=skin.parts.find(part=>part.id==='body').localPosition;
      cat.animator=player();cat.animator.update(.371,moving);cat.poses=rig.bones.map((_,i)=>cat.animator.pose(i));
      cat.attackPose=sampleWeaponAttack('bow',{attackInterval:.6,willFire:false,hasTarget:true,...phase});
      const circle=[],pivot=[...cat.bowRotationPivot()];
      for(let direction=0;direction<16;direction++) {
        cat.aimAngle=direction*22.5;cat.updatePose(0,moving,facing);
        const right=cat.poses[6],a=right.r*Math.PI/180;
        const grip=[cat.gunPivot.position.x,cat.gunPivot.position.y];
        const palm=[right.p[0]+Math.cos(a)*grip[0]*right.s[0]-Math.sin(a)*grip[1]*right.s[1],
          right.p[1]+Math.sin(a)*grip[0]*right.s[0]+Math.cos(a)*grip[1]*right.s[1]];
        const originalRadius=Math.hypot(...cat.bowDrawnGrip)*right.s[0];
        close(Math.hypot(palm[0]-pivot[0],palm[1]-pivot[1])/originalRadius,.85);
        assert.deepEqual([...cat.bowRotationPivot()],pivot,'aim angle and attack progress cannot move the center');
        circle.push(palm);
        const fixed=[...right.p];cat.updateEffects(0);
        close(right.p[0],fixed[0]);close(right.p[1],fixed[1]);
      }
      // Opposite sampled palms independently recover the same center.
      for(let i=0;i<8;i++) {
        close((circle[i][0]+circle[i+8][0])/2,pivot[0]);
        close((circle[i][1]+circle[i+8][1])/2,pivot[1]);
      }
      assertBowBodyCenter(cat,pivot);
    }
  }
});

test('rendered bow circle remains centered while idle breathing and walk animation change its parent',()=>{
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons.filter(weapon=>weapon.bowString);
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const {WeaponAttackAnimator}=require('./.build/character/WeaponAttackAnimation.js');
  const point=(pose,p)=>{const a=pose.r*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [
    pose.p[0]+c*p[0]*pose.s[0]-s*p[1]*pose.s[1],pose.p[1]+s*p[0]*pose.s[0]+c*p[1]*pose.s[1]];};
  for(const appearance of appearances) {
    const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
    cat.weaponAppearance=appearance;cat.bowStringDefinition=appearance.bowString;
    cat.bowStringNode={active:false};cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
    for(const skin of skins)for(const facing of [-1,1])for(const moving of [false,true])for(const direction of [0,90,180,270]) {
      cat.skinBodyCenter=skin.parts.find(part=>part.id==='body').localPosition;
      cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
      cat.aimAngle=direction;cat.setAttackState({attackInterval:.6,attackProgress:.9,willFire:false,hasTarget:true},0);
      cat.updatePose(0,moving,facing);
      const offset=drawingOffset(cat);
      for(const dt of [0,.037,.1]) {
        cat.updateEffects(dt);
        const right=cat.poses[6],left=cat.poses[rig.dynamics.leftHandBone],radius=Math.hypot(...cat.bowDrawnGrip)*.85;
        const grip=[cat.gunPivot.position.x,cat.gunPivot.position.y];
        // Recover the actual center from the rendered holding palm, instead
        // of trusting that a freshly calculated pivot was applied to the rig.
        const inferred=point(right,[grip[0]-radius,grip[1]]);
        assertBowBodyCenter(cat,inferred);
        close(drawingOffset(cat)[0],offset[0]);close(drawingOffset(cat)[1],offset[1]);
      }
    }
  }
});

test('authored bows keep the holding orbit and shared drawing start for all directions, distances and skins', () => {
  const skins=require('../assets/resources/art/skin-system/visuals.json').skins;
  const appearances=require('../assets/resources/art/weapon-system/visuals.json').weapons.filter(weapon=>weapon.bowString);
  const { WeaponAttackAnimator }=require('./.build/character/WeaponAttackAnimation.js');
  for(const appearance of appearances) {
    const cat=proceduralCat();cat.art={};cat.attackAnimator=new WeaponAttackAnimator();cat.weaponCategory='bow';
    cat.weaponAppearance=appearance;cat.bowStringDefinition=appearance.bowString;
    cat.bowStringNode={active:false};cat.bowStringGraphic={clear(){},moveTo(){},lineTo(){},stroke(){}};
    for(const skin of skins)for(const facing of [-1,1])for(const distance of [2,40])for(let direction=0;direction<8;direction++) {
      cat.skinBodyCenter=skin.parts.find(part=>part.id==='body').localPosition;
      cat.supportPalmCenter=skin.parts.find(part=>part.id==='hand_left').localPosition;
      cat.attackAnimator.reset();
      const angle=direction*Math.PI/4;
      cat.setAimTarget({x:Math.cos(angle)*distance,z:Math.sin(angle)*distance});
      cat.setAttackState({attackInterval:.6,attackProgress:.96,willFire:false,hasTarget:true},0);
      cat.updatePose(1,false,facing);
      const pivot=cat.bowRotationPivot(),right=cat.poses[6],fixedGrip=[...right.p];
      const left=cat.poses[rig.dynamics.leftHandBone];
      const rotate=(p,scale,degrees)=>{
        const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
        return [c*p[0]*scale[0]-s*p[1]*scale[1],s*p[0]*scale[0]+c*p[1]*scale[1]];
      };
      const image=appearance.image,gun=rig.attachments.gun,string=appearance.bowString;
      let hand=[-string.drawPx*.90/image.sizePx[0]*image.sizeUnits[0],0];
      hand=rotate(hand,image.localScale,image.localRotationDeg);
      hand=rotate(hand,gun.localScale,gun.localRotationDeg);
      let fullSpan=[((string.bracePx[0]-string.drawPx)/image.sizePx[0]-image.anchor[0])*image.sizeUnits[0],
        (1-string.bracePx[1]/image.sizePx[1]-image.anchor[1])*image.sizeUnits[1]];
      fullSpan=rotate(fullSpan,image.localScale,image.localRotationDeg);
      fullSpan[0]+=image.localPosition[0];fullSpan[1]+=image.localPosition[1];
      fullSpan=rotate(fullSpan,gun.localScale,gun.localRotationDeg);
      close(cat.bowDrawnGrip[0],fullSpan[0]);close(cat.bowDrawnGrip[1],fullSpan[1]);
      const expected=rotate([-Math.hypot(...hand),0],right.s,right.r),start=drawingPalm(cat,true),palm=drawingPalm(cat);
      close(palm[0]-start[0],expected[0]);close(palm[1]-start[1],expected[1]);
      assertBowBodyCenter(cat,pivot);
      for(const progress of [0,.5,.75,.96]) {
        cat.setAttackState({attackInterval:.6,attackProgress:progress,willFire:false,hasTarget:true},0);
        cat.updatePose(0,false,facing);
        close(right.p[0],fixedGrip[0]);close(right.p[1],fixedGrip[1]);
        if(progress===0){close(drawingPalm(cat)[0],start[0]);close(drawingPalm(cat)[1],start[1]);}
      }
      cat.setAttackState({attackInterval:.6,attackProgress:1,willFire:true,hasTarget:true},0);
      cat.updatePose(0,false,facing);
      close(right.p[0],fixedGrip[0]);close(right.p[1],fixedGrip[1]);
    }
  }
});

test('Attack flips the pivot after the single pose update and before sampling the muzzle', () => {
  const ts = require('typescript');
  const core = require('./.build/core/index.js');
  const load = name => {
    const source = fs.readFileSync(path.join(root, `assets/scripts/view/${name}.ts`), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } }).outputText;
    const moduleObject = { exports: {} };
    vm.runInNewContext(js, { exports: moduleObject.exports, require: name => name === '../core' ? core : {} });
    return moduleObject.exports[name];
  };
  const BattlefieldView = load('BattlefieldView'), CatView = load('CatView');
  const battlefield = Object.create(BattlefieldView.prototype), cat = Object.create(CatView.prototype);
  const operations = [];
  let elapsed = 0;
  Object.assign(cat, {
    node: { setPosition: () => {} }, setAimTarget: () => {}, setWeapon: () => {}, setAttackState: () => {},
    body: { setScale: x => operations.push(['facing', x]) },
    aimAngle: 147, faceAngle: 96, recoil: .073,
    updatePose: (dt, moving, facing) => {
      elapsed += dt; operations.push(['pose', facing]);
      cat.setFacing(facing);
    },
    getBulletSpawnOffset: height => {
      operations.push(['muzzle', cat.bodyMirror]);
      return { x: cat.bodyMirror, z: height };
    },
  });
  battlefield.cat = cat;
  battlefield.cats = new Map([[0,cat]]);
  const playerState = { position: { x: 0, z: 0 }, aim: { x: 0, z: 1 }, moving: true, facing: -1 };
  const offset = battlefield.prepareCatPose({ dt: 1 / 60, player: playerState, targetPoint: null, attackFacing: 1 });
  assert.deepEqual(operations, [['pose', -1], ['facing', 1], ['facing', -1], ['muzzle', -1]]);
  assert.equal(offset.x, -1);
  close(elapsed, 1 / 60);
  assert.equal(cat.aimAngle, 147); assert.equal(cat.faceAngle, 96); assert.equal(cat.recoil, .073);
  assert.equal(playerState.facing, -1, 'Preparing visual pose does not mutate the core context');
  operations.length = 0;
  battlefield.prepareCatPose({ dt: 1 / 60, player: playerState, targetPoint: null });
  assert.deepEqual(operations, [['pose', -1], ['facing', 1], ['muzzle', 1]]);
});

test('Battlefield teardown releases its map material before destroying the owned node hierarchy', () => {
  const ts=require('typescript');
  const source=fs.readFileSync(path.join(root,'assets/scripts/view/BattlefieldView.ts'),'utf8');
  const moduleObject={exports:{}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports:moduleObject.exports,require:()=>({})});
  const view=Object.create(moduleObject.exports.BattlefieldView.prototype),calls=[];
  view.cats=new Map([[0,{destroy:()=>calls.push('cat0')}],[1,{destroy:()=>calls.push('cat1')}]]);
  view.projectiles={destroy:()=>calls.push('projectiles')};
  view.moneyBurst={destroy:()=>calls.push('money')};
  view.map={destroy:()=>calls.push('map')};view.node={isValid:true,destroy:()=>calls.push('world')};
  view.pets = new Map(); view.retiredMineViews = [];
  view.destroy();assert.deepEqual(calls,['cat0','cat1','projectiles','money','map','world']);
});

test('Authored bow firing point matches the original 3D character chain and 40-degree CamDir', t => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, './fixtures/original-muzzle-position-source.json'), 'utf8'));
  const visuals = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/art/weapon-system/visuals.json'), 'utf8'));
  const gun = rig.attachments.gun, appearance = visuals.weapons[0], weapon = { ...appearance.image, muzzle: appearance.muzzle };
  const multiply = (a, b) => a.map(row => b[0].map((_, col) => row.reduce((sum, x, k) => sum + x * b[k][col], 0)));
  const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)));
  const quaternion = (x, y, z) => {
    const [sx, sy, sz] = [x, y, z].map(t => Math.sin(t / 2));
    const [cx, cy, cz] = [x, y, z].map(t => Math.cos(t / 2));
    // Unity Euler's Y * X * Z order.
    return [cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz,
      cy * cx * sz - sy * sx * cz, cy * cx * cz + sy * sx * sz];
  };
  const matrix3D = spec => {
    const [x, y, z, w] = spec.quaternion;
    const rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
    return [...rotation.map((row, i) => [...row.map((value, j) => value * spec.scale[j]), spec.position[i]]), [0, 0, 0, 1]];
  };
  const matrix2D = (p, degrees, scale) => {
    const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[c * scale[0], -s * scale[1], p[0]], [s * scale[0], c * scale[1], p[1]], [0, 0, 1]];
  };
  const imageMatrix = spec => matrix2D(spec.localPosition || [0, 0], spec.localRotationDeg || 0, spec.localScale || [1, 1]);
  const camMatrix = matrix3D({ quaternion: quaternion(...fixture.camDirEulerRadiansFromElf), position: [0, 0, 0], scale: [1, 1, 1] });
  const camDir = camMatrix.slice(0, 3).map(row => row[2]);
  let maximumVisibleError = 0, maximumPhysicalError = 0, maximumIntentionalSeparation = 0, count = 0;
  for (const facing of [-1, 1]) for (const name of ['idle', 'walk']) for (const frame of [0, 17, 30, 67, 105]) {
    const poses = rig.animations[name].frames[frame];
    for (const handAngle of [-90, 0, 30, 90, 130, 180]) for (const recoil of [0, .5, 1]) {
      const chain = structuredClone(fixture.chain);
      // Keep the extracted 3D character and its source camera as the reference,
      // replacing only the old pistol sprite/socket with the authored bow.
      chain[8].position = [...(weapon.localPosition ?? [0, 0]), 0];
      chain[8].quaternion = quaternion(Math.PI, 0, -(weapon.localRotationDeg ?? 0) * Math.PI / 180);
      chain[8].scale = [weapon.localScale[0], -weapon.localScale[1], .4];
      chain[9].position = [...weapon.muzzle.localPosition, 0];
      chain[1].quaternion = quaternion(...fixture.runtimePivotEuler[facing < 0 ? 'left' : 'right'].map(v => v * Math.PI / 180));
      for (const [index, bone] of [[3, 0], [4, 6]]) {
        chain[index].position.splice(0, 2, ...poses[bone].p);
        chain[index].scale.splice(0, 2, ...poses[bone].s);
        chain[index].quaternion = quaternion(0, 0, (bone === 6 ? handAngle : poses[bone].r) * Math.PI / 180);
      }
      chain[5].position[0] = rig.dynamics.recoil.position[0] * recoil;
      chain[7].scale.splice(0, 2, ...rig.dynamics.recoil.gunScale.map(v => 1 + (v - 1) * recoil));
      const original = chain.reduce((matrix, transform) => multiply(matrix, matrix3D(transform)), identity(4)).slice(0, 3).map(row => row[3]);
      const expectedSpawn = original.map((coordinate, i) => coordinate + (fixture.bulletHeight - original[1]) / camDir[1] * camDir[i]);
      const d = rig.display;
      let display = multiply(matrix2D([0, 0], 0, [-facing, d.projectionScaleY]), matrix2D(d.pivotOffset, 0, [d.scale, d.scale]));
      for (const bone of [0, 6]) display = multiply(display, matrix2D(poses[bone].p, bone === 6 ? handAngle : poses[bone].r, poses[bone].s));
      display = multiply(display, matrix2D([rig.dynamics.recoil.position[0] * recoil, 0], 0, [1, 1]));
      display = multiply(display, imageMatrix(gun));
      display = multiply(display, matrix2D([0, 0], 0, rig.dynamics.recoil.gunScale.map(v => 1 + (v - 1) * recoil)));
      display = multiply(display, imageMatrix(weapon));
      const local = [...weapon.muzzle.localPosition, 1], projected = display.slice(0, 2).map(row => row.reduce((sum, v, i) => sum + v * local[i], 0));
      const project = point => ['right', 'up'].map(axis => fixture.cameraBasis[axis].reduce((sum, value, i) => sum + value * point[i], 0));
      maximumVisibleError = Math.max(maximumVisibleError, Math.hypot(...project(original).map((v, i) => v - projected[i])));
      const actualSpawn = originalBulletSpawnOffset({ x: projected[0], y: projected[1] }, d.projectionScaleY, fixture.bulletHeight);
      maximumPhysicalError = Math.max(maximumPhysicalError, Math.hypot(actualSpawn.x - expectedSpawn[0], actualSpawn.z - expectedSpawn[2]));
      maximumIntentionalSeparation = Math.max(maximumIntentionalSeparation, Math.hypot(...project(expectedSpawn).map((v, i) => v - projected[i])));
      count++;
    }
  }
  assert.equal(count, 360);
  assert.ok(maximumVisibleError < 1e-6, `visible socket projection error ${maximumVisibleError}`);
  assert.ok(maximumPhysicalError < 1e-6, `original physical firing point error ${maximumPhysicalError}`);
  assert.ok(maximumIntentionalSeparation > .1, 'Original CamDir projection deliberately differs from aligning the bullet to the visible muzzle');
  t.diagnostic(`360 source-chain poses: max visible error ${maximumVisibleError}; max spawn XZ error ${maximumPhysicalError}; max authored screen separation ${maximumIntentionalSeparation}`);
});
