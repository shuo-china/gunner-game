const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { projectPath } = require('./support/paths.cjs');
const {createTiming}=require('./support/wechat-resource-timing.cjs');

const BASE = 'https://nurse.kylinsit.com/forest-gunner/';
const PATH = 'remote/resources/import/00/00e2a338-5a64-5e21-889f-66456a0e369a.a2533.json';
const OTHER_PATH = 'remote/resources/import/00/00e2a338-5a64-5e21-889f-66456a0e369a@f9941.35d00.json';
const URL = BASE + PATH;
const SOURCE = fs.readFileSync(projectPath('tools/wechat-startup-runtime.cjs'), 'utf8');

function asciiBytes(value) {
  return new Uint8Array(Buffer.from(JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')), 'ascii'));
}

function fixture(config = {}) {
  const tasks = [], reads = [], requires = [], registrations = [], originalCalls = [];
  const module = { exports: {} };
  const timing=createTiming(config.scope);
  const metadata = config.metadata ?? { version: 2, routes: {}, groups: {}, base: BASE, files: {
    [PATH]: JSON.stringify({ message: '正在走进森林… 🎮', nested: { health: 100 }, padding: 'a'.repeat(20000) }),
  } };
  const buffer = config.buffer ?? new Uint8Array([1, 2, 3]).buffer;
  const original = function (url, options, complete) {
    originalCalls.push({ receiver: this, url, options, complete });
    if (config.original) return config.original(url, options, complete);
    complete(null, { remote: true });
  };
  const png = () => 'unchanged image downloader';
  const downloader = { handlers: { '.json': original, '.png': png },
    register(extension, handler) { registrations.push(extension); this.handlers[extension] = handler; } };
  const scope = { module, exports: module.exports,
    require(name) {
      if(name==='./wechat-resource-timing.js')return timing.exports;
      requires.push(name);
      if (config.requireError) throw config.requireError;
      if (config.inflater) return config.inflater;
      return { Inflate: class {
        constructor(input) { assert.deepEqual([...input], [1, 2, 3]); }
        decompress() {
          config.inflate?.();
          if (config.inflateError) throw config.inflateError;
          return config.bytes ?? asciiBytes(metadata);
        }
      } };
    },
    wx: { getFileSystemManager() { return { readFileSync(path) {
      config.read?.();
      reads.push(path);
      if (config.readError) throw config.readError;
      return buffer;
    } }; } },
    queueMicrotask: callback => tasks.push(callback),
    ...config.scope,
  };
  vm.runInNewContext(SOURCE, scope);
  return { install: module.exports.installStartupMetadata, cc: { assetManager: { downloader } },
    downloader, original, png, tasks, reads, requires, registrations, originalCalls, timing:timing.api,
    flush() { while (tasks.length) tasks.shift()(); },
  };
}

test('local metadata installs only JSON and completes asynchronously with Unicode intact', () => {
  const f = fixture(), completed = [], stats = f.install(f.cc);
  assert.equal(stats.installed, true);
  assert.equal(stats.entries, 1);
  assert.deepEqual(f.reads, ['startup-metadata.bin']);
  assert.deepEqual(f.requires, ['./startup-inflate.js']);
  assert.deepEqual(f.registrations, ['.json']);
  assert.equal(f.downloader.handlers['.png'], f.png);
  f.downloader.handlers['.json'](URL + '?cache=1#fragment', {}, (...args) => completed.push(args));
  assert.equal(completed.length, 0);
  f.flush();
  assert.equal(completed.length, 1);
  assert.equal(completed[0][0], null);
  assert.equal(completed[0][1].message, '正在走进森林… 🎮');
  assert.equal(completed[0][1].padding.length, 20000);
  assert.equal(stats.hits, 1);
  assert.equal(f.originalCalls.length, 0);
});

test('metadata diagnostics measure the actual synchronous read, inflate, text parse and per-entry restoration',()=>{
  let now=10;
  const f=fixture({read:()=>{now+=3;},inflate:()=>{now+=11;},scope:{Date:{now:()=>now},
    JSON:{parse:value=>{now+=7;return JSON.parse(value);}}}});
  assert.equal(f.install(f.cc).installed,true);
  let s=f.timing.snapshot();assert.equal(s.startedAt,10);
  assert.equal(s.phases.metadataRead.totalMs,3);assert.equal(s.phases.metadataInflate.totalMs,11);
  assert.equal(s.phases.metadataParse.totalMs,7);assert.equal(s.phases.metadataHydrate.started,0);
  let value;f.downloader.handlers['.json'](URL+'?private=secret',{},(_,data)=>{value=data;});f.flush();
  assert.equal(value.nested.health,100);s=f.timing.snapshot();
  assert.equal(s.phases.metadataParse.started,2);assert.equal(s.phases.metadataParse.totalMs,14);
  assert.equal(s.phases.metadataHydrate.started,1);assert.equal(s.phases.metadataHydrate.active,0);
  assert.doesNotMatch(JSON.stringify(s),/secret|private|https:|health/);
});

test('metadata phase failures remain visible while the original fallback behavior is preserved',()=>{
  for(const [config,phase] of [[{readError:Error('missing bin')},'metadataRead'],
    [{inflateError:Error('corrupt deflate')},'metadataInflate'],[{bytes:new Uint8Array([123,0])},'metadataParse']]) {
    const f=fixture(config);assert.equal(f.install(f.cc).installed,false);
    assert.equal(f.downloader.handlers['.json'],f.original);
    const s=f.timing.snapshot();assert.equal(s.phases[phase].failed,1);assert.equal(s.phases[phase].active,0);
  }
});

test('every hit reparses JSON after a previous consumer mutates the result', () => {
  const f = fixture(), values = [];
  f.install(f.cc);
  const load = () => { f.downloader.handlers['.json'](URL, {}, (_, value) => values.push(value)); f.flush(); };
  load();
  values[0].nested.health = 0;
  values[0].injected = true;
  load();
  assert.equal(values[1].nested.health, 100);
  assert.equal('injected' in values[1], false);
  assert.notEqual(values[0], values[1]);
  assert.notEqual(values[0].nested, values[1].nested);
});

test('new bundle config is delivered locally even before its CDN version exists', () => {
  const configPath = 'remote/resources/config.abc123.json';
  const f = fixture({ metadata: { version: 2, routes: {}, groups: {}, base: BASE, files: { [configPath]: '{"name":"resources","paths":{}}' } } });
  f.install(f.cc); let value;
  f.downloader.handlers['.json'](BASE + configPath, {}, (error, data) => { assert.equal(error, null); value = data; });
  assert.equal(value, undefined); f.flush();
  assert.equal(value.name, 'resources'); assert.equal(f.originalCalls.length, 0);
});

test('unknown URLs preserve original URL, options, callback, and adapter receiver', () => {
  const f = fixture(), stats = f.install(f.cc), options = { cacheEnabled: false };
  const urls = [BASE + OTHER_PATH + '?x=1#y', URL.replace('nurse.kylinsit.com', 'other.example'),
    URL.replace('https:', 'http:'), URL.replace('.a2533.json', '.json'),
    BASE + 'remote/resources/config.e0d45.json', BASE + 'remote/resources/native/00/font.ttf'];
  for (const url of urls) {
    let count = 0;
    const callback = (error, value) => { assert.equal(error, null); assert.equal(value.remote, true); count++; };
    f.downloader.handlers['.json'](url, options, callback);
    assert.equal(count, 1);
    const call = f.originalCalls.at(-1);
    assert.equal(call.url, url);
    assert.equal(call.options, options);
    assert.equal(call.complete, callback);
    assert.equal(call.receiver, f.downloader);
  }
  assert.equal(stats.misses, urls.length);
  assert.equal(f.tasks.length, 0);
});

test('one corrupt entry falls back while other metadata remains usable', () => {
  for (const damaged of ['{broken', { objectInsteadOfRawJson: true }]) {
    const f = fixture({ metadata: { version: 2, routes: {}, groups: {}, base: BASE, files: {
      [PATH]: damaged, [OTHER_PATH]: '{"healthy":true}',
    } } }), stats = f.install(f.cc), completed = [];
    const options = { request: 'keep me' };
    f.downloader.handlers['.json'](URL, options, (...args) => completed.push(args));
    f.downloader.handlers['.json'](BASE + OTHER_PATH, {}, (...args) => completed.push(args));
    f.flush();
    assert.equal(completed.length, 2);
    assert.equal(completed[0][1].remote, true);
    assert.equal(completed[1][1].healthy, true);
    assert.equal(f.originalCalls[0].url, URL);
    assert.equal(f.originalCalls[0].options, options);
    assert.equal(stats.hits, 1);
    assert.equal(stats.fallbacks, 1);
  }
});

test('a throwing hit callback is invoked once without remote fallback', () => {
  const f = fixture(), failure = new Error('consumer failure');
  f.install(f.cc);
  let count = 0;
  f.downloader.handlers['.json'](URL, {}, () => { count++; throw failure; });
  assert.throws(() => f.flush(), error => error === failure);
  assert.equal(count, 1);
  assert.equal(f.originalCalls.length, 0);
});

test('a throwing callback on corrupt-entry fallback is never retried by the hook', () => {
  const failure = new Error('remote consumer failure');
  const f = fixture({ metadata: { version: 2, routes: {}, groups: {}, base: BASE, files: { [PATH]: '{broken' } } });
  f.install(f.cc);
  let count = 0;
  assert.throws(() => f.downloader.handlers['.json'](URL, {}, () => { count++; throw failure; }), error => error === failure);
  assert.equal(count, 1);
  assert.equal(f.originalCalls.length, 1);
});

test('missing WeChat or downloader APIs leave the original path untouched', () => {
  for (const wx of [undefined, {}, { getFileSystemManager: () => ({}) }]) {
    const f = fixture({ scope: { wx } }), stats = f.install(f.cc);
    assert.equal(stats.installed, false);
    assert.equal(f.downloader.handlers['.json'], f.original);
    assert.equal(f.registrations.length, 0);
    assert.equal(f.requires.length, 0);
  }
  for (const cc of [undefined, {}, { assetManager: {} }, { assetManager: { downloader: {} } }]) {
    assert.equal(fixture().install(cc).installed, false);
  }
  const f = fixture();
  f.downloader.handlers = {};
  assert.equal(f.install(f.cc).installed, false);
  assert.equal(f.requires.length, 0);
});

test('unreadable, missing, malformed, or unsupported binary metadata preserves network loading', () => {
  for (const config of [
    { requireError: new Error('missing inflate') }, { readError: new Error('missing bin') },
    { inflateError: new Error('corrupt deflate') }, { bytes: new Uint8Array([123, 0]) },
    { bytes: new Uint8Array([233]) },
    { metadata: { version: 2, base: BASE, files: {} } },
    { metadata: { version: 1, routes: {}, groups: {}, base: BASE, files: {} } },
    { metadata: { version: 2, routes: {}, groups: {}, base: 'https://other.example/', files: {} } },
    { metadata: { version: 2, routes: {}, groups: {}, base: BASE, files: [] } },
  ]) {
    const f = fixture(config), stats = f.install(f.cc);
    assert.equal(stats.installed, false);
    assert.equal(f.downloader.handlers['.json'], f.original);
    assert.equal(f.registrations.length, 0);
  }
});

test('repeat installation returns the same read-only live statistics without wrapping twice', () => {
  const f = fixture(), stats = f.install(f.cc), handler = f.downloader.handlers['.json'];
  assert.equal(f.install(f.cc), stats);
  assert.equal(f.downloader.handlers['.json'], handler);
  assert.deepEqual(f.reads, ['startup-metadata.bin']);
  assert.equal(Object.isFrozen(stats), true);
  assert.throws(() => { 'use strict'; stats.hits = 9000; }, TypeError);
  handler(URL, {}, () => {});
  f.flush();
  assert.equal(stats.hits, 1);
});

test('Promise and timer schedulers preserve asynchronous local completion', async () => {
  const promised = fixture({ scope: { queueMicrotask: undefined } });
  promised.install(promised.cc);
  let promiseCount = 0;
  promised.downloader.handlers['.json'](URL, {}, () => promiseCount++);
  assert.equal(promiseCount, 0);
  await Promise.resolve();
  assert.equal(promiseCount, 1);

  const timers = [], timed = fixture({ scope: { queueMicrotask: undefined, Promise: undefined,
    setTimeout: (callback, delay) => { assert.equal(delay, 0); timers.push(callback); } } });
  timed.install(timed.cc);
  let timerCount = 0;
  timed.downloader.handlers['.json'](URL, {}, () => timerCount++);
  assert.equal(timerCount, 0);
  timers.shift()();
  assert.equal(timerCount, 1);
});

test('the shipped inflater decodes real packaged zlib bytes with Chinese and emoji without browser or Node globals', () => {
  const vendorModule = { exports: {} };
  const vendorContext = vm.createContext({ module: vendorModule, exports: vendorModule.exports });
  assert.equal(vm.runInContext('typeof Buffer', vendorContext), 'undefined');
  assert.equal(vm.runInContext('typeof TextDecoder', vendorContext), 'undefined');
  assert.equal(vm.runInContext('typeof window', vendorContext), 'undefined');
  vm.runInContext(fs.readFileSync(projectPath('tools/vendor/startup-inflate.cjs'), 'utf8'), vendorContext);

  const expected = { message: '正在走进森林… 🎮', emoji: '🐱🏹', nested: { text: '武器' }, padding: '数据'.repeat(10000) };
  const metadata = { version: 2, routes: {}, groups: {}, base: BASE, files: { [PATH]: JSON.stringify(expected) } };
  const compressed = zlib.deflateSync(asciiBytes(metadata), { level: 9 });
  const buffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
  const f = fixture({ buffer, inflater: vendorModule.exports });
  assert.equal(f.install(f.cc).installed, true);
  let result;
  f.downloader.handlers['.json'](URL, {}, (error, data) => { assert.equal(error, null); result = data; });
  assert.equal(result, undefined);
  f.flush();
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.equal(f.originalCalls.length, 0);
});
