const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession, BATTLE_MODES, economyStorageKey } = require('./.build/session/session/BattleSession.js');
const { StageProgression, nextStagePosition } = require('./.build/session/session/StageProgression.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { CombatWorld } = require('./.build/core/index.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

const stats = { shots: 0, hits: 0, kills: 0, totalTrees: 30, elapsed: 0, complete: false };
function deadTree(id, degree) { return { id, degree, alive: false, reward: D.from([20, 36, 60, 2000][degree]) }; }
function died(treeId) { return { type: 'treeDied', treeId, sourceTime: 1.25, position: { x: 4, z: 8 } }; }
function clear(session, trees = [deadTree(0, 0)]) {
  return session.consume([...trees.map(tree => died(tree.id)), { type: 'complete', position: { x: 0, z: 0 } }], trees, session.roundId);
}
function finishTransition(session, replay = false) {
  session.advanceFrame(.01); // The victory frame does not age its new transition.
  session.advanceFrame(replay ? 1 : 2);
  return session.advanceFrame(replay ? .75 : 1.5);
}

test('First-stage rewards are 20/36, awarded once immediately and independent of effect rendering', () => {
  const session = new BattleSession(), events = [died(0), died(1)];
  const trees = [deadTree(0, 0), deadTree(1, 1)];
  const rewards = session.consume(events, trees, session.roundId);
  assert.deepEqual(rewards.map(r => r.amount.toNumber()), [20, 36]);
  assert.equal(rewards[0].sourceTime, 1.25);
  assert.equal(session.snapshot(stats, false).money.toNumber(), 56);
  assert.deepEqual(session.consume(events, trees, session.roundId), []);
  assert.equal(session.snapshot(stats, false).money.toNumber(), 56);
  events[0].position.x = -9;
  assert.equal(rewards[0].position.x, 4);
});

test('Missing/live targets cannot award money; replay resets IDs and retains only session balance', () => {
  const session = new BattleSession();
  assert.deepEqual(session.consume([died(0), died(1)], [{ ...deadTree(0, 0), alive: true }], 0), []);
  session.consume([died(0)], [deadTree(0, 0)], session.roundId);
  session.beginRound();
  session.consume([died(0)], [deadTree(0, 0)], session.roundId);
  assert.equal(session.snapshot(stats, false).money.toNumber(), 40);
  assert.equal(session.snapshot(stats, false).diamonds, 0);
  assert.equal(new BattleSession().snapshot(stats, false).money.toNumber(), 0);
});

test('Session owns the timer; pause freezes it and original next-frame expiration fails the round', () => {
  const session = new BattleSession();
  assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  session.advanceFrame(32.5);
  session.advanceFrame(30, session.roundId, true);
  assert.equal(session.snapshot(stats, true).remainingSeconds, 147.5);
  session.advanceFrame(147.5);
  assert.equal(session.canFight, true, 'source yields once after subtracting the final delta');
  session.advanceFrame(.01);
  const expired = session.snapshot(stats, false);
  assert.equal(expired.remainingSeconds, 0);
  assert.equal(expired.phase, 'failed'); assert.equal(session.canFight, false);
  assert.equal(expired.stageIndex, 0); assert.equal(expired.waveIndex, 0);
});

test('Mode transitions preserve wallet, block unsupported gameplay rewards and validate mode IDs', () => {
  const session = new BattleSession(), trees = [deadTree(0, 1)];
  for (const mode of BATTLE_MODES.filter(mode => mode !== 'Main')) {
    session.setMode(mode);
    assert.equal(session.snapshot(stats, true).mode, mode);
    assert.deepEqual(session.consume([died(0)], trees, 0), []);
  }
  session.setMode('Main'); session.consume([died(0)], trees, session.roundId);
  assert.equal(session.snapshot(stats, false).money.toNumber(), 36);
  assert.throws(() => session.setMode('invalid'), /Unsupported battle mode/);
  assert.equal(session.mode, 'Main');
});

test('Real clear awards the exact sum, including final death, without changing combat trajectories', () => {
  for (const fps of [30, 60, 120]) {
    const actual = new CombatWorld(20261010), control = new CombatWorld(20261010), session = new BattleSession();
    const expected = actual.trees.reduce((sum, t) => sum + (t.degree === 0 ? 20 : 36), 0);
    let rewards = 0;
    for (let frame = 0; frame < 60000 && !actual.stats.complete; frame++) {
      actual.step(1 / fps); control.step(1 / fps);
      rewards += session.consume(actual.drainEvents(), actual.trees, session.roundId).length;
      control.drainEvents();
    }
    assert.equal(actual.stats.complete, true); assert.equal(rewards, 30);
    assert.equal(session.snapshot(actual.stats, false).money.toNumber(), expected);
    assert.deepEqual(actual.stats, control.stats);
    assert.deepEqual(actual.player, control.player);
    const stopped = session.snapshot(actual.stats, false).remainingSeconds;
    actual.step(0.25);
    assert.equal(session.snapshot(actual.stats, false).remainingSeconds, stopped);
  }
});

test('Five-wave clear progression crosses the stage boundary and has no stage-5000 cap', () => {
  assert.deepEqual(nextStagePosition({ stageIndex: 0, waveIndex: 4 }), { stageIndex: 1, waveIndex: 0 });
  assert.deepEqual(nextStagePosition({ stageIndex: 4999, waveIndex: 4 }), { stageIndex: 5000, waveIndex: 0 });
  const session = new BattleSession({ environment: 'test' });
  session.configureProgressionTest({ stageIndex: 4999, waveIndex: 4 });
  const diamonds = session.weapons.diamonds;
  clear(session);
  assert.equal(session.phase, 'won');
  assert.equal(session.weapons.snapshot().stageValueMax, 50000);
  assert.deepEqual(session.round, { stageIndex: 4999, waveIndex: 4, roundId: 2, movementMultiplier: 1 });
  assert.equal(session.weapons.diamonds, diamonds, 'original wave completion does not grant diamonds');
  const next = finishTransition(session);
  assert.deepEqual(next, { stageIndex: 5000, waveIndex: 0, roundId: 3, movementMultiplier: 1 });
  assert.equal(session.phase, 'reveal'); assert.equal(session.canFight, true);
  session.advanceFrame(.2);
  assert.equal(session.phase, 'playing'); assert.equal(session.snapshot(stats, false).stageTransition, undefined);
});

test('Victory holds two seconds, loads 1.5 seconds and does not wait for reward particles', () => {
  const session = new BattleSession(); clear(session);
  session.advanceFrame(.1);
  assert.equal(session.snapshot(stats, false, true).stageTransition.elapsed, 0);
  assert.equal(session.snapshot(stats, false, true).resultsReady, true);
  session.advanceFrame(1.99); assert.equal(session.phase, 'won');
  session.advanceFrame(.01); assert.equal(session.phase, 'loading');
  session.advanceFrame(1.49); assert.equal(session.round.waveIndex, 0);
  const round = session.advanceFrame(.01); assert.equal(round.waveIndex, 1);
  assert.equal(session.snapshot(stats, false).stageTransition.loadingElapsed, 1.5);
  session.advanceFrame(.1); assert.ok(session.snapshot(stats, false).stageTransition);
  session.advanceFrame(.1); assert.equal(session.snapshot(stats, false).stageTransition, undefined);
});

test('Replay movement and transition speed use strict historical progress and preserve maximum', () => {
  const session = new BattleSession({ environment: 'test' });
  session.configureProgressionTest({ stageIndex: 1, waveIndex: 0, stageValueMax: 14 });
  assert.equal(session.round.movementMultiplier, 2);
  clear(session); const next = finishTransition(session, true);
  assert.equal(next.waveIndex, 1); assert.equal(next.movementMultiplier, 2);
  assert.equal(session.weapons.snapshot().stageValueMax, 14);
  session.configureProgressionTest({ stageIndex: 1, waveIndex: 4, stageValueMax: 14 });
  assert.equal(session.round.movementMultiplier, 1);
});

test('Timeout restarts the same wave automatically, retains earned money and rejects stale rounds', () => {
  const session = new BattleSession(), oldRound = session.roundId;
  session.consume([died(0)], [deadTree(0, 0)], oldRound);
  session.advanceFrame(180); session.advanceFrame(.01);
  const fail = session.snapshot(stats, false).stageTransition;
  assert.equal(fail.kind, 'fail'); assert.equal(session.canFight, false);
  session.advanceFrame(2); const next = session.advanceFrame(1.5);
  assert.equal(next.waveIndex, 0); assert.notEqual(next.roundId, oldRound);
  assert.equal(session.moneyBalance.toNumber(), 20);
  assert.deepEqual(session.consume([died(0)], [deadTree(0, 0)], oldRound), []);
  assert.equal(session.advanceFrame(99, oldRound), null);
  assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  session.consume([died(0)], [deadTree(0, 0)], next.roundId);
  assert.equal(session.moneyBalance.toNumber(), 40);
});

test('Last kill on the zero-crossing frame wins, repeated completion cannot settle twice', () => {
  const session = new BattleSession(); session.advanceFrame(180);
  clear(session); const transition = session.snapshot(stats, false).stageTransition;
  clear(session); session.advanceFrame(.01);
  assert.equal(session.phase, 'won'); assert.equal(session.weapons.snapshot().stageValueMax, 1);
  assert.equal(session.moneyBalance.toNumber(), 20);
  assert.equal(session.snapshot(stats, false).stageTransition.id, transition.id);
});

test('A new win during reveal replaces its transition without the old reveal hiding it', () => {
  const session = new BattleSession(); clear(session); finishTransition(session);
  const oldId = session.snapshot(stats, false).stageTransition.id;
  clear(session); session.advanceFrame(.1); session.advanceFrame(.2);
  const replacement = session.snapshot(stats, false).stageTransition;
  assert.equal(session.phase, 'won'); assert.ok(replacement.id > oldId); assert.equal(replacement.elapsed, .2);
});

test('Relic skip performs at most one extra advance strictly below historical best and uses no RNG at zero', () => {
  let calls = 0;
  const progression = new StageProgression({ stageIndex: 0, waveIndex: 3 }, { rng: () => { calls++; return 0; } });
  progression.startRound(20); progression.win(20); assert.equal(calls, 0);
  const session = new BattleSession({ environment: 'test', rng: () => { calls++; return 0; } });
  session.configureProgressionTest({ stageIndex: 0, waveIndex: 3, stageValueMax: 20, skipPercent: 100 });
  clear(session); const round = finishTransition(session, true);
  assert.equal(round.stageIndex, 1); assert.equal(round.waveIndex, 0);
  assert.equal(session.snapshot(stats, false).stageSkip.elapsed, 0);
  session.advanceFrame(.2); assert.ok(session.snapshot(stats, false).stageSkip);
  session.advanceFrame(1.6); assert.equal(session.snapshot(stats, false).stageSkip, undefined);
  session.configureProgressionTest({ stageIndex: 0, waveIndex: 3, stageValueMax: 10 });
  clear(session); const boundary = finishTransition(session, true);
  assert.equal(boundary.stageIndex, 0); assert.equal(boundary.waveIndex, 4, 'skip destination equal to best is rejected');
});

test('Ordinary Main rounds always restart with the source 180-second duration', () => {
  const session = new BattleSession({ environment: 'test' });
  assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  session.advanceFrame(32);
  session.configureProgressionTest({ stageIndex: 3 });
  assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  assert.equal(session.snapshot(stats, false).durationSeconds, 180);
  assert.equal(new BattleSession().snapshot(stats, false).remainingSeconds, 180);
});

test('Reward batch, target stage and monotonic history persist together once and reload starts target', () => {
  const data = new Map(), writes = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, raw) { data.set(key, raw); writes.push(JSON.parse(raw)); } };
  const session = new BattleSession({ storage }); writes.length = 0;
  const tree = { ...deadTree(0, 3), reward: D.from('1e1000') };
  clear(session, [tree]);
  assert.equal(writes.length, 1);
  assert.equal(D.from(writes[0].money).compare('1e1000'), 0);
  assert.deepEqual(writes[0].progress, { stageIndex: 0, waveIndex: 1 });
  assert.equal(writes[0].weapons.stageValueMax, 1);
  assert.equal(writes[0].weapons.diamonds, 0);
  const restored = new BattleSession({ storage });
  assert.equal(restored.round.waveIndex, 1); assert.equal(restored.moneyBalance.compare('1e1000'), 0);
  assert.equal(economyStorageKey('production'), 'forest-gunner:economy:v3:production');
});

test('Wave-clear notification fires once after persistence and failures cannot interrupt settlement', () => {
  const data = new Map(), notified = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const session = new BattleSession({ storage, onStageCleared(round) {
    notified.push(round);
    const persisted = JSON.parse(data.get(economyStorageKey('production')));
    assert.equal(persisted.progress.waveIndex, 1); assert.equal(persisted.weapons.stageValueMax, 1);
    throw new Error('simulated unavailable mission adapter');
  } });
  const warn = console.warn, warnings = [];
  console.warn = (...args) => warnings.push(args);
  try { clear(session); clear(session); } finally { console.warn = warn; }
  assert.equal(notified.length, 1); assert.equal(notified[0].waveIndex, 0);
  assert.equal(warnings.length, 1); assert.equal(session.phase, 'won');
  assert.equal(session.moneyBalance.toNumber(), 20);
});

test('Stage validation rejects unsafe indices but accepts progression beyond the old artificial cap', () => {
  const session = new BattleSession({ environment: 'test' });
  assert.equal(session.configureProgressionTest({ stageIndex: 100000001, waveIndex: 0, stageValueMax: 1000000010 }), true);
  clear(session); assert.equal(session.weapons.snapshot().stageValueMax, 1000000011);
  assert.equal(session.configureProgressionTest({ stageIndex: Number.MAX_SAFE_INTEGER }), false);
  assert.equal(session.configureProgressionTest({ waveIndex: 5 }), false);
  assert.equal(session.configureProgressionTest({ skipPercent: NaN }), false);
});

test('Production progression naturally opens stage 4 and stage 40 weapon gates', () => {
  for (const [stageIndex, waveIndex, expected, feature] of [[2, 4, 30, 'dailyAdUnlocked'], [38, 4, 390, 'starUnlocked']]) {
    const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    new BattleSession({ storage });
    const key = economyStorageKey('production'), saved = JSON.parse(data.get(key));
    saved.progress = { stageIndex, waveIndex }; saved.weapons.stageValueMax = stageIndex * 10 + waveIndex;
    data.set(key, JSON.stringify(saved));
    const session = new BattleSession({ storage, contentConfig: resolveContentConfig('production', { adsEnabled: true }) });
    assert.equal(session.weapons.snapshot()[feature], false);
    clear(session);
    assert.equal(session.weapons.snapshot().stageValueMax, expected);
    assert.equal(session.weapons.snapshot()[feature], true);
  }
});

test('Production adapters may provide Relic skip modifiers without test-only configuration', () => {
  const session = new BattleSession({ rng: () => 0 });
  session.advanceFrame(20);
  session.setProgressionModifiers({ skipPercent: 100 });
  assert.equal(session.snapshot(stats, false).remainingSeconds, 160, 'changing skip chance does not restart the round');
  session.weapons.recordStageValue(10);
  session.restartRound(); assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  clear(session); const next = finishTransition(session, true);
  assert.equal(next.waveIndex, 2); assert.ok(session.snapshot(stats, false).stageSkip);
  assert.throws(() => session.setProgressionModifiers({ skipPercent: 101 }), /skip chance/);
});


test('mode phase queries do not construct HUD or inventory snapshots', () => {
  const session = new BattleSession({environment: 'test'});
  for (const name of ['getSpeedRunState', 'getRaidState', 'getBossState', 'getHuntState', 'getMineState'])
    session[name] = () => { throw Error('full HUD state must not be needed'); };
  session.weapons.snapshot = () => { throw Error('inventory snapshot must not be needed'); };
  for (const mode of ['SpeedRun', 'Raid', 'Boss', 'Monster', 'Mine']) assert.equal(session.getModePhase(mode), 'idle');
});
