'use strict';
const timing = require('./wechat-resource-timing.js');
// Use WeChat's versioned subpackage delivery for the original map images.
// Keep the existing adapter for local files, cache behavior and remote fallback.
const installed = new WeakMap();
const REMOTE_BASE = 'https://nurse.kylinsit.com/forest-gunner/';
const MAP_INDEX = __FOREST_GUNNER_MAP_INDEX__;
const PACKAGE_TIMEOUT_MS = 15000;
const PACKAGE_RETRY_DELAY_MS = 60000;
const IMAGE_TIMEOUT_MS = 45000;

function installMapResources(cc) {
  const downloader = cc && cc.assetManager && cc.assetManager.downloader;
  if (!downloader || typeof downloader.register !== 'function' || typeof wx === 'undefined'
    || typeof wx.loadSubpackage !== 'function') return false;
  if (installed.has(downloader)) return true;
  const original = downloader.handlers && downloader.handlers['.png'];
  if (typeof original !== 'function') return false;
  const index = MAP_INDEX;
  if (!index || index.version !== 1 || index.base !== REMOTE_BASE || !index.files) return false;
  const files = Object.create(null);
  for (const remote of Object.keys(index.files)) {
    const item = index.files[remote];
    if (!/^remote\/resources\/native\/[0-9a-f]{2}\/[0-9a-f-]+\.[0-9a-f]+\.png$/.test(remote)
      || !item || !/^forest-map-(?:common|\d+)(?:-\d+)?$/.test(item.package)
      || item.path !== 'subpackages/' + item.package + '/' + remote.slice('remote/resources/'.length)) return false;
    files[remote] = item;
  }
  const requests = new Map(), retryAt = new Map(), failedPackages = new Set();
  function loadPackage(name) {
    if (requests.has(name) && (!retryAt.has(name) || Date.now() < retryAt.get(name))) { timing.reusePackage(name); return requests.get(name); }
    retryAt.delete(name);
    const request = new Promise((resolve, reject) => {
      const finishTiming = timing.beginPackage(name, 'map-images');
      let settled = false;
      const complete = (error, outcome = error ? 'failed' : 'success') => {
        finishTiming(outcome);
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => complete(new Error('WeChat map subpackage timed out: ' + name), 'timeout'), PACKAGE_TIMEOUT_MS);
      try {
        wx.loadSubpackage({ name, success: () => complete(),
          fail: error => complete(error || new Error('WeChat map subpackage failed: ' + name)) });
      } catch (error) { complete(error || new Error('WeChat map subpackage failed: ' + name), 'threw'); }
    }).catch(error => { retryAt.set(name, Date.now() + PACKAGE_RETRY_DELAY_MS); throw error; });
    // Share failures briefly, then allow recovery after connectivity returns.
    // Never leave an unresolved platform Promise occupying the engine slots.
    requests.set(name, request);
    return request;
  }
  downloader.register('.png', function (url, options, complete) {
    const clean = typeof url === 'string' ? url.split(/[?#]/, 1)[0] : '';
    const item = clean.startsWith(REMOTE_BASE) ? files[clean.slice(REMOTE_BASE.length)] : undefined;
    if (!item) return original.call(downloader, url, options, complete);
    let settled = false;
    const done = (error, data) => {
      if (settled) return;
      settled = true; clearTimeout(timer); complete(error, data);
    };
    // Also bound a missing filesystem/CDN callback. This fires before the
    // background loader's 60s watchdog and releases the real downloader slot.
    const timer = setTimeout(() => done(new Error('WeChat map image timed out: ' + clean)), IMAGE_TIMEOUT_MS);
    const read = (path, callback) => {
      if (settled) return;
      try { original.call(downloader, path, options, callback); }
      catch (error) { callback(error || new Error('WeChat map image failed: ' + path)); }
    };
    const fallback = () => read(url, done);
    loadPackage(item.package).then(() => {
      read(item.path, (error, data) => {
        if (error) fallback(); else done(null, data);
      });
    }, error => {
      if (!failedPackages.has(item.package)) {
        failedPackages.add(item.package);
        console.warn('[ForestGunner] Map subpackage unavailable; using server', item.package, error);
      }
      fallback();
    });
  });
  installed.set(downloader, true);
  return true;
}

module.exports = { installMapResources };
