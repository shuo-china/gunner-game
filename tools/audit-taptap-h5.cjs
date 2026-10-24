'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function auditTapTapH5(directory) {
  const root = fs.realpathSync(directory);
  const files = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('Symlinks cannot enter the H5 package');
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(file);
      else throw new Error('Unexpected H5 file type');
    }
  }
  walk(root);
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const names = files.map(relative);
  for (const name of names) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.git|node_modules|game\.js|game\.json|project\.config\.json)(?:\/|$)|\.(?:map|ts|php|pem|key)$/i.test(name)) {
      throw new Error(`Unexpected source, secret or mini-game file: ${name}`);
    }
  }
  function localFile(reference, base = root) {
    if (!reference || /^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(reference) || reference.includes('\\')) {
      throw new Error(`Expected a relative local asset: ${reference}`);
    }
    const file = path.resolve(base, decodeURIComponent(reference.split(/[?#]/)[0]));
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing or escaping local asset: ${reference}`);
    }
    return file;
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...live.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  // Normalize CRLF, without evaluating arbitrary entry scripts during packaging.
  const first = scripts[0];
  if (!first || first[1].trim() || first[2].replace(/\r\n/g, '\n').trim() !==
    'globalThis.__FOREST_GUNNER_ENV__ = {"environment":"production"};\nglobalThis.__FOREST_GUNNER_PLATFORM__ = {"channel":"taptap-h5"};') {
    throw new Error('Expected production + taptap-h5 injection before all scripts');
  }
  if (/<base\b/i.test(live)) throw new Error('H5 entry must not replace the relative asset base');
  for (const match of live.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) localFile(match[1]);
  for (const match of live.matchAll(/System\.import\(["']([^"']+)["']\)/g)) localFile(match[1]);
  const settingNames = names.filter(name => /^src\/settings(?:\.[a-f0-9]+)?\.json$/.test(name));
  if (settingNames.length !== 1) throw new Error('Expected exactly one Creator settings file');
  const settings = JSON.parse(fs.readFileSync(path.join(root, settingNames[0]), 'utf8'));
  if (settings.splashScreen?.totalTime !== 0 || settings.splashScreen?.logo?.type !== 'none') {
    throw new Error('TapTap H5 must disable the Cocos splash screen before packaging');
  }
  if (settings.CocosEngine !== '3.8.8' || settings.engine?.debug !== false || settings.engine?.platform !== 'web-mobile' ||
    settings.screen?.orientation !== 'portrait' || settings.assets?.server !== '' ||
    !Array.isArray(settings.assets?.remoteBundles) || settings.assets.remoteBundles.length ||
    !Array.isArray(settings.assets?.subpackages) || settings.assets.subpackages.length) {
    throw new Error('Expected portrait, production Creator 3.8.8 with all bundles local');
  }
  if (!settings.assets.projectBundles?.includes('resources')) throw new Error('Missing bundled game resources');
  for (const bundle of settings.assets.projectBundles) {
    if (!/^[a-z0-9_-]+$/i.test(bundle)) throw new Error('Unexpected bundle name');
    const version = settings.assets.bundleVers?.[bundle];
    localFile(`assets/${bundle}/config${version ? '.' + version : ''}.json`);
  }
  for (const reference of settings.scripting?.scriptPackages ?? []) localFile(reference, path.join(root, 'src'));
  for (const name of names.filter(name => /^src\/import-map(?:\.[a-f0-9]+)?\.json$/.test(name))) {
    const map = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    // SystemJS resolves external import maps relative to their file URL.
    for (const reference of Object.values(map.imports ?? {})) localFile(reference, path.join(root, 'src'));
  }
  let hasApp = false, hasApi = false;
  const manifest = files.map(file => {
    const bytes = fs.readFileSync(file);
    if (/\.(?:js|json|html|css)$/.test(file)) {
      const source = bytes.toString('utf8');
      if (/sourceMappingURL\s*=|TAPTAP_MINI_SECRET\s*[=:]|MINIAPP_SECRET\s*[=:]|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i.test(source)) {
        throw new Error(`Debug or secret configuration found: ${relative(file)}`);
      }
      hasApp ||= source.includes('tapmcg8evaubisjmzc');
      hasApi ||= source.includes('https://nurse.kylinsit.com/game/v1');
    }
    return { path: relative(file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!hasApp || !hasApi) throw new Error('Expected TapTap application and production API in compiled game');
  return { version: 1, channel: 'taptap-h5', environment: 'production', appId: '997859',
    miniAppId: 'tapmcg8evaubisjmzc', api: 'https://nurse.kylinsit.com/game/v1',
    cocosSplashDisabled: true,
    realHostAcceptance: 'PENDING: tap.login + PHP exchange must pass in this application before release',
    fileCount: manifest.length, totalBytes: manifest.reduce((sum, item) => sum + item.bytes, 0), files: manifest };
}
if (require.main === module) {
  try {
    const [directory, output, ...extra] = process.argv.slice(2);
    if (!directory || extra.length) throw new Error('Usage: node tools/audit-taptap-h5.cjs BUILD [MANIFEST.json]');
    const report = auditTapTapH5(directory);
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`TapTap H5 audit passed: ${report.fileCount} files, ${report.totalBytes} bytes. Real host acceptance pending.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { auditTapTapH5 };
