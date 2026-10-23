'use strict';
const timing = require('./wechat-resource-timing.js');
const INDEX = __FOREST_GUNNER_FEATURE_INDEX__;
const installed = new WeakSet();
// Three attempts plus retry delays must settle before the resource loader's
// 60-second watchdog, including when WeChat never reports a package result.
const PACKAGE_TIMEOUT_MS = 15000;

function installFeatureResources(cc) {
  const downloader = cc && cc.assetManager && cc.assetManager.downloader;
  if (!downloader || typeof downloader.register !== 'function' || typeof wx === 'undefined') return false;
  if (installed.has(downloader)) return true;
  if (!INDEX || INDEX.version !== 2 || INDEX.base !== 'https://nurse.kylinsit.com/forest-gunner/' || !INDEX.files) return false;
  for (const remote of Object.keys(INDEX.files)) {
    const item = INDEX.files[remote];
    if (!/^remote\/resources\/native\/[0-9a-f]{2}\/[0-9a-f-]+\.[0-9a-f]+\.png$/.test(remote)
      || !item || typeof item.localOnly !== 'boolean'
      || (item.package !== null && !/^forest-(?:ui|feature)-(?:[a-z]+(?:-[a-z]+)*(?:-[0-9a-f]{8})?)-\d+$/.test(item.package))
      || item.path !== (item.package === null ? 'startup-ui/' : 'subpackages/' + item.package + '/') + remote.slice('remote/resources/'.length)) return false;
  }
  const original = downloader.handlers || {};
  if (typeof original['.png'] !== 'function') return false;
  const requests = new Map(), retryAt = new Map();
  function load(name) {
    if (typeof wx.loadSubpackage !== 'function') {
      timing.beginPackage(name, 'feature-images')('unavailable');
      return Promise.reject(new Error('WeChat subpackages are unavailable'));
    }
    if (requests.has(name) && (!retryAt.has(name) || Date.now() < retryAt.get(name))) { timing.reusePackage(name); return requests.get(name); }
    retryAt.delete(name);
    const attempt = number => new Promise((resolve, reject) => {
      // The shared metadata broker records the actual platform attempt once.
      const shared = typeof cc.assetManager.__forestGunnerLoadSubpackage === 'function';
      const finishTiming = shared ? undefined : timing.beginPackage(name, 'feature-images');
      let settled = false;
      const complete = (error, outcome = error ? 'failed' : 'success') => {
        if (finishTiming) finishTiming(outcome);
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => complete(new Error('WeChat subpackage request timed out: ' + name), 'timeout'), PACKAGE_TIMEOUT_MS);
      try {
        if (shared) {
          cc.assetManager.__forestGunnerLoadSubpackage(name).then(() => complete(), complete);
          return;
        }
        wx.loadSubpackage({ name, success: () => complete(),
          fail: error => complete(error || new Error('WeChat subpackage request failed: ' + name)) });
      } catch (error) { complete(error || new Error('WeChat subpackage request failed: ' + name), 'threw'); }
    })
      .catch(error => number < 2 ? new Promise(resolve => setTimeout(resolve, 250 * (number + 1))).then(() => attempt(number + 1)) : Promise.reject(error));
    // A whole panel shares one retry sequence; a later user retry may recover
    // after connectivity returns, without one platform download per icon.
    const request = attempt(0).catch(error => { retryAt.set(name, Date.now() + 2000); throw error; });
    requests.set(name, request); return request;
  }
  for (const extension of ['.png']) {
    const handler = original[extension];
    downloader.register(extension, function (url, options, complete) {
      const clean = typeof url === 'string' ? url.split(/[?#]/, 1)[0] : '';
      const item = clean.startsWith(INDEX.base) ? INDEX.files[clean.slice(INDEX.base.length)] : undefined;
      if (!item) return handler.call(downloader, url, options, complete);
      if (item.package === null) return handler.call(downloader, item.path, options, complete);
      const fallback = error => item.localOnly ? complete(error) : handler.call(downloader, url, options, complete);
      load(item.package).then(() => {
        handler.call(downloader, item.path, options, (error, data) => {
          if (error) fallback(error); else complete(null, data);
        });
      }, fallback);
    });
  }
  installed.add(downloader); return true;
}
module.exports = { installFeatureResources };
