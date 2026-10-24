const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { buildEarlyLogin } = require('../tools/install-early-login.cjs');
const { takeEarlyWechatLogin } = require('./.build/session/session/EarlyWechatLogin.js');
const { GameLoginError } = require('./.build/session/session/GameLogin.js');
const { createWechatLogin } = require('./.build/session/platform/WechatPlatform.js');
const { PLATFORM_CHANNELS } = require('./.build/session/platform/PlatformConfig.js');
const { resolveGameBackendConfig } = require('./.build/session/session/GameBackendConfig.js');
const config = PLATFORM_CHANNELS['wechat-mini'], backend = resolveGameBackendConfig(undefined, 'production');
function fixture() {
  let codes=0, requests=0, resolveRequest;
  const scope={__FOREST_GUNNER_ENV__:{environment:'production'},wx:{
    getAccountInfoSync:()=>({miniProgram:{appId:config.appId}}),
    login:o=>{codes++;o.success({code:'fresh-code-'+codes});},
    request:o=>{requests++;resolveRequest=o;return{abort(){}};},
  }};
  const module={exports:{}};
  vm.runInNewContext(buildEarlyLogin(),{module,exports:module.exports,setTimeout,clearTimeout,console});
  return{scope,start:()=>module.exports.beginEarlyWechatLogin(scope),codes:()=>codes,requests:()=>requests,
    reply:(status=200)=>resolveRequest.success({statusCode:status,data:status===200?{
      player:{id:'101',nickname:'玩家',provider:'wechat_mini',app_id:config.appId},is_new_player:false,
      token_info:{access_token:'fg1_'+'A'.repeat(43),token_type:'Bearer',expires_in:86400,expires_at_ms:9999999999999},server_time_ms:1000,
    }:{code:'WECHAT_CODE_INVALID'}})};
}
const flush=()=>new Promise(setImmediate);
test('packaged early login starts without cc, hands off the same in-flight client once and does not send a second code',async()=>{
  const f=fixture();f.start();f.start();await flush();assert.equal(f.codes(),1);assert.equal(f.requests(),1);
  const entry=takeEarlyWechatLogin(f.scope,createWechatLogin({config,globals:f.scope}),backend);
  assert.ok(entry);assert.equal(takeEarlyWechatLogin(f.scope,createWechatLogin({config,globals:f.scope}),backend),undefined);
  f.reply();const result=await entry.outcome;assert.equal(result.ok,true);assert.equal(entry.client.player.id,'101');
  assert.equal(f.requests(),1);entry.client.dispose();
});
test('early auth failure is observed and retry uses a fresh code on the same client',async()=>{
  const f=fixture();f.start();await flush();f.reply(401);
  const entry=takeEarlyWechatLogin(f.scope,createWechatLogin({config,globals:f.scope}),backend);
  const failure=await entry.outcome;assert.equal(failure.ok,false);
  assert.equal(GameLoginError.messageFor(failure.error),'微信登录凭证已失效，请重试');
  const retry=entry.client.login();await flush();assert.equal(f.codes(),2);f.reply();await retry;entry.client.dispose();
});
test('early auth rejects a changed backend instead of exposing the old session',async()=>{
  const f=fixture();f.start();await flush();
  assert.equal(takeEarlyWechatLogin(f.scope,createWechatLogin({config,globals:f.scope}),{baseUrl:'https://other.example/game/v1'}),undefined);
  f.reply();await flush();assert.equal(f.scope.__FOREST_GUNNER_EARLY_LOGIN__,undefined);
});
test('test environment does not perform unsolicited production authentication',async()=>{
  const f=fixture();f.scope.__FOREST_GUNNER_ENV__={environment:'test'};f.start();await flush();assert.equal(f.codes(),0);
});
