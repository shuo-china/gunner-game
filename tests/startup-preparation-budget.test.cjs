const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./support/resource-modules.cjs').resourceModules();
const { StartupPreparationBudget } = load('StartupPreparationBudget');
const { ResourceModuleManager } = load('ResourceModuleManager');

test('cold and return budgets include core boot time from the earliest startup timestamp', () => {
  for (const [returningPlayer,budgetMs] of [[false,10000],[true,3000]]) {
    let now=2000;const budget=new StartupPreparationBudget(0,returningPlayer,()=>now);
    assert.equal(budget.budgetMs,budgetMs);assert.equal(budget.evaluate({coreReady:true,viewsReady:false,hidden:false}).elapsedMs,2000);
    now=budgetMs-1;assert.equal(budget.evaluate({coreReady:true,viewsReady:false,hidden:false}).release,false);
    now=budgetMs;const result=budget.evaluate({coreReady:true,viewsReady:false,hidden:false});assert.equal(result.release,false);assert.equal(result.expired,true);assert.equal(result.reason,'waiting');
  }
});

test('neither elapsed budget nor a returning-player marker can skip missing core assets', () => {
  const budget=new StartupPreparationBudget(0,true,()=>60000);
  const result=budget.evaluate({coreReady:false,viewsReady:false,hidden:false});
  assert.equal(result.expired,true);assert.equal(result.release,false);assert.equal(result.reason,'core');
});

test('fully prepared views release early; hidden completion waits until visible', () => {
  const budget=new StartupPreparationBudget(0,false,()=>500);
  assert.equal(budget.evaluate({coreReady:true,viewsReady:true,hidden:false}).release,true);
  const hidden=budget.evaluate({coreReady:true,viewsReady:true,hidden:true});assert.equal(hidden.release,false);assert.equal(hidden.reason,'hidden');
  assert.equal(budget.evaluate({coreReady:true,viewsReady:true,hidden:false}).release,true);
});

test('deadline checks leave outstanding preparation tasks reusable', async () => {
  let resolve,loads=0,views=0;const pending=new Promise(done=>resolve=done);const manager=new ResourceModuleManager();
  manager.register('panel',{load:()=>{loads++;return pending;},create:async()=>{views++;}});
  const startup=manager.prepare('panel');await new Promise(setImmediate);
  const budget=new StartupPreparationBudget(0,false,()=>10000);
  assert.equal(budget.evaluate({coreReady:true,viewsReady:false,hidden:false}).release,false);
  assert.equal(manager.prepare('panel',{foreground:true}),startup);
  resolve('ready');await startup;assert.equal(manager.isViewReady('panel'),true);assert.equal(loads,1);assert.equal(views,1);
});
