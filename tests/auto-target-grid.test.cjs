const test = require('node:test');
const assert = require('node:assert/strict');
const { CombatWorld, createStageDefinition, treeCollider } = require('./.build/core/index.js');

// Source Cat.FindNearestTreeByGrid: the authored bank bounds decide which
// Tree_list arrays are visited before ordinary root-distance scoring.
const tree = (id, x, z, gridOriginZ) => ({ id, position: { x, z }, gridOriginZ,
  alive: true, health: 250, maxHealth: 250, degree: 0, collider: treeCollider({ x, z }) });
function fixture(position, ...trees) {
  const world = new CombatWorld(1);
  world.trees.splice(0, world.trees.length, ...trees);
  world.player.position = position;
  return world;
}

test('all five authored banks carry their source origins, while Boss_tree stays independent', () => {
  const stage = createStageDefinition(0, 4, 1);
  assert.equal(stage.trees.length, 151);
  for (const target of stage.trees) {
    if (target.degree === 3) assert.equal(target.gridOriginZ, undefined);
    else assert.equal(target.gridOriginZ, 50 + Math.floor(target.id / 100) * 50);
  }
});

test('a later bank front cannot bypass a remaining side tree when the bank bound is farther', () => {
  // Both positions fall within their actual authored banks. A flat search
  // prefers the next bank (score 42) to the side tree (score about 49.24),
  // but the source stops before its bank at lower bound 52.5.
  const remaining = tree(0, 22.5, 27.5, 50);
  const nextBank = tree(100, -22.5, 77.5, 100);
  const world = fixture({ x: -22.5, z: 47.5 }, nextBank, remaining);
  assert.equal(world.findAutoTarget(), remaining);
  remaining.alive = false;
  assert.equal(world.findAutoTarget(), nextBank, 'a depleted bank must allow progression');
});

test('a bank lower bound equal to the best score is searched; strictly greater is pruned', () => {
  const nextBank = tree(100, -22.5, 80, 100);
  for (const [x, expected] of [[27.5, nextBank], [27.499, null]]) {
    const current = tree(0, x, 50, 50);
    const world = fixture({ x: -22.5, z: 50 }, current, nextBank);
    assert.equal(world.findAutoTarget(), expected ?? current);
  }
});

test('source grid ordering controls equal-score ties before serialized tree array order', () => {
  // Synthetic roots isolate ordering from geometry: the current bank's bound
  // is zero and the previous bank's bound is ten at player Z=105.
  const previous = tree(0, -20, 105, 50), current = tree(100, 20, 105, 100);
  assert.equal(fixture({ x: 0, z: 105 }, previous, current).findAutoTarget(), current);
  // Equidistant bounds retain the source grid order even if the flat active
  // tree collection has been reordered.
  const early = tree(0, -20, 97.5, 50), late = tree(100, 20, 97.5, 100);
  assert.equal(fixture({ x: 0, z: 97.5 }, late, early).findAutoTarget(), early);
  const second = tree(1, 20, 97.5, 50);
  assert.equal(fixture({ x: 0, z: 97.5 }, second, early).findAutoTarget(), second);
});

test('the previous bank lower bound starts after origin plus 45, not at its origin', () => {
  const previous = tree(0, 0, 94, 50), current = tree(100, 15, 96, 100);
  const world = fixture({ x: 0, z: 96 }, current, previous);
  assert.equal(world.findAutoTarget(), previous);
});

test('fifth-wave Boss_tree is scored independently after a later bank is pruned', () => {
  const current = tree(0, 10, 50, 50), pruned = tree(100, 0, 80, 100);
  const boss = { ...tree(500, 0, 55), degree: 3 };
  const world = fixture({ x: 0, z: 50 }, current, pruned, boss);
  assert.equal(world.findAutoTarget(), boss);
  boss.alive = false;
  assert.equal(world.findAutoTarget(), current);
});

test('arena targeting keeps its distance search even if trees carry main-bank metadata', () => {
  const remaining = tree(0, 22.5, 27.5, 50), nextBank = tree(100, -22.5, 77.5, 100);
  const world = fixture({ x: -22.5, z: 47.5 }, remaining, nextBank);
  world.stage.mapLayout = 'arena';
  assert.equal(world.findAutoTarget(), nextBank);
});

test('real fifth-wave combat finishes its opening bank before choosing the next in the regression seed', () => {
  // Original root-distance-only selection left four opening-bank trees alive
  // when it switched banks at 115.88 s. Exercise actual rays, projectiles,
  // deaths, movement and timed rescans rather than force-killing fixtures.
  const world = new CombatWorld(1, createStageDefinition(0, 4, 1));
  let nextBankReached = false;
  for (let frame = 0; frame < 180 * 60; frame++) {
    world.step(1 / 60);
    world.drainEvents();
    if (world.autoTargetId === null || world.autoTargetId < 100) continue;
    nextBankReached = true;
    assert.equal(world.trees.filter(target => target.id < 100 && target.alive).length, 0);
    break;
  }
  assert.equal(nextBankReached, true, 'clearing the current bank must not stall progression');
});
