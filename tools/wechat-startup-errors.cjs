'use strict';

// Startup failures happen before the game's own error UI exists.
let reported = false;
function reportStartupError(error) {
  console.error('[Forest Gunner startup]', error);
  if (reported || typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
  reported = true;
  const version = typeof globalThis.__FOREST_GUNNER_RELEASE__ === 'string'
    ? globalThis.__FOREST_GUNNER_RELEASE__ : '';
  let detail = '';
  try { detail = String(error && (error.message || error.errMsg) || error || '未知错误'); } catch (_) {}
  try {
    wx.showModal({
      title: '游戏启动失败',
      content: '请退出小游戏后重新进入。如仍失败，请将此提示截图反馈。'
        + (version ? '\n版本：' + version : '') + '\n' + detail.slice(0, 240),
      showCancel: false,
      confirmText: '知道了',
    });
  } catch (_) {
    // Reporting must not turn the original boot failure into an unhandled rejection.
  }
}

module.exports = { reportStartupError };
