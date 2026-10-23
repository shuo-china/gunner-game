const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { looseArraySpread } = require('./support/loose-array-spread.cjs');
const { AdventureSystem } = require('./.build/session/session/AdventureSystem.js');

function releasePets() {
  const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/session/PetSystem.ts'), 'utf8');
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
    transformers: { before: [looseArraySpread] } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(
    key => require(path.resolve(__dirname, '.build/session/session', key)), module, module.exports);
  return new module.exports.PetSystem();
}
const now = new Date(2026, 9, 18, 12).getTime();

test('release-compiled locks protect all 19 slots, ignore ordering and release on cancel or claim', () => {
  const p = releasePets();
  const save = p.serialize();save.owned.fill(0);save.selected.fill(0);save.autoEnabled=true;save.collected[1]=true;p.restore(save);
  const refs = [...Array.from({length:16},(_,index)=>({kind:'owned',index})),...Array.from({length:3},(_,index)=>({kind:'selected',index}))];
  p.setLocks(refs);const revision=p.snapshot(0).revision;
  assert.equal(p.snapshot(0).ownedLocked.every(Boolean),true);assert.equal(p.snapshot(0).selectedLocked.every(Boolean),true);
  assert.equal(p.autoPair(),null);p.setLocks(refs.slice().reverse());assert.equal(p.snapshot(0).revision,revision);
  for(const ref of refs){assert.equal(p.move(ref,{kind:'owned',index:0}).reason,'locked');if(ref.kind==='selected')assert.equal(p.unequip(ref.index).reason,'locked');}
  assert.equal(p.merge(0,1).reason,'locked');p.setLocks([]);assert.ok(p.autoPair());
  for(const end of ['cancel','claim']){
    const a=new AdventureSystem(now);assert.equal(a.start(0,0,[refs[0]],p.serialize(),now).ok,true);p.setLocks(a.locks());
    assert.equal(p.merge(0,1).reason,'locked');assert.equal(p.move(refs[1],refs[0]).reason,'locked');
    assert.equal(a[end](0,0,now+3600000).ok,true);p.setLocks(a.locks());assert.equal(p.isLocked(refs[0]),false);
  }
  assert.equal(p.merge(0,1).ok,true);
});

test('release-compiled same-size replacement locks update the actual pet identities',()=>{
 const p=releasePets(),save=p.serialize();save.owned.fill(0);p.restore(save);
 p.setLocks([{kind:'owned',index:0}]);const revision=p.snapshot(0).revision;
 p.setLocks([{kind:'owned',index:1}]);assert.equal(p.snapshot(0).revision,revision+1);
 assert.equal(p.isLocked({kind:'owned',index:0}),false);assert.equal(p.isLocked({kind:'owned',index:1}),true);
});
