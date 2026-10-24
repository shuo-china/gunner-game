const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_HUNT_TEST_BUILD || path.resolve(__dirname, '.build/session');
const { HuntSystem, validateHuntSave } = require(path.join(build, 'session/HuntSystem.js'));
const { ContentUnlockManager } = require(path.join(build, 'session/ContentUnlockManager.js'));
const { resolveContentConfig } = require(path.join(build, 'session/ContentConfig.js'));
const make = () => new HuntSystem(new ContentUnlockManager(resolveContentConfig('test', { adsEnabled: true })));

test('hunt has 2 second entry and clear waits, five levels per wave, no terminal victory', () => {
  const h = make(); assert.equal(h.start().ok, true);
  assert.equal(h.advanceFrame(1.999), null); assert.equal(h.advanceFrame(.001), 'entered');
  for (let level = 0; level < 5; level++) {
    assert.equal(h.requestClear(0, level), true); assert.equal(h.canFight, false);
    assert.equal(h.advanceFrame(20), null); h.commitClear(h.nextSave());
    assert.equal(h.advanceFrame(.1), null); assert.equal(h.advanceFrame(1.999), null);
    assert.equal(h.advanceFrame(.001), 'next');
  }
  assert.deepEqual(h.serialize(), { wave: 1, level: 0 }); assert.equal(h.snapshot(150).runReward, 150);
  assert.equal(h.phase, 'playing'); assert.equal(h.firstClear, true);
});

test('hunt stale clear, pause, failure, give-up and ordinary exit cannot duplicate rewards', () => {
  const h = make(); h.start(); assert.equal(h.advanceFrame(20, true), null); h.advanceFrame(2);
  assert.equal(h.requestClear(0, 1), false); assert.equal(h.requestClear(0, 0), true);
  assert.equal(h.requestClear(0, 0), false); assert.equal(h.giveUp().ok, false);
  h.commitClear(h.nextSave()); h.commitClear(h.nextSave()); assert.equal(h.runReward, 30);
  assert.equal(h.giveUp().ok, true); assert.equal(h.snapshot(30).adAvailable, true);
  assert.equal(h.exit().ok, true); h.advanceFrame(.01); assert.equal(h.advanceFrame(1.5), 'exited');
  assert.equal(h.start().ok, true); assert.equal(h.runReward, 0);
});

test('hunt successful ad stays pending until wallet commit, cancel and stale callbacks are inert', () => {
  const h = make(); h.start(); h.advanceFrame(2); h.requestClear(0, 0); h.commitClear(h.nextSave()); h.giveUp();
  const first = h.beginAd(); assert.equal(h.completeAd(first.token, 'cancel').ok, false); assert.equal(h.phase, 'failed');
  const ad = h.beginAd(); assert.equal(h.completeAd(first.token, 'success').reason, 'staleAd');
  assert.equal(h.completeAd(ad.token, 'success').ok, true); assert.equal(h.pendingAdReward, true);
  h.cancelAd(); assert.equal(h.phase, 'adPending'); assert.equal(h.advanceFrame(10), null);
  h.commitAd(); assert.equal(h.phase, 'exiting'); assert.equal(h.completeAd(ad.token, 'success').reason, 'staleAd');
});

test('hunt save requires integral wave/level and restores no active reward entitlement', () => {
  const h = make(); assert.throws(() => h.restore(undefined), /Invalid hunt save/); h.restore({ wave: 12, level: 4 });
  assert.deepEqual(h.serialize(), { wave: 12, level: 4 }); assert.equal(h.runReward, 0); assert.equal(h.phase, 'idle');
  for (const bad of [null, {}, {wave:-1,level:0}, {wave:0,level:5}, {wave:1.5,level:0}, {wave:Number.MAX_SAFE_INTEGER,level:0}])
    assert.throws(() => validateHuntSave(bad));
});
