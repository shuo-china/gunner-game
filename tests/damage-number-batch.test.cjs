const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const crypto=require('node:crypto');
const {decodeRgba,buildAtlas}=require('../tools/build-number-atlas.cjs');
const {NumberBatchHarness}=require('./support/number-batch-harness.cjs');
const root=path.resolve(__dirname,'..');
const resources=path.join(root,'assets/resources');
const damage=require('../assets/resources/art/effects/original-feedback.json').damage;
const money=require('../assets/resources/art/effects/money-numbers/config.json');
const critical=require('../assets/resources/art/weapon-system/critical/config.json');
const mine=require('../assets/resources/art/mine-system/diamond-numbers/config.json');
const manifest=require('../assets/resources/art/effects/number-atlas/config.json');
const core=require('./.build/core/index.js');
const math=require('./.build/feedback/view/OriginalFeedbackMath.js');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

function load(filename,imports,random=()=>0) {
  const module={exports:{}},fakeMath=Object.create(Math);fakeMath.random=random;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module,exports:module.exports,Math:fakeMath,require:name=>{assert.ok(name in imports,`Unknown import ${name}`);return imports[name];}});
  return module.exports;
}
function harness(reference=false) {
  class Color {constructor(r,g,b,a=255){Object.assign(this,{r,g,b,a});}static WHITE=new Color(255,255,255,255);}
  class UITransform {setContentSize(width,height){Object.assign(this,{width,height});}setAnchorPoint(x,y){this.anchor={x,y};}}
  class UIOpacity {opacity=255;}
  class Sprite {}
  class Node {
    static EventType={NODE_DESTROYED:'destroyed'};
    once() {}
    constructor(name){this.name=name;this.children=[];this.components=new Map();this.active=true;this.position={x:0,y:0,z:0};this.scale={x:1,y:1,z:1};this.angle=0;}
    addChild(node){this.children.push(node);node.parent=this;}
    addComponent(Type){const value=new Type();this.components.set(Type,value);return value;}
    getComponent(Type){return this.components.get(Type);}
    setPosition(x,y,z){this.position={x,y,z};}
    setScale(x,y,z){this.scale={x,y,z};}
  }
  const makeNode=(name,parent)=>{const node=new Node(name);node.addComponent(UITransform);parent?.addChild(node);return node;};
  const art={catalog:{feedback:{damage}},weaponVisuals:{config:{criticalDamage:critical}},
    frames:new Map([damage,money,critical,mine].flatMap(config=>Object.values(config.glyphs).map(spec=>[spec.path,spec.path]))),
    image(name,spec,parent){const node=makeNode(name,parent),sprite=node.addComponent(Sprite);
      sprite.spriteFrame=spec.path;sprite.color=spec.color?new Color(...spec.color):Color.WHITE;
      if(spec.localScale)node.setScale(...spec.localScale,1);node.angle=spec.localRotationDeg??0;return node;}};
  let seed=71;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const filename=reference?path.join(__dirname,'fixtures/damage-numbers-before-batching.ts.txt'):path.join(root,'assets/scripts/view/DamageNumbers.ts');
  const {DamageNumbers}=load(filename,{cc:{Color,Node,Sprite,UIOpacity,UITransform},'../core':core,
    './ArtLibrary':{makeNode},'./OriginalFeedbackMath':math,'./OrderedQuadBatch':{OrderedQuadBatch:NumberBatchHarness},
    './NumberGlyphAtlas':{retainNumberGlyphAtlas:()=>()=>{},numberGlyphFrame:(art,path)=>art.frames.get(path)}},random);
  const parent=makeNode('Numbers'),view=new DamageNumbers(art,parent,money);
  const quads=()=>reference?view.slots.flatMap(slot=>slot.node.active?slot.digits.filter(node=>node.active).map(node=>{
    const sprite=node.getComponent(Sprite),tr=node.getComponent(UITransform),scale=slot.node.scale;
    return {frame:sprite.spriteFrame,x:slot.node.position.x+node.position.x*scale.x,y:slot.node.position.y,
      width:tr.width*node.scale.x*scale.x,height:tr.height*node.scale.y*scale.y,
      anchorX:tr.anchor.x,anchorY:tr.anchor.y,angle:node.angle,
      color:[sprite.color.r/255,sprite.color.g/255,sprite.color.b/255,sprite.color.a/255*slot.opacity.opacity/255]};
  }):[]):view.batch.quads;
  return {view,parent,quads};
}

test('batched number quads match pre-batching node geometry, color and ordering over mixed lifecycles',()=>{
  const before=harness(true),after=harness(false);
  let now=0;
  for(let frame=0;frame<720;frame++) {
    now=Math.fround(now+(frame%7===0?0:1/60));
    for(const {view} of [before,after]) {
      if(frame===240||frame===480){view.reset();}
      if(frame%3===0)view.spawn({x:(frame%19)*3,z:(frame%31)-15},core.DecimalAmount.from(frame%2?'1.23e2206':275),now-.01,frame%4===0,frame%5===0?8:2);
      if(frame%4===0)view.spawnMoney({x:(frame%13)*3,z:frame%23},frame%8===0?36:20,now-.01);
      if(frame%11===0)view.spawnStyledText({x:(frame%17)*3,z:frame%29},mine.height,'+12.3a',mine,now-.01);
      view.update(frame%7===0?0:1/60,now);
    }
    const expected=before.quads(),actual=after.quads();
    assert.deepEqual({...after.view.diagnostics()},{...before.view.diagnostics()});
    assert.equal(actual.length,expected.length,`frame ${frame}`);
    for(let i=0;i<actual.length;i++) {
      assert.equal(actual[i].frame,expected[i].frame,`ordered glyph ${i} at frame ${frame}`);
      for(const key of ['x','y','width','height','anchorX','anchorY','angle'])close(actual[i][key],expected[i][key]);
      for(let c=0;c<4;c++)close(actual[i].color[c],expected[i].color[c]);
    }
  }
  before.view.update(20,now+20);after.view.update(20,now+20);
  assert.equal(after.quads().length,0);assert.equal(before.quads().length,0);
  const submissions=after.view.batch.submissions;
  after.view.update(0,now+20);assert.equal(after.view.batch.submissions,submissions,'idle buffers are not rebuilt');
  assert.equal(after.parent.children.length,0,'the number layer does not allocate per-number or per-glyph nodes');
});

test('many number spawns produce one ordered submission at render time and frozen poses reuse it',()=>{
  const {view}=harness();
  for(let i=0;i<100;i++)view.spawnMoney({x:i*3,z:0},20,0);
  assert.equal(view.batch.submissions,0);
  view.update(0,0);assert.equal(view.batch.submissions,1);assert.equal(view.batch.quads.length,300);
  const quads=view.batch.quads;
  for(let i=0;i<100;i++)view.update(0,0);
  assert.equal(view.batch.submissions,1);assert.equal(view.batch.quads,quads);
  view.reset();assert.equal(view.batch.quads.length,0);
});

test('all four atlas fonts preserve every original RGBA pixel and extruded clamp-to-edge gutters',()=>{
  const atlas=decodeRgba(fs.readFileSync(path.join(resources,`${manifest.atlas}.png`)));
  assert.equal(atlas.width,512);assert.equal(atlas.height,1024);
  const specs=[damage,money,critical,mine].flatMap(config=>Object.values(config.glyphs));
  assert.equal(Object.keys(manifest.frames).length,168);
  for(const spec of specs) {
    const original=decodeRgba(fs.readFileSync(path.join(resources,`${spec.path}.png`)));
    const {rect:[x,y,w,h],rgbaSha256}=manifest.frames[spec.path],crop=Buffer.alloc(w*h*4);
    assert.equal(w,original.width);assert.equal(h,original.height);
    for(let row=0;row<h;row++)atlas.rgba.copy(crop,row*w*4,((y+row)*atlas.width+x)*4,((y+row)*atlas.width+x+w)*4);
    assert.deepEqual(crop,original.rgba,spec.path);
    assert.equal(crypto.createHash('sha256').update(crop).digest('hex'),spec.source.rgbaSha256);
    assert.equal(rgbaSha256,spec.source.rgbaSha256);
    for(let gy=-2;gy<h+2;gy++)for(let gx=-2;gx<w+2;gx++)if(gx<0||gy<0||gx>=w||gy>=h) {
      const source=(Math.min(h-1,Math.max(0,gy))*w+Math.min(w-1,Math.max(0,gx)))*4;
      const target=((y+gy)*atlas.width+x+gx)*4;
      assert.deepEqual(atlas.rgba.subarray(target,target+4),original.rgba.subarray(source,source+4));
    }
  }
  const generated=buildAtlas();
  assert.deepEqual(generated.manifest,manifest);
  assert.deepEqual(generated.png,fs.readFileSync(path.join(resources,`${manifest.atlas}.png`)));
});

test('atlas frames load once, preserve subrects and release when the final number layer leaves',async()=>{
  class Rect {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}}
  class Size {constructor(width,height){Object.assign(this,{width,height});}}
  const owned=[];
  class SpriteFrame {constructor(){owned.push(this);this.destroyCount=0;}destroy(){this.destroyCount++;}}
  const {loadNumberGlyphAtlas,numberGlyphFrame,retainNumberGlyphAtlas}=load(path.join(root,'assets/scripts/view/NumberGlyphAtlas.ts'),{cc:{Rect,Size,SpriteFrame}});
  const texture={},atlas={texture},fallback={texture:{}};let jsonLoads=0,textureLoads=0;
  const art={frames:new Map([['custom',fallback]]),async json(resource){jsonLoads++;assert.equal(resource,'art/effects/number-atlas/config');return manifest;},
    async loadFrame(resource){textureLoads++;assert.equal(resource,manifest.atlas);return atlas;}};
  await Promise.all([loadNumberGlyphAtlas(art),loadNumberGlyphAtlas(art)]);
  await loadNumberGlyphAtlas(art);assert.equal(jsonLoads,1);assert.equal(textureLoads,1);assert.equal(art.frames.size,1);
  assert.equal(owned.length,0,'cancelled loading has no owned SpriteFrames to leak');
  const releaseMain=retainNumberGlyphAtlas(art),releaseMine=retainNumberGlyphAtlas(art);
  assert.equal(atlas.packable,false);assert.equal(numberGlyphFrame(art,'custom'),fallback);
  for(const [path,{rect:[x,y,width,height]}] of Object.entries(manifest.frames)) {
    const frame=numberGlyphFrame(art,path);assert.equal(frame.texture,texture);assert.equal(frame.packable,false);
    assert.deepEqual({...frame.rect},{x,y,width,height});assert.deepEqual({...frame.originalSize},{width,height});
  }
  assert.throws(()=>numberGlyphFrame(art,'missing'),/Missing number glyph/);
  const glyphPath=Object.keys(manifest.frames)[0],first=numberGlyphFrame(art,glyphPath);
  assert.equal(owned.length,168);releaseMine();assert.ok(owned.every(frame=>frame.destroyCount===0));
  releaseMain();assert.ok(owned.every(frame=>frame.destroyCount===1));
  releaseMain();releaseMine();assert.ok(owned.every(frame=>frame.destroyCount===1),'releases are idempotent');
  const releaseAgain=retainNumberGlyphAtlas(art),again=numberGlyphFrame(art,glyphPath);
  assert.notEqual(again,first);assert.equal(again.texture,texture);assert.equal(textureLoads,1);
  assert.equal(owned.length,169);releaseAgain();assert.equal(again.destroyCount,1);
});

test('atlas retries failed preparation and destroys a failed subframe before retrying',async()=>{
  class Rect {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}}
  class Size {constructor(width,height){Object.assign(this,{width,height});}}
  const owned=[];let rejectRect=true;
  class SpriteFrame {
    constructor(){owned.push(this);this.destroyCount=0;}
    set rect(value){if(rejectRect)throw new Error('invalid rect');this.value=value;}
    destroy(){this.destroyCount++;}
  }
  const {loadNumberGlyphAtlas,numberGlyphFrame,retainNumberGlyphAtlas}=load(path.join(root,'assets/scripts/view/NumberGlyphAtlas.ts'),{cc:{Rect,Size,SpriteFrame}});
  let fail=true;
  const art={frames:new Map(),async json(){if(fail)throw new Error('offline');return manifest;},async loadFrame(){return {texture:{}};}};
  await assert.rejects(loadNumberGlyphAtlas(art),/offline/);fail=false;await loadNumberGlyphAtlas(art);
  const release=retainNumberGlyphAtlas(art),glyphPath=Object.keys(manifest.frames)[0];
  assert.throws(()=>numberGlyphFrame(art,glyphPath),/invalid rect/);assert.equal(owned[0].destroyCount,1);
  rejectRect=false;const frame=numberGlyphFrame(art,glyphPath);assert.equal(owned.length,2);assert.equal(frame.destroyCount,0);
  release();assert.equal(frame.destroyCount,1);
});
