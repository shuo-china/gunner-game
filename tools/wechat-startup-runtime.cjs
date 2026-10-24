'use strict';
const timing = require('./wechat-resource-timing.js');

// Copied beside game.js by the release packager; this module needs no Node APIs.
const REMOTE_BASE = 'https://nurse.kylinsit.com/forest-gunner/';
const IMPORT_PATH = /^remote\/resources\/(?:config\.[0-9a-f]+|import\/[0-9a-f]{2}\/[0-9a-f-]+(?:@[0-9a-f]+)?\.[0-9a-f]+)\.json$/;
const STARTUP_METADATA_PATH = 'startup-metadata.bin';
const installed = new WeakMap();

function statistics(state) {
  return Object.freeze({
    get installed() { return state.installed; },
    get reason() { return state.reason; },
    get entries() { return state.entries; },
    get hits() { return state.hits; },
    get misses() { return state.misses; },
    get fallbacks() { return state.fallbacks; },
    get bundleInstalled() { return state.bundleInstalled; },
    get bundleHits() { return state.bundleHits; },
    get bundleFallbacks() { return state.bundleFallbacks; },
    get groupsLoaded() { return state.groupsLoaded; },
    get groupRequests() { return state.groupRequests; },
    get groupFallbacks() { return state.groupFallbacks; },
  });
}

function asciiText(bytes) {
  const parts = [];
  // The packager escapes non-ASCII characters, including UTF-16 surrogate pairs.
  // Small chunks also avoid apply's argument limit on mobile JavaScript engines.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const chunk = bytes.subarray(offset, offset + 8192);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] > 127) throw new Error('Startup metadata must contain ASCII JSON');
    }
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return parts.join('');
}

function copyJson(value) {
  if (Array.isArray(value)) return value.map(copyJson);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__') Object.defineProperty(copy, key,
      { value: copyJson(value[key]), writable: true, enumerable: true, configurable: true });
    else copy[key] = copyJson(value[key]);
  }
  return copy;
}

function restoreFonts(data, path, value) {
  const references = data.fonts && data.fonts[path];
  if (!references) return value;
  if (!Array.isArray(references) || !Array.isArray(data.fontMetrics)) throw new Error('Invalid font metadata');
  for (const reference of references) {
    if (!reference || !Array.isArray(reference.path) || !Number.isInteger(reference.index)
      || !data.fontMetrics[reference.index] || !Array.isArray(reference.pages)
      || !reference.variants || typeof reference.variants !== 'object') throw new Error('Invalid font reference');
    const metrics = data.fontMetrics[reference.index];
    const font = typeof metrics === 'string' ? JSON.parse(metrics) : copyJson(metrics);
    if (!font.glyphs || typeof font.glyphs !== 'object') throw new Error('Invalid font metrics');
    font.pages = copyJson(reference.pages);
    for (const code of Object.keys(reference.variants)) {
      if (!Object.prototype.hasOwnProperty.call(font.glyphs, code)) throw new Error('Invalid font glyph');
      font.glyphs[code].variants = copyJson(reference.variants[code]);
    }
    if (!reference.path.length) value = font;
    else {
      let parent = value;
      for (const key of reference.path.slice(0, -1)) {
        if (!parent || !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error('Invalid font path');
        parent = parent[key];
      }
      const key = reference.path[reference.path.length - 1];
      if (!parent || !Object.prototype.hasOwnProperty.call(parent, key) || parent[key] !== null) throw new Error('Invalid font placeholder');
      Object.defineProperty(parent, key, { value: font, writable: true, enumerable: true, configurable: true });
    }
  }
  return value;
}

function restoreMeshes(data, path, value) {
  const references = data.meshes && data.meshes[path];
  if (!references) return value;
  if (!Array.isArray(references) || !Array.isArray(data.meshGeometries)) throw new Error('Invalid mesh metadata');
  for (const reference of references) {
    if (!reference || !Array.isArray(reference.path) || !reference.path.length ||
      !Number.isInteger(reference.index) || typeof data.meshGeometries[reference.index] !== 'string') throw new Error('Invalid mesh reference');
    let mesh = value;
    for (const key of reference.path) {
      if (!mesh || !Object.prototype.hasOwnProperty.call(mesh, key)) throw new Error('Invalid mesh path');
      mesh = mesh[key];
    }
    if (!mesh || typeof mesh !== 'object' || Array.isArray(mesh) ||
      ['positions', 'uv', 'indices'].some(key => Object.prototype.hasOwnProperty.call(mesh, key))) throw new Error('Invalid mesh placeholder');
    // Native JSON.parse preserves independent mutable geometry per effect and
    // per request. Deduplication never aliases two emitters' runtime buffers.
    const geometry = JSON.parse(data.meshGeometries[reference.index]);
    if (!geometry || !Array.isArray(geometry.positions) || !Array.isArray(geometry.uv) || !Array.isArray(geometry.indices)) throw new Error('Invalid mesh geometry');
    mesh.positions = geometry.positions; mesh.uv = geometry.uv; mesh.indices = geometry.indices;
  }
  return value;
}

function installStartupMetadata(cc) {
  const state = { installed: false, reason: 'unavailable', entries: 0, hits: 0, misses: 0, fallbacks: 0,
    bundleInstalled: false, bundleHits: 0, bundleFallbacks: 0, groupsLoaded: 0, groupRequests: 0, groupFallbacks: 0 };
  const stats = statistics(state);
  let downloader, original, files, defer, fileSystem, inflater;
  let routes = {}, groups = {};
  try {
    downloader = cc && cc.assetManager && cc.assetManager.downloader;
    if (!downloader || typeof downloader.register !== 'function') return stats;
    if (installed.has(downloader)) return installed.get(downloader);
    // Capture the WeChat adapter handler so misses retain its filesystem/cache behavior.
    original = downloader.handlers && downloader.handlers['.json'];
    if (typeof original !== 'function' || typeof wx === 'undefined'
      || typeof wx.getFileSystemManager !== 'function') return stats;
    fileSystem = wx.getFileSystemManager();
    if (!fileSystem || typeof fileSystem.readFileSync !== 'function') return stats;
    if (typeof queueMicrotask === 'function') defer = callback => queueMicrotask(callback);
    else if (typeof Promise === 'function') defer = callback => Promise.resolve().then(callback);
    else if (typeof setTimeout === 'function') defer = callback => setTimeout(callback, 0);
    else return stats;

    inflater = require('./startup-inflate.js');
    const buffer = timing.measureMetadata('metadataRead', 'startup-index', () => fileSystem.readFileSync(STARTUP_METADATA_PATH));
    const bytes = timing.measureMetadata('metadataInflate', 'startup-index', () => new inflater.Inflate(new Uint8Array(buffer)).decompress());
    const metadata = timing.measureMetadata('metadataParse', 'startup-index', () => JSON.parse(asciiText(bytes)));
    if (!metadata || metadata.version !== 2 || metadata.base !== REMOTE_BASE
      || !metadata.files || typeof metadata.files !== 'object' || Array.isArray(metadata.files)) {
      state.reason = 'invalid-metadata';
      return stats;
    }
    files = metadata.files;
    routes = metadata.routes; groups = metadata.groups;
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)
      || !groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('Invalid metadata routing');
    for (const name of Object.keys(groups)) {
      const group = groups[name];
      if (!/^forest-(metadata|feature)-[a-z-]+-\d+$/.test(name) || !group || group.name !== name
        || group.path !== 'subpackages/' + name + '/metadata.bin') throw new Error('Invalid metadata group');
    }
    for (const path of Object.keys(routes)) {
      if (!IMPORT_PATH.test(path) || !Object.prototype.hasOwnProperty.call(groups, routes[path])
        || Object.prototype.hasOwnProperty.call(files, path)) throw new Error('Invalid metadata route');
    }
    state.entries = Object.keys(files).filter(path => IMPORT_PATH.test(path)).length + Object.keys(routes).length;
  } catch (_) {
    state.reason = 'metadata-unavailable';
    return stats;
  }

  // Metadata and native images can share one official feature package. Keep
  // their platform request (and completed result) shared across both hooks.
  if (!cc.assetManager.__forestGunnerLoadSubpackage) {
    const requests = new Map();
    cc.assetManager.__forestGunnerLoadSubpackage = name => {
      if (requests.has(name)) { timing.reusePackage(name); return requests.get(name); }
      const request = new Promise((resolve, reject) => {
        const finishTiming = timing.beginPackage(name, 'metadata-shared');
        let settled = false, timer;
        const finish = (error, outcome = error ? 'failed' : 'success') => {
          finishTiming(outcome);
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        if (typeof wx.loadSubpackage !== 'function') return finish(new Error('Metadata subpackages unavailable'), 'unavailable');
        timer = setTimeout(() => finish(new Error('Metadata subpackage timed out: ' + name), 'timeout'), 15000);
        try { wx.loadSubpackage({ name, success: () => finish(), fail: error => finish(error || new Error('Metadata subpackage failed')) }); }
        catch (error) { finish(error, 'threw'); }
      }).catch(error => { requests.delete(name); throw error; });
      requests.set(name, request); return request;
    };
  }
  const groupRequests = new Map(), groupFiles = new Map(), retryAt = new Map();
  function loadGroup(name) {
    if (groupFiles.has(name)) { timing.reusePackage(name); return Promise.resolve(groupFiles.get(name)); }
    if (groupRequests.has(name) && (!retryAt.has(name) || Date.now() < retryAt.get(name))) { timing.reusePackage(name); return groupRequests.get(name); }
    retryAt.delete(name);
    state.groupRequests++;
    const request = cc.assetManager.__forestGunnerLoadSubpackage(name).then(() => {
          const buffer = timing.measureMetadata('metadataRead', name, () => fileSystem.readFileSync(groups[name].path));
          const bytes = timing.measureMetadata('metadataInflate', name, () => new inflater.Inflate(new Uint8Array(buffer)).decompress());
          const data = timing.measureMetadata('metadataParse', name, () => JSON.parse(asciiText(bytes)));
          if (!data || ![1, 2, 3].includes(data.version) || data.base !== REMOTE_BASE || !data.files
            || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('Invalid lazy metadata');
          for (const path of Object.keys(data.files)) {
            if (routes[path] !== name || typeof data.files[path] !== 'string') throw new Error('Mismatched lazy metadata');
          }
          if (data.version >= 2 && (!Array.isArray(data.fontMetrics) || !data.fonts || typeof data.fonts !== 'object')) throw new Error('Invalid shared font metadata');
          if (data.version === 3 && (!Array.isArray(data.meshGeometries) || !data.meshes || typeof data.meshes !== 'object')) throw new Error('Invalid shared mesh metadata');
          groupFiles.set(name, data); state.groupsLoaded++;
          return data;
    }).catch(error => { retryAt.set(name, Date.now() + 2000); throw error; });
    groupRequests.set(name, request);
    return request;
  }

  const handler = function (url, options, complete) {
    const cleanUrl = typeof url === 'string' ? url.split(/[?#]/, 1)[0] : '';
    const path = cleanUrl.startsWith(REMOTE_BASE) ? cleanUrl.slice(REMOTE_BASE.length) : '';
    if (!IMPORT_PATH.test(path) || (!Object.prototype.hasOwnProperty.call(files, path)
      && !Object.prototype.hasOwnProperty.call(routes, path))) {
      state.misses++;
      return original.call(downloader, url, options, complete);
    }

    const fallback = () => {
      state.fallbacks++;
      return original.call(downloader, url, options, complete);
    };
    const deliver = sourceData => {
      let data;
      try {
        const sourceFiles = sourceData.files;
        if (typeof sourceFiles[path] !== 'string') throw new Error('Invalid startup metadata entry');
        // Cocos mutates imported JSON during deserialization. Never reuse a parsed object.
        const group = routes[path] || 'startup-entry';
        const parsed = timing.measureMetadata('metadataParse', group, () => JSON.parse(sourceFiles[path]));
        data = timing.measureMetadata('metadataHydrate', group, () => restoreMeshes(sourceData, path, restoreFonts(sourceData, path, parsed)));
      } catch (_) { return fallback(); }
      state.hits++;
      // Keep callbacks out of the parse catch, including callbacks which throw.
      defer(() => complete(null, data));
    };
    if (Object.prototype.hasOwnProperty.call(files, path)) return deliver({ files });
    loadGroup(routes[path]).then(deliver, () => { state.groupFallbacks++; fallback(); });
  };

  try {
    downloader.register('.json', handler);
  } catch (_) {
    state.reason = 'registration-failed';
    return stats;
  }
  state.installed = true;
  state.reason = 'ready';
  const originalBundle = downloader.handlers && downloader.handlers.bundle;
  if (typeof originalBundle === 'function' && typeof fileSystem.writeFileSync === 'function') {
    // Creator's WeChat bundle handler captures its own JSON loader, bypassing
    // handlers['.json']. Seed its existing temporary-file cache, then let the
    // untouched adapter load the script/config and apply base/zip semantics.
    const bundleHandler = function (url, options, complete) {
      try {
        const version = options && options.version || downloader.bundleVers && downloader.bundleVers.resources;
        const path = typeof version === 'string' && /^[0-9a-f]+$/.test(version)
          ? 'remote/resources/config.' + version + '.json' : '';
        const subpackages = cc.settings && typeof cc.settings.querySettings === 'function'
          ? cc.settings.querySettings('assets', 'subpackages') : [];
        if (url === 'resources' && downloader.remoteServerAddress === REMOTE_BASE
          && Array.isArray(downloader.remoteBundles) && downloader.remoteBundles.includes('resources')
          && !(Array.isArray(subpackages) && subpackages.includes('resources'))
          && path && Object.prototype.hasOwnProperty.call(files, path)) {
          const cache = cc.assetManager.cacheManager;
          const remoteUrl = REMOTE_BASE + path;
          if (cache && typeof cache.cacheDir === 'string' && cache.cacheDir
            && cache.tempFiles && typeof cache.tempFiles.get === 'function'
            && typeof cache.tempFiles.add === 'function') {
            // Preserve already downloaded entries and their cache lifecycle.
            if (!cache.tempFiles.get(remoteUrl)
              && !(cache.cachedFiles && typeof cache.cachedFiles.get === 'function' && cache.cachedFiles.get(remoteUrl))) {
              if (typeof files[path] !== 'string') throw new Error('Invalid startup bundle config');
              const config = timing.measureMetadata('metadataParse', 'bundle-config', () => JSON.parse(files[path]));
              if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid startup bundle config');
              const localPath = cache.cacheDir + '/startup-resources-config.' + version + '.json';
              fileSystem.writeFileSync(localPath, files[path], 'utf8');
              cache.tempFiles.add(remoteUrl, localPath);
              state.bundleHits++;
            }
          }
        }
      } catch (_) {
        // Disk/cache failures retain the original network and error behavior.
        state.bundleFallbacks++;
      }
      return originalBundle.call(downloader, url, options, complete);
    };
    try {
      downloader.register('bundle', bundleHandler);
      state.bundleInstalled = true;
    } catch (_) {
      state.bundleFallbacks++;
    }
  }
  installed.set(downloader, stats);
  return stats;
}

module.exports = { STARTUP_METADATA_PATH, installStartupMetadata };
