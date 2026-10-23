const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceModules } = require('./support/resource-modules.cjs');
const load = resourceModules();
const { UiPreparationQueue } = load('UiPreparationQueue');

test('a forced recovery admission executes exactly one generator step', () => {
  const queue=new UiPreparationQueue(()=>0);let count=0;
  queue.run('panel',(function*(){for(let i=0;i<100;i++){count++;yield;}})()).catch(()=>{});
  queue.tick(undefined,()=>true,1);assert.equal(count,1);
  queue.tick(undefined,()=>true,1);assert.equal(count,2);queue.dispose();
});
const { RESOURCE_LOADING_POLICY: policy } = load('ResourceLoadingPolicy');

test('startup grants only its focused panel a larger slice and runtime budgets recover immediately', () => {
  let clock=0;const queue=new UiPreparationQueue(()=>clock),work=[];
  function* steps(name){while(true){work.push(name);clock++;yield;}}
  queue.run('panel',steps('panel')).catch(()=>{});queue.run('other',steps('other')).catch(()=>{});
  queue.tick('panel',()=>true,undefined,'startup');
  assert.equal(clock,12);assert.deepEqual(work,Array(12).fill('panel'));
  queue.tick('panel');assert.equal(clock,18,'foreground clicks still get 6 ms');
  queue.tick();assert.equal(clock,19,'background preparation still gets 1 ms');
  queue.tick('panel',name=>name==='other',undefined,'startup');
  assert.equal(clock,20,'blocked startup focus cannot grant a larger budget');assert.equal(work.at(-1),'other');
  queue.dispose();
});

test('startup yields after an indivisible long step and remains bounded with a coarse clock', () => {
  let clock=0,count=0;const queue=new UiPreparationQueue(()=>clock);
  queue.run('panel',(function*(){while(true){count++;clock+=18;yield;}})()).catch(()=>{});
  queue.tick('panel',()=>true,undefined,'startup');assert.equal(count,1);queue.dispose();
  const coarse=new UiPreparationQueue(()=>0);count=0;
  coarse.run('panel',(function*(){while(true){count++;yield;}})()).catch(()=>{});
  coarse.tick('panel',()=>true,undefined,'startup');assert.equal(count,1024);
  coarse.dispose();coarse.tick('panel',()=>true,undefined,'startup');assert.equal(count,1024);
});

test('UI preparation advances only on game frames, shares a time budget, and prioritizes the clicked feature', async () => {
  let clock = 0;
  const queue = new UiPreparationQueue(() => clock), work = [];
  function* steps(name) { for (let n = 0; n < 8; n++) { work.push(name); clock++; yield; } }
  const background = queue.run('weapons', steps('weapons'));
  const foreground = queue.run('challenge', steps('challenge'));
  await Promise.resolve(); assert.deepEqual(work, []);
  queue.tick('challenge');
  assert.deepEqual(work, Array(policy.uiPreparation.foregroundFrameBudgetMs).fill('challenge'));
  for (let n = 0; n < 30; n++) queue.tick('challenge');
  await Promise.all([background, foreground]);
  assert.deepEqual(work.slice(0, 8), Array(8).fill('challenge'));
  assert.deepEqual(work.slice(8), Array(8).fill('weapons'));
  assert.deepEqual(Array.from(queue.snapshot()), []);
});

test('step limit bounds work even with a coarse clock and disposal closes unfinished construction', async () => {
  const queue = new UiPreparationQueue(() => 0);
  let count = 0, closed = false;
  function* steps() { try { while (true) { count++; yield; } } finally { closed = true; } }
  const request = queue.run('weapons', steps());
  queue.tick(); assert.equal(count, policy.uiPreparation.maxStepsPerFrame);
  const rejected = assert.rejects(request, /disposed/);
  queue.dispose(); await rejected;
  assert.equal(closed, true); queue.tick(); assert.equal(count, policy.uiPreparation.maxStepsPerFrame);
  await assert.rejects(queue.run('late', steps()), /disposed/);
});

test('a failed feature does not prevent other queued panels from preparing', async () => {
  const queue = new UiPreparationQueue(() => 0);
  const broken = queue.run('broken', (function* () { yield; throw Error('construction failed'); })());
  let completed = false;
  const good = queue.run('good', (function* () { completed = true; yield; })());
  const rejected = assert.rejects(broken, /construction failed/);
  queue.tick(); await rejected; await good; assert.equal(completed, true);
});

test('a suspended compositor cannot block ordinary HUDs or consume their frame budget', async () => {
  const queue = new UiPreparationQueue(() => 0), work = [];
  function* steps(name) { for (let n = 0; n < 40; n++) { work.push(name); yield; } }
  const compositor = queue.run('settings', steps('settings'));
  const challenge = queue.run('speedrun', steps('speedrun'));
  const allowed = name => name === 'speedrun';
  queue.tick('settings', allowed);
  assert.deepEqual(work, Array(policy.uiPreparation.maxStepsPerFrame).fill('speedrun'), 'blocked foreground cannot grant an extra budget');
  for (let n = 0; n < Math.ceil(41 / policy.uiPreparation.maxStepsPerFrame); n++) queue.tick(undefined, allowed);
  await challenge;
  assert.equal(work.includes('settings'), false);
  assert.deepEqual(Array.from(queue.snapshot()), ['settings']);
  queue.tick(undefined, allowed); assert.equal(work.length, 40);
  for (let n = 0; n < Math.ceil(41 / policy.uiPreparation.maxStepsPerFrame); n++) queue.tick();
  await compositor; assert.equal(work.filter(name => name === 'settings').length, 40);
});

test('timings count construction work separately from time between frames',async()=>{
  let now=0;const queue=new UiPreparationQueue(()=>now);
  const done=queue.run('weapons',(function*(){for(let i=0;i<5;i++){now++;yield;}})());
  for(let i=0;i<6;i++){queue.tick();now+=1000;}await done;
  const timing=queue.timings().weapons;assert.equal(timing.workMs,5);assert.equal(timing.maxStepMs,1);assert.equal(timing.runs,1);
  timing.workMs=999;assert.equal(queue.timings().weapons.workMs,5);
});

test('commit work is measured and only one commit can run per tick with a coarse clock',async()=>{
  let now=0;const events=[],published=[];
  const queue=new UiPreparationQueue(()=>now,(name,phase,ms,done)=>events.push({name,phase,ms,done}));
  const first=queue.run('settings',(function*(){published.push('settings');now+=3;})(),'commit');
  const second=queue.run('weapons',(function*(){published.push('weapons');})(),'commit');
  queue.tick();await first;
  assert.deepEqual(published,['settings']);assert.equal(queue.timings().settings.maxStepMs,3);
  assert.deepEqual(events[0],{name:'settings',phase:'commit',ms:3,done:true});
  queue.tick();await second;assert.deepEqual(published,['settings','weapons']);
});

test('disposing a queued commit prevents its publication',async()=>{
  const queue=new UiPreparationQueue();let published=false;
  const request=queue.run('settings',(function*(){published=true;})(),'commit');
  const rejected=assert.rejects(request,/disposed/);queue.dispose();await rejected;
  queue.tick();assert.equal(published,false);
});

test('ready commits overtake long construction and share the remaining one-millisecond budget',async()=>{
  let now=0;const queue=new UiPreparationQueue(()=>now),events=[];
  const long=queue.run('large',(function*(){for(let i=0;i<100;i++){events.push('build');now+=.25;yield;}})());
  const ready=queue.run('ready',(function*(){events.push('commit');now+=.25;})(),'commit');
  const next=queue.run('next',(function*(){events.push('next-commit');})(),'commit');
  assert.equal(queue.nextName(),'ready');queue.tick();await ready;
  assert.deepEqual(events,['commit','build','build','build']);assert.equal(now,1);
  queue.tick();await next;assert.equal(events[4],'next-commit');
  const rejected=assert.rejects(long,/disposed/);queue.dispose();await rejected;
});
