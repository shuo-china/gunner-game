const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, DecimalAmount: D, COMBAT_CONFIG: C } = require('./.build/core/index.js');
const { getWeapon } = require('./.build/core/WeaponCatalog.js');

function fixture() {
  const world = new CombatWorld(42);
  world.setLoadout([0, 1].map(actorIndex => ({ actorIndex, weapon: getWeapon(0), damage: D.from(100), attackInterval: .6 })));
  const follower = world.followers[0];
  follower.player.position = { x: 0, z: 0 };
  return { world, follower, context: {
    leader: world.player, leaderTarget: null, ownTarget: null, history: [], time: 1,
    separation: { x: 0, z: 0 }, pathClear: () => true, breadcrumb: p => p,
  } };
}

// Cat.GetBreadcrumbTarget (RVA 0x2b40f4c) clamps nearest+5 to Count-1,
// then falls back to the live leader only when that is also the nearest index.
test('follower lookahead keeps the final recorded turn until it becomes the nearest breadcrumb', () => {
  const { world } = fixture();
  world.player.position = { x: 10.2, z: 5.2 };
  world.breadcrumbs = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 5 }];
  assert.deepEqual(world.breadcrumbTarget({ x: 0, z: 0 }), { x: 10, z: 5 });
  assert.deepEqual(world.breadcrumbTarget({ x: 10, z: 0 }), { x: 10, z: 5 });
  assert.deepEqual(world.breadcrumbTarget({ x: 10, z: 5 }), world.player.position);
  world.breadcrumbs = Array.from({ length: 8 }, (_, x) => ({ x, z: 0 }));
  assert.deepEqual(world.breadcrumbTarget({ x: 0, z: 0 }), { x: 5, z: 0 });
  assert.deepEqual(world.breadcrumbTarget({ x: 2, z: 0 }), { x: 7, z: 0 });
  world.breadcrumbs = [];
  assert.deepEqual(world.breadcrumbTarget({ x: 3, z: 4 }), { x: 3, z: 4 });
});

// Cat.GetApproachPosition / AIReposition use squared distance < float0.001.
test('a follower almost coincident with its target uses the source right-vector fallback', () => {
  for (const offset of [0, .01, .031, .032]) {
    const { follower, context } = fixture();
    follower.player.position = { x: 0, z: offset };
    let requested;
    follower.update(.3, { ...context, ownTarget: { x: 0, z: 0 }, ownTargetHeight: 2,
      pathClear: (_from, to) => { requested = to; return true; } });
    assert.equal(follower.state, 'Reposition');
    assert.deepEqual(requested, offset * offset < C.retreatDirectionSquaredThreshold
      ? { x: 5.5, z: 0 } : { x: 0, z: 5.5 });
  }
});

test('a breadcrumb within the source movement tolerance stops the follower or uses separation drift', () => {
  for (const offset of [.0005, .001, .0011]) {
    for (const separationX of [0, Math.sqrt((.01 + Math.fround(.01)) / 2), 1]) {
      const { follower, context } = fixture();
      follower.player.position = { x: 20, z: 0 };
      const separation = { x: separationX, z: 0 }, separate = separationX !== 0;
      follower.update(.3, { ...context, separation, pathClear: () => false,
        breadcrumb: () => ({ x: 20, z: offset }) });
      assert.equal(follower.player.moving, offset > .0010000000474974513 || separate);
      if (offset <= .0010000000474974513) {
        assert.equal(follower.player.velocity.z, 0);
        if (separate) assert.ok(follower.player.velocity.x > 0);
        else assert.deepEqual(follower.player.velocity, { x: 0, z: 0 });
      } else assert.ok(follower.player.velocity.z > 0);
    }
  }
});

test('follower path checks skip source sub-centimeter routes but cast at the threshold', () => {
  const { world } = fixture();
  world.trees.splice(0, world.trees.length, { alive: true, collider: { minX: -.1, maxX: .1, minZ: -.1, maxZ: .1 } });
  for (const length of [.001, .009, .009999999776482582, .011]) {
    assert.equal(world.followerPathClear({ x: 0, z: 0 }, { x: length, z: 0 }), length < .009999999776482582);
  }
});
