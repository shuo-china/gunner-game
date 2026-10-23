const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = require(path.join(root, 'assets/resources/art/ui-alert/config.json'));
const source = fs.readFileSync(path.join(root, 'assets/scripts/view/OriginalAlerts.ts'), 'utf8');

function harness() {
  class UITransform {
    setContentSize(width, height) { Object.assign(this, { width, height }); }
  }
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true, scale: {x:1,y:1,z:1}, position: {x:0,y:0,z:0} }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const instance = new Type(); instance.node = this; this.components.set(Type, instance); return instance; }
    getComponent(Type) { return this.components.get(Type); }
    setScale(x,y,z) { this.scale = {x,y,z}; }
    setPosition(x,y,z=0) { this.position = {x,y,z}; }
    setSiblingIndex(index) { const list = this.parent.children; list.splice(list.indexOf(this),1); list.splice(index,0,this); }
    destroy() { this.destroyed = true; this.children.forEach(node => node.destroy()); }
  }
  class Color { constructor(r,g,b,a) { Object.assign(this,{r,g,b,a}); } }
  class Graphics { clear() { this.rectangles=[]; } rect(...value) { this.rectangles.push(value); } fill() {} }
  class Label { string=''; static HorizontalAlign={CENTER:0}; static VerticalAlign={CENTER:0}; static Overflow={SHRINK:0}; }
  class Font {}
  const makeNode = (name,parent) => { const node=new Node(name); node.addComponent(UITransform); if(parent)parent.addChild(node); return node; };
  const font=new Font(), requests=[];
  const resources={load:(key,Type,callback)=>{ requests.push(key); callback(null,font); }};
  const cc={Color,Font,Graphics,Label,Node,resources,UITransform};
  const art={json:async key=>{ requests.push(key); return config; },loadFrame:async key=>{ requests.push(key); }};
  const module={exports:{}};
  const imports={cc,'./ArtLibrary':{makeNode},'./FontPolicyLabel':require('./support/font-policy-handle.cjs')};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018}}).outputText,
    {module,exports:module.exports,require:key=>{assert.ok(key in imports);return imports[key];}});
  const parent=makeNode('Canvas'), alerts=new module.exports.OriginalAlerts(parent,art,{config,font});
  return {alerts,parent,cc,font,requests,art,exports:module.exports,makeNode};
}

function near(actual,expected,tolerance=0.001) { assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`); }

test('source warning text is imported verbatim and formatting leaves unknown placeholders intact',()=>{
  const {alerts}=harness();
  assert.equal(alerts.text('Alarm/UnSelectError'),'无法卸下 - 至少需要装备1件！');
  assert.equal(alerts.text('Alarm/SelectedFusionError'),'请先卸下装备再合成！');
  assert.equal(alerts.text('Gun/InventoryFull'),'请清空背包。');
  assert.equal(alerts.text('Gun/PauseMergeError'),'锁定的武器无法合成。');
  assert.equal(alerts.text('Gun/PauseLocked'),'关卡40后可用！');
  assert.equal(alerts.text('Alarm/MaxGradeError'),'已达最高等级，无法合成！');
  assert.equal(alerts.text('StarUpgrade/NotEnoughGem'),'强化石不足');
  assert.equal(alerts.text('StarUpgrade/StarUpgradeSuccess'),'强化成功！');
  assert.equal(alerts.text('StarUpgrade/StarUpgradeFail'),'强化失败..');
  assert.equal(alerts.text('{0} / {1}',7),'7 / {1}');
});

test('the source cubic rises quickly then settles instead of using a linear toast tween',()=>{
  const {alerts}=harness(); alerts.show('source');
  near(alerts.node.position.y,200);
  alerts.update(1/3); near(alerts.node.position.y,341.666658);
  alerts.update(1/3); near(alerts.node.position.y,500);
  alerts.update(2/3); near(alerts.node.position.y,541.666665);
  assert.equal(alerts.node.active,true);
});

test('background and text use independent source alpha curves with the delayed fade',()=>{
  const {alerts,cc}=harness(); alerts.show('source');
  const band=alerts.node.children[0].getComponent(cc.Graphics), text=alerts.node.children[1].getComponent(cc.Label);
  assert.equal(band.fillColor.a,153); assert.equal(text.color.a,255);
  alerts.update(1.2166666984558105);
  assert.equal(band.fillColor.a,153); assert.equal(text.color.a,255);
  alerts.update(.55);
  near(band.fillColor.a,77,1.01); near(text.color.a,128,1.01);
  assert.ok(text.color.a>band.fillColor.a,'background alpha never propagates into text');
  assert.equal(alerts.node.getComponent(cc.Graphics),undefined);
  assert.equal(alerts.node.getComponent(cc.Label),undefined);
});

test('the two-second Destroy wins over the longer source animation clip',()=>{
  const {alerts,cc}=harness(); alerts.show('warning');
  alerts.update(1.999);
  assert.equal(alerts.node.active,true);
  assert.ok(alerts.node.children[1].getComponent(cc.Label).color.a>0);
  alerts.update(.0011);
  assert.equal(alerts.node.active,false);
  assert.equal(alerts.elapsed,0);
  assert.ok(config.animation.clipDuration>2.3);
});

test('one shared alert restarts immediately, replaces text, raises to top and cancels the old lifetime',()=>{
  const {alerts,parent,makeNode,cc}=harness(); alerts.show('first'); alerts.update(1.8);
  makeNode('LaterPopup',parent);
  alerts.showLocalized('Alarm/UnSelectError');
  assert.equal(parent.children.at(-1),alerts.node);
  assert.equal(alerts.node.children.length,2);
  near(alerts.node.position.y,200);
  assert.equal(alerts.node.children[1].getComponent(cc.Label).string,'无法卸下 - 至少需要装备1件！');
  assert.equal(alerts.node.children[1].getComponent(cc.Label).color.a,255);
  alerts.update(.3); assert.equal(alerts.node.active,true,'the first message deadline no longer applies');
  alerts.update(1.7); assert.equal(alerts.node.active,false);
});

test('clear and destruction cancel visible feedback without delayed reactivation',()=>{
  const {alerts}=harness(); alerts.show('one'); alerts.clear(); alerts.update(10);
  assert.equal(alerts.node.active,false);
  alerts.show('two'); assert.equal(alerts.node.active,true);
  alerts.destroy(); alerts.destroy(); alerts.show('three'); alerts.update(1); alerts.resize(390,844);
  assert.equal(alerts.node.destroyed,true); assert.equal(alerts.node.active,false);
});

test('full-screen positioning and band bounds stay proportional at all acceptance viewports',()=>{
  const {alerts,cc}=harness();
  for(const [width,height] of [[360,640],[390,844],[412,915]]) {
    alerts.resize(width,height); alerts.show('警告'); const scale=width/1080;
    near(alerts.node.position.x,2*scale); near(alerts.node.position.y,200*scale);
    near(alerts.node.scale.x,scale);
    const band=alerts.node.children[0].getComponent(cc.UITransform), text=alerts.node.children[1].getComponent(cc.UITransform);
    near(band.width*scale,width); near(band.height,48); near(text.height,44);
  }
});

test('alert delegates mixed text measurement without old Chinese font advances or input listeners',()=>{
  const {alerts,cc,font}=harness(); alerts.showLocalized('Alarm/UnSelectError');
  const text=alerts.node.children[1].getComponent(cc.Label);
  assert.equal(text.font,null); assert.equal(text.policyFont,config.bitmapFont);
  near(text.fontSize,config.font.sizeMax*config.font.scale);
  near(text.lineHeight,text.fontSize*config.font.lineHeight/config.font.pointSize);
  assert.equal(text.enableWrapText,true);
  assert.equal(alerts.node.components.size,1);
  assert.equal(alerts.node.children[0].components.size,2);
  assert.equal(alerts.node.children[1].components.size,2);
  assert.doesNotMatch(source,/BlockInputEvents|\.on\(|addComponent\(LabelOutline\)|roundRect/);
});

test('all Chinese warnings use system text regardless of the old subset coverage',()=>{
  const {alerts,cc,font}=harness();
  const legacy=JSON.parse(JSON.stringify(config));
  for(const char of '新手引导皮肤')delete legacy.font.advances[String(char.codePointAt(0))];
  alerts.assets={config:legacy,font};
  alerts.show('完成新手引导后开放皮肤。');
  const label=alerts.node.children[1].getComponent(cc.Label);
  assert.equal(label.string,'完成新手引导后开放皮肤。');
  assert.equal(label.useSystemFont,true);
  assert.equal(label.fontFamily,'sans-serif');
  alerts.showLocalized('Alarm/UnSelectError');
  assert.equal(label.useSystemFont,true);
  assert.equal(label.font,null);
});

function glyphPresent(buffer,code) {
  let cmap=0;
  for(let i=0;i<buffer.readUInt16BE(4);i++) {
    const entry=12+i*16;
    if(buffer.toString('ascii',entry,entry+4)==='cmap')cmap=buffer.readUInt32BE(entry+8);
  }
  assert.ok(cmap,'font cmap exists');
  for(let i=0;i<buffer.readUInt16BE(cmap+2);i++) {
    const base=cmap+buffer.readUInt32BE(cmap+4+i*8+4),format=buffer.readUInt16BE(base);
    if(format===12) {
      for(let j=0;j<buffer.readUInt32BE(base+12);j++) {
        const p=base+16+j*12,from=buffer.readUInt32BE(p),to=buffer.readUInt32BE(p+4);
        if(from<=code&&code<=to&&buffer.readUInt32BE(p+8)+code-from)return true;
      }
    } else if(format===4&&code<=0xffff) {
      const count=buffer.readUInt16BE(base+6)/2,end=base+14,start=end+2*count+2,delta=start+2*count,offset=delta+2*count;
      for(let j=0;j<count;j++)if(buffer.readUInt16BE(start+j*2)<=code&&code<=buffer.readUInt16BE(end+j*2)) {
        const change=buffer.readInt16BE(delta+j*2),range=buffer.readUInt16BE(offset+j*2);
        let glyph=range?buffer.readUInt16BE(offset+j*2+range+(code-buffer.readUInt16BE(start+j*2))*2):code;
        if(glyph&&(glyph+change)&0xffff)return true;
      }
    }
  }
  return false;
}

test('authored warnings retain their glyphs and new runtime text has an explicit readable fallback',()=>{
  const font=fs.readFileSync(path.join(root,'assets/resources/art/ui-alert/chinese.ttf'));
  const sources=['view/WeaponHud.ts','view/RebirthHud.ts','view/SpeedRunHud.ts','session/ContentUnlockManager.ts'];
  const runtimeMessages=sources.map(source=>fs.readFileSync(path.join(root,'assets/scripts',source),'utf8')).join('');
  const characters=new Set(Array.from(Object.values(config.messages).join('')+(runtimeMessages.match(/[\u3400-\u9fff]/g)||[]).join('')));
  const authored=new Set(Array.from(Object.values(config.messages).join('')));
  const {alerts,cc}=harness();
  for(const char of characters) {
    if(authored.has(char))assert.ok(glyphPresent(font,char.codePointAt(0)),`missing authored glyph ${char}`);
    if(glyphPresent(font,char.codePointAt(0)))assert.ok(config.font.advances[String(char.codePointAt(0))]>0,`missing width ${char}`);
    else {
      alerts.show(char);
      assert.equal(alerts.node.children[1].getComponent(cc.Label).useSystemFont,true,`missing fallback ${char}`);
    }
  }
  assert.equal(glyphPresent(font,0xffff),false,'missing-glyph sentinel is not accepted');
  assert.equal(config.source.hierarchy,'Canvas/UI_manager/Alert_list/Alert');
  assert.equal(config.poolSize,1);
});

test('shared alert resources load independently of weapon UI and do not require payment assets',async()=>{
  const {exports,art,requests,font}=harness();
  const loaded=await exports.loadOriginalAlertAssets(art);
  assert.ok(loaded.font);
  assert.deepEqual(requests,['art/ui-alert/config',...config.bitmapFont.pages]);
  assert.doesNotMatch(JSON.stringify(Object.keys(config.messages)),/Purchase|Store|Inapp|Payment/);
});

test('redemption results include every glyph in the packaged alert font',()=>{
  const settings=require('../assets/resources/art/settings-system/config.json');
  const message=settings.input.invalidMessage;
  assert.equal(message,'兑换码不存在');
  assert.equal(config.messages['Redeem/Alert_Invalid'],message);
  assert.equal(settings.input.successMessage,'获得{0}颗钻石！');
  assert.equal(settings.input.alreadyUsedMessage,'兑换码已被使用。');
  assert.equal(config.messages['Redeem/Alert_GetDia'],settings.input.successMessage);
  assert.equal(config.messages['Redeem/Alert_AlreadyUsed'],settings.input.alreadyUsedMessage);
  const font=fs.readFileSync(path.join(root,'assets/resources/art/ui-alert/chinese.ttf'));
  const messages=[message,settings.input.successMessage.replace('{0}','2000'),settings.input.alreadyUsedMessage,
    settings.input.saveFailedMessage,settings.input.walletLimitMessage];
  for(const char of messages.join('')){
    assert.ok(glyphPresent(font,char.codePointAt(0)),`missing redemption glyph ${char}`);
    assert.ok(config.font.advances[String(char.codePointAt(0))]>0,`missing redemption width ${char}`);
  }
  const {alerts,cc}=harness();alerts.show(message);
  assert.equal(alerts.node.children[1].getComponent(cc.Label).string,message);
  alerts.showLocalized('Redeem/Alert_GetDia',2000);
  assert.equal(alerts.node.children[1].getComponent(cc.Label).string,'获得2000颗钻石！');
});
