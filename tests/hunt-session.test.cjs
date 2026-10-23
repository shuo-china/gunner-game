const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.FOREST_GUNNER_HUNT_TEST_BUILD || path.resolve(__dirname, '.build/session');
const { BattleSession, economyStorageKey } = require(path.join(build,'session/BattleSession.js'));
const { resolveContentConfig } = require(path.join(build,'session/ContentConfig.js'));
function fixture(patch,adsEnabled=true) {
  const data=new Map(),key=economyStorageKey('test'),writes=[];
  const storage={getItem:k=>data.get(k)??null,setItem(k,v){data.set(k,v);writes.push(v);}};
  const contentConfig=resolveContentConfig('test',{adsEnabled,tutorialEnabled:false,testResources:{diamonds:0,starGems:0,fundGoldUpgrades:false,fundRebirthUpgrades:false}});
  const make=()=>new BattleSession({environment:'test',storage,contentConfig,now:()=>1792022400000,rng:()=>.5});
  let session=make();if(patch){const save=JSON.parse(data.get(key));patch(save);data.set(key,JSON.stringify(save));session=make();}
  writes.length=0;return {session,make,data,key,storage,writes};
}
function enter(s){assert.equal(s.startHunt().ok,true);assert.equal(s.advanceFrame(1.9),null);assert.ok(s.advanceFrame(.1));assert.equal(s.canFight,true);}
function clear(s,id=s.roundId){const h=s.getHuntState();s.consume([{type:'huntLevelComplete',wave:h.wave,level:h.level}],[],id);}
function next(s){s.advanceFrame(.016);return s.advanceFrame(2);}

test('hunt level reward and permanent progress commit together; next level reuses combat and leaves main history unchanged',()=>{
  const f=fixture(),s=f.session,main=JSON.parse(f.data.get(f.key)).progress;enter(s);const combat=s.getHuntCombat(),id=s.roundId;
  clear(s);assert.equal(s.getPetState().coins,30);assert.equal(s.getHuntState().phase,'clearing');assert.equal(f.writes.length,1);
  const saved=JSON.parse(f.data.get(f.key));assert.deepEqual(saved.hunt,{wave:0,level:1});assert.equal(saved.pets.coins,30);assert.deepEqual(saved.progress,main);
  clear(s,id);assert.equal(s.getPetState().coins,30);const round=next(s);assert.ok(round.roundId>id);assert.equal(s.getHuntCombat(),combat);
  clear(s,id);assert.equal(s.getPetState().coins,30);
  for(let i=0;i<4;i++){clear(s);next(s);}assert.deepEqual(JSON.parse(f.data.get(f.key)).hunt,{wave:1,level:0});assert.equal(s.getPetState().coins,150);
  assert.equal(s.getContentState('petDailyAd').unlocked,true);
});

test('hunt abandonment and leak keep earned coins; ordinary return works with advertisements disabled',()=>{
  const f=fixture(undefined,false),s=f.session;enter(s);clear(s);next(s);assert.equal(s.giveUpHunt().ok,true);
  assert.equal(s.getHuntState().adEnabled,false);assert.equal(s.beginHuntAd().reason,'adsDisabled');assert.equal(s.getPetState().coins,30);
  assert.equal(s.exitHunt().ok,true);assert.ok(s.advanceFrame(1.5));assert.equal(s.mode,'Main');assert.equal(s.getPetState().coins,30);
  enter(s);s.getHuntCombat().barrierHp=0;s.consume([{type:'huntFailed'}],[]);assert.equal(s.getHuntState().phase,'failed');assert.equal(s.getHuntState().hp,0);
});

test('hunt ad adds current-run reward once; cancel/failure and restart cannot repeat it',()=>{
  const f=fixture(),s=f.session;enter(s);clear(s);next(s);clear(s);assert.equal(s.giveUpHunt().ok,true);
  for(const outcome of ['cancel','failure']){const ad=s.beginHuntAd();assert.equal(s.completeHuntAd(ad.token,outcome).ok,false);assert.equal(s.getPetState().coins,60);}
  const ad=s.beginHuntAd();assert.equal(s.completeHuntAd(ad.token,'success').ok,true);assert.equal(s.getPetState().coins,120);
  assert.equal(s.completeHuntAd(ad.token,'success').ok,false);assert.equal(s.getPetState().coins,120);
  const restored=f.make();assert.equal(restored.mode,'Main');assert.equal(restored.getPetState().coins,120);assert.equal(restored.getHuntState().runReward,0);
  assert.equal(restored.beginHuntAd().ok,false);
});

test('hunt persistence rejects dropped writes, retries pending level and recognises uncertain successful writes exactly once',()=>{
  for(const behavior of ['throw','drop','afterWrite','readFail','reenter']) {
    const f=fixture(),s=f.session;enter(s);const write=f.storage.setItem,read=f.storage.getItem;let reentrant;
    f.storage.setItem=(k,v)=>{if(behavior==='reenter')reentrant=s.retryHuntSettlement();if(behavior==='throw')throw Error('quota');if(behavior!=='drop')write(k,v);if(behavior==='afterWrite')throw Error('after write');if(behavior==='readFail')f.storage.getItem=()=>{throw Error('read');};};
    const warn=console.warn;console.warn=()=>{};try{clear(s);}finally{console.warn=warn;}
    const failed=['throw','drop','readFail'].includes(behavior);
    assert.equal(s.getPetState().coins,failed?0:30,behavior);assert.equal(s.getHuntState().settlementPending,failed,behavior);
    if(reentrant)assert.equal(reentrant.reason,'busy');
    f.storage.setItem=write;f.storage.getItem=read;
    if(failed)assert.equal(s.retryHuntSettlement().ok,true,behavior);
    assert.equal(s.getPetState().coins,30,behavior);assert.deepEqual(JSON.parse(f.data.get(f.key)).hunt,{wave:0,level:1});
    assert.equal(s.retryHuntSettlement().ok,false);assert.equal(s.getPetState().coins,30);
  }
});

test('hunt successful ad retries without watching again after storage failure',()=>{
  const f=fixture(),s=f.session;enter(s);clear(s);s.giveUpHunt();const ad=s.beginHuntAd(),write=f.storage.setItem;
  f.storage.setItem=()=>{};assert.equal(s.completeHuntAd(ad.token,'success').reason,'saveFailed');assert.equal(s.getPetState().coins,30);
  s.cancelHuntAd();assert.equal(s.getHuntState().settlementPending,true);f.storage.setItem=write;
  assert.equal(s.retryHuntSettlement().ok,true);assert.equal(s.getPetState().coins,60);assert.equal(s.getHuntState().phase,'exiting');
});

test('ordinary exit can finish an already-earned advertisement whose save was temporarily unavailable',()=>{
  const f=fixture(),s=f.session;enter(s);clear(s);s.giveUpHunt();const ad=s.beginHuntAd(),write=f.storage.setItem;
  f.storage.setItem=()=>{};s.completeHuntAd(ad.token,'success');f.storage.setItem=write;
  assert.equal(s.exitHunt().ok,true);assert.equal(s.getPetState().coins,60);assert.ok(s.advanceFrame(1.5));assert.equal(s.mode,'Main');
});

test('pending hunt transaction preserves intervening weapon state and denies competing session transactions',()=>{
  const f=fixture(),s=f.session;enter(s);const write=f.storage.setItem;f.storage.setItem=()=>{};clear(s);
  assert.equal(s.retryHuntSettlement().reason,'saveFailed');assert.equal(s.redeemCode('950424').reason,'saveFailed');
  assert.equal(s.purchaseRebirthUpgrade('power'),false);assert.equal(s.configureRebirthTest({}),false);
  assert.throws(()=>s.setMode('Main'));
  s.weapons.grantDiamonds(77);f.storage.setItem=write;assert.equal(s.retryHuntSettlement().ok,true);
  assert.equal(f.make().weapons.diamonds,77);assert.equal(f.make().getPetState().coins,30);
});

test('reentrant storage cannot settle a Hunt candidate that omits a concurrent weapon mutation',()=>{
  const f=fixture(),s=f.session;enter(s);const write=f.storage.setItem;let once=true;
  f.storage.setItem=(k,v)=>{write(k,v);if(once){once=false;s.weapons.grantDiamonds(77);}};clear(s);
  assert.equal(s.getHuntState().settlementPending,true);assert.equal(s.getPetState().coins,0);
  assert.equal(s.retryHuntSettlement().ok,true);assert.equal(f.make().weapons.diamonds,77);assert.equal(f.make().getPetState().coins,30);
});

test('optional hunt migration and rebirth preserve fish, pets, claims and unrelated v3 balances',()=>{
  const warn=console.warn;console.warn=()=>{};
  try{for(const hunt of [undefined,null,{}, {wave:-1,level:0},{wave:0,level:9}]){
    const f=fixture(save=>{save.hunt=hunt;save.weapons.diamonds=731;save.pets.coins=97;save.fish.inventory=[3,3];});
    assert.equal(f.session.weapons.diamonds,731);assert.equal(f.session.getPetState().coins,97);assert.deepEqual(f.session.getFishState().inventory,[3,3]);assert.equal(f.session.getHuntState().wave,0);
  }}finally{console.warn=warn;}
  const f=fixture(save=>{save.hunt={wave:5,level:3};save.pets.coins=999;save.fish.inventory=[4];});
  const before=JSON.parse(f.data.get(f.key));assert.equal(f.session.requestRebirth('normal').ok,true);f.session.advanceRebirth(2);
  const after=JSON.parse(f.data.get(f.key));assert.deepEqual(after.hunt,before.hunt);assert.deepEqual(after.fish,before.fish);assert.deepEqual(after.pets,before.pets);
});

test('hunt excludes gold attack and speed upgrades while preserving fish damage/critical bonuses like Boss',()=>{
  const f=fixture(save=>{save.levels=[100,100,100];save.fish.inventory=[2,2];}),s=f.session;
  const main=s.getLoadout();assert.equal(s.startBoss().ok,true);const boss=s.getLoadout();s.exitBoss();s.advanceFrame(1.5);
  enter(s);const hunt=s.getLoadout();assert.deepEqual(hunt,boss);assert.ok(hunt[0].damage.compare(main[0].damage)<0);
  assert.ok(hunt[0].criticalChance>0);assert.ok(hunt[0].criticalMultiplier>1.25);assert.equal(s.purchase('power'),false);
});
