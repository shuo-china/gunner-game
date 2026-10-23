const test = require('node:test');
const assert = require('node:assert/strict');
const { loadResourceBatch } = require('./support/resource-modules.cjs').resourceModules()('ResourceBatch');

test('first-use loading limits concurrent work and retries only the failed asset', async () => {
  let active = 0, peak = 0;
  const calls = Array(125).fill(0), waits = [];
  await loadResourceBatch(calls.map((_, i) => async () => {
    calls[i]++; peak = Math.max(peak, ++active);
    await new Promise(setImmediate); active--;
    if (i === 17 && calls[i] < 3) throw Error('temporary download failure');
  }), async ms => { waits.push(ms); });
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(calls[17], 3); assert.ok(calls.every((n, i) => n === (i === 17 ? 3 : 1)));
  assert.deepEqual(waits, [250, 1000]);
});

test('a permanent failure waits for other pending resources before reporting failure', async () => {
  let release, settled = false;
  const pending = loadResourceBatch([
    async () => { throw Error('missing weapon icon'); },
    () => new Promise(resolve => { release = resolve; }),
  ], async () => {});
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(setImmediate); assert.equal(settled, false);
  release(); await assert.rejects(pending, /missing weapon icon/);
  assert.equal(settled, true);
});
