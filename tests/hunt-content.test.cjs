const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const build = process.env.FOREST_GUNNER_HUNT_TEST_BUILD || path.resolve(__dirname, '.build/session');
const { ContentUnlockManager } = require(path.join(build, 'session/ContentUnlockManager.js'));
const { resolveContentConfig } = require(path.join(build, 'session/ContentConfig.js'));
const { ECONOMY_CONFIG, validateEconomyConfig } = require(path.join(build, 'core/EconomyConfig.js'));

test('hunt original historical 10/12 entry gates and tutorial override apply independently of pets', () => {
  const c = new ContentUnlockManager(resolveContentConfig('production'));
  for (const [stageValueMax, visible, unlocked] of [[89,false,false],[90,true,false],[109,true,false],[110,true,true]]) {
    const state = c.get('hunt', {stageValueMax,tutorialCompleted:true});
    assert.equal(state.visible,visible); assert.equal(state.unlocked,unlocked);
  }
  assert.equal(c.get('hunt',{stageValueMax:999,tutorialCompleted:false}).visible,false);
  assert.equal(new ContentUnlockManager(resolveContentConfig('test')).get('hunt').unlocked,true);
});

test('pet daily needs an actual first hunt clear even in test; both advertisements obey global and placement switches', () => {
  const on = new ContentUnlockManager(resolveContentConfig('test',{adsEnabled:true}));
  assert.equal(on.get('petDailyAd').unlocked,false);
  assert.equal(on.get('petDailyAd',{huntFirstClear:true}).unlocked,true);
  assert.equal(on.get('huntAd').unlocked,true);
  const off = new ContentUnlockManager(resolveContentConfig('test'));
  assert.equal(off.get('petDailyAd',{huntFirstClear:true}).reason,'adsDisabled');
  assert.equal(off.get('huntAd').reason,'adsDisabled');
  const partial = new ContentUnlockManager(resolveContentConfig('test',{adsEnabled:true,adPlacements:{hunt:false,'pet-daily':false}}));
  assert.equal(partial.get('huntAd').unlocked,false); assert.equal(partial.get('petDailyAd',{huntFirstClear:true}).unlocked,false);
});

test('hunt and daily pet rewards are authored and validated centrally', () => {
  assert.deepEqual(ECONOMY_CONFIG.hunt,{petCoinsPerLevel:30,adAdditionalMultiplier:1});
  assert.deepEqual(ECONOMY_CONFIG.pets.dailyAd,{grade:1,dailyLimit:1});
  for(const mutate of [c=>c.hunt.petCoinsPerLevel=-1,c=>c.hunt.adAdditionalMultiplier=.5,c=>c.pets.dailyAd.grade=10,c=>c.pets.dailyAd.dailyLimit=-1]) {
    const c=JSON.parse(JSON.stringify(ECONOMY_CONFIG));mutate(c);assert.throws(()=>validateEconomyConfig(c));
  }
});

test('edited economy values drive hunt previews, ordinary/ad settlement and daily pet grade/limit together',()=>{
  const original=require(path.join(build,'core/EconomyConfig.js')),config=JSON.parse(JSON.stringify(original.ECONOMY_CONFIG));
  config.hunt.petCoinsPerLevel=75;config.hunt.adAdditionalMultiplier=2;config.pets.dailyAd={grade:3,dailyLimit:2};original.validateEconomyConfig(config);
  const cache=new Map([[path.join(build,'core/EconomyConfig.js'),{...original,ECONOMY_CONFIG:config}]]);
  function load(name,parent=build){const file=path.resolve(parent,name.endsWith('.js')?name:name+'.js');if(cache.has(file))return cache.get(file);
    const module={exports:{}};cache.set(file,module.exports);vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file,'utf8')}\n})`,{filename:file})(id=>load(id,path.dirname(file)),module,module.exports);cache.set(file,module.exports);return module.exports;}
  const {BattleSession}=load('session/BattleSession'),{resolveContentConfig}=load('session/ContentConfig');
  const s=new BattleSession({environment:'test',now:()=>new Date(2026,9,15,12).getTime(),contentConfig:resolveContentConfig('test',{adsEnabled:true})});
  s.startHunt();s.advanceFrame(2);assert.equal(s.getHuntState().reward,75);s.consume([{type:'huntLevelComplete',wave:0,level:0}],[]);
  assert.equal(s.getPetState().coins,75);assert.equal(s.getHuntState().adReward,150);s.giveUpHunt();const ad=s.beginHuntAd();s.completeHuntAd(ad.token,'success');
  assert.equal(s.getPetState().coins,225);s.advanceFrame(1.5);
  for(let i=0;i<2;i++){const request=s.beginPetAd();assert.equal(request.ok,true);assert.equal(s.completePetAd(request.token,'success').grade,3);}
  assert.equal(s.beginPetAd().reason,'dailyLimit');assert.deepEqual(s.getPetState().owned.slice(0,2),[3,3]);
});
