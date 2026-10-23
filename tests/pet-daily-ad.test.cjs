const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const build = process.env.FOREST_GUNNER_HUNT_TEST_BUILD || path.resolve(__dirname,'.build/session');
const load = file => require(path.join(build,file));
const { BattleSession, economyStorageKey } = load('session/BattleSession.js');
const { resolveContentConfig } = load('session/ContentConfig.js');
const { PetSystem } = load('session/PetSystem.js');
const { RewardedAdService } = load('session/RewardedAds.js');
function fixture(patch,adsEnabled=true) {
  const data=new Map(),key=economyStorageKey('test');let now=new Date(2026,9,15,12).getTime();
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const contentConfig=resolveContentConfig('test',{adsEnabled,tutorialEnabled:false,testResources:{diamonds:0,starGems:0,fundGoldUpgrades:false,fundRebirthUpgrades:false}});
  const make=()=>new BattleSession({environment:'test',contentConfig,storage,now:()=>now,rng:()=>.1});
  let session=make();const save=JSON.parse(data.get(key));save.hunt={wave:0,level:1};if(patch)patch(save);data.set(key,JSON.stringify(save));session=make();
  return {session,make,data,key,storage,setTime:v=>now=v};
}

test('pet daily grants configured C once after hunt, keeping diamonds, coins and selected pets',()=>{
  const f=fixture(save=>{save.weapons.diamonds=123;save.pets.coins=456;save.pets.selected=[4,-1,-1];});const s=f.session;
  const ad=s.beginPetAd();assert.equal(ad.ok,true);assert.equal(s.completePetAd(ad.token,'success').grade,1);
  const p=s.getPetState();assert.equal(p.owned[0],1);assert.equal(p.collected[1],true);assert.equal(p.diamonds,123);assert.equal(p.coins,456);assert.deepEqual(p.selected,[4,-1,-1]);
  assert.equal(p.dailyAdRemaining,0);assert.equal(s.beginPetAd().reason,'dailyLimit');assert.equal(s.completePetAd(ad.token,'success').reason,'staleAd');
  assert.equal(f.make().getPetState().dailyAdRemaining,0);
});

test('pet daily is denied before first hunt, with ads disabled, or when the backpack is full',()=>{
  assert.equal(fixture(s=>s.hunt={wave:0,level:0}).session.beginPetAd().reason,'contentLocked');
  assert.equal(fixture(undefined,false).session.beginPetAd().reason,'contentLocked');
  const full=fixture(s=>s.pets.owned=Array(16).fill(0)).session;assert.equal(full.beginPetAd().reason,'full');assert.equal(full.getPetState().dailyAdRemaining,1);
});

test('pet ad cancel/failure, rollover, backwards clock and stale tokens cannot grant or consume daily allowance',()=>{
  const f=fixture(),s=f.session;
  for(const outcome of ['cancel','failure']){const ad=s.beginPetAd();assert.equal(s.completePetAd(ad.token,outcome).ok,false);assert.equal(s.getPetState().dailyAdRemaining,1);}
  const old=s.beginPetAd();s.cancelPetAd();const newer=s.beginPetAd();assert.equal(s.completePetAd(old.token,'success').reason,'staleAd');
  f.setTime(new Date(2026,9,16,12).getTime());assert.equal(s.completePetAd(newer.token,'success').reason,'staleAd');
  const ad=s.beginPetAd();assert.equal(s.completePetAd(ad.token,'success').ok,true);
  f.setTime(new Date(2026,9,15,12).getTime());assert.equal(s.getPetState().dailyAdRemaining,0);
  f.setTime(new Date(2026,9,17,12).getTime());assert.equal(s.getPetState().dailyAdRemaining,1);
  const rollback=s.beginPetAd();f.setTime(new Date(2026,9,17,11).getTime());assert.equal(s.completePetAd(rollback.token,'success').reason,'staleAd');
});

test('pet daily failed durable write consumes neither inventory nor date and later retry succeeds',()=>{
  const f=fixture(),s=f.session,write=f.storage.setItem,before=s.getPetState();f.storage.setItem=()=>{};
  const ad=s.beginPetAd();assert.equal(s.completePetAd(ad.token,'success').reason,'saveFailed');assert.deepEqual(s.getPetState(),before);
  f.storage.setItem=write;const retry=s.beginPetAd();assert.equal(s.completePetAd(retry.token,'success').ok,true);
  assert.equal(s.getPetState().owned.filter(x=>x>=0).length,1);assert.equal(f.make().getPetState().dailyAdRemaining,0);
});

test('fish and pet advertisements block each other, hunts, rebirth and concurrent inventory mutations',()=>{
  const f=fixture(s=>{s.weapons.diamonds=1000;s.fish.freeDrawDate='2026-10-15';s.fish.freeDrawCount=3;}),s=f.session;
  const fish=s.beginFishAd();assert.equal(fish.ok,true);assert.equal(s.beginPetAd().reason,'busy');assert.equal(s.startHunt().reason,'busy');
  s.cancelFishAd();const pet=s.beginPetAd();assert.equal(pet.ok,true);
  for(const result of [s.beginFishAd(),s.startHunt(),s.requestRebirth('normal'),s.startBoss(),s.startSpeedRun(),s.openRaid(),s.drawPet('diamonds'),s.drawFish('diamonds')])assert.equal(result.reason,'busy');
  s.cancelPetAd();assert.equal(s.startHunt().ok,true);assert.equal(s.completePetAd(pet.token,'success').reason,'staleAd');
});

test('legacy pet dates migrate as already claimed and daily counts above a reduced limit remain valid',()=>{
  const f=fixture(s=>{delete s.pets.dailyAdCount;s.pets.lastDailyAdDate='2026-10-15';});assert.equal(f.session.getPetState().dailyAdRemaining,0);
  const p=new PetSystem();const saved=f.session.getPetState();p.restore({...saved,dailyAdCount:5});assert.equal(p.dailyAdRemaining('2026-10-15'),0);assert.equal(p.dailyAdRemaining('2026-10-16'),1);
  assert.throws(()=>p.restore({...saved,lastDailyAdDate:'2026-02-31'}));
});

test('real PetHud original AD_Draw_Btn_Click uses shared service and ignores late callbacks after cancellation',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../assets/scripts/view/PetHud.ts'),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText;
  const module={exports:{}};vm.runInNewContext(js,{module,exports:module.exports,require:id=>id.endsWith('/PetSystem')?load('session/PetSystem.js'):id.endsWith('/EconomyConfig')?load('core/EconomyConfig.js'):{}});
  const f=fixture(),s=f.session,records=[];let providerCallback;
  const service=new RewardedAdService({show(request,complete){records.push(request.placement);providerCallback=complete;}});
  const hud=Object.create(module.exports.PetHud.prototype);
  Object.assign(hud,{adToken:null,destroyed:false,rewardedAds:service,stopAuto(){},refresh(){},check(result){records.push(result.ok);return result.ok;},callbacks:{
    getDailyAdState:()=>s.getContentState('petDailyAd'),getState:()=>s.getPetState(),beginAd:()=>s.beginPetAd(),completeAd:(token,outcome)=>s.completePetAd(token,outcome),cancelAd:()=>s.cancelPetAd(),playSfx:()=>{}}});
  hud.invoke('AD_Draw_Btn_Click','',false);assert.equal(records[0],'pet-daily');providerCallback('success');assert.equal(s.getPetState().owned[0],1);
  const f2=fixture(),s2=f2.session;hud.callbacks.getState=()=>s2.getPetState();hud.callbacks.beginAd=()=>s2.beginPetAd();hud.callbacks.completeAd=(t,o)=>s2.completePetAd(t,o);hud.callbacks.cancelAd=()=>s2.cancelPetAd();
  hud.invoke('AD_Draw_Btn_Click','',false);const late=providerCallback,token=hud.adToken;hud.adToken=null;service.cancelRewardedAd(token);s2.cancelPetAd();late('success');assert.equal(s2.getPetState().owned[0],-1);
});
