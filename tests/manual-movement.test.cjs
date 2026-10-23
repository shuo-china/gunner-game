const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, COMBAT_CONFIG: C, DecimalAmount: D, getWeapon, createStageDefinition,
  createSpeedRunDefinition, createBossDefinition, BossCombat, createRaidDefinition, RaidBossCombat,
  manualVelocity, manualLookDirection, clampMovementInput, MANUAL_INPUT_SQUARED_THRESHOLD: threshold } = require('./.build/core/index.js');
const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function emptyWorld(stage = createStageDefinition(0, 0, 42)) {
  const world = new CombatWorld(42, stage);
  world.trees.length = 0;
  return world;
}

test('original manual mapping preserves analog magnitude, anisotropy and all eight directions', () => {
  // Independent source oracle: float32 ScreenSpeedK=1.2000000476837158,
  // Quaternion.Euler(0,-45,0), Balance_Reload main speed=15.
  const a = 8.838834413611019, b = 12.727922567112344;
  for (const [x, y, vx, vz] of [[1,0,a,a],[-1,0,-a,-a],[0,1,-b,b],[0,-1,b,-b],
    [.6,.8,.6*a-.8*b,.6*a+.8*b],[-.6,.8,-.6*a-.8*b,-.6*a+.8*b],
    [.6,-.8,.6*a+.8*b,.6*a-.8*b],[-.6,-.8,-.6*a+.8*b,-.6*a-.8*b]]) {
    const v = manualVelocity({ x, y }, 15);
    close(v.x, vx); close(v.z, vz);
    const half = manualVelocity({ x:x/2, y:y/2 }, 15);
    close(half.x, vx/2); close(half.z, vz/2);
  }
  assert.deepEqual(clampMovementInput({ x:3, y:4 }), { x:.6, y:.8 });
  assert.deepEqual(clampMovementInput({ x:NaN, y:1 }), { x:0, y:0 });
});

test('source equality selects manual handling but Walk needs strictly greater squared input', () => {
  for (const squared of [threshold - 1e-10, threshold, threshold + 1e-10]) {
    const world = emptyWorld();
    world.setMovementInput({ x:Math.sqrt(squared), y:0 });
    world.updateAutoTarget = () => { world.automaticCalled = true; };
    world.step(.001);
    assert.equal(!!world.automaticCalled, squared < threshold);
    assert.equal(world.player.moving, squared > threshold);
  }
});

test('manual velocity is immediate, uses current multiplier and is consumed by the next fixed step', () => {
  const world = emptyWorld(); world.setMovementMultiplier(2);
  world.setMovementInput({ x:.5, y:0 }); world.step(.01);
  close(world.player.velocity.x, 8.838834413611019);
  assert.deepEqual(world.player.position, {x:0,z:0});
  world.step(.01); close(world.player.position.x, world.player.velocity.x * C.physicsStep);
});

test('manual clears auto movement state while retaining independently locked attack and clock', () => {
  const world = emptyWorld(); world.autoTargetId = 123; world.autoSearchTimer = .2;
  world.autoSmoothVelocity = {x:8,z:9}; world.lockedAttackTargetId = 91; world.attackClock = .42;
  world.clearAutoMovement();
  assert.equal(world.autoTargetId, null); assert.equal(world.autoSearchTimer, 0);
  assert.deepEqual(world.autoSmoothVelocity, {x:0,z:0});
  assert.equal(world.lockedAttackTargetId, 91); assert.equal(world.attackClock, .42);
});

test('release restarts automatic search and smoothing from zero rather than manual inertia', () => {
  const world = new CombatWorld(42);
  world.setMovementInput({ x:-1, y:0 }); world.step(.01);
  assert.equal(world.autoTargetId, null);
  world.setMovementInput({ x:0, y:0 }); world.step(.01);
  assert.notEqual(world.autoTargetId, null);
  assert.ok(Math.hypot(world.player.velocity.x,world.player.velocity.z) < 2);
  assert.deepEqual(world.player.velocity, world.autoSmoothVelocity);
});

test('automatic attacks continue while moving manually, without resetting cooldown each frame', () => {
  const world = new CombatWorld(42); world.setMovementInput({x:.03,y:0});
  for (let i=0;i<240;i++) world.step(1/60);
  assert.ok(world.stats.shots >= 4); assert.ok(world.stats.hits > 0);
  assert.equal(world.autoTargetId,null); assert.ok(world.player.moving);
});

test('raw manual look reaches the pose adapter without creating an attack target', () => {
  const world = emptyWorld(), samples=[]; world.setMuzzleProvider(ctx => { samples.push(ctx); return null; });
  world.setMovementInput({x:.6,y:.8}); world.step(.01);
  const ctx=samples.at(-1); assert.equal(ctx.targetPoint,null); assert.equal(ctx.willFire,false);
  assert.deepEqual(ctx.manualLookDirection,manualLookDirection({x:.6,y:.8}));
  assert.equal(world.player.facing,1);
  world.setMovementInput({x:0,y:1});world.step(.01);assert.equal(world.player.facing,-1);
});

test('stopped combat permits unobscured manual movement but never attacks or advances combat time', () => {
  const world=emptyWorld();world.stopCombat();world.setMovementInput({x:1,y:0});
  for(let i=0;i<60;i++)world.advanceEffects(1/60);
  assert.ok(world.player.position.x>5);assert.equal(world.stats.shots,0);assert.equal(world.stats.elapsed,0);
  world.setBattlefieldActive(false);const p={...world.player.position};
  world.advanceEffects(.1);assert.deepEqual(world.player.position,p);assert.equal(world.player.moving,false);
});

test('cancel, pause and reset remove manual velocity without overwriting automatic state', () => {
  for(const action of ['clearMovementInput','pause','reset']){
    const world=emptyWorld();world.setMovementInput({x:1,y:0});world.step(.01);world[action]();
    assert.deepEqual(world.currentMovementInput,{x:0,y:0});assert.deepEqual(world.player.velocity,{x:0,z:0});
  }
  const world=emptyWorld();world.autoSmoothVelocity={x:3,z:4};world.player.velocity={x:3,z:4};
  world.clearMovementInput();assert.deepEqual(world.player.velocity,{x:3,z:4});
});

test('manual movement respects existing tree and map wall collision', () => {
  const world=new CombatWorld(42);world.setMovementInput({x:1,y:0});
  for(let i=0;i<600;i++)world.step(1/60);
  assert.ok(world.player.position.x <= world.stage.bounds.maxX-C.playerRadius+1e-5);
  for(const tree of world.trees.filter(t=>t.alive)){
    const c=tree.collider,p=world.player.position;
    const dx=p.x-Math.max(c.minX,Math.min(c.maxX,p.x)),dz=p.z-Math.max(c.minZ,Math.min(c.maxZ,p.z));
    assert.ok(dx*dx+dz*dz >= C.playerRadius*C.playerRadius-1e-3);
  }
});

test('three-cat formation follows manual leader and preserves independent teammate control', () => {
  const world=emptyWorld();world.setLoadout([0,1,2].map(actorIndex=>({actorIndex,weapon:getWeapon(0),damage:D.from(100),attackInterval:.6})));
  const initial=world.players.slice(1).map(p=>({...p.position}));
  world.setMovementInput({x:0,y:1});for(let i=0;i<180;i++)world.step(1/60);
  assert.equal(world.players.length,3);
  for(let i=1;i<3;i++){assert.notDeepEqual(world.players[i].position,initial[i-1]);assert.notDeepEqual(world.players[i].velocity,world.player.velocity);}
});

test('Main, SpeedRun, Boss and Raid use the same manual input path at different frame rates', () => {
  const stages=[()=>createStageDefinition(0,0,42),()=>createSpeedRunDefinition(0,42),()=>createBossDefinition(new BossCombat(0,42)),
    ()=>createRaidDefinition(new RaidBossCombat(0,42))];
  for(const stage of stages)for(const fps of [30,60,120]){
    const world=new CombatWorld(42,stage());world.setMovementInput({x:.25,y:0});world.step(1/fps);
    close(world.player.velocity.x,8.838834413611019*.25);assert.equal(world.autoTargetId,null);
  }
});
