const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PetSystem,PET_CATALOG} = require('./.build/session/session/PetSystem.js');
const {BattleSession,economyStorageKey} = require('./.build/session/session/BattleSession.js');
const {resolveContentConfig} = require('./.build/session/session/ContentConfig.js');
const {ContentUnlockManager} = require('./.build/session/session/ContentUnlockManager.js');
const {CombatWorld,PetFollowers,DecimalAmount:D} = require('./.build/core/index.js');
const {PetAnimation,petTimelineValue} = require('./.build/character/PetAnimation.js');
const owned = index => ({kind:'owned',index}), selected = index => ({kind:'selected',index});
const save = (grades=[],equipped=[]) => ({owned:[...grades,...Array(16-grades.length).fill(-1)],selected:[...equipped,...Array(3-equipped.length).fill(-1)],collected:Array(10).fill(false),coins:0,autoEnabled:false,lastDailyAdDate:'',dailyAdCount:0});
function fixture(environment='test',patch) {
  const data=new Map(),writes=[],key=economyStorageKey(environment);
  const storage={getItem:k=>data.get(k)??null,setItem(k,v){data.set(k,v);writes.push(v);}};
  const config=resolveContentConfig(environment,{tutorialEnabled:false,testResources:{diamonds:0,starGems:0,fundGoldUpgrades:false,fundRebirthUpgrades:false}});
  const make=()=>new BattleSession({environment,storage,contentConfig:config});
  let session=make();
  if(patch){const s=JSON.parse(data.get(key));patch(s);data.set(key,JSON.stringify(s));session=make();}
  writes.length=0;return {session,data,key,storage,writes,make};
}
test('ten native Balance_Reload rows, with no invented extra grades',()=>{
  assert.deepEqual(PET_CATALOG.map(p=>p.grade),['D','C','B','A','S','SS','SSS','Z','ZZ','ZZZ']);
  assert.deepEqual(PET_CATALOG.map(p=>p.money.amount.toString()),['2','6','18','55','170','520','1600','4900','15000','46000']);
  assert.deepEqual(PET_CATALOG.map(p=>p.moveSpeed),[2,4,8,14,22,32,44,58,74,92]);
});
test('historical stages 10/12, tutorial override, and unimplemented Hunt ad prerequisite',()=>{
  const c=new ContentUnlockManager(resolveContentConfig('production'));
  for(const [stage,visible,unlocked] of [[89,false,false],[90,true,false],[109,true,false],[110,true,true]]) {
    const state=c.get('pets',{stageValueMax:stage,tutorialCompleted:true});assert.equal(state.visible,visible);assert.equal(state.unlocked,unlocked);
  }
  assert.equal(c.get('pets',{stageValueMax:1000,tutorialCompleted:false}).visible,false);
  const ads=new ContentUnlockManager(resolveContentConfig('test',{adsEnabled:true}));assert.equal(ads.get('petDailyAd').unlocked,false);
});
test('draw price 100, empty fresh save, independent currency, full and insufficient reject without mutation',()=>{
  const f=fixture('production',s=>{s.weapons.stageValueMax=110;s.weapons.diamonds=100;});const s=f.session;
  assert.deepEqual(s.getPetState().owned,Array(16).fill(-1));assert.equal(s.getPetState().coins,0);
  assert.equal(s.drawPet('petCoins').reason,'currency');assert.equal(s.weapons.diamonds,100);
  assert.equal(s.drawPet('diamonds').discovered,0);assert.equal(s.weapons.diamonds,0);assert.equal(f.writes.length,1);
  assert.equal(s.drawPet('diamonds').reason,'currency');assert.equal(f.make().getPetState().owned[0],0);
  const system=new PetSystem();system.restore({...save(Array(16).fill(0)),coins:500});const before=system.serialize();
  assert.equal(system.draw('petCoins',999).reason,'full');assert.deepEqual(system.serialize(),before);
  system.restore({...save(),coins:100});assert.equal(system.draw('petCoins',0).ok,true);assert.equal(system.snapshot(0).coins,0);
});
test('move/equip swaps conserve grades and all three may be unequipped; full inventory cannot lose a pet',()=>{
  const p=new PetSystem();p.restore(save([0,1,2],[3,4,5]));
  assert.equal(p.move(owned(0),selected(0),0).ok,true);assert.deepEqual(p.snapshot(0).selected,[0,4,5]);assert.equal(p.snapshot(0).owned[0],3);
  assert.equal(p.move(selected(1),selected(2),4).ok,true);assert.deepEqual(p.snapshot(0).selected,[0,5,4]);
  assert.equal(p.move(owned(0),owned(15),3).ok,true);assert.equal(p.move(owned(15),owned(3),0).reason,'stale');
  for(let i=0;i<3;i++)assert.equal(p.unequip(i).ok,true);
  assert.deepEqual(p.snapshot(0).selected,[-1,-1,-1]);
  assert.deepEqual(p.snapshot(0).owned.filter(v=>v>=0).sort(),[0,1,2,3,4,5]);
  p.restore(save(Array(16).fill(0),[9]));const before=p.serialize();assert.equal(p.unequip(0).reason,'full');assert.deepEqual(p.serialize(),before);
});
test('merge consumes exactly two equal grades, discovers once, and never merges the highest grade',()=>{
  const p=new PetSystem();p.restore(save([0,0,0,0,9,9]));
  assert.equal(p.merge(0,1).discovered,1);assert.equal(p.merge(2,3).discovered,undefined);
  assert.equal(p.merge(1,3).discovered,2);assert.equal(p.merge(1,3).ok,false);
  assert.equal(p.merge(4,5).reason,'maxGrade');assert.equal(p.merge(3,4).reason,'grade');
  assert.deepEqual(p.snapshot(0).owned.filter(v=>v>=0),[2,9,9]);
});
test('auto merge is opt-in, lowest-grade/first-slot ordered and cannot discover a new highest grade or consume Z',()=>{
  const p=new PetSystem();p.restore(save([1,0,1,0,6,6,7,7]));assert.equal(p.autoPair(),null);
  p.setAuto(true);assert.deepEqual(p.autoPair(),{from:1,to:3,grade:0});
  assert.equal(p.merge(1,3,0,true).ok,true);assert.deepEqual(p.autoPair(),{from:0,to:2,grade:1});
  assert.equal(p.merge(6,7,7,true).ok,false);assert.equal(p.merge(4,5,6,true).ok,true);
  p.restore(save([0,0]));p.setAuto(true);assert.equal(p.autoPair(),null);
  p.setAuto(false);assert.equal(p.merge(0,1,0,true).ok,false);
});
test('equipped duplicates add native percentages in slot order; inventory has no effect',()=>{
  const p=new PetSystem();p.restore(save([9,9],[0,0,9]));assert.equal(p.snapshot(0).moveSpeedPercent,196);assert.equal(p.moneyMultiplier.amount.toString(),'46100');
  for(let i=0;i<3;i++)p.unequip(i);assert.equal(p.snapshot(0).moveSpeedPercent,100);assert.equal(p.moneyMultiplier.amount.toString(),'100');
});
test('source backpack swap may displace to a nearer empty slot and rejects a stale occupied vacancy atomically',()=>{
  const p=new PetSystem();p.restore(save([0,1,2]));
  assert.equal(p.move(owned(0),owned(2),0,3).ok,true);assert.deepEqual(p.snapshot(0).owned.slice(0,4),[-1,1,0,2]);
  const before=p.serialize();assert.equal(p.move(owned(2),owned(1),0,3).reason,'stale');assert.deepEqual(p.serialize(),before);
});
test('wallet and inventory publish only after a durable full-save commit; readback and reentrant writes are guarded',()=>{
  for(const behavior of ['throw','drop','afterWrite','readFail','reenter']){
    const f=fixture();f.session.weapons.grantDiamonds(200);const before=f.session.getPetState();const write=f.storage.setItem;let attempted;
    f.storage.setItem=(k,v)=>{if(behavior==='reenter')attempted=f.session.drawPet('diamonds');if(behavior==='throw')throw Error('quota');if(behavior!=='drop')write(k,v);if(behavior==='afterWrite')throw Error('after');if(behavior==='readFail')f.storage.getItem=()=>{throw Error('read');};};
    const warn=console.warn;console.warn=()=>{};let result;try{result=f.session.drawPet('diamonds');}finally{console.warn=warn;}
    const ok=behavior==='afterWrite'||behavior==='reenter';assert.equal(result.ok,ok,behavior);
    if(ok){assert.equal(f.session.weapons.diamonds,100);assert.equal(f.session.getPetState().owned[0],0);}else assert.deepEqual(f.session.getPetState(),before);
    if(attempted)assert.equal(attempted.reason,'busy');
  }
});
test('corrupt/absent pets cannot overwrite current saves; rebirth and isolated test saves retain pets',()=>{
  const warn=console.warn;console.warn=()=>{};
  try{for(const block of [undefined,null,{},save([10]),{...save(),coins:-1},{...save(),autoEnabled:1}]){
    const f=fixture('production',s=>{s.pets=block;s.weapons.diamonds=731;s.levels=[7,8,9];});
    const raw=f.data.get(f.key);assert.equal(f.session.persistenceBlocked,true);assert.deepEqual(f.session.getPetState().owned,Array(16).fill(-1));
    assert.equal(JSON.parse(raw).weapons.diamonds,731);assert.deepEqual(JSON.parse(raw).levels,[7,8,9]);
    f.make();assert.equal(f.data.get(f.key),raw);assert.equal(f.writes.length,0);
  }}finally{console.warn=warn;}
  const f=fixture('test',s=>{s.pets=save([5],[9,9]);});const before=f.session.getPetState();
  assert.equal(f.session.requestRebirth('normal').ok,true);assert.equal(f.session.drawPet('diamonds').reason,'busy');f.session.advanceRebirth(2);
  assert.deepEqual(f.make().getPetState().selected,before.selected);assert.deepEqual(f.make().getPetState().owned,before.owned);
  assert.equal(new BattleSession({storage:f.storage}).getPetState().selected[0],-1);
});
test('pet gold passes through native InfVal and is credited once; no attack loadout change',()=>{
  const f=fixture('test',s=>{s.pets=save([],[0,0]);});const s=f.session,loadout=s.getLoadout();
  const tree={id:90,alive:false,reward:D.from(100),rewardPrecision:3},event={type:'treeDied',treeId:90,position:{x:0,z:0},sourceTime:1};
  assert.equal(s.consume([event],[tree])[0].amount.toString(),'104');assert.deepEqual(s.consume([event],[tree]),[]);assert.deepEqual(s.getLoadout(),loadout);
});
test('source formation, hysteresis, duplicate pets, warp and fixed-rate stepping stay finite at 30/60/120 fps',()=>{
  const p=new PetFollowers();p.setSelected([0,-1,0],{x:0,z:0});assert.equal(p.pets.length,2);assert.ok(Math.abs(p.pets[0].offset.x+2.5)<1e-10);p.warp({x:10,z:20});
  assert.equal(p.pets[0].position.x,7.5);p.fixedStep(.02,[{x:10,z:20}]);assert.equal(p.pets[0].moving,false);
  const values=[];
  for(const fps of [30,60,120]){const w=new CombatWorld();w.petFollowers.setSelected([0,0,0],w.player.position);w.setMovementMultiplier(2);w.setPetSpeedPercent(106);w.stopCombat();w.setMovementInput({x:1,y:0});
    for(let i=0;i<fps*3;i++)w.advanceEffects(1/fps);
    assert.equal(w.players.length,1);assert.equal(w.petFollowers.pets.length,3);assert.ok(w.petFollowers.pets.every(p=>Number.isFinite(p.position.x)&&Number.isFinite(p.position.z)));
    values.push(w.petFollowers.pets[0].position.x);const before=JSON.stringify(w.petFollowers.pets);w.pause();w.step(1);assert.equal(JSON.stringify(w.petFollowers.pets),before);w.reset();assert.equal(w.petFollowers.pets[0].moving,false);
  }
  assert.ok(Math.max(...values)-Math.min(...values)<1,'only original frame-driven cat velocity introduces a one-frame difference');
});
test('pet speed multiplies existing historical speed for manual movement without affecting attack interval',()=>{
  const a=new CombatWorld(),b=new CombatWorld();for(const w of [a,b]){w.setMovementMultiplier(2);w.stopCombat();w.setMovementInput({x:1,y:0});}b.setPetSpeedPercent(196);
  a.advanceEffects(.02);b.advanceEffects(.02);assert.ok(Math.abs(b.player.velocity.x/a.player.velocity.x-1.96)<1e-12);
  assert.equal(a.attackInterval,b.attackInterval);assert.throws(()=>b.setPetSpeedPercent(Infinity));
});
test('Spine 4.1 absolute Bezier/stepped channels and all ten weighted meshes evaluate both loops and transitions',()=>{
  assert.equal(petTimelineValue([{value:4,curve:'stepped'},{time:1,value:9}],.5,'value',0),4);
  assert.ok(Math.abs(petTimelineValue([{value:0,curve:[.2,0,.8,10]},{time:1,value:10}],.5,'value',0)-5)<1e-4);
  for(let id=0;id<10;id++){
    const rig=JSON.parse(fs.readFileSync(path.join(__dirname,`../assets/resources/art/pet-system/characters/${id}/rig.json`)));
    const a=new PetAnimation(rig);assert.ok(a.meshes.some(m=>m.influences.some(v=>v.length>1)),`weighted grade ${id}`);
    for(let i=0;i<600;i++){a.update(1/60,i%180<90);for(const mesh of a.meshes)assert.ok(mesh.positions.every(p=>p.every(Number.isFinite)));}
  }
});
