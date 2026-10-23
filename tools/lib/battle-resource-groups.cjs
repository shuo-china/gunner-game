'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decodeUuid } = require('./bundle-native-files.cjs');

// The authored directories contain both encounter art and complete UI catalogs.
// Follow actual image paths in battle/HUD definitions, including deduplicated images
// owned by another directory, instead of treating the directory as one feature.
function battleResourceGroups(input, config, sources) {
  const groups = new Map(), images = new Set(), parsed = new Map();
  const hasWeaponRuntime = Object.values(config.paths || {}).some(item => item[0] === 'art/weapon-runtime/index');
  const packs = new Map();
  for (const [uuid, indices] of Object.entries(config.packs || {})) for (const index of indices) packs.set(String(index), uuid);
  const sourceFiles = sources ? Object.keys(sources) : [];
  const add = (asset, group) => {
    const previous = groups.get(asset);
    groups.set(asset, previous && previous !== group ? 'battle-shared' : group);
  };
  const inspect = (value, group) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && value.path.startsWith('art/') &&
      (Array.isArray(value.sizePx) || Array.isArray(value.sizeUnits) || typeof value.aspect === 'number')) {
      images.add(value.path); add(value.path, group);
    }
    for (const child of Object.values(value)) inspect(child, group);
  };
  for (const [index, item] of Object.entries(config.paths || {})) {
    if (config.types[item[1]] !== 'cc.JsonAsset') continue;
    if (hasWeaponRuntime && item[0] === 'art/weapon-system/visuals') {
      // Keep the original export available at its existing URL for authoring
      // and verification, without making it a dependency of the split runtime.
      groups.set(item[0], 'weapon-authoring');
      continue;
    }
    const runtime = /^art\/weapon-runtime\/(index|projectiles\/([a-z-]+))$/.exec(item[0]);
    const match = /^art\/(weapon|skin|pet|raid|boss|hunt|mine)-system\/(?:visuals|critical\/config|characters\/[^/]+\/rig)$/.exec(item[0]);
    // Core HUD/effect art can also be deduplicated into a feature directory (or
    // referenced by a panel). Track those consumers so e.g. the cash icon does
    // not make an unopened weapon inventory a prerequisite for the main HUD.
    const core = /^art\/(?:catalog$|(?:hud|upgrades|stage-transition|ui-alert|weapon-grade-effects|tutorial-system)\/config$|(?:effects|characters)\/)/.test(item[0]);
    if (!runtime && !match && !core) continue;
    const group = runtime ? 'battle-weapon-' + (runtime[2] || 'core') : match ? 'battle-' + match[1] : 'core';
    add(item[0], group);
    const uuid = packs.get(index) || decodeUuid(config.uuids[Number(index)]);
    const directory = `remote/resources/import/${uuid.slice(0, 2)}`;
    const file = sources ? sourceFiles.find(file => file.startsWith(directory + '/') && path.basename(file).startsWith(uuid + '.'))
      : directory + '/' + fs.readdirSync(path.join(input, directory)).find(file => file.startsWith(uuid + '.') && file.endsWith('.json'));
    if (!file) throw new Error('Missing battle definition: ' + item[0]);
    if (!parsed.has(file)) parsed.set(file, JSON.parse(sources ? sources[file] : fs.readFileSync(path.join(input, file), 'utf8')));
    inspect(parsed.get(file), group);
  }
  return { groups, images };
}
module.exports = { battleResourceGroups };
