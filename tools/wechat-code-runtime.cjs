'use strict';
function installFeatureCode(features, scope, requireScript) {
  const pending = new Map(), loaded = new Set();
  function load(name) {
    if (loaded.has(name)) return Promise.resolve();
    if (pending.has(name)) return pending.get(name);
    const request = new Promise((resolve, reject) => {
      let active = true;
      const finishTrace = requireScript('./wechat-resource-timing').beginPackage(name, 'code');
      const timer = setTimeout(() => finish(new Error('Feature code download timed out')), 60000);
      function finish(error) {
        if (!active) return;
        active = false; clearTimeout(timer);
        if (!error) {
          try { requireScript('./subpackages/' + name + '/index.js'); loaded.add(name); }
          catch (failure) { error = failure; }
        }
        finishTrace(error ? 'failed' : 'success');
        if (error) reject(error); else resolve();
      }
      try {
        scope.wx.loadSubpackage({ name, success: () => finish(), fail: error => finish(error || new Error('Feature code download failed')) });
      } catch (error) { finish(error); }
    });
    pending.set(name, request);
    void request.then(() => pending.delete(name), () => pending.delete(name));
    return request;
  }
  scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__ = name => {
    if (!Object.prototype.hasOwnProperty.call(features, name)) return Promise.reject(new Error('Unknown feature code: ' + name));
    return Promise.all(features[name].map(load)).then(() => {});
  };
}
module.exports = { installFeatureCode };
