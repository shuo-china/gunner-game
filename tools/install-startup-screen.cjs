'use strict';
const fs = require('node:fs');
const path = require('node:path');
function installStartupScreen(platform, output) {
  if (!['web', 'wechat'].includes(platform)) throw new Error('Expected web or wechat platform');
  const source = path.join(__dirname, 'startup-screen');
  fs.copyFileSync(path.join(source, 'background.jpg'), path.join(output, 'startup-background.jpg'));
  fs.copyFileSync(path.join(source, 'runtime.js'), path.join(output, 'startup-screen.js'));
  if (platform === 'web') {
    const target = path.join(output, 'index.html');
    let html = fs.readFileSync(target, 'utf8');
    html = html.replace(/<!-- FOX_STARTUP_START -->[\s\S]*?<!-- FOX_STARTUP_END -->\s*/g, '');
    const injection = '<!-- FOX_STARTUP_START -->\n<script src="startup-screen.js"></script>\n<script>globalThis.__FOREST_GUNNER_BOOT_STARTED_AT__=Date.now();globalThis.__FOREST_STARTUP_VISUALS__.mountBrowser();</script>\n<!-- FOX_STARTUP_END -->';
    if (!html.includes('<!-- Polyfills bundle. -->')) throw new Error('Unknown Creator web entry');
    html = html.replace('<!-- Polyfills bundle. -->', injection + '\n<!-- Polyfills bundle. -->');
    html = html.replace(/<title>[^<]*<\/title>/, '<title>小队出征</title>');
    fs.writeFileSync(target, html);
  }
  return { backgroundBytes: fs.statSync(path.join(output, 'startup-background.jpg')).size };
}
if (require.main === module) console.log(installStartupScreen(process.argv[2], path.resolve(process.argv[3])));
module.exports = { installStartupScreen };
