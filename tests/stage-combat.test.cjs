const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, createStageDefinition, DecimalAmount: D, getWeapon } = require('./.build/core/index.js');

function target(id, z, health = '1e400') {
  const hp=D.from(health);
  return {id,position:{x:0,z},degree:0,stageIndex:1000,reward:D.from('1e398'),health:hp,maxHealth:hp,alive:true,
    collider:{minX:-1,maxX:1,minZ:z-1,maxZ:z+1}};
}
function armed(type,trees,damage='2e399') {
  const world=new CombatWorld(42);
  world.trees.splice(0,world.trees.length,...trees);world.stats.totalTrees=trees.length;
  world.setLoadout([{actorIndex:0,weapon:{...getWeapon(0),type,explosionRadius:4},damage:D.from(damage),attackInterval:.6}]);
  world.setMuzzleOffset({x:0,z:0});world.player.aim={x:0,z:1};
  return world;
}

for(const type of ['SINGLE','LASER','EXPLOSIVE'])test(`endless stage ${type} preserves nonlethal and lethal HP above Number range`,()=>{
  const world=armed(type,[target(0,10)]);
  assert.equal(world.fire(),true);world.updateBullets(.3);
  assert.equal(world.trees[0].health.compare('8e399'),0);
  assert.equal(world.trees[0].health.ratio(world.trees[0].maxHealth),.8);
  const first=world.drainEvents().find(event=>event.type==='hit');
  assert.equal(first.health.compare('8e399'),0);
  world.setCombatModifiers({damage:D.from('9e399'),attackInterval:.6});
  assert.equal(world.fire(),true);world.updateBullets(.3);
  const events=world.drainEvents();
  assert.equal(world.trees[0].health.isZero,true);
  assert.equal(events.filter(event=>event.type==='treeDied').length,1);
  assert.equal(events.filter(event=>event.type==='complete').length,1);
});

test('high-HP laser damages multiple targets without converting any HP to Number',()=>{
  const world=armed('LASER',[target(0,10),target(1,15)]);
  world.fire();world.updateBullets(.3);
  assert.deepEqual(world.trees.map(tree=>tree.health.toString()),['8e+399','8e+399']);
  assert.equal(world.drainEvents().filter(event=>event.type==='hit').length,2);
});

test('fifth-wave movement and projectiles use the extended north wall',()=>{
  const world=new CombatWorld(42,createStageDefinition(7,4,42));
  world.trees.splice(0);world.stats.totalTrees=0;
  world.player.position={x:0,z:280};
  world.moveAndSlide({x:0,z:15});
  assert.equal(world.player.position.z,295);
  world.moveAndSlide({x:0,z:100});
  assert.equal(world.player.position.z,306);
  world.player.position={x:0,z:280};world.player.aim={x:0,z:1};world.setMuzzleOffset({x:0,z:0});
  world.fire();world.updateBullets(.3);
  assert.equal(world.bullets[0].damaging,true,'old first-wave wall at z107.5 is not used');
  world.updateBullets(.2);
  assert.equal(world.bullets[0].damaging,false);
  assert.equal(world.bulletWalls[1].minZ,307.5);
});

test('historical replay doubles leader movement without doubling attack clocks or world time',()=>{
  const normal=new CombatWorld(42),replay=new CombatWorld(42);
  replay.setMovementMultiplier(2);
  normal.step(.1);replay.step(.1);
  assert.equal(replay.player.velocity.x,normal.player.velocity.x*2);
  assert.equal(replay.player.velocity.z,normal.player.velocity.z*2);
  assert.equal(replay.attackClock,normal.attackClock);
  assert.equal(replay.simulationTime,normal.simulationTime);
});

for(const type of ['SINGLE','LASER','PIERCE','BLAST_SNIPER','EXPLOSIVE'])test(`settled ${type} still flies, collides and expires while Enemy.Damage is gated`,()=>{
  const world=armed(type,[target(0,10),target(1,15)]);
  world.fire();world.drainEvents();
  const bullet=world.bullets[0],health=world.trees.map(tree=>tree.health),player={...world.player.position};
  world.stopCombat();
  assert.equal(bullet.damaging,true,'stopCombat must not call DieAndWait on an in-flight bullet');
  world.advanceEffects(.02);
  assert.ok(bullet.position.z>0);assert.equal(bullet.damaging,true);
  for(let i=0;i<180;i++)world.step(1/60);
  const events=world.drainEvents();
  assert.ok(events.some(event=>event.type==='impact'),'normal contact FX remains visible');
  assert.ok(events.some(event=>event.type==='damageText'),'source still emits visual damage text after timeout');
  assert.equal(events.some(event=>['shot','hit','treeDied','complete'].includes(event.type)),false);
  assert.deepEqual(world.trees.map(tree=>tree.health),health);
  assert.deepEqual(world.player.position,player);assert.equal(world.stats.elapsed,0);
  assert.equal(world.bullets.filter(bullet=>bullet.active).length,0);
});

test('settled pierce retains the source theoretical-kill pass rule although health cannot change',()=>{
  const world=armed('PIERCE',[target(0,10),target(1,15)],'2e400');
  world.fire();world.stopCombat();
  for(let i=0;i<15;i++)world.advanceEffects(.02);
  const bullet=world.bullets[0];
  assert.equal(bullet.damaging,true);assert.ok(bullet.position.z>16);
  assert.deepEqual(bullet.hitIds,[0,1]);assert.ok(world.trees.every(tree=>tree.alive));
});

test('settled missile keeps its arc and impact without damage; full pause freezes its entire lifecycle',()=>{
  const world=armed('MISSILE',[target(0,30)]);
  world.setLoadout([{actorIndex:0,weapon:{...getWeapon(0),type:'MISSILE',missileSpeed:30,missileExplosionRadius:4},
    damage:D.from('2e400'),attackInterval:.6}]);
  world.player.targetId=0;world.fire();world.drainEvents();world.stopCombat();
  const bullet=world.bullets[0],health=world.trees[0].health;
  world.advanceEffects(.1);assert.ok(bullet.position.z>0);assert.ok(bullet.height>2);
  world.pause();const frozen=JSON.stringify(bullet),clock=world.simulationTime;
  world.advanceEffects(.1);world.step(.1);
  assert.equal(JSON.stringify(bullet),frozen);assert.equal(world.simulationTime,clock);
  world.resume();for(let i=0;i<180;i++)world.advanceEffects(1/60);
  const events=world.drainEvents();
  assert.equal(events.filter(event=>event.type==='impact').length,1);
  assert.equal(events.some(event=>event.type==='hit'||event.type==='treeDied'),false);
  assert.equal(world.trees[0].health,health);assert.equal(bullet.active,false);
});

test('settled straight shots still hit map walls rather than vanishing at the result boundary',()=>{
  const world=armed('SINGLE',[]);world.player.position={x:0,z:100};
  world.fire();world.drainEvents();world.stopCombat();
  for(let i=0;i<8;i++)world.advanceEffects(.02);
  const bullet=world.bullets[0],impact=world.drainEvents().find(event=>event.type==='impact');
  assert.equal(bullet.damaging,false);assert.ok(impact);assert.equal(impact.position.z,107.5);
});
