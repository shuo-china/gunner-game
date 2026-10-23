const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_SESSION_TEST_BUILD || path.resolve(__dirname, '../.build/session');
const compiled = file => require(path.join(build, file));
const { BattleSession, economyStorageKey } = compiled('session/BattleSession.js');
const { resolveContentConfig } = compiled('session/ContentConfig.js');
const { DecimalAmount: D } = compiled('core/DecimalAmount.js');
const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 0, elapsed: 0, complete: false };
function options(environment = 'test', overrides = {}) {
  return { environment, now: () => 1791691200000, rng: () => .5,
    contentConfig: resolveContentConfig(environment, { adsEnabled: true, tutorialEnabled: false, firstDrawDiamonds: 0,
      testResources: { fundGoldUpgrades: false, fundRebirthUpgrades: false, diamonds: 0, starGems: 0 }, ...overrides }) };
}
function fixture(environment = 'test', overrides = {}) {
  const data = new Map(), writes = [], key = economyStorageKey(environment), configuration = options(environment, overrides);
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, value); writes.push(JSON.parse(value)); } };
  const restore = extra => new BattleSession({ ...configuration, storage, ...extra });
  const session = restore(); writes.length = 0;
  return { session, data, storage, writes, key, restore };
}
function died() { return { type: 'bossDied', treeId: 3000000, sourceTime: .5, position: { x: -115, z: 15 } }; }
function win(session, roundId = session.roundId) { return session.consume([died()], [], roundId); }
function enter(session) {
  assert.equal(session.startBoss().ok, true);
  const round = session.advanceFrame(2);
  assert.equal(round.roundId, session.roundId); assert.equal(session.getBossState().phase, 'playing');
  return round;
}
function exit(session) {
  assert.equal(session.exitBoss().ok, true);
  const round = session.advanceFrame(1.5); assert.equal(session.mode, 'Main'); return round;
}
module.exports = { assert, compiled, BattleSession, D, stats, options, fixture, died, win, enter, exit };
