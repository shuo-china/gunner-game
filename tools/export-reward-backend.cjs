#!/usr/bin/env node
'use strict';

// One source of economy values and offline arithmetic for the client and PHP.
// Run after changing EconomyConfig or any offline combat dependency:
//   node tools/export-reward-backend.cjs [--check]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const backendRoot = path.resolve(projectRoot, '../PHP');
const targetRoot = path.join(backendRoot, 'bin/reward-runtime');
const configFile = path.join(backendRoot, 'config/rewards-economy.json');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: export-reward-backend.cjs [--check]');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forest-gunner-reward-'));

function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${child}`);
    return entry.isDirectory() ? files(child).map(file => path.join(entry.name, file)) : [entry.name];
  }).sort();
}
function writeOrCheck(filename, content) {
  const same = fs.existsSync(filename) && fs.readFileSync(filename).equals(content);
  if (check && !same) throw new Error(`Reward backend artifact is stale: ${path.relative(backendRoot, filename)}. Run node tools/export-reward-backend.cjs.`);
  if (!check && !same) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
}
try {
  const entries = ['session/OfflineProgressSimulator.ts', 'session/WeaponInventory.ts', 'session/RebirthSystem.ts',
    'session/PetSystem.ts', 'session/SkinSystem.ts', 'session/FishSystem.ts', 'session/RelicSystem.ts'];
  const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'),
    '--target', 'ES2018', '--module', 'commonjs', '--strict', '--skipLibCheck', '--removeComments',
    '--rootDir', path.join(projectRoot, 'assets/scripts'), '--outDir', temporaryRoot,
    ...entries.map(entry => path.join(projectRoot, 'assets/scripts', entry))],
  { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Reward runtime compilation failed (${result.status}).`);
  const { ECONOMY_CONFIG } = require(path.join(temporaryRoot, 'core/EconomyConfig.js'));
  const config = { schemaVersion: 1, dailyCheck: ECONOMY_CONFIG.dailyCheck, dailyShare: ECONOMY_CONFIG.dailyShare,
    redeemCodes: ECONOMY_CONFIG.redeemCodes.map(reward => ({ code: reward.code, diamonds: reward.diamonds, mode: reward.mode })) };
  if (config.redeemCodes.some(reward => !['per_player', 'global_once'].includes(reward.mode))) {
    throw new Error('Every redeem code needs a per_player or global_once mode.');
  }
  const outputFiles = files(temporaryRoot);
  for (const relative of files(targetRoot)) {
    if (!outputFiles.includes(relative)) throw new Error(`Unexpected generated runtime file: ${relative}. Remove it before exporting.`);
  }
  for (const relative of outputFiles) writeOrCheck(path.join(targetRoot, relative), fs.readFileSync(path.join(temporaryRoot, relative)));
  writeOrCheck(configFile, Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
  console.log(`Reward backend ${check ? 'checked' : 'exported'}: ${outputFiles.length} runtime modules and economy configuration.`);
} finally {
  // The only recursive removal is this invocation's mkdtemp directory.
  const resolved = path.resolve(temporaryRoot), parent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('forest-gunner-reward-')) {
    throw new Error('Refusing to remove an unexpected temporary directory.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
