const test = require('node:test');
const { assert, D, stats, fixture, died, win, enter, exit } = require('./support/boss-session-fixture.cjs');

test('Boss enters after 2 seconds and owns a full paused-aware 60-second clock', () => {
  const { session } = fixture(); const oldId = session.roundId;
  assert.equal(session.startBoss().ok, true); assert.equal(session.mode, 'Boss');
  assert.equal(session.roundId, oldId + 1); assert.equal(session.phase, 'loading'); assert.equal(session.canFight, false);
  session.advanceFrame(90, session.roundId, true); session.advanceFrame(NaN); session.advanceFrame(-1);
  assert.equal(session.getBossState().loadingElapsed, 0); assert.equal(session.advanceFrame(1.99), null);
  assert.equal(session.getBossState().remainingSeconds, 60);
  assert.equal(session.advanceFrame(.01).roundId, session.roundId); assert.equal(session.canFight, true);
  assert.equal(session.snapshot(stats, false).durationSeconds, 60);
  session.advanceFrame(12, session.roundId, true); assert.equal(session.getBossState().remainingSeconds, 60);
  session.advanceFrame(4.5); assert.equal(session.getBossState().remainingSeconds, 55.5);
  assert.equal(session.requestRebirth('normal').reason, 'mode'); assert.equal(session.openRaid().reason, 'mode');
  assert.equal(session.startSpeedRun().reason, 'mode'); assert.equal(session.configureBossTest({ stage: 8 }), false);
});

test('zero crossing yields once; Boss death before the next resume wins, later death cannot pay', () => {
  const winning = fixture().session; enter(winning); winning.advanceFrame(60.1);
  assert.ok(Math.abs(winning.getBossState().remainingSeconds + .1) < 1e-12); assert.equal(winning.canFight, true);
  win(winning); winning.advanceFrame(.1);
  assert.equal(winning.getBossState().phase, 'won'); assert.equal(winning.weapons.diamonds, 300);
  assert.equal(winning.getBossState().resultElapsed, 0, 'the settling frame does not advance result animation');
  winning.advanceFrame(.2); assert.equal(winning.getBossState().resultElapsed, .2);
  const failed = fixture().session; enter(failed); failed.advanceFrame(60); failed.advanceFrame(.01);
  assert.equal(failed.getBossState().phase, 'failed'); assert.equal(failed.canFight, false);
  win(failed); assert.equal(failed.weapons.diamonds, 0); failed.advanceFrame(1000);
  assert.equal(failed.getBossState().phase, 'failed'); assert.equal(failed.getBossState().stage, 0);
});

test('Boss snapshot retains the final timer operand while the common battle HUD stays nonnegative', () => {
  for (const elapsed of [60, 60.125]) {
    const session = fixture().session; enter(session); session.advanceFrame(elapsed);
    const remaining = 60 - elapsed;
    assert.equal(session.getBossState().remainingSeconds, remaining);
    assert.equal(session.getBossState().phase, 'playing', 'crossing zero yields before failure');
    assert.equal(session.snapshot(stats, false).remainingSeconds, 0);
    session.advanceFrame(.01);
    assert.equal(session.getBossState().phase, 'failed');
    assert.equal(session.getBossState().remainingSeconds, remaining);
    session.advanceFrame(5);
    assert.equal(session.getBossState().remainingSeconds, remaining, 'failure does not subtract or normalize the last operand');
    assert.equal(session.snapshot(stats, false).remainingSeconds, 0);
  }
});

test('victory atomically commits the fifth-stage 420 diamonds and next Boss stage without Main gold or advancement', () => {
  const f = fixture(); let notifications = 0;
  const session = f.restore({ onStageCleared: () => notifications++ });
  session.configureProgressionTest({ stageIndex: 2, waveIndex: 3, stageValueMax: 30 });
  session.configureBossTest({ stage: 4 }); const main = { ...session.round };
  enter(session); f.writes.length = 0;
  const tree = { id: 4, alive: false, reward: D.from(9999), rewardPrecision: 4 };
  assert.deepEqual(session.consume([{ type: 'treeDied', treeId: 4, sourceTime: 0, position: { x: 0, z: 0 } },
    { type: 'complete', position: { x: 0, z: 0 } }], [tree]), []);
  assert.equal(session.getBossState().phase, 'playing'); assert.equal(session.moneyBalance.toNumber(), 0);
  win(session); win(session); assert.equal(f.writes.length, 1); assert.equal(notifications, 0);
  assert.equal(session.weapons.diamonds, 420); assert.equal(session.getBossState().stage, 4);
  const saved = JSON.parse(f.data.get(f.key)); assert.equal(saved.version, 3); assert.deepEqual(saved.boss, { stage: 5 });
  assert.deepEqual(saved.progress, { stageIndex: main.stageIndex, waveIndex: main.waveIndex });
  assert.equal(saved.weapons.stageValueMax, 30); assert.equal(saved.speedRun.stage, 0);
  const restored = f.restore(); assert.equal(restored.mode, 'Main'); assert.equal(restored.getBossState().stage, 5);
  assert.equal(restored.weapons.diamonds, 420); const returned = exit(session);
  assert.deepEqual([returned.stageIndex, returned.waveIndex], [main.stageIndex, main.waveIndex]);
  assert.equal(enter(session).stageIndex, 5);
});

test('Boss ad cancellation and failure retain victory, success adds 600 once and exits', () => {
  const { session, writes, restore } = fixture(); enter(session); win(session);
  for (const outcome of ['cancel', 'failure']) {
    const ad = session.beginBossAd(); assert.equal(ad.ok, true); assert.equal(session.getBossState().phase, 'adPending');
    assert.equal(session.beginBossAd().reason, 'adInProgress'); assert.equal(session.completeBossAd(ad.token, outcome).reason, outcome);
    assert.equal(session.getBossState().phase, 'won'); assert.equal(session.weapons.diamonds, 300);
    assert.equal(session.completeBossAd(ad.token, 'success').reason, 'staleAd');
  }
  const cancelled = session.beginBossAd(); session.cancelBossAd();
  assert.equal(session.completeBossAd(cancelled.token, 'success').reason, 'staleAd');
  const ad = session.beginBossAd(); assert.equal(session.completeBossAd(ad.token, 'other').reason, 'invalid');
  assert.equal(session.getBossState().phase, 'adPending'); writes.length = 0;
  assert.equal(session.completeBossAd(ad.token, 'success').ok, true); assert.equal(session.weapons.diamonds, 900);
  assert.equal(writes.length, 1); assert.equal(session.getBossState().phase, 'exiting');
  assert.equal(session.getBossState().adAvailable, false); assert.equal(session.completeBossAd(ad.token, 'success').reason, 'staleAd');
  assert.equal(restore().weapons.diamonds, 900); assert.equal(session.advanceFrame(1.49), null);
  session.advanceFrame(.01); assert.equal(session.mode, 'Main'); assert.equal(session.getBossState().stage, 1);
});

test('pending Boss ad tokens expire on exit and never survive refresh or collide with later encounters', () => {
  const { session, restore } = fixture(); enter(session); win(session);
  const old = session.beginBossAd(); exit(session);
  assert.equal(session.completeBossAd(old.token, 'success').reason, 'staleAd');
  enter(session); win(session); const current = session.beginBossAd(); assert.notEqual(current.token, old.token);
  assert.equal(session.completeBossAd(old.token, 'success').reason, 'staleAd');
  const restored = restore(); assert.equal(restored.getBossState().stage, 2); assert.equal(restored.weapons.diamonds, 630);
  assert.equal(restored.completeBossAd(current.token, 'success').reason, 'staleAd');
  enter(restored); win(restored); assert.notEqual(restored.beginBossAd().token, current.token);
});

test('failure and voluntary exit give unlimited free retries and invalidate old round callbacks', () => {
  const { session } = fixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = enter(session).roundId;
    if (attempt % 2) { session.advanceFrame(60); session.advanceFrame(.01); }
    assert.equal(session.exitBoss().ok, true); session.advanceFrame(.5, session.roundId, true);
    assert.equal(session.getBossState().loadingElapsed, 0); assert.equal(session.advanceFrame(1.49), null);
    const returned = session.advanceFrame(.01); assert.equal(session.mode, 'Main'); assert.ok(returned.roundId > old);
    assert.deepEqual(session.consume([died()], [], old), []); assert.equal(session.advanceFrame(100, old), null);
    assert.equal(session.weapons.diamonds, 0); assert.equal(session.getBossState().stage, 0);
    assert.equal(session.snapshot(stats, false).remainingSeconds, 180);
  }
});

test('Boss preserves its stage through rebirth and prevents overwriting missing or damaged saves', () => {
  const f = fixture(); f.session.configureBossTest({ stage: 12 });
  f.session.configureProgressionTest({ stageIndex: 2, stageValueMax: 90 });
  assert.equal(f.session.requestRebirth('normal').ok, true); assert.equal(f.session.startBoss().reason, 'busy');
  f.session.advanceRebirth(2); assert.equal(f.session.getBossState().stage, 12);
  assert.equal(f.restore().getBossState().stage, 12);
  const saved = JSON.parse(f.data.get(f.key)); saved.money = { digits: '1234', exponent: 0, precision: 4 }; saved.weapons.diamonds = 5678;
  for (const boss of [undefined, null, { stage: -1 }, { stage: .5 }, { stage: Number.MAX_SAFE_INTEGER }, { stage: '2' }]) {
    f.data.set(f.key, JSON.stringify({ ...saved, boss })); const warning = console.warn; console.warn = () => {};
    let restored; try { restored = f.restore(); } finally { console.warn = warning; }
    const raw = f.data.get(f.key); assert.equal(restored.persistenceBlocked, true); assert.equal(restored.getBossState().stage, 0);
    if (boss !== undefined) {
      assert.equal(restored.moneyBalance.toNumber(), 1234); assert.equal(restored.weapons.diamonds, 5678);
      assert.equal(restored.getRebirthState().count, 1); assert.equal(restored.weapons.stageValueMax, 90);
    }
    restored.save(); assert.equal(f.data.get(f.key), raw);
  }
});

test('Boss snapshot formats huge health without converting its magnitude to an unsafe number', () => {
  const session = fixture().session;
  assert.equal(session.getBossState().health, D.from(50000).format());
  assert.equal(session.getBossState().maxHealth, D.from(50000).format());
  assert.equal(session.getBossState().healthRatio, 1); enter(session);
  const snapshot = session.getBossState({ health: D.from('25e999'), maxHealth: D.from('5e1000') });
  assert.equal(snapshot.healthRatio, .5); assert.equal(snapshot.progress, .5);
  assert.equal(snapshot.health, D.from('25e999').format()); assert.equal(snapshot.maxHealth, D.from('5e1000').format());
  assert.equal(snapshot.reward, 300);
});

test('Boss entry and ad rewards enforce the shared safe diamond wallet without partial advancement', () => {
  const session = fixture().session;
  session.weapons.configureTest({ diamonds: Number.MAX_SAFE_INTEGER - 100 });
  assert.equal(session.startBoss().reason, 'walletLimit'); assert.equal(session.mode, 'Main');
  session.weapons.configureTest({ diamonds: Number.MAX_SAFE_INTEGER - 300 }); enter(session); win(session);
  assert.equal(session.weapons.diamonds, Number.MAX_SAFE_INTEGER); assert.equal(session.beginBossAd().reason, 'walletLimit');
  assert.equal(session.getBossState().phase, 'won'); exit(session); assert.equal(session.getBossState().stage, 1);
});

test('very large saved Boss stages remain finite previews and retain safe displayed level arithmetic', () => {
  const f = fixture(); assert.equal(f.session.configureBossTest({ stage: 1000000000000 }), true);
  const restored = f.restore(); assert.equal(restored.getBossState().stage, 1000000000000);
  assert.ok(restored.getBossState().maxHealth.length > 0); assert.equal(restored.getBossState().healthRatio, 1);
  assert.equal(restored.configureBossTest({ stage: Number.MAX_SAFE_INTEGER - 1 }), true);
  assert.ok(restored.getBossState().maxHealth.length > 0); assert.equal(restored.startBoss().reason, 'stageLimit');
  assert.equal(restored.configureBossTest({ stage: Number.MAX_SAFE_INTEGER }), false);
});

test('Boss ads hold unrelated pending weapon expiry until cancel, failure, success or explicit exit', () => {
  const { AD_WEAPON_DURATION_MS } = require('./support/boss-session-fixture.cjs').compiled('session/WeaponInventory.js');
  for (const outcome of ['cancel', 'failure', 'success', 'exit']) {
    let now = 1791691200000; const session = fixture().restore({ now: () => now, rng: () => 0 });
    session.weapons.grantTestWeapon(0); session.weapons.grantTestWeapon(1); session.weapons.merge(0, 1);
    const at = session.weapons.snapshot().backpack.findIndex(item => item?.pendingAd); assert.ok(at >= 0);
    enter(session); win(session); const ad = session.beginBossAd(); assert.equal(ad.ok, true);
    now += AD_WEAPON_DURATION_MS; session.weapons.tick();
    assert.equal(session.weapons.snapshot().backpack[at]?.pendingAd, true);
    assert.equal(session.completeBossAd('old', 'success').reason, 'staleAd');
    assert.equal(session.weapons.snapshot().backpack[at]?.pendingAd, true);
    if (outcome === 'exit') session.exitBoss(); else session.completeBossAd(ad.token, outcome);
    assert.equal(session.weapons.serialize().backpack[at], null); assert.equal(session.weapons.serialize().collection[14], false);
    assert.equal(session.weapons.diamonds, outcome === 'success' ? 900 : 300);
  }
});
