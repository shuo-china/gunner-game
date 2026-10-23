const { projectPath, fixturePath } = require('./support/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const engine = fixturePath('cocos-3.8.8');
function load(file, imports) {
  const module = {exports:{}};
  const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'), {
    compilerOptions:{target:ts.ScriptTarget.ES2018,module:ts.ModuleKind.CommonJS},
  }).outputText;
  vm.runInNewContext(compiled,{module,exports:module.exports,Float32Array,Uint16Array,
    require:name=>{assert.ok(name in imports,`Unstubbed import ${name}`);return imports[name];}});
  return module.exports;
}
const {MeshBuffer}=load(path.join(engine,'mesh-buffer.ts.txt'),{
  'internal:constants':{JSB:false},'../../gfx':{},'./vertex-format':{},
  '../../core':{sys:{__isWebIOS14OrIPadOS14Env:false}},'./native-2d':{},
});
const {StaticVBAccessor}=load(path.join(engine,'static-vb-accessor.ts.txt'),{
  'internal:constants':{JSB:false},'./mesh-buffer':{MeshBuffer},
  './buffer-accessor':{BufferAccessor:class{}},'../../game':{},
  '../../core':{assertID:assert.ok,assertIsTrue:assert.ok,errorID:()=>assert.fail('accessor overflow'),
    Pool:class{constructor(make){this.make=make;}alloc(){return this.make();}free(){}}},
});
const {simple}=load(path.join(engine,'simple.ts.txt'),{
  '../../utils/dynamic-atlas/atlas-manager':{dynamicAtlasManager:{packToDynamicAtlas(){}}},
});
const identity=()=>({m00:1,m01:0,m02:0,m03:0,m04:0,m05:1,m06:0,m07:0,m12:0,m13:0,m14:0,m15:1});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<2e-5,`${actual} != ${expected}`);
function fixture(vertexCapacity=4096){
  const accessor=Object.create(StaticVBAccessor.prototype),uploads=[];
  Object.assign(accessor,{_buffers:[],_freeLists:[],_vCount:vertexCapacity,_iCount:vertexCapacity*4,
    vertexFormatBytes:36,_floatsPerVertex:9});
  accessor._allocateBuffer=function(){
    const buffer=new MeshBuffer(),record={buffer,frames:[]};uploads.push(record);
    buffer.vData=new Float32Array(vertexCapacity*9);buffer.iData=new Uint16Array(vertexCapacity*4);
    const gpuBuffer=recording=>({size:0,resize(size){this.size=size;},update(data){if(recording)record.frames.push(Array.from(data));}});
    buffer._iaPool=[{vertexBuffers:[gpuBuffer(false)],indexBuffer:gpuBuffer(true)}];
    this._buffers.push(buffer);this._freeLists.push([{offset:0,length:buffer.vData.byteLength}]);
    return this._buffers.length-1;
  };
  accessor._allocateBuffer();
  const sprites=[],nodes=[],defaultMaterial={name:'default'},linearMaterial={name:'linear'};
  class Node{
    static EventType={NODE_DESTROYED:'destroyed'};
    constructor(name){Object.assign(this,{name,children:[],isValid:true,_active:true,parent:null,layer:1<<19,
      worldMatrix:identity(),_uiProps:{opacity:1,localOpacity:1},listeners:[]});nodes.push(this);}
    get active(){return this._active;}
    get activeInHierarchy(){return this._active&&(!this.parent||this.parent.activeInHierarchy);}
    set active(value){const before=this.activeInHierarchy;this._active=value;
      if(before!==this.activeInHierarchy)this.syncActive(this.activeInHierarchy);}
    syncActive(enabled){
      if(this.sprite&&this.sprite.enabledInHierarchy!==enabled){
        this.sprite.enabledInHierarchy=enabled;
        // Real 3.8.8 UIRenderer destroys RenderData on disable, including
        // ancestor deactivation; enable restores it through _flushAssembler.
        if(enabled)this.sprite._flushAssembler?.();else this.sprite.destroyRenderData();
      }
      for(const child of this.children)child.syncActive(enabled&&child.active);
    }
    addComponent(Type){const component=new Type(this);if(Type===Sprite)this.sprite=component;return component;}
    once(event,fn,target){this.listeners.push({fn,target});}
    destroy(){if(!this.isValid)return;this.isValid=false;for(const child of this.children)child.destroy();
      this.sprite?.destroyRenderData();for(const {fn,target}of this.listeners.splice(0))fn.call(target);}
  }
  class Sprite{
    static SizeMode={CUSTOM:0};
    constructor(node){Object.assign(this,{node,enabledInHierarchy:node.activeInHierarchy,
      customMaterial:null,color:{r:255,g:255,b:255,a:255}});sprites.push(this);}
    get renderData(){return this._renderData;}
    setFillColorType(value){this.fillColorType=value;}
    getRenderMaterial(){return this.customMaterial??defaultMaterial;}
    markForUpdateRenderData(){this.dirty=true;}
    destroyRenderData(){if(this._renderData?.chunk)accessor.recycleChunk(this._renderData.chunk);this._renderData=null;}
    requestRenderData(){
      const data={accessor,floatStride:9,data:[],vertDirty:true,updateRenderData(sprite,frame){this.frame=frame;},
        set dataLength(length){this.data=Array.from({length},()=>({}));},get dataLength(){return this.data.length;},
        resize(vc,ic){if(this.chunk)accessor.recycleChunk(this.chunk);this.chunk=accessor.allocateChunk(vc,ic);
          this.vertexCount=vc;this.indexCount=ic;assert.ok(this.chunk);},
      };this._renderData=data;return data;
    }
  }
  const makeNode=(name,parent)=>{const node=new Node(name);if(parent){parent.children.push(node);node.parent=parent;node.layer=parent.layer;}return node;};
  const {OrderedQuadBatch}=load(projectPath('assets/scripts/view/OrderedQuadBatch.ts'),{
    cc:{Node,Sprite},'./ArtLibrary':{makeNode},'./OriginalColorMath':{ORIGINAL_WORLD_LAYER:1<<19},
  });
  const parent=new Node('Parent'),batch=new OrderedQuadBatch({linearSpriteMaterial:linearMaterial},parent);
  function draw(opacity=1){
    accessor.reset();
    const walk=(node,parentOpacity)=>{if(!node.active||!node.isValid)return;
      node._uiProps.opacity=parentOpacity*node._uiProps.localOpacity;
      if(node.sprite){const s=node.sprite;s._assembler.updateRenderData();s._assembler.fillBuffers();
        // Creator 3.8.8 Batcher2D._handleUIRenderer only overrides COLOR=0.
        // VERTEX=1 is necessary for independently fading quads in one draw.
        if(s.fillColorType!==1)for(let i=8;i<s.renderData.chunk.vb.length;i+=9)s.renderData.chunk.vb[i]=node._uiProps.opacity;}
      for(const child of node.children)walk(child,node._uiProps.opacity);
    };walk(parent,opacity);accessor.uploadBuffers();
  }
  return{batch,parent,nodes,sprites,accessor,uploads,draw,linearMaterial,Sprite,makeNode};
}
function frame(texture={},uv=[0,1,1,1,0,0,1,0]){
  return{texture,uv,packable:true,originalSize:{width:100,height:80},trimmedBorder:{x:7,y:-11,z:5,w:-13}};
}
function add(batch,f,x=0,color=[1,1,1,1],material){batch.add(f,x,4,10,8,.3,.65,23,color,material);}

test('projected batch matches the actual 3.8.8 Sprite assembler geometry, UVs and colors',()=>{
  const h=fixture(),texture={},frames=[frame(texture),frame(texture,[.5,.25,.5,.75,.1,.25,.1,.75])];
  h.batch.begin();
  frames.forEach((f,index)=>add(h.batch,f,index*12,[.25,.5,1,.75]));h.batch.end();h.draw(.4);
  assert.equal(h.batch.diagnostics().activeRuns,1);assert.equal(h.sprites.length,1);
  const batchSprite=h.sprites[0],vb=batchSprite.renderData.chunk.vb;
  frames.forEach((f,index)=>{
    const node=h.makeNode('Reference'),sprite=new h.Sprite(node),radians=23*Math.PI/180;
    Object.assign(node.worldMatrix,{m00:Math.cos(radians),m01:Math.sin(radians),m04:-Math.sin(radians),m05:Math.cos(radians),m12:index*12,m13:4});
    node._getUITransformComp=()=>({width:10,height:8,anchorX:.3,anchorY:.65});
    sprite.spriteFrame=f;sprite.trim=false;sprite.color={r:63.75,g:127.5,b:255,a:191.25};
    simple.createData(sprite);simple.updateRenderData(sprite);simple.updateColor(sprite);simple.fillBuffers(sprite);
    const reference=sprite.renderData.chunk.vb;
    for(let i=0;i<4*9;i++)close(vb[index*4*9+i],reference[i]*(i%9===8?.4:1));
    assert.equal(f.packable,false);
  });
  assert.deepEqual(h.uploads[0].frames.at(-1),[0,1,2,1,3,2,4,5,6,5,7,6]);
});

test('only consecutive compatible textures/materials merge, retaining alpha and explicit material changes',()=>{
  const h=fixture(),a=frame(),b=frame(),otherMaterial={name:'other'};
  h.batch.begin();add(h.batch,a,0,[1,1,1,.2]);add(h.batch,a,1,[1,1,1,.8]);
  add(h.batch,b,2);add(h.batch,a,3);add(h.batch,a,4,[1,1,1,1],otherMaterial);h.batch.end();h.draw();
  assert.equal(h.batch.diagnostics().activeRuns,4);
  assert.deepEqual(h.sprites.map(s=>s.spriteFrame.texture),[a.texture,b.texture,a.texture,a.texture]);
  close(h.sprites[0].renderData.chunk.vb[8],.2);close(h.sprites[0].renderData.chunk.vb[44],.8);
  assert.equal(h.sprites[0].customMaterial,h.linearMaterial);assert.equal(h.sprites[3].customMaterial,otherMaterial);
  h.batch.begin();add(h.batch,b,10,[1,1,1,.3],null);h.batch.end();h.draw(.5);
  assert.equal(h.sprites[0].customMaterial,null);assert.equal(h.sprites[0].renderData.frame,b);
  assert.ok(h.sprites.slice(1).every(s=>!s.node.active));close(h.sprites[0].renderData.chunk.vb[8],.15);
});

test('growth, shrinking and hierarchy reactivation keep correct active indices and current ancestor opacity',()=>{
  const h=fixture(),f=frame();let previousCapacity=0;
  for(const count of [1,17,201,0,2,301,3]){
    h.batch.begin();for(let i=0;i<count;i++)add(h.batch,f,i,[1,1,1,.5]);h.batch.end();h.draw(.6);
    const d=h.batch.diagnostics();assert.equal(d.activeQuads,count);assert.ok(d.capacityQuads>=previousCapacity);previousCapacity=d.capacityQuads;
    assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),count*6);
    for(const s of h.sprites.filter(s=>s.node.active))close(s.renderData.chunk.vb[8],.3);
    h.parent.active=false;h.draw();assert.ok(h.accessor._buffers.every(b=>b.indexOffset===0));
    h.parent.active=true;h.draw(.2);
    for(const s of h.sprites.filter(s=>s.node.active))close(s.renderData.chunk.vb[8],.1);
  }
  const capacities=h.sprites.map(s=>s.renderData?.chunk);
  h.draw(.9);assert.deepEqual(h.sprites.map(s=>s.renderData?.chunk),capacities,'opacity-only change does not rebuild chunks');
  const originalVertex=Array.from(h.sprites[0].renderData.chunk.vb.slice(0,27));
  h.sprites[0].destroyRenderData();h.sprites[0]._flushAssembler();h.draw(.9);
  assert.deepEqual(Array.from(h.sprites[0].renderData.chunk.vb.slice(0,27)),originalVertex,
    'recreated engine RenderData restores the retained quad data');
  h.batch.destroy();h.batch.destroy();h.batch.begin();add(h.batch,f);h.batch.end();h.draw();
  assert.deepEqual({...h.batch.diagnostics()},{activeQuads:0,activeRuns:0,pooledRuns:0,capacityQuads:0});
  assert.ok(h.sprites.every(s=>!s.node.isValid));
});

test('first submission and pooled capacity growth work while a parent is inactive',()=>{
  const h=fixture(),f=frame();
  // A freshly constructed run is deactivated before the first add. The mock
  // now destroys RenderData exactly like the engine, reproducing the original
  // first-frame null-data failure rather than silently retaining the chunk.
  h.batch.begin();add(h.batch,f);h.batch.end();h.draw();
  assert.equal(h.batch.diagnostics().activeQuads,1);
  h.parent.active=false;assert.equal(h.sprites[0].renderData,null);
  h.batch.begin();for(let i=0;i<200;i++)add(h.batch,f,i);h.batch.end();
  assert.equal(h.sprites[0].renderData,null,'hidden growth only updates retained CPU storage');
  h.draw();assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),0);
  h.parent.active=true;h.draw(.25);
  assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),1200);
  close(h.sprites[0].renderData.chunk.vb[8],.25);
  h.batch.begin();h.batch.end();assert.equal(h.sprites[0].renderData,null);
  h.batch.begin();for(let i=0;i<256;i++)add(h.batch,f,i);h.batch.end();h.draw();
  assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),1536);
  // Also construct new runs under an already hidden hierarchy, then activate.
  h.parent.active=false;h.batch.begin();for(let i=0;i<700;i++)add(h.batch,f,i);h.batch.end();
  h.parent.active=true;h.draw();
  assert.equal(h.batch.diagnostics().activeRuns,3);
  assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),4200);
});

test('the authored maximum 1000 money particles uses four pooled Sprite runs and preserves parent transform',()=>{
  const h=fixture(),f=frame(),count=1000;
  h.batch.begin();for(let i=0;i<count;i++)add(h.batch,f,i);h.batch.end();
  assert.equal(h.batch.diagnostics().activeRuns,4);assert.equal(h.sprites.length,4);
  const m={m00:.3,m01:1.7,m02:.1,m03:.001,m04:-2,m05:.4,m06:.2,m07:0,m12:5,m13:7,m14:3,m15:1};
  Object.assign(h.sprites[0].node.worldMatrix,m);h.draw();
  const run=h.batch.runs[0],source=run.vertices,vb=h.sprites[0].renderData.chunk.vb;
  for(let i=0;i<run.count*4;i++){
    const x=source[i*9],y=source[i*9+1],w=1/(m.m03*x+m.m07*y+m.m15);
    close(vb[i*9],(m.m00*x+m.m04*y+m.m12)*w);
    close(vb[i*9+1],(m.m01*x+m.m05*y+m.m13)*w);
    close(vb[i*9+2],(m.m02*x+m.m06*y+m.m14)*w);
  }
});

test('dense bursts split before accessor capacity and Uint16 boundaries, uploading/resetting across frames',()=>{
  for(const [vertexCapacity,count]of [[32,29],[4096,17000]]){
    const h=fixture(vertexCapacity),f=frame();
    for(let iteration=0;iteration<2;iteration++){
      h.batch.begin();for(let i=0;i<count;i++)add(h.batch,f,i);h.batch.end();h.draw();
      assert.equal(h.accessor._buffers.reduce((n,b)=>n+b.indexOffset,0),count*6);
      assert.ok(h.batch.diagnostics().activeRuns>1);
      for(const buffer of h.accessor._buffers){
        assert.ok(buffer.indexOffset>0);
        for(const index of buffer.iData.subarray(0,buffer.indexOffset))assert.ok(index<vertexCapacity&&index<=65535);
      }
    }
    h.parent.destroy();assert.equal(h.batch.diagnostics().pooledRuns,0);
    assert.ok(h.sprites.every(s=>s._renderData===null));
  }
});

test('frame UV updates are resubmitted and caller color arrays may be reused without aliasing',()=>{
  const h=fixture(),f=frame(),tint=[1,0,0,.8];
  h.batch.begin();add(h.batch,f,0,tint);tint[0]=0;tint[1]=1;tint[3]=.4;add(h.batch,f,1,tint);h.batch.end();h.draw();
  let vb=h.sprites[0].renderData.chunk.vb;assert.equal(vb[5],1);assert.equal(vb[41],0);close(vb[44],.4);
  f.uv=[.1,.2,.3,.4,.5,.6,.7,.8];h.batch.begin();add(h.batch,f);h.batch.end();h.draw();
  vb=h.sprites[0].renderData.chunk.vb;
  for(let i=0;i<4;i++){close(vb[i*9+3],f.uv[i*2]);close(vb[i*9+4],f.uv[i*2+1]);}
});
