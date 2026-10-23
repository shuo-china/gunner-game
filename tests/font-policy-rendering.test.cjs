const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  const frames = [], measured = [], drawn = [];
  class Color {
    constructor(r = 255, g = 255, b = 255, a = 255) { Object.assign(this, { r, g, b, a }); }
    static WHITE = new Color();
  }
  class Vec2 { constructor(x = 0, y = 0) { Object.assign(this, { x, y }); } }
  class UITransform {
    width = 0; height = 0; anchorX = .5; anchorY = .5;
    setContentSize(width, height) { Object.assign(this, { width, height }); }
    setAnchorPoint(anchorX, anchorY) { Object.assign(this, { anchorX, anchorY }); }
  }
  class Node {
    constructor(name) { Object.assign(this, { name, children: [], components: new Map(), active: true, isValid: true, layer: 1,
      position: { x: 0, y: 0 }, scale: { x: 1, y: 1, z: 1 } }); }
    addChild(node) { node.parent = this; this.children.push(node); }
    addComponent(Type) { const component = new Type(); component.node = this; this.components.set(Type, component); return component; }
    getComponent(Type) { return this.components.get(Type); }
    setPosition(x, y) { this.position = { x, y }; }
    setScale(x, y, z = 1) { this.scale = { x, y, z }; }
    destroy() { if (!this.isValid) return; this.isValid = false; this.active = false; this.children.forEach(node => node.destroy()); }
  }
  class Label {
    static HorizontalAlign = { LEFT: 0, CENTER: 1, RIGHT: 2 };
    static VerticalAlign = { TOP: 0, CENTER: 1, BOTTOM: 2 };
    static Overflow = { NONE: 0, CLAMP: 1, SHRINK: 2 };
    constructor() { Object.assign(this, { enabled: true, color: new Color(), fontSize: 40, lineHeight: 50, string: '', horizontalAlign: 1, verticalAlign: 1, overflow: 1, enableWrapText: false, shadowOffset: new Vec2(), updates: 0 }); }
    updateRenderData() {
      this.updates++;
      const characters = Array.from(this.string), fontSize = this.fontSize;
      // Deliberately differs from the old Chinese bitmap advances. Also model
      // system-font kerning to verify runs use measured widths, not character sums.
      const width = (characters.reduce((sum, char) => sum + (char === '中' ? .72 : /[\x20-\x7e]/.test(char) ? .5 : .93), 0)
        - (this.string.includes('Ωé') ? .12 : 0)) * fontSize * (1 + (this.isBold ? .1 : 0) + (this.isItalic ? .05 : 0));
      const padding = this.enableOutline ? this.outlineWidth : 0;
      this.node.getComponent(UITransform).setContentSize(width + padding * 2, fontSize * 1.26 + padding * 2);
      this.textLayoutData = { canvasSize: { height: fontSize * 1.26 + padding * 2 }, startPosition: { x: padding, y: fontSize * .87 + padding } };
      if (this.node.name === 'FontPolicyMeasure') measured.push(this.string);
      else if (this.node.name === 'SystemGlyph') drawn.push(this.string);
    }
  }
  class LabelOutline { enabled = true; width = 3; color = new Color(101, 69, 45); }
  class LabelShadow { enabled = true; offset = new Vec2(1, -2); blur = 0; color = new Color(0, 0, 0, 120); }
  class Sprite { static SizeMode = { CUSTOM: 0 }; color = Color.WHITE; }
  class SpriteFrame {
    destroyCalls = 0;
    constructor() { frames.push(this); }
    reset(value) { Object.assign(this, value); }
    destroy() { this.destroyCalls++; }
  }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
  class Graphics { clear() {} roundRect() {} fill() {} }
  const makeNode = (name, parent) => { const node = new Node(name); node.addComponent(UITransform); if (parent) parent.addChild(node); return node; };
  const cc = { Color, Vec2, Label, LabelOutline, LabelShadow, Sprite, SpriteFrame, Rect, Size, Graphics, Node, UITransform };
  const imports = { cc, './ArtLibrary': { makeNode }, './ResourceBatch': {} };
  for (const name of ['OriginalBitmapText', 'FontPolicyLabel', 'OriginalWeaponUi']) {
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/view', `${name}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, require: name => { assert.ok(name in imports, `missing import ${name}`); return imports[name]; } });
    imports[`./${name}`] = module.exports;
  }
  const font = { pages: ['western'], pointSize: 100, scale: 1, ascent: 90, descent: -20, lineHeight: 120, glyphs: {} };
  for (const char of Array.from(' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,%/+-×÷−中文攻击')) {
    const code = char.codePointAt(0);
    font.glyphs[code] = { advance: char.charCodeAt(0) > 255 ? 100 : 60, bearingX: 1, bearingY: 80, width: 55, height: 90,
      variants: { '255,255,255,255': { page: 0, rect: [code, 0, 55, 90] }, '255,95,95,255': { page: 0, rect: [code, 90, 55, 90] } } };
  }
  const artFrame = { texture: {}, destroyCalls: 0 }, icon = { texture: {} };
  const art = { frames: new Map([['western', artFrame], ['cash', icon]]) };
  const { OriginalBitmapText, OriginalBitmapTextFactory, usesOriginalFontCharacter } = imports['./OriginalBitmapText'];
  const { attachFontPolicyLabel } = imports['./FontPolicyLabel'];
  const { OriginalWeaponUi } = imports['./OriginalWeaponUi'];
  function render(value, overrides = {}, width = 500, height = 150) {
    const node = makeNode('Text'); node.getComponent(UITransform).setContentSize(width, height);
    const label = node.addComponent(Label); label.enabled = false;
    const spec = { size: 40, autosize: false, wrap: false, horizontal: 1, vertical: 512, color: [255, 255, 255, 255], ...overrides };
    const factory = new OriginalBitmapTextFactory(art, { text: font }, { 0: { width: 100, height: 100, bearingX: 0, bearingY: 90, advance: 100, scale: 1, pointSize: 100 } }, { 0: 'cash' });
    const renderer = new OriginalBitmapText(node, spec, font, factory); renderer.setText(value);
    return { node, label, spec, factory, renderer };
  }
  const glyphs = node => node.children.filter(child => child.active && child.name === 'OriginalGlyph');
  const system = node => node.children.filter(child => child.active && child.name === 'SystemGlyph').map(child => child.getComponent(Label));
  return { ...cc, font, art, icon, artFrame, frames, measured, drawn, makeNode, render, glyphs, system,
    OriginalBitmapTextFactory, OriginalWeaponUi, usesOriginalFontCharacter, attachFontPolicyLabel };
}

function hudCurrencyFixture(width, options = {}) {
  const h = fixture(), font = require('../assets/resources/art/hud/config.json').bitmapFont;
  for (const page of font.pages) h.art.frames.set(page, h.artFrame);
  const node = h.makeNode('Price_txt'); node.getComponent(h.UITransform).setContentSize(width, 54);
  const label = node.addComponent(h.Label);
  label.fontSize = 32; label.lineHeight = 40; label.overflow = h.Label.Overflow.SHRINK;
  const handle = h.attachFontPolicyLabel(label, h.art, font, options);
  const draw = value => {
    label.string = value; handle.sync();
    return h.glyphs(node).map(glyph => {
      const transform = glyph.getComponent(h.UITransform);
      return { left: glyph.position.x, right: glyph.position.x + transform.width, width: transform.width, height: transform.height };
    });
  };
  return { ...h, font, node, label, handle, draw };
}

test('only Western display characters use authored atlas glyphs, including number formatting symbols', () => {
  const h = fixture();
  for (const char of 'Az09 .%/+-×÷−') assert.equal(h.usesOriginalFontCharacter(char), true, char);
  for (const char of '中文，。！（）Ω🙂') assert.equal(h.usesOriginalFontCharacter(char), false, char);
});

test('Chinese sentences use one system face for their Latin, digits and punctuation even when atlas glyphs exist', () => {
  const h = fixture(), f = h.render('攻击Boss605！', { systemStyle: { outlineWidth: .05, outlineColor: [101, 69, 45, 255] } });
  assert.deepEqual(h.system(f.node).map(label => label.string), ['攻击Boss605！']);
  assert.equal(h.glyphs(f.node).length, 0);
  for (const label of h.system(f.node)) {
    assert.equal(label.useSystemFont, true); assert.equal(label.font, null); assert.equal(label.fontFamily, 'sans-serif');
    assert.equal(label.outlineWidth, 2);
  }
  assert.ok(h.measured.includes('攻击Boss605！'), 'the entire sentence uses measured system advances');
});

test('entry labels can use the Chinese system face for Boss while ordinary Latin and numbers retain their atlas', () => {
  const h = fixture(), systemStyle = { outlineWidth: .05, outlineColor: [101, 69, 45, 255] };
  const boss = h.render('Boss', { useSystemFont: true, systemStyle });
  const chinese = h.render('宠物', { systemStyle });
  assert.equal(h.glyphs(boss.node).length, 0, 'existing ASCII atlas glyphs must not override the entry font choice');
  assert.deepEqual(h.system(boss.node).map(label => label.string), ['Boss']);
  const style = label => [label.font, label.useSystemFont, label.fontFamily, label.fontSize, label.isBold,
    label.isItalic, label.enableOutline, label.outlineWidth, label.outlineColor, label.shadowOffset];
  assert.deepEqual(style(h.system(boss.node)[0]), style(h.system(chinese.node)[0]));
  assert.equal(h.system(boss.node)[0].isBold, false);
  assert.ok(h.measured.includes('Boss'), 'the Latin entry uses actual system-font advances');
  for (const value of ['Boss', '605']) {
    const ordinary = h.render(value, { systemStyle });
    assert.equal(h.system(ordinary.node).length, 0, value);
    assert.equal(h.glyphs(ordinary.node).length, value.length, value);
  }
});

test('forced system labels preserve font choice and glyph pools through text reuse and inline-icon preparation', () => {
  const h = fixture(), f = h.render('Boss', { useSystemFont: true });
  const firstLabel = h.system(f.node)[0];
  assert.equal(f.renderer.canStageInitialText('Boss'), true);
  assert.equal(f.renderer.canStageInitialText('605'), true);
  assert.equal(f.renderer.canStageInitialText('<sprite=0>Boss'), false, 'mixed system and icon pools retain their initial order');
  assert.equal(f.renderer.canStageInitialText('中文<sprite=0>605'), false);
  const ordinary = h.render('605');
  assert.equal(ordinary.renderer.canStageInitialText('<sprite=0>605'), true, 'an entirely bitmap row remains stageable');
  for (const value of ['中文', '605', 'Boss']) {
    f.renderer.setText(value);
    assert.equal(h.system(f.node)[0], firstLabel, value);
    assert.equal(firstLabel.string, value);
    assert.equal(h.glyphs(f.node).length, 0, value);
  }
  f.renderer.setText('<sprite=0>Boss');
  const icons = h.glyphs(f.node);
  assert.equal(icons.length, 1, 'the icon remains the only bitmap glyph');
  assert.equal(icons[0].getComponent(h.Sprite).spriteFrame, h.icon);
  assert.equal(h.system(f.node)[0], firstLabel);
  assert.equal(firstLabel.string, 'Boss');
  assert.ok(icons[0].position.x < firstLabel.node.position.x);
  f.renderer.setText('Boss');
  assert.equal(h.glyphs(f.node).length, 0, 'removing the inline icon hides its pooled glyph');
  assert.equal(h.system(f.node)[0], firstLabel);
});

test('missing Latin, Unicode and emoji remain visible, while system-run kerning determines following glyph placement', () => {
  const h = fixture(); delete h.font.glyphs[90];
  const f = h.render('ΩéA🙂Z');
  assert.equal(h.system(f.node).map(label => label.string).join(''), 'Ωé🙂Z');
  assert.equal(h.glyphs(f.node).length, 1);
  assert.ok(Math.abs(h.glyphs(f.node)[0].position.x - (-250 + (1.86 - .12) * 40 + .4)) < .0001);
});

test('mixed text wraps and shrinks within the source box and retains inline icon order', () => {
  const h = fixture(), f = h.render('中A文2', { wrap: true }, 80, 130);
  const system = h.system(f.node);
  assert.equal(system.length, 2); assert.ok(system[0].node.position.y > system[1].node.position.y);
  const price = h.render('<sprite=0>605', { autosize: true, minSize: 10, maxSize: 40 }, 70, 70);
  assert.equal(h.glyphs(price.node)[0].getComponent(h.Sprite).spriteFrame, h.icon);
  assert.equal(h.glyphs(price.node).length, 4); assert.ok(price.renderer.fontSize < 40);
});

test('approved loading, speed, weapon, unlock, challenge, raid, fish and reward copy uses system text', () => {
  const h = fixture(), config = name => require(`../assets/resources/art/${name}/config.json`);
  const values = [
    '版本 0.1.29\n正在准备武器界面 0/3…',
    '等待：武器资源（已等待 10 秒）\n模块已完成 6/12 · 资源已完成 265 项',
    '资源加载失败：武器界面\nHTTP 503: weapon-atlas-1\n点击这里重试',
    config('stage-transition').nodes['level0:10104'].text.value,
    '请先抽取 2 次武器（0/2）。', '请先将两把 D 级武器拖到一起合成。', '请先穿戴刚合成的 C 级弩。',
    config('weapon-system').translations.SlotUpgrade.replace('{0}', '1'),
    config('ui-alert').messages['Alarm/UnSelectError'],
    '成功通关1次挑战后开放皮肤。', '第40关起可用。', '攻击升级达到 Lv.3 后开放挑战与武器。',
    config('boss-system').translations['Alarm/StageUnlock'].replace('{0}', '10'),
    config('speedrun-system').nodes['level0:10311'].text.value,
    config('mine-system').nodes['level0:10373'].text.value, config('mine-system').nodes['level0:10240'].text.value,
    config('raid-system').nodes['level0:10363'].text.value,
    config('raid-system').translations['Raid/HighScore_History'].replace('{0}', 'Lv.10'),
    config('raid-system').translations['Raid/Mission_BestLevel'].replace('{0}', '100'),
    config('raid-system').translations['Raid/Mission_TryCount'].replace('{0}', '3'),
    'D级鱼', 'SS级鱼', 'ZZZ级鱼', config('settings-system').input.successMessage.replace('{0}', '1000'),
  ];
  for (const value of values) {
    const f = h.render(value, { wrap: true, autosize: true, minSize: 10, maxSize: 40 }, 300, 180);
    assert.equal(h.glyphs(f.node).length, 0, value);
    assert.equal(h.system(f.node).map(label => label.string).join(''), value.replace(/\n/g, ''), value);
    assert.ok(h.system(f.node).every(label => label.useSystemFont && label.fontFamily === 'sans-serif' && label.font === null), value);
    f.renderer.destroy(); f.factory.destroy();
  }
});

test('rich Chinese copy keeps colored spans and inline icons while all visible text uses system fonts', () => {
  const h = fixture(), f = h.render('使用<color=yellow>(弓)造成10倍</color>伤害！<sprite=0>获得605', {}, 1200);
  assert.deepEqual(h.system(f.node).map(label => label.string), ['使用', '(弓)造成10倍', '伤害！', '获得605']);
  const yellow = h.system(f.node)[1].color;
  assert.deepEqual([yellow.r, yellow.g, yellow.b], [255, 255, 0]);
  assert.equal(h.glyphs(f.node).length, 1, 'the icon is the only sprite glyph');
  assert.equal(h.glyphs(f.node)[0].getComponent(h.Sprite).spriteFrame, h.icon);
  assert.ok(h.glyphs(f.node)[0].position.x < h.system(f.node)[3].node.position.x, 'reward text stays after its icon');
  const hidden = h.render('<font=中文>605</font>');
  assert.equal(h.system(hidden.node).length, 0, 'hidden tag contents do not change numeric-only labels');
  assert.equal(h.glyphs(hidden.node).length, 3);
});

test('reused labels switch between numeric display and mixed system text without leaving old glyphs visible', () => {
  const h = fixture(), f = h.render('605'), originals = h.glyphs(f.node);
  assert.equal(originals.length, 3);
  for (const value of ['获得605颗钻石！', '获得1000颗钻石！']) {
    f.renderer.setText(value);
    assert.equal(h.glyphs(f.node).length, 0);
    assert.deepEqual(h.system(f.node).map(label => label.string), [value]);
  }
  f.renderer.setText('605');
  assert.deepEqual(h.glyphs(f.node), originals, 'returning to numeric text reuses the original glyphs');
  assert.equal(h.system(f.node).length, 0);
});

test('HUD currency glyph bounds fit a safe text area for large balances and restore small balances at full size', () => {
  const cases = [
    { currency: 'money', width: 120, values: ['39', '392.71c', '999.99m', '999.99aa', '1.79e+308', '39'] },
    { currency: 'diamonds', width: 100, values: ['39', '9999999', '9999999999', '9007199254740991', '39'] },
  ];
  for (const { currency, width, values } of cases) {
    const f = hudCurrencyFixture(width, { fitGlyphBounds: true, characterSpacing: 9 });
    for (const alignment of [f.Label.HorizontalAlign.LEFT, f.Label.HorizontalAlign.CENTER, f.Label.HorizontalAlign.RIGHT]) {
      f.label.horizontalAlign = alignment;
      let initial;
      for (const [index, value] of values.entries()) {
        const bounds = f.draw(value), context = `${currency} ${value}, alignment ${alignment}`;
        assert.equal(bounds.length, value.length, `${context}: no glyph is dropped`);
        assert.equal(f.system(f.node).length, 0, `${context}: all characters retain the HUD font`);
        for (const glyph of bounds) {
          assert.ok(glyph.left >= -width / 2 - .001, `${context}: glyph starts outside the text box (${glyph.left})`);
          assert.ok(glyph.right <= width / 2 + .001, `${context}: glyph ends outside the text box (${glyph.right})`);
        }
        const displayedSize = bounds[0].width / f.font.glyphs[value.codePointAt(0)].width * f.font.pointSize;
        if (index === 0) {
          initial = bounds;
          assert.ok(Math.abs(displayedSize - 32) < .001, `${context}: short values retain the authored size`);
          const left = Math.min(...bounds.map(glyph => glyph.left)), right = Math.max(...bounds.map(glyph => glyph.right));
          const alignmentError = alignment === f.Label.HorizontalAlign.LEFT ? left + width / 2
            : alignment === f.Label.HorizontalAlign.RIGHT ? right - width / 2 : (left + right) / 2;
          assert.ok(Math.abs(alignmentError) < .001, `${context}: alignment includes the visible outline`);
        } else if (index === values.length - 1) {
          assert.deepEqual(bounds, initial, `${context}: returning to a small balance restores its size and alignment`);
        } else {
          assert.ok(displayedSize > 0 && displayedSize < 32, `${context}: long values shrink`);
        }
        assert.equal(f.label.fontSize, 32, `${context}: autosizing does not change the requested font size`);
      }
    }
    f.handle.destroy();
  }
});

test('HUD fitting is opt-in and preserves the previous advance-based layout when disabled', () => {
  const defaultView = hudCurrencyFixture(120), disabled = hudCurrencyFixture(120, { fitGlyphBounds: false });
  const fitted = hudCurrencyFixture(120, { fitGlyphBounds: true });
  const previous = defaultView.draw('999.99m');
  assert.deepEqual(disabled.draw('999.99m'), previous, 'omitting the option keeps the previous layout');
  assert.ok(previous.some(glyph => glyph.left < -60 || glyph.right > 60), 'the original advance-based fit excludes the authored outline overhang');
  const safe = fitted.draw('999.99m');
  assert.ok(safe.every(glyph => glyph.left >= -60 - .001 && glyph.right <= 60 + .001));
  assert.ok(safe[0].width < previous[0].width, 'including the visible outline reduces the fitted size');
  for (const view of [defaultView, disabled, fitted]) view.handle.destroy();
});

test('Label adapter forwards authored character spacing without changing glyph size in an ample box', () => {
  const normal = hudCurrencyFixture(500, { fitGlyphBounds: true });
  const spaced = hudCurrencyFixture(500, { fitGlyphBounds: true, characterSpacing: 9 });
  normal.label.horizontalAlign = spaced.label.horizontalAlign = normal.Label.HorizontalAlign.LEFT;
  const regular = normal.draw('392.71c'), authored = spaced.draw('392.71c');
  assert.equal(authored.length, regular.length);
  assert.deepEqual(authored.map(glyph => glyph.width), regular.map(glyph => glyph.width), 'spacing leaves the font size unchanged');
  assert.ok(authored[1].left - authored[0].left > regular[1].left - regular[0].left, 'the adapter applies the supplied spacing between glyphs');
  assert.ok(authored.at(-1).right - authored[0].left > regular.at(-1).right - regular[0].left, 'authored positive spacing separates the digits');
  normal.handle.destroy(); spaced.handle.destroy();
});

test('dynamic alpha cascades once through the disabled source Label and unchanged frames do not allocate', () => {
  const h = fixture(), f = h.render('605');
  f.renderer.setText('中605');
  const firstFrames = h.frames.slice(), measured = h.measured.length;
  f.renderer.setText('中605'); assert.equal(h.frames.length, firstFrames.length); assert.equal(h.measured.length, measured);
  f.label.color = new h.Color(255, 255, 255, 128); f.renderer.tint([255, 255, 255, 128]);
  assert.ok(h.glyphs(f.node).every(node => node.getComponent(h.Sprite).color.a === 255));
  assert.equal(h.system(f.node)[0].color.a, 255);
  assert.deepEqual(h.frames, firstFrames, 'alpha changes reuse the opaque baked variant');
  f.renderer.setText('MAX'); assert.equal(h.system(f.node).length, 0);
  f.renderer.destroy(); f.renderer.destroy(); f.factory.destroy(); f.factory.destroy();
  assert.ok(h.frames.every(frame => frame.destroyCalls === 1)); assert.equal(h.artFrame.destroyCalls, 0);
});

test('repeated Chinese names share measured advances across a panel without extra measurement textures', () => {
  const h = fixture(), first = h.render('中文');
  const count = h.measured.length, node = h.makeNode('Repeated'); node.getComponent(h.UITransform).setContentSize(500, 150);
  const repeated = new first.renderer.constructor(node, first.spec, h.font, first.factory); repeated.setText('中文');
  assert.equal(h.measured.length, count);
  assert.equal(node.children.some(node => node.name === 'FontPolicyMeasure'), false);
  assert.deepEqual(h.system(node).map(label => label.string), ['中文']);
});

test('Label adapter synchronizes text, effects and size without changing authored fontsize or double-applying opacity', () => {
  const h = fixture(), node = h.makeNode('Value'); node.getComponent(h.UITransform).setContentSize(300, 44.2822);
  const label = node.addComponent(h.Label); label.fontSize = 45; label.lineHeight = 44.2822; label.overflow = h.Label.Overflow.SHRINK; label.string = '605中';
  const outline = node.addComponent(h.LabelOutline); const shadow = node.addComponent(h.LabelShadow);
  const handle = h.attachFontPolicyLabel(label, h.art, h.font);
  assert.equal(label.enabled, false); assert.equal(label.fontSize, 45);
  assert.equal(label.font, null); assert.equal(label.useSystemFont, true); assert.equal(label.fontFamily, 'sans-serif');
  assert.equal(h.system(node)[0].fontSize, 45, 'single-line original bounds do not shrink a 45px face');
  assert.equal(h.system(node)[0].outlineWidth, outline.width); assert.equal(h.system(node)[0].shadowOffset.y, shadow.offset.y);
  const count = h.frames.length, measurements = h.measured.length; handle.sync();
  assert.equal(h.frames.length, count); assert.equal(h.measured.length, measurements);
  label.string = 'Lv.24中文'; label.color = new h.Color(255, 95, 95, 80); handle.sync();
  assert.equal(h.system(node)[0].string, 'Lv.24中文'); assert.equal(h.system(node)[0].color.a, 255);
  assert.equal(h.glyphs(node).length, 0);
  assert.deepEqual([h.system(node)[0].color.r, h.system(node)[0].color.g, h.system(node)[0].color.b], [255, 95, 95]);
  handle.destroy(); handle.destroy(); assert.equal(label.enabled, true);
  assert.ok(h.frames.every(frame => frame.destroyCalls === 1));
});

test('Label adapter can switch baked font variants by instance size and releases only its owned frame views', () => {
  const h = fixture(), node = h.makeNode('Value'); node.getComponent(h.UITransform).setContentSize(500, 100);
  const label = node.addComponent(h.Label); label.string = '605';
  const alternate = { ...h.font, pages: ['alternate'] }; h.art.frames.set('alternate', { texture: { alternate: true } });
  const handle = h.attachFontPolicyLabel(label, h.art, h.font, { selectFont: label => label.fontSize > 40 ? alternate : h.font });
  const previous = h.frames.slice(); label.fontSize = 60; handle.sync();
  assert.ok(previous.every(frame => frame.destroyCalls === 1));
  assert.ok(h.glyphs(node).every(node => node.getComponent(h.Sprite).spriteFrame.texture.alternate));
  handle.destroy(); assert.ok(h.frames.every(frame => frame.destroyCalls === 1));
});

test('system advances are shared across panels in one art session and remain isolated by font style and session', () => {
  const h = fixture(), first = h.render('中文'), measured = h.measured.length;
  const second = h.render('中文');
  assert.equal(h.measured.length, measured, 'another panel reuses exact measured prefixes');
  assert.equal(second.node.children.some(node => node.name === 'FontPolicyMeasure'), false);
  first.factory.destroy(); h.render('中文');
  assert.equal(h.measured.length, measured, 'closing one panel retains other panels numeric measurements');
  const regularWidth = h.system(second.node)[0].node.getComponent(h.UITransform).width;
  const bold = h.render('中文', { systemStyle: { bold: true } });
  assert.equal(h.measured.length, measured * 2);
  const italic = h.render('中文', { systemStyle: { italic: true } });
  assert.equal(h.measured.length, measured * 3);
  assert.ok(h.system(bold.node)[0].node.getComponent(h.UITransform).width > regularWidth);
  assert.ok(h.system(italic.node)[0].node.getComponent(h.UITransform).width > regularWidth);
  h.render('中文', { systemStyle: { bold: true }, color: [255, 95, 95, 100] });
  assert.equal(h.measured.length, measured * 3, 'color does not alter measured advances');
  const otherArt = { frames: h.art.frames }, factory = new h.OriginalBitmapTextFactory(otherArt, { text: h.font }, {}, {});
  const node = h.makeNode('NewSession'); node.getComponent(h.UITransform).setContentSize(500, 150);
  new first.renderer.constructor(node, first.spec, h.font, factory).setText('中文');
  assert.equal(h.measured.length, measured * 4, 'another session measures its own current device font');
});

test('changing and oversized system text cannot grow the shared numeric cache without bound', () => {
  const h = fixture(), view = h.render('中0');
  for (let i = 1; i <= 2300; i++) view.renderer.setText('中' + i);
  assert.ok(view.factory.systemWidthCache.size <= 2048);
  assert.ok(Array.from(view.factory.systemWidthCache.values()).every(value => Number.isFinite(value)));
  const long = '中文'.repeat(160);
  const first = h.render(long), priorMeasurements = h.measured.filter(value => value === long).length;
  const second = h.render(long);
  assert.ok(h.measured.filter(value => value === long).length > priorMeasurements, 'long runs are measured accurately without permanent cache entries');
  assert.deepEqual(h.system(first.node).map(label => [label.string, label.node.position]),
    h.system(second.node).map(label => [label.string, label.node.position]));
  assert.ok(Array.from(view.factory.systemWidthCache.keys()).every(key => key.length <= 288));
});

function preparationTextFixture(authoredChild = false) {
  const h = fixture();
  const rect = { min: [.5, .5], max: [.5, .5], position: [0, 0], size: [300, 100], pivot: [.5, .5], scale: [1, 1], angle: 0 };
  const base = { active: true, components: [], children: [], rect };
  const text = { size: 40, autosize: true, minSize: 15, maxSize: 40, wrap: true, horizontal: 2, vertical: 512,
    color: [255, 255, 255, 255], outline: true, font: 'original', profile: 'text', term: '' };
  const values = { latin: '<sprite=0>605.25k', chinese: '攻击 <color=#ff5f5f>Boss605</color>！', dynamic: '初始99' };
  const nodes = { root: { ...base, id: 'root', transform: 'root-tr', name: 'Root', children: Object.keys(values) } };
  for (const [id, value] of Object.entries(values)) nodes[id] = { ...base, id, transform: id + '-tr', name: id, text: { ...text, value } };
  if (authoredChild) {
    nodes.latin.children = ['core'];
    nodes.core = { ...base, id: 'core', transform: 'core-tr', name: 'Core_img' };
  }
  const config = { nodes, images: { cash: { path: 'cash' } }, bitmapFonts: { text: h.font }, inlineSprites: { 0: 'cash' },
    inlineSpriteMetrics: { 0: { width: 100, height: 100, bearingX: 0, bearingY: 90, advance: 100, scale: 1, pointSize: 100 } } };
  const ui = new h.OriginalWeaponUi(h.art, { config, originalFont: null, numberFont: null, chineseFont: null });
  const parent = h.makeNode('Canvas'), owner = h.makeNode('Panel', parent);
  const snapshot = () => JSON.parse(JSON.stringify(Object.keys(nodes).map(id => {
    const node = ui.node(id), tr = node.getComponent(h.UITransform), label = node.getComponent(h.Label);
    return { id, position: node.position, size: [tr.width, tr.height], active: node.active,
      text: label && [label.string, label.fontSize, label.color],
      glyphs: h.glyphs(node).map(child => { const sprite = child.getComponent(h.Sprite), size = child.getComponent(h.UITransform);
        return [child.position, size.width, size.height, sprite.color, sprite.spriteFrame.rect ?? 'cash']; }),
      system: h.system(node).map(label => [label.string, label.fontSize, label.node.position, label.color, label.outlineWidth,
        label.outlineColor, label.shadowColor, label.shadowOffset, label.node.getComponent(h.UITransform).width]) };
  })));
  function* initialize() {
    yield* ui.createSteps('root', owner);
    ui.setText('dynamic', '中文 <sprite=0>605'); ui.tint('chinese', [180, 210, 240, 130]);
    yield;
    yield* ui.layoutSteps('root', 500, 600);
    ui.setText('dynamic', '中文 <sprite=0>808');
  }
  return { ...h, ui, owner, parent, initialize, snapshot };
}

test('managed construction draws final text once after layout with identical styled glyphs, refresh, updates and resize', async () => {
  const sync = preparationTextFixture(), managed = preparationTextFixture();
  await sync.ui.prepare(sync.owner, sync.parent, sync.initialize());
  const driver = require('./support/ui-preparation.cjs').preparationDriver(); driver.prepare.managed = true;
  let complete = false;
  const prepared = managed.ui.prepare(managed.owner, managed.parent, managed.initialize(), driver.prepare).then(() => { complete = true; });
  await Promise.resolve(); driver.advance(4);
  assert.equal(complete, false); assert.equal(managed.drawn.length, 0); assert.equal(managed.frames.length, 0);
  assert.equal(managed.owner.active, false, 'unfinished text stays under the managed preparation shield');
  await driver.flush(); await prepared;
  assert.deepEqual(managed.snapshot(), sync.snapshot());
  assert.ok(managed.drawn.length < sync.drawn.length, `${managed.drawn.length} final-layout draws versus ${sync.drawn.length} including prelayout draws`);
  for (const value of ['99.5k', '中文 <color=#ff5f5f>605</color>', '<sprite=0>17']) {
    for (const h of [sync, managed]) { h.ui.setText('dynamic', value); h.ui.tint('dynamic', [255, 95, 95, 90]); h.ui.layout('root', 360, 780); }
    assert.deepEqual(managed.snapshot(), sync.snapshot(), value);
  }
  managed.ui.destroy(); sync.ui.destroy();
});

test('managed preparation flushes an unlaid hidden root before readiness and standalone creation keeps immediate text', async () => {
  const managed = preparationTextFixture(), driver = require('./support/ui-preparation.cjs').preparationDriver(); driver.prepare.managed = true;
  const prepared = managed.ui.prepare(managed.owner, managed.parent, managed.ui.createSteps('root', managed.owner), driver.prepare);
  await Promise.resolve(); driver.advance(4);
  assert.equal(managed.drawn.length, 0);
  await driver.flush(); await prepared;
  assert.ok(managed.system(managed.ui.node('chinese')).length > 0);
  assert.ok(managed.glyphs(managed.ui.node('latin')).length > 0);
  const immediate = preparationTextFixture(); immediate.ui.create('root', immediate.owner);
  assert.deepEqual(managed.snapshot(), immediate.snapshot(), 'flush preserves the synchronous path even without a layout pass');
  managed.ui.destroy(); immediate.ui.destroy();
});

test('managed text parents preserve glyph sibling order before authored children', async () => {
  const sync = preparationTextFixture(true), managed = preparationTextFixture(true);
  await sync.ui.prepare(sync.owner, sync.parent, sync.initialize());
  const driver = require('./support/ui-preparation.cjs').preparationDriver(); driver.prepare.managed = true;
  const prepared = managed.ui.prepare(managed.owner, managed.parent, managed.initialize(), driver.prepare);
  await driver.flush(); await prepared;
  const childOrder = h => h.ui.node('latin').children.map(child => child.name);
  assert.ok(childOrder(sync).indexOf('Core_img') > childOrder(sync).indexOf('OriginalGlyph'));
  assert.deepEqual(childOrder(managed), childOrder(sync), 'authored content must remain after initial text glyphs');
  assert.deepEqual(managed.snapshot(), sync.snapshot());
  for (const h of [sync, managed]) { h.ui.setText('latin', '<sprite=0>17'); h.ui.layout('root', 360, 780); }
  assert.deepEqual(childOrder(managed), childOrder(sync), 'runtime updates and resize retain the original sibling order');
  assert.deepEqual(managed.snapshot(), sync.snapshot());
  managed.ui.destroy(); sync.ui.destroy();
});

test('failed managed construction discards staged text without rendering or activating a partial panel', async () => {
  const h = preparationTextFixture(), driver = require('./support/ui-preparation.cjs').preparationDriver(); driver.prepare.managed = true;
  const steps = function* () { yield* h.ui.createSteps('root', h.owner); throw new Error('cancelled construction'); };
  const rejected = assert.rejects(h.ui.prepare(h.owner, h.parent, steps(), driver.prepare), /cancelled construction/);
  await driver.flush(); await rejected;
  assert.equal(h.owner.isValid, false); assert.equal(h.drawn.length, 0); assert.equal(h.frames.length, 0);
});
