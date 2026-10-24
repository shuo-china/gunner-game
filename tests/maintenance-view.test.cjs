const { projectPath } = require('./support/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const scripts = projectPath('assets/scripts');
const { resourceModules } = require('./support/resource-modules.cjs');
const shared = resourceModules();

function loadScript(relative, imports, globals = {}) {
  if (relative !== 'view/ResourceLoadingPolicy') imports['./ResourceLoadingPolicy'] ??= resourceLoadingPolicy;
  if (relative === 'GameBootstrap') imports['./view/ResourceLoadingPolicy'] ??= resourceLoadingPolicy;
  if (relative === 'view/ArtLibrary') {
    imports['./GameResourceLoader'] ??= loadScript('view/GameResourceLoader', { cc: imports.cc });
    imports['./ResourceBatch'] ??= loadScript('view/ResourceBatch', {}, { setTimeout });
    imports['./NumberGlyphAtlas'] ??= loadScript('view/NumberGlyphAtlas', { cc: imports.cc });
  }
  if (relative === 'view/OriginalMapView') {
    imports['./MapBorderGeometry'] ??= loadScript('view/MapBorderGeometry', {});
    imports['./OriginalParticleMesh'] ??= { OriginalParticleMesh: class {
      constructor(sprite, geometry) {
        this.sprite = sprite; this.geometry = geometry; this.updates = 0;
        assert.equal(sprite.mapBorderMesh, undefined, 'a resident border must allocate its mesh only once');
        sprite.mapBorderMesh = this;
      }
      updateProjected() {
        this.updates++;
        this.sprite.node.setPosition(0, 0, 0); this.sprite.node.angle = 0;
        this.sprite.node.setScale(1, 1, 1);
      }
    } };
  }
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports,
    require: name => {
      if (name === './ResourceLoadingPolicy' || name === './view/ResourceLoadingPolicy') return shared('ResourceLoadingPolicy');
      if (name === './ResourceBatch') return shared('ResourceBatch');
      if (name === './view/UiPreparationQueue') return shared('UiPreparationQueue');
      if (name === './view/BackgroundPreparationScheduler') return shared('BackgroundPreparationScheduler');
      if (['./view/ResourceModuleManager','./view/StartupPreparationBudget','./view/FeatureResourceManifest'].includes(name)) return shared(path.basename(name));
      if (name === './view/LoadingPerformanceTrace') return loadScript('view/LoadingPerformanceTrace', {});
      if (name === './view/StartupTimeline') return loadScript('view/StartupTimeline', {});
      assert.ok(name in imports, `Missing stub for ${name} in ${relative}`);
      return imports[name];
    }, ...globals });
  const source = fs.readFileSync(path.join(scripts, `${relative}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  vm.runInContext(compiled, context);
  return { ...module.exports, context };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Advance the monotonic work clock as well as the game frame. Background work
// deliberately no longer runs on every update(0) at the same timestamp.
async function preparationFrames(app, frames = 140) {
  if (!app.testPreparationClock) {
    app.testPreparationClock = { now: app.preparationNow() };
    app.preparationNow = () => app.testPreparationClock.now;
  }
  for (let i = 0; i < frames; i++) {
    app.testPreparationClock.now += 1000 / 60; app.update(1 / 60); await new Promise(setImmediate);
  }
}

// Legacy gameplay fixtures wait for a panel without simulating combat. Each
// iteration is one real queue tick, separated by a host turn so Promise
// continuations can enqueue their next phase. Lifecycle/scheduling tests use
// app.update through preparationFrames instead of this targeted fixture helper.
async function drainPreparation(app, request, limit = 240) {
  let settled = false, result, failure;
  Promise.resolve(request).then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
  for (let frame = 0; frame < limit && !settled; frame++) {
    await new Promise(setImmediate);
    if (settled) break;
    if (!app.backgrounded && !app.disposed && app.session?.mode === 'Main' && !app.battleLoading) {
      const foreground = app.openingFeature || (app.settingsOpening ? 'settings' : app.dailyCheckOpening ? 'dailyCheck' : undefined);
      app.uiPreparation.tick(foreground, name => app.canPrepareHud(name));
    }
  }
  assert.equal(settled, true, `UI preparation did not settle: ${app.uiPreparation.snapshot().join(', ')}`);
  if (failure) throw failure;
  return result;
}

const resourceLoadingPolicy = loadScript('view/ResourceLoadingPolicy', {});
const backgroundQueue = loadScript('view/BackgroundResourceQueue', {});
const backgroundManifest = loadScript('view/FeatureResourceManifest', {});

// Only APIs exercised by the real constructors/update/teardown paths are stubbed.
function engineStub({ failMaterialAt = 0, failOutputSprite = false } = {}) {
  const materials = [], assets = [], nodes = [];
  class Events {
    listeners = [];
    on(name, fn, target) { this.listeners.push({ name, fn, target, once: false }); }
    once(name, fn, target) { this.listeners.push({ name, fn, target, once: true }); }
    off(name, fn, target) {
      this.listeners = this.listeners.filter(e => e.name !== name || e.fn !== fn || e.target !== target);
    }
    emit(name, ...args) {
      for (const event of this.listeners.slice()) if (event.name === name) {
        if (event.once) this.off(name, event.fn, event.target);
        event.fn.apply(event.target, args);
      }
    }
  }
  class Component { get isValid() { return this.node?.isValid === true; } }
  class UITransform extends Component {
    contentSize = { width: 720, height: 1280 };
    setContentSize(width, height) { this.contentSize = { width, height }; }
    setAnchorPoint(x, y) { this.anchor = { x, y }; }
  }
  class Node extends Events {
    static EventType = { NODE_DESTROYED: 'destroyed', TOUCH_END: 'touch' };
    constructor(name = '') {
      super(); this.name = name; this.children = []; this.components = new Map();
      nodes.push(this);
      this.active = true; this.isValid = true; this.destroyCalls = 0; this.layer = 1;
      this.position = this.worldPosition = { x: 0, y: 0, z: 0 };
      this.worldRotation = {}; this.scale = { x: 1, y: 1, z: 1 };
    }
    addChild(node) { this.children.push(node); node.parent = this; }
    addComponent(Type) {
      if (failOutputSprite && Type === Sprite && this.name === 'OriginalWorldPresentation') throw new Error('output sprite failure');
      const component = new Type(); component.node = this; this.components.set(Type, component); return component;
    }
    getComponent(Type) { return this.components.get(Type); }
    getChildByName(name) { return this.children.find(child => child.name === name); }
    setPosition(x, y, z) { this.position = { x, y, z }; }
    setScale(x, y, z) { this.scale = { x, y, z }; }
    setWorldPosition(value) { this.worldPosition = value; }
    setWorldRotation(value) { this.worldRotation = value; }
    getSiblingIndex() { return this.parent ? this.parent.children.indexOf(this) : 0; }
    setSiblingIndex(index) {
      this.siblingIndex = index;
      const siblings = this.parent?.children;
      if (!siblings) return;
      siblings.splice(siblings.indexOf(this), 1); siblings.splice(Math.min(index, siblings.length), 0, this);
    }
    destroy() {
      if (!this.isValid) return false;
      this.destroyCalls++; this.isValid = false;
      for (const child of this.children) child.destroy();
      // Engine component destruction clears node references before the owning
      // Canvas's Bootstrap.onDestroy runs.
      for (const component of this.components.values()) component.node = null;
      this.emit(Node.EventType.NODE_DESTROYED); return true;
    }
  }
  class Label extends Component {
    static Overflow = { NONE: 0, SHRINK: 2 };
    static HorizontalAlign = { CENTER: 1 };
    static VerticalAlign = { CENTER: 1 };
    writes = 0;
    set string(value) { this.value = value; this.writes++; }
    get string() { return this.value; }
  }
  class Graphics extends Component {
    clears = 0; rectangles = 0; fills = 0;
    clear() { this.clears++; }
    rect(...bounds) { this.rectangles++; this.bounds = bounds; }
    roundRect() { this.rectangles++; }
    fill() { this.fills++; }
    stroke() {}
    moveTo() {}
    lineTo() {}
    close() {}
  }
  class Sprite extends Component { static SizeMode = { CUSTOM: 0 }; }
  class Color { constructor(...rgba) { this.rgba = rgba; } static WHITE = new Color(255, 255, 255, 255); }
  class Asset { constructor() { assets.push(this); } destroyCalls = 0; destroy() { this.destroyCalls++; } }
  class Material extends Asset {
    constructor() { super(); materials.push(this); }
    initialize(options) {
      if (materials.indexOf(this) + 1 === failMaterialAt) throw new Error('material initialization failure');
      this.options = options;
    }
    properties = new Map();
    setProperty(name, value) { this.properties.set(name, value); }
  }
  class RenderTexture extends Asset {
    initialize(options) { Object.assign(this, options); }
    resize(width, height) { Object.assign(this, { width, height }); }
    setWrapMode(x, y) { this.wrap = [x, y]; }
  }
  class SpriteFrame extends Asset { reset({ texture }) { this.texture = texture; } }
  class Texture2D extends Asset {
    static WrapMode = { REPEAT: 0, CLAMP_TO_EDGE: 2 };
    width = 512; height = 512;
    setWrapMode(x, y) { this.wrap = [x, y]; }
  }
  class Camera extends Component { static ProjectionType = { ORTHO: 0 }; static ClearFlag = { SOLID_COLOR: 0 }; priority = 1; visibility = 0x7fffffff; near = .1; far = 1000; }
  const game = new Events(), view = new Events();
  const director = { getScene: () => ({ name: 'main' }), loads: [], loadScene(name) { director.loads.push(name); return true; } };
  const saved = new Map();
  view.setDesignResolutionSize = () => {};
  const cc = { Component, Node, UITransform, Label, Graphics, Sprite, Color, Material, RenderTexture, SpriteFrame, BlockInputEvents: class extends Component {},
    Texture2D, Camera, EffectAsset: class extends Asset {}, JsonAsset: class extends Asset {}, Font: class extends Asset {}, AudioClip: class extends Asset {}, ImageAsset: class extends Asset {},
    Vec4: class { constructor(x, y, z, w) { Object.assign(this, {x, y, z, w}); } },
    Layers: { Enum: { UI_2D: 1 } }, gfx: { BlendFactor: { ONE: 1 } },
    resources: { load: () => assert.fail('Unexpected resource load'), get: () => null },
    assetManager: { parser: {}, downloader: { maxRetryCount: 4 } },
    screen: { windowSize: { width: 720, height: 1280 } },
    _decorator: { ccclass: () => Class => Class, disallowMultiple: Class => Class }, Game: { EVENT_HIDE: 'hide', EVENT_SHOW: 'show' }, game, view, director,
    profiler: { hideStats() {} }, ResolutionPolicy: { FIXED_WIDTH: 0 },
    sys: { localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
      getSafeAreaRect: () => ({ x: 0, y: 0, width: 720, height: 1280 }) } };
  const colorMath = { ORIGINAL_WORLD_LAYER: 1 << 20, ORIGINAL_CAMERA_CLEAR: [.2, .15, .1, 1],
    originalRenderExtent: value => Math.floor(value * .7), srgbToLinear: value => value };
  const artModule = loadScript('view/ArtLibrary', { cc, './OriginalColorMath': colorMath,
    './GameResourceLoader': resourceModules(cc)('GameResourceLoader') });
  return { cc, colorMath, artModule, materials, assets, nodes };
}

// The source HUD's unchanged-state/transition assertions live in hud.test.cjs.

test('ArtLibrary coalesces concurrent frame loads, retries failure and serves successful cache', async () => {
  const { cc, artModule } = engineStub(), requests = [];
  cc.resources.load = (name, Type, callback) => requests.push({ name, Type, callback });
  const art = new artModule.ArtLibrary(), progress = [];
  art.onAssetLoaded = count => progress.push(count);
  const first = art.loadFrame('a'), duplicate = art.loadFrame('a');
  assert.equal(first, duplicate); assert.equal(requests.length, 1);
  const failure = assert.rejects(first, /missing/);
  requests[0].callback(new Error('missing')); await failure;
  assert.deepEqual(progress, [], 'failed requests are not completed assets');
  assert.equal(art.frames.has('a'), false);
  const retry = art.loadFrame('a'); assert.notEqual(retry, first); assert.equal(requests.length, 2);
  const frame = new cc.SpriteFrame(); requests[1].callback(null, frame);
  assert.equal(await retry, frame); assert.equal(await art.loadFrame('a'), frame); assert.equal(requests.length, 2);
  assert.deepEqual(progress, [1], 'coalesced and cached frames count once');
  const json = art.json('config'); requests[2].callback(null, { json: { valid: true } });
  assert.deepEqual(await json, { valid: true }); assert.deepEqual(progress, [1, 2]);
  assert.equal(requests[0].name, 'a/spriteFrame'); assert.equal(requests[0].Type, cc.SpriteFrame);
});

function bootstrapHarness({ artWait = Promise.resolve(), feedbackWait = Promise.resolve({}), startupFontWait,
  moneyWait = Promise.resolve({}), rebirthWait = Promise.resolve({}), skinWait = Promise.resolve({}), settingsWait = Promise.resolve({}), bgmWait = Promise.resolve({}), failResize = false, failHudImage = false, failRebirthImage = false, failSkinImage = false, failSettingsImage = false,
  realWorld = false, storage, environment = 'production', contentOverrides, settingsLoad, skinPrepare, wechat = false, douyin = false, native = false, platformConfig, debug = true, loginRequest, saveRequest, rewardRequest, useRuntimeRewardAuthority = false,
  deferHiddenHuds = false, manualStartup = false, dailyCheck = false, dailyCheckLoad, dailyCheckEntryLoad, offlineLoad, offlineUpdate, sessionNow, weaponLoad, raidLoad, bossLoad, speedRunLoad, fishLoad, adventureLoad, bgmLoad, release, backgroundFail = false } = {}) {
  const engine = engineStub(), { cc, artModule, colorMath } = engine;
  if (storage) cc.sys.localStorage = storage;
  const calls = { worlds: 0, artLoads: 0, feedback: 0, maps: 0, battlefieldDestroyed: 0, colorsDestroyed: 0, hudDestroyed: 0,
    hudAssets: 0, moneyBurst: 0, moneyNumbers: 0, rebirthAssets: 0, rebirthCreated: 0, rebirthDestroyed: 0,
    skinAssets: 0, skinCreated: 0, skinDestroyed: 0, settingsAssets: 0, settingsCreated: 0, settingsDestroyed: 0,
    bgmAssets: 0, bgmCreated: 0, bgmDestroyed: 0, steps: 0, drains: 0, resets: 0, loadouts: 0, fontInstalled: 0,
    dailyCheckAssets: 0, dailyCheckCreated: 0, dailyCheckDestroyed: 0, dailyCheckEntryAssets: 0,
    adventureAssets: 0, adventureCreated: 0, adventureDestroyed: 0,
    weaponAssets: 0, raidAssets: 0, bossAssets: 0, speedRunAssets: 0, fishAssets: 0, fishCreated: 0, fishDestroyed: 0 }, errors = [], logs = [];
  const feedbackEntered = deferred();
  calls.backgroundConfigs = []; calls.backgroundDownloads = [];
  cc.assetManager.loadAny = (request, options, callback) => {
    if (request.type !== cc.JsonAsset) { calls.backgroundDownloads.push(request.path); callback(null, {}); return; }
    calls.backgroundConfigs.push(request.path);
    if (backgroundFail) callback(new Error('offline predownload'));
    else callback(null, { json: JSON.parse(fs.readFileSync(projectPath('assets/resources', request.path + '.json'), 'utf8')) });
  };
  cc.assetManager.preloadAny = (request, options, callback) => { calls.backgroundDownloads.push(request.path); callback(null); };
  const preloaderModule = loadScript('view/GameResourcePreloader', { cc, '../session/PetSystem': { PET_COUNT: 10 },
    './BackgroundResourceQueue': backgroundQueue, './FeatureResourceManifest': backgroundManifest });
  const assets = { hud: {}, moneyBurst: {} };
  const loadedSkins = new Set([0]);
  const skinVisualAssets = { isLoaded: id => loadedSkins.has(id),
    async ensureLoaded(id) { if (skinPrepare) await skinPrepare(id); loadedSkins.add(id); } };
  class World {
    constructor(seed,stage) { calls.worlds++; this.reset(seed,stage); }
    reset(seed,stage) {
      this.stage=stage;
      calls.resets++; this.stats = { shots: 0, hits: 0, kills: 0, totalTrees: 30, elapsed: 0, complete: false };
      this.bullets = []; this.trees = []; this.events = []; this.paused = false; this.simulationTime = 0;
      this.player = { position: { x: 0, z: 0 }, velocity: { x: 0, z: 0 }, moving: false };
    }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    clearMovementInput() { this.player.velocity = { x: 0, z: 0 }; this.player.moving = false; }
    get isPaused() { return this.paused; }
    setMuzzleProvider(provider) { this.provider = provider; }
    setCombatModifiers(value) { this.modifiers = value; }
    setLoadout(value) { calls.loadouts++; this.loadout = value; this.players = value.map(actor => ({ ...this.player, actorId: actor.actorIndex, weaponId: actor.weapon.id })); }
    setViewport() {}
    setPetSpeedPercent(value) {this.petSpeedPercent=value;}
    setMovementMultiplier(value) {this.movementMultiplier=value;}
    stopCombat() {this.player.velocity={x:0,z:0};this.player.moving=false;}
    startCombat() { this.combatStopped = false; }
    setBattlefieldActive(active) { this.battlefieldActive = active; }
    beginRebirth() { this.stopCombat(); this.rebirthStopped = true; }
    advanceEffects(dt) {if(!this.paused)this.simulationTime+=dt;}
    step(dt) { calls.steps++; if (!this.paused) { this.simulationTime += dt; if (!this.stats.complete) this.stats.elapsed += dt; } }
    drainEvents() { calls.drains++; const events = this.events; this.events = []; return events; }
  }
  class Colors {
    static load() { return Promise.resolve([]); }
    constructor(parent) { this.world = artModule.makeNode('World', parent); }
    resize() { if (failResize) throw new Error('resize failure'); }
    syncCamera() {}
    destroy() { calls.colorsDestroyed++; this.world.destroy(); }
  }
  class Battlefield {
    constructor(art, world, parent, feedback, map, burst, numbers, sfx) {
      this.node = artModule.makeNode('Battlefield', parent);
      this.sfx = sfx;
      this.assets = { burst, numbers }; this.eventBatches = []; this.updates = []; this.clears = 0; this.resets = 0;
      this.resetOptions = [];
      this.rewardEffectsActive = false;
    }
    setViewport() {}
    setBattlefieldActive(active) { this.battlefieldActive = active; }
    handleEvents(events, rewards) { this.eventBatches.push({ events, rewards }); }
    update(dt) { this.updates.push(dt); }
    reset(options) { this.resets++; this.resetOptions.push(options); }
    clearTransientEffects() { this.clears++; this.rewardEffectsActive = false; }
    get hasActiveRewards() { return this.rewardEffectsActive; }
    diagnostics() { return { moneyBurst: { active: 0, pooled: 2 } }; }
    prepareCatPose() { return { x: 0, z: 0 }; }
    prepareLoadout() {}
    setShootingMuted(muted) { this.muted = muted; }
    setPets() {}
    setSkin(id) { this.skinId = id; }
    destroy() { calls.battlefieldDestroyed++; this.node.destroy(); }
  }
  class Hud {
    constructor(parent, art, hudAssets, onRestart, onUpgrade, sfx, onSettings) {
      this.node = artModule.makeNode('HUD', parent); this.assets = hudAssets; this.onRestart = onRestart; this.onSettings = onSettings; this.states = [];
      if (failHudImage) {
        artModule.makeNode('PartialHudImage', this.node);
        throw new Error('HUD image failure');
      }
    }
    resize() {}
    cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; }
    setModalOpen(open) { this.modalOpen = open; }
    setLoadingOverlay(elapsed) { this.loadingElapsed = elapsed; }
    getTutorialUpgradeTarget() { return this.modalOpen || this.loadingElapsed != null ? null : this.node; }
    getDiamondTarget() { return this.node; }
    update(state) { this.states.push(state); this.state = state; }
    destroy() { calls.hudDestroyed++; if (this.node.isValid) this.node.destroy(); }
  }
  class Art {
    resourceLoader = new (resourceModules(cc)('GameResourceLoader').GameResourceLoader)();
    frames = new Map();
    catalog = { weapons: { pistol_basic: {} } };
    async json(key) { assert.equal(key, 'art/hud/config'); if (startupFontWait) await startupFontWait; return { bitmapFont: { pages: [] } }; }
    async loadFrame() {}
    load() { assert.ok(calls.fontInstalled > 0, 'font fallback installs before any art load'); calls.artLoads++; calls.art = this; this.onAssetLoaded?.(1); return artWait; }
    image() { throw new Error('HUD image failure'); }
    dispose() { this.frames.clear();this.resourceLoader.invalidate(); }
    evictFrames(paths,retained) {let count=0;for(const path of paths)if(!retained.has(path)&&this.frames.delete(path))count++;return count;}
  }
  class WeaponsHud {
    constructor(parent, art, assets, session, alerts, onVisibility, sfx) { this.node = artModule.makeNode('WeaponsHud', parent); this.alerts = alerts; this.sfx = sfx; this.onVisibility = onVisibility; this.isOpen = false; }
    resize() {}
    update() {}
    setEntryBlocked(value) { this.entryBlocked = value; }
    getTutorialTargets() { return { entry: this.node, buy: this.node, from: null, to: null, blocked: false }; }
    open() { this.isOpen = true; this.onVisibility(true); }
    close() { this.isOpen = false; this.onVisibility(false); }
    cancelInteractions() {}
    async prepareCollectionAssets() {}
    async warmCollection() {this.collectionReady=true;}
    releaseCollection() {this.collectionReady=false;}
    openStarUpgrade(slot, preview) { this.starSlot = slot; this.starPreview = preview; this.isOpen = true; this.onVisibility(true); }
    destroy() { this.node.destroy(); }
  }
  class RebirthHud {
    constructor(parent, art, assets, callbacks) {
      this.node = artModule.makeNode('OriginalRebirthHud', parent); this.assets = assets; this.callbacks = callbacks;
      this.isOpen = false; this.updates = []; this.state = callbacks.getState(); calls.rebirthCreated++;
      if (failRebirthImage) { artModule.makeNode('PartialRebirthImage', this.node); throw new Error('rebirth image failure'); }
    }
    resize() {}
    setEntryBlocked(value) { this.entryBlocked = value; }
    setContentBlocked(value) { this.contentBlocked = value; }
    update(dt, state = this.callbacks.getState()) { this.updates.push(dt); this.state = state; }
    open() {
      if (this.contentBlocked || !this.callbacks.getState().unlocked || this.callbacks.getState().phase !== 'idle') return;
      this.callbacks.onBeforeOpen?.(); this.isOpen = true; this.callbacks.onVisibilityChanged?.(true);
    }
    close() {
      this.cancelInteractions(); if (this.callbacks.getState().phase === 'animating') return;
      this.isOpen = false; this.callbacks.onVisibilityChanged?.(false);
    }
    cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; }
    destroy() { this.cancelInteractions(); calls.rebirthDestroyed++; this.node.destroy(); }
  }
  class SpeedRunHud {
    constructor(parent, art, assets, callbacks) {
      this.node = artModule.makeNode('OriginalSpeedRunHud', parent); this.callbacks = callbacks; this.startOpen = false;
    }
    get isOpen() { return this.startOpen || this.callbacks.getState().phase !== 'idle'; }
    get blocksUpgrades() { return this.startOpen || !['idle', 'playing'].includes(this.callbacks.getState().phase); }
    setEntryVisible(value) { this.entryVisible = value; }
    setEntryBlocked(value) { this.entryBlocked = value; }
    resize() {}
    update() {}
    open() { if (this.callbacks.getState().phase !== 'idle') return; this.callbacks.onBeforeOpen(); this.startOpen = true; this.callbacks.onVisibilityChanged(); }
    close() { this.startOpen = false; this.callbacks.onVisibilityChanged(); }
    cancelInteractions() {}
    destroy() { this.node.destroy(); }
  }
  class RaidHud {
    constructor(parent, art, assets, callbacks) { this.node = artModule.makeNode('OriginalRaidHud', parent); this.callbacks = callbacks; }
    get isOpen() { return this.callbacks.getState().phase !== 'idle'; }
    get blocksUpgrades() { return !['idle', 'playing'].includes(this.callbacks.getState().phase); }
    setEntryVisible(value) { this.entryVisible = value; }
    setEntryBlocked(value) { this.entryBlocked = value; }
    setExternalModalOpen(value) { this.externalModal = value; }
    resize() {}
    update() {}
    open() { this.callbacks.onBeforeOpen?.(); this.callbacks.open(); this.callbacks.onVisibilityChanged?.(); }
    close() { this.callbacks.close(); this.callbacks.onVisibilityChanged?.(); }
    cancelInteractions() {}
    destroy() { this.node.destroy(); }
  }
  class BossHud extends SpeedRunHud {
    update() { if(this.callbacks.getState().phase!=='idle')this.startOpen=false; }
  }
  class SkinHud {
    constructor(parent, art, assets, callbacks) {
      this.node = artModule.makeNode('OriginalSkinHud', parent); this.callbacks = callbacks;
      this.isOpen = false; this.updates = []; calls.skinCreated++;
      if (failSkinImage) { artModule.makeNode('PartialSkinImage', this.node); throw new Error('skin image failure'); }
    }
    setEntryVisible(value) { this.entryVisible = value && this.callbacks.getContentState().visible; }
    setEntryBlocked(value) { this.entryBlocked = value; }
    setContentBlocked(value) { this.contentBlocked = value; }
    resize() {}
    update(dt) { this.updates.push(dt); if (!this.callbacks.getContentState().unlocked && this.isOpen) this.close(); }
    open() { if (!this.callbacks.getContentState().unlocked) return; this.callbacks.onBeforeOpen?.(); this.isOpen = true; this.callbacks.onVisibilityChanged?.(true); }
    openDetail(id) { this.open(); this.detailId = id; }
    close() { this.cancelInteractions(); this.isOpen = false; this.callbacks.onVisibilityChanged?.(false); }
    cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; this.pressed = false; }
    destroy() { this.cancelInteractions(); calls.skinDestroyed++; this.node.destroy(); }
  }
  class PetHud extends SkinHud {
    constructor(...args) {super(...args);calls.skinCreated--;this.node.name='OriginalPetHud';}
    destroy() {this.cancelInteractions();this.node.destroy();}
  }
  class Alerts {
    constructor(parent) { this.node = artModule.makeNode('OriginalAlert', parent); this.clears = 0; this.updates = []; this.node.active = false; }
    show(message) { this.message = message; this.node.active = true; }
    update(dt) { this.updates.push(dt); }
    resize(width, height) { this.extent = { width, height }; }
    clear() { this.clears++; this.node.active = false; }
    destroy() { this.node.destroy(); }
  }
  // Keep the fish popup contract separate from SkinHud: its state and teardown
  // callbacks own transient drag/ad operations, not skin purchase state.
  class FishHud {
    constructor(parent, art, assets, callbacks) {
      this.node = artModule.makeNode('OriginalFishHud', parent); this.callbacks = callbacks;
      this.isOpen = false; this.updates = []; this.state = callbacks.getState(); calls.fishCreated++;
    }
    setEntryVisible(value) { this.entryVisible = value && this.callbacks.getContentState().visible; }
    setEntryBlocked(value) { this.entryBlocked = value; }
    resize() {}
    update(dt) { this.updates.push(dt); this.state = this.callbacks.getState(); }
    open() {
      if (!this.callbacks.getContentState().unlocked || this.isOpen) return;
      this.callbacks.onBeforeOpen?.(); this.isOpen = true; this.callbacks.onVisibilityChanged?.(true);
    }
    openDetail(grade) { this.open(); this.detailGrade = grade; }
    close() { const wasOpen = this.isOpen; this.cancelInteractions(); this.isOpen = false; if (wasOpen) this.callbacks.onVisibilityChanged?.(false); }
    cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; this.callbacks.cancelAd?.(); }
    destroy() { this.cancelInteractions(); calls.fishDestroyed++; this.node.destroy(); }
  }
  class AdventureHud extends FishHud {
    constructor(...args) { super(...args); calls.fishCreated--; calls.adventureCreated++; this.node.name='OriginalAdventureHud'; }
    destroy() { this.cancelInteractions(); calls.adventureDestroyed++; this.node.destroy(); }
  }
  class SettingsHud {
    constructor(parent, art, assets, callbacks) {
      this.node = artModule.makeNode('OriginalSettingsHud', parent); this.callbacks = callbacks;
      this.isOpen = false; this.isRedeemOpen = false; this.updates = []; calls.settingsCreated++;
      if (failSettingsImage) {
        artModule.makeNode('PartialSettingsImage', this.node);
        this.node.destroy(); // SettingsHud's real constructor owns partial cleanup.
        throw new Error('settings image failure');
      }
    }
    setEntryBlocked(value) { this.entryBlocked = value; }
    resize(width, height) { this.extent = { width, height }; }
    update(dt) { this.updates.push(dt); }
    open() {
      if (this.entryBlocked || this.isOpen) return;
      this.callbacks.onBeforeOpen?.(); this.isOpen = true; this.callbacks.onVisibilityChanged?.(true);
    }
    close() {
      this.cancelInteractions(); if (!this.isOpen) return;
      this.isOpen = false; this.isRedeemOpen = false; this.callbacks.onVisibilityChanged?.(false);
    }
    cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; this.pressed = false; }
    destroy() { this.cancelInteractions(); calls.settingsDestroyed++; this.node.destroy(); }
  }
  class DailyCheckHud extends SettingsHud {
    constructor(parent, art, assets, callbacks) {
      super(parent, art, assets, callbacks); calls.settingsCreated--;
      this.node.name = 'OriginalDailyCheckHud'; this.prepared = Promise.resolve(); calls.dailyCheckCreated++;
    }
    update(dt) { this.updates.push(dt); this.state = this.callbacks.getState(); }
    destroy() { this.cancelInteractions(); calls.dailyCheckDestroyed++; this.node.destroy(); }
  }
  class DailyCheckEntry {
    constructor(parent, art, assets, open) { this.node = artModule.makeNode('DailyCheckEntry', parent); this.open = open; this.prepared = Promise.resolve(); }
    setVisible(value) { this.node.active = value; }
    setBlocked(value) { this.blocked = value; }
    resize(...args) { this.extent = args; }
    update() {} cancelInteractions() { this.cancellations = (this.cancellations || 0) + 1; }
    destroy() { this.node.destroy(); }
  }
  class DailyShareEntry extends DailyCheckEntry {
    constructor(...args) { super(...args); this.node.name = 'DailyShareEntry'; calls.dailyShareCreated = (calls.dailyShareCreated || 0) + 1; }
    setRewardState(visible, blocked) { this.node.active = visible; this.blocked = blocked; }
    setEntryOffset(offset) { this.offset = offset; }
  }
  class TutorialHud {
    constructor(parent) { this.node = artModule.makeNode('TutorialHud', parent); this.updates = []; }
    resize(width, height) { this.extent = { width, height }; }
    update(state, targets, dt) { this.updates.push({ state, targets, dt }); this.node.active = state.active && !targets.blocked; }
    hide() { this.node.active = false; }
    destroy() { this.node.destroy(); }
  }
  class RewardedAdModal {
    constructor(parent, onResult) { this.node = artModule.makeNode('RewardedAdModal', parent); this.onResult = onResult; this.isOpen = false; }
    open(id) { this.requestId = id; this.isOpen = true; this.node.active = true; }
    dismiss() { this.isOpen = false; this.node.active = false; }
    resize() {}
    cancelInteractions() {}
    destroy() { this.dismiss(); this.node.destroy(); }
  }
  class Sfx {
    constructor(parent) { this.node = artModule.makeNode('OriginalSfx', parent); this.updates = []; }
    update(dt) { this.updates.push(dt); }
    setEnabled(enabled) { this.enabled = enabled; }
    play() {}
    destroy() { this.node.destroy(); }
  }
  class Bgm {
    constructor(parent) { this.node = artModule.makeNode('OriginalBgm', parent); this.modes = []; this.setup = []; calls.bgmCreated++; }
    setEnabled(enabled) { this.enabled = enabled; this.setup.push(['enabled', enabled]); }
    setPaused(paused) { this.paused = paused; this.setup.push(['paused', paused]); }
    setMode(mode) { this.mode = mode; this.modes.push(mode); this.setup.push(['mode', mode]); }
    destroy() { calls.bgmDestroyed++; this.node.destroy(); }
  }
  const session = require('./.build/session/session/BattleSession.js');
  const { resolveContentConfig } = require('./.build/session/session/ContentConfig.js');
  const sessionForFixture = { ...session,
    BattleSession: class extends session.BattleSession {
      constructor(options) { super({ ...options,
        // Unrelated offline/gameplay fixtures explicitly exercise the isolated local simulator.
        // Cloud cases and authority regressions retain the production bootstrap decision.
        rewardAuthority: useRuntimeRewardAuthority || options.rewardAuthority === 'server' ? options.rewardAuthority : 'local',
        now: sessionNow ?? (() => new Date(2026, 9, 11, 12).getTime()), contentConfig: contentOverrides === undefined ? options.contentConfig : resolveContentConfig(options.environment, contentOverrides) }); }
      // Legacy unrelated gameplay cases opt out of this newly added launch popup.
      getDailyCheckState() { const state = super.getDailyCheckState(); return dailyCheck ? state : { ...state, canClaim: false, claimableIndex: null }; }
    } };
  const core = require('./.build/core/index.js');
  const { GameBootstrap, context } = loadScript('GameBootstrap', {
    cc, 'cc/env': { DEBUG: debug, PREVIEW: false, WECHAT: wechat, BYTEDANCE: douyin, NATIVE: native }, './core': { CombatWorld: realWorld ? core.CombatWorld : World, COMBAT_CONFIG: core.COMBAT_CONFIG,
      createStageDefinition:core.createStageDefinition },
    './view/ArtLibrary': { makeNode: artModule.makeNode, ArtLibrary: Art },
    './view/StartupLoadingScreen': loadScript('view/StartupLoadingScreen', { cc, './ArtLibrary': artModule }),
    './view/CloudSavePanel': loadScript('view/CloudSavePanel', { cc, './ArtLibrary': artModule }),
    './session/CloudSaveStorage': require('./.build/session/session/CloudSaveStorage.js'),
    './view/BattleAssetLoader': { BattleAssetLoader: class { ready() { return true; } async load() {} preload() {} } },
    './view/SkinHudColorPipeline': { disposeSkinHudPresentation() {}, skinHudPresentationSnapshot: () => ({ owners: 0 }) },
    './view/GameResourcePreloader': preloaderModule,
    './view/SafeArea': loadScript('view/SafeArea', {}),
    './view/FeatureEntry': { leftMenuOffsets: () => ({}), rightMenuOffsets: () => ({}), rightMenuShareOffset: () => 355, loadFeatureEntry: async () => ({}), FeatureEntry: class {
      constructor(parent, art, assets, name, open) { this.node = artModule.makeNode('FeatureEntry_' + name, parent); this.entry = this.node; this.open = open; }
      resize(...args) { this.extent = args; } update() {} cancelInteractions() {} destroy() { this.node.destroy(); }
      setState(visible, locked, blocked) { this.node.active = visible; this.locked = locked; this.blocked = blocked; }
      setAlert(value) { this.alert = value; }
    } },
    './view/BattlefieldView': { BattlefieldView: Battlefield }, './view/GameHud': { GameHud: Hud },
    './session/BattleSession': sessionForFixture,
    './core/SpeedRunMap': { createSpeedRunDefinition: core.createSpeedRunDefinition },
    './core/RaidMap': { createRaidDefinition: core.createRaidDefinition },
    './core/BossMap': { createBossDefinition: core.createBossDefinition },
    './core/HuntMap': { createHuntDefinition: core.createHuntDefinition },
    './core/BossCombat': { BossCombat: core.BossCombat },
    './session/RuntimeEnvironment': require('./.build/session/session/RuntimeEnvironment.js'),
    './session/GameBackendConfig': require('./.build/session/session/GameBackendConfig.js'),
    './session/GameLogin': require('./.build/session/session/GameLogin.js'),
    './platform/PlatformServices': require('./.build/session/platform/PlatformServices.js'),
    './session/TutorialPreview': require('./.build/session/session/TutorialPreview.js'),
    './session/RewardedAds': require('./.build/session/session/RewardedAds.js'),
    './session/AudioPreferences': loadScript('session/AudioPreferences', {}),
    './session/WeChatFontFallback': { installWeChatFontFallback(parser) { assert.equal(parser, cc.assetManager.parser); calls.fontInstalled++; } },
    './view/RewardedAdModal': { RewardedAdModal },
    './view/OriginalFeedbackAssets': { loadOriginalFeedback: () => { calls.feedback++; feedbackEntered.resolve(); return feedbackWait; } },
    './view/OriginalMapView': { OriginalMapView: { load: (_art, stageIndex) => { calls.maps++; calls.initialMapStage = stageIndex; return Promise.resolve({}); } } },
    './view/OriginalColorPipeline': { OriginalColorPipeline: Colors }, './view/OriginalColorMath': colorMath,
    './view/FontPolicyLabel': require('./support/font-policy-handle.cjs'),
    './view/MineHud': { MineHud: class extends RaidHud {
      constructor(...args) { super(...args); this.node.name = 'OriginalMineHud'; }
    }, loadMineHudAssets: async () => ({}) },
    './core/MineMap': core,
    './view/OriginalHudAssets': { loadOriginalHudAssets: async () => { calls.hudAssets++; return assets.hud; } },
    './view/OriginalMoneyBurst': { loadOriginalMoneyBurst: async () => { calls.moneyBurst++; return assets.moneyBurst; } },
    './view/DamageNumbers': { loadOriginalMoneyNumbers: () => { calls.moneyNumbers++; return moneyWait; } },
    './view/WeaponVisualAssets': { WeaponVisualAssets: { load: async (_art, ids) => { calls.initialWeaponIds = [...ids]; return {}; } } },
    './view/WeaponHud': { WeaponHud: WeaponsHud, loadWeaponHudAssets: () => { calls.weaponAssets++; return weaponLoad ? weaponLoad() : Promise.resolve({}); } },
    './view/OriginalAlerts': { OriginalAlerts: Alerts, loadOriginalAlertAssets: async () => ({}) },
    './view/OriginalSfx': { OriginalSfx: Sfx, loadOriginalSfxAssets: async () => ({}) },
    './view/OriginalBgm': { OriginalBgm: Bgm, loadOriginalBgmAssets: () => { calls.bgmAssets++; return bgmLoad ? bgmLoad() : bgmWait; } },
    './view/SettingsHud': { SettingsHud, loadSettingsHudAssets: () => { calls.settingsAssets++; return settingsLoad ? settingsLoad() : settingsWait; } },
    './view/DailyCheckHud': { DailyCheckHud, DailyCheckEntry,
      loadDailyCheckHudAssets: () => { calls.dailyCheckAssets++; return dailyCheckLoad ? dailyCheckLoad() : Promise.resolve({}); },
      loadDailyCheckEntryAssets: () => { calls.dailyCheckEntryAssets++; return dailyCheckEntryLoad ? dailyCheckEntryLoad() : Promise.resolve({}); },
    },
    './view/DailyShareEntry': { DailyShareEntry,
      DAILY_SHARE_ENTRY_IMAGES: ['art/boss-system/images/s803', 'art/share-system/images/entry-share'],
      loadDailyShareEntryAssets: async () => { calls.dailyShareAssets = (calls.dailyShareAssets || 0) + 1; return {}; },
    },
    './view/RebirthHud': { RebirthHud, loadRebirthHudAssets: () => { calls.rebirthAssets++; return rebirthWait; } },
    './view/SpeedRunHud': { SpeedRunHud, loadSpeedRunHudAssets: () => { calls.speedRunAssets++; return speedRunLoad ? speedRunLoad() : Promise.resolve({}); } },
    './view/RaidHud': { RaidHud, loadRaidHudAssets: () => { calls.raidAssets++; return raidLoad ? raidLoad() : Promise.resolve({}); } },
    './view/BossHud': { BossHud, loadBossHudAssets: () => { calls.bossAssets++; return bossLoad ? bossLoad() : Promise.resolve({}); } },
    './view/HuntHud': { HuntHud: BossHud, loadHuntHudAssets: async () => ({}) },
    './view/PetHud': { PetHud, loadPetHudAssets: async () => ({}) },
    './view/FishHud': { FishHud, loadFishHudAssets: () => { calls.fishAssets++; return fishLoad ? fishLoad() : Promise.resolve({}); } },
    './view/AdventureHud': { AdventureHud, loadAdventureHudAssets: () => { calls.adventureAssets++; return adventureLoad ? adventureLoad() : Promise.resolve({}); } },
    './view/PetView': { PetVisualAssets: class { prepare() { return Promise.resolve(); } isLoaded() { return true; } } },
    './view/SkinHud': { SkinHud, loadSkinHudAssets: () => { calls.skinAssets++; return skinWait; } },
    './view/SkinVisualAssets': { SkinVisualAssets: { load: async (_art, selectedId) => {
      calls.initialSkinId = selectedId; loadedSkins.add(selectedId); return skinVisualAssets;
    } } },
    './view/OfflineHud': {
      loadOfflineHudAssets: async () => { calls.offlineAssets = (calls.offlineAssets || 0) + 1; return offlineLoad ? offlineLoad() : {}; },
      OfflineHud: class {
        constructor(parent, art, assets, callbacks) { this.node = artModule.makeNode('OriginalOfflineHud', parent); this.callbacks = callbacks; this.isOpen = false; this.prepared = Promise.resolve(); calls.offlineCreated = (calls.offlineCreated || 0) + 1; }
        update(dt) { offlineUpdate?.(this); this.lastDt = dt; this.state = this.callbacks.getState(); this.isOpen = !!this.state?.visible; }
        resize() {} cancelInteractions() {} destroy() { calls.offlineDestroyed = (calls.offlineDestroyed || 0) + 1; this.node.destroy(); }
      },
    },
    './view/TutorialHud': { TutorialHud, loadTutorialHudAssets: async () => ({}) },
  }, { setTimeout, __FOREST_GUNNER_ENV__: { environment }, __FOREST_GUNNER_RELEASE__: release, __FOREST_GUNNER_PLATFORM__: platformConfig, console: { error: (...args) => errors.push(args), info: (...args) => logs.push(args),warn:(...args)=>logs.push(args) } });
  const create = () => {
    const app = new GameBootstrap(); app.node = artModule.makeNode('Canvas');
    const actualStart = app.start.bind(app);
    app.start = () => {
      if (wechat) {
        context.wx ??= {};
        context.wx.login ??= options => { calls.loginCodes = (calls.loginCodes || 0) + 1; options.success({ code: 'fixture-code-' + calls.loginCodes }); };
        context.wx.request ??= options => {
          if (options.url.includes('/rewards/')) {
            calls.rewardRequests ??= []; calls.rewardRequests.push(options);
            if (rewardRequest) return rewardRequest(options);
            const kind = options.url.split('/').at(-1), now = Date.now();
            if (kind === 'state') {
              const { DailyCheckSystem } = require('./.build/session/session/DailyCheckSystem.js'), daily = new DailyCheckSystem();
              if (calls.cloudRaw) daily.restore(JSON.parse(calls.cloudRaw).dailyCheck);
              options.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', server_time_ms: now, revision: calls.cloudRevision ?? '0',
                ...bootstrapRewardState(calls.cloudRaw, calls.cloudRevision, now) } });
            } else {
              assert.equal(kind, 'offline', 'non-startup reward calls need an explicit server fixture');
              const save = JSON.parse(calls.cloudRaw); save.offline = { lastSavedAtMs: now };
              calls.cloudRevision = String(Number(options.data.base_revision) + 1); calls.cloudRaw = JSON.stringify(save);
              options.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', request_id: options.data.request_id,
                revision: calls.cloudRevision, awarded_revision: calls.cloudRevision, save: calls.cloudRaw, saved_at_ms: now,
                ...bootstrapRewardState(calls.cloudRaw, calls.cloudRevision, now), reward: { kind: 'offline', result: null, before: null } } });
            }
            return;
          }
          if(options.url.endsWith('/save')){
            calls.cloudRequests ??= [];
            calls.cloudRequests.push(options);
            if(saveRequest)return saveRequest(options);
            if(options.method==='GET')options.success({statusCode:200,data:{player_id:'101',namespace:'production',revision:calls.cloudRevision??'0',save:calls.cloudRaw??null,saved_at_ms:0}});
            else {
              calls.cloudRevision=String(Number(options.data.base_revision)+1);calls.cloudRaw=options.data.save;
              options.success({statusCode:200,data:{player_id:'101',namespace:'production',request_id:options.data.request_id,revision:calls.cloudRevision,current_revision:calls.cloudRevision,saved_at_ms:Date.now()}});
            }
            return;
          }
          calls.loginRequests = (calls.loginRequests || 0) + 1;
          if (loginRequest) return loginRequest(options);
          options.success({ statusCode: 200, data: bootstrapLoginResponse() });
        };
      }
      return actualStart();
    };
    // Model engine frames while start() waits at its real preparation barrier.
    // Lazy-panel fixtures model an already booted scene with evicted views;
    // startup contracts opt into manualStartup and control real timestamps.
    if (!manualStartup) {
      const start = app.start.bind(app);
      app.start = async () => {
        let settled=false,elapsed=0;const request=start().finally(()=>{settled=true;});
        while(!settled){
          await new Promise(setImmediate);if(settled)break;
          if(!app.preparationReady)continue;
          elapsed+=1000/60;
          // Lazy-view fixtures deliberately model a later evicted/unprepared
          // state. Real startup behavior is exercised by manualStartup cases.
          if(deferHiddenHuds)app.startupModules=[];
          app.startupBudget.now=()=>app.startupStartedAt+elapsed;
          app.checkStartupRelease();if(app.startupRelease)app.update(0);
        }
        await request;
        if (!deferHiddenHuds&&app.ready) for (const name of ['weapons', 'raid', 'boss', 'speedrun', 'rebirth', 'skins']) await drainPreparation(app, app.loadDeferredHud(name));
      };
    }
    artModule.makeNode('Camera', app.node).addComponent(cc.Camera); return app;
  };
  return { create, context, calls, errors, logs, cc, assets, nodes: engine.nodes, feedbackEntered: feedbackEntered.promise };
}

function captureBootstrapSafeAreaLayouts(app) {
  const calls = new Map(), originals = new Map();
  for (const name of ['hud', 'weaponsHud', 'rebirthHud', 'speedRunHud', 'raidHud', 'bossHud', 'huntHud', 'mineHud',
    'skinHud', 'petHud', 'fishHud', 'adventureHud', 'settingsHud', 'offlineHud', 'tutorialHud']) {
    originals.set(name, app[name]);
    app[name] = { resize: (...args) => calls.set(name, args) };
  }
  return { calls, restore() { for (const [name, original] of originals) app[name] = original; } };
}

function bootstrapRewardState(raw, revision, now, today = '2026-10-23') {
  const { DailyCheckSystem } = require('./.build/session/session/DailyCheckSystem.js');
  const { DailyShareSystem } = require('./.build/session/session/DailyShareSystem.js');
  const daily = new DailyCheckSystem(), share = new DailyShareSystem();
  if (raw) { const save = JSON.parse(raw); daily.restore(save.dailyCheck); share.restore(save.dailyShare); }
  return { revision: revision ?? '0', server_time_ms: now, next_daily_reset_ms: now + 86400000,
    daily_check: daily.snapshot(today), daily_share: share.snapshot(today) };
}

function bootstrapLoginResponse() {
  return { player: { id: '101', nickname: '玩家', provider: 'wechat_mini', app_id: 'wx3dd63318911f5012' },
    is_new_player: false, token_info: { access_token: 'fg1_' + 'A'.repeat(43), token_type: 'Bearer', expires_in: 86400, expires_at_ms: Date.now() + 86400000 }, server_time_ms: Date.now() };
}

function enableDailyShareHost(h, show = () => {}) {
  h.context.wx = { ...h.context.wx, shareAppMessage: options => {
    h.calls.shareCalls = (h.calls.shareCalls || 0) + 1; show(options);
  } };
}

function unlockDailyShareContent(app) {
  app.session.tutorial.complete();
  app.session.speedRun.restore({ stage: 1 });
  app.syncModalState();
}

test('daily share appears with daily check only after the tutorial and first challenge win, and hides after claiming', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    const available = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
    app.session.setVerifiedDailyShare(available); app.updateDeferredHuds();
    await Promise.all([app.dailyShareEntryRequest, app.dailyCheckEntryRequest]);
    assert.equal(app.session.getContentState('dailyCheck').reason, 'tutorial');
    assert.equal(app.dailyCheckEntry.node.active, false); assert.equal(app.dailyShareEntry.node.active, false);
    assert.equal(app.canStartDailyShare(), false); await app.beginDailyShare();
    app.session.tutorial.complete(); app.syncModalState();
    assert.equal(app.session.getContentState('dailyCheck').reason, 'challenge');
    assert.equal(app.dailyCheckEntry.node.active, false); assert.equal(app.dailyShareEntry.node.active, false);
    assert.equal(app.canStartDailyShare(), false); await app.beginDailyShare();
    assert.equal(h.calls.shareCalls, undefined, 'A direct call cannot bypass the shared progression gate');
    app.session.speedRun.restore({ stage: 1 }); app.syncModalState();
    assert.equal(app.session.getContentState('dailyCheck').visible, true);
    assert.equal(app.dailyCheckEntry.node.active, true); assert.equal(app.dailyShareEntry.node.active, true);
    assert.equal(app.canStartDailyShare(), true);
    let claims = 0;
    app.session.claimDailyShare = async () => {
      claims++; app.session.setVerifiedDailyShare({ ...available, canClaim: false, lastClaimDay: available.today });
      return { ok: true, diamonds: available.diamonds };
    };
    app.cloudSave.reconcile = async () => {};
    const operation = app.beginDailyShare(); app.onHide(); app.onShow(); await operation;
    assert.equal(claims, 1); assert.equal(h.calls.shareCalls, 1);
    assert.equal(app.dailyShareEntry.node.active, false, 'Claiming removes only the share reward entry');
    assert.equal(app.dailyCheckEntry.node.active, true, 'Daily check keeps its own entry and claim state');
    await app.beginDailyShare(); assert.equal(h.calls.shareCalls, 1);
  } finally { app.onDestroy(); }
});

test('daily share visibility and interaction reuse the separate daily check content contracts', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  await Promise.all([app.dailyShareEntryRequest, app.dailyCheckEntryRequest]);
  try {
    const content = app.session.getContentState.bind(app.session);
    let gate = { visible: false, unlocked: false };
    app.session.getContentState = id => id === 'dailyCheck' ? gate : content(id);
    app.syncModalState();
    assert.equal(app.dailyCheckEntry.node.active, false); assert.equal(app.dailyShareEntry.node.active, false);
    assert.equal(app.canStartDailyShare(), false); await app.beginDailyShare();
    gate = { visible: true, unlocked: false }; app.syncModalState();
    assert.equal(app.dailyCheckEntry.node.active, true); assert.equal(app.dailyShareEntry.node.active, true);
    assert.equal(app.canStartDailyShare(), false); await app.beginDailyShare();
    assert.equal(h.calls.shareCalls, undefined, 'A visible but locked daily feature cannot launch a share');
    gate = { visible: true, unlocked: true }; app.syncModalState();
    assert.equal(app.dailyShareEntry.node.active, true); assert.equal(app.canStartDailyShare(), true);
  } finally { app.onDestroy(); }
});

test('daily share grants once after returning, hides after settlement and rejects repeat clicks', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true });
  enableDailyShareHost(h);
  const app = h.create(); await app.start(); await app.dailyShareEntryRequest;
  try {
    assert.equal(app.canStartDailyShare(), true); assert.equal(app.dailyShareEntry.node.active, true);
    const before = app.session.weapons.diamonds, reward = app.session.getDailyShareState().diamonds;
    const first = app.beginDailyShare(); await app.beginDailyShare();
    assert.equal(h.calls.shareCalls, 1); assert.equal(app.shareBusy, true);
    assert.equal(app.dailyShareEntry.blocked, true); assert.equal(app.session.weapons.diamonds, before);
    app.onHide(); app.onShow(); await first;
    assert.equal(app.session.weapons.diamonds, before + reward);
    assert.equal(app.session.getDailyShareState().canClaim, false);
    assert.equal(app.dailyShareEntry.node.active, false); assert.equal(app.shareBusy, false);
    assert.equal(app.world.isPaused, false, 'settlement must release the world paused when sharing hid the game');
    const elapsed = app.world.simulationTime;
    app.update(1 / 60); app.update(1 / 60);
    assert.ok(app.world.simulationTime > elapsed, 'combat advances after the share result and resumed-frame guard');
    await app.beginDailyShare(); app.onShow();
    assert.equal(h.calls.shareCalls, 1); assert.equal(app.session.weapons.diamonds, before + reward);
  } finally { app.onDestroy(); }
});

test('daily share SDK failure leaves its reward available and does not change the wallet', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true });
  enableDailyShareHost(h, () => { throw Error('platform unavailable'); });
  const app = h.create(); await app.start(); await app.dailyShareEntryRequest;
  try {
    const before = app.session.weapons.diamonds;
    await app.beginDailyShare();
    assert.equal(app.shareBusy, false); assert.equal(app.shareClaimReady, false);
    assert.equal(app.session.weapons.diamonds, before); assert.equal(app.dailyShareEntry.node.active, true);
    assert.match(app.alerts.message, /分享未完成/);
  } finally { app.onDestroy(); }
});

test('daily share respects tutorial, modal, background and non-main interaction gates', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start(); await app.dailyShareEntryRequest;
  try {
    const tutorial = app.session.getTutorialState.bind(app.session);
    app.session.getTutorialState = () => ({ ...tutorial(), active: true }); app.syncModalState();
    assert.equal(app.dailyShareEntry.node.active, false); await app.beginDailyShare();
    app.session.getTutorialState = tutorial;
    app.offlineSummaryPending = true; app.syncModalState();
    assert.equal(app.dailyShareEntry.blocked, true); await app.beginDailyShare(); app.offlineSummaryPending = false;
    app.session.setMode('Mine'); app.syncModalState();
    assert.equal(app.dailyShareEntry.node.active, false); await app.beginDailyShare(); app.session.setMode('Main');
    app.onHide(); await app.beginDailyShare(); app.onShow();
    assert.equal(h.calls.shareCalls, undefined); app.syncModalState(); assert.equal(app.dailyShareEntry.node.active, true);
  } finally { app.onDestroy(); }
});

test('daily share waits for foreground cloud reconciliation before calling the reward service', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    unlockDailyShareContent(app);
    const state = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
    app.session.setVerifiedDailyShare(state); app.updateDeferredHuds(); await app.dailyShareEntryRequest;
    let claims = 0;
    app.session.claimDailyShare = async () => { claims++; app.session.setVerifiedDailyShare({ ...state, lastClaimDay: state.today, canClaim: false }); return { ok: true, diamonds: state.diamonds }; };
    const reconciled = deferred(); app.cloudSave.reconcile = () => reconciled.promise;
    const operation = app.beginDailyShare(); app.onHide(); app.onShow();
    await new Promise(setImmediate);
    assert.equal(claims, 0); assert.equal(app.shareBusy, true); assert.equal(app.cloudForegroundCheck, true);
    reconciled.resolve(); await operation;
    assert.equal(claims, 1); assert.equal(app.cloudForegroundCheck, false); assert.equal(app.dailyShareEntry.node.active, false);
  } finally { app.onDestroy(); }
});

test('daily share ignores a cloud return that finishes after the game has hidden again', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    unlockDailyShareContent(app);
    app.session.setVerifiedDailyShare({ today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 });
    let claims = 0; app.session.claimDailyShare = async () => { claims++; return { ok: true, diamonds: 80 }; };
    const first = deferred(), second = deferred(); let reconciles = 0;
    app.cloudSave.reconcile = () => ++reconciles === 1 ? first.promise : second.promise;
    const operation = app.beginDailyShare(); app.onHide(); app.onShow(); app.onHide();
    first.resolve(); await new Promise(setImmediate);
    assert.equal(claims, 0); assert.equal(app.shareClaimReady, false); assert.equal(app.shareBusy, true);
    app.onShow(); second.resolve(); await operation;
    assert.equal(claims, 1);
  } finally { app.onDestroy(); }
});

test('daily share retries a failed settlement without launching the platform sheet twice', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start(); await app.dailyShareEntryRequest;
  try {
    const grant = app.session.claimDailyShare.bind(app.session), before = app.session.weapons.diamonds;
    let claims = 0;
    app.session.claimDailyShare = () => ++claims === 1 ? { ok: false, reason: 'saveFailed' } : grant();
    const first = app.beginDailyShare(); app.onHide(); app.onShow(); await first;
    assert.equal(app.shareClaimReady, true); assert.equal(app.session.weapons.diamonds, before);
    await app.beginDailyShare();
    assert.equal(claims, 2); assert.equal(h.calls.shareCalls, 1); assert.equal(app.shareClaimReady, false);
    assert.equal(app.dailyShareEntry.node.active, false);
  } finally { app.onDestroy(); }
});

test('daily share teardown destroys the provider and prevents a late result from claiming', async () => {
  const h = bootstrapHarness({ wechat: true, environment: 'test', deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start(); await app.dailyShareEntryRequest;
  const result = deferred(); let destroyed = 0, claims = 0;
  app.shareProvider.destroy();
  app.shareProvider = { supported: true, share: () => result.promise, destroy() { destroyed++; } };
  app.session.claimDailyShare = () => { claims++; return { ok: true, diamonds: 80 }; };
  const operation = app.beginDailyShare(); app.clearViews(); result.resolve({ status: 'unverified' }); await operation;
  assert.equal(destroyed, 1); assert.equal(claims, 0); assert.equal(app.dailyShareEntry, undefined);
  assert.equal(app.shareBusy, false); assert.equal(app.shareClaimReady, false); app.onDestroy();
});

test('daily share stays hidden without verified presentation state and refreshes claimed and next-day state', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    app.session.setVerifiedDailyShare(undefined);
    unlockDailyShareContent(app);
    assert.equal(app.session.getDailyShareState(), undefined); assert.equal(app.dailyShareEntry?.node.active ?? false, false);
    await app.beginDailyShare(); assert.equal(h.calls.shareCalls, undefined);
    let share = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
    app.cloudSave.rewardState = async () => ({ revision: app.cloudSave.currentRevision, daily_check: app.session.verifiedDailyCheck, daily_share: share });
    app.rewardStateRefreshAt = 0; await app.refreshRewardState(); app.updateDeferredHuds(); await app.dailyShareEntryRequest;
    assert.equal(app.dailyShareEntry.node.active, true);
    app.shareClaimReady = true; share = { ...share, lastClaimDay: share.today, canClaim: false };
    app.rewardStateRefreshAt = 0; await app.refreshRewardState(); assert.equal(app.dailyShareEntry.node.active, false);
    assert.equal(app.shareClaimReady, false, 'an authoritative claimed state discards an obsolete retry');
    share = { ...share, today: '2026-10-25', canClaim: true, diamonds: 125 };
    app.rewardStateRefreshAt = 0; await app.refreshRewardState();
    assert.equal(app.dailyShareEntry.node.active, true); assert.equal(app.session.getDailyShareState().diamonds, 125);
    assert.equal(app.shareClaimReady, false, 'a completed reward does not create another automatic claim on the new day');
    app.session.setVerifiedDailyShare(undefined); app.syncModalState();
    assert.equal(app.dailyShareEntry.node.active, false, 'cleared verified presentation state removes an existing entry too');
    await app.beginDailyShare();
    assert.equal(app.shareClaimReady, false);
  } finally { app.onDestroy(); }
});

for (const staleBecause of ['newer reward receipt', 'reward still in flight']) {
  test(`daily share state arriving after ${staleBecause} cannot revive a claimed entry`, async () => {
    const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
    const app = h.create(); await app.start();
    try {
      unlockDailyShareContent(app);
      const available = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
      app.session.setVerifiedDailyShare(available); app.updateDeferredHuds(); await app.dailyShareEntryRequest;
      const state = deferred(), oldRevision = app.cloudSave.currentRevision;
      let revision = oldRevision;
      Object.defineProperty(app.cloudSave, 'currentRevision', { get: () => revision });
      app.cloudSave.rewardState = () => state.promise; app.rewardStateRefreshAt = 0;
      const refreshed = app.refreshRewardState();
      app.session.setVerifiedDailyShare({ ...available, canClaim: false, lastClaimDay: available.today });
      app.syncModalState(); assert.equal(app.dailyShareEntry.node.active, false);
      if (staleBecause === 'newer reward receipt') revision = String(Number(oldRevision) + 1);
      else Object.defineProperty(app.session, 'backendRewardPending', { get: () => true });
      const now = Date.now(); h.context.Date = { now: () => now };
      state.resolve({ revision: oldRevision, daily_check: app.session.verifiedDailyCheck, daily_share: available });
      await refreshed;
      assert.equal(app.dailyShareEntry.node.active, false); assert.equal(app.session.getDailyShareState().canClaim, false);
      assert.equal(app.rewardStateRefreshAt, now + 1000, 'stale state is retried promptly instead of being cached for fifteen minutes');
    } finally { app.onDestroy(); }
  });
}

test('daily share preserves an unsettled retry across midnight until the server accepts or rejects it', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    unlockDailyShareContent(app);
    const yesterday = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
    app.session.setVerifiedDailyShare(yesterday); app.shareClaimReady = true;
    app.cloudSave.rewardState = async () => ({ revision: app.cloudSave.currentRevision,
      daily_check: app.session.verifiedDailyCheck, daily_share: { ...yesterday, today: '2026-10-25' } });
    app.rewardStateRefreshAt = 0; await app.refreshRewardState();
    assert.equal(app.session.getDailyShareState().canClaim, true); assert.equal(app.shareClaimReady, true);
  } finally { app.onDestroy(); }
});

test('daily share definitive rejection clears eligibility even when the next state is a claimable new day', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }); enableDailyShareHost(h);
  const app = h.create(); await app.start();
  try {
    unlockDailyShareContent(app);
    const yesterday = { today: '2026-10-24', lastClaimDay: '', canClaim: true, blocked: false, diamonds: 80 };
    app.session.setVerifiedDailyShare(yesterday);
    let claims = 0;
    app.session.claimDailyShare = async () => { claims++; return { ok: false, reason: 'notClaimable' }; };
    app.cloudSave.reconcile = async () => {};
    app.cloudSave.rewardState = async () => ({ revision: app.cloudSave.currentRevision,
      daily_check: app.session.verifiedDailyCheck, daily_share: { ...yesterday, today: '2026-10-25' } });
    const operation = app.beginDailyShare(); app.onHide(); app.onShow(); await operation;
    assert.equal(app.session.getDailyShareState().canClaim, true); assert.equal(app.shareClaimReady, false);
    assert.equal(app.world.isPaused, false, 'a definitive reward failure also releases the share pause');
    const elapsed = app.world.simulationTime;
    app.update(1 / 60); app.update(1 / 60);
    assert.ok(app.world.simulationTime > elapsed, 'rejected rewards cannot leave the battle frozen');
    app.shareClaimRetryAt = 0; app.update(0); await new Promise(setImmediate);
    assert.equal(h.calls.shareCalls, 1); assert.equal(claims, 1, 'the rejected prior request cannot auto-claim tomorrow');
  } finally { app.onDestroy(); }
});

test('production without login keeps rewards unavailable and never computes local offline income', async () => {
  const saved = offlineBootStorage(), h = bootstrapHarness({ storage: saved.storage, useRuntimeRewardAuthority: true,
    sessionNow: () => OFFLINE_BOOT_NOW, dailyCheck: true, deferHiddenHuds: true }), app = h.create();
  const before = JSON.parse(saved.data.get(saved.key));
  await app.start();
  assert.equal(app.ready, true); assert.equal(app.cloudSave, undefined);
  assert.equal(app.session.offlineInitializationPending, false); assert.equal(app.session.offlineResult, null);
  assert.equal(app.offlineSummaryPending, false); assert.equal(app.session.getDailyCheckState().canClaim, false);
  const diamonds = app.session.weapons.diamonds;
  for (const result of [await app.session.claimDailyCheck(0), await app.session.redeemCode('950424')]) {
    assert.equal(result.ok, false); assert.match(result.message, /登录/);
  }
  assert.equal(app.session.weapons.diamonds, diamonds);
  const after = JSON.parse(saved.data.get(saved.key)).money;
  assert.equal(after.digits, before.money.digits); assert.equal(after.exponent, before.money.exponent);
  assert.deepEqual(JSON.parse(saved.data.get(saved.key)).levels, before.levels);
  assert.equal(h.calls.rewardRequests, undefined); app.onDestroy();
});

test('cloud startup reuses complete offline receipt state before constructing the settled session', async () => {
  const saved = offlineBootStorage(), original = saved.data.get(saved.key);
  const { DailyCheckSystem } = require('./.build/session/session/DailyCheckSystem.js');
  const { OriginalInfVal } = require('./.build/session/core/OriginalInfVal.js');
  const daily = new DailyCheckSystem().snapshot('2026-10-15');
  const share = { today: '2026-10-15', lastClaimDay: '2026-10-15', canClaim: false, blocked: false, diamonds: 80 };
  let offline;
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true, useRuntimeRewardAuthority: true, sessionNow: () => OFFLINE_BOOT_NOW,
    rewardRequest: options => {
      if (options.url.endsWith('/offline')) { offline = options; return; }
      assert.equal(app.session, undefined, 'daily state is verified before session construction');
      options.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', server_time_ms: OFFLINE_BOOT_NOW,
        revision: h.calls.cloudRevision, next_daily_reset_ms: OFFLINE_BOOT_NOW + 86400000, daily_check: daily, daily_share: share } });
    } }), app = h.create();
  h.calls.cloudRaw = original; h.calls.cloudRevision = '4';
  const starting = app.start(); await new Promise(setImmediate);
  assert.ok(offline); assert.equal(offline.method, 'POST'); assert.equal(offline.data.base_revision, '4');
  assert.equal(app.session, undefined); assert.equal(h.calls.worlds, 0); assert.equal(app.startupEntryReady, false);
  assert.equal(app.cloudSave.localSave, original);
  const settled = JSON.parse(original); settled.money = OriginalInfVal.fromInt(7654321).toJSON();
  settled.levels = [8, 9, 10]; settled.offline.lastSavedAtMs = OFFLINE_BOOT_NOW;
  h.calls.cloudRaw = JSON.stringify(settled); h.calls.cloudRevision = '5';
  offline.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', request_id: offline.data.request_id,
    revision: '5', awarded_revision: '5', save: h.calls.cloudRaw, saved_at_ms: OFFLINE_BOOT_NOW, server_time_ms: OFFLINE_BOOT_NOW,
    next_daily_reset_ms: OFFLINE_BOOT_NOW + 12 * 60 * 60000, daily_check: daily, daily_share: share,
    reward: { kind: 'offline', result: null, before: null } } });
  await starting;
  assert.equal(app.ready, true); assert.equal(app.session.offlineInitializationPending, false);
  assert.equal(app.session.moneyBalance.toString(), '7654321');
  assert.deepEqual(app.session.snapshot({}).upgrades.map(upgrade => upgrade.level), [8, 9, 10]);
  assert.equal(app.session.getDailyCheckState().today, '2026-10-15');
  assert.deepEqual(app.session.verifiedDailyCheck, daily);
  assert.deepEqual(app.session.getDailyShareState(), share);
  assert.deepEqual(h.calls.rewardRequests.map(options => options.url.split('/').at(-1)), ['offline']);
  assert.deepEqual(JSON.parse(app.cloudSave.localSave).money, settled.money);
  assert.equal(app.cloudSave.rewardPending, false); assert.equal(app.cloudSave.dirty, false);
  app.onDestroy();
});

test('cloud startup expired receipt state failure retries state without repeating an already-settled offline claim', async () => {
  const saved = offlineBootStorage(), original = saved.data.get(saved.key);
  const { DailyCheckSystem } = require('./.build/session/session/DailyCheckSystem.js');
  const { OriginalInfVal } = require('./.build/session/core/OriginalInfVal.js');
  const settled = JSON.parse(original); settled.money = OriginalInfVal.fromInt(7654321).toJSON();
  settled.offline.lastSavedAtMs = OFFLINE_BOOT_NOW;
  let states = 0, now;
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true, useRuntimeRewardAuthority: true, sessionNow: () => OFFLINE_BOOT_NOW,
    rewardRequest: options => {
      if (options.url.endsWith('/offline')) {
        now = Date.now(); app.cloudSave.now = () => now;
        const readState = app.cloudSave.rewardState.bind(app.cloudSave);
        app.cloudSave.rewardState = receipt => {
          if (receipt) now += 1001;
          return readState(receipt);
        };
        h.calls.cloudRaw = JSON.stringify(settled); h.calls.cloudRevision = '5';
        options.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', request_id: options.data.request_id,
          revision: '5', awarded_revision: '5', save: h.calls.cloudRaw, saved_at_ms: OFFLINE_BOOT_NOW, server_time_ms: OFFLINE_BOOT_NOW,
          ...bootstrapRewardState(h.calls.cloudRaw, '5', OFFLINE_BOOT_NOW, '2026-10-15'),
          reward: { kind: 'offline', result: null, before: null } } });
        return;
      }
      assert.ok(options.url.endsWith('/state'));
      if (++states === 1) { options.fail({ errMsg: 'temporary state failure' }); return; }
      options.success({ statusCode: 200, data: { player_id: '101', namespace: 'production', revision: h.calls.cloudRevision,
        ...bootstrapRewardState(h.calls.cloudRaw, h.calls.cloudRevision, OFFLINE_BOOT_NOW, '2026-10-15') } });
    } }), app = h.create();
  h.calls.cloudRaw = original; h.calls.cloudRevision = '4';
  const starting = app.start();
  try {
    await waitForOfflineRetry(app);
    assert.equal(app.session, undefined); assert.equal(app.ready, false); assert.equal(h.calls.worlds, 0);
    assert.equal(app.cloudSave.currentRevision, '5'); assert.equal(app.cloudSave.rewardPending, false);
    assert.deepEqual(JSON.parse(app.cloudSave.localSave).money, settled.money);
    app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END, { propagationStopped: false });
    await starting;
    assert.equal(app.ready, true); assert.equal(app.session.moneyBalance.toString(), '7654321');
    assert.equal(app.session.getDailyCheckState().today, '2026-10-15');
    assert.deepEqual(h.calls.rewardRequests.map(options => options.url.split('/').at(-1)), ['offline', 'state', 'state']);
    assert.deepEqual(h.errors, []);
  } finally { app.onDestroy(); await starting; }
});

test('cloud read precedes session creation and initial upload gates automatic entry and account-dependent assets', async () => {
  let read, write;
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true,saveRequest:o=>{if(o.method==='GET')read=o;else write=o;}}),app=h.create(),start=app.start();
  await new Promise(setImmediate);
  assert.ok(read);assert.equal(app.session,undefined);assert.equal(app.startupEntryReady,false);
  assert.equal(app.startupInputBlock.getChildByName('StartGameButton'),undefined);
  assert.equal(app.resourceLoadingSnapshot().startup.dataReadyMs,null);assert.equal(app.ready,false);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  assert.equal(h.calls.maps,0);assert.equal(h.calls.initialWeaponIds,undefined);
  assert.equal(h.context.__forestGunnerLoading.snapshot().startup.timeline.phases.cloudRead.active,1);
  read.success({statusCode:200,data:{player_id:'101',namespace:'production',revision:'0',save:null,saved_at_ms:0}});
  await new Promise(setImmediate);
  assert.ok(write);assert.ok(app.session);assert.equal(app.startupEntryReady,false);assert.equal(h.calls.worlds,0);
  assert.equal(app.resourceLoadingSnapshot().startup.dataReadyMs,null);assert.equal(app.ready,false);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  assert.equal(h.calls.maps,0);assert.equal(h.calls.initialWeaponIds,undefined);
  assert.equal(h.context.__forestGunnerLoading.snapshot().startup.timeline.phases.cloudWrite.active,1);
  write.success({statusCode:200,data:{player_id:'101',namespace:'production',revision:'1',current_revision:'1',request_id:write.data.request_id,saved_at_ms:Date.now()}});
  await start;assert.equal(app.ready,true);assert.equal(app.cloudSave.dirty,false);
  assert.equal(app.resourceLoadingSnapshot().startup.entryMode,'automatic');
  assert.notEqual(app.resourceLoadingSnapshot().startup.dataReadyMs,null);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.maps,1);
  const timeline=h.context.__forestGunnerLoading.snapshot().startup.timeline;
  assert.equal(timeline.phases.cloudRead.succeeded,1);assert.equal(timeline.phases.cloudWrite.succeeded,1);
  app.onDestroy();
});

test('cloud read failure keeps the account at retry without initializing a fresh session', async () => {
  const h=bootstrapHarness({wechat:true,saveRequest:o=>o.fail({})}),app=h.create(),start=app.start();
  await new Promise(setImmediate);
  assert.ok(app.cancelOfflineRetry);assert.equal(app.session,undefined);assert.equal(app.startupEntryReady,false);assert.equal(h.calls.worlds,0);
  app.onDestroy();await start;
});

test('new authenticated accounts ignore obsolete local saves without showing an import decision', async () => {
  const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js'), data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  new BattleSession({ environment: 'production', storage });
  const key = economyStorageKey('production'), old = JSON.parse(storage.getItem(key)); old.levels[0] = 42;
  storage.setItem(key, JSON.stringify(old));
  const h = bootstrapHarness({ wechat: true, storage, deferHiddenHuds: true }), app = h.create();
  try {
    await app.start(); assert.equal(app.ready, true); assert.equal(app.cloudPanel.cover.active, false);
    assert.equal(app.session.snapshot({}).upgrades[0].level, 0); assert.deepEqual(JSON.parse(storage.getItem(key)), old);
    assert.equal(storage.getItem(app.cloudSave.journalKey + ':backup:legacy'), null);
    assert.ok(h.calls.cloudRequests.some(o => o.method === 'POST'));
  } finally { app.onDestroy(); }
});

test('test-funded WeChat sessions never use production cloud storage', async () => {
  const h=bootstrapHarness({wechat:true,environment:'test',deferHiddenHuds:true}),app=h.create();await app.start();
  assert.equal(app.ready,true);assert.equal(app.cloudSave,undefined);assert.equal(h.calls.cloudRequests,undefined);app.onDestroy();
});

for(const screenOff of [false,true])test(`a foreground cloud conflict pauses gameplay and offers both snapshots${screenOff?' after screen unlock':''}`, async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
  if(screenOff){app.onHide();await new Promise(setImmediate);}
  const changed=JSON.parse(h.calls.cloudRaw);changed.progress.stageIndex=3;h.calls.cloudRaw=JSON.stringify(changed);h.calls.cloudRevision='2';
  const nextRead=app.cloudSave.now()+300001;app.cloudSave.now=()=>nextRead;
  app.onShow();assert.equal(app.isPaused,true);await new Promise(setImmediate);
  if(screenOff)assert.equal(app.world.isPaused,true,'a conflicting cloud save cannot release the hidden world');
  app.update(1/60);
  assert.equal(app.cloudSave.status,'conflict');assert.equal(app.cloudPanel.cover.active,true);assert.equal(app.isPaused,true);
  assert.match(app.cloudPanel.body.string,/两份存档/);app.onDestroy();await new Promise(setImmediate);
});

test('screen unlock resumes the real combat world after foreground cloud reconciliation', async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true,realWorld:true}),app=h.create();await app.start();
  try {
    app.update(0);app.update(1/60);const before=app.world.simulationTime;
    app.onHide();app.update(60);assert.equal(app.world.simulationTime,before);
    const nextRead=app.cloudSave.now()+300001;app.cloudSave.now=()=>nextRead;
    app.onShow();assert.equal(app.isPaused,true);assert.equal(app.world.isPaused,true);
    await new Promise(setImmediate);
    assert.equal(app.cloudForegroundCheck,false);assert.equal(app.world.isPaused,false);
    app.update(60);assert.equal(app.world.simulationTime,before,'the first resumed frame cannot catch up screen-off time');
    app.update(1/60);assert.ok(app.world.simulationTime>before,'combat advances after cloud success');
  } finally { app.onDestroy(); }
});

test('screen unlock resumes combat after a failed cloud network check', async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
  try {
    app.onHide();await new Promise(setImmediate);
    h.context.wx.request=options=>options.fail({errMsg:'network unavailable'});
    const nextRead=app.cloudSave.now()+300001;app.cloudSave.now=()=>nextRead;
    app.onShow();await new Promise(setImmediate);
    assert.equal(app.cloudSave.status,'offline');assert.equal(app.isPaused,false);assert.equal(app.world.isPaused,false);
    app.update(60);const before=app.world.simulationTime;app.update(1/60);
    assert.ok(app.world.simulationTime>before,'local gameplay continues after a failed request');
  } finally { app.onDestroy(); }
});

test('an older foreground check cannot release a newer screen-unlock check', async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
  try {
    const first=deferred(),second=deferred();let checks=0;
    app.cloudSave.reconcile=()=>++checks===1?first.promise:second.promise;
    app.onHide();app.onShow();app.onHide();app.onShow();
    first.resolve();await new Promise(setImmediate);
    assert.equal(app.cloudForegroundCheck,true);assert.equal(app.world.isPaused,true);
    second.resolve();await new Promise(setImmediate);
    assert.equal(app.cloudForegroundCheck,false);assert.equal(app.world.isPaused,false);
  } finally { app.onDestroy(); }
});

for(const blockedBy of ['background','manual pause','cloud conflict','battle loading','destroy']) {
  test(`foreground cloud completion respects ${blockedBy}`,async()=>{
    const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
    try {
      const pending=deferred();app.cloudSave.reconcile=()=>pending.promise;
      app.onHide();app.onShow();const world=app.world;
      if(blockedBy==='background')app.onHide();
      else if(blockedBy==='manual pause')app.togglePause();
      else if(blockedBy==='cloud conflict')app.cloudSave.status='conflict';
      else if(blockedBy==='battle loading')app.battleLoading=true;
      else app.onDestroy();
      pending.resolve();await new Promise(setImmediate);
      assert.equal(world.isPaused,true,'completion must preserve the current pause reason');
      if(blockedBy==='background'){
        app.onShow();await new Promise(setImmediate);assert.equal(world.isPaused,false,'a later valid return still resumes');
      }else if(blockedBy==='manual pause'){
        app.togglePause();assert.equal(world.isPaused,false,'the user can resume explicitly');
      }
    } finally { if(!app.disposed)app.onDestroy(); }
  });
}

test('cloud conflict reload releases views before engine scene destruction and retains the chosen save', async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
  const changed=JSON.parse(h.calls.cloudRaw);changed.progress.stageIndex=3;h.calls.cloudRaw=JSON.stringify(changed);h.calls.cloudRevision='2';
  const nextRead=app.cloudSave.now()+300001;app.cloudSave.now=()=>nextRead;
  await app.cloudSave.reconcile();const cloud=app.cloudSave;let reloaded=false;
  app.chooseCloudSave=async()=> 'cloud';
  h.cc.director.loadScene=()=>{
    assert.equal(app.ready,false);assert.equal(app.hud,undefined);assert.equal(app.weaponsHud,undefined);
    assert.equal(app.cloudPanel.title.string,'正在恢复进度');
    reloaded=true;app.onDestroy();return true;
  };
  await app.handleCloudDecision();assert.equal(reloaded,true);assert.equal(cloud.localSave,h.calls.cloudRaw);assert.deepEqual(h.errors,[]);
});

test('cached cloud state survives repeated daily-panel opens and foreground changes until its fifteen-minute expiry', async () => {
  let now=Date.now();const startedAt=now;
  const h=bootstrapHarness({wechat:true,dailyCheck:true,deferHiddenHuds:true,sessionNow:()=>now,
    contentOverrides:{tutorialEnabled:false,thresholds:{rebirthSkinChallengeWins:0}}});
  h.context.Date={now:()=>now};const app=h.create();await app.start();
  app.cloudSave.now=()=>now;app.dailyCheckAutoPending=false;
  const stateReads=()=>h.calls.rewardRequests.filter(request=>request.url.endsWith('/state')).length;
  const saveReads=()=>h.calls.cloudRequests.filter(request=>request.method==='GET').length;
  const saveWrites=()=>h.calls.cloudRequests.filter(request=>request.method==='POST').length;
  const initialWrites=saveWrites();
  try {
    assert.equal(stateReads(),1);assert.equal(saveReads(),1);
    for(let i=0;i<5;i++){
      await drainPreparation(app,app.openDailyCheck());assert.equal(app.dailyCheckHud.isOpen,true);
      app.dailyCheckHud.close();app.syncModalState();now+=1000;
      app.onHide();app.onShow();await new Promise(setImmediate);app.update(0);
      assert.equal(stateReads(),1,'reopening and resuming keep the cached reward state');
      assert.equal(saveReads(),1,'rapid foreground checks reuse the recent cloud read');
      assert.equal(saveWrites(),initialWrites,'rapid hide events cannot upload each local checkpoint');
    }
    now=startedAt+15*60000-1;
    await drainPreparation(app,app.openDailyCheck());assert.equal(stateReads(),1);
    app.dailyCheckHud.close();app.syncModalState();
    now++;
    await drainPreparation(app,Promise.all([app.openDailyCheck(),app.openDailyCheck()]));
    assert.equal(stateReads(),2,'expiry refreshes once even when two opens overlap');
    assert.equal(app.dailyCheckHud.isOpen,true);
  } finally {app.onDestroy();}
});

test('server daily reset expires the reward presentation before the fifteen-minute cache', async () => {
  const resetAt=Date.UTC(2026,9,23,16);let now=resetAt-10000;
  const {DailyCheckSystem}=require('./.build/session/session/DailyCheckSystem.js');
  const h=bootstrapHarness({wechat:true,dailyCheck:true,deferHiddenHuds:true,sessionNow:()=>now,
    rewardRequest:options=>{
      assert.ok(options.url.endsWith('/state'));
      options.success({statusCode:200,data:{player_id:'101',namespace:'production',
        ...bootstrapRewardState(h.calls.cloudRaw,h.calls.cloudRevision,now,now<resetAt?'2026-10-23':'2026-10-24'),
        next_daily_reset_ms:now<resetAt?resetAt:resetAt+86400000,
      }});
    }});
  h.context.Date={now:()=>now};const app=h.create();await app.start();app.dailyCheckAutoPending=false;
  try {
    assert.equal(h.calls.rewardRequests.length,1);assert.equal(app.session.getDailyCheckState().today,'2026-10-23');
    now=resetAt-1;app.update(0);await new Promise(setImmediate);
    assert.equal(h.calls.rewardRequests.length,1);
    now=resetAt;app.update(0);await new Promise(setImmediate);
    assert.equal(h.calls.rewardRequests.length,2);assert.equal(app.session.getDailyCheckState().today,'2026-10-24');
    now=resetAt+15*60000-1;app.update(0);await new Promise(setImmediate);
    assert.equal(h.calls.rewardRequests.length,2,'the new day starts a fresh presentation cache');
    now++;app.update(0);await new Promise(setImmediate);assert.equal(h.calls.rewardRequests.length,3);
  } finally {app.onDestroy();}
});

test('failed reward-state refreshes back off for fifteen minutes across daily-panel opens and resume', async () => {
  let now=Date.now(),fail=false;
  const {DailyCheckSystem}=require('./.build/session/session/DailyCheckSystem.js');
  const h=bootstrapHarness({wechat:true,dailyCheck:true,deferHiddenHuds:true,sessionNow:()=>now,
    contentOverrides:{tutorialEnabled:false,thresholds:{rebirthSkinChallengeWins:0}},
    rewardRequest:options=>{
      assert.ok(options.url.endsWith('/state'));
      if(fail){options.fail({errMsg:'network unavailable'});return;}
      options.success({statusCode:200,data:{player_id:'101',namespace:'production',server_time_ms:now,revision:h.calls.cloudRevision??'0',
        ...bootstrapRewardState(h.calls.cloudRaw,h.calls.cloudRevision,now)}});
    }});
  h.context.Date={now:()=>now};const app=h.create();await app.start();app.dailyCheckAutoPending=false;
  try {
    await drainPreparation(app,app.openDailyCheck());app.dailyCheckHud.close();app.syncModalState();
    fail=true;now+=15*60000;
    await drainPreparation(app,app.openDailyCheck());assert.equal(h.calls.rewardRequests.length,2);
    assert.equal(app.dailyCheckHud.isOpen,true,'cached presentation remains usable after a transient state failure');
    app.dailyCheckHud.close();app.syncModalState();
    now+=15*60000-1;app.onHide();app.onShow();await new Promise(setImmediate);
    await drainPreparation(app,app.openDailyCheck());assert.equal(h.calls.rewardRequests.length,2);
    app.dailyCheckHud.close();app.syncModalState();
    now++;fail=false;await drainPreparation(app,app.openDailyCheck());
    assert.equal(h.calls.rewardRequests.length,3);assert.equal(app.dailyCheckHud.isOpen,true);
  } finally {app.onDestroy();}
});

test('Bootstrap cloud notices use filtered display status for repeated failures and slow synchronization', async () => {
  const h=bootstrapHarness({wechat:true,deferHiddenHuds:true}),app=h.create();await app.start();
  const cloud=app.cloudSave;let now=cloud.now();cloud.now=()=>now;
  try {
    h.context.wx.request=options=>options.fail({errMsg:'network unavailable'});
    for(let failures=1;failures<=3;failures++){
      now+=300001;await cloud.reconcile().catch(()=>{});app.update(0);
      assert.equal(cloud.status,'offline');
      assert.equal(app.cloudPanel.status.node.active,failures===3,'the first two failures remain quiet');
    }
    assert.match(app.cloudPanel.status.string,/等待云端同步/);
    let pending;h.context.wx.request=options=>{pending=options;};now+=300001;
    const request=cloud.reconcile();await new Promise(setImmediate);assert.ok(pending);
    app.update(0);assert.equal(cloud.status,'syncing');assert.equal(app.cloudPanel.status.node.active,false);
    now+=2999;app.update(0);assert.equal(app.cloudPanel.status.node.active,false);
    now++;app.update(0);assert.match(app.cloudPanel.status.string,/正在同步进度/);
    assert.equal(app.cloudPanel.status.node.active,true);
    pending.success({statusCode:200,data:{player_id:'101',namespace:'production',revision:h.calls.cloudRevision,
      save:h.calls.cloudRaw,saved_at_ms:now}});
    await request;app.update(0);assert.equal(app.cloudPanel.status.node.active,false);
  } finally {app.onDestroy();}
});

test('WeChat startup waits for verified login before loading the local session or gameplay', async () => {
  let response;
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true, loginRequest: options => { response = options; } });
  const app = h.create(), start = app.start();
  await new Promise(setImmediate);
  assert.ok(response); assert.equal(app.session, undefined); assert.equal(h.calls.worlds, 0);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  assert.equal(h.calls.maps,0);assert.equal(h.calls.initialWeaponIds,undefined);assert.equal(app.startupEntryReady,false);
  const timeline=h.context.__forestGunnerLoading.snapshot().startup.timeline;
  assert.equal(timeline.phases.login.active,1);assert.equal(timeline.phases.core.active,1);
  app.update(1 / 60); app.onHide(); app.update(1 / 60); app.onShow(); app.update(1 / 60);
  assert.equal(app.session, undefined, 'engine frames and foreground changes do not bypass login');
  response.success({ statusCode: 200, data: bootstrapLoginResponse() });
  await start;
  assert.equal(app.ready, true, h.errors.map(e=>e.map(String).join(' ')).join('\n')); assert.equal(app.gameLogin.player.id, '101');
  assert.equal(h.calls.loginCodes, 1);assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  assert.deepEqual(h.errors, []);
  app.onDestroy();
});

test('WeChat login failure stays on the startup cover and a tap retries with a new code', async () => {
  let requests = 0;
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true, loginRequest: options => {
    options.success(++requests === 1 ? { statusCode: 401, data: { code: 'WECHAT_CODE_INVALID' } }
      : { statusCode: 200, data: bootstrapLoginResponse() });
  } });
  const app = h.create(), start = app.start();
  await new Promise(setImmediate);
  assert.equal(app.session, undefined); assert.ok(app.cancelOfflineRetry);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END);
  await start;
  assert.equal(app.ready, true); assert.equal(h.calls.loginCodes, 2); assert.equal(requests, 2);
  assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.hudAssets,1);
  const timeline=h.context.__forestGunnerLoading.snapshot().startup.timeline;
  assert.equal(timeline.phases.login.attempts,2);assert.equal(timeline.phases.login.failed,1);assert.equal(timeline.phases.login.succeeded,1);
  assert.deepEqual(h.errors, []); app.onDestroy();
});

test('an early fixed-resource rejection stays observed while login retries and cannot replace the login error', async () => {
  const feedback=deferred(),requests=[],unhandled=[];
  const onUnhandled=error=>unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);
  const h=bootstrapHarness({wechat:true,manualStartup:true,feedbackWait:feedback.promise,loginRequest:options=>requests.push(options)});
  const app=h.create(),started=app.start();
  try {
    await new Promise(setImmediate);assert.equal(requests.length,1);
    requests[0].fail({});await new Promise(setImmediate);
    assert.ok(app.cancelOfflineRetry);assert.equal(app.session,undefined);
    const label=app.loading.getComponent(h.cc.Label),retryMessage=label.string;
    assert.match(retryMessage,/连接失败.*\n点击这里重试/);
    feedback.reject(new Error('early feedback failure'));await new Promise(setImmediate);
    h.calls.art.onAssetLoaded(20);app.update(1/60);
    assert.equal(label.string,retryMessage);assert.deepEqual(unhandled,[]);
    assert.equal(h.calls.maps,0);assert.equal(h.calls.worlds,0);assert.equal(app.startupEntryReady,false);
    app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END);await new Promise(setImmediate);
    assert.equal(requests.length,2);assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);
    requests[1].success({statusCode:200,data:bootstrapLoginResponse()});await started;
    assert.equal(app.ready,false);assert.equal(h.calls.worlds,0);assert.deepEqual(unhandled,[]);
    assert.match(label.string,/资源加载失败：战斗反馈/);assert.match(label.string,/early feedback failure/);
    assert.equal(h.errors.length,1);
  } finally {app.onDestroy();await started;process.off('unhandledRejection',onUnhandled);}
});

test('fixed assets completing during hidden startup do not redraw progress or publish the world', async () => {
  const feedback=deferred(),money=deferred();let now=0;
  const h=bootstrapHarness({manualStartup:true,feedbackWait:feedback.promise,moneyWait:money.promise});
  h.context.Date={now:()=>now};
  const app=h.create(),started=app.start();await new Promise(setImmediate);
  const label=app.loading.getComponent(h.cc.Label),screen=app.startupScreen;
  assert.equal(app.startupEntryReady,true);assert.equal(app.preparationReady,false);
  let progressUpdates=0;const setProgress=screen.setProgress.bind(screen);
  screen.setProgress=value=>{progressUpdates++;setProgress(value);};
  app.onHide();const message=label.string,writes=label.writes;
  feedback.resolve({});await new Promise(setImmediate);
  h.calls.art.onAssetLoaded(23);now=3000;app.update(0);
  assert.equal(label.string,message);assert.equal(label.writes,writes);assert.equal(progressUpdates,0);
  assert.equal(h.calls.worlds,0);assert.equal(app.ready,false);
  app.onShow();app.update(0);
  assert.match(label.string,/等待：伤害数字/);assert.match(label.string,/资源已完成 23 项/);assert.ok(progressUpdates>0);
  app.onDestroy();money.resolve({});await started;assert.deepEqual(h.errors,[]);
});

test('teardown during login observes late fixed-resource success and failure without starting account-dependent work', async () => {
  for(const fail of [false,true]){
    const assets=deferred();let login;
    const h=bootstrapHarness({wechat:true,manualStartup:true,artWait:assets.promise,loginRequest:options=>{login=options;}});
    const app=h.create(),started=app.start();await new Promise(setImmediate);
    assert.ok(login);assert.equal(h.calls.artLoads,1);assert.equal(app.session,undefined);assert.equal(h.calls.maps,0);
    app.onDestroy();if(fail)assets.reject(new Error('late prewarm failure'));else assets.resolve();
    await started;await new Promise(setImmediate);
    assert.equal(h.calls.maps,0);assert.equal(h.calls.worlds,0);assert.equal(app.ready,false);
    assert.equal(h.cc.game.listeners.length,0);assert.equal(h.context.__forestGunnerLoading,undefined);assert.deepEqual(h.errors,[]);
  }
});

test('reserved distribution builds stop before local gameplay when their login SDK is not integrated', async () => {
  for (const options of [{ douyin: true }, { platformConfig: { channel: 'taptap-mini' } },
    { native: true, platformConfig: { channel: 'taptap-android' } }, { native: true },
    { wechat: true, platformConfig: { channel: 'web' } }]) {
    const h = bootstrapHarness(options), app = h.create(); await app.start();
    assert.notEqual(app.ready, true); assert.equal(app.session, undefined); assert.equal(h.calls.worlds, 0);
    assert.equal(h.calls.loginCodes, undefined); assert.ok(h.errors.length); app.onDestroy();
  }
});

async function reachStartupPreparation(app) {
  for(let i=0;i<60&&!app.preparationReady&&!app.disposed;i++)await new Promise(setImmediate);
  assert.equal(app.preparationReady,true,'core dependencies permit the real update queue before gameplay readiness');
}

test('startup automatically enters once every unlocked view is ready and all main panels open immediately',async()=>{
  let now=0;const h=bootstrapHarness({manualStartup:true,environment:'test'});h.context.Date={now:()=>now};const app=h.create();
  const started=app.start();await reachStartupPreparation(app);assert.equal(app.ready,false);
  assert.ok(app.startupInputBlock.getComponent(h.cc.BlockInputEvents));
  assert.equal(app.startupInputBlock.getSiblingIndex(),app.node.children.length-1,'the loading shield stays above prepared entry buttons');
  assert.equal(app.loading.parent,app.startupInputBlock,'loading text is rendered above its opaque cover');
  assert.equal(app.startupInputBlock.getChildByName('StartGameButton'),undefined,'loading offers no extra start gesture');
  const world=app.world,originalBind=app.bindPreparedHud.bind(app);let bindings=0,weapons;
  app.bindPreparedHud=(name,hud)=>{assert.equal(app.resourceLoadingSnapshot().uiReady[name],false,'published readiness waits for binding');bindings++;if(name==='weapons')weapons=hud;originalBind(name,hud);};
  const getContent=app.session.getContentState.bind(app.session);
  app.session.getContentState=name=>({...getContent(name),unlocked:true,visible:true});
  const required=Array.from(app.startupModules);
  assert.deepEqual(required,Array.from(backgroundManifest.RESOURCE_MODULE_ORDER).filter(name=>name!=='offline'));
  const admissions=[],prepare=app.resourceModules.prepare.bind(app.resourceModules);
  app.resourceModules.prepare=(name,options)=>{if(!options?.foreground){assert.equal(admissions.every(prior=>app.resourceModules.isViewReady(prior)),true);admissions.push(name);}return prepare(name,options);};
  let overlap=false;
  for(let frame=0;frame<2200&&!app.ready;frame++){
    assert.equal(app.world.simulationTime,0,'preparing required views never advances combat');
    if(!required.every(name=>app.resourceModules.isViewReady(name)))assert.equal(app.ready,false);
    now++;app.update(1/60);await new Promise(setImmediate);
    if(!app.resourceModules.isViewReady('weapons')&&h.calls.backgroundConfigs.includes('art/speedrun-system/config'))overlap=true;
  }
  assert.equal(app.ready,true,'the final required view automatically releases startup');
  assert.notEqual(app.startupResourcesReadyAt,undefined);await started;
  assert.equal(app.ready,true);assert.equal(app.world,world);assert.equal(app.weaponsHud,weapons);
  assert.equal(h.calls.worlds,1);assert.equal(h.calls.weaponAssets,1);
  const startup=app.resourceLoadingSnapshot().startup;
  assert.equal(startup.entryMode,'automatic');assert.notEqual(startup.dataReadyMs,null);assert.notEqual(startup.total.dataReadyMs,null);
  for(const field of ['startPageMs','startRequestedMs','remainingWaitMs'])assert.equal(startup[field],null,field);
  assert.equal(startup.startRequested,false);assert.equal(startup.waitingForStart,false);
  assert.equal(startup.total.startPageMs,null);assert.equal(startup.total.startRequestedMs,null);
  for(const name of app.startupModules)assert.equal(app.resourceModules.isViewReady(name),true,name);
  assert.ok(app.dailyCheckEntry);assert.equal(h.calls.dailyCheckEntryAssets,0,'startup reuses the full panel entry assets');
  assert.deepEqual(admissions,required);assert.equal(overlap,true,'next panel resources start before the current view is ready');
  const allowedConfigs=new Set(backgroundManifest.backgroundConfigs().filter(item=>required.includes(item.group)).map(item=>item.path));
  assert.ok(h.calls.backgroundConfigs.every(config=>allowedConfigs.has(config)),'only required panels are prefetched');
  assert.ok(app.fishHud);assert.ok(app.petHud);assert.ok(app.settingsHud);assert.equal(app.fishHud.isOpen,false);
  assert.ok(app.resourceLoadingSnapshot().trace.events.some(event=>event.phase==='initialBinding'));
  assert.ok(bindings>=app.startupModules.length);assert.equal(app.startupInputBlock,undefined);
  assert.equal(app.weaponsHud.collectionReady,undefined,'heavy collection is excluded from the initial barrier');
  const opened=app.openFeature('weapons');assert.equal(app.weaponsHud.isOpen,true,'prepared panel opens in the input event');await opened;
  app.onDestroy();
});

test('automatic startup waits for slow core and required panels, stays blocked while hidden and enters once after resume',async()=>{
  const core=deferred(),panel=deferred();
  const h=bootstrapHarness({manualStartup:true,artWait:core.promise,settingsLoad:()=>panel.promise});
  const app=h.create(),started=app.start();
  for(let frame=0;frame<80&&!app.startupEntryReady;frame++)await new Promise(setImmediate);
  assert.equal(app.startupEntryReady,true);assert.equal(app.preparationReady,false);assert.equal(h.calls.worlds,0);
  const cover=app.startupInputBlock;
  assert.equal(cover.getChildByName('StartGameButton'),undefined);
  for(const [width,height] of [[720,1280],[360,800],[428,951]]){
    app.resizeStartupScreen(width,height);
    assert.equal(cover.getChildByName('StartGameButton'),undefined);
    assert.deepEqual(cover.getComponent(h.cc.UITransform).contentSize,{width,height});
  }
  cover.emit(h.cc.Node.EventType.TOUCH_END,{});cover.emit(h.cc.Node.EventType.TOUCH_END,{});
  assert.equal(app.ready,false);assert.equal(h.calls.worlds,0,'touches cannot bypass slow core resources');
  const session=app.session;core.resolve();await reachStartupPreparation(app);
  for(let frame=0;frame<30;frame++){app.update(1/60);await new Promise(setImmediate);}
  assert.equal(h.calls.settingsAssets,1);assert.equal(app.ready,false);assert.equal(app.resourceModules.isViewReady('settings'),false);
  app.onHide();panel.resolve({});await new Promise(setImmediate);app.update(0);
  assert.equal(app.ready,false,'completion while hidden cannot automatically enter the game');
  app.onShow();
  for(let frame=0;frame<200&&!app.ready;frame++){app.update(1/60);await new Promise(setImmediate);}
  await started;assert.equal(app.ready,true);assert.equal(app.session,session);
  assert.equal(h.calls.worlds,1);assert.equal(h.calls.settingsAssets,1);assert.equal(app.resourceModules.isViewReady('settings'),true);
  assert.equal(cover.isValid,false);assert.equal(app.startupInputBlock,undefined);
  app.onDestroy();
});

test('startup covers the world from the first asset wait through panel preparation, resize and resume',async()=>{
  const assets=deferred(),panel=deferred(),h=bootstrapHarness({manualStartup:true,contentOverrides:{thresholds:{challengePowerLevel:0}},artWait:assets.promise,weaponLoad:()=>panel.promise});
  const app=h.create(),started=app.start(),cover=app.startupInputBlock,loading=app.loading;
  const background=cover.getComponent(h.cc.Graphics);
  assert.deepEqual(background.fillColor.rgba,[245,240,223,255],'the cover is fully opaque before any asset arrives');
  assert.deepEqual(background.bounds,[-360,-640,720,1280]);assert.equal(background.fills,1);
  assert.equal(loading.parent,cover);assert.ok(cover.getComponent(h.cc.BlockInputEvents));
  assets.resolve();await reachStartupPreparation(app);app.update(0);await Promise.resolve();
  assert.ok(app.battlefield);assert.equal(app.ready,false);assert.equal(app.startupInputBlock,cover);
  assert.equal(cover.getSiblingIndex(),app.node.children.length-1);
  const worldTime=app.world.simulationTime;
  app.onHide();app.node.getComponent(h.cc.UITransform).setContentSize(360,800);app.onShow();app.update(0);
  assert.deepEqual(background.bounds,[-180,-400,360,800]);
  assert.deepEqual(cover.getComponent(h.cc.UITransform).contentSize,{width:360,height:800});
  assert.deepEqual(loading.getComponent(h.cc.UITransform).contentSize,{width:296,height:340});
  assert.equal(app.world.simulationTime,worldTime);assert.equal(cover.isValid,true);
  app.node.getComponent(h.cc.UITransform).setContentSize(428,951);app.update(0);
  assert.deepEqual(background.bounds,[-214,-475.5,428,951],'startup catches Canvas sizes applied after the resize event');
  assert.deepEqual(loading.getComponent(h.cc.UITransform).contentSize,{width:364,height:340});
  panel.resolve({});
  for(let frame=0;frame<250&&!app.ready;frame++){app.update(1/60);await new Promise(setImmediate);}
  await started;assert.equal(app.ready,true);assert.equal(cover.isValid,false);assert.equal(loading.isValid,false);
  assert.equal(app.startupInputBlock,undefined);assert.equal(app.loading,undefined);app.onDestroy();
});

test('required panel downloads start during core wait without decoding panels or admitting locked resources',async()=>{
  const core=deferred(),h=bootstrapHarness({manualStartup:true,artWait:core.promise});
  const app=h.create(),started=app.start();
  for(let frame=0;frame<100&&!app.resourcePreloader;frame++)await new Promise(setImmediate);
  assert.ok(app.resourcePreloader);assert.equal(app.preparationReady,false);
  assert.deepEqual(Array.from(app.startupModules),['settings']);
  for(let frame=0;frame<30;frame++){app.update(1/60);await new Promise(setImmediate);}
  assert.ok(h.calls.backgroundConfigs.includes('art/settings-system/config'));
  assert.ok(h.calls.backgroundConfigs.every(path=>path==='art/settings-system/config'));
  assert.equal(h.calls.weaponAssets,0);assert.equal(h.calls.settingsAssets,0);
  app.onHide();const count=h.calls.backgroundConfigs.length;app.update(1/60);await new Promise(setImmediate);
  assert.equal(h.calls.backgroundConfigs.length,count);app.onShow();core.resolve();
  await reachStartupPreparation(app);
  for(let frame=0;frame<200&&!app.ready;frame++){app.update(1/60);await new Promise(setImmediate);}
  await started;assert.equal(app.ready,true);assert.equal(app.resourceModules.isViewReady('settings'),true);app.onDestroy();
});

test('expired startup targets keep waiting for equipment and challenge, including hide/resume and repeated clicks',async()=>{
  for(const returning of [false,true]){
    let now=0;const pending=deferred(),h=bootstrapHarness({manualStartup:true,contentOverrides:{thresholds:{challengePowerLevel:0}},weaponLoad:()=>pending.promise});h.context.Date={now:()=>now};
    if(returning)h.cc.sys.localStorage.setItem('forest-gunner-production-returning-player-v1','1');
    const app=h.create(),started=app.start();await reachStartupPreparation(app);
    const preparing=app.loadDeferredHud('weapons',true);await Promise.resolve();assert.equal(h.calls.weaponAssets,1);
    now=returning?3000:10000;app.onHide();app.update(0);assert.equal(app.ready,false);
    app.onShow();app.update(0);assert.equal(app.ready,false);assert.equal(app.weaponsHud,undefined);
    assert.equal(app.startupBudgetMs,returning?3000:10000);assert.equal(app.resourceModules.snapshot().weapons.persistence,'unknown');
    app.session.contentProgress.weaponsUnlocked=true;await app.openFeature('weapons');assert.equal(app.openingFeature,undefined);
    assert.equal(h.calls.weaponAssets,1);pending.resolve({});
    for(let frame=0;frame<200&&!app.ready;frame++){now+=16;app.update(1/60);await new Promise(setImmediate);}
    assert.equal(app.ready,true);await Promise.all([started,preparing]);
    assert.equal(app.resourceModules.isViewReady('speedrun'),true);await app.openFeature('weapons');
    assert.equal(app.weaponsHud.isOpen,true);assert.equal(h.calls.weaponAssets,1);app.onDestroy();
  }
});


test('locked weapons and challenge skip cold/return startup and prepare in order during gameplay',async()=>{
  for(const returning of [false,true])for(const partial of [false,true]){
    const h=bootstrapHarness({manualStartup:true,contentOverrides:partial?{tutorialEnabled:false,thresholds:{fishStage:1,fishVisibleStage:1}}:undefined});
    let now=0;h.context.Date={now:()=>now};
    if(returning)h.cc.sys.localStorage.setItem('forest-gunner-production-returning-player-v1','1');
    const app=h.create(),started=app.start();await reachStartupPreparation(app);
    assert.deepEqual(Array.from(app.startupModules),['settings',...(partial?['fish']:[])]);
    assert.equal(app.session.getContentState('speedrun').unlocked,false);
    for(let frame=0;frame<250&&!app.ready;frame++){now+=16;app.update(1/60);await new Promise(setImmediate);}
    await started;assert.equal(app.ready,true);
    assert.equal(app.startupInputBlock,undefined);assert.equal(h.calls.weaponAssets,0);assert.equal(h.calls.speedRunAssets,0);
    assert.ok(h.calls.backgroundConfigs.every(config=>!/art\/(weapon-system|speedrun-system)\/config|art\/feature-entries\/(weapons|speedrun)/.test(config)));
    for(const name of app.startupModules)assert.equal(app.resourceModules.isViewReady(name),true,name);
    const prepared=[],publish=app.publishPreparedHud.bind(app);
    app.publishPreparedHud=(name,hud)=>{prepared.push(name);publish(name,hud);};
    for(let frame=0;frame<3600&&!app.resourceModules.isViewReady('speedrun');frame++){now+=1000/60;app.update(1/60);await new Promise(setImmediate);}
    assert.deepEqual(prepared.slice(0,2),['weapons','speedrun']);
    assert.equal(app.resourceModules.isViewReady('weapons'),true);assert.equal(app.resourceModules.isViewReady('speedrun'),true);
    assert.ok(app.world.simulationTime>0,'background preparation allows gameplay to progress');
    assert.equal(app.weaponsHud.isOpen,false);assert.equal(app.speedRunHud.isOpen,false);
    assert.equal(app.session.getContentState('weapons').unlocked,false);
    assert.equal(app.resourceModules.isViewReady('raid'),false);assert.equal(app.session.getContentState('speedrun').unlocked,false);
    await app.openFeature('speedrun');assert.equal(app.speedRunHud.isOpen,false,'preparation cannot bypass the unlock gate');
    const weapons=app.weaponsHud,challenge=app.speedRunHud;app.onMemoryWarning();
    assert.equal(app.weaponsHud,weapons);assert.equal(app.speedRunHud,challenge);assert.equal(app.resourceModules.isViewReady('speedrun'),true);
    app.onDestroy();
  }
});

test('startup finite retries stay blocked, then shield retry reuses completed views and the session',async()=>{
  let now=0,fail=true,attempts=0;
  const h=bootstrapHarness({manualStartup:true,contentOverrides:{thresholds:{challengePowerLevel:0}},speedRunLoad:()=>{attempts++;return fail?Promise.reject(Error('challenge unavailable')):Promise.resolve({});}});
  h.context.Date={now:()=>now};const app=h.create(),started=app.start();await reachStartupPreparation(app);
  const session=app.session,world=app.world;
  for(let frame=0;frame<250&&!app.startupFailure;frame++){now+=100;app.update(1/60);await new Promise(setImmediate);}
  assert.equal(attempts,4,'one speculative attempt plus three ordinary startup attempts');assert.equal(app.ready,false);assert.ok(app.loading);assert.equal(app.resourceModules.isViewReady('weapons'),true);
  assert.equal(h.context.__forestGunnerLoading.snapshot().startup.waitingModule,'speedrun');
  assert.match(app.loading.getComponent(h.cc.Label).string,/挑战.*准备失败/);
  assert.equal(app.startupInputBlock.getComponent(h.cc.Graphics).fillColor.rgba[3],255);
  assert.equal(app.loading.parent,app.startupInputBlock);
  const weapons=app.weaponsHud;now+=70000;app.update(0);await new Promise(setImmediate);assert.equal(attempts,4);
  fail=false;app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END);app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END);
  for(let frame=0;frame<250&&!app.ready;frame++){now+=16;app.update(1/60);await new Promise(setImmediate);}
  await started;assert.equal(app.ready,true);assert.equal(attempts,5);assert.equal(h.calls.weaponAssets,1);
  assert.equal(app.weaponsHud,weapons);assert.equal(app.session,session);assert.equal(app.world,world);assert.equal(h.calls.worlds,1);
  app.onDestroy();
});

test('destroying a pending startup cannot publish stale panels or restart its queue',async()=>{
  const pending=deferred(),h=bootstrapHarness({manualStartup:true,contentOverrides:{thresholds:{challengePowerLevel:0}},weaponLoad:()=>pending.promise}),app=h.create(),started=app.start();
  await reachStartupPreparation(app);app.update(0);await Promise.resolve();assert.equal(h.calls.weaponAssets,1);
  app.onDestroy();pending.resolve({});await started;await new Promise(setImmediate);
  assert.equal(app.ready,false);assert.equal(app.weaponsHud,undefined);assert.equal(app.speedRunHud,undefined);assert.equal(h.calls.speedRunAssets,0);
  assert.equal(h.errors.length,0);
});

test('adventure deferred open joins one request, cancels stale opening on hide, and excludes other panels',async()=>{
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,environment:'test',adventureLoad:()=>pending.promise}),app=h.create();
  await app.start();
  const first=app.openFeature('adventure'),second=app.openFeature('adventure');
  await Promise.resolve();assert.equal(h.calls.adventureAssets,1);
  app.onHide();pending.resolve({});await new Promise(setImmediate);
  assert.equal(app.adventureHud,undefined,'a background completion cannot build the view');
  app.onShow();await drainPreparation(app,Promise.all([first,second]));
  assert.equal(app.adventureHud.isOpen,false,'the cancelled click cannot reopen after resume');
  await drainPreparation(app,app.openFeature('adventure'));
  assert.equal(app.adventureHud.isOpen,true);assert.equal(h.calls.adventureCreated,1);
  assert.equal(app.purchaseUpgrade('power'),false,'travel popup blocks battle upgrades');
  await drainPreparation(app,app.openFeature('fish'));
  assert.equal(app.fishHud.isOpen,true);assert.equal(app.adventureHud.isOpen,false);
  await drainPreparation(app,app.openFeature('adventure'));
  assert.equal(app.adventureHud.isOpen,true);assert.equal(app.fishHud.isOpen,false);
  const hud=app.adventureHud;app.onHide();app.update(10);
  assert.equal(hud.updates.at(-1),0,'travel animations do not advance in the background');
  app.onDestroy();assert.equal(h.calls.adventureDestroyed,1);
});

test('adventure memory eviction retains active view and reloads a closed view without changing travel state',async()=>{
  const h=bootstrapHarness({deferHiddenHuds:true,environment:'test'}),app=h.create();await app.start();
  await drainPreparation(app,app.openFeature('adventure'));
  const hud=app.adventureHud,before=JSON.stringify(app.session.getAdventureState());
  app.onMemoryWarning();assert.equal(app.adventureHud,hud);assert.equal(hud.isOpen,true);
  hud.close();app.onMemoryWarning();assert.equal(app.adventureHud,undefined);assert.equal(h.calls.adventureDestroyed,1);
  app.memoryPressureUntil=0;await drainPreparation(app,app.openFeature('adventure'));
  assert.equal(app.adventureHud.isOpen,true);assert.equal(h.calls.adventureCreated,2);
  assert.equal(JSON.stringify(app.session.getAdventureState()),before);
  app.onDestroy();
});

test('memory pressure preserves the active view and shared art, suppresses evicted views, and reloads on explicit open',async()=>{
  const h=bootstrapHarness({deferHiddenHuds:true,environment:'test'}),app=h.create();await app.start();
  await drainPreparation(app,app.loadDeferredHud('skins'));await drainPreparation(app,app.loadDeferredHud('rebirth'));
  await Promise.all([...app.entryRequests.values(),app.dailyCheckEntryRequest]);
  await drainPreparation(app,app.openSettings());const settings=app.settingsHud;
  app.moduleAssetPaths.set('skins',new Set(['shared','skin-only','current-battle']));app.moduleAssetPaths.set('rebirth',new Set(['rebirth-only']));
  app.battleAssets.residentPaths=()=>['current-battle'];
  app.coreResourcePaths.add('shared');for(const path of ['shared','skin-only','rebirth-only','current-battle'])app.artLibrary.frames.set(path,{});
  const before=h.calls.skinAssets;app.onMemoryWarning();
  assert.equal(app.settingsHud,settings);assert.equal(settings.isOpen,true);assert.equal(app.skinHud,undefined);assert.equal(app.rebirthHud,undefined);
  assert.equal(app.artLibrary.frames.has('shared'),true);assert.equal(app.artLibrary.frames.has('skin-only'),false);
  assert.equal(app.artLibrary.frames.has('current-battle'),true,'a texture shared with current encounter particles stays resident');
  assert.equal(app.artLibrary.frames.has('rebirth-only'),false);settings.close();app.memoryPressureUntil=0;
  app.resourcePreloader.isFeatureReady=()=>true;
  await preparationFrames(app,100);assert.equal(h.calls.skinAssets,before);assert.equal(app.shouldPrepareModule('skins'),false);
  await drainPreparation(app,app.openFeature('skins'));assert.equal(app.skinHud.isOpen,true);assert.equal(h.calls.skinAssets,before+1);
  assert.equal(app.shouldPrepareModule('skins'),true);app.onDestroy();
});

test('memory pressure retains entry textures and conservatively protects partially loaded owners',async()=>{
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,environment:'test',fishLoad:()=>pending.promise}),app=h.create();await app.start();
  await drainPreparation(app,app.loadDeferredHud('skins'));await Promise.all([...app.entryRequests.values(),app.dailyCheckEntryRequest]);
  app.retainEntryResources({images:{icon:{path:'art/shared-entry',sizePx:[1,1]}}},'skins');
  app.moduleAssetPaths.set('skins',new Set(['art/shared-entry','art/pending-shared','art/later-unused']));
  for(const path of ['art/shared-entry','art/pending-shared','art/later-unused'])app.artLibrary.frames.set(path,{});
  const preparing=app.loadDeferredHud('fish',true);await Promise.resolve();
  app.onMemoryWarning();assert.equal(app.skinHud,undefined);
  assert.equal(app.artLibrary.frames.has('art/shared-entry'),true);assert.equal(app.artLibrary.frames.has('art/pending-shared'),true);
  assert.ok(app.pendingFrameEvictions.size>0);
  pending.resolve({});await drainPreparation(app,preparing);
  app.moduleAssetPaths.set('fish',new Set(['art/pending-shared']));app.update(0);
  assert.equal(app.artLibrary.frames.has('art/shared-entry'),true);assert.equal(app.artLibrary.frames.has('art/pending-shared'),true);
  assert.equal(app.artLibrary.frames.has('art/later-unused'),false);assert.equal(app.pendingFrameEvictions.size,0);
  const snapshot=app.resourceLoadingSnapshot().modules.fish;
  assert.equal(snapshot.assetReady,true);assert.equal(snapshot.resourcesAcquired,true);assert.equal(snapshot.decodedReady,true);assert.equal(snapshot.viewReady,true);
  app.pendingFrameEvictions.add('pending-after');app.onDestroy();assert.equal(app.pendingFrameEvictions.size,0);
});

test('Bootstrap rejects a screenshot-sized corrupt bottom inset for every HUD, new entry and delayed panel', async () => {
  const h = bootstrapHarness({ deferHiddenHuds: true }), app = h.create();
  app.node.getComponent(h.cc.UITransform).setContentSize(720, 1620);
  h.cc.sys.getSafeAreaRect = () => ({ x: 0, y: 436, width: 720, height: 1184 });
  await app.start(); assert.equal(app.ready, true);
  app.session.contentProgress.weaponsUnlocked = true; app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  const entry = app.featureEntries.get('weapons');
  assert.ok(entry, 'a late-created feature entry uses the same validated boundary');
  assert.deepEqual(entry.extent, [720, 1620, 0, 0]);
  const captured = captureBootstrapSafeAreaLayouts(app);
  try {
    app.resize();
    assert.equal(captured.calls.size, 15);
    for (const [name, args] of captured.calls) assert.deepEqual(args, [720, 1620, 0, 0], name);
    assert.deepEqual(entry.extent, [720, 1620, 0, 0]);
  } finally { captured.restore(); }
  for (const sliced of [false, true]) {
    const pending = deferred(), layouts = [], node = new h.cc.Node('DeferredSafeArea'); app.hudRoot.addChild(node);
    const panel = { node, prepared: pending.promise, resize: (...args) => layouts.push(args), destroy: () => node.destroy() };
    if (sliced) panel.resizePrepared = async (_prepare, ...args) => layouts.push(args);
    const preparing = app.prepareFeatureHud('safe-area-regression', () => panel);
    assert.deepEqual(layouts, [], 'layout waits for the panel resources');
    pending.resolve(); assert.equal(await drainPreparation(app, preparing), panel);
    assert.deepEqual(layouts, [[720, 1620, 0, 0]], sliced ? 'sliced preparation' : 'synchronous preparation');
    panel.destroy();
  }
  assert.deepEqual(h.errors, []); app.onDestroy();
});

test('Bootstrap prefers current WeChat window metrics and applies logical pixels exactly once', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }), app = h.create();
  app.node.getComponent(h.cc.UITransform).setContentSize(720, 1620);
  let windowReads = 0;
  h.context.wx = {
    getWindowInfo() { windowReads++; return { windowWidth: 360, windowHeight: 810, pixelRatio: 3,
      screenTop: 0, statusBarHeight: 24, safeArea: { top: 24, bottom: 790, left: 0, right: 360, width: 360, height: 766 } }; },
    getSystemInfoSync() { assert.fail('valid current window data must take priority over the legacy API'); },
  };
  h.cc.sys.getSafeAreaRect = () => assert.fail('valid host data must bypass the corrupt engine safe rectangle');
  await app.start(); assert.equal(app.ready, true); assert.ok(windowReads > 0);
  app.session.contentProgress.weaponsUnlocked = true; app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  assert.deepEqual(app.featureEntries.get('weapons').extent, [720, 1620, 48, 40]);
  const captured = captureBootstrapSafeAreaLayouts(app);
  try {
    app.resize();
    for (const [name, args] of captured.calls) assert.deepEqual(args, [720, 1620, 48, 40], name);
  } finally { captured.restore(); }
  assert.deepEqual(h.errors, []); app.onDestroy();
});

test('Bootstrap refreshes all safe-area layouts on foreground return even without a Canvas resize', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }), app = h.create();
  let safe = { top: 0, bottom: 640, left: 0, right: 360, width: 360, height: 640 };
  h.context.wx = { getWindowInfo: () => ({ windowWidth: 360, windowHeight: 640, pixelRatio: 2, screenTop: 0, safeArea: safe }) };
  await app.start(); app.session.contentProgress.weaponsUnlocked = true; app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  const entry = app.featureEntries.get('weapons'); assert.deepEqual(entry.extent, [720, 1280, 0, 0]);
  app.onHide();
  safe = { top: 22, bottom: 623, left: 0, right: 360, width: 360, height: 601 };
  const captured = captureBootstrapSafeAreaLayouts(app), size = { ...app.canvasTransform.contentSize };
  try {
    app.onShow();
    assert.deepEqual(app.canvasTransform.contentSize, size, 'the Canvas dimensions did not change');
    assert.equal(captured.calls.size, 15, 'a safe-area-only change reaches every HUD');
    for (const [name, args] of captured.calls) assert.deepEqual(args, [720, 1280, 44, 34], name);
    assert.deepEqual(entry.extent, [720, 1280, 44, 34]);
  } finally { captured.restore(); }
  assert.deepEqual(h.errors, []); app.onDestroy();
});

test('Bootstrap retains current HUD layout when foreground window and safe bounds are unchanged', async () => {
  const h = bootstrapHarness({ wechat: true, deferHiddenHuds: true }), app = h.create();
  let windowReads = 0;
  h.context.wx = { getWindowInfo: () => {
    windowReads++;
    return { windowWidth: 360, windowHeight: 640, pixelRatio: 3, screenTop: 0,
      safeArea: { top: 22, bottom: 623, left: 0, right: 360, width: 360, height: 601 } };
  } };
  await app.start(); app.session.contentProgress.weaponsUnlocked = true; app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  const entry = app.featureEntries.get('weapons'); assert.deepEqual(entry.extent, [720, 1280, 44, 34]);
  app.onHide();
  const captured = captureBootstrapSafeAreaLayouts(app), readsBeforeShow = windowReads;
  const resizeEntry = entry.resize; let entryResizes = 0;
  entry.resize = () => { entryResizes++; };
  try {
    app.onShow();
    assert.ok(windowReads > readsBeforeShow, 'foreground return still reads current safe bounds');
    assert.equal(captured.calls.size, 0, 'unchanged bounds must not reset any HUD scroll or layout state');
    assert.equal(entryResizes, 0, 'unchanged bounds do not relayout lightweight entries');
  } finally { captured.restore(); entry.resize = resizeEntry; }
  assert.deepEqual(h.errors, []); app.onDestroy();
});

test('Bootstrap disposed during the initial asset await ignores both late success and failure', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({ artWait: pending.promise }), app = h.create();
    const started = app.start(), loading = app.loading;
    for (let i = 0; i < 12 && !h.calls.art; i++) await Promise.resolve();
    assert.ok(h.calls.art, 'dispose while the intended main asset promise is pending');
    const mapsBeforeDispose=h.calls.maps;
    app.onDestroy();
    if (fail) pending.reject(new Error('late load error')); else pending.resolve();
    await started;
    assert.equal(h.calls.worlds, 0); assert.equal(h.calls.maps, mapsBeforeDispose, 'late base art cannot start new map work after disposal');
    assert.equal(h.calls.feedback, 1, 'independent groups start alongside base art'); assert.equal(h.errors.length, 0);
    assert.equal(loading.isValid, false); assert.equal(h.cc.game.listeners.length, 0); assert.equal(h.cc.view.listeners.length, 0);
    assert.equal(app.ready, false);
  }
});

test('Bootstrap disposed during the second asset await never constructs views after completion', async () => {
  const pending = deferred(), h = bootstrapHarness({ feedbackWait: pending.promise }), app = h.create();
  const started = app.start(); await h.feedbackEntered;
  assert.equal(h.calls.feedback, 1); app.onDestroy(); pending.resolve({}); await started;
  assert.equal(h.calls.worlds, 0); assert.equal(h.errors.length, 0); assert.equal(app.battlefield, undefined);
});

test('Bootstrap disposal also guards the new money resource await and ignores its late failure', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({ moneyWait: pending.promise }), app = h.create();
    const started = app.start(); await h.feedbackEntered;
    assert.equal(h.calls.moneyNumbers, 1); assert.equal(h.calls.moneyBurst, 1); assert.equal(h.calls.hudAssets, 1);
    app.onDestroy();
    if (fail) pending.reject(new Error('late money resource error')); else pending.resolve({});
    await started;
    assert.equal(h.calls.worlds, 0); assert.equal(h.errors.length, 0);
    assert.equal(app.hud, undefined); assert.equal(app.hudRoot, undefined);
    assert.equal(h.cc.game.listeners.length, 0); assert.equal(h.cc.view.listeners.length, 0);
  }
});

test('deferred rebirth resources ignore teardown and clean partial construction without stopping battle', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({deferHiddenHuds:true,rebirthWait:pending.promise}), app=h.create();
    await app.start(); const request=app.loadDeferredHud('rebirth');await Promise.resolve();
    assert.equal(h.calls.rebirthAssets,1); app.onDestroy();
    if(fail)pending.reject(new Error('late resource error'));else pending.resolve({});
    await drainPreparation(app, request);assert.equal(h.calls.rebirthCreated,0);assert.equal(app.rebirthHud,undefined);assert.equal(h.errors.length,0);
  }
  const h=bootstrapHarness({deferHiddenHuds:true,failRebirthImage:true}),app=h.create();await app.start();
  await drainPreparation(app, app.loadDeferredHud('rebirth'));
  assert.equal(app.ready,true);assert.equal(app.rebirthHud,undefined);assert.equal(h.errors.length,1);
  const node=h.nodes.find(node=>node.name==='OriginalRebirthHud');assert.ok(node);assert.equal(node.isValid,false);
  assert.ok(app.battlefield.node.isValid);app.onDestroy();
});


test('Bootstrap startup resize failure releases partial views but retains a visible error message', async () => {
  const h = bootstrapHarness({ failResize: true }), app = h.create(); await app.start();
  assert.equal(h.errors.length, 1); assert.equal(h.calls.battlefieldDestroyed, 1); assert.equal(h.calls.colorsDestroyed, 1);
  assert.equal(app.ready, false); assert.equal(app.world.paused, true); assert.equal(app.world.provider, null);
  assert.ok(app.loading?.isValid, 'loading node must survive until resize succeeds');
  assert.match(app.loading.getComponent(h.cc.Label).string, /资源加载失败：创建战场\n.*resize failure\n点击这里重试/);
  assert.ok(app.startupInputBlock?.isValid,'the complete startup page survives cleanup after a core failure');
  assert.equal(app.loading.parent,app.startupInputBlock);
  app.startupInputBlock.emit(h.cc.Node.EventType.TOUCH_END);
  app.loading.emit(h.cc.Node.EventType.TOUCH_END);
  assert.deepEqual(h.cc.director.loads,['main'],'tapping the cover or text starts only one retry');
  app.onDestroy(); assert.equal(app.loading, undefined);
});

test('deferred skins resources ignore teardown and clean partial construction without stopping battle', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({deferHiddenHuds:true,skinWait:pending.promise}), app=h.create();
    await app.start(); const request=app.loadDeferredHud('skins');await Promise.resolve();
    assert.equal(h.calls.skinAssets,1); app.onDestroy();
    if(fail)pending.reject(new Error('late resource error'));else pending.resolve({});
    await drainPreparation(app, request);assert.equal(h.calls.skinCreated,0);assert.equal(app.skinHud,undefined);assert.equal(h.errors.length,0);
  }
  const h=bootstrapHarness({deferHiddenHuds:true,failSkinImage:true}),app=h.create();await app.start();
  await drainPreparation(app, app.loadDeferredHud('skins'));
  assert.equal(app.ready,true);assert.equal(app.skinHud,undefined);assert.equal(h.errors.length,1);
  const node=h.nodes.find(node=>node.name==='OriginalSkinHud');assert.ok(node);assert.equal(node.isValid,false);
  assert.ok(app.battlefield.node.isValid);app.onDestroy();
});


test('Skin popup blocks tutorial and upgrades, cancels background gestures and resumes without latent input', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  const skin = app.skinHud, tutorial = app.tutorialHud;
  assert.equal(app.battlefield.skinId, 0);
  skin.open(); app.update(0);
  assert.equal(tutorial.updates.at(-1).targets.blocked, true); assert.equal(tutorial.node.active, false);
  assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  for (const name of ['weaponsHud', 'rebirthHud', 'speedRunHud', 'raidHud', 'bossHud', 'skinHud']) assert.equal(app[name].entryBlocked, true, name);
  assert.equal(app.purchaseUpgrade('power'), false);
  skin.pressed = true; const cancellationCount = skin.cancellations || 0;
  app.onHide(); app.update(60);
  assert.equal(skin.pressed, false); assert.ok(skin.cancellations > cancellationCount);
  assert.equal(skin.updates.at(-1), 0);
  app.onShow(); app.update(0); skin.close(); app.update(0);
  assert.equal(tutorial.updates.at(-1).targets.blocked, false);
  assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  skin.pressed = true; app.togglePause(); assert.equal(skin.pressed, false);
  app.togglePause(); app.onDestroy();
  assert.equal(h.calls.skinDestroyed, 1); assert.equal(skin.node.isValid, false);
});

test('Bootstrap hides loaded skin and rebirth entries until tutorial completion and a challenge win', async () => {
  const h = bootstrapHarness({ realWorld: true }), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  const skin = app.skinHud;
  assert.equal(skin.callbacks.getContentState().reason, 'tutorial'); assert.equal(skin.entryVisible, false);
  skin.open(); assert.equal(skin.isOpen, false);
  assert.equal(skin.callbacks.purchase(1).reason, 'contentLocked');
  assert.equal(skin.callbacks.equip(0).reason, 'contentLocked');
  app.session.tutorial.complete(); app.update(0);
  assert.equal(skin.callbacks.getContentState().reason, 'challenge'); assert.equal(skin.entryVisible, false);
  assert.equal(app.rebirthHud.contentBlocked, true);
  skin.open(); assert.equal(skin.isOpen, false);
  app.session.speedRun.restore({ stage: 1 }); app.update(0);
  assert.equal(skin.callbacks.getContentState().unlocked, true); assert.equal(skin.entryVisible, true);
  assert.equal(app.rebirthHud.contentBlocked, false);
  skin.open(); assert.equal(skin.isOpen, true);
  app.onDestroy();
});

test('BGM downloads start after battle readiness and never delay the first playable frame', async () => {
  const feedback = deferred(), music = deferred();
  const h = bootstrapHarness({ deferHiddenHuds: true, feedbackWait: feedback.promise, bgmWait: music.promise }), app = h.create();
  const started = app.start(); await h.feedbackEntered;
  assert.equal(h.calls.bgmAssets, 0); assert.equal(app.ready, false);
  feedback.resolve({}); await started;
  assert.equal(app.ready, true); assert.equal(h.calls.bgmAssets, 1); assert.equal(h.calls.bgmCreated, 0);
  assert.equal(h.calls.settingsAssets, 0); assert.equal(app.loading, undefined);
  app.update(0); const time = app.world.simulationTime; app.update(.1);
  assert.ok(app.world.simulationTime > time, 'battle advances while audio is still downloading');
  music.resolve({}); await app.bgmRequest;
  assert.equal(h.calls.bgmCreated, 1); app.onDestroy();
});

test('BGM completion restores the latest mute, background and mode before playback', async () => {
  const pending = deferred(), h = bootstrapHarness({ bgmWait: pending.promise }), app = h.create(); await app.start();
  await drainPreparation(app, app.openSettings()); app.settingsHud.callbacks.toggleBgm();
  app.session.setMode('Mine'); app.onHide();
  pending.resolve({}); await app.bgmRequest;
  assert.deepEqual(app.bgm.setup, [['enabled', false], ['paused', true], ['mode', 'Mine']]);
  app.onShow(); assert.equal(app.bgm.paused, false); assert.equal(app.bgm.enabled, false);
  app.onDestroy();
});

test('Bootstrap discards late BGM success or failure after teardown or scene reload', async () => {
  for (const teardown of ['destroy', 'reload']) for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({ bgmWait: pending.promise }), app = h.create();
    await app.start(); const request = app.bgmRequest;
    assert.equal(app.ready, true); assert.equal(h.calls.bgmAssets, 1);
    if (teardown === 'destroy') app.onDestroy(); else assert.equal(app.restartForTutorial(() => true), true);
    if (fail) pending.reject(new Error('late audio load')); else pending.resolve({});
    await drainPreparation(app, request);
    assert.equal(h.errors.length, 0); assert.equal(h.calls.bgmCreated, 0); assert.equal(app.bgm, undefined);
    if (teardown === 'reload') app.onDestroy();
    assert.equal(h.cc.game.listeners.length, 0);
  }
});

test('failed BGM keeps battle playable and retries only when settings re-enable music', async () => {
  const first = deferred(), second = deferred(), waits = [first.promise, second.promise];
  const h = bootstrapHarness({ bgmLoad: () => waits.shift() }), app = h.create(); await app.start();
  first.reject(new Error('audio timeout')); await app.bgmRequest;
  assert.equal(app.ready, true); assert.equal(app.bgm, undefined); assert.equal(app.bgmRequest, undefined);
  assert.match(app.alerts.message, /背景音乐加载失败.*设置/);
  for (let i = 0; i < 20; i++) app.update(.1);
  assert.equal(h.calls.bgmAssets, 1, 'frames do not create unbounded retry traffic');
  await drainPreparation(app, app.openSettings()); const toggle = app.settingsHud.callbacks.toggleBgm;
  toggle(); assert.equal(h.calls.bgmAssets, 1);
  toggle(); const retried = app.bgmRequest; assert.equal(h.calls.bgmAssets, 2);
  toggle(); toggle(); assert.equal(app.bgmRequest, retried); assert.equal(h.calls.bgmAssets, 2);
  toggle(); second.resolve({}); await drainPreparation(app, retried);
  assert.equal(h.calls.bgmCreated, 1); assert.equal(app.bgm.enabled, false); assert.equal(app.ready, true);
  app.onDestroy();
});

test('lazy settings constructor failure leaves the battle alive and cleans only its partial nodes', async () => {
  const h = bootstrapHarness({ deferHiddenHuds:true,failSettingsImage: true }), app = h.create(); await app.start();
  assert.equal(h.calls.settingsCreated, 0); await drainPreparation(app, app.openSettings());
  assert.equal(h.errors.length, 1); assert.match(h.errors[0][1].message, /settings image failure/);
  assert.equal(app.ready, true); assert.equal(app.settingsHud, undefined); assert.ok(app.bgm);
  for (const name of ['OriginalSettingsHud', 'PartialSettingsImage']) {
    const node = h.nodes.find(candidate => candidate.name === name);
    assert.ok(node); assert.equal(node.isValid, false); assert.equal(node.destroyCalls, 1);
  }
  assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  assert.equal(h.calls.bgmDestroyed, 0); app.onDestroy(); assert.equal(h.calls.bgmDestroyed, 1);
});

test('first settings click shares one deferred load, provides feedback, and does not pause battle time', async () => {
  const pending = deferred(), h = bootstrapHarness({ deferHiddenHuds:true,settingsWait: pending.promise }), app = h.create();
  await app.start(); app.update(0);
  assert.equal(app.ready, true); assert.equal(h.calls.settingsAssets, 0);
  assert.equal(h.context.__forestGunner.snapshot().settingsPopup, false);
  const opened = app.hud.onSettings(), duplicate = app.hud.onSettings();await Promise.resolve();
  assert.equal(h.calls.settingsAssets, 1); assert.equal(h.calls.settingsCreated, 0);
  assert.equal(app.settingsOpening, true); assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  assert.equal(app.settingsLoading, undefined, 'fast cache hits do not flash a loading label');
  h.context.Date = { now: () => app.settingsNoticeAt - 1 }; app.update(0);
  assert.equal(app.settingsLoading, undefined);
  h.context.Date = { now: () => app.settingsNoticeAt }; app.update(0);
  const notice = app.settingsLoading;
  assert.match(notice.getComponent(h.cc.Label).string, /正在加载设置资源/);
  assert.equal(app.purchaseUpgrade('power'), false);
  const time = app.world.simulationTime; app.update(.1);
  assert.ok(app.world.simulationTime > time);
  pending.resolve({}); await drainPreparation(app, opened); await duplicate;
  assert.equal(h.calls.settingsCreated, 1); assert.equal(app.settingsHud.isOpen, true);
  assert.equal(app.settingsOpening, false); assert.equal(notice.isValid, false);
  assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  app.settingsHud.close(); await drainPreparation(app, app.openSettings());
  assert.equal(h.calls.settingsAssets, 1); assert.equal(h.calls.settingsCreated, 1);
  app.onDestroy();
});

test('a failed settings request releases input and can succeed on the next click', async () => {
  const first = deferred(), second = deferred(), waits = [first.promise, second.promise];
  const h = bootstrapHarness({ deferHiddenHuds:true,settingsLoad: () => waits.shift() }), app = h.create(); await app.start();
  const failed = app.openSettings(); first.reject(new Error('network timeout')); await failed;
  assert.equal(app.ready, true); assert.equal(app.settingsOpening, false); assert.equal(app.settingsHudRequest, undefined);
  assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  assert.match(app.alerts.message, /设置加载失败.*重试/); assert.equal(app.alerts.node.active, true);
  const retried = app.openSettings();await Promise.resolve(); assert.equal(h.calls.settingsAssets, 2);
  second.resolve({}); await drainPreparation(app, retried);
  assert.equal(app.settingsHud.isOpen, true); assert.equal(h.calls.settingsCreated, 1);
  app.onDestroy();
});

test('settings completion after backgrounding or mode change stays closed and reuses the loaded assets', async () => {
  for (const cancel of ['background', 'mode']) {
    const pending = deferred(), h = bootstrapHarness({ deferHiddenHuds: true, settingsWait: pending.promise }), app = h.create(); await app.start();
    const opened = app.openSettings();
    if (cancel === 'background') app.onHide(); else { app.session.setMode('Mine'); app.syncModalState(); }
    assert.equal(app.settingsOpening, false); assert.equal(app.settingsLoading, undefined);
    pending.resolve({}); await new Promise(setImmediate); app.update(0);
    assert.equal(app.settingsHud, undefined, 'cancelled screens cannot construct while hidden or in another mode');
    assert.equal(app.hud.modalOpen, false);
    if (cancel === 'background') app.onShow(); else app.session.setMode('Main');
    await drainPreparation(app, opened); assert.equal(app.settingsHud.isOpen, false);
    app.canvasTransform.contentSize = { width: 800, height: 1400 };
    app.syncModalState(); await drainPreparation(app, app.openSettings());
    assert.equal(app.settingsHud.isOpen, true); assert.equal(h.calls.settingsAssets, 1); assert.equal(h.calls.settingsCreated, 1);
    assert.deepEqual(app.settingsHud.extent, { width: 800, height: 1400 }, 'a cached canceled request uses the current viewport when opened');
    app.onDestroy();
  }
});

test('settings completion after scene teardown never constructs or reports a stale UI', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = bootstrapHarness({ deferHiddenHuds: true, settingsWait: pending.promise }), app = h.create(); await app.start();
    const opened = app.openSettings(); await Promise.resolve();
    assert.equal(h.calls.settingsAssets, 1);
    h.context.Date = { now: () => app.settingsNoticeAt }; app.update(0);
    const notice = app.settingsLoading;
    app.onDestroy();
    if (fail) pending.reject(new Error('late settings')); else pending.resolve({});
    await drainPreparation(app, opened);
    assert.equal(h.calls.settingsCreated, 0); assert.equal(h.errors.length, 0);
    assert.equal(app.settingsHud, undefined); assert.equal(notice.isValid, false);
  }
});

test('startup reports core asset progress followed by interface preparation', async () => {
  const art = deferred(), feedback = deferred(), h = bootstrapHarness({ artWait: art.promise, feedbackWait: feedback.promise });
  const app = h.create(), started = app.start(), label = app.loading.getComponent(h.cc.Label);
  // Base art, the local text atlas and independent resource groups overlap.
  for (let i = 0; i < 12 && !h.calls.art; i++) await Promise.resolve();
  assert.ok(h.calls.art, 'the main asset load starts without waiting on text');
  assert.match(label.string, /资源已完成 1 项/);
  assert.equal(h.calls.feedback, 1); assert.equal(h.calls.hudAssets, 1);
  assert.deepEqual(h.calls.initialWeaponIds, [0]);
  assert.equal(h.calls.worlds, 0, 'parallel downloads do not release the startup barrier');
  art.resolve(); await h.feedbackEntered;
  await new Promise(setImmediate);
  assert.match(label.string, /模块已完成 13\/14/); assert.match(label.string, /等待：战斗反馈/);
  h.calls.art.onAssetLoaded(22); assert.match(label.string, /资源已完成 22 项/);
  assert.match(label.string, /模块已完成 13\/14/, 'individual asset completions do not inflate module count');
  feedback.resolve({}); await started;
  assert.match(label.string, /准备就绪，正在进入游戏/);
  assert.equal(h.calls.art.onAssetLoaded, undefined);
  assert.equal(h.calls.settingsAssets, 1); assert.equal(app.ready, true);assert.equal(app.resourceModules.isViewReady('settings'),true);
  assert.equal(app.startupProgress, undefined);
  app.onDestroy();
});

test('startup timing reports the longest pending module once per second and stops in background or after completion', async () => {
  const feedback = deferred(), money = deferred(); let now = 0;
  const h = bootstrapHarness({ deferHiddenHuds: true, feedbackWait: feedback.promise, moneyWait: money.promise, release: '0.1.4' });
  h.context.Date = { now: () => now };
  const app = h.create(), started = app.start(); await h.feedbackEntered; await new Promise(setImmediate);
  const label = app.loading.getComponent(h.cc.Label);
  assert.match(label.string, /版本 0\.1\.4/); assert.match(label.string, /等待：战斗反馈（已等待 0 秒）/);
  now = 1500; app.update(0); assert.match(label.string, /已等待 1 秒/);
  now = 2100; app.update(0); assert.match(label.string, /已等待 1 秒/, 'updates are throttled to one second');
  app.onHide(); now = 6000; app.update(0); assert.match(label.string, /已等待 1 秒/);
  app.onShow(); app.update(0); assert.match(label.string, /已等待 6 秒/);
  feedback.resolve({}); await Promise.resolve(); await Promise.resolve();
  assert.match(label.string, /等待：伤害数字（已等待 6 秒）/);
  assert.ok(h.logs.some(([line]) => line === '[ForestGunner] 模块完成：战斗反馈，耗时 6000 ms'));
  now = 7000; money.resolve({}); await started;
  assert.equal(app.startupProgress, undefined); assert.equal(h.logs.length, 14);
  const complete = label.string; now = 9000; app.update(0); assert.equal(label.string, complete);
  app.onDestroy();
});

test('startup timing is cleared after module failure or teardown without late logging', async () => {
  for (const destroy of [false, true]) {
    const feedback = deferred(), h = bootstrapHarness({ deferHiddenHuds: true, feedbackWait: feedback.promise }), app = h.create();
    const started = app.start(); await h.feedbackEntered; await new Promise(setImmediate);
    assert.ok(app.startupProgress); assert.doesNotMatch(app.loading.getComponent(h.cc.Label).string, /版本/);
    const count = h.logs.length;
    if (destroy) { app.onDestroy(); feedback.resolve({}); } else feedback.reject(new Error('module failure'));
    await started;
    assert.equal(app.startupProgress, undefined); assert.equal(h.logs.length, count);
    if (!destroy) app.onDestroy();
  }
});

test('only WeChat reduces downloader retries before loading resources', async () => {
  for (const wechat of [false, true]) {
    const h = bootstrapHarness({ wechat }), app = h.create(); await app.start();
    assert.equal(app.ready, true); assert.equal(h.cc.assetManager.downloader.maxRetryCount, wechat ? 2 : 4);
    app.onDestroy();
  }
});

test('new production saves enter battle without hidden feature HUDs and retain the upgrade tutorial target', async () => {
  const h = bootstrapHarness({ deferHiddenHuds: true }), app = h.create(); await app.start();
  assert.equal(app.ready, true); assert.equal(h.calls.weaponAssets, 0); assert.equal(h.calls.raidAssets, 0); assert.equal(h.calls.bossAssets, 0);
  assert.equal(h.calls.speedRunAssets, 0); assert.equal(h.calls.rebirthAssets, 0);
  assert.equal(app.weaponsHud, undefined); assert.equal(app.raidHud, undefined); assert.equal(app.bossHud, undefined);
  assert.equal(app.speedRunHud, undefined); assert.equal(app.rebirthHud, undefined);
  app.updateTutorial(0);
  const targets = app.tutorialHud.updates.at(-1).targets;
  assert.equal(targets.upgrade, app.hud.node); assert.equal(targets.entry, null); assert.equal(targets.weaponOpen, false);
  assert.equal(h.context.__forestGunner.snapshot().weaponPopup, false);
  for (let i = 0; i < 10; i++) app.update(.01);
  assert.equal(h.calls.weaponAssets + h.calls.raidAssets + h.calls.bossAssets, 0);
  assert.equal(h.calls.speedRunAssets + h.calls.rebirthAssets, 0);
  assert.ok(app.world.simulationTime > 0); app.onDestroy();
});

test('Bootstrap downloads progress on busy frames, remain silent, and stop on hide/teardown', async () => {
  for (const backgroundFail of [false, true]) {
    let now = 0;
    const h = bootstrapHarness({ deferHiddenHuds: true, backgroundFail }), app = h.create();
    h.context.Date = { now: () => now };
    await app.start(); await Promise.all(Array.from(app.entryRequests.values()));
    app.resourcePreloader.setMode('download-only');
    const nodes = h.nodes.length;
    assert.equal(h.calls.backgroundConfigs.length, 0); assert.equal(app.loading, undefined);
    // Startup has already started the shared download queue with no delay.
    // Busy gameplay frames may continue it immediately, without creating UI.
    app.update(.1);assert.equal(h.calls.backgroundConfigs.length,1);
    await new Promise(setImmediate);
    assert.equal(h.nodes.length, nodes); assert.equal(app.deferredHudNotice, undefined); assert.equal(app.settingsLoading, undefined);
    assert.equal(h.calls.weaponAssets + h.calls.settingsAssets + h.calls.fishAssets, 0);
    app.onHide(); now = 20000; app.update(0); assert.equal(h.calls.backgroundConfigs.length, 1);
    assert.equal(h.context.__forestGunner.preload().paused, true);
    app.onShow(); app.update(.1);
    for (let i = 0; i < 6; i++) { now += 100; app.update(1 / 60); await new Promise(setImmediate); }
    assert.ok(h.calls.backgroundConfigs.length + h.calls.backgroundDownloads.length > 1);
    assert.equal(app.ready, true); assert.equal(app.deferredHudNotice, undefined); assert.equal(h.errors.length, 0);
    const queue = app.resourcePreloader; app.onDestroy(); app.update(0);
    assert.equal(queue.snapshot().total, 0); assert.equal(app.resourcePreloader, undefined);
  }
});

test('foreground feature requests share the progressing resource pipeline and only show a delayed notice', async () => {
  let now = 0;
  const pending = deferred(), h = bootstrapHarness({ deferHiddenHuds: true, weaponLoad: () => pending.promise }), app = h.create();
  h.context.Date = { now: () => now }; await app.start(); app.session.contentProgress.weaponsUnlocked = true;
  const opened = app.openFeature('weapons');await Promise.resolve();
  assert.equal(h.calls.weaponAssets, 1); assert.equal(app.deferredHudNotice, undefined);
  now = 199; app.update(0); assert.equal(app.deferredHudNotice, undefined);
  now = 200; app.update(0); assert.match(app.deferredHudNotice.getComponent(h.cc.Label).string, /正在准备武器/);
  now = 2000; app.update(0); assert.ok(h.calls.backgroundConfigs.length>0);
  pending.resolve({}); await drainPreparation(app, opened); assert.equal(app.weaponsHud.isOpen, true);
  for (let i = 0; i < 6; i++) { now += 32; app.update(1 / 60); }
  assert.ok(h.calls.backgroundConfigs.length>0); assert.equal(app.deferredHudNotice.active, false);
  app.onDestroy();
});

test('cached feature/settings opens never create loading notices', async () => {
  const h = bootstrapHarness({ deferHiddenHuds: true }), app = h.create();
  await app.start(); app.session.contentProgress.weaponsUnlocked = true;
  await drainPreparation(app, app.openFeature('weapons')); assert.equal(app.deferredHudNotice, undefined);
  app.weaponsHud.close(); await drainPreparation(app, app.openSettings()); assert.equal(app.settingsLoading, undefined);
  app.onDestroy();
});

test('ready panels open synchronously without a pending loading state even when the next frame is delayed', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();let now=0;h.context.Date={now:()=>now};
  await app.start();app.session.contentProgress.weaponsUnlocked=true;
  await drainPreparation(app,app.loadDeferredHud('weapons',true));
  assert.equal(app.resourceModules.isViewReady('weapons'),true);
  const opened=app.openFeature('weapons');
  assert.equal(app.weaponsHud.isOpen,true,'a prepared view needs no asynchronous prepare round trip');
  assert.equal(app.openingFeature,undefined);
  now+=250;app.update(0);
  assert.equal(app.deferredHudNotice?.active??false,false);
  await opened;assert.equal(h.calls.weaponAssets,1);app.onDestroy();
});

test('30 Hz foreground play with 9 ms updates finishes all locally available unlocked panels before 60 seconds', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true,environment:'test'}),app=h.create();let now=0;h.context.Date={now:()=>now};
  await app.start();app.preparationNow=()=>now;app.backgroundPreparation.reset(0);
  const content=app.session.getContentState.bind(app.session);
  app.session.getContentState=name=>({...content(name),unlocked:true,visible:true});
  const names=backgroundManifest.RESOURCE_MODULE_ORDER.filter(name=>app.shouldPrepareModule(name));
  for(let frame=0;frame<1800;frame++){
    now=frame*1000/30+9;app.updateResourcePreparation(1/30,now-9);await new Promise(setImmediate);
  }
  const unfinished=names.filter(name=>!app.resourceModules.isViewReady(name));
  assert.equal(unfinished.length,0,`locally available panels must not remain unprepared: ${unfinished.join(', ')}`);
  assert.equal(h.calls.weaponAssets,1);assert.equal(app.deferredHudNotice?.active??false,false);
  app.onDestroy();
});

test('a clicked panel bypasses slow-frame backoff without advancing unrelated hidden UI', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  let now=0,hiddenSteps=0,foregroundSteps=0;
  app.preparationNow=()=>now;app.backgroundPreparation.reset();
  app.backgroundPreparation.allow(.1,20);
  const hidden=app.uiPreparation.run('speedrun',(function*(){for(let i=0;i<20;i++){hiddenSteps++;yield;}})());
  app.openingFeature='weapons';
  app.updateResourcePreparation(.1,now);
  assert.equal(hiddenSteps,0,'waiting for foreground assets must not run another panel');
  const clicked=app.uiPreparation.run('weapons',(function*(){foregroundSteps++;yield;})());
  app.updateResourcePreparation(.1,now);await clicked;
  assert.equal(foregroundSteps,1);assert.equal(hiddenSteps,0);assert.ok(h.calls.backgroundConfigs.length>0,'the shared resource pipeline continues while the requested UI waits');
  const rejected=assert.rejects(hidden,/disposed/);app.onDestroy();await rejected;
});

test('downloads continue on busy frames while each stable frame gets UI work and decoding has an independent cadence', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  let now=0,steps=0,resources=0,downloads=0;
  app.preparationNow=()=>now;app.backgroundPreparation.reset(0);
  app.resourcePreloader.updateDownloads=()=>downloads++;app.resourcePreloader.updatePreparation=()=>resources++;
  const pending=app.uiPreparation.run('speedrun',(function*(){for(let i=0;i<1000;i++){steps++;yield;}})());
  const update=app.hud.update.bind(app.hud);
  app.hud.update=(...args)=>{update(...args);now+=20;};
  for(let i=0;i<8;i++){now+=16;app.update(1/60);}
  assert.equal(steps,0);assert.equal(resources,0);assert.equal(downloads,8);
  assert.equal(app.resourceLoadingSnapshot().scheduling.reason,'busy-frame');
  app.hud.update=update;
  now+=500;
  for(let i=0;i<6;i++){now+=32;app.update(1/60);}
  assert.ok(steps>0&&steps<=12);assert.equal(resources,1);
  const before=steps;now+=16;app.update(1/60);
  assert.equal(resources,1);assert.equal(steps,before+12,'UI does not wait for the decode interval');
  now+=16;app.update(1/60);assert.equal(steps,before+24);assert.equal(resources,2);
  app.battleLoading=true;now+=32;app.updateResourcePreparation(1/60,now);
  const stopped=steps;assert.equal(resources,2);
  app.battleLoading=false;app.session.setMode('SpeedRun');now+=32;app.updateResourcePreparation(1/60,now);
  assert.ok(steps>=stopped&&steps-stopped<=12);assert.ok(downloads>8,'other modes retain download progress');
  const rejected=assert.rejects(pending,/disposed/);app.onDestroy();await rejected;
});

test('severe 100 ms stalls admit only one UI step each second and no extra decode on that recovery frame',async()=>{
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  let now=0,steps=0,resources=0;app.preparationNow=()=>now;app.backgroundPreparation.reset(0);
  app.resourcePreloader.updateDownloads=()=>{};app.resourcePreloader.updatePreparation=()=>resources++;
  const pending=app.uiPreparation.run('speedrun',(function*(){for(let i=0;i<100;i++){steps++;yield;}})());
  for(let frame=0;frame<20;frame++){now+=100;app.updateResourcePreparation(.1,now);}
  assert.equal(steps,2);assert.equal(resources,0);assert.equal(app.backgroundPreparation.snapshot().forcedAdmissions,2);
  const rejected=assert.rejects(pending,/disposed/);app.onDestroy();await rejected;
});

test('completed background resources prepare a closed challenge before its first click', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  app.session.contentProgress.challengeUnlocked=true;
  let ready=false;app.resourcePreloader.isFeatureReady=name=>ready&&name==='speedrun';
  app.prepareBackgroundHuds();assert.equal(h.calls.speedRunAssets,0);
  ready=true;app.prepareBackgroundHuds();await drainPreparation(app, Promise.all(app.backgroundHudRequests.values()));
  assert.equal(h.calls.speedRunAssets,1);assert.ok(app.speedRunHud);assert.equal(app.speedRunHud.isOpen,false);
  assert.equal(app.deferredHudNotice,undefined);
  app.session.contentProgress.challengeUnlocked=true;await drainPreparation(app, app.openFeature('speedrun'));
  assert.equal(app.speedRunHud.isOpen,true);assert.equal(h.calls.speedRunAssets,1);
  assert.equal(app.deferredHudNotice,undefined);app.onDestroy();
});

test('production WeChat exposes only read-only loading evidence and records the first wait once', async () => {
  const pending=deferred(),h=bootstrapHarness({debug:false,wechat:true,release:'0.1.22',deferHiddenHuds:true,weaponLoad:()=>pending.promise}),app=h.create();
  let now=0;h.context.Date={now:()=>now};await app.start();
  assert.equal(h.context.__forestGunner,undefined);
  const diagnostics=h.context.__forestGunnerLoading;
  assert.deepEqual(Object.keys(diagnostics),['snapshot']);assert.equal(Object.isFrozen(diagnostics),true);
  assert.equal(diagnostics.snapshot().version,'0.1.22');assert.equal(diagnostics.snapshot().uiReady.weapons,false);
  app.session.contentProgress.weaponsUnlocked=true;const opened=app.openFeature('weapons');
  now=200;app.update(0);app.update(0);
  const waits=h.logs.filter(([message])=>message==='[ForestGunner] Resource wait');
  assert.equal(waits.length,1);assert.equal(waits[0][1],'weapons');assert.equal(waits[0][2].opening,'weapons');
  pending.resolve({});await drainPreparation(app, opened);
  assert.equal(diagnostics.snapshot().uiReady.weapons,true);
  app.onDestroy();assert.equal(h.context.__forestGunnerLoading,undefined);
});

test('one pending background HUD cannot block other ready panels before their first click', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,weaponLoad:()=>pending.promise}),app=h.create();
  await app.start();app.session.contentProgress.challengeUnlocked=true;let challengeReady=false;
  app.resourcePreloader.isFeatureReady=name=>name==='weapons'||(challengeReady&&name==='speedrun');
  app.prepareBackgroundHuds();const weapons=app.backgroundHudRequests.get('weapons');
  assert.ok(weapons);await Promise.resolve();assert.equal(h.calls.weaponAssets,1);
  challengeReady=true;
  await preparationFrames(app);
  assert.ok(app.speedRunHud,'challenge must prepare while the unrelated weapon request is still pending');
  assert.equal(app.speedRunHud.isOpen,false);assert.equal(app.weaponsHud,undefined);
  app.session.contentProgress.challengeUnlocked=true;await drainPreparation(app, app.openFeature('speedrun'));
  assert.equal(app.speedRunHud.isOpen,true);assert.equal(app.deferredHudNotice,undefined);
  pending.resolve({});await drainPreparation(app, weapons);app.onDestroy();
});

test('pending settings is skipped when admitting the next ready background HUD', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,settingsLoad:()=>pending.promise}),app=h.create();
  await app.start();app.resourcePreloader.isFeatureReady=name=>name==='settings';
  app.prepareBackgroundHuds();await Promise.resolve();assert.equal(h.calls.settingsAssets,1);
  app.resourcePreloader.isFeatureReady=name=>name==='settings'||name==='weapons';
  await preparationFrames(app);
  assert.equal(h.calls.settingsAssets,1);assert.ok(app.weaponsHud);assert.equal(app.settingsHud,undefined);
  pending.resolve({});await drainPreparation(app, Promise.all(app.backgroundHudRequests.values()));app.onDestroy();
});

test('a click joins background panel preparation and background failure stays silent and recoverable', async () => {
  const pending=deferred();let attempts=0;
  const h=bootstrapHarness({deferHiddenHuds:true,weaponLoad:()=>++attempts===1?Promise.reject(Error('temporary')):pending.promise}),app=h.create();
  let now=0;h.context.Date={now:()=>now};await app.start();
  app.resourcePreloader.isFeatureReady=name=>name==='weapons';
  app.prepareBackgroundHuds();await drainPreparation(app, Promise.all(app.backgroundHudRequests.values()));
  assert.equal(app.deferredHudStates.weapons.failed,false);assert.equal(app.deferredHudNotice,undefined);assert.equal(h.errors.length,0);
  app.prepareBackgroundHuds();assert.equal(attempts,1);
  now=app.deferredHudStates.weapons.retryAt;app.prepareBackgroundHuds();
  app.session.contentProgress.weaponsUnlocked=true;const opened=app.openFeature('weapons');
  await Promise.resolve();assert.equal(attempts,2);pending.resolve({});await drainPreparation(app, opened);await drainPreparation(app, Promise.all(app.backgroundHudRequests.values()));
  assert.equal(app.weaponsHud.isOpen,true);assert.equal(attempts,2);app.onDestroy();
});

test('UI preparation stops while hidden and teardown cancels remaining work', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  let count=0;const request=app.uiPreparation.run('challenge',(function*(){for(let n=0;n<1000;n++){count++;yield;}})());
  app.onHide();app.update(.05);assert.equal(count,0);
  app.onShow();app.update(.05);assert.equal(count,0,'resume waits for stable frames');
  await preparationFrames(app,40);assert.ok(count>0&&count<1000);
  const before=count,rejected=assert.rejects(request,/disposed/);app.onDestroy();await rejected;
  app.update(.05);assert.equal(count,before);
});

test('HUD constructors and publication require separate ticks and unchanged initial layout is reused', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  const prepared=deferred();let created=0,layouts=0,hud;
  const request=app.prepareFeatureHud('settings',()=>{
    created++;app.hudPreparation('settings').layout();
    const node=new h.cc.Node('TickOwnedSettings');app.hudRoot.addChild(node);
    return hud={node,prepared:prepared.promise,resize(){layouts++;},cancelInteractions(){},destroy(){node.destroy();}};
  });
  await new Promise(setImmediate);
  assert.equal(created,0,'a settled asset Promise cannot synchronously construct a HUD');
  app.uiPreparation.tick('settings');
  assert.equal(created,1);assert.equal(hud.node.active,false);assert.equal(app.settingsHud,undefined);
  prepared.resolve();await new Promise(setImmediate);
  assert.equal(app.settingsHud,undefined,'preparation completion cannot publish through its Promise chain');
  assert.equal(hud.node.active,false);assert.equal(layouts,0);
  app.uiPreparation.tick('settings');
  assert.equal(app.settingsHud,hud,'registration happens inside the commit tick');
  assert.equal(hud.node.active,true);assert.equal(app.modalStateDirty,true);
  assert.equal(await request,hud);assert.equal(layouts,0,'unchanged viewport skips a second layout traversal');
  const phases=Array.from(app.resourceLoadingSnapshot().trace.events).filter(event=>event.feature==='settings').map(event=>event.phase);
  assert.ok(phases.includes('construct'));assert.ok(phases.includes('commit'));assert.ok(phases.includes('activation'));
  app.onDestroy();
});

test('a viewport change during HUD preparation waits for sliced layout before publication', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  const prepared=deferred(),layouts=[];let hud;
  const request=app.prepareFeatureHud('settings',()=>{
    app.hudPreparation('settings').layout();
    const node=new h.cc.Node('ResizedSettings');app.hudRoot.addChild(node);
    return hud={node,prepared:prepared.promise,resize(){assert.fail('layout must use the sliced path');},cancelInteractions(){},
      resizePrepared(prepare,...extent){return prepare((function*(){layouts.push(extent);})());},destroy(){node.destroy();}};
  });
  app.uiPreparation.tick('settings');await new Promise(setImmediate);
  app.viewport.width=800;prepared.resolve();await new Promise(setImmediate);
  assert.equal(layouts.length,0);assert.equal(app.settingsHud,undefined);
  app.uiPreparation.tick('settings');await new Promise(setImmediate);
  assert.deepEqual(layouts,[[800,1280,0,0]]);assert.equal(hud.node.active,false);assert.equal(app.settingsHud,undefined);
  app.uiPreparation.tick('settings');assert.equal(await request,hud);assert.equal(hud.node.active,true);
  app.onDestroy();
});

test('one UI tick publishes at most one ready HUD even when the clock does not advance', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  app.preparationNow=()=>0;
  const panels=[],requests=['one','two'].map(name=>app.prepareFeatureHud(name,()=>{
    app.hudPreparation(name).layout();
    const node=new h.cc.Node(name);app.hudRoot.addChild(node);
    const hud={node,resize(){},destroy(){node.destroy();}};panels.push(hud);return hud;
  }));
  app.uiPreparation.tick();await new Promise(setImmediate);
  assert.equal(panels.length,2);assert.equal(panels.filter(hud=>hud.node.active).length,0);
  app.uiPreparation.tick();await new Promise(setImmediate);
  assert.equal(panels.filter(hud=>hud.node.active).length,1,'coarse clocks cannot merge two commits');
  app.uiPreparation.tick();await Promise.all(requests);
  assert.equal(panels.filter(hud=>hud.node.active).length,2);app.onDestroy();
});

test('teardown rejects queued HUD construction and queued publication without leaking partial nodes', async () => {
  for(const phase of ['construct','commit']){
    const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
    let created=0,node;
    const request=app.prepareFeatureHud('settings',()=>{
      created++;app.hudPreparation('settings').layout();node=new h.cc.Node('CancelledSettings');app.hudRoot.addChild(node);
      return {node,resize(){},cancelInteractions(){},destroy(){node.destroy();}};
    });
    if(phase==='commit'){app.uiPreparation.tick('settings');await new Promise(setImmediate);assert.equal(node.active,false);}
    const rejected=assert.rejects(request,/disposed/);app.onDestroy();await rejected;
    assert.equal(created,phase==='construct'?0:1);assert.equal(app.settingsHud,undefined);
    if(node){assert.equal(node.isValid,false);assert.equal(node.destroyCalls,1);}
  }
});

test('resource completion while hidden cannot construct until foreground update resumes', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,settingsLoad:()=>pending.promise}),app=h.create();await app.start();
  const opened=app.openSettings();app.onHide();pending.resolve({});await new Promise(setImmediate);
  await preparationFrames(app,12);assert.equal(h.calls.settingsCreated,0);assert.equal(app.settingsHud,undefined);
  app.onShow();await preparationFrames(app,80);await opened;
  assert.equal(h.calls.settingsCreated,1);assert.equal(app.settingsHud.isOpen,false,'resuming does not revive the cancelled click');
  app.onDestroy();
});

test('dispose between commit and its Promise continuation cannot reassign a destroyed HUD', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  const request=app.ensureSettingsHud();await new Promise(setImmediate);
  for(let frame=0;frame<6&&!app.settingsHud;frame++){
    app.uiPreparation.tick('settings');
    // Leave the successful commit's Promise continuation pending for teardown.
    if(!app.settingsHud)await new Promise(setImmediate);
  }
  const hud=app.settingsHud;assert.ok(hud);assert.equal(hud.node.active,true);
  const rejected=assert.rejects(request,/invalidated/);app.onDestroy();assert.equal(app.settingsHud,undefined);
  await rejected;
  assert.equal(app.settingsHud,undefined);assert.equal(hud.node.isValid,false);
  assert.equal(h.calls.settingsDestroyed,1);assert.equal(hud.node.destroyCalls,1);
});

test('diagnostic download and decode modes suppress background HUD creation while explicit clicks still work', async () => {
  for(const mode of ['download-only','decode']){
    const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
    app.resourcePreloader.setMode(mode);app.resourcePreloader.isFeatureReady=()=>true;
    await preparationFrames(app,120);
    assert.equal(h.calls.settingsCreated,0);assert.equal(app.weaponsHud,undefined);assert.equal(app.speedRunHud,undefined);
    assert.equal(app.resourcePreloader.mode,mode);
    const opened=app.openSettings();
    await preparationFrames(app,8);await opened;
    assert.equal(app.settingsHud.isOpen,true);assert.equal(h.calls.settingsCreated,1);
    app.onDestroy();
  }
});

test('an unlocked panel prepares automatically after the open compositor is released', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,fishLoad:()=>pending.promise,contentOverrides:{thresholds:{fishStage:1,fishVisibleStage:1}}}),app=h.create();
  await app.start();await drainPreparation(app, app.openSettings());
  app.session.tutorial.complete();
  app.resourcePreloader.isFeatureReady=name=>name==='fish';
  app.prepareBackgroundHuds();assert.equal(h.calls.fishAssets,0);
  app.settingsHud.close();app.prepareBackgroundHuds();await Promise.resolve();assert.equal(h.calls.fishAssets,1,'an unlocked panel starts before its first click');
  const fish=app.loadDeferredHud('fish',true);assert.equal(h.calls.fishAssets,1);
  await drainPreparation(app, app.openSettings());pending.resolve({});await new Promise(setImmediate);
  app.update(0);assert.equal(h.calls.fishCreated,0,'never capture another panel\'s temporary camera target');
  app.settingsHud.close();
  await preparationFrames(app);
  await drainPreparation(app, fish);
  assert.equal(h.calls.fishCreated,1);assert.equal(app.fishHud.isOpen,false);app.onDestroy();
});

test('a suspended fish panel does not block challenge preparation behind settings', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,fishLoad:()=>pending.promise}),app=h.create();
  await app.start();app.session.contentProgress.challengeUnlocked=true;let challengeReady=false;
  app.resourcePreloader.isFeatureReady=name=>name==='fish'||(challengeReady&&name==='speedrun');
  app.prepareBackgroundHuds();assert.equal(h.calls.fishAssets,0);
  const fish=app.loadDeferredHud('fish',true);
  await drainPreparation(app, app.openSettings());pending.resolve({});await new Promise(setImmediate);
  challengeReady=true;
  await preparationFrames(app);
  assert.equal(h.calls.fishCreated,0,'compositor must not borrow the open settings camera');
  assert.ok(app.speedRunHud);assert.equal(app.speedRunHud.isOpen,false);
  assert.equal(app.speedRunHud.entryBlocked,true);assert.equal(app.settingsHud.isOpen,true);
  assert.ok(app.settingsHud.node.getSiblingIndex()>app.speedRunHud.node.getSiblingIndex());
  assert.equal(app.deferredHudNotice,undefined);
  app.settingsHud.close();
  await preparationFrames(app);
  await drainPreparation(app, fish);assert.equal(h.calls.fishCreated,1);app.onDestroy();
});

test('real background resource completion prepares challenge while an offline receipt stays open', async () => {
  const saved=offlineBootStorage(),h=bootstrapHarness({storage:saved.storage,sessionNow:()=>OFFLINE_BOOT_NOW,deferHiddenHuds:true}),app=h.create();
  let now=0;h.context.Date={now:()=>now};
  await app.start();await drainPreparation(app, app.offlineHudRequest);
  assert.equal(app.offlineSummaryPending,true);assert.equal(app.offlineHud.isOpen,true);
  const load=app.deferredHudLoaders.speedrun;let preparedSteps=0;
  app.deferredHudLoaders.speedrun=async()=>{
    await app.uiPreparation.run('speedrun',(function*(){for(let i=0;i<60;i++){preparedSteps++;yield;}})());
    await load();
  };
  now=1000;
  for(let frame=0;frame<3600&&!app.speedRunHud;frame++){now+=1000/60;app.update(0);await new Promise(setImmediate);}
  now+=1000/60;app.update(0); // Commit marks state dirty; the next update refreshes the closed entry.
  assert.equal(app.resourcePreloader.isFeatureReady('speedrun'),true);
  assert.equal(preparedSteps,60);assert.ok(app.speedRunHud);assert.equal(app.speedRunHud.isOpen,false);
  assert.equal(app.offlineHud.isOpen,true);assert.equal(app.hud.modalOpen,true);
  assert.equal(app.speedRunHud.entryBlocked,true);
  assert.ok(app.offlineHud.node.getSiblingIndex()>app.speedRunHud.node.getSiblingIndex());
  assert.equal(app.deferredHudNotice,undefined);
  app.session.contentProgress.challengeUnlocked=true;app.closeOfflineSummary();
  const loads=h.calls.speedRunAssets;await drainPreparation(app, app.openFeature('speedrun'));
  assert.equal(app.speedRunHud.isOpen,true);assert.equal(h.calls.speedRunAssets,loads);
  assert.equal(app.deferredHudNotice,undefined);app.onDestroy();
});

test('startup weapon visuals include default construction and every saved squad weapon without duplicates', async () => {
  const fresh = bootstrapHarness({ deferHiddenHuds: true }), newApp = fresh.create(); await newApp.start();
  assert.deepEqual(fresh.calls.initialWeaponIds, [0]); newApp.onDestroy();
  const saved = rebirthStorage(), data = JSON.parse(saved.data.get(saved.key));
  const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
  const weapons = new WeaponInventory({ environment: 'test', initialState: data.weapons });
  assert.equal(weapons.grantTestWeapon(2).ok, true); assert.equal(weapons.equip(0, 0).ok, true);
  data.weapons = weapons.serialize(); saved.data.set(saved.key, JSON.stringify(data));
  const h = bootstrapHarness({ storage: saved.storage, deferHiddenHuds: true }), app = h.create(); await app.start();
  assert.equal(app.ready, true);
  assert.deepEqual(app.session.combatLoadout.map(actor => actor.weapon.id), [2, 1, 2]);
  assert.deepEqual(h.calls.initialWeaponIds, [0, 2, 1]);
  assert.deepEqual(app.world.loadout.map(actor => actor.weapon.id), [2, 1, 2], 'saved weapons still reach the first battle');
  app.onDestroy();
});

test('old saves load lightweight visible entries without loading full feature panels at startup', async () => {
  const saved=rebirthStorage(),data=JSON.parse(saved.data.get(saved.key));
  data.progress={stageIndex:9,waveIndex:0};data.weapons.stageValueMax=90;
  data.content={challengeUnlocked:true,weaponsUnlocked:true,firstDrawGranted:true};saved.data.set(saved.key,JSON.stringify(data));
  const h=bootstrapHarness({storage:saved.storage,deferHiddenHuds:true}),app=h.create();await app.start();
  await Promise.all(Array.from(app.entryRequests.values()));
  for(const name of ['weapons','boss','speedrun'])assert.ok(app.featureEntries.has(name));
  assert.equal(app.raidHud,undefined);assert.equal(app.weaponsHud,undefined);assert.equal(app.bossHud,undefined);
  assert.equal(h.calls.weaponAssets+h.calls.bossAssets+h.calls.speedRunAssets+h.calls.raidAssets,0);
  assert.equal(app.ready,true);app.onDestroy();
});

test('challenge first click shares one load while combat runs and opens only after readiness', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,speedRunLoad:()=>pending.promise}),app=h.create();
  await app.start();app.update(0);app.session.contentProgress.challengeUnlocked=true;app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));assert.ok(app.featureEntries.has('speedrun'));assert.equal(h.calls.speedRunAssets,0);
  const opened=app.openFeature('speedrun'),again=app.openFeature('speedrun');await Promise.resolve();
  app.update(.05);assert.equal(h.calls.speedRunAssets,1);assert.ok(app.world.simulationTime>0);assert.equal(app.startSpeedRun().ok,false);
  pending.resolve({});await drainPreparation(app, Promise.all([opened, again]));assert.equal(app.speedRunHud.isOpen,true);
  assert.equal(app.startSpeedRun().ok,true);assert.equal(app.session.mode,'SpeedRun');app.onDestroy();
});

test('fish entry stays lightweight and duplicate first clicks share a panel load while combat continues', async () => {
  const pending = deferred(), h = bootstrapHarness({ deferHiddenHuds: true, fishLoad: () => pending.promise,
    contentOverrides: { thresholds: { fishStage: 1, fishVisibleStage: 1 } } }), app = h.create();
  await app.start(); app.update(0); app.session.tutorial.complete(); app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  assert.ok(app.featureEntries.has('fish')); assert.equal(app.fishHud, undefined); assert.equal(h.calls.fishAssets, 0);
  const opened = app.openFeature('fish'), again = app.openFeature('fish');await Promise.resolve();
  app.update(.05);
  assert.equal(h.calls.fishAssets, 1); assert.equal(h.calls.fishCreated, 0);
  assert.ok(app.world.simulationTime > 0); assert.equal(app.hud.modalOpen, true);
  assert.equal(app.battlefield.muted, true); assert.equal(app.purchaseUpgrade('money'), false);
  pending.resolve({}); await drainPreparation(app, Promise.all([opened, again]));
  assert.equal(app.fishHud.isOpen, true); assert.equal(h.calls.fishCreated, 1);
  assert.equal(app.featureEntries.get('fish').node.active, false);
  assert.ok(app.fishHud.node.getSiblingIndex() < app.tutorialHud.node.getSiblingIndex());
  app.fishHud.close(); assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  app.onDestroy(); app.onDestroy(); assert.equal(h.calls.fishDestroyed, 1);
});

test('fish and pet popup callbacks are mutually exclusive and background cancels fish interaction', async () => {
  const h = bootstrapHarness({ deferHiddenHuds: true,
    contentOverrides: { thresholds: { fishStage: 1, fishVisibleStage: 1, petStage: 1, petVisibleStage: 1 } } }), app = h.create();
  await app.start(); app.update(0); app.session.tutorial.complete();
  await drainPreparation(app, app.loadDeferredHud('pets'));
  await drainPreparation(app, app.openFeature('fish')); assert.equal(app.fishHud.isOpen, true);
  app.petHud.open();
  assert.equal(app.petHud.isOpen, true); assert.equal(app.fishHud.isOpen, false);
  app.fishHud.open(); assert.equal(app.fishHud.isOpen, true); assert.equal(app.petHud.isOpen, false);
  const before = app.fishHud.cancellations;
  app.onHide(); assert.ok(app.fishHud.cancellations > before);
  app.update(5); assert.equal(app.fishHud.updates.at(-1), 0);
  app.onDestroy(); assert.equal(h.calls.fishDestroyed, 1);
});

test('tutorial and first challenge win reveal lightweight skin and rebirth entries without downloading panels', async () => {
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();app.session.tutorial.complete();app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));
  for(const name of ['skins','rebirth']) {
    assert.equal(app.visibleDeferredHuds()[name],false);assert.equal(app.featureEntries.has(name),false);
    await drainPreparation(app, app.openFeature(name));
  }
  assert.equal(h.calls.skinAssets+h.calls.rebirthAssets,0);
  app.session.speedRun.restore({stage:1});app.updateDeferredHuds();await Promise.all(Array.from(app.entryRequests.values()));app.syncModalState();
  for(const name of ['skins','rebirth'])assert.equal(app.visibleDeferredHuds()[name],true);
  assert.equal(app.featureEntries.get('skins').locked,false);assert.equal(app.skinHud,undefined);assert.equal(h.calls.skinAssets,0);
  assert.ok(app.featureEntries.get('rebirth').locked);assert.equal(app.rebirthHud,undefined);assert.equal(h.calls.rebirthAssets,0);
  await drainPreparation(app, app.openFeature('rebirth'));assert.equal(h.calls.rebirthAssets,0);assert.equal(app.rebirthHud,undefined);app.onDestroy();
});

test('Boss and Raid lightweight entries and loaded HUDs use the same tutorial gate', async () => {
  const saved=rebirthStorage(),data=JSON.parse(saved.data.get(saved.key));
  data.progress={stageIndex:39,waveIndex:0};data.weapons.stageValueMax=390;
  data.content={challengeUnlocked:true,weaponsUnlocked:true,firstDrawGranted:true};data.tutorial={step:'gunOpen',drawCount:0};
  saved.data.set(saved.key,JSON.stringify(data));
  const h=bootstrapHarness({storage:saved.storage,deferHiddenHuds:true}),app=h.create();await app.start();
  await Promise.all(Array.from(app.entryRequests.values()));
  for(const name of ['boss','raid']) {
    assert.equal(app.visibleDeferredHuds()[name],false);assert.equal(app.featureEntries.has(name),false);
    await drainPreparation(app, app.openFeature(name));
  }
  assert.equal(h.calls.bossAssets+h.calls.raidAssets,0);
  app.session.tutorial.complete();app.updateDeferredHuds();await Promise.all(Array.from(app.entryRequests.values()));app.syncModalState();
  for(const name of ['boss','raid']) {
    assert.equal(app.featureEntries.get(name).node.active,true);assert.equal(app.featureEntries.get(name).locked,false);
    await drainPreparation(app, app.loadDeferredHud(name));app.syncModalState();
    assert.equal(app.getFeature(name).entryVisible,true);assert.equal(app.featureEntries.get(name).node.active,false);
  }
  app.session.tutorial.restore({step:'gunOpen',drawCount:0});app.syncModalState();
  for(const name of ['boss','raid'])assert.equal(app.getFeature(name).entryVisible,false);
  assert.equal(app.session.startBoss().ok,false);assert.equal(app.session.openRaid().ok,false);
  app.onDestroy();
});

test('a Boss or Raid panel finishing its load rechecks tutorial access before opening', async () => {
  for(const name of ['boss','raid']) {
    const saved=rebirthStorage(),data=JSON.parse(saved.data.get(saved.key));
    data.progress={stageIndex:39,waveIndex:0};data.weapons.stageValueMax=390;data.tutorial={step:'done',drawCount:0};
    saved.data.set(saved.key,JSON.stringify(data));
    const pending=deferred(),h=bootstrapHarness({storage:saved.storage,deferHiddenHuds:true,[name+'Load']:()=>pending.promise});
    const app=h.create();await app.start();const opened=app.openFeature(name);
    app.session.tutorial.restore({step:'gunOpen',drawCount:0});pending.resolve({});await drainPreparation(app, opened);
    assert.equal(app.getFeature(name).isOpen,false);assert.equal(app.getFeature(name).entryVisible,false);
    assert.equal(app.openingFeature,undefined);assert.equal(app.hud.modalOpen,false);app.onDestroy();
  }
});

test('weapon first open preserves tutorial target and overlay ordering while loading', async () => {
  const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,weaponLoad:()=>pending.promise}),app=h.create();
  await app.start();app.update(0);app.session.contentProgress.weaponsUnlocked=true;app.updateDeferredHuds();
  await Promise.all(Array.from(app.entryRequests.values()));app.updateTutorial(0);
  assert.equal(app.tutorialHud.updates.at(-1).targets.entry,app.featureEntries.get('weapons').entry);
  assert.equal(h.calls.weaponAssets,0);const opened=app.openFeature('weapons');await Promise.resolve();app.update(.05);
  assert.equal(h.calls.weaponAssets,1);assert.ok(app.world.simulationTime>0);assert.equal(app.hud.modalOpen,true);
  pending.resolve({});await drainPreparation(app, opened);assert.equal(app.weaponsHud.isOpen,true);assert.equal(app.featureEntries.get('weapons').node.active,false);
  assert.ok(app.weaponsHud.node.getSiblingIndex()<app.tutorialHud.node.getSiblingIndex());app.onDestroy();
});

test('failed panel loads never retry every frame and can be explicitly retried', async () => {
  let attempts=0;const h=bootstrapHarness({deferHiddenHuds:true,weaponLoad:()=>++attempts===1?Promise.reject(new Error('offline')):Promise.resolve({})}),app=h.create();
  await app.start();app.session.contentProgress.weaponsUnlocked=true;await drainPreparation(app, app.openFeature('weapons'));
  assert.equal(attempts,1);assert.equal(app.ready,true);assert.equal(app.openingFeature,undefined);
  for(let i=0;i<30;i++)app.updateDeferredHuds();assert.equal(attempts,1);
  assert.match(app.deferredHudNotice.getComponent(h.cc.Label).string,/点击重试/);
  await drainPreparation(app, app.openFeature('weapons'));assert.equal(attempts,2);assert.equal(app.weaponsHud.isOpen,true);app.onDestroy();
});

test('panel completion after background, mode change or teardown cannot open stale UI', async () => {
  for(const action of ['background','mode','destroy']){
    const pending=deferred(),h=bootstrapHarness({deferHiddenHuds:true,weaponLoad:()=>pending.promise}),app=h.create();
    await app.start();app.session.contentProgress.weaponsUnlocked=true;
    app.onHide();await drainPreparation(app, app.openFeature('weapons'));assert.equal(h.calls.weaponAssets,0);app.onShow();
    const opened=app.openFeature('weapons');await Promise.resolve();assert.equal(h.calls.weaponAssets,1);
    if(action==='background')app.onHide();else if(action==='mode')app.session.setMode('Mine');else app.onDestroy();
    pending.resolve({});await new Promise(setImmediate);app.update(0);
    if(action!=='destroy'){
      assert.equal(app.weaponsHud,undefined,'cancelled preparation waits for a playable foreground frame');
      if(action==='background')app.onShow();else app.session.setMode('Main');
    }
    await drainPreparation(app, opened);
    if(action==='destroy')assert.equal(app.weaponsHud,undefined);else{assert.equal(app.weaponsHud.isOpen,false);app.onDestroy();}
  }
});

test('skin preparation never mutates the selected save and a mode change prevents the eventual transaction', async () => {
  const pending = deferred(), h = bootstrapHarness({ environment: 'test', skinPrepare: () => pending.promise });
  const app = h.create(); await app.start();
  assert.equal(app.purchaseSkin(4).ok, true);
  const before = app.session.getSkinState().selectedId;
  const preparing = app.skinHud.callbacks.prepare(4);
  assert.equal(app.skinHud.callbacks.equip(4).ok, false);
  assert.equal(app.session.getSkinState().selectedId, before); assert.equal(app.battlefield.skinId, before);
  app.session.setMode('Mine'); pending.resolve(); await drainPreparation(app, preparing);
  assert.equal(app.skinHud.callbacks.equip(4).ok, false);
  assert.equal(app.session.getSkinState().selectedId, before); assert.equal(app.battlefield.skinId, before);
  app.session.setMode('Main'); assert.equal(app.skinHud.callbacks.equip(4).ok, true);
  assert.equal(app.session.getSkinState().selectedId, 4); assert.equal(app.battlefield.skinId, 4);
  app.onDestroy();
});

test('settings entry blocks tutorial and upgrades without stopping combat, then restores background state and disposes audio', async () => {
  const h = bootstrapHarness({ realWorld: true }), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  const bgm = app.bgm, sfx = app.sfx;
  assert.equal(bgm.mode, 'Main'); assert.equal(bgm.enabled, true); assert.equal(sfx.enabled, true);
  await drainPreparation(app, app.hud.onSettings()); app.update(0);
  const settings = app.settingsHud;
  assert.equal(settings.isOpen, true); assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  assert.equal(app.tutorialHud.updates.at(-1).targets.blocked, true);
  for (const name of ['weaponsHud', 'rebirthHud', 'speedRunHud', 'raidHud', 'bossHud', 'skinHud', 'settingsHud']) {
    assert.equal(app[name].entryBlocked, true, name);
  }
  assert.equal(app.purchaseUpgrade('power'), false);
  const time = app.world.simulationTime; app.update(.1);
  assert.ok(app.world.simulationTime > time, 'opening settings leaves main combat running');
  assert.equal(bgm.paused, false, 'the settings popup does not pause background music');
  settings.callbacks.toggleBgm(); settings.callbacks.toggleSound();
  assert.equal(bgm.enabled, false); assert.equal(sfx.enabled, false);
  assert.equal(settings.callbacks.getState().bgmEnabled, false); assert.equal(settings.callbacks.getState().soundEnabled, false);
  settings.isRedeemOpen = true; settings.pressed = true;
  app.onHide(); app.update(60);
  assert.equal(settings.pressed, false); assert.equal(settings.updates.at(-1), 0);
  assert.equal(bgm.paused, true); assert.equal(app.world.paused, true);
  app.onShow(); app.update(0);
  assert.equal(bgm.paused, false); assert.equal(bgm.enabled, false, 'foreground does not undo user mute');
  assert.equal(settings.isOpen, true); assert.equal(settings.isRedeemOpen, true);
  settings.close(); app.update(0);
  assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  assert.equal(app.tutorialHud.updates.at(-1).targets.blocked, false);
  app.onDestroy(); app.onDestroy();
  assert.equal(h.calls.settingsDestroyed, 1); assert.equal(h.calls.bgmDestroyed, 1);
  assert.equal(settings.node.isValid, false); assert.equal(bgm.node.isValid, false);
  const restored = h.create(); await restored.start();
  assert.equal(h.errors.length, 0); assert.equal(restored.bgm, undefined); assert.equal(restored.sfx.enabled, false);
  restored.onDestroy();
});

test('settings redemption reaches the persistent session wallet and survives Bootstrap recreation', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create(); await app.start();
  await drainPreparation(app, app.openSettings());
  const before = app.session.weapons.diamonds;
  const result = app.settingsHud.callbacks.redeemCode('950424');
  assert.equal(result.ok, true); assert.equal(result.diamonds, 2000);
  app.update(0); assert.equal(app.hudState().diamonds, before + 2000);
  assert.equal(app.settingsHud.callbacks.redeemCode('950424').reason, 'alreadyUsed');
  app.onDestroy();
  const restored = h.create(); await restored.start();
  await drainPreparation(restored, restored.openSettings());
  assert.equal(h.errors.length, 0); assert.equal(restored.session.weapons.diamonds, before + 2000);
  assert.equal(restored.settingsHud.callbacks.redeemCode('950424').reason, 'alreadyUsed');
  restored.onDestroy();
});

test('Skin HUD callbacks equip immediately, restore selected art on restart and close for mode transitions', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  assert.equal(app.skinHud.callbacks.purchase(4).ok, true);
  assert.equal(app.battlefield.skinId, 0, 'purchase adds ownership without changing appearance');
  assert.equal(app.skinHud.callbacks.equip(4).ok, false, 'unloaded appearance cannot be persisted');
  await app.skinHud.callbacks.prepare(4);
  assert.equal(app.skinHud.callbacks.equip(4).ok, true); assert.equal(app.battlefield.skinId, 4);
  const skin = app.skinHud; skin.open(); skin.pressed = true;
  app.speedRunHud.open(); assert.equal(skin.isOpen, false); assert.equal(skin.pressed, false);
  app.speedRunHud.close(); skin.open(); assert.equal(app.startBoss().ok, true);
  assert.equal(skin.isOpen, false); assert.equal(skin.node.active, false);
  app.onDestroy();
  const restored = h.create(); await restored.start();
  assert.equal(h.calls.initialSkinId, 4, 'saved appearance is passed to initial preparation');
  assert.equal(h.errors.length, 0); assert.equal(restored.battlefield.skinId, 4);
  assert.equal(h.context.__forestGunner.skins.state().selectedId, 4);
  restored.skinHud.pressed = true;
  assert.equal(h.context.__forestGunner.tutorial.replay(), true);
  assert.equal(restored.skinHud, undefined); assert.equal(h.calls.skinDestroyed, 2);
  restored.onDestroy();
});

test('Bootstrap owns partial HUD nodes even when the GameHud constructor throws before assignment', async () => {
  const h = bootstrapHarness({ failHudImage: true }), app = h.create(); await app.start();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0][1].message, /HUD image failure/);
  assert.equal(app.hud, undefined); assert.equal(app.hudRoot, undefined); assert.equal(app.ready, false);
  const hudRoot = h.nodes.find(node => node.name === 'GameInterface');
  assert.ok(hudRoot); assert.ok(hudRoot.children.length > 0, 'failure must leave a partially constructed HUD to clean up');
  const cover=app.startupInputBlock;
  assert.ok(cover?.isValid,'startup failure retains its opaque retry page');
  const belongsToCover=node=>node===cover||!!(node.parent&&belongsToCover(node.parent));
  const owned = h.nodes.filter(node => node !== app.node && node.name !== 'Camera' && !belongsToCover(node));
  for (const node of owned) { assert.equal(node.isValid, false, node.name); assert.equal(node.destroyCalls, 1, node.name); }
  assert.equal(cover.getChildByName('StartGameButton'),undefined,'failure retains only the retry page');
  assert.equal(app.startupEntryReady,false);
  assert.equal(h.calls.battlefieldDestroyed, 1); assert.equal(h.calls.colorsDestroyed, 1);
  assert.equal(app.world.paused, true); assert.equal(app.world.provider, null);
  assert.match(app.loading.getComponent(h.cc.Label).string, /资源加载失败：创建战场\n.*HUD image failure\n点击这里重试/);
  app.onDestroy();
  assert.equal(cover.isValid,false);assert.equal(cover.destroyCalls,1);
  assert.equal(h.calls.battlefieldDestroyed, 1); assert.equal(h.calls.colorsDestroyed, 1);
});

test('Destroying an older Bootstrap cannot remove the newer instance diagnostic API', async () => {
  const h = bootstrapHarness(), old = h.create(), current = h.create();
  await old.start(); const oldApi = h.context.__forestGunner;
  await current.start(); const currentApi = h.context.__forestGunner;
  assert.notEqual(oldApi, currentApi); old.onDestroy(); assert.equal(h.context.__forestGunner, currentApi);
  current.onDestroy(); assert.equal(h.context.__forestGunner, undefined);
  assert.equal(h.cc.game.listeners.length, 0); assert.equal(h.cc.view.listeners.length, 0);
});

test('main tutorial presentation follows the actual session, lifecycle and modal state', async () => {
  const h = bootstrapHarness(), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  const tutorial = app.tutorialHud;
  assert.equal(tutorial.updates.at(-1).state.step, 'upgrade');
  assert.equal(tutorial.updates.at(-1).targets.canUpgrade, false);
  assert.equal(app.rebirthHud.contentBlocked, true);
  app.world.trees = [{ id: 7, degree: 1, alive: false, reward: require('./.build/core/index.js').DecimalAmount.from(1000) }];
  app.world.events = [{ type: 'treeDied', treeId: 7, position: { x: 0, z: 0 } }];
  app.update(0); app.update(.05);
  assert.equal(tutorial.updates.at(-1).targets.canUpgrade, true);
  assert.equal(app.purchaseUpgrade('power'), true); app.update(0);
  assert.equal(tutorial.updates.at(-1).state.step, 'upgrade');
  assert.equal(tutorial.updates.at(-1).targets.canUpgrade, true, 'continue power hints until the shared weapon/challenge unlock');
  assert.equal(app.purchaseUpgrade('power'), true);
  assert.equal(app.purchaseUpgrade('power'), true); app.update(0);
  assert.equal(tutorial.updates.at(-1).state.step, 'gunOpen');
  assert.equal(tutorial.updates.at(-1).targets.canUpgrade, false, 'no unrelated upgrade hint after Lv3');
  app.speedRunHud.open(); app.update(0);
  assert.equal(tutorial.updates.at(-1).targets.blocked, true);
  app.speedRunHud.close(); app.update(0);
  assert.equal(tutorial.updates.at(-1).targets.blocked, false);
  h.context.__forestGunner.background(true);
  assert.equal(tutorial.node.active, false, 'hide immediately without waiting for another frame');
  app.update(.1); assert.equal(tutorial.updates.at(-1).targets.blocked, true);
  h.context.__forestGunner.background(false); app.update(0);
  assert.equal(tutorial.updates.at(-1).targets.blocked, false);
  app.onDestroy(); assert.equal(tutorial.node.isValid, false);
});

test('test tutorial replay and exit restart into isolated resumable storage, production omits the controls', async () => {
  const h = bootstrapHarness({ environment: 'test' }), normal = h.create(); await normal.start();
  const normalKey = 'forest-gunner:economy:v3:test';
  assert.equal(h.context.__forestGunner.tutorial.preview, false);
  assert.equal(h.context.__forestGunner.tutorial.state().active, false);
  const originalReload = h.cc.director.loadScene;
  h.cc.director.loadScene = sceneName => {
    assert.equal(normal.ready, false, 'dispose interactive views before engine destroys their nodes');
    assert.equal(normal.weaponsHud, undefined);
    assert.equal(normal.tutorialHud, undefined);
    return originalReload(sceneName);
  };
  assert.equal(h.context.__forestGunner.tutorial.replay(), true);
  h.cc.director.loadScene = originalReload;
  assert.deepEqual(h.cc.director.loads, ['main']);
  assert.equal(h.context.__forestGunner.tutorial.replay(), false, 'ignore duplicate requests while a scene is loading');
  const normalSave = h.cc.sys.localStorage.getItem(normalKey); normal.onDestroy();
  const replay = h.create(); await replay.start();
  assert.equal(h.errors.length, 0);
  assert.equal(h.context.__forestGunner.tutorial.preview, true);
  assert.equal(h.context.__forestGunner.tutorial.state().step, 'upgrade');
  assert.equal(replay.session.weapons.diamonds, 0);
  assert.equal(replay.session.content.isUnlocked('weapons'), false);
  assert.equal(h.context.__forestGunner.tutorial.exitReplay(), true);
  assert.deepEqual(h.cc.director.loads, ['main', 'main']); replay.onDestroy();
  assert.equal(h.cc.sys.localStorage.getItem(normalKey), normalSave);
  const resumed = h.create(); await resumed.start();
  assert.equal(h.context.__forestGunner.tutorial.preview, false);
  assert.equal(h.context.__forestGunner.tutorial.state().active, false);
  assert.equal(resumed.session.weapons.diamonds, normal.session.weapons.diamonds);
  resumed.onDestroy();
  const release = bootstrapHarness(), production = release.create(); await production.start();
  assert.equal(release.context.__forestGunner.tutorial, undefined); production.onDestroy();
});

test('tutorial replay handles missing scenes and reports scene-load failures without touching the normal save', async () => {
  for (const missing of [true, false]) {
    const h = bootstrapHarness({ environment: 'test' }), app = h.create(); await app.start();
    if (missing) h.cc.director.getScene = () => null;
    else h.cc.director.loadScene = () => false;
    const save = h.cc.sys.localStorage.getItem('forest-gunner:economy:v3:test');
    assert.equal(h.context.__forestGunner.tutorial.replay(), false);
    assert.equal(h.cc.sys.localStorage.getItem('forest-gunner:economy:v3:test'), save);
    if (missing) {
      assert.equal(app.ready, true);
      assert.equal(h.cc.sys.localStorage.getItem('forest-gunner:tutorial-preview'), null);
    } else {
      assert.equal(app.loading.getComponent(h.cc.Label).string, '重新开始失败，请重新打开');
      assert.equal(h.errors.length, 1);
    }
    app.onDestroy();
  }
});

test('Bootstrap loads HUD and money assets, drains events once and credits before presenting rewards', async () => {
  const numbers = { testAsset: 'money' }, h = bootstrapHarness({ moneyWait: Promise.resolve(numbers) }), app = h.create();
  await app.start();
  assert.equal(h.errors.length, 0); assert.equal(app.ready, true);
  assert.equal(app.hud.assets, h.assets.hud);
  assert.equal(app.battlefield.assets.burst, h.assets.moneyBurst);
  assert.equal(app.battlefield.assets.numbers, numbers);
  assert.equal(app.hud.state.money.toNumber(), 0); assert.equal(app.hud.state.remainingSeconds, 180);
  const death = { type: 'treeDied', treeId: 7, position: { x: 4, z: 20 }, sourceTime: .01 };
  const events = [{ type: 'hit', treeId: 7, position: { x: 2, z: 19 }, sourceTime: .01,
    damage: 100, health: 0, maxHealth: 450 }, death];
  app.world.trees = [{ id: 7, degree: 1, alive: false, reward:require('./.build/core/index.js').DecimalAmount.from(36) }];
  app.world.events = events;
  const calls = [], consume = app.session.consume.bind(app.session), present = app.battlefield.handleEvents.bind(app.battlefield);
  app.session.consume = (batch, trees) => { calls.push('consume'); assert.equal(batch, events); return consume(batch, trees); };
  app.battlefield.handleEvents = (batch, rewards) => {
    calls.push('present'); assert.equal(batch, events);
    assert.equal(app.session.snapshot(app.world.stats, false).money.toNumber(), 36);
    assert.equal(rewards.length, 1); assert.equal(rewards[0].sourceTime, .01);
    assert.equal(rewards[0].position.x, 4); assert.equal(rewards[0].position.z, 20);
    present(batch, rewards);
  };
  app.update(10); // Initial/resumed frame is discarded before stepping or draining.
  assert.equal(h.calls.steps, 0); assert.equal(h.calls.drains, 0);
  app.update(1/60);
  assert.deepEqual(calls, ['consume', 'present']);
  assert.equal(h.calls.steps, 1); assert.equal(h.calls.drains, 1);
  assert.equal(app.battlefield.eventBatches[0].events, events);
  assert.equal(app.battlefield.updates.length, 1); assert.equal(app.hud.state.money.toNumber(), 36);
  assert.equal(h.context.__forestGunner.snapshot().effects.moneyBurst.pooled, 2);
  app.onDestroy(); assert.equal(h.calls.hudDestroyed, 1);
});

test('Bootstrap shares alerts across panels, advances full elapsed time and clears them on background and disposal', async () => {
  const h = bootstrapHarness({ contentOverrides: { tutorialEnabled: false, thresholds: { mineStage: 1, mineVisibleStage: 1 } } }), app = h.create();
  await app.start(); await drainPreparation(app, app.loadDeferredHud('mine')); app.update(0);
  const alerts = app.alerts;
  assert.equal(app.weaponsHud.alerts, alerts);
  assert.deepEqual(alerts.extent, { width: 720, height: 1280 });
  alerts.show(); app.weaponsHud.open(); app.weaponsHud.close();
  assert.equal(alerts.node.active, true, 'closing a panel does not own the global alert lifetime');
  app.update(1.5);
  assert.equal(alerts.updates.at(-1), 1.5, 'alert timing must not use the combat delta clamp');
  h.context.__forestGunner.background(true);
  assert.equal(alerts.node.active, false); assert.equal(alerts.clears, 1);
  app.update(20); assert.equal(alerts.updates.at(-1), 0);
  h.context.__forestGunner.background(false);
  alerts.show(); app.hud.onRestart(); assert.equal(alerts.node.active, false);
  alerts.show(); h.context.__forestGunner.setMode('Mine'); assert.equal(alerts.node.active, false);
  app.onDestroy(); assert.equal(app.alerts, undefined); assert.equal(alerts.node.destroyCalls, 1);
});

test('Bootstrap shares one SFX owner and advances one audio frame even while a weapon panel or manual pause is active', async () => {
  const h = bootstrapHarness(), app = h.create(); await app.start();
  const sfx = app.sfx;
  assert.ok(sfx && app.battlefield.sfx === sfx && app.weaponsHud.sfx === sfx, 'weapon buttons and all cats share original duplicate suppression');
  app.update(0); app.weaponsHud.open(); app.update(.05);
  assert.deepEqual(sfx.updates, [0, .05]);
  h.context.__forestGunner.pause(); app.update(.1);
  assert.equal(sfx.updates.at(-1), .1, 'the interface sound cooldown still advances during manual pause');
  h.context.__forestGunner.background(true); app.update(30);
  assert.equal(sfx.updates.at(-1), 0, 'background frames do not age sounds by a spurious game delta');
  app.onDestroy();
  assert.equal(app.sfx, undefined); assert.equal(sfx.node.destroyCalls, 1, 'views do not destroy the shared owner twice');
});

test('ordinary upgrade clicks and repeats play the original success sound only for committed purchases', async () => {
  const h = bootstrapHarness({ environment: 'test' }), app = h.create(); await app.start();
  const sounds = []; app.sfx.play = id => sounds.push(id);
  for (const type of ['power', 'speed', 'money', 'power']) assert.equal(app.purchaseUpgrade(type), true);
  assert.deepEqual(sounds, [4, 4, 4, 4]);
  const committed = sounds.length;
  app.weaponsHud.open(); assert.equal(app.purchaseUpgrade('power'), false); app.weaponsHud.close();
  app.togglePause(); assert.equal(app.purchaseUpgrade('power'), false); app.togglePause();
  const D = require('./.build/core/index.js').DecimalAmount;
  const { OriginalInfVal } = require('./.build/session/core/OriginalInfVal.js');
  app.session.gold = OriginalInfVal.fromInt(0); assert.equal(app.purchaseUpgrade('power'), false);
  app.session.gold = OriginalInfVal.fromAmount(D.from('1e2300'), 5); app.session.levels[0] = 10000;
  assert.equal(app.purchaseUpgrade('power'), false);
  assert.equal(sounds.length, committed, 'blocked, unaffordable and max-level attempts remain silent');
  app.onDestroy();
});

test('Bootstrap keeps final-tree effects advancing after completion and freezes them during pause/background', async () => {
  const h = bootstrapHarness(), app = h.create(); await app.start(); app.update(0);
  app.world.trees = [{ id: 0, degree: 0, alive: false, reward:require('./.build/core/index.js').DecimalAmount.from(20) }];
  app.world.stats.complete = true; app.world.stats.kills = 30; app.world.stats.elapsed = 61.2;
  app.world.events = [{ type: 'treeDied', treeId: 0, sourceTime: 0, position: { x: 0, z: 30 } },
    { type: 'complete', position: { x: 0, z: 20 } }];
  app.update(1/60);
  assert.equal(app.hud.state.complete, true); assert.equal(app.hud.state.money.toNumber(), 20);
  const before = app.world.simulationTime, effects = app.battlefield.updates.length;
  h.context.__forestGunner.pause();
  for (let i = 0; i < 20; i++) app.update(1/60);
  assert.equal(app.world.simulationTime, before); assert.equal(app.battlefield.updates.length, effects);
  assert.equal(app.hud.state.paused, true);
  h.context.__forestGunner.resume(); app.update(20);
  assert.equal(app.world.simulationTime, before, 'resumed long frame is discarded');
  app.update(1/60);
  assert.ok(app.world.simulationTime > before); assert.equal(app.world.stats.elapsed, 61.2);
  assert.equal(app.battlefield.updates.length, effects+1);
  const beforeBackground = app.world.simulationTime;
  h.context.__forestGunner.background(true); app.update(20);
  assert.equal(app.world.simulationTime, beforeBackground);
  h.context.__forestGunner.background(false); app.update(20);
  assert.equal(app.world.simulationTime, beforeBackground);
  app.update(1/60); assert.ok(app.world.simulationTime > beforeBackground);
  assert.equal(app.hud.state.money.toNumber(), 20); app.onDestroy();
});

test('Bootstrap shows original win immediately, keeps reward effects alive and automatically starts the next wave', async () => {
  const h = bootstrapHarness(), app = h.create(); await app.start(); app.update(0);
  app.world.stats.complete = true; app.world.stats.kills = 30;
  app.world.trees = [{id:0,alive:false,reward:require('./.build/core/index.js').DecimalAmount.from(20)}];
  app.world.events=[{type:'complete',position:{x:0,z:0}}];
  app.battlefield.rewardEffectsActive = true;
  app.update(1/60);
  assert.equal(app.hud.state.complete, true, 'combat completion is immediate');
  assert.equal(app.hud.state.stageTransition.kind, 'win');
  assert.equal(app.hud.state.stageTransition.elapsed,0,'settlement does not double-count the win frame');
  h.context.__forestGunner.pause(); app.update(1/60);
  assert.equal(app.hud.state.stageTransition.elapsed,0);
  h.context.__forestGunner.resume(); app.update(1/60);
  for(let i=0;i<120;i++)app.update(1/60);
  assert.equal(app.session.phase,'loading');
  assert.equal(app.worldRoundId,1);
  for(let i=0;i<90;i++)app.update(1/60);
  assert.equal(app.session.phase,'reveal');
  assert.equal(app.worldRoundId,2);
  assert.equal(app.world.stage.waveIndex,1);
  assert.equal(app.battlefield.resets,1);
  assert.equal(app.world.stage.trees.length,60);
  for(let i=0;i<12;i++)app.update(1/60);
  assert.equal(app.session.phase,'playing');
  assert.equal(app.hud.state.stageTransition,undefined);
  app.onDestroy();
});

test('Mine placement advances retained global shots only in foreground and clamps the last combat frame', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create();
  await app.start(); await drainPreparation(app, app.loadDeferredHud('mine')); app.update(0);
  const world = app.world;
  assert.equal(world.fire(), true);
  const shot = world.bullets.find(b => b.active && b.damaging);
  world.bulletTimeouts.set(shot.id, world.simulationTime + .05);
  h.context.__forestGunner.setMode('Mine');
  const before = world.simulationTime;
  app.update(.1);
  assert.ok(world.simulationTime > before); assert.equal(shot.damaging, false, 'old Main shot expires while Mine is still sampling');
  assert.equal(app.session.getMineState().phase, 'entering');
  const pausedTime = world.simulationTime;
  app.onHide(); app.update(30); assert.equal(world.simulationTime, pausedTime);
  app.onShow(); app.update(30); assert.equal(world.simulationTime, pausedTime);
  app.update(.1); assert.ok(world.simulationTime > pausedTime, 'loading resumes global effects after the first resumed frame');
  for (let i = 0; i < 500 && app.session.getMineState().phase === 'entering'; i++) { app.update(.05); await Promise.resolve(); }
  assert.equal(app.session.getMineState().phase, 'playing');
  app.session.mine.remaining = .01;
  const originalStep = world.step.bind(world), deltas = [];
  world.step = dt => { deltas.push(dt); originalStep(dt); };
  app.update(.25);
  assert.deepEqual(deltas, [.01]); assert.equal(app.session.getMineState().phase, 'result');
  const reward = app.session.weapons.diamonds; app.update(.25);
  assert.equal(deltas.length, 1); assert.equal(app.session.weapons.diamonds, reward);
  app.onDestroy();
});

test('Bootstrap enters Mine through loading, pauses in background and restarts preserve session balance', async () => {
  const h = bootstrapHarness({ contentOverrides: { tutorialEnabled: false, thresholds: { mineStage: 1, mineVisibleStage: 1 } } }), app = h.create();
  await app.start(); await drainPreparation(app, app.loadDeferredHud('mine')); app.update(0);
  const earn = () => {
    app.world.trees = [{ id: 0, degree: 1, alive: false, reward:require('./.build/core/index.js').DecimalAmount.from(36) }];
    app.world.events = [{ type: 'treeDied', treeId: 0, sourceTime: app.world.simulationTime, position: { x: 0, z: 10 } }];
    app.update(1/60);
  };
  earn(); assert.equal(app.hud.state.money.toNumber(), 36);
  const steps = h.calls.steps;
  h.context.__forestGunner.setMode('Mine');
  assert.equal(app.session.mode, 'Mine'); assert.equal(app.session.getMineState().phase, 'entering');
  assert.equal(app.battlefield.battlefieldActive, false); assert.equal(app.session.canFight, false);
  h.context.__forestGunner.background(true); app.update(10);
  assert.equal(h.calls.steps, steps); assert.equal(app.session.getMineState().loadingElapsed, 0);
  h.context.__forestGunner.background(false);
  for (let i = 0; i < 500 && app.session.getMineState().phase === 'entering'; i++) { app.update(.05); await Promise.resolve(); }
  assert.equal(app.session.getMineState().phase, 'playing'); assert.equal(app.world.stage.mapLayout, 'mine');
  assert.equal(app.session.getMineState().oreCountMax, app.world.stage.ores.length);
  h.context.__forestGunner.background(true); const remaining = app.session.getMineState().timeRemaining; app.update(10);
  assert.equal(app.session.getMineState().timeRemaining, remaining); h.context.__forestGunner.background(false);
  h.context.__forestGunner.setMode('Main');
  assert.equal(app.session.getMineState().phase, 'exiting');
  for (let i = 0; i < 80 && app.session.mode === 'Mine'; i++) { app.update(.05); await Promise.resolve(); }
  assert.equal(app.session.mode, 'Main'); assert.equal(app.session.getMineState().usedEntries, 1);
  assert.equal(app.hud.state.money.toNumber(), 36);
  const resets = app.battlefield.resets;
  app.hud.onRestart();
  assert.equal(app.world.simulationTime, 0); assert.equal(app.battlefield.resets, resets + 1);
  assert.equal(app.hud.state.kills, 0); assert.equal(app.hud.state.remainingSeconds, 180);
  assert.equal(app.hud.state.money.toNumber(), 36);
  app.update(0); earn(); assert.equal(app.hud.state.money.toNumber(), 72, 'new round permits reused tree IDs');
  app.onDestroy();
  const fresh = h.create(); await fresh.start();
  assert.equal(fresh.hud.state.money.toNumber(), 72, 'the browser storage adapter retains the wallet across Bootstrap instances');
  fresh.onDestroy();
});

test('challenge loads by warping once, preserves global FX and returns through a fresh Main round', async () => {
  const h = bootstrapHarness({ realWorld: true, contentOverrides: { thresholds: { challengePowerLevel: 0 } } }), app = h.create(); await app.start(); app.update(0);
  const world = app.world, mainRound = app.session.roundId, mainTrees = world.trees.slice();
  world.fire(); world.drainEvents();
  const shot = world.bullets.find(bullet => bullet.active), clock = world.simulationTime;
  assert.ok(shot);
  app.battlefield.rewardEffectsActive = true;
  assert.equal(app.startSpeedRun().ok, true);
  assert.equal(app.session.getSpeedRunState().phase, 'entering');
  assert.equal(world.player.position.x, -100, 'source Warp runs before the loading wait');
  assert.equal(world.bullets[shot.id], shot); assert.equal(shot.active, true);
  assert.equal(world.simulationTime, clock); assert.equal(app.battlefield.hasActiveRewards, true);
  assert.equal(app.session.roundId > mainRound, true);
  const map = world.stage, resets = app.battlefield.resets;
  for (let i = 0; i < 90; i++) app.update(1 / 60);
  assert.equal(app.session.getSpeedRunState().phase, 'playing');
  assert.equal(world.stage, map); assert.equal(app.battlefield.resets, resets, 'loading completion only starts combat');
  assert.equal(world.combatStopped, false); assert.equal(app.hud.loadingElapsed, null);
  app.update(1 / 60); assert.equal(app.hud.modalOpen, false, 'ordinary challenge still allows upgrade cards');
  const challengeId = app.session.roundId;
  assert.equal(app.exitSpeedRun().ok, true);
  assert.equal(world.isBattlefieldActive, false); assert.equal(app.battlefield.battlefieldActive, false);
  assert.equal(app.battlefield.hasActiveRewards, true, 'hiding a map does not destroy reward FX');
  for (let i = 0; i < 90; i++) app.update(1 / 60);
  assert.equal(app.session.mode, 'Main'); assert.equal(app.session.roundId > challengeId, true);
  assert.equal(world.isBattlefieldActive, true); assert.equal(world.player.position.x, 0);
  assert.equal(world.stats.kills, 0); assert.equal(app.hud.state.remainingSeconds, 180);
  assert.ok(world.trees.every(tree => tree.alive)); assert.notEqual(world.trees[0], mainTrees[0]);
  assert.equal(app.hud.loadingElapsed, 1.5, 'Main starts under the last .2 s of loading');
  for (let i = 0; i < 12; i++) app.update(1 / 60);
  assert.equal(app.hud.loadingElapsed, null); assert.equal(app.hud.modalOpen, false);
  app.onDestroy();
});

test('Color pipeline teardown restores camera visibility and releases each owned resource once', () => {
  const { cc, colorMath, artModule, materials } = engineStub();
  const { OriginalColorPipeline } = loadScript('view/OriginalColorPipeline', { cc, './ArtLibrary': artModule, './OriginalColorMath': colorMath });
  const parent = artModule.makeNode('Canvas'), camera = artModule.makeNode('MainCamera', parent).addComponent(cc.Camera);
  const visibility = camera.visibility, effects = [new cc.EffectAsset(), new cc.EffectAsset()];
  const art = {}, pipeline = new OriginalColorPipeline(parent, camera, art, effects);
  assert.equal(camera.visibility & colorMath.ORIGINAL_WORLD_LAYER, 0); assert.equal(materials.length, 4);
  assert.equal(art.linearBowMaterial, undefined);
  assert.equal(art.linearSpriteMaterial.options.defines, undefined);
  assert.equal(art.linearCrossbowMaterial, undefined, 'authored weapon frames need no extra outline material');
  assert.equal(art.linearSpriteMaterial.properties.size, 0, 'weapon dimensions never mutate the common sprite material');
  const resources = [pipeline.frame, pipeline.texture, ...materials];
  const nodes = [pipeline.world, pipeline.camera.node, pipeline.output.node];
  pipeline.destroy(); pipeline.destroy();
  assert.equal(camera.visibility, visibility); assert.equal(pipeline.camera.targetTexture, null);
  for (const resource of resources) assert.equal(resource.destroyCalls, 1);
  for (const node of nodes) assert.equal(node.destroyCalls, 1);
  assert.equal(camera.node.isValid, true); assert.equal(parent.isValid, true);
  for (const effect of effects) assert.equal(effect.destroyCalls, 0, 'loaded engine assets are not pipeline-owned');
});

test('Color pipeline releases GPU resources after engine destruction has cleared component node references', () => {
  const { cc, colorMath, artModule, materials } = engineStub();
  const { OriginalColorPipeline } = loadScript('view/OriginalColorPipeline', { cc, './ArtLibrary': artModule, './OriginalColorMath': colorMath });
  const parent = artModule.makeNode('Canvas'), camera = artModule.makeNode('MainCamera', parent).addComponent(cc.Camera);
  const pipeline = new OriginalColorPipeline(parent, camera, {}, [new cc.EffectAsset(), new cc.EffectAsset()]);
  const cameraNode = pipeline.camera.node, outputNode = pipeline.output.node;
  parent.destroy();
  assert.equal(pipeline.camera.node, null); assert.equal(pipeline.output.node, null); assert.equal(camera.isValid, false);
  assert.doesNotThrow(() => { pipeline.destroy(); pipeline.destroy(); });
  for (const resource of [pipeline.frame, pipeline.texture, ...materials]) assert.equal(resource.destroyCalls, 1);
  assert.equal(cameraNode.destroyCalls, 1); assert.equal(outputNode.destroyCalls, 1); assert.equal(pipeline.world.destroyCalls, 1);
});

test('Color pipeline constructor releases partial resources on every material initialization failure', () => {
  for (let failMaterialAt = 1; failMaterialAt <= 4; failMaterialAt++) {
    const { cc, colorMath, artModule, materials, assets, nodes } = engineStub({ failMaterialAt });
    const { OriginalColorPipeline } = loadScript('view/OriginalColorPipeline', { cc, './ArtLibrary': artModule, './OriginalColorMath': colorMath });
    const parent = artModule.makeNode('Canvas'), camera = artModule.makeNode('MainCamera', parent).addComponent(cc.Camera);
    const visibility = camera.visibility, effects = [new cc.EffectAsset(), new cc.EffectAsset()];
    const art = { linearSpriteMaterial: {}, linearGraphicsMaterial: {}, originalHealthFillMaterial: {} }, previous = { ...art };
    assert.throws(() => new OriginalColorPipeline(parent, camera, art, effects), /material initialization failure/);
    assert.equal(materials.length, failMaterialAt); assert.equal(camera.visibility, visibility); assert.deepEqual(art, previous);
    const owned = assets.filter(asset => !effects.includes(asset));
    assert.equal(owned.length, failMaterialAt + 2, 'partially initialized frame and texture are owned too');
    for (const asset of owned) assert.equal(asset.destroyCalls, 1);
    for (const effect of effects) assert.equal(effect.destroyCalls, 0);
    for (const node of nodes) if (node !== parent && node !== camera.node) assert.equal(node.destroyCalls, 1);
    assert.ok(parent.isValid); assert.ok(camera.isValid);
  }
});

test('Color pipeline output creation failure restores visibility and destroys the already bound render target', () => {
  const { cc, colorMath, artModule, materials, assets, nodes } = engineStub({ failOutputSprite: true });
  const { OriginalColorPipeline } = loadScript('view/OriginalColorPipeline', { cc, './ArtLibrary': artModule, './OriginalColorMath': colorMath });
  const parent = artModule.makeNode('Canvas'), camera = artModule.makeNode('MainCamera', parent).addComponent(cc.Camera);
  const visibility = camera.visibility, effects = [new cc.EffectAsset(), new cc.EffectAsset()], art = {};
  assert.throws(() => new OriginalColorPipeline(parent, camera, art, effects), /output sprite failure/);
  assert.equal(materials.length, 4); assert.equal(camera.visibility, visibility); assert.deepEqual(art, {});
  const renderCamera = nodes.find(node => node.name === 'OriginalWorldCamera').getComponent(cc.Camera);
  assert.equal(renderCamera.targetTexture, null);
  for (const asset of assets) assert.equal(asset.destroyCalls, effects.includes(asset) ? 0 : 1);
  const owned = nodes.filter(node => node !== parent && node !== camera.node);
  assert.ok(owned.some(node => node.name === 'OriginalWorldPresentation'));
  for (const node of owned) assert.equal(node.destroyCalls, 1, node.name);
  assert.ok(parent.isValid); assert.ok(camera.isValid);
});

test('Map initialization failure leaves its material owned by the partial node for parent teardown', () => {
  const { cc, artModule, materials, nodes } = engineStub({ failMaterialAt: 1 });
  const { OriginalMapView } = loadScript('view/OriginalMapView', { cc, './ArtLibrary': artModule,
    '../core': { projectWorld: value => ({ x: value.x, y: value.z }) } });
  const parent = artModule.makeNode('World');
  assert.throws(() => new OriginalMapView({}, {}, parent), /material initialization failure/);
  assert.equal(materials.length, 1); assert.equal(materials[0].destroyCalls, 0);
  parent.destroy(); parent.destroy();
  assert.equal(materials[0].destroyCalls, 1);
  assert.equal(nodes.find(node => node.name === 'OriginalStageMap').destroyCalls, 1);
});

test('Map loading allocates no GPU material; each map instance releases its own material with its node', async () => {
  const { cc, artModule, materials } = engineStub();
  const { OriginalMapView } = loadScript('view/OriginalMapView', { cc, './ArtLibrary': artModule,
    '../core': { projectWorld: value => ({ x: value.x, y: value.z }) } });
  const art = new artModule.ArtLibrary();
  const map = { version: 1, sprites: { ground: { path: 'ground', sizeUnits: [1, 1], anchor: [0, 0] } },
    ground: { position: [0, 0], axisX: [1, 0], axisY: [0, 1], repeat: [18, 18], uvOffset: [0, 0],
      sortingOrder: -32, color: [255, 255, 255, 255], lighting: { effect: 'floor', irradiance: [1, 1, 1] } },
    borders: [], fills: [], camera: { halfHeight: 40, projectedOffset: [0, 0] } };
  const stages = { version: 1, skins: Array.from({ length: 10 }, () => ({ sprites: map.sprites, fillColors: {} })),
    treeSprites: Array.from({ length: 40 }, () => map.sprites.ground),
    normal: { healthBar: { background: map.sprites.ground, fill: map.sprites.ground } },
    boss: { healthBar: { background: map.sprites.ground, fill: map.sprites.ground } } };
  art.catalog = {};
  art.json = async name => name === 'art/stages/config' ? stages : map;
  const texture = new cc.Texture2D(), frame = new cc.SpriteFrame(), effect = new cc.EffectAsset();
  frame.texture = texture; frame.rect = { x: 0, y: 0, width: 512, height: 512 }; frame.rotated = false;
  let effectLoads = 0;
  cc.resources.load = (name, Type, callback) => {
    if (Type === cc.SpriteFrame) callback(null, frame);
    else { assert.equal(Type, cc.EffectAsset); effectLoads++; callback(null, effect); }
  };
  const definition = await OriginalMapView.load(art);
  assert.equal(materials.length, 0); assert.equal(effectLoads, 1);
  const parent = artModule.makeNode('World'), first = new OriginalMapView(art, definition, parent);
  const second = new OriginalMapView(art, definition, parent);
  assert.equal(materials.length, 2); assert.notEqual(first.material, second.material);
  first.destroy(); assert.equal(first.material.destroyCalls, 1); assert.equal(second.material.destroyCalls, 0);
  parent.destroy(); second.destroy(); assert.equal(first.material.destroyCalls, 1); assert.equal(second.material.destroyCalls, 1);
  assert.equal(texture.destroyCalls, 0); assert.equal(frame.destroyCalls, 0); assert.equal(effect.destroyCalls, 0);
});

test('All ten map borders stay resident while the camera moves; mode and battlefield hiding still win', () => {
  const { cc, artModule, nodes } = engineStub();
  const core = require('./.build/core/index.js');
  const { OriginalMapView } = loadScript('view/OriginalMapView', { cc, './ArtLibrary': artModule, '../core': core });
  const definition = structuredClone(require('../assets/resources/art/maps/forest/map.json'));
  definition.skins = require('../assets/resources/art/stages/config.json').skins;
  const art = new artModule.ArtLibrary();
  for (const sprites of [definition.sprites, ...definition.skins.map(skin => skin.sprites)]) {
    for (const spec of Object.values(sprites)) {
      const frame = new cc.SpriteFrame(), texture = new cc.Texture2D();
      [texture.width, texture.height] = spec.sizePx;
      frame.texture = texture; frame.rotated = false;
      frame.rect = { x: 0, y: 0, width: texture.width, height: texture.height };
      art.frames.set(spec.path, frame);
    }
  }
  const map = new OriginalMapView(art, definition, artModule.makeNode('World'));
  const borders = map.spriteItems.filter(item => item.asset !== 'ground');
  const strip = borders.map(item => item.node);
  const appearances = new Map(borders.map(item => {
    const sprite = item.node.getComponent(cc.Sprite);
    return [item.node, { color: sprite.color, material: sprite.customMaterial }];
  }));
  assert.equal(strip.length, 48); assert.equal(map.fillItems.length, 24);
  assert.ok(borders.every(item => !item.node.getComponent(cc.Sprite).mapBorderMesh),
    'the unchanged initial skin retains the ordinary sprite geometry');
  const nodeCount = nodes.length;
  const meshes = new Set();
  let visibilityChanges = 0;
  for (const node of strip) {
    let active = node.active;
    Object.defineProperty(node, 'active', { get: () => active, set: value => {
      if (active !== value) visibilityChanges++;
      active = value;
    } });
  }
  for (let skinIndex = 0; skinIndex < 10; skinIndex++) {
    map.setBattlefield({ skinIndex, mapLayout: 'main', mapOrigin: { x: 0, z: 0 } });
    for (const aspect of [9 / 20, 9 / 16, 4 / 3]) {
      for (let z = -27; z <= 308; z += 5) {
        for (const x of [-27.5, 0, 27.5]) {
          map.updateCamera(map.cameraCenter({ x, z }), 40 * aspect);
          assert.ok(strip.every(node => node.active), `skin ${skinIndex}, ${aspect}, (${x}, ${z})`);
        }
      }
    }
    for (const item of borders) {
      const sprite = item.node.getComponent(cc.Sprite), mesh = sprite.mapBorderMesh;
      assert.equal(sprite.spriteFrame,
        art.frames.get(definition.skins[skinIndex].sprites[item.asset].path));
      assert.equal(sprite.color, appearances.get(item.node).color, 'seam projection preserves the authored wall tint');
      assert.equal(sprite.customMaterial, appearances.get(item.node).material, 'seam projection retains the shared wall material');
      assert.equal(!!mesh, skinIndex > 0 && item.asset === 'borderUp',
        `skin ${skinIndex}: only the upper wall needs a persistent seam mesh`);
      if (mesh) {
        meshes.add(mesh); assert.ok(mesh.updates > 0);
        const spec = definition.skins[skinIndex].sprites[item.asset];
        const bent = mesh.geometry.positions.some((point, index) =>
          Math.abs(point[1] - (mesh.geometry.uv[index][1] - spec.anchor[1]) * spec.sizeUnits[1]) > 1e-8);
        assert.equal(bent, [1, 6, 9].includes(skinIndex),
          `skin ${skinIndex}: corrected and ordinary skins must replace the previous deformation`);
      }
      assert.deepEqual(item.node.position, { x: item.basis.position[0], y: item.basis.position[1], z: 0 },
        'updating projected mesh data must restore the authored map position');
      assert.ok(Math.abs(item.node.scale.x - Math.hypot(...item.basis.axisX)) < 1e-10);
      assert.ok(Math.abs(item.node.scale.y - Math.hypot(...item.basis.axisY)) < 1e-10);
    }
    for (const upper of borders.filter(item => item.asset === 'borderUp')) {
      for (const lower of borders.filter(item => item.asset === 'borderDown')) {
        const a = upper.visible, b = lower.visible;
        assert.ok(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY,
          `skin ${skinIndex}: grouping border textures must not reorder overlapping geometry`);
      }
    }
  }
  const ordered = borders[0].node.parent.children.map(node => borders.find(item => item.node === node).asset);
  assert.equal(ordered.filter((asset, index) => index && asset !== ordered[index - 1]).length, 1,
    'resident borders use two contiguous texture groups');
  assert.equal(visibilityChanges, 0, 'camera movement and skin changes never recycle border render data');
  assert.equal(nodes.length, nodeCount, 'the same finite strip is reused across every stage');
  assert.equal(meshes.size, 24, 'skin changes reuse one mesh for each upper wall');
  map.updateCamera({ x: 1e6, y: 1e6 }, 1, 1);
  assert.equal(map.spriteItems.find(item => item.asset === 'ground').node.active, false, 'ground still uses camera culling');
  assert.ok(map.fillItems.every(item => !item.graphics.node.active), 'offscreen fills still use camera culling');
  assert.ok(strip.every(node => node.active));
  const camera = map.cameraCenter({ x: 0, z: 40 });
  map.setBattlefield({ skinIndex: 6, mapLayout: 'arena' });
  map.updateCamera(camera, 22.5);
  assert.ok(strip.every(node => !node.active), 'challenge still hides all main-map borders');
  assert.ok(map.fillItems.every(item => !item.graphics.node.active), 'challenge still hides all main-map fills');
  map.setBattlefield({ skinIndex: 6, mapLayout: 'main', mapOrigin: { x: 5, z: 10 } });
  map.updateCamera(camera, 22.5);
  assert.ok(strip.every(node => node.active), 'returning from challenge restores the whole strip');
  const offset = core.projectWorld({ x: 5, z: 10 });
  for (const item of borders) assert.deepEqual(item.node.position,
    { x: item.basis.position[0] + offset.x, y: item.basis.position[1] + offset.y, z: 0 },
    'corrected borders follow the map origin when returning from an arena');
  for (const mode of ['raid', 'boss', 'hunt', 'mine']) {
    const visuals = require(`../assets/resources/art/${mode}-system/visuals.json`);
    art.catalog[mode] = visuals;
    const texture = new cc.Texture2D(), frame = new cc.SpriteFrame();
    [texture.width, texture.height] = visuals.ground.sizePx;
    frame.texture = texture; frame.rotated = false;
    frame.rect = { x: 0, y: 0, width: texture.width, height: texture.height };
    art.frames.set(visuals.ground.path, frame);
    map.setBattlefield({ skinIndex: 1, mapLayout: mode, mapOrigin: { x: -100, z: 0 } });
    assert.ok(strip.every(node => !node.active), `${mode} hides corrected main-map walls`);
    assert.equal(map.spriteItems[0].node.getComponent(cc.Sprite).spriteFrame, frame);
    assert.equal(map.spriteItems[0].node.getComponent(cc.Sprite).mapBorderMesh, undefined,
      `${mode} keeps the existing repeating ground renderer`);
    map.setBattlefield({ skinIndex: 9, mapLayout: 'main' });
    assert.ok(strip.every(node => node.active), `${mode} restores corrected main-map walls`);
    for (const item of borders.filter(item => item.asset === 'borderUp')) {
      assert.ok(meshes.has(item.node.getComponent(cc.Sprite).mapBorderMesh));
    }
  }
  map.setBattlefieldActive(false);
  map.setStage(7); map.updateCamera(camera, 18);
  assert.ok(map.visibleItems.every(item => !item.node.active), 'hidden battlefields stay hidden after skin/camera changes');
  map.setBattlefieldActive(true); map.updateCamera(camera, 18);
  assert.ok(strip.every(node => node.active));
  map.destroy();
});

test('Weapon popup keeps battle stepping, mutes shots and blocks global upgrades until closed', async () => {
  const h = bootstrapHarness(), app = h.create(); await app.start();
  assert.equal(app.ready, true, JSON.stringify(h.errors));
  app.update(0); const before = h.calls.steps;
  app.weaponsHud.open(); app.update(1 / 60);
  assert.equal(app.battlefield.muted, true); assert.equal(app.hud.modalOpen, true);
  assert.equal(h.calls.steps, before + 1); assert.equal(app.world.paused, false);
  assert.equal(app.purchaseUpgrade('power'), false);
  app.weaponsHud.close(); assert.equal(app.battlefield.muted, false);
  app.onDestroy();
});

test('Weapon mutations synchronize only changed loadouts immediately; test commands are absent in production', async () => {
  const h = bootstrapHarness({ contentOverrides: { adsEnabled: true, tutorialEnabled: false, thresholds: { challengePowerLevel: 0 } } }), app = h.create(); await app.start();
  assert.equal(h.context.__forestGunner.weapons, undefined);
  assert.equal(h.context.__forestGunner.content, undefined);
  const initial = h.calls.loadouts;
  app.session.weapons.recordStageValue(390); assert.equal(h.calls.loadouts, initial);
  app.session.weapons.beginAd('daily');
  app.session.weapons.completeAd(app.session.weapons.snapshot().pendingAd.token, 'success');
  assert.equal(h.calls.loadouts, initial, 'adding a backpack gun must not reset gun actors');
  assert.equal(app.session.weapons.equip(0, 2).ok, true);
  assert.equal(h.calls.loadouts, initial + 1); assert.equal(app.world.loadout.length, 2);
  app.onDestroy();
});

test('Backgrounding cancels an unfinished weapon ad and preserves wallet without rewarding', async () => {
  const h = bootstrapHarness({ contentOverrides: { adsEnabled: true, tutorialEnabled: false, thresholds: { dailyAdWeaponStage: 1, challengePowerLevel: 0 } } }), app = h.create(); await app.start();
  const balance = app.session.weapons.diamonds;
  const started = app.session.weapons.beginAd('daily'); assert.equal(started.ok, true);
  app.onHide();
  assert.equal(app.session.weapons.snapshot().pendingAd, null);
  assert.equal(app.session.weapons.snapshot().backpack.filter(Boolean).length, 0);
  assert.equal(app.session.weapons.completeAd(started.token, 'success').ok, false);
  assert.equal(app.session.weapons.diamonds, balance); assert.equal(app.world.paused, true);
  app.onShow(); assert.equal(app.world.paused, false); app.onDestroy();
});

test('disabled advertising creates no advertisement service or modal in either environment', async () => {
  for (const environment of ['production', 'test']) {
    const h = bootstrapHarness({ environment, contentOverrides: { adsEnabled: false } }), app = h.create(); await app.start();
    assert.equal(h.errors.length, 0); assert.equal(app.ready, true);
    assert.equal(app.rewardedAds, undefined); assert.equal(app.rewardedAdModal, undefined);
    assert.equal(h.nodes.some(node => node.name === 'RewardedAdModal'), false);
    assert.equal(app.session.getRebirthState().adEnabled, false);
    assert.equal(app.session.getSpeedRunState().adEnabled, false);
    assert.equal(app.session.getContentState('dailyAdWeapon').reason, 'adsDisabled');
    assert.equal(app.session.weapons.beginAd('daily').ok, false);
    assert.equal(app.session.weapons.snapshot().pendingAd, null);
    app.onDestroy();
  }
});

test('production advertisements explicitly enabled cannot expose simulated success or grant a reward without an SDK', async () => {
  const h = bootstrapHarness({ contentOverrides: { adsEnabled: true, tutorialEnabled: false, thresholds: { dailyAdWeaponStage: 1, challengePowerLevel: 0 } } }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); assert.equal(app.rewardedAdModal, undefined);
  assert.ok(app.rewardedAds); const begun = app.session.weapons.beginAd('daily'); assert.equal(begun.ok, true);
  let outcome;
  app.rewardedAds.showRewardedAd(begun.token, 'weapon-daily', result => {
    outcome = result; app.session.weapons.completeAd(begun.token, result);
  });
  assert.equal(outcome, 'failure'); assert.equal(app.rewardedAds.isPresenting, false);
  assert.equal(app.session.weapons.snapshot().pendingAd, null);
  assert.equal(app.session.weapons.snapshot().backpack.filter(Boolean).length, 0);
  assert.equal(app.session.weapons.snapshot().dailyAdAvailable, true); app.onDestroy();
});

test('test-only diagnostics report content policy and refill resources without enabling advertising', async () => {
  const h = bootstrapHarness({ environment: 'test', contentOverrides: { adsEnabled: false } }), app = h.create(); await app.start();
  assert.equal(h.errors.length, 0); const api = h.context.__forestGunner.content;
  assert.equal(api.state('rebirth').unlocked, true); assert.equal(api.state('rebirthAd').visible, false);
  assert.equal(app.session.weapons.configureTest({ diamonds: 0, starGems: 0 }).ok, true);
  assert.equal(api.refillResources(), true);
  assert.equal(app.session.weapons.diamonds, app.session.content.config.testResources.diamonds);
  assert.equal(app.session.weapons.starGems, app.session.content.config.testResources.starGems);
  assert.equal(app.rewardedAdModal, undefined); assert.equal(app.session.getRebirthState().adEnabled, false);
  app.onDestroy();
});

test('one shared ad modal pauses combat, cancels on background and rejects its stale completion', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test', contentOverrides: { adsEnabled: true } }), app = h.create(); await app.start(); app.update(0);
  assert.equal(h.errors.length, 0);
  const start = app.session.weapons.beginAd('daily'); assert.equal(start.ok, true);
  app.rewardedAds.showRewardedAd(start.token, 'weapon-daily', outcome => app.session.weapons.completeAd(start.token, outcome));
  const modal = app.rewardedAdModal, staleId = modal.requestId;
  assert.equal(modal.isOpen, true); assert.equal(app.hud.modalOpen, true);
  const elapsed = app.world.simulationTime; app.update(.25);
  assert.equal(app.world.simulationTime, elapsed, 'the common provider pauses all combat while presenting');
  app.onHide(); assert.equal(modal.isOpen, false); assert.equal(app.rewardedAds.isPresenting, false);
  assert.equal(app.session.weapons.snapshot().pendingAd, null);
  modal.onResult(staleId, 'success'); assert.equal(app.session.weapons.snapshot().backpack.filter(Boolean).length, 0);
  app.onShow(); app.update(0); app.update(.1); assert.ok(app.world.simulationTime > elapsed);
  app.manuallyPaused = true;
  const retry = app.session.weapons.beginAd('daily');
  app.rewardedAds.showRewardedAd(retry.token, 'weapon-daily', outcome => app.session.weapons.completeAd(retry.token, outcome));
  modal.onResult(modal.requestId, 'success'); assert.equal(app.session.weapons.snapshot().backpack.filter(Boolean).length, 1);
  assert.equal(app.isPaused, true, 'finishing an ad does not undo an independent manual pause');
  assert.equal(modal.isOpen, false); app.onDestroy(); app.onDestroy();
  assert.equal(modal.node.destroyCalls, 1);
});

function rebirthStorage() {
  const { BattleSession, economyStorageKey } = require('./.build/session/session/BattleSession.js');
  const { WeaponInventory } = require('./.build/session/session/WeaponInventory.js');
  const data = new Map(), writes = [], key = economyStorageKey('production');
  const storage = { getItem: name => data.get(name) ?? null, setItem(name, value) { data.set(name, value); if(name===key)writes.push(JSON.parse(value)); } };
  new BattleSession({ storage });
  const saved = JSON.parse(data.get(key));
  const weapons = new WeaponInventory({ environment: 'test', initialState: saved.weapons });
  for (const slot of [1, 2]) { assert.equal(weapons.grantTestWeapon(slot).ok, true); assert.equal(weapons.equip(0, slot).ok, true); }
  weapons.configureTest({ stageValueMax: 100, starLevels: [1, 2, 3], diamonds: 1234, starGems: 567 });
  saved.weapons = weapons.serialize(); saved.progress = { stageIndex: 2, waveIndex: 0 };
  saved.money = { digits: '1234575', exponent: -2, precision: 7 }; saved.levels = [2, 3, 4];
  saved.rebirth = { ...saved.rebirth, ruby: { digits: '0', exponent: 0, precision: 1 }, levels: [1, 2, 3], count: 7, adUsedDate: '' };
  saved.tutorial = { step: 'done', drawCount: 0 }; saved.speedRun.stage = 1;
  data.set(key, JSON.stringify(saved)); writes.length = 0;
  return { storage, data, writes, key, BattleSession };
}

test('Rebirth HUD callbacks drive a real session/world through FX and rebuild the round in place', async () => {
  const saved = rebirthStorage(), h = bootstrapHarness({ realWorld: true, storage: saved.storage }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  const session = app.session, world = app.world, player = world.player, followers = [...world.followers];
  const preserved = JSON.stringify(session.weapons.serialize()), roundId = app.worldRoundId, writes = saved.writes.length;
  world.attackClock = .137; world.previouslyHadTarget = true;
  followers.forEach((follower, index) => { follower.attackClock = .2 + index * .01; follower.previouslyHadTarget = true; });
  const clocks = [world.attackClock, ...followers.map(follower => follower.attackClock)];
  const rebirthHud = app.rebirthHud;
  rebirthHud.open();
  assert.equal(rebirthHud.isOpen, true); assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  assert.equal(rebirthHud.callbacks.requestRebirth('normal').ok, true);
  assert.equal(world.rebirthStopped, true); assert.equal(world.isPaused, false); assert.equal(session.canFight, false);
  assert.equal(rebirthHud.callbacks.requestRebirth('normal').reason, 'busy');
  assert.equal(app.purchaseUpgrade('power'), false);
  for (let frame = 0; frame < 7; frame++) app.update(.25);
  assert.equal(session.rebirthAnimating, true); assert.equal(session.moneyBalance.toString(), '12345.75');
  assert.equal(app.worldRoundId, roundId); assert.equal(saved.writes.length, writes);
  assert.equal(world.stats.elapsed, 0); assert.equal(world.simulationTime, 1.75, 'visual/physics time advances while battle timers stop');
  app.update(.25);
  assert.equal(app.session, session, 'rebirth does not reconstruct/refund a session'); assert.equal(app.world, world);
  assert.equal(world.player, player); followers.forEach((follower, index) => assert.equal(world.followers[index], follower));
  assert.deepEqual([world.attackClock, ...world.followers.map(follower => follower.attackClock)], clocks);
  assert.equal(world.previouslyHadTarget, true); assert.ok(world.followers.every(follower => follower.previouslyHadTarget));
  assert.ok(world.players.every(actor => actor.targetId === null)); assert.ok(world.bullets.every(bullet => !bullet.active));
  assert.equal(app.worldRoundId, roundId + 1); assert.equal(world.stage.stageIndex, 0); assert.equal(world.stage.waveIndex, 0);
  assert.equal(world.movementMultiplier, 2); assert.equal(session.moneyBalance.toNumber(), 0);
  assert.deepEqual(session.snapshot(world.stats, false).upgrades.map(upgrade => upgrade.level), [0, 0, 0]);
  assert.equal(session.getRebirthState().ruby.toString(), '316.22'); assert.equal(session.getRebirthState().count, 8);
  assert.equal(JSON.stringify(session.weapons.serialize()), preserved); assert.equal(saved.writes.length, writes + 1);
  assert.equal(app.battlefield.resets, 1); assert.equal(app.battlefield.resetOptions[0].preserveCharacterState, true);
  assert.equal(app.battlefield.resetOptions[0].preserveTransientEffects, true);
  assert.equal(rebirthHud.isOpen, false); assert.equal(app.hud.modalOpen, false); assert.equal(app.battlefield.muted, false);
  app.update(.1); assert.equal(session.getRebirthState().count, 8); assert.ok(world.simulationTime > 0);
  app.onDestroy(); app.onDestroy(); assert.equal(h.calls.rebirthDestroyed, 1); assert.equal(rebirthHud.node.destroyCalls, 1);
});

test('Real bootstrap suspends rebirth on hide, discards the resumed delta and saves before/after atomically', async () => {
  const saved = rebirthStorage(), h = bootstrapHarness({ realWorld: true, storage: saved.storage }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  app.rebirthHud.open(); assert.equal(app.rebirthHud.callbacks.requestRebirth('normal').ok, true);
  app.update(.25); app.update(.25);
  const worldTime = app.world.simulationTime, elapsed = app.session.getRebirthState().animationElapsed;
  app.onHide(); app.update(60);
  assert.equal(app.world.isPaused, true); assert.equal(app.world.simulationTime, worldTime);
  assert.equal(app.session.getRebirthState().animationElapsed, elapsed); assert.equal(app.rebirthHud.updates.at(-1), 0);
  const beforeReload = new saved.BattleSession({ storage: saved.storage });
  assert.equal(beforeReload.getRebirthState().phase, 'idle'); assert.equal(beforeReload.getRebirthState().count, 7);
  assert.equal(beforeReload.round.stageIndex, 2); assert.equal(beforeReload.moneyBalance.toString(), '12345.75');
  app.onShow(); app.update(60);
  assert.equal(app.world.isPaused, false); assert.equal(app.world.simulationTime, worldTime);
  assert.equal(app.session.getRebirthState().animationElapsed, elapsed);
  for (let frame = 0; frame < 6; frame++) app.update(.25);
  assert.equal(app.session.getRebirthState().count, 8); assert.equal(app.worldRoundId, app.session.roundId);
  const afterReload = new saved.BattleSession({ storage: saved.storage });
  assert.equal(afterReload.getRebirthState().ruby.toString(), '316.22'); assert.equal(afterReload.getRebirthState().count, 8);
  assert.equal(afterReload.round.stageIndex, 0); assert.equal(afterReload.round.waveIndex, 0); assert.equal(afterReload.moneyBalance.toNumber(), 0);
  app.onDestroy();
});

test('Real bootstrap lets the old loading coroutine resume combat during FX before the final rebirth reset', async () => {
  const saved = rebirthStorage(), h = bootstrapHarness({ realWorld: true, storage: saved.storage }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  const firstRound = app.worldRoundId;
  for (const tree of app.world.trees) tree.alive = false;
  app.world.stats.complete = true; app.world.events.push({ type: 'complete', position: { x: 0, z: 0 } });
  app.update(.01);
  assert.equal(app.session.phase, 'won'); assert.equal(app.session.getRebirthState().reward.toString(), '397.99');
  app.rebirthHud.open(); assert.equal(app.rebirthHud.callbacks.requestRebirth('normal').ok, true);
  for (let frame = 0; frame < 7; frame++) app.update(.25);
  assert.equal(app.session.rebirthAnimating, true); assert.equal(app.worldRoundId, firstRound + 1);
  assert.equal(app.world.stage.waveIndex, 1); assert.equal(app.world.rebirthStopped, false);
  assert.equal(app.world.combatStopped, false); assert.equal(app.session.canFight, true);
  app.update(.1);
  assert.equal(app.session.rebirthAnimating, true); assert.equal(app.world.stats.elapsed, .1, 'world really runs the new round under FX');
  assert.equal(app.session.snapshot(app.world.stats, false).remainingSeconds, 179.9);
  app.update(.15);
  assert.equal(app.worldRoundId, firstRound + 2); assert.equal(app.world.stage.stageIndex, 0); assert.equal(app.world.stage.waveIndex, 0);
  assert.equal(app.session.phase, 'playing'); assert.equal(app.session.getRebirthState().ruby.toString(), '397.99');
  assert.equal(app.battlefield.resets, 2); assert.ok(app.battlefield.resetOptions.every(options => options.preserveCharacterState));
  for (let frame = 0; frame < 8; frame++) app.update(.25);
  assert.equal(app.worldRoundId, firstRound + 2, 'the retired transition cannot return after completion');
  assert.equal(app.world.stage.stageIndex, 0); assert.equal(app.session.getRebirthState().count, 8);
  app.onDestroy();
});

test('Rebirth HUD ad callback is cancelled on background and a fresh success awards only once', async () => {
  const saved = rebirthStorage(), h = bootstrapHarness({ realWorld: true, storage: saved.storage, contentOverrides: { adsEnabled: true } }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  app.rebirthHud.open(); const callbacks = app.rebirthHud.callbacks;
  const stale = callbacks.requestRebirth('ad'); assert.equal(stale.ok, true);
  app.onHide(); assert.equal(app.session.getRebirthState().phase, 'idle');
  assert.equal(callbacks.completeAd(stale.token, 'success').reason, 'staleAd');
  assert.equal(app.session.getRebirthState().ruby.toNumber(), 0); assert.equal(app.session.getRebirthState().adAvailable, true);
  app.onShow(); app.update(0);
  const current = callbacks.requestRebirth('ad'); assert.equal(callbacks.completeAd(current.token, 'success').ok, true);
  assert.equal(app.world.rebirthStopped, true); assert.equal(callbacks.completeAd(current.token, 'success').reason, 'staleAd');
  for (let frame = 0; frame < 8; frame++) app.update(.25);
  assert.equal(app.session.getRebirthState().ruby.toString(), '948.66'); assert.equal(app.session.getRebirthState().count, 8);
  assert.equal(app.session.getRebirthState().adAvailable, false); assert.equal(app.world.stage.stageIndex, 0);
  app.onDestroy();
});

test('Raid bootstrap keeps preparation on main, locks the shared Raid boss enemy through loading and settles before returning', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  const session = app.session, mainRound = session.round, mainTime = app.world.simulationTime;
  app.raidHud.open();
  assert.equal(session.getRaidState().phase, 'preparing'); assert.equal(session.mode, 'Main');
  app.update(.1); assert.ok(app.world.simulationTime > mainTime, 'preparation leaves main running');
  assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  app.raidHud.callbacks.openStarUpgrade(0);
  assert.equal(app.weaponsHud.starSlot, 0); assert.equal(app.raidHud.externalModal, true);
  assert.equal(app.weaponsHud.starPreview(0), session.getRaidStarPreview(0, 0));
  assert.equal(app.raidHud.callbacks.start().ok, false, 'cannot start through the shared star dialog');
  app.weaponsHud.close(); assert.equal(app.raidHud.externalModal, false);
  assert.equal(app.raidHud.callbacks.start().ok, true);
  const boss = session.getRaidBossCombat(), world = app.world, pool = world.bullets;
  assert.equal(session.mode, 'Raid'); assert.equal(session.getRaidState().freeRemaining, 1);
  assert.equal(world.stage.raidBoss, boss); assert.equal(session.canFight, false);
  for (let frame = 0; frame < 7; frame++) app.update(.25);
  assert.equal(session.getRaidState().phase, 'entering'); assert.equal(session.getRaidState().seasonTryCount, 0);
  app.update(.25); assert.equal(session.canFight, true); assert.equal(session.getRaidState().seasonTryCount, 1);
  assert.equal(app.world, world); assert.equal(world.stage.raidBoss, boss); assert.equal(world.bullets, pool);
  const gems = session.weapons.starGems, money = session.moneyBalance.toString();
  boss.hit(boss.maxHealth);
  assert.equal(boss.clearedLevels, 1); assert.equal(boss.health.toString(), boss.maxHealth.toString());
  for (let frame = 0; frame < 240; frame++) app.update(.25);
  assert.equal(session.getRaidState().phase, 'result'); assert.equal(session.canFight, false);
  assert.equal(session.weapons.starGems, gems + 25); assert.equal(session.moneyBalance.toString(), money);
  app.update(.25); assert.equal(session.weapons.starGems, gems + 25, 'settlement cannot replay');
  assert.equal(app.raidHud.callbacks.exit().ok, true);
  assert.equal(app.battlefield.battlefieldActive, false);
  for (let frame = 0; frame < 6; frame++) app.update(.25);
  assert.equal(session.mode, 'Main'); assert.equal(session.round.stageIndex, mainRound.stageIndex);
  assert.equal(session.round.waveIndex, mainRound.waveIndex); assert.equal(session.canFight, true);
  assert.equal(app.modeRevealElapsed, 0); assert.equal(app.hud.loadingElapsed, 1.5);
  app.update(.2); assert.equal(app.modeRevealElapsed, null); assert.equal(app.hud.loadingElapsed, null);
  app.raidHud.open(); assert.equal(app.raidHud.callbacks.claimMission(0).ok, true);
  assert.equal(app.raidHud.callbacks.claimMission(0).ok, false); assert.equal(session.weapons.starGems, gems + 325);
  app.onDestroy();
});

test('Raid bootstrap pauses on background, ignores resumed delta and never settles an abandoned run', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0); app.raidHud.open();
  assert.equal(app.raidHud.callbacks.start().ok, true);
  for (let frame = 0; frame < 8; frame++) app.update(.25);
  const remaining = app.session.getRaidState().remainingSeconds, gems = app.session.weapons.starGems;
  app.onHide(); app.update(60); assert.equal(app.session.getRaidState().remainingSeconds, remaining);
  app.onShow(); app.update(60); assert.equal(app.session.getRaidState().remainingSeconds, remaining);
  app.session.getRaidBossCombat().hit(app.session.getRaidBossCombat().maxHealth);
  assert.equal(app.raidHud.callbacks.exit().ok, true);
  for (let frame = 0; frame < 8; frame++) app.update(.25);
  assert.equal(app.session.mode, 'Main'); assert.equal(app.session.weapons.starGems, gems);
  assert.equal(app.session.getRaidState().seasonBestLevel, 0); assert.equal(app.session.getRaidState().freeRemaining, 1);
  app.onDestroy();
});

test('Boss bootstrap retains one arena through loading and settles diamonds without changing Main progress', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  const session = app.session, mainRound = session.round, wallet = session.weapons.diamonds;
  app.bossHud.open(); assert.equal(session.mode, 'Main'); assert.equal(app.hud.modalOpen, true);
  assert.equal(app.bossHud.callbacks.start().ok, true);
  const boss = app.world.stage.boss, pool = app.world.bullets;
  assert.ok(boss); assert.equal(session.mode, 'Boss'); assert.equal(app.isPaused, false);
  for (let i=0; i<7; i++) app.update(.25);
  assert.equal(session.canFight, false); assert.equal(session.getBossState().phase, 'entering');
  app.update(.25);
  assert.equal(session.canFight, true); assert.equal(app.world.stage.boss, boss); assert.equal(app.world.bullets, pool);
  assert.equal(app.battlefield.muted, false, 'playing Boss is not a popup and must not mute shooting');
  const gold = session.moneyBalance.toString();
  app.world.hitTree(boss, boss.position, boss.maxHealth); app.update(1/60);
  assert.equal(session.getBossState().phase, 'won'); assert.equal(session.weapons.diamonds, wallet+300);
  assert.equal(session.moneyBalance.toString(), gold);
  assert.equal(app.battlefield.eventBatches.at(-1).rewards.length, 0);
  app.update(.25); assert.equal(session.weapons.diamonds, wallet+300);
  assert.equal(app.bossHud.callbacks.exit().ok, true); assert.equal(app.battlefield.battlefieldActive, false);
  for (let i=0; i<6; i++) app.update(.25);
  assert.equal(session.mode, 'Main'); assert.equal(session.round.stageIndex, mainRound.stageIndex);
  assert.equal(session.round.waveIndex, mainRound.waveIndex); assert.equal(app.modeRevealElapsed, 0);
  assert.equal(app.hud.loadingElapsed, 1.5); assert.equal(session.getBossState().stage, 1);
  app.update(.2); assert.equal(app.hud.loadingElapsed, null); assert.equal(app.modeRevealElapsed, null);
  app.onDestroy();
});

test('Boss timeout and background resume preserve progress and award nothing', async () => {
  const h = bootstrapHarness({ realWorld: true, environment: 'test' }), app = h.create();
  await app.start(); assert.equal(h.errors.length, 0); app.update(0);
  app.session.configureBossTest({ stage: 100 });
  const wallet=app.session.weapons.diamonds;
  assert.equal(app.startBoss().ok, true);
  for (let i=0; i<8; i++) app.update(.25);
  const boss=app.world.stage.boss, position={...boss.position};
  app.onHide(); app.update(30); assert.deepEqual(boss.position,position);
  assert.equal(app.session.getBossState().remainingSeconds,60);
  app.onShow(); app.update(30); assert.equal(app.session.getBossState().remainingSeconds,60);
  for (let i=0; i<240; i++) app.update(.25);
  assert.equal(app.session.getBossState().phase,'playing', 'source yields after subtracting through zero');
  app.update(.25); assert.equal(app.session.getBossState().phase,'failed');
  assert.equal(app.session.weapons.diamonds,wallet); assert.equal(app.session.getBossState().stage,100);
  const stopped={...boss.position}; app.update(.25); assert.deepEqual(boss.position,stopped);
  assert.equal(app.exitBoss().ok,true);
  for(let i=0;i<7;i++)app.update(.25);
  assert.equal(app.session.mode,'Main'); assert.equal(app.session.getBossState().stage,100);
  app.onDestroy();
});

test('Boss ad callbacks expire on hide and successful reward immediately disables the arena', async () => {
  const h=bootstrapHarness({realWorld:true,environment:'test',contentOverrides:{adsEnabled:true}}), app=h.create();
  await app.start(); assert.equal(h.errors.length,0); app.update(0); assert.equal(app.startBoss().ok,true);
  for(let i=0;i<8;i++)app.update(.25);
  const boss=app.world.stage.boss; app.world.hitTree(boss,boss.position,boss.maxHealth); app.update(1/60);
  const wallet=app.session.weapons.diamonds, cb=app.bossHud.callbacks, stale=cb.beginAd();
  assert.equal(stale.ok,true); app.onHide(); app.onShow(); app.update(0);
  assert.equal(cb.completeAd(stale.token,'success').reason,'staleAd');
  assert.equal(app.session.weapons.diamonds,wallet);
  const request=cb.beginAd(); assert.equal(request.ok,true);
  assert.equal(cb.completeAd(request.token,'success').ok,true);
  assert.equal(app.session.weapons.diamonds,wallet+600); assert.equal(app.world.battlefieldActive,false);
  assert.equal(app.battlefield.battlefieldActive,false); assert.equal(app.session.getBossState().phase,'exiting');
  assert.equal(cb.completeAd(request.token,'success').reason,'staleAd');
  app.onDestroy();
});
const testHuntClear = app => {
  for (let i=0;i<1500 && app.session.getHuntState().phase==='playing';i++) {
    for (const enemy of app.world.hunt.enemies) if(enemy.alive) app.world.hitTree(enemy,enemy.position,enemy.maxHealth);
    app.update(.1);
  }
  assert.equal(app.session.getHuntState().phase,'clearing');
};

test('Hunt Bootstrap lazily opens original entry and retains cats, pool and projectiles between small levels', async()=>{
  const h=bootstrapHarness({realWorld:true,environment:'test',deferHiddenHuds:true}),app=h.create();
  await app.start();assert.equal(h.errors.length,0);app.update(0);
  assert.equal(app.huntHud,undefined,'full Hunt UI is absent from startup');
  await drainPreparation(app, app.openFeature('hunt'));assert.ok(app.huntHud);assert.equal(app.hud.modalOpen,true);
  const main={...app.session.round},gold=app.session.moneyBalance.toString();
  assert.equal(app.huntHud.callbacks.start().ok,true);
  const world=app.world,hunt=world.hunt,pool=world.bullets,cats=world.players.slice();
  assert.equal(app.session.mode,'Monster');assert.equal(app.isPaused,false);assert.equal(hunt.activeCount,0);
  for(let i=0;i<8;i++)app.update(.25);
  assert.equal(app.session.getHuntState().phase,'playing');assert.equal(app.world,world);assert.equal(world.hunt,hunt);
  assert.equal(app.battlefield.muted,false);assert.ok(hunt.activeCount>0);
  testHuntClear(app);
  assert.equal(app.session.getPetState().coins,30);assert.equal(app.session.getHuntState().level,0);
  assert.equal(app.session.hunt.serialize().level,1,'next uncleared level is saved before clearing animation');
  const positions=world.players.map(cat=>({...cat.position})),resets=app.battlefield.resets;
  for(let i=0;i<8;i++)app.update(.25);
  assert.equal(app.session.getHuntState().phase,'playing');assert.equal(world.hunt,hunt);assert.equal(world.bullets,pool);
  assert.equal(app.battlefield.resets,resets,'small-level progression must not reconstruct/warp battlefield');
  for(let i=0;i<cats.length;i++){
    assert.equal(world.players[i],cats[i]);
    const distance=p=>Math.hypot(p.x+100,p.z);
    assert.ok(distance(world.players[i].position)<=distance(positions[i])+1e-5,'cats continue returning toward center during clear delay');
  }
  assert.equal(app.worldRoundId,app.session.roundId);
  assert.equal(app.giveUpHunt().ok,true);assert.equal(app.session.getHuntState().phase,'failed');
  assert.equal(app.session.getPetState().coins,30);assert.equal(app.session.moneyBalance.toString(),gold);
  assert.equal(app.exitHunt().ok,true);assert.equal(app.battlefield.battlefieldActive,false);
  for(let i=0;i<6;i++)app.update(.25);
  assert.equal(app.session.mode,'Main');assert.equal(app.session.round.stageIndex,main.stageIndex);assert.equal(app.session.round.waveIndex,main.waveIndex);
  assert.equal(app.modeRevealElapsed,0);app.update(.2);assert.equal(app.modeRevealElapsed,null);app.onDestroy();
});

test('Hunt Bootstrap pauses moving monsters in background, fails on invasion and resumes saved level after re-entry',async()=>{
  const h=bootstrapHarness({realWorld:true,environment:'test'}),app=h.create();await app.start();app.update(0);
  assert.equal(app.startHunt().ok,true);for(let i=0;i<8;i++)app.update(.25);
  const hunt=app.world.hunt,enemy=hunt.enemies.find(enemy=>enemy.alive),position={...enemy.position};
  app.onHide();app.update(30);assert.deepEqual(enemy.position,position);
  app.onShow();app.update(30);assert.deepEqual(enemy.position,position);
  enemy.position={x:-100,z:0};app.update(.1);
  assert.equal(app.session.getHuntState().phase,'failed');assert.equal(app.session.getHuntState().hp,0);
  assert.equal(app.session.getPetState().coins,0);
  app.exitHunt();for(let i=0;i<7;i++)app.update(.25);app.update(.2);
  assert.equal(app.startHunt().ok,true);for(let i=0;i<8;i++)app.update(.25);
  assert.equal(app.session.getHuntState().level,0);assert.equal(app.session.getHuntState().hp,1);
  app.onDestroy();
});

test('Hunt Bootstrap ad callbacks expire in background and apply an accumulated bonus only once',async()=>{
  const h=bootstrapHarness({realWorld:true,environment:'test',contentOverrides:{adsEnabled:true}}),app=h.create();
  await app.start();app.update(0);await drainPreparation(app, app.loadDeferredHud('hunt'));assert.equal(app.startHunt().ok,true);
  for(let i=0;i<8;i++)app.update(.25);testHuntClear(app);app.giveUpHunt();
  const cb=app.huntHud.callbacks,stale=cb.beginAd();assert.equal(stale.ok,true);
  app.onHide();app.onShow();app.update(0);
  assert.equal(cb.completeAd(stale.token,'success').ok,false);assert.equal(app.session.getPetState().coins,30);
  const request=cb.beginAd();assert.equal(request.ok,true);assert.equal(cb.completeAd(request.token,'success').ok,true);
  assert.equal(app.session.getPetState().coins,60);assert.equal(app.world.battlefieldActive,false);
  assert.equal(cb.completeAd(request.token,'success').ok,false);assert.equal(app.session.getPetState().coins,60);app.onDestroy();
});

test('Hunt resource wait holds entry clocks and an exited request cannot reactivate its arena',async()=>{
  const h=bootstrapHarness({realWorld:true,environment:'test'}),app=h.create();await app.start();app.update(0);
  const pending=deferred();let loaded=false;
  app.battleAssets={ready:stage=>stage.mapLayout!=='hunt'||loaded,load:()=>pending.promise};
  assert.equal(app.startHunt().ok,true);assert.equal(app.battleLoading,true);
  for(let i=0;i<20;i++)app.update(.25);
  assert.equal(app.session.getHuntState().phase,'entering');assert.equal(app.session.getHuntState().loadingElapsed,0);
  assert.equal(app.exitHunt().ok,true);assert.equal(app.battleLoading,false);
  for(let i=0;i<8;i++)app.update(.25);
  assert.equal(app.session.mode,'Main');const resets=app.battlefield.resets,roundId=app.worldRoundId;
  loaded=true;pending.resolve();await new Promise(resolve=>setImmediate(resolve));app.update(.25);
  assert.equal(app.session.mode,'Main');assert.equal(app.world.hunt,undefined);assert.equal(app.battlefield.resets,resets);assert.equal(app.worldRoundId,roundId);
  app.onDestroy();
});

const OFFLINE_BOOT_NOW = Date.UTC(2026, 9, 15, 4);
function offlineBootStorage(absentSeconds = 300) {
  const saved = rebirthStorage(), data = JSON.parse(saved.data.get(saved.key));
  data.offline = { lastSavedAtMs: OFFLINE_BOOT_NOW - absentSeconds * 1000 };
  saved.data.set(saved.key, JSON.stringify(data)); saved.writes.length = 0;
  return saved;
}
async function waitForOfflineRetry(app) {
  for (let count = 0; count < 100 && !app.cancelOfflineRetry; count++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(typeof app.cancelOfflineRetry, 'function', 'startup exposes the same-session persistence retry');
}

test('offline startup prewarms fixed assets but saves the final economy before loading or constructing the resumed world', async () => {
  const saved = offlineBootStorage(), pending = deferred();
  const h = bootstrapHarness({ storage: saved.storage, sessionNow: () => OFFLINE_BOOT_NOW,
    deferHiddenHuds: true, feedbackWait: pending.promise }), app = h.create();
  const started = app.start(); await h.feedbackEntered;
  // Fixed feedback now starts independently of offline settlement. The data
  // barrier, rather than a resource callback, certifies the resumed snapshot.
  for(let count=0;count<200&&!app.startupEntryReady;count++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(app.startupEntryReady,true,'offline settlement reaches its durable data barrier');
  assert.equal(h.calls.worlds, 0); assert.equal(app.session.offlineInitializationPending, false);
  assert.ok(saved.writes.length > 0);
  const result = app.session.offlineResult, durable = JSON.parse(saved.data.get(saved.key));
  assert.equal(h.calls.initialMapStage,result.stageIndex,'map selection uses the settled position');
  assert.deepEqual(durable.money, result.moneyFinal.toJSON());
  assert.deepEqual(durable.levels, result.levels);
  assert.deepEqual(durable.progress, { stageIndex: result.stageIndex, waveIndex: result.waveIndex });
  assert.equal(durable.offline.lastSavedAtMs, OFFLINE_BOOT_NOW);
  pending.resolve({}); await started; await drainPreparation(app, app.offlineHudRequest);
  assert.equal(app.ready, true); assert.equal(h.calls.worlds, 1); assert.equal(app.offlineHud.isOpen, true);
  assert.equal(app.world.stage.stageIndex, result.stageIndex); assert.equal(app.world.stage.waveIndex, result.waveIndex);
  assert.equal(h.errors.length, 0); app.onDestroy();
});

test('offline summary blocks underlying controls and tutorial while main combat continues, and closing never awards again', async () => {
  const saved = offlineBootStorage(), h = bootstrapHarness({ realWorld: true, storage: saved.storage,
    sessionNow: () => OFFLINE_BOOT_NOW, deferHiddenHuds: true }), app = h.create();
  await app.start(); await drainPreparation(app, app.offlineHudRequest); app.update(0);
  assert.equal(app.offlineHud.isOpen, true); assert.equal(app.hud.modalOpen, true);
  assert.equal(app.tutorialHud.updates.at(-1).targets.blocked, true); assert.equal(app.isPaused, false);
  assert.ok(app.featureEntries.size > 0);
  for (const [name, entry] of app.featureEntries) {
    assert.equal(entry.blocked, true, name);
    assert.ok(app.offlineHud.node.getSiblingIndex() > entry.node.getSiblingIndex());
  }
  assert.equal(app.purchaseUpgrade('power'), false); assert.equal(app.canOpenSettings(), false);
  await drainPreparation(app, app.openFeature('weapons')); assert.equal(app.weaponsHud, undefined);
  const time = app.world.simulationTime; app.update(.1); assert.ok(app.world.simulationTime > time);
  const money = app.session.moneyBalance.toString(), writes = saved.writes.length;
  app.closeOfflineSummary(); assert.equal(app.offlineHud.isOpen, false); assert.equal(app.hud.modalOpen, false);
  assert.equal(app.session.moneyBalance.toString(), money); assert.equal(saved.writes.length, writes);
  assert.equal(h.errors.length, 0); app.onDestroy();
});

test('offline checkpoints run every ten foreground seconds including the summary, and hide/show never evaluates again', async () => {
  let now = OFFLINE_BOOT_NOW;
  const saved = offlineBootStorage(), h = bootstrapHarness({ storage: saved.storage, sessionNow: () => now,
    deferHiddenHuds: true }), app = h.create();
  h.context.offlineTestNow = now; vm.runInContext('Date.now = () => offlineTestNow', h.context);
  await app.start(); await drainPreparation(app, app.offlineHudRequest); app.update(0);
  const result = app.session.offlineResult, evaluate = app.session.initializeOfflineProgress.bind(app.session);
  let initializations = 0, checkpoints = 0;
  app.session.initializeOfflineProgress = (...args) => { initializations++; return evaluate(...args); };
  const checkpoint = app.session.checkpointForeground.bind(app.session);
  app.session.checkpointForeground = () => { checkpoints++; checkpoint(); };
  const advance = seconds => { now += seconds * 1000; h.context.offlineTestNow = now; app.update(0); };
  advance(9.999); assert.equal(checkpoints, 0); advance(.001); assert.equal(checkpoints, 1);
  assert.equal(JSON.parse(saved.data.get(saved.key)).offline.lastSavedAtMs, now);
  advance(10); assert.equal(checkpoints, 2); assert.equal(app.offlineHud.isOpen, true);
  app.onHide(); const hidden = now, before = saved.writes.length;
  advance(3600); assert.equal(checkpoints, 2); assert.equal(saved.writes.length, before);
  assert.equal(JSON.parse(saved.data.get(saved.key)).offline.lastSavedAtMs, hidden);
  app.onShow(); assert.equal(checkpoints, 3); assert.equal(initializations, 0);
  assert.equal(app.session.offlineResult, result); assert.equal(app.offlineHud.isOpen, true);
  assert.equal(JSON.parse(saved.data.get(saved.key)).offline.lastSavedAtMs, now);
  advance(9.999); assert.equal(checkpoints, 3); advance(.001); assert.equal(checkpoints, 4);
  app.onDestroy();
});

test('offline persistence failure retries the existing session before world creation and cancels cleanly on teardown', async () => {
  for (const teardown of [false, true]) {
    const saved = offlineBootStorage(), setItem = saved.storage.setItem;
    let fail = true;
    saved.storage.setItem = (key, value) => { if (fail) throw new Error('offline quota'); setItem(key, value); };
    const h = bootstrapHarness({ storage: saved.storage, sessionNow: () => OFFLINE_BOOT_NOW, deferHiddenHuds: true }), app = h.create();
    const started = app.start(); await waitForOfflineRetry(app); const session = app.session;
    assert.equal(h.calls.worlds, 0); assert.equal(app.ready, false); assert.equal(saved.writes.length, 0);
    assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);assert.equal(h.calls.maps,0);
    assert.equal(app.resourceLoadingSnapshot().startup.timeline.phases.offline.failed,1);
    assert.match(app.loading.getComponent(h.cc.Label).string, /离线进度保存失败.*\n点击这里重试/);
    if (teardown) {
      app.onDestroy(); await started; assert.equal(h.calls.worlds, 0); assert.equal(app.cancelOfflineRetry, undefined);
      assert.equal(h.cc.game.listeners.length, 0); assert.equal(h.errors.length, 0);
    } else {
      fail = false; app.loading.emit(h.cc.Node.EventType.TOUCH_END); await started; await drainPreparation(app, app.offlineHudRequest);
      assert.equal(app.session, session); assert.equal(h.cc.director.loads.length, 0);
      assert.equal(app.ready, true); assert.equal(h.calls.worlds, 1); assert.equal(app.offlineHud.isOpen, true);
      const offlineTiming=app.resourceLoadingSnapshot().startup.timeline.phases.offline;
      assert.equal(offlineTiming.attempts,2);assert.equal(offlineTiming.failed,1);assert.equal(offlineTiming.succeeded,1);
      assert.equal(h.calls.artLoads,1);assert.equal(h.calls.feedback,1);
      assert.equal(h.errors.length, 0); app.onDestroy();
    }
  }
});

test('offline UI loading failure only retries the summary and cannot settle the same absence twice', async () => {
  let attempts = 0;
  const saved = offlineBootStorage(), h = bootstrapHarness({ storage: saved.storage, sessionNow: () => OFFLINE_BOOT_NOW,
    deferHiddenHuds: true, offlineLoad: () => ++attempts === 1 ? Promise.reject(new Error('offline atlas')) : Promise.resolve({}) }), app = h.create();
  await app.start(); await drainPreparation(app, app.offlineHudRequest);
  assert.equal(app.ready, true); assert.equal(app.offlineHud, undefined); assert.equal(attempts, 1);
  assert.equal(app.hud.modalOpen, true); assert.match(app.offlineNotice.getComponent(h.cc.Label).string, /离线进度已保存.*\n点击这里重试/);
  const result = app.session.offlineResult, money = app.session.moneyBalance.toString(), writes = saved.writes.length;
  for (let i = 0; i < 20; i++) app.update(0); assert.equal(attempts, 1);
  app.offlineNotice.emit(h.cc.Node.EventType.TOUCH_END); await drainPreparation(app, app.offlineHudRequest);
  assert.equal(attempts, 2); assert.equal(app.offlineHud.isOpen, true); assert.equal(app.offlineNotice.active, false);
  assert.equal(app.session.offlineResult, result); assert.equal(app.session.moneyBalance.toString(), money);
  assert.equal(saved.writes.length, writes); assert.equal(h.calls.worlds, 1); app.onDestroy();
});

test('offline summary failure after assignment releases the partial view and retries without reapplying progress', async () => {
  let fail = true;
  const saved = offlineBootStorage(), h = bootstrapHarness({ storage: saved.storage, sessionNow: () => OFFLINE_BOOT_NOW,
    deferHiddenHuds: true, offlineUpdate: () => { if (fail) throw new Error('offline first refresh'); } }), app = h.create();
  await app.start(); await drainPreparation(app, app.offlineHudRequest);
  assert.equal(app.ready, true); assert.equal(app.offlineHud, undefined);
  assert.equal(h.calls.offlineCreated, 1); assert.equal(h.calls.offlineDestroyed, 1);
  assert.equal(h.nodes.filter(node => node.name === 'OriginalOfflineHud' && node.isValid).length, 0);
  assert.equal(app.hud.modalOpen, true); assert.equal(app.offlineNotice.active, true);
  const result = app.session.offlineResult, money = app.session.moneyBalance.toString(), writes = saved.writes.length;
  fail = false; app.offlineNotice.emit(h.cc.Node.EventType.TOUCH_END); await drainPreparation(app, app.offlineHudRequest);
  assert.equal(h.calls.offlineCreated, 2); assert.equal(h.calls.offlineDestroyed, 1); assert.equal(app.offlineHud.isOpen, true);
  assert.equal(app.session.offlineResult, result); assert.equal(app.session.moneyBalance.toString(), money);
  assert.equal(saved.writes.length, writes); assert.equal(h.calls.worlds, 1); app.onDestroy();
});

async function settleDailyCheck(app) {
  for (let i = 0; i < 8; i++) { app.update(0); await new Promise(setImmediate); }
}

test('daily launch popup waits for offline receipt, blocks input/tutorial and resumes the same step only once', async () => {
  const saved = offlineBootStorage(), h = bootstrapHarness({ dailyCheck: true, storage: saved.storage,
    sessionNow: () => OFFLINE_BOOT_NOW, deferHiddenHuds: true }), app = h.create();
  await app.start(); await drainPreparation(app, app.offlineHudRequest); await settleDailyCheck(app);
  assert.equal(app.offlineHud.isOpen, true); assert.equal(h.calls.dailyCheckAssets, 0);
  assert.equal(app.dailyCheckAutoPending, true);
  const step = app.session.getTutorialState().step;
  app.closeOfflineSummary(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, true); assert.equal(app.dailyCheckAutoPending, false);
  assert.equal(app.hud.modalOpen, true); assert.equal(app.battlefield.muted, true);
  assert.equal(app.tutorialHud.updates.at(-1).targets.blocked, true);
  assert.equal(app.purchaseUpgrade('power'), false); assert.equal(app.canOpenSettings(), false);
  assert.equal(app.dailyCheckEntry.blocked, true);
  assert.ok(app.dailyCheckHud.node.getSiblingIndex() > app.dailyCheckEntry.node.getSiblingIndex());
  app.dailyCheckHud.close(); await settleDailyCheck(app);
  assert.equal(app.session.getTutorialState().step, step); assert.equal(app.hud.modalOpen, false);
  app.onHide(); app.onShow(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, false); assert.equal(h.calls.dailyCheckAssets, 1);
  app.onDestroy(); assert.equal(h.calls.dailyCheckDestroyed, 1);
});

test('production startup preserves a locked daily popup intent without downloading its heavy panel, then prepares it after unlock',async()=>{
  let now=0;const h=bootstrapHarness({dailyCheck:true,manualStartup:true,environment:'production'});h.context.Date={now:()=>now};
  const app=h.create(),started=app.start();await reachStartupPreparation(app);
  assert.equal(app.dailyCheckAutoPending,true);assert.equal(app.session.getContentState('dailyCheck').unlocked,false);
  assert.equal(app.shouldPrepareModule('dailyCheck'),false);assert.equal(app.startupModules.includes('dailyCheck'),false);
  for(let i=0;i<1100&&!app.ready;i++){now+=1000/60;app.update(1/60);await new Promise(setImmediate);}
  assert.equal(app.ready,true);await started;
  for(let i=0;i<300;i++){now+=1000/60;app.update(1/60);await new Promise(setImmediate);}
  assert.equal(h.calls.dailyCheckAssets,0);assert.equal(app.resourceModules.snapshot().dailyCheck.attempts,0);
  assert.equal(h.calls.backgroundConfigs.some(path=>path==='art/daily-check-system/config'),false);
  assert.equal(app.resourcePreloader.snapshot().features.dailyCheck.downloads.completed,0);
  app.session.tutorial.complete();app.session.speedRun.restore({stage:1});app.manuallyPaused=true;
  assert.equal(app.dailyCheckPreparationDemand,true);
  for(let i=0;i<800&&!app.resourceModules.isViewReady('dailyCheck');i++){now+=1000/60;app.update(1/60);await new Promise(setImmediate);}
  assert.equal(h.calls.backgroundConfigs.includes('art/daily-check-system/config'),true);
  assert.equal(app.resourceModules.isViewReady('dailyCheck'),true);assert.equal(h.calls.dailyCheckAssets,1);
  assert.equal(app.dailyCheckAutoPending,true);assert.equal(app.dailyCheckHud.isOpen,false);
  app.manuallyPaused=false;await settleDailyCheck(app);assert.equal(app.dailyCheckHud.isOpen,true);
  assert.equal(app.dailyCheckAutoPending,false);app.onDestroy();
});

test('daily entry and launch popup wait for both tutorial completion and a challenge win, matching skins and rebirth', async () => {
  const h = bootstrapHarness({ dailyCheck: true, deferHiddenHuds: true }), app = h.create();
  await app.start(); await settleDailyCheck(app);
  assert.equal(app.session.getTutorialState().active, true);
  assert.equal(app.dailyCheckEntry.node.active, false); assert.equal(!!app.dailyCheckHud?.isOpen, false);
  assert.equal(app.dailyCheckAutoPending, true); assert.equal(app.hud.modalOpen, false);
  assert.equal(app.tutorialHud.updates.at(-1).targets.blocked, false);
  await drainPreparation(app, app.openDailyCheck()); assert.equal(h.calls.dailyCheckAssets, 0);
  app.session.tutorial.complete(); await settleDailyCheck(app);
  for (const id of ['dailyCheck', 'skins', 'rebirth']) assert.equal(app.session.getContentState(id).reason, 'challenge');
  assert.equal(app.dailyCheckEntry.node.active, false); assert.equal(app.dailyCheckAutoPending, true);
  await drainPreparation(app, app.openDailyCheck()); assert.equal(h.calls.dailyCheckAssets, 0);
  app.onHide(); app.onShow(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckAutoPending, true); assert.equal(h.calls.dailyCheckAssets, 0);
  app.session.speedRun.restore({ stage: 1 }); await settleDailyCheck(app);
  for (const id of ['dailyCheck', 'skins', 'rebirth']) assert.equal(app.session.getContentState(id).visible, true);
  assert.equal(app.dailyCheckEntry.node.active, true); assert.equal(app.dailyCheckHud.isOpen, true);
  assert.equal(app.dailyCheckAutoPending, false); assert.equal(app.dailyCheckHud.state.claimableIndex, 0);
  const before = app.session.weapons.diamonds;
  assert.equal(app.dailyCheckHud.callbacks.claim(0).ok, true);
  assert.equal(app.session.weapons.diamonds, before + 140);
  app.dailyCheckHud.close(); app.onHide(); app.onShow(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, false); assert.equal(h.calls.dailyCheckAssets, 1);
  app.onDestroy();
});

test('daily UI snapshots refresh at midnight and after resume without another automatic popup', async () => {
  let now = new Date(2026, 9, 16, 23, 59).getTime();
  const h = bootstrapHarness({ dailyCheck: true, sessionNow: () => now, deferHiddenHuds: true,
    contentOverrides: { tutorialEnabled: false, thresholds: { rebirthSkinChallengeWins: 0 } } }), app = h.create();
  await app.start(); await settleDailyCheck(app);
  const before = app.session.weapons.diamonds;
  assert.equal(app.dailyCheckHud.callbacks.claim(0).ok, true); app.update(0);
  assert.equal(app.session.weapons.diamonds, before + 140); assert.equal(app.dailyCheckHud.state.claimableIndex, null);
  now += 120000; app.update(0); assert.equal(app.dailyCheckHud.state.claimableIndex, 1);
  app.dailyCheckHud.close(); app.onHide(); now += 86400000; app.onShow(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, false); assert.equal(app.dailyCheckHud.state.claimableIndex, 1);
  await drainPreparation(app, app.openDailyCheck()); assert.equal(app.dailyCheckHud.isOpen, true);
  app.onDestroy();
});

test('daily asset failure preserves launch intent, manual retry reuses one loader and cancelled opens cannot become visible', async () => {
  let attempts = 0;
  const h = bootstrapHarness({ dailyCheck: true, deferHiddenHuds: true,
    contentOverrides: { tutorialEnabled: false, thresholds: { rebirthSkinChallengeWins: 0 } },
    dailyCheckLoad: () => ++attempts === 1 ? Promise.reject(Error('daily atlas offline')) : Promise.resolve({}) }), app = h.create();
  await app.start(); await settleDailyCheck(app);
  assert.equal(attempts, 1); assert.equal(app.dailyCheckAutoPending, true); assert.equal(app.dailyCheckOpening, false);
  assert.equal(app.hud.modalOpen, false); assert.match(app.alerts.message, /七日领取加载失败/);
  await drainPreparation(app, app.openDailyCheck()); assert.equal(attempts, 2); assert.equal(app.dailyCheckHud.isOpen, true);
  app.onDestroy();
  for (const stop of ['background', 'mode', 'tutorial', 'destroy']) {
    const pending = deferred();
    const h = bootstrapHarness({ dailyCheck: true, deferHiddenHuds: true, dailyCheckLoad: () => pending.promise }), app = h.create();
    await app.start(); app.session.tutorial.complete(); app.session.speedRun.restore({ stage: 1 }); app.update(0);
    const request = app.dailyCheckHudRequest;await Promise.resolve();
    const settledRequest = stop === 'destroy' ? assert.rejects(request, /invalidated|disposed/) : request;
    assert.equal(app.dailyCheckOpening, true); assert.equal(h.calls.dailyCheckAssets, 1);
    if (stop === 'background') app.onHide();
    else if (stop === 'mode') { app.session.setMode('Mine'); app.syncModalState(); }
    else if (stop === 'tutorial') { app.session.tutorial.restore({ step: 'upgrade', drawCount: 0 }); app.syncModalState(); }
    else app.onDestroy();
    pending.resolve({}); await new Promise(setImmediate);
    if (stop === 'background' || stop === 'mode') {
      app.update(0); assert.equal(h.calls.dailyCheckCreated, 0, 'cancelled daily construction waits until foreground Main');
      if (stop === 'background') app.onShow(); else app.session.setMode('Main');
    }
    await drainPreparation(app, settledRequest); await new Promise(setImmediate);
    assert.equal(!!app.dailyCheckHud?.isOpen, false, stop);
    if (stop === 'destroy') assert.equal(h.calls.dailyCheckCreated, 0);
    else { assert.equal(app.dailyCheckAutoPending, true); app.onDestroy(); }
  }
});

test('daily lightweight entry retries downloads independently from the full panel', async () => {
  let attempts = 0;
  const h = bootstrapHarness({ deferHiddenHuds: true, contentOverrides: { tutorialEnabled: false, thresholds: { rebirthSkinChallengeWins: 0 } },
    dailyCheckEntryLoad: () => ++attempts === 1 ? Promise.reject(Error('entry unavailable')) : Promise.resolve({}) }), app = h.create();
  await app.start(); await app.dailyCheckEntryRequest;
  assert.equal(app.dailyCheckEntry, undefined); assert.equal(h.calls.dailyCheckAssets, 0);
  app.updateDeferredHuds(); assert.equal(attempts, 1);
  app.dailyCheckEntryRetryAt = 0; app.updateDeferredHuds(); await app.dailyCheckEntryRequest;
  assert.equal(attempts, 2); assert.equal(app.dailyCheckEntry.node.active, true);
  app.onDestroy(); assert.equal(app.dailyCheckEntry, undefined);
});

test('a foreground feature supersedes a pending daily open and the launch popup waits until that feature closes', async () => {
  const pending = deferred(), h = bootstrapHarness({ dailyCheck: true, deferHiddenHuds: true, environment: 'test',
    contentOverrides: { tutorialEnabled: false }, dailyCheckLoad: () => pending.promise }), app = h.create();
  await app.start(); app.update(0);
  assert.equal(app.dailyCheckOpening, true);
  const request = app.dailyCheckHudRequest;
  await drainPreparation(app, app.openFeature('weapons')); assert.equal(app.weaponsHud.isOpen, true);
  pending.resolve({}); await drainPreparation(app, request); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, false); assert.equal(app.dailyCheckAutoPending, true);
  app.weaponsHud.close(); await settleDailyCheck(app);
  assert.equal(app.dailyCheckHud.isOpen, true); assert.equal(app.dailyCheckAutoPending, false);
  app.onDestroy();
});

test('usage records both ready HUD entry buttons and deferred opens once per visible opening',async()=>{
  const h=bootstrapHarness({deferHiddenHuds:true}),app=h.create();await app.start();
  app.session.contentProgress.weaponsUnlocked=true;
  const used=[];app.resourcePreloader.recordUse=name=>used.push(name);
  await drainPreparation(app, app.loadDeferredHud('weapons'));app.weaponsHud.open();app.syncModalState();app.syncModalState();
  assert.deepEqual(used,['weapons']);app.weaponsHud.close();app.syncModalState();
  await drainPreparation(app, app.openFeature('weapons'));app.syncModalState();assert.deepEqual(used,['weapons','weapons']);app.onDestroy();
});


test('an initialized daily check opens synchronously without a pending state or preparation notice',async()=>{
 const h=bootstrapHarness({dailyCheck:true,environment:'test'}),app=h.create();await app.start();
 app.dailyCheckAutoPending=false;app.dailyCheckHud.close();app.syncModalState();
 const request=app.openDailyCheck();
 assert.equal(app.dailyCheckHud.isOpen,true);assert.equal(app.dailyCheckOpening,false);assert.equal(app.dailyCheckNotice,undefined);
 await request;assert.equal(h.calls.dailyCheckAssets,1);assert.equal(h.calls.dailyCheckCreated,1);app.onDestroy();
});


test('startup starts the current map alongside independent groups while both font and base-art barriers still gate gameplay', async () => {
  const art = deferred(), font = deferred();
  const h = bootstrapHarness({ artWait: art.promise, startupFontWait: font.promise });
  const app = h.create(), started = app.start();
  await new Promise(setImmediate);
  assert.equal(h.calls.feedback, 1); assert.equal(h.calls.hudAssets, 1);
  assert.deepEqual(h.calls.initialWeaponIds, [0]); assert.equal(h.calls.maps, 1,'map preparation no longer waits for full base art');
  assert.equal(h.calls.worlds, 0); assert.equal(app.ready, false);
  art.resolve(); await new Promise(setImmediate);
  assert.equal(h.calls.maps, 1); assert.equal(h.calls.worlds, 0); assert.equal(app.ready, false);
  font.resolve(); await started;
  assert.equal(app.ready, true); assert.equal(h.calls.worlds, 1); app.onDestroy();
});

for (const name of ['weapons', 'raid']) for (const first of ['panel', 'visuals']) {
  test(`${name} starts panel assets and all weapon choices together, waiting for ${first === 'panel' ? 'visuals' : 'panel assets'} before construction`, async () => {
    const panel = deferred(), visuals = deferred(), field = name === 'weapons' ? 'weaponsHud' : 'raidHud';
    const h = bootstrapHarness({ manualStartup: true, environment: 'test',
      [name === 'weapons' ? 'weaponLoad' : 'raidLoad']: () => panel.promise });
    const app = h.create(), started = app.start(); await reachStartupPreparation(app);
    let visualStarts = 0;
    app.artLibrary.weaponVisuals = { loadedFramePaths: new Set(['all-weapon-choices']),
      prepareAll: () => { visualStarts++; return visuals.promise; } };
    const request = app.resourceModules.prepare(name); await new Promise(setImmediate);
    assert.equal(h.calls[name === 'weapons' ? 'weaponAssets' : 'raidAssets'], 1);
    assert.equal(visualStarts, 1, 'visual loading starts while panel assets are unresolved');
    (first === 'panel' ? panel : visuals).resolve({}); await new Promise(setImmediate);
    app.uiPreparation.tick(name);
    assert.equal(app[field], undefined); assert.equal(app.resourceModules.isViewReady(name), false);
    assert.equal(app.resourceModules.snapshot()[name].assetReady, false, 'both dependencies gate asset readiness');
    assert.equal(app.ready, false, 'startup still waits for its complete view set');
    (first === 'panel' ? visuals : panel).resolve({}); await drainPreparation(app, request);
    assert.ok(app[field]); assert.equal(app.resourceModules.isViewReady(name), true);
    assert.ok(app.coreResourcePaths.has('all-weapon-choices'), 'combat choices stay protected from panel eviction');
    assert.deepEqual(h.errors, []); app.onDestroy(); await started;
  });
}

for (const name of ['weapons', 'raid']) for (const failed of ['panel', 'visuals']) {
  test(`${name} ${failed} failure blocks construction and permits a same-session retry of the parallel asset barrier`, async () => {
    let panel = deferred(), visuals = deferred();
    const field = name === 'weapons' ? 'weaponsHud' : 'raidHud';
    const h = bootstrapHarness({ manualStartup: true, environment: 'test',
      [name === 'weapons' ? 'weaponLoad' : 'raidLoad']: () => panel.promise });
    const app = h.create(), started = app.start(); await reachStartupPreparation(app);
    const session = app.session;
    let visualStarts = 0;
    app.artLibrary.weaponVisuals = { loadedFramePaths: new Set(['all-weapon-choices']),
      prepareAll: () => { visualStarts++; return visuals.promise; } };
    const rejected = assert.rejects(app.resourceModules.prepare(name), /choice dependency failed/);
    await new Promise(setImmediate);
    assert.equal(visualStarts, 1); assert.equal(h.calls[name === 'weapons' ? 'weaponAssets' : 'raidAssets'], 1);
    (failed === 'panel' ? panel : visuals).reject(new Error('choice dependency failed')); await rejected;
    (failed === 'panel' ? visuals : panel).resolve({}); await new Promise(setImmediate);
    app.uiPreparation.tick(name);
    assert.equal(app[field], undefined); assert.equal(app.resourceModules.isViewReady(name), false);
    assert.equal(app.ready, false); assert.equal(app.resourceModules.snapshot()[name].assetReady, false);
    panel = deferred(); visuals = deferred();
    const retry = app.resourceModules.prepare(name); await new Promise(setImmediate);
    assert.equal(visualStarts, 2); assert.equal(h.calls[name === 'weapons' ? 'weaponAssets' : 'raidAssets'], 2);
    panel.resolve({}); visuals.resolve(); await drainPreparation(app, retry);
    assert.equal(app.session, session); assert.equal(h.calls.worlds, 1);
    assert.equal(app.resourceModules.isViewReady(name), true); assert.equal(app.resourceModules.snapshot()[name].attempts, 2);
    assert.ok(app.coreResourcePaths.has('all-weapon-choices'));
    assert.deepEqual(h.errors, []); app.onDestroy(); await started;
  });
}

for (const name of ['weapons', 'raid']) {
  test(`${name} late parallel asset completion cannot publish a destroyed view or retain its frames`, async () => {
    const panel = deferred(), visuals = deferred(), field = name === 'weapons' ? 'weaponsHud' : 'raidHud';
    const h = bootstrapHarness({ manualStartup: true, environment: 'test',
      [name === 'weapons' ? 'weaponLoad' : 'raidLoad']: () => panel.promise });
    const app = h.create(), started = app.start(); await reachStartupPreparation(app);
    app.artLibrary.weaponVisuals = { loadedFramePaths: new Set(['stale-weapon-choices']), prepareAll: () => visuals.promise };
    const rejected = assert.rejects(app.resourceModules.prepare(name), /invalidated/);
    await new Promise(setImmediate); app.onDestroy(); panel.resolve({}); visuals.resolve();
    await rejected; await started;
    assert.equal(app[field], undefined); assert.equal(app.resourceModules.isViewReady(name), false);
    assert.equal(app.coreResourcePaths.has('stale-weapon-choices'), false); assert.deepEqual(h.errors, []);
  });
}
