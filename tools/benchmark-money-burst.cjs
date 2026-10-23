'use strict';
// Usage: node tools/benchmark-money-burst.cjs --before <saved scripts directory> [--output <report.json>]
// Runs pure simulation in Node. These CPU timings exclude Cocos rendering/GPU
// and are not a substitute for WeChat device measurements.
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),ts=require('typescript');
const project=path.resolve(__dirname,'..'),args=process.argv.slice(2);
function argument(name){const index=args.indexOf(name);return index<0?undefined:args[index+1];}
const baseline=argument('--before');
if(!baseline)throw new Error('Pass --before with the saved pre-change scripts directory.');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS},
}).outputText,filename);
const beforeFile=path.resolve(baseline,'view/MoneyBurstSimulation.ts');
const afterFile=path.join(project,'assets/scripts/view/MoneyBurstSimulation.ts');
const Before=require(beforeFile).MoneyBurstSimulation,After=require(afterFile).MoneyBurstSimulation;
const config=require(path.join(project,'assets/resources/art/effects/money-burst/config.json'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const treeGrid=(offset=0)=>Array.from({length:500},(_,i)=>({alive:true,
  collider:{minX:(i%20)*5-48+offset,maxX:(i%20)*5-46+offset,minZ:Math.floor(i/20)*5-48+offset,maxZ:Math.floor(i/20)*5-46+offset}}));
const scenarios=[{name:'100-particles-500-near-trees',count:100,trees:treeGrid()},
  {name:'1000-particles-500-near-trees',count:1000,trees:treeGrid()},
  {name:'1000-particles-500-distant-trees',count:1000,trees:treeGrid(100)},
  {name:'empty-pool-500-trees',count:0,trees:treeGrid()}];
function create(Type,scenario){
  const simulation=new Type(config,1234567);
  for(let i=0;i<scenario.count/config.count;i++)simulation.spawn({x:(i%8)*6-21,z:Math.floor(i/8)%8*6-21});
  assert.equal(simulation.diagnostics().active,scenario.count);return simulation;
}
function summarize(samples){samples.sort((a,b)=>a-b);return {samples:samples.length,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,
  medianMs:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],maxMs:samples.at(-1)};}
const results=[];
for(const scenario of scenarios){
  // Compare every frame before timing, including all fields and RNG outcomes.
  const old=create(Before,scenario),current=create(After,scenario);
  for(let frame=0;frame<50;frame++){old.update(1/60,scenario.trees);current.update(1/60,scenario.trees);assert.deepEqual(current.particles,old.particles);}
  const samples={before:[],after:[]};
  for(let round=0;round<6;round++){
    // Alternate ordering to avoid consistently rewarding one version's warmup.
    const versions=round%2?[['after',After],['before',Before]]:[['before',Before],['after',After]];
    for(const [name,Type] of versions){
      const simulation=create(Type,scenario);
      for(let frame=0;frame<50;frame++){const start=performance.now();simulation.update(1/60,scenario.trees);const elapsed=performance.now()-start;
        if(round>0&&frame>=10)samples[name].push(elapsed);}
      assert.equal(simulation.diagnostics().active,scenario.count,'benchmark must keep original density');
    }
  }
  const before=summarize(samples.before),after=summarize(samples.after);
  results.push({name:scenario.name,particles:scenario.count,trees:scenario.trees.length,before,after,
    reductionPercent:(1-after.meanMs/before.meanMs)*100,identicalEveryFrame:true,finalStateSha256:hash(JSON.stringify(current.particles))});
}
const report={method:'Node pure simulation; original 5-particle bursts and 1000 cap; seeded identical trajectories; 60 Hz, 50 frames/repetition; one warmup repetition, then five measured repetitions with 10 warmup frames each; alternate baseline/current order.',
  limits:'CPU simulation only, no Cocos nodes, rendering, draw calls, GPU or phone frame-rate claims.',node:process.version,
  seed:1234567,sourceSha256:{before:hash(fs.readFileSync(beforeFile)),after:hash(fs.readFileSync(afterFile))},results};
const output=argument('--output');if(output)fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
