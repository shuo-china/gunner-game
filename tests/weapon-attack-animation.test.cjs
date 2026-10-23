const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WeaponAttackAnimator, sampleWeaponAttack, bowStringPoints } = require('./.build/character/WeaponAttackAnimation.js');
const { CombatWorld, DecimalAmount: D, treeCollider, getWeapon } = require('./.build/core/index.js');
const categories = ['bow', 'crossbow', 'glove', 'staff', 'fan', 'handgun', 'cannon'];
const state = (fields = {}) => ({ attackInterval: .6, attackProgress: .9, willFire: false, hasTarget: true, ...fields });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('all seven attacks release immediately before muzzle sampling, including the first shot', () => {
  for (const category of categories) {
    const animator = new WeaponAttackAnimator();
    const release = animator.sample(category, state({ attackProgress: 0, willFire: true }), 0);
    assert.equal(release.phase, 'release');
    assert.equal(release.rightArmRotation, 0);
    assert.equal(release.weaponRotation, category === 'staff' ? -26 : 0);
    close(release.weaponOffset[0], 0); close(release.weaponOffset[1], 0);
    assert.deepEqual(release.weaponScale, [1, 1]);
    const recovery = animator.sample(category, state({ attackProgress: .05 }), .03);
    assert.equal(recovery.phase, 'recover');
    assert.notDeepEqual(recovery, release);
  }
});

test('staff cast rotates only the holding palm and keeps the accepted release and effect timing', () => {
  const sample = time => sampleWeaponAttack('staff',state({attackProgress:(time+.31)/.6}),Infinity);
  const initial = sample(0), raised = sample(.21);
  assert.equal(initial.staffCast.holdingRotation,0);
  assert.equal(initial.rightArmRotation,0);assert.equal(initial.staffCast.charge,0);
  close(raised.staffCast.holdingRotation,6);close(raised.weaponRotation,-72);
  for(let frame=0;frame<=60;frame++) {
    const pose=frame<29?sample(frame/100):sampleWeaponAttack('staff',state({attackProgress:0}),frame/100-.29);
    assert.deepEqual(pose.weaponOffset,[0,0]);assert.equal(pose.supportGripOffset,null);
    assert.equal(pose.rightArmRotation,0);
    close(pose.staffCast.holdingRotation,pose.weaponRotation+78);
  }
  for(const interval of [.02,.1,.6,.7,2]) {
    const animator=new WeaponAttackAnimator();
    const release=animator.sample('staff',state({attackInterval:interval,attackProgress:0,willFire:true}),0);
    assert.equal(release.phase,'release');close(release.staffCast.time,.29);
    close(release.staffCast.holdingRotation,52);
    assert.equal(release.staffCast.charge,0);close(release.weaponRotation,-26);
    const flash=animator.sample('staff',state({attackInterval:interval,attackProgress:0}),interval*.0325/.6);
    close(flash.staffCast.flash,1);
    const returned=animator.sample('staff',state({attackInterval:interval,attackProgress:0,hasTarget:false}),interval*.30/.6);
    assert.equal(returned.phase,'idle');assert.equal(returned.staffCast.holdingRotation,0);
    assert.equal(returned.staffCast.flash,0);assert.equal(returned.staffCast.charge,0);
    close(returned.weaponRotation,initial.weaponRotation);
  }
});

test('staff charge cancels on target loss and reset without delayed or accumulated poses',()=>{
  const animator=new WeaponAttackAnimator();
  const charged=animator.sample('staff',state({attackProgress:.97}),0);
  assert.ok(charged.staffCast.charge>.9);
  const blocked=animator.sample('staff',state({attackProgress:1,willFire:false}),0);
  assert.equal(blocked.phase,'windup');assert.equal(blocked.staffCast.charge,1);
  assert.equal(blocked.staffCast.flash,0,'a full projectile pool must not release the charge');
  const idle=animator.sample('staff',state({hasTarget:false,attackProgress:0}),0);
  assert.equal(idle.staffCast.charge,0);assert.equal(idle.staffCast.holdingRotation,0);
  for(let shot=0;shot<3;shot++) {
    const released=animator.sample('staff',state({willFire:true}),0);
    close(released.staffCast.holdingRotation,52);
    animator.sample('staff',state(),.03);
  }
  animator.reset();
  assert.deepEqual(animator.sample('staff',state({hasTarget:false,attackProgress:0}),0),idle);
});

test('staff sub-frame flashes remain visible on the real release without creating a second release',()=>{
  for(const fps of [30,60,120])for(const interval of [.005,.02,.1,.7]) {
    const animator=new WeaponAttackAnimator(),dt=1/fps;
    const release=animator.sample('staff',state({attackInterval:interval,willFire:true,attackProgress:0}),dt);
    assert.equal(release.phase,'release');close(release.staffCast.holdingRotation,52);
    if(dt>=interval*.065/.6)assert.equal(release.staffCast.flash,1);
    else assert.equal(release.staffCast.flash,0);
    const after=animator.sample('staff',state({attackInterval:interval,willFire:false,hasTarget:false,attackProgress:0}),dt);
    assert.notEqual(after.phase,'release');
    if(dt>=interval*.065/.6)assert.equal(after.staffCast.flash,0,'an expired short pulse must not persist');
    const idle=animator.sample('staff',state({attackInterval:interval,willFire:false,hasTarget:false,attackProgress:0}),interval);
    assert.equal(idle.staffCast.holdingRotation,0);
    assert.equal(idle.staffCast.charge,0);assert.equal(idle.staffCast.flash,0);
  }
});

test('weapon families retain distinct hand use and keep fan artwork open', () => {
  const bow = sampleWeaponAttack('bow', state());
  assert.deepEqual(bow.weaponScale, [1, 1], 'drawing never squashes the bow artwork');
  assert.ok(bow.supportGripOffset[0] < -.8, 'string hand pulls backward while bow grip stays registered');
  const cannon = sampleWeaponAttack('cannon', state(), .07);
  const handgun = sampleWeaponAttack('handgun', state(), .05);
  assert.ok(cannon.weaponOffset[0] < handgun.weaponOffset[0], 'cannon has heavier recoil');
  assert.ok(cannon.supportGripOffset[0] > 0);
  assert.equal(handgun.supportGripOffset, null);
  assert.equal(sampleWeaponAttack('glove', state()).hideHoldingHand, true);
  assert.equal(sampleWeaponAttack('crossbow', state()).hideHoldingHand, false);
  assert.ok(sampleWeaponAttack('staff', state()).weaponRotation < -30);
  for (const phase of [0, .2, .5, .9, 1]) {
    assert.deepEqual(sampleWeaponAttack('fan', state({ attackProgress: phase })).weaponScale, [1, 1]);
  }
});

test('bow string follows the drawing hand until release, then rebounds while the holding hand stays fixed', () => {
  const spec = { upperPx: [80, 12], lowerPx: [80, 132], bracePx: [80, 72], drawPx: 32 };
  const draws = [.38, .55, .75, .96].map(attackProgress => sampleWeaponAttack('bow', state({ attackProgress })));
  const points = draws.map(pose => bowStringPoints(spec, pose));
  for (let i = 0; i < points.length; i++) {
    assert.deepEqual(points[i].nock, points[i].hand);
    assert.deepEqual(points[i].upper, spec.upperPx); assert.deepEqual(points[i].lower, spec.lowerPx);
    assert.deepEqual(draws[i].weaponOffset, [0, 0]); assert.deepEqual(draws[i].weaponScale, [1, 1]);
    assert.equal(draws[i].rightArmRotation, 0); assert.equal(draws[i].holdingArmReach, draws[0].holdingArmReach);
    if (i) assert.ok(points[i].nock[0] < points[i - 1].nock[0]);
  }
  const animator = new WeaponAttackAnimator();
  const release = animator.sample('bow', state({ willFire: true }), 1 / 60), released = bowStringPoints(spec, release);
  assert.deepEqual(released.nock, spec.bracePx, 'string reaches its brace on the real release frame');
  assert.deepEqual(released.hand, [48, 72], 'drawing hand does not teleport forward with the string');
  const follow = animator.sample('bow', state({ attackProgress: .03 }), .018);
  assert.ok(Math.abs(follow.bowStringPull) < .075); assert.ok(follow.bowHandPull > .95);
  const ready = animator.sample('bow', state({ attackProgress: .32 }), .18);
  assert.equal(ready.bowHandPull, 0); assert.equal(ready.bowStringPull, 0);
  assert.deepEqual(ready.weaponOffset, release.weaponOffset);
});

test('bow hand retreat translates the entire pull path and smoothly rejoins the released string',()=>{
  const original={upperPx:[80,12],lowerPx:[80,132],bracePx:[80,72],drawPx:32};
  const shifted={...original,handRetreatPx:12};
  for(const progress of [0,.38,.55,.75,.96]) {
    const pose=sampleWeaponAttack('bow',state({attackProgress:progress}));
    const before=bowStringPoints(original,pose),after=bowStringPoints(shifted,pose);
    close(after.hand[0],before.hand[0]-12);close(after.hand[1],before.hand[1]);
    assert.deepEqual(after.hand,after.nock,'held string and palm remain coincident');
    assert.deepEqual(after.upper,before.upper);assert.deepEqual(after.lower,before.lower);
  }
  for(const interval of [.02,.1,.6]) {
    const duration=Math.min(.16,interval*.35);
    const release=sampleWeaponAttack('bow',state({attackInterval:interval,willFire:true}),0);
    const points=bowStringPoints(shifted,release);
    assert.deepEqual(points.nock,original.bracePx,'release still springs to the original brace');
    assert.deepEqual(points.hand,[36,72],'release preserves the retreated fully drawn palm');
    let previous=points;
    for(let frame=1;frame<=100;frame++) {
      const pose=sampleWeaponAttack('bow',state({attackInterval:interval,attackProgress:0}),duration*frame/100);
      const before=bowStringPoints(original,pose),after=bowStringPoints(shifted,pose);
      close(after.hand[0],before.hand[0]-12);
      assert.ok(Math.abs(after.nock[0]-previous.nock[0])<1,'returning string moves continuously');
      previous=after;
    }
    assert.deepEqual(previous.hand,previous.nock,'palm rejoins the held string at the end of recovery');
    assert.deepEqual(previous.hand,[68,72]);
  }
});

test('battle bow draw scale shortens only string and hand travel while preserving registration and release timing',()=>{
  const spec={upperPx:[80,12],lowerPx:[80,132],bracePx:[80,72],drawPx:32,handRetreatPx:12};
  const saved=structuredClone(spec);
  const phases=[sampleWeaponAttack('bow',state({hasTarget:false,attackProgress:0})),
    ...[0,.38,.55,.75,.96].map(attackProgress=>sampleWeaponAttack('bow',state({attackProgress}))),
    sampleWeaponAttack('bow',state({willFire:true}),0),
    ...[.018,.05,.12,.16].map(elapsed=>sampleWeaponAttack('bow',state({attackProgress:0}),elapsed))];
  for(const pose of phases) {
    const original=bowStringPoints(spec,pose),scaled=bowStringPoints(spec,pose,.90);
    const noTravel=bowStringPoints({...spec,drawPx:0},pose);
    for(const name of ['hand','nock']) {
      close(scaled[name][0]-noTravel[name][0],.9*(original[name][0]-noTravel[name][0]));
      close(scaled[name][1],original[name][1]);
    }
    assert.deepEqual(scaled.upper,spec.upperPx);assert.deepEqual(scaled.lower,spec.lowerPx);
    assert.deepEqual(bowStringPoints(spec,pose,1),original,'previews retain their full registered travel by default');
    if(pose.phase==='release') {
      assert.deepEqual(scaled.nock,spec.bracePx,'the actual firing frame still releases to the original brace');
      close(scaled.hand[0],80-12-32*.9);
    } else if(pose.phase!=='recover') assert.deepEqual(scaled.nock,scaled.hand);
  }
  assert.deepEqual(spec,saved,'battle scaling never mutates the asset or the full-span radius reference');
});

test('crossbows and gloves reproduce the source linear gun compression and return without wrist rotation', () => {
  const recoil=require('../assets/resources/art/characters/cat_basic/rig.json').dynamics.recoil;
  for(const category of ['crossbow','glove'])for(const [fraction,pulse] of [[0,0],[.25,.5],[.5,1],[.75,.5],[1,0],[2,0]]) {
    const pose=sampleWeaponAttack(category,state(),recoil.duration*fraction,recoil);
    close(pose.weaponOffset[0],recoil.position[0]*pulse);
    close(pose.weaponScale[0],1+(recoil.gunScale[0]-1)*pulse);
    close(pose.weaponScale[1],1+(recoil.gunScale[1]-1)*pulse);
    assert.equal(pose.rightArmRotation,0);assert.equal(pose.weaponRotation,0);
    assert.equal(pose.weaponOffset[1],0);
    assert.equal(pose.supportGripOffset,null,'source gun hands keep their original animated positions');
  }
  for(const category of ['crossbow','glove'])for(const interval of [.02,.1,.3,.6]) {
    const duration=Math.min(recoil.duration,interval*.8),animator=new WeaponAttackAnimator();
    const fire=animator.sample(category,state({attackInterval:interval,willFire:true}),0,recoil);
    assert.equal(fire.phase,'release');assert.deepEqual(fire.weaponScale,[1,1]);
    const peak=animator.sample(category,state({attackInterval:interval}),duration/2,recoil);
    close(peak.weaponScale[0],recoil.gunScale[0]);close(peak.weaponOffset[0],recoil.position[0]);
    const returned=animator.sample(category,state({attackInterval:interval}),duration/2,recoil);
    assert.deepEqual(returned.weaponScale,[1,1]);close(returned.weaponOffset[0],0);
    assert.equal(returned.phase,'ready','high attack speed finishes compression before the next volley');
  }
});

test('gloves hold a steady aim before firing and can restart source recoil without accumulating scale', () => {
  const animator=new WeaponAttackAnimator(),recoil=require('../assets/resources/art/characters/cat_basic/rig.json').dynamics.recoil;
  for(const attackProgress of [0,.5,.9,1]) {
    const ready=animator.sample('glove',state({attackProgress}),.05,recoil);
    assert.equal(ready.phase,'ready');assert.equal(ready.rightArmRotation,0);assert.equal(ready.weaponRotation,0);
    close(ready.weaponOffset[0],0);close(ready.weaponOffset[1],0);assert.deepEqual(ready.weaponScale,[1,1]);
    assert.equal(ready.hideHoldingHand,true);
  }
  for(let volley=0;volley<3;volley++) {
    const fire=animator.sample('glove',state({willFire:true}),.01,recoil);
    assert.equal(fire.phase,'release');assert.deepEqual(fire.weaponScale,[1,1]);close(fire.weaponOffset[0],0);close(fire.weaponOffset[1],0);
    const peak=animator.sample('glove',state(),recoil.duration/2,recoil);
    assert.deepEqual(peak.weaponScale,recoil.gunScale);assert.deepEqual(peak.weaponOffset,recoil.position);
  }
});

test('attack recovery is independent of frame rate, resets cleanly and does not accumulate transforms', () => {
  for (const category of categories) {
    const frames = [30, 60, 120].map(fps => {
      const animator = new WeaponAttackAnimator();
      animator.sample(category, state({ willFire: true }), 0);
      let pose;
      for (let i = 0; i < fps / 10; i++) pose = animator.sample(category, state({ attackProgress: .1 / .6 }), 1 / fps);
      return pose;
    });
    for (const pose of frames.slice(1)) {
      close(pose.weaponOffset[0], frames[0].weaponOffset[0]);
      close(pose.rightArmRotation, frames[0].rightArmRotation);
    }
    const animator = new WeaponAttackAnimator();
    animator.sample(category, state({ willFire: true }), 0);
    animator.sample(category, state(), .03);
    animator.reset();
    const idle = animator.sample(category, state({ hasTarget: false, attackProgress: 0 }), .1);
    assert.deepEqual(idle, sampleWeaponAttack(category, state({ hasTarget: false, attackProgress: 0 })));
  }
});

function worldFixture() {
  const world = new CombatWorld(42);
  const position = { x: 2, z: 10 };
  world.trees.splice(0, world.trees.length, { id: 1000, position, health: D.from('1e30'), maxHealth: D.from('1e30'),
    degree: 0, alive: true, collider: treeCollider(position) });
  world.stats.totalTrees = 1;
  return world;
}

test('core announces one release for a shotgun volley before any projectile origin is captured', () => {
  const world = worldFixture(), samples = [];
  world.setLoadout([{ actorIndex: 0, weapon: { ...getWeapon(0), type: 'SHOTGUN', pelletCount: 4 }, damage: D.from(10), attackInterval: .6 }]);
  world.setMuzzleProvider(context => {
    assert.equal(world.drainEvents().filter(event => event.type === 'shot').length, 0, 'shot is emitted after pose is prepared');
    samples.push(context);
    return { x: context.willFire ? 2.25 : 0, z: 0 };
  });
  let volleys = 0;
  for (let i = 0; i < 120; i++) {
    world.step(1 / 60);
    const shots = world.drainEvents().filter(event => event.type === 'shot');
    const sample = samples.at(-1);
    assert.equal(sample.willFire, shots.length > 0);
    assert.ok(sample.attackProgress >= 0 && sample.attackProgress <= 1);
    assert.equal(sample.attackInterval, .6);
    if (shots.length) {
      volleys++;
      assert.equal(shots.length, 4);
      assert.equal(shots.filter(event => event.pelletIndex === 0).length, 1);
      for (const shot of shots) close(shot.position.x - sample.player.position.x, 2.25);
    }
  }
  assert.ok(volleys >= 2);
  assert.equal(samples.filter(sample => sample.willFire).length, volleys);
});

test('all eight crossbows keep their same-grade arrow counts and trigger one recoil per volley', () => {
  for(const [id,count] of [[1,2],[3,2],[6,3],[10,3],[14,3],[62,2],[63,2],[64,3]]) {
    const world=worldFixture(),weapon=getWeapon(id),animator=new WeaponAttackAnimator();
    world.setLoadout([{actorIndex:0,weapon,damage:D.from(10),attackInterval:weapon.attackInterval}]);
    let releases=0,volleys=0;
    world.setMuzzleProvider(context=>{
      const pose=animator.sample('crossbow',context,context.dt);
      if(context.willFire) {releases++;assert.equal(pose.phase,'release');assert.deepEqual(pose.weaponScale,[1,1]);}
      return {x:1,z:0};
    });
    for(let frame=0;frame<180;frame++) {
      world.step(1/60);
      const shots=world.drainEvents().filter(event=>event.type==='shot');
      if(shots.length) {volleys++;assert.equal(shots.length,count,weapon.name);}
    }
    assert.ok(volleys>1);assert.equal(releases,volleys);
  }
});

test('full projectile pool does not announce a visual release that cannot emit', () => {
  const world = worldFixture(), samples = [];
  world.setMuzzleProvider(context => { samples.push(context); return { x: 0, z: 0 }; });
  for (const bullet of world.bullets) { bullet.active = true; bullet.damaging = true; }
  world.attackClock = .6;
  world.sampleMuzzle(0, world.trees[0], 1);
  assert.equal(samples.at(-1).willFire, false);
  world.bullets[0].damaging = false;
  world.sampleMuzzle(0, world.trees[0], 1);
  assert.equal(samples.at(-1).willFire, true, 'a reusable non-damaging bullet can emit');
  world.sampleMuzzle(0);
  assert.equal(samples.at(-1).willFire, false);
  assert.equal(samples.at(-1).attackProgress, 0);
});
