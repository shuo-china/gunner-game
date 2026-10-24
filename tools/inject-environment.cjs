'use strict';
const fs = require('node:fs');
const path = require('node:path');

const START = 'FOREST_GUNNER_ENV_START';
const END = 'FOREST_GUNNER_ENV_END';

function validateEnvironment(environment) {
  if (environment !== 'test' && environment !== 'production') {
    throw new Error('Environment must be exactly test or production.');
  }
}

/** Replace our own complete block only; malformed/duplicate markers indicate an unexpected entry. */
function removePreviousBlock(source, platform) {
  const starts = source.split(START).length - 1;
  const ends = source.split(END).length - 1;
  if (!starts && !ends) return source;
  if (starts !== 1 || ends !== 1) throw new Error('Invalid or duplicate Forest Gunner environment markers.');
  const expression = platform !== 'wechat'
    ? /<!-- FOREST_GUNNER_ENV_START -->\r?\n[\s\S]*?<!-- FOREST_GUNNER_ENV_END -->\r?\n?/
    : /\/\* FOREST_GUNNER_ENV_START \*\/\r?\n[\s\S]*?\/\* FOREST_GUNNER_ENV_END \*\/\r?\n?/;
  if (!expression.test(source)) throw new Error('Malformed Forest Gunner environment block.');
  return source.replace(expression, '');
}

function makeEnvironmentEntry(source, platform, environment) {
  validateEnvironment(environment);
  if (!['web', 'wechat', 'taptap-h5'].includes(platform)) throw new Error('Platform must be web, wechat or taptap-h5.');
  const original = removePreviousBlock(source, platform);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const assignment = `globalThis.__FOREST_GUNNER_ENV__ = ${JSON.stringify({ environment })};` +
    (platform === 'taptap-h5' ? `${newline}globalThis.__FOREST_GUNNER_PLATFORM__ = {"channel":"taptap-h5"};` : '');
  if (platform === 'wechat') {
    const block = [`/* ${START} */`, assignment, `/* ${END} */`, ''].join(newline);
    return original.startsWith('\uFEFF')
      ? `\uFEFF${block}${original.slice(1)}`
      : block + original;
  }
  // Ignore HTML comments so an example/commented script cannot become the injection point.
  const tokens = original.matchAll(/<!--[\s\S]*?-->|<script\b/gi);
  const firstScript = [...tokens].find(token => /^<script\b/i.test(token[0]));
  if (!firstScript) throw new Error('Web entry has no script tag; refusing to inject an unusable build.');
  const block = [`<!-- ${START} -->`, '<script>', assignment, '</script>', `<!-- ${END} -->`, ''].join(newline);
  return original.slice(0, firstScript.index) + block + original.slice(firstScript.index);
}

function injectEnvironment(outputDirectory, platform, environment) {
  validateEnvironment(environment);
  if (!['web', 'wechat', 'taptap-h5'].includes(platform)) throw new Error('Platform must be web, wechat or taptap-h5.');
  const entry = path.join(outputDirectory, platform === 'wechat' ? 'game.js' : 'index.html');
  if (!fs.statSync(entry).isFile()) throw new Error(`Build entry is not a file: ${entry}`);
  const source = fs.readFileSync(entry, 'utf8');
  const injected = makeEnvironmentEntry(source, platform, environment);
  if (injected !== source) fs.writeFileSync(entry, injected, 'utf8');
  if (fs.readFileSync(entry, 'utf8') !== injected) throw new Error(`Environment injection verification failed: ${entry}`);
  return entry;
}

if (require.main === module) {
  try {
    const [platform, outputDirectory, environment, ...extra] = process.argv.slice(2);
    if (!outputDirectory || extra.length) throw new Error('Usage: node tools/inject-environment.cjs <web|wechat|taptap-h5> <output-directory> <test|production>');
    const entry = injectEnvironment(outputDirectory, platform, environment);
    console.log(`Forest Gunner environment: ${environment} (${entry})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { makeEnvironmentEntry, injectEnvironment };
