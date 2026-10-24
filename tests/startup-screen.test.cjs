const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { installStartupScreen } = require('../tools/install-startup-screen.cjs');
const source = fs.readFileSync(path.join(__dirname, '../tools/startup-screen/runtime.js'), 'utf8');
function fixture(failImage = false) {
  let images = 0;
  class Image { constructor() { images++; } set src(value) { this.source = value; queueMicrotask(() => failImage ? this.onerror() : this.onload()); } }
  const context = { Image, module: { exports: {} }, document: {}, Number, Math, Promise };
  vm.runInNewContext(source, context);
  return { theme: context.module.exports, imageCount: () => images };
}
function drawingContext(labels = []) {
  return new Proxy({ fillText: (...args) => labels.push(args),
    measureText(text) { return { width: Array.from(text).reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : .55), 0) * (parseInt(this.font?.match(/\d+/)?.[0]) || 27) }; }
  }, { get: (target, key) => target[key] || (() => {}) });
}
test('startup image is decoded once across boot and engine; failed art cannot block startup', async () => {
  const { theme, imageCount } = fixture();
  const [boot, engine] = await Promise.all([theme.load(), theme.load()]);
  assert.equal(boot, engine); assert.equal(imageCount(), 1);
  theme.release(); assert.equal(theme.image, null); await theme.load(); assert.equal(imageCount(), 2);
  assert.equal(await fixture(true).theme.load(), null);
});
test('startup progress never decreases or becomes invalid, and resets after disposal', () => {
  const { theme } = fixture();
  for (const [input, expected] of [[.15,.15],[.7,.7],[.3,.7],[NaN,.7],[Infinity,.7],[1.5,1],[-1,1]]) {
    assert.equal(theme.setProgress(input), expected);
  }
  theme.release(); assert.equal(theme.progress, 0);
});
test('loading strip stays inside portrait viewports and uses only selected status/system fonts', () => {
  const { theme } = fixture();
  for (const [w,h] of [[720,1280],[780,1688],[824,1830]]) {
    const l=theme.layout(w,h), labels=[];
    assert.ok(l.top > 0 && l.top+l.height < h);
    assert.ok(l.barY+l.barH/2 < l.top+l.height);
    const ctx = drawingContext(labels);
    theme.overlay(ctx,w,h,.68,false,l.top);
    assert.deepEqual(labels.map(args=>args[0]),['小队集结中（首次加载会慢一点）','68%','正在加载引擎与启动场景…','版本 local']);
    assert.match(ctx.font,/sans-serif/);
    labels.length=0;theme.overlay(ctx,w,h,.68,true,l.top);
    assert.equal(labels[2][0],'加载失败：请重新进入游戏');
    labels.length=0;
    theme.overlay(ctx,w,h,.68,true,l.top,'版本 0.1.32\n资源加载失败：森林地图\nart/maps/forest/ground/spriteFrame: HTTP 404\n点击这里重试');
    assert.equal(labels.length,4,'heading, percentage, one diagnostic line and version are drawn');
    assert.equal(labels[3][0],'版本 0.1.32');
    assert.match(labels[2][0],/加载失败/);assert.match(labels[2][0],/HTTP 404/);assert.match(labels[2][0],/点击重试/);
    assert.doesNotMatch(labels[2][0],/\n/);
    for(const [,x,y] of labels){assert.ok(x>0&&x<w);assert.ok(y>0&&y<l.height,'all diagnostic lines remain inside the uploaded strip');}
  }
});
test('build install is repeatable, precedes engine scripts, and ships one small local JPEG without fonts', () => {
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'fox-startup-test-'));
  try {
    fs.writeFileSync(path.join(output,'index.html'),'<title>Cocos Creator | Forest Gunner</title><body><!-- Polyfills bundle. --><script src="engine.js"></script></body>');
    installStartupScreen('web',output);installStartupScreen('web',output);
    const html=fs.readFileSync(path.join(output,'index.html'),'utf8');
    assert.equal((html.match(/FOX_STARTUP_START/g)||[]).length,1);
    assert.ok(html.indexOf('mountBrowser()') < html.indexOf('engine.js'));
    assert.doesNotMatch(html,/Forest Gunner/);
    assert.match(html,/<title>小队出征<\/title>/);
    assert.ok(fs.statSync(path.join(output,'startup-background.jpg')).size < 180000);
    assert.deepEqual(fs.readdirSync(output).sort(),['index.html','startup-background.jpg','startup-screen.js']);
  } finally { fs.rmSync(output,{recursive:true,force:true}); }
});

test('engine cover rebinds GPU frames on resize and uploads only changed progress', async () => {
  const {theme}=fixture();
  const labels=[],context2d=drawingContext(labels);
  theme.canvas=()=>({width:0,height:0,getContext:()=>context2d});
  theme.hideBrowserCover=()=>{};
  class ImageAsset {constructor(data){this.data=data;}destroy(){this.destroyed=true;}}
  class Texture2D {uploads=0;uploadData(){this.uploads++;}destroy(){this.destroyed=true;}}
  class SpriteFrame {destroy(){this.destroyed=true;}}
  class Sprite {static SizeMode={CUSTOM:0};}
  class UITransform {setContentSize(w,h){this.size=[w,h];}}
  function makeNode(name,parent){const components=new Map([[UITransform,new UITransform()]]),node={name,children:[],isValid:true,
    addComponent(Type){const value=new Type();components.set(Type,value);return value;},getComponent(Type){return components.get(Type);},
    setPosition(){},destroy(){this.isValid=false;}};if(parent)parent.children.push(node);return node;}
  const typescript=require('typescript'),module={exports:{}};
  const code=typescript.transpileModule(fs.readFileSync(path.join(__dirname,'../assets/scripts/view/StartupLoadingScreen.ts'),'utf8'),
    {compilerOptions:{target:typescript.ScriptTarget.ES2018,module:typescript.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,__FOREST_STARTUP_VISUALS__:theme,setTimeout:fn=>fn(),
    require:name=>name==='cc'?{ImageAsset,Texture2D,SpriteFrame,Sprite,UITransform}:{makeNode}});
  const message={enabled:true,string:'正在准备森林地图'};
  const screen=new module.exports.StartupLoadingScreen(makeNode('root'),message);
  const originalFrame=screen.overlayFrame,originalTexture=screen.overlayTexture;
  screen.resize(720,1560);
  assert.notEqual(screen.overlayFrame,originalFrame);assert.equal(originalFrame.destroyed,true);assert.equal(originalTexture.destroyed,true);
  assert.equal(screen.overlay.getComponent(Sprite).spriteFrame,screen.overlayFrame);
  assert.equal(screen.overlayFrame.packable,false);
  const uploads=screen.overlayTexture.uploads;
  screen.sync();assert.equal(screen.overlayTexture.uploads,uploads);
  for(let completed=1;completed<=40;completed++){
    message.string=`正在准备森林地图 · 资源已完成 ${completed} 项`;
    screen.setProgress(.28+completed/100);
  }
  assert.equal(screen.overlayTexture.uploads,uploads,'resource callback bursts wait for the frame');
  labels.length=0;screen.sync();assert.equal(screen.overlayTexture.uploads,uploads+1);
  assert.ok(labels.some(args=>args[0]==='68%'),'the frame paints the latest progress');
  screen.sync();assert.equal(screen.overlayTexture.uploads,uploads+1,'unchanged frames do not upload');
  let elapsedMs=4000;
  screen.resourceStatus=()=>({completed:18,pending:[
    {path:'art/next/config',elapsedMs:9000,preload:true},
    {path:'art/maps/forest/ground/spriteFrame',elapsedMs,preload:false},
  ]});
  labels.length=0;screen.sync();
  let text=labels.map(args=>args[0]).join('');
  assert.match(text,/art\/maps\/.*ground\/spriteFrame/);assert.doesNotMatch(text,/已等待|等待中|正在准备森林地图/);
  assert.equal(labels.length,4);
  assert.doesNotMatch(text,/art\/next\/config/);
  const waitingUploads=screen.overlayTexture.uploads;screen.sync();assert.equal(screen.overlayTexture.uploads,waitingUploads);
  elapsedMs=5000;labels.length=0;screen.sync();assert.equal(screen.overlayTexture.uploads,waitingUploads+1);
  assert.doesNotMatch(labels.map(args=>args[0]).join(''),/已等待/);
  message.string='资源加载失败：森林地图\nart/maps/forest/ground/spriteFrame: HTTP 404\n点击这里重试';
  labels.length=0;screen.sync();text=labels.map(args=>args[0]).join('');
  assert.match(text,/HTTP 404/);assert.match(text,/点击重试/);assert.doesNotMatch(text,/已等待/);
  message.string='正在重试森林地图';labels.length=0;screen.sync();
  assert.match(labels.map(args=>args[0]).join(''),/正在加载/);
  screen.destroy();await theme.imagePromise;
  assert.equal(screen.root.isValid,false);assert.equal(screen.backgroundFrame,undefined);
  assert.equal(theme.image,null);
});
