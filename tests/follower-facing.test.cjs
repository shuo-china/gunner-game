const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, DecimalAmount: D } = require('./.build/core/index.js');
const { getWeapon } = require('./.build/core/WeaponCatalog.js');

function fixture() {
  const world = new CombatWorld(42);
  world.setLoadout([0, 1].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 })));
  const follower = world.followers[0];
  follower.player.position = { x: 0, z: 0 };
  return { world, follower, context: {
    leader: world.player, leaderTarget: null, ownTarget: null, history: [], time: 1,
    separation: { x: 0, z: 0 }, pathClear: () => true, breadcrumb: () => ({ x: 0, z: 0 }),
  } };
}

// Cat.AIFollow/AIAttackStay/SmoothMoveTowardWithAvoidance read nearObj.transform
// for body facing, while Attack/CalcBulletDir keeps aiming at nearHitPoint.
test('followers face the collider center consistently between shots even when a hit face projects to the other side', () => {
  for (const state of ['Follow', 'Attack', 'Chase', 'Reposition']) {
    const { follower, context } = fixture();
    follower.state = state; follower.stateTime = 0;
    follower.player.facing = -1;
    follower.update(.02, { ...context, ownTarget: { x: 7, z: -9 }, ownTargetCenter: { x: 10, z: -9 } });
    assert.equal(follower.state, state, 'the minimum state dwell time retains the tested state');
    assert.equal(follower.player.facing, 1, state);
    assert.ok(follower.player.aim.x + follower.player.aim.z < 0, 'the shot still aims at the near surface');
  }
});

test('a following cat faces its requested route immediately while residual velocity still points the other way', () => {
  const { follower, context } = fixture();
  follower.player.position = { x: 15, z: 0 };
  follower.player.velocity = { x: 10, z: 0 };
  follower.player.facing = 1;
  follower.update(.01, context);
  assert.ok(follower.player.velocity.x > 0, 'the old velocity is still decelerating');
  assert.equal(follower.player.facing, -1, 'SmoothMove faces its requested direction');
});

test('stopping and separation drift preserve follower facing without a target', () => {
  for (const separation of [{ x: 0, z: 0 }, { x: 1, z: 0 }]) {
    const { follower, context } = fixture();
    follower.player.velocity = { x: 10, z: 0 };
    follower.player.facing = -1;
    follower.update(.02, { ...context, separation });
    assert.ok(follower.player.velocity.x > 0);
    assert.equal(follower.player.facing, -1);
  }
});

test('losing a target during Chase or Reposition preserves motion until the state dwell time expires', () => {
  for (const state of ['Chase', 'Reposition']) {
    const { follower, context } = fixture();
    follower.state = state; follower.stateTime = 0;
    follower.player.velocity = { x: 3, z: 4 };
    follower.player.moving = true; follower.player.facing = -1;
    follower.update(.02, context);
    assert.equal(follower.state, state);
    assert.deepEqual(follower.player.velocity, { x: 3, z: 4 });
    assert.equal(follower.player.moving, true);
    assert.equal(follower.player.facing, -1);
    follower.update(.3, context);
    assert.equal(follower.state, 'Follow');
    assert.equal(follower.player.moving, false);
  }
});
