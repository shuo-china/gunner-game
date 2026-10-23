const test = require('node:test');
const assert = require('node:assert/strict');
const { RewardedAdService, SimulatedRewardedAdProvider, UnavailableRewardedAdProvider } = require('./.build/session/session/RewardedAds.js');
const { BattleSession } = require('./.build/session/session/BattleSession.js');
const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');

function fixture() {
  const view = { id: null, opens: [], open(id) { this.id = id; this.opens.push(id); }, dismiss() { this.id = null; } };
  const provider = new SimulatedRewardedAdProvider(view);
  const changes = [], service = new RewardedAdService(provider, () => changes.push(service.isPresenting));
  return { view, provider, service, changes };
}

test('four placements share one provider; completion is once and old modal callbacks cannot complete a later request', () => {
  const { view, provider, service, changes } = fixture();
  let priorId;
  for (const placement of ['weapon-daily', 'weapon-unlock', 'rebirth', 'speedrun']) {
    const outcomes = [];
    service.showRewardedAd(`business:${placement}`, placement, value => outcomes.push(value));
    const id = view.id;
    assert.ok(id && id !== priorId);
    if (priorId) provider.resolve(priorId, 'success');
    assert.deepEqual(outcomes, []);
    provider.resolve(id, 'success'); provider.resolve(id, 'success');
    assert.deepEqual(outcomes, ['success']); assert.equal(service.isPresenting, false); assert.equal(view.id, null);
    priorId = id;
  }
  assert.deepEqual(changes, Array.from({ length: 8 }, (_, i) => i % 2 === 0));
});

test('another placement is rejected without replacing the active modal or leaving a business token pending', () => {
  const { view, provider, service } = fixture(); const session = new BattleSession({ environment: 'test', contentConfig: resolveContentConfig('test', { adsEnabled: true }) });
  const daily = session.weapons.beginAd('daily');
  service.showRewardedAd(daily.token, 'weapon-daily', outcome => session.weapons.completeAd(daily.token, outcome));
  const activeId = view.id;
  session.configureProgressionTest({ stageIndex: 2, waveIndex: 0, stageValueMax: 20 });
  const rebirth = session.requestRebirth('ad'); assert.equal(rebirth.ok, true);
  service.showRewardedAd(rebirth.token, 'rebirth', outcome => session.completeRebirthAd(rebirth.token, outcome));
  assert.equal(session.getRebirthState().phase, 'idle'); assert.equal(view.id, activeId);
  provider.resolve(activeId, 'success'); assert.equal(session.weapons.snapshot().dailyAdAvailable, false);
  assert.equal(session.weapons.snapshot().backpack.filter(Boolean).length, 1);
});

test('cancel/failure can retry and app cancellation invalidates all outstanding callbacks', () => {
  const { view, provider, service } = fixture(); const outcomes = [];
  for (const result of ['cancel', 'failure']) {
    service.showRewardedAd(result, 'speedrun', outcome => outcomes.push(outcome));
    provider.resolve(view.id, result);
  }
  service.showRewardedAd('hide', 'rebirth', outcome => outcomes.push(outcome));
  const id = view.id; service.cancelAll(); provider.resolve(id, 'success');
  assert.deepEqual(outcomes, ['cancel', 'failure', 'cancel']);
  service.showRewardedAd('close', 'weapon-daily', outcome => outcomes.push(outcome));
  const closeId = view.id;
  service.cancelRewardedAd('wrong'); assert.equal(view.id, closeId);
  service.cancelRewardedAd('close'); provider.resolve(closeId, 'success');
  assert.deepEqual(outcomes, ['cancel', 'failure', 'cancel']);
  service.showRewardedAd('destroy', 'weapon-unlock', outcome => outcomes.push(outcome));
  const destroyedId = view.id; service.destroy(); service.destroy(); provider.resolve(destroyedId, 'success');
  assert.deepEqual(outcomes, ['cancel', 'failure', 'cancel', 'cancel']); assert.equal(view.id, null);
  service.showRewardedAd('too-late', 'speedrun', outcome => outcomes.push(outcome));
  assert.equal(outcomes.at(-1), 'failure'); assert.equal(view.id, null);
});

test('provider exceptions, malformed outcomes and synchronous completion fail safely with request-scoped cleanup', () => {
  for (const mode of ['throws', 'invalid', 'sync-success']) {
    const outcomes = []; let cleanups = 0;
    const service = new RewardedAdService({ show(request, complete) {
      if (mode === 'throws') throw new Error('SDK show failed');
      complete(mode === 'invalid' ? 'not-an-outcome' : 'success'); complete('success');
      return () => cleanups++;
    } });
    service.showRewardedAd('token', 'rebirth', result => outcomes.push(result));
    assert.deepEqual(outcomes, [mode === 'sync-success' ? 'success' : 'failure']);
    assert.equal(service.isPresenting, false); assert.equal(cleanups, mode === 'throws' ? 0 : 1);
  }
});

test('replacing a provider does not bypass the challenge reward transaction or replay its reward', () => {
  const session = new BattleSession({ contentConfig: resolveContentConfig('production', {
    adsEnabled: true, thresholds: { challengePowerLevel: 0 }, firstDrawDiamonds: 0,
  }) }); session.startSpeedRun(); session.advanceFrame(1.5);
  session.consume([{ type: 'complete', position: { x: 0, z: 0 } }], [{ id: 1000000, alive: false }], session.roundId);
  assert.equal(session.weapons.diamonds, 60);
  let finish;
  const service = new RewardedAdService({ show(request, complete) { finish = complete; assert.equal(request.placement, 'speedrun'); } });
  const start = session.beginSpeedRunAd();
  service.showRewardedAd(start.token, 'speedrun', result => session.completeSpeedRunAd(start.token, result));
  finish('success'); finish('success');
  assert.equal(session.weapons.diamonds, 240); assert.equal(session.getSpeedRunState().phase, 'exiting');
});

test('a disabled placement never opens the provider and disabling it during playback suppresses success', () => {
  let enabled = false, opens = 0, finish, cleanups = 0;
  const outcomes = [];
  const service = new RewardedAdService({ show(request, complete) { opens++; finish = complete; return () => cleanups++; } },
    () => {}, () => enabled);
  service.showRewardedAd('disabled', 'rebirth', outcome => outcomes.push(outcome));
  assert.equal(opens, 0); assert.deepEqual(outcomes, ['failure']);
  enabled = true;
  service.showRewardedAd('enabled', 'rebirth', outcome => outcomes.push(outcome));
  assert.equal(opens, 1); enabled = false; finish('success'); finish('success');
  assert.deepEqual(outcomes, ['failure', 'cancel']); assert.equal(cleanups, 1); assert.equal(service.isPresenting, false);
});

test('a policy change from the presentation observer prevents the provider from opening', () => {
  let enabled = true, opens = 0; const outcomes = [];
  const service = new RewardedAdService({ show() { opens++; } }, () => { enabled = false; }, () => enabled);
  service.showRewardedAd('disabled-before-open', 'speedrun', outcome => outcomes.push(outcome));
  assert.equal(opens, 0); assert.deepEqual(outcomes, ['cancel']); assert.equal(service.isPresenting, false);
});

test('production provider fails without granting or leaving the shared slot occupied', () => {
  const outcomes = [], service = new RewardedAdService(new UnavailableRewardedAdProvider());
  service.showRewardedAd('production', 'speedrun', outcome => outcomes.push(outcome));
  assert.deepEqual(outcomes, ['failure']); assert.equal(service.isPresenting, false);
});

test('a throwing SDK cleanup still settles the business request once and allows the next placement', () => {
  let finish; const outcomes = [];
  const service = new RewardedAdService({ show(request, complete) {
    finish = complete; return () => { throw new Error('SDK offClose failed'); };
  } });
  service.showRewardedAd('first', 'speedrun', result => outcomes.push(result));
  finish('success'); finish('success');
  assert.deepEqual(outcomes, ['success']); assert.equal(service.isPresenting, false);
  service.showRewardedAd('second', 'rebirth', result => outcomes.push(result));
  service.cancelAll(); finish('success');
  assert.deepEqual(outcomes, ['success', 'cancel']);
});
