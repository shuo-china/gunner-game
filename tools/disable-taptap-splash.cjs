'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Creator 3.8.8 ignores the CLI splash override for this Web build. Change its
// generated settings, then rebuild the same five-character MD5 reference chain.
function disableTapTapSplash(directory) {
  const root = fs.realpathSync(directory);
  const src = path.join(root, 'src');
  if (!fs.lstatSync(src).isDirectory() || fs.lstatSync(src).isSymbolicLink()) {
    throw new Error('Expected a local Creator src directory');
  }
  const digest = source => crypto.createHash('md5').update(source).digest('hex').slice(0, 5);
  function read(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  function unique(dir, name, extension) {
    const names = fs.readdirSync(dir).filter(file =>
      new RegExp(`^${name}(?:\\.[a-f0-9]+)?\\.${extension}$`, 'i').test(file));
    if (names.length !== 1) throw new Error(`Expected exactly one Creator ${name} file`);
    const file = path.join(dir, names[0]);
    const source = read(file);
    if (names[0] !== `${name}.${digest(source)}.${extension}`) {
      throw new Error(`Unexpected Creator MD5 filename: ${names[0]}`);
    }
    return { file, source, name, extension };
  }
  function replaceReference(source, from, to) {
    if (source.split(from).length !== 2) throw new Error(`Expected one reference to ${from}`);
    return source.replace(from, to);
  }
  function renamed(file, source) {
    return { ...file, next: path.join(path.dirname(file.file), `${file.name}.${digest(source)}.${file.extension}`), content: source };
  }
  const settingsFile = unique(src, 'settings', 'json');
  const application = unique(root, 'application', 'js');
  const bootstrap = unique(root, 'index', 'js');
  const entry = path.join(root, 'index.html');
  const html = read(entry);
  const liveHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const firstScript = liveHtml.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
  if (!firstScript || firstScript[1].trim() || firstScript[2].replace(/\r\n/g, '\n').trim() !==
    'globalThis.__FOREST_GUNNER_ENV__ = {"environment":"production"};\nglobalThis.__FOREST_GUNNER_PLATFORM__ = {"channel":"taptap-h5"};') {
    throw new Error('Splash processing requires production + taptap-h5 injection before all scripts');
  }
  if (/<base\b/i.test(liveHtml)) throw new Error('Unexpected HTML asset base');
  const settings = JSON.parse(settingsFile.source);
  if (settings.CocosEngine !== '3.8.8' || settings.engine?.platform !== 'web-mobile' || settings.engine?.debug !== false) {
    throw new Error('Splash processing requires a production Creator 3.8.8 web-mobile build');
  }
  if (!settings.splashScreen || typeof settings.splashScreen !== 'object' || Array.isArray(settings.splashScreen) ||
    !Number.isFinite(settings.splashScreen.totalTime) || !settings.splashScreen.logo) {
    throw new Error('Unexpected Creator splash settings');
  }
  const settingsReference = `src/${path.basename(settingsFile.file)}`;
  const applicationReference = `./${path.basename(application.file)}`;
  const bootstrapReference = `./${path.basename(bootstrap.file)}`;
  const settingsLinks = [...application.source.matchAll(/this\.settingsPath\s*=\s*(['"])([^'"]+)\1/g)];
  const applicationLinks = [...bootstrap.source.matchAll(/System\.register\(\[(['"])([^'"]+)\1\]/g)];
  const bootstrapLinks = [...liveHtml.matchAll(/System\.import\((['"])([^'"]+)\1\)/g)];
  if (settingsLinks.length !== 1 || settingsLinks[0][2] !== settingsReference ||
    applicationLinks.length !== 1 || applicationLinks[0][2] !== applicationReference ||
    bootstrapLinks.length !== 1 || bootstrapLinks[0][2] !== bootstrapReference) {
    throw new Error('Unexpected settings -> application -> index.js -> HTML reference chain');
  }
  // Validate uniqueness even when already disabled, without rewriting any bytes.
  replaceReference(application.source, settingsReference, settingsReference);
  replaceReference(bootstrap.source, applicationReference, applicationReference);
  replaceReference(html, bootstrapReference, bootstrapReference);
  if (settings.splashScreen.totalTime === 0 && JSON.stringify(settings.splashScreen.logo) === '{"type":"none"}') {
    return { changed: false, settings: settingsReference, application: applicationReference, bootstrap: bootstrapReference };
  }
  settings.splashScreen.totalTime = 0;
  settings.splashScreen.logo = { type: 'none' };
  const nextSettings = renamed(settingsFile, JSON.stringify(settings));
  const nextSettingsReference = `src/${path.basename(nextSettings.next)}`;
  const nextApplication = renamed(application, replaceReference(application.source, settingsReference, nextSettingsReference));
  const nextApplicationReference = `./${path.basename(nextApplication.next)}`;
  const nextBootstrap = renamed(bootstrap, replaceReference(bootstrap.source, applicationReference, nextApplicationReference));
  const nextBootstrapReference = `./${path.basename(nextBootstrap.next)}`;
  const nextHtml = replaceReference(html, bootstrapReference, nextBootstrapReference);
  const changes = [nextSettings, nextApplication, nextBootstrap];
  // Prepare and validate the complete chain before touching the build. Reject
  // existing destinations, including short-hash collisions with the old files.
  for (const change of changes) {
    if (fs.existsSync(change.next)) throw new Error(`Refusing to overwrite ${change.next}`);
  }
  const stagedEntry = path.join(root, `.index.html.taptap-splash-${crypto.randomUUID()}.tmp`);
  const created = [];
  let committed = false;
  function createExclusive(file, content) {
    const descriptor = fs.openSync(file, 'wx');
    created.push(file);
    try { fs.writeFileSync(descriptor, content, 'utf8'); } finally { fs.closeSync(descriptor); }
    if (read(file) !== content) throw new Error(`Splash output verification failed: ${file}`);
  }
  try {
    // New dependency names are unreachable until the HTML is atomically replaced.
    for (const change of changes) createExclusive(change.next, change.content);
    createExclusive(stagedEntry, nextHtml);
    for (const change of changes) {
      if (read(change.file) !== change.source) throw new Error(`Build changed during splash processing: ${change.file}`);
    }
    if (read(entry) !== html) throw new Error('HTML changed during splash processing');
    fs.renameSync(stagedEntry, entry);
    committed = true;
    for (const change of changes) fs.unlinkSync(change.file);
  } catch (error) {
    // Before the HTML commit, the original build remains usable. After it, retain
    // the complete new chain if removing an obsolete file unexpectedly fails.
    for (const file of committed ? [stagedEntry] : created.reverse()) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    throw error;
  }
  return { changed: true, settings: nextSettingsReference, application: nextApplicationReference, bootstrap: nextBootstrapReference };
}

if (require.main === module) {
  try {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length) throw new Error('Usage: node tools/disable-taptap-splash.cjs BUILD');
    const result = disableTapTapSplash(directory);
    console.log(`TapTap Cocos splash ${result.changed ? 'disabled' : 'already disabled'}: ${result.settings} -> ${result.application} -> ${result.bootstrap} -> index.html`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { disableTapTapSplash };
