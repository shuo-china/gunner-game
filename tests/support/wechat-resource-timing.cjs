const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../tools/wechat-resource-timing.js'),'utf8');
function createTiming(globals={}) {
  const module={exports:{}},scope={module,exports:module.exports,...globals};
  vm.runInNewContext(source,scope);
  return {exports:module.exports,api:scope.__forestGunnerPlatformTiming,scope};
}
module.exports={createTiming};
