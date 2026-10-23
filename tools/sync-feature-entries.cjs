'use strict';
// Extract only menu-button nodes and their dependencies from the reviewed UI exports.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { optimizeConfig, compactJson } = require('./optimize-resource-data.cjs');
const root = path.resolve(__dirname, '../assets/resources/art/feature-entries');
const names = { weapons: 'weapon', rebirth: 'rebirth', speedrun: 'speedrun', raid: 'raid', boss: 'boss', skins: 'skin', pets: 'pet', fish: 'fish', hunt: 'hunt', mine: 'mine', adventure: 'adventure', dailyCheck: 'daily-check' };
function buildEntries() {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(names)) {
    const config = JSON.parse(fs.readFileSync(path.join(root, '..', source + '-system/config.json')));
    const nodes = {}, images = {}, bitmapFonts = {}, textProfiles = {};
    function visit(id) {
      const node = nodes[id] = structuredClone(config.nodes[id]);
      if (node.image?.sprite) images[node.image.sprite] = config.images[node.image.sprite];
      if (node.text?.profile) {
        const key = node.text.profile, font = structuredClone(config.bitmapFonts[key]);
        const codes = new Set(Array.from(node.text.value, ch => String(ch.codePointAt(0))));
        font.glyphs = Object.fromEntries(Object.entries(font.glyphs).filter(([code]) => codes.has(code)));
        // Retain only variants rendered by this fixed entry label.
        const pages = new Set();
        for (const glyph of Object.values(font.glyphs)) {
          const color = node.text.color.join(',');
          const variant = glyph.variants[color] || glyph.variants['255,255,255,255'] || Object.values(glyph.variants)[0];
          glyph.variants = variant ? { [color]: variant } : {};
          if (variant) pages.add(variant.page);
        }
        const indices = Array.from(pages).sort((a,b) => a-b);
        font.pages = indices.map(index => font.pages[index]);
        for (const glyph of Object.values(font.glyphs)) for (const variant of Object.values(glyph.variants)) variant.page = indices.indexOf(variant.page);
        bitmapFonts[key] = font;
        if (config.textProfiles?.[key]) textProfiles[key] = config.textProfiles[key];
      }
      node.children.forEach(visit);
    }
    visit(config.roots.entry);
    const result = { version: 1, referenceWidth: config.referenceWidth, roots: { entry: config.roots.entry },
      nodes, images, roles: {}, gunIcons: [], degreeColors: [], translations: {}, bitmapFonts, textProfiles };
    optimizeConfig(result);
    const file = path.join(root, name + '.json'), data = compactJson(result) + '\n';
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== data) fs.writeFileSync(file, data);
    if (!fs.existsSync(file + '.meta')) fs.writeFileSync(file + '.meta', JSON.stringify({ver:'2.0.1',importer:'json',imported:true,uuid:crypto.randomUUID(),files:['.json'],subMetas:{},userData:{}},null,2)+'\n');
  }
}
if (require.main === module) { buildEntries(); console.log('Feature entry resources synchronized.'); }
module.exports = { buildEntries };
