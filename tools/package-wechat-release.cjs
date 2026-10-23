'use strict';
// Package a production Creator build; remote resources never enter the code upload.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { packageStartupMetadata, installStartupErrorHandler } = require('./wechat-startup-package.cjs');
const { packageMapResources } = require('./wechat-map-package.cjs');
const { packageFeatureResources } = require('./wechat-feature-package.cjs');
const [built, destination, version = '0.1.0'] = process.argv.slice(2);
if (!built || !destination || process.argv.length > 5 || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: node tools/package-wechat-release.cjs BUILD RELEASE [VERSION]');
const input = path.resolve(built), output = path.resolve(destination);
const code = path.join(output, 'wechatgame'), server = path.join(output, 'server');
if (output === input || output.startsWith(input + path.sep) || input.startsWith(output + path.sep + 'wechatgame' + path.sep)) throw new Error('Input and package output must be separate');
for (const dir of [code, server]) if (fs.existsSync(dir)) throw new Error(`Refusing to overwrite ${dir}`);
const project = JSON.parse(fs.readFileSync(path.join(input, 'project.config.json'), 'utf8'));
if (project.appid !== 'wx3dd63318911f5012' || project.compileType !== 'game') throw new Error('Unexpected WeChat project identity');
const entry = fs.readFileSync(path.join(input, 'game.js'), 'utf8');
if (!entry.startsWith('/* FOREST_GUNNER_ENV_START */') || !entry.includes('globalThis.__FOREST_GUNNER_ENV__ = {"environment":"production"};')) throw new Error('Expected injected production entry');
const settingsName = fs.readdirSync(path.join(input, 'src')).find(x => /^settings\..*\.json$/.test(x));
const settings = JSON.parse(fs.readFileSync(path.join(input, 'src', settingsName), 'utf8'));
if (settings.engine.debug || settings.assets.server !== 'https://nurse.kylinsit.com/forest-gunner/' || !settings.assets.remoteBundles.includes('resources') || settings.assets.subpackages.length) throw new Error('Unexpected remote release settings');
const firstScreenNames = fs.readdirSync(input).filter(name => /^first-screen(?:\.[0-9a-f]+)?\.js$/.test(name));
if (firstScreenNames.length !== 1) throw new Error('Expected one startup screen script');
const firstScreen = fs.readFileSync(path.join(input, firstScreenNames[0]), 'utf8');
if (!/let useLogo = false;/.test(firstScreen) || !/let useDefaultLogo = false;/.test(firstScreen)
  || settings.splashScreen?.totalTime !== 0) {
  throw new Error('Expected the logo-free project startup template and disabled engine splash');
}
const remoteConfig = `remote/resources/config.${settings.assets.bundleVers.resources}.json`;
if (!fs.existsSync(path.join(input, remoteConfig))) throw new Error('Missing remote resource config');
// Creator has already assigned content hashes. This step is read-only: any
// image transformation must happen to source assets before the Creator build.
// CDN files and official subpackage copies must retain the hashed build bytes.
fs.mkdirSync(output, { recursive: true });
const pngReport = path.join(output, 'png-optimization.json');
const optimized = spawnSync(process.env.FOREST_GUNNER_PYTHON || 'python', [path.join(__dirname, 'optimize-release-pngs.py'),
  '--build', input, '--report', pngReport], { encoding: 'utf8', windowsHide: true });
if (optimized.status !== 0) throw new Error('PNG audit requires Python with Pillow: ' + (optimized.error?.message || optimized.stderr || optimized.stdout));
const pngOptimization = JSON.parse(fs.readFileSync(pngReport, 'utf8'));
if (pngOptimization.applied !== false) throw new Error('PNG audit must not modify hashed build resources');
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(server, { recursive: true });
for (const file of fs.readdirSync(input)) {
  if (file === 'logo.png' || file === 'slogan.png') continue;
  if (file === 'remote') fs.cpSync(path.join(input, file), path.join(server, file), { recursive: true });
  else fs.cpSync(path.join(input, file), path.join(code, file), { recursive: true });
}
const startupMetadata = packageStartupMetadata(input, code, settings.assets.server);
installStartupErrorHandler(code);
const mapResources = packageMapResources(input, code,
  JSON.parse(fs.readFileSync(path.join(input, remoteConfig), 'utf8')), settings.assets.server,
  path.join(output, 'map-package-index.json'));
const featureResources = packageFeatureResources(input, code,
  JSON.parse(fs.readFileSync(path.join(input, remoteConfig), 'utf8')), settings.assets.server,
  path.join(output, 'feature-package-index.json'), startupMetadata.packages);
const subpackages = Array.from(new Map([...startupMetadata.packages, ...mapResources.packages, ...featureResources.packages]
  .map(item => [item.name, item])).values());
// Match the installed official builder's default MaxSubPackageLimit. The
// platform's account-specific compiler remains the final authority at upload.
if (subpackages.length > 100) throw new Error(`Too many WeChat subpackages: ${subpackages.length} (limit 100)`);
const cocosLicenses = fs.readdirSync(code).filter(name => /^cocos-startup\.LICENSE(?:\.[0-9a-f]+)?\.txt$/.test(name));
if (cocosLicenses.length !== 1) throw new Error('Missing Cocos startup template license');
const packedEntryPath = path.join(code, 'game.js');
const packedEntry = fs.readFileSync(packedEntryPath, 'utf8');
const environmentEnd = '/* FOREST_GUNNER_ENV_END */';
if (packedEntry.split(environmentEnd).length !== 2) throw new Error('Missing unique environment marker');
fs.writeFileSync(packedEntryPath, 'globalThis.__FOREST_GUNNER_BOOT_STARTED_AT__ = Date.now();\n' + packedEntry.replace(environmentEnd,
  environmentEnd + '\n' + 'globalThis.__FOREST_GUNNER_RELEASE__ = ' + JSON.stringify(version) + ';'));
project.packOptions = { ignore: [{ type: 'folder', value: 'remote' }], include: [
  ...startupMetadata.packages.map(item => ({ type: 'file', value: item.path || startupMetadata.path })),
  { type: 'file', value: 'startup-inflate.LICENSE.txt' },
  { type: 'file', value: cocosLicenses[0] },
] };
fs.writeFileSync(path.join(code, 'project.config.json'), JSON.stringify(project, null, 2) + '\n');
const gameConfigPath = path.join(code, 'game.json');
const gameConfig = JSON.parse(fs.readFileSync(gameConfigPath, 'utf8'));
// The engine template allows each bad download to wait over eight minutes.
// Bound stalled downloads; optional panels and audio have independent retries.
gameConfig.networkTimeout = { ...gameConfig.networkTimeout, downloadFile: 120000 };
gameConfig.subpackages = subpackages.map(({ name, root }) => ({ name, root }));
fs.writeFileSync(gameConfigPath, JSON.stringify(gameConfig, null, 2) + '\n');
const webConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <staticContent>
      <remove fileExtension=".json" /><mimeMap fileExtension=".json" mimeType="application/json" />
      <remove fileExtension=".ttf" /><mimeMap fileExtension=".ttf" mimeType="font/ttf" />
      <remove fileExtension=".bin" /><mimeMap fileExtension=".bin" mimeType="application/octet-stream" />
      <remove fileExtension=".cconb" /><mimeMap fileExtension=".cconb" mimeType="application/octet-stream" />
    </staticContent>
    <httpProtocol><customHeaders>
      <remove name="Access-Control-Allow-Origin" /><add name="Access-Control-Allow-Origin" value="*" />
    </customHeaders></httpProtocol>
  </system.webServer>
</configuration>
`;
fs.writeFileSync(path.join(server, 'web.config'), webConfig);
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(x => x.isDirectory() ? files(path.join(dir, x.name)) : [path.join(dir, x.name)]); }
function manifest(dir) { return files(dir).map(file => ({ path: path.relative(dir, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })); }
fs.writeFileSync(path.join(server, 'release-health.json'), JSON.stringify({ appid: project.appid, version, environment: 'production', adsEnabled: false, resources: settings.assets.bundleVers.resources }) + '\n');
const codeFiles = manifest(code), remoteFiles = manifest(server);
const codeBytes = codeFiles.reduce((sum, x) => sum + x.bytes, 0);
const mainPackageBytes = codeFiles.filter(x => !subpackages.some(p => x.path.startsWith(p.root))).reduce((sum, x) => sum + x.bytes, 0);
const subpackageBudgets = subpackages.map(({ name, root }) => ({ name, root,
  bytes: codeFiles.filter(file => file.path.startsWith(root)).reduce((sum, file) => sum + file.bytes, 0),
  limitBytes: 4 * 1024 * 1024 }));
for (const item of subpackageBudgets) {
  if (item.bytes > item.limitBytes) throw new Error(`Subpackage ${item.name} exceeds 4 MiB: ${item.bytes}`);
}
if (mainPackageBytes > 4 * 1024 * 1024) throw new Error(`Main package exceeds 4 MiB: ${mainPackageBytes}`);
if (codeBytes > 30 * 1024 * 1024) throw new Error(`Total package exceeds 30 MiB: ${codeBytes}`);
const report = { appid: project.appid, version, environment: 'production', adsEnabled: false, cocosSplashRemoved: true, server: settings.assets.server, remoteConfig, startupMetadata, mapResources, featureResources,
  pngOptimization: { applied: false, before: pngOptimization.before, after: pngOptimization.before, saved: 0,
    potentialSaved: pngOptimization.saved, rgbaPixelsEqual: pngOptimization.rgbaPixelsEqual, colorProfileEqual: pngOptimization.colorProfileEqual },
  mainPackageBytes, subpackageBudgets, codeBytes, remoteBytes: remoteFiles.reduce((sum, x) => sum + x.bytes, 0), codeFiles, remoteFiles };
fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ codeBytes, remoteBytes: report.remoteBytes, remoteConfig, code, server }));
