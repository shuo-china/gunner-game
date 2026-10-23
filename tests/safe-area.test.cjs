const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view/SafeArea.ts'), 'utf8');
const moduleValue = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS,
} }).outputText, { module: moduleValue, exports: moduleValue.exports });
const { resolveSafeAreaInsets } = moduleValue.exports;

const viewport = { width: 720, height: 1600 };
const engineRect = (top = 0, bottom = 0) => ({
  x: 0, y: bottom, width: viewport.width, height: viewport.height - top - bottom,
});
const windowInfo = (overrides = {}) => ({
  windowWidth: 360, windowHeight: 800,
  screenWidth: 360, screenHeight: 800, screenTop: 0,
  safeArea: { left: 0, right: 360, top: 24, bottom: 780, width: 360, height: 756 },
  ...overrides,
});
let unexpectedEngineReads = 0;
const mustNotReadEngine = () => { unexpectedEngineReads++; return engineRect(44, 460); };

function expectInsets(actual, top, bottom) {
  assert.equal(unexpectedEngineReads, 0, 'valid host window must not reuse a stale engine safe area');
  assert.ok(Number.isFinite(actual.top), 'top inset must be finite');
  assert.ok(Number.isFinite(actual.bottom), 'bottom inset must be finite');
  assert.ok(Math.abs(actual.top - top) < 1e-8, `top: expected ${top}, received ${actual.top}`);
  assert.ok(Math.abs(actual.bottom - bottom) < 1e-8, `bottom: expected ${bottom}, received ${actual.bottom}`);
}

test('engine fallback preserves normal notch and home indicator in design coordinates', () => {
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(44, 24)), 44, 24);
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect()), 0, 0);
});

test('stale engine bottom or top cannot lift the whole HUD and each valid opposite edge survives', () => {
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(44, 460)), 44, 0);
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(460, 24)), 0, 24);
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(460, 460)), 0, 0);
});

test('edge limit uses one quarter of the short side and discards oversized values instead of clamping', () => {
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(180, 180)), 180, 180);
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(180.01, 20)), 0, 20);
  expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(20, 180.01)), 20, 0);
  expectInsets(resolveSafeAreaInsets({ width: 1600, height: 720 },
    () => ({ x: 0, y: 200, width: 1600, height: 500 })), 20, 0);
});

test('missing, malformed or throwing engine safe area yields finite zero insets', () => {
  for (const rect of [undefined, null, {},
    { x: 0, y: NaN, width: 720, height: 1500 },
    { x: 0, y: 20, width: 0, height: 1500 },
    { x: 0, y: 20, width: 720, height: -1 },
    { x: 0, y: 20, width: 720, height: Infinity },
    { x: 0, y: '20', width: 720, height: 1500 },
  ]) {
    expectInsets(resolveSafeAreaInsets(viewport, () => rect), 0, 0);
  }
  expectInsets(resolveSafeAreaInsets(viewport, () => { throw new Error('not ready'); }), 0, 0);
});

test('current WeChat window data takes priority over stale system and engine rectangles', () => {
  let legacyCalls = 0;
  const host = {
    getWindowInfo: () => windowInfo(),
    getSystemInfoSync: () => { legacyCalls++; return windowInfo({ windowHeight: 600 }); },
  };
  expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, host), 48, 40);
  assert.equal(legacyCalls, 0, 'a valid current window should not be replaced by older metrics');
});

test('absent, failed or dimensionless current window API falls back to the legacy host API', () => {
  for (const getWindowInfo of [undefined, () => undefined, () => null,
    () => { throw new Error('old base library'); },
    () => windowInfo({ windowWidth: 0 }),
    () => windowInfo({ windowHeight: NaN }),
  ]) {
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo,
      getSystemInfoSync: () => windowInfo(),
    }), 48, 40);
  }
});

test('engine fallback remains available when neither host API can supply window dimensions', () => {
  for (const host of [{},
    { getWindowInfo: () => null, getSystemInfoSync: () => ({}) },
    { getWindowInfo: () => { throw new Error('window unavailable'); },
      getSystemInfoSync: () => { throw new Error('system unavailable'); } },
  ]) {
    expectInsets(resolveSafeAreaInsets(viewport, () => engineRect(44, 24), host), 44, 24);
  }
});

test('screen safe bounds subtract screenTop and scale by window height rather than screen height', () => {
  const host = { getWindowInfo: () => windowInfo({
    screenTop: 24, screenHeight: 844,
    safeArea: { left: 0, right: 360, top: 44, bottom: 812, width: 360, height: 768 },
  }) };
  expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, host), 40, 24);
});

test('screen safe bounds enclosing the entire window do not add already excluded system bars', () => {
  const host = { getWindowInfo: () => windowInfo({
    screenTop: 24, screenHeight: 844,
    safeArea: { left: 0, right: 360, top: 0, bottom: 844, width: 360, height: 844 },
  }) };
  expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, host), 0, 0);
});

test('pixel ratio and device brand do not change insets for the same logical window', () => {
  for (const pixelRatio of [1, 2, 3, 4]) {
    for (const brand of ['HUAWEI', 'HONOR', 'Xiaomi', 'Samsung', 'Apple', undefined]) {
      expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
        getWindowInfo: () => windowInfo({ pixelRatio, brand }),
      }), 48, 40);
    }
  }
});

test('valid host window with missing or invalid safe bounds cannot reintroduce corrupt engine insets', () => {
  for (const safeArea of [undefined, null, {},
    { left: 0, right: 360, top: NaN, bottom: 780, width: 360, height: 756 },
    { left: 0, right: 360, top: 780, bottom: 24, width: 360, height: -756 },
  ]) {
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({ safeArea }),
    }), 0, 0);
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({ safeArea, statusBarHeight: 24 }),
    }), 48, 0);
  }
});

test('declared safe area dimensions must be positive and consistent with the reported edges', () => {
  for (const geometry of [
    { width: 0 }, { width: -360 }, { width: NaN }, { width: 300 },
    { height: 0 }, { height: -756 }, { height: NaN }, { height: 700 },
  ]) {
    const safeArea = { ...windowInfo().safeArea, ...geometry };
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({ safeArea }),
    }), 0, 0);
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({ safeArea, statusBarHeight: 24 }),
    }), 48, 0);
  }
});

test('host safe bounds do not require redundant width and height fields', () => {
  expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
    getWindowInfo: () => windowInfo({ safeArea: { top: 24, bottom: 780 } }),
  }), 48, 40);
});

test('status bar fallback removes window offset and rejects unsafe or nonnumeric heights', () => {
  for (const [statusBarHeight, top] of [[24, 0], [44, 40], [undefined, 0], [NaN, 0],
    [Infinity, 0], [-24, 0], ['44', 0], [400, 0]]) {
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({ safeArea: undefined, screenTop: 24, statusBarHeight }),
    }), top, 0);
  }
});

test('implausible host safe edges are rejected independently without losing the real notch or home bar', () => {
  for (const [top, bottom, expectedTop, expectedBottom] of [
    [24, 500, 48, 0],
    [300, 780, 0, 40],
    [90, 710, 180, 180],
    [91, 709, 0, 0],
  ]) {
    expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, {
      getWindowInfo: () => windowInfo({
        safeArea: { left: 0, right: 360, top, bottom, width: 360, height: bottom - top },
      }),
    }), expectedTop, expectedBottom);
  }
});

test('each resize resolves fresh host dimensions and converts into the new design viewport', () => {
  let current = windowInfo();
  const host = { getWindowInfo: () => current };
  expectInsets(resolveSafeAreaInsets(viewport, mustNotReadEngine, host), 48, 40);
  current = windowInfo({ windowWidth: 400, windowHeight: 900, screenWidth: 400, screenHeight: 900,
    safeArea: { left: 0, right: 400, top: 30, bottom: 875, width: 400, height: 845 } });
  expectInsets(resolveSafeAreaInsets({ width: 800, height: 1800 }, mustNotReadEngine, host), 60, 50);
  expectInsets(resolveSafeAreaInsets({ width: 400, height: 900 }, mustNotReadEngine, host), 30, 25);
});
