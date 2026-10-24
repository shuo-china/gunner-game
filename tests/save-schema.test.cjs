const test = require('node:test');
const assert = require('node:assert/strict');
const { ContentUnlockManager } = require('./.build/session/session/ContentUnlockManager.js');
const NOW = Date.UTC(2026, 9, 24, 0);

test('gameplay restore rejects absent data without modifying current state; constructors own new-game defaults', () => {
  const content = new ContentUnlockManager();
  const constructors = [
    ['SkinSystem', 'SkinSystem', []], ['FishSystem', 'FishSystem', []], ['HuntSystem', 'HuntSystem', [content]],
    ['MineSystem', 'MineSystem', [content, () => NOW]], ['MineSystem', 'AttackSpeedBuff', []],
    ['BossSystem', 'BossSystem', [content]], ['SpeedRunSystem', 'SpeedRunSystem', [content]],
    ['RelicSystem', 'RelicSystem', []], ['AdventureSystem', 'AdventureSystem', [NOW]],
  ];
  for (const [file, name, args] of constructors) {
    const Constructor = require(`./.build/session/session/${file}.js`)[name], system = new Constructor(...args);
    const fresh = system.serialize();
    system.restore(structuredClone(fresh)); assert.deepEqual(system.serialize(), fresh, `${name} restores current saves`);
    assert.throws(() => system.restore(undefined), /Invalid .* save/, name);
    assert.deepEqual(system.serialize(), fresh, `${name} preserves state after rejecting absent data`);
  }
});
