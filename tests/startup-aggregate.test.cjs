const test=require('node:test'),assert=require('node:assert/strict');
const {CloudSaveStorage}=require('./.build/session/session/CloudSaveStorage.js');
const {BattleSession,economyStorageKey}=require('./.build/session/session/BattleSession.js');
const {DailyCheckSystem}=require('./.build/session/session/DailyCheckSystem.js');
const {DailyShareSystem}=require('./.build/session/session/DailyShareSystem.js');
const key=economyStorageKey('production');
function fixture({saved=false}={}){
  let now=10000,reads=0,states=0;
  const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const seed=new Map();new BattleSession({environment:'production',storage:{getItem:k=>seed.get(k)??null,setItem:(k,v)=>seed.set(k,v)}});
  const head={player_id:'101',namespace:'production',revision:saved?'1':'0',save:saved?seed.get(key):null,saved_at_ms:saved?10000:0,
    server_time_ms:10000,next_daily_reset_ms:86410000,daily_check:new DailyCheckSystem().snapshot('2026-10-24'),daily_share:new DailyShareSystem().snapshot('2026-10-24')};
  const api={startupRequest:async()=>{reads++;return{...head};},saveRequest:async()=>{throw Error('unexpected separate read/write');},
    rewardRequest:async()=>{states++;return{...head};}};
  const cloud=new CloudSaveStorage(storage,api,'101',key,'https://example.com/game/v1','production',()=>now,()=> 'startup_request_0001');
  return{cloud,head,api,data,key,open:()=>cloud.open(async()=>{throw Error('unexpected conflict');}),advance:n=>{now+=n;},reads:()=>reads,states:()=>states};
}
test('new-account aggregate supplies the initial reward state without a second HTTP round trip, then expires on use',async()=>{
  const f=fixture();await f.open();const state=await f.cloud.rewardState();assert.equal(state.revision,'0');
  assert.equal(f.reads(),1);assert.equal(f.states(),0);assert.equal(f.cloud.localSave,null);
  await f.cloud.rewardState();assert.equal(f.states(),1);
});
for(const kind of ['age','midnight','rollback','dirty'])test('aggregate state is not reused after '+kind,async()=>{
  const f=fixture({saved:kind==='dirty'});if(kind==='midnight')f.head.next_daily_reset_ms=10010;
  await f.open();if(kind==='age')f.advance(1001);if(kind==='midnight')f.advance(10);if(kind==='rollback')f.advance(-1);
  if(kind==='dirty'){const save=JSON.parse(f.cloud.localSave);save.levels[0]++;f.cloud.setItem(key,JSON.stringify(save));}
  await f.cloud.rewardState();assert.equal(f.states(),1);
});
for(const field of ['player_id','namespace','revision','daily_check','daily_share','next_daily_reset_ms'])test('malformed aggregate '+field+' never overwrites the local journal',async()=>{
  const f=fixture();f.head[field]=field==='player_id'?'202':undefined;await assert.rejects(f.open());assert.equal(f.data.size,0);
});
test('a failed aggregate request can retry without mutating or claiming rewards',async()=>{
  const f=fixture();const original=f.api.startupRequest;let fail=true;
  f.api.startupRequest=async()=>{if(fail)throw Error('network');return original();};
  await assert.rejects(f.open(),/network/);assert.equal(f.data.size,0);fail=false;
  await f.open();await f.cloud.rewardState();assert.equal(f.states(),0);
});
