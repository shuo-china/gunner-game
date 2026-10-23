const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleSession } = require('./.build/session/session/BattleSession.js');
const { AD_WEAPON_DURATION_MS } = require('./.build/session/session/WeaponInventory.js');
const { DecimalAmount: D } = require('./.build/session/core/DecimalAmount.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

function fixture(kind) {
  let now = new Date(2026, 9, 10, 12).getTime();
  const session = new BattleSession({ environment: 'test', contentConfig: resolveContentConfig('test', { adsEnabled: true }), now: () => now, rng: () => 0 });
  session.configureProgressionTest({ stageIndex: 2, stageValueMax: 20 });
  session.weapons.grantTestWeapon(0); session.weapons.grantTestWeapon(1); session.weapons.merge(0, 1);
  const at = session.weapons.snapshot().backpack.findIndex(item => item?.pendingAd);
  assert.ok(at >= 0);
  if (kind === 'speedrun') {
    session.startSpeedRun(); session.advanceFrame(1.5);
    session.consume([{ type: 'treeDied', treeId: 0, sourceTime: 0, position: { x: 0, z: 0 } },
      { type: 'complete', position: { x: 0, z: 0 } }], [{ id: 0, alive: false, reward: D.from(20) }]);
  }
  const result = kind === 'rebirth' ? session.requestRebirth('ad') : session.beginSpeedRunAd();
  assert.equal(result.ok, true);
  return { session, at, token: result.token, passDeadline: () => { now += AD_WEAPON_DURATION_MS; session.weapons.tick(); } };
}

test('every retained rewarded-ad placement delays unrelated weapon-offer expiry until its callback settles', () => {
  for (const kind of ['rebirth', 'speedrun']) for (const outcome of ['success', 'cancel', 'failure']) {
    const { session, at, token, passDeadline } = fixture(kind);
    passDeadline();
    assert.equal(session.weapons.snapshot().backpack[at]?.pendingAd, true, `${kind} ${outcome} preserves the offer while busy`);
    const result = kind === 'rebirth' ? session.completeRebirthAd(token, outcome) : session.completeSpeedRunAd(token, outcome);
    assert.equal(result.ok, outcome === 'success');
    assert.equal(session.weapons.serialize().backpack[at], null, `${kind} ${outcome} rechecks immediately, without a later tick/snapshot`);
    assert.equal(session.weapons.serialize().adGunExpiresAt, 0);
    assert.equal(session.weapons.serialize().collection[14], false, 'watching another placement cannot claim the pending weapon');
  }
});

test('explicit cancellation and leaving a challenge also release the global expiration hold', () => {
  for (const kind of ['rebirth', 'speedrun', 'speedrun-exit']) {
    const { session, at, token, passDeadline } = fixture(kind === 'rebirth' ? 'rebirth' : 'speedrun');
    passDeadline();
    if (kind === 'rebirth') session.cancelRebirthAd();
    else if (kind === 'speedrun') session.cancelSpeedRunAd();
    else session.exitSpeedRun();
    assert.equal(session.weapons.serialize().backpack[at], null);
    assert.equal((kind === 'rebirth' ? session.completeRebirthAd(token, 'success') : session.completeSpeedRunAd(token, 'success')).ok, false);
    assert.equal(session.weapons.serialize().collection[14], false);
  }
});

test('stale and invalid callbacks cannot end another placement expiration hold', () => {
  for (const kind of ['rebirth', 'speedrun']) {
    const { session, at, token, passDeadline } = fixture(kind);
    passDeadline();
    const complete = (id, outcome) => kind === 'rebirth' ? session.completeRebirthAd(id, outcome) : session.completeSpeedRunAd(id, outcome);
    assert.equal(complete('other', 'success').reason, 'staleAd');
    assert.equal(complete(token, 'invalid').ok, false);
    assert.equal(session.weapons.snapshot().backpack[at]?.pendingAd, true);
    complete(token, 'cancel'); assert.equal(session.weapons.serialize().backpack[at], null);
  }
});
