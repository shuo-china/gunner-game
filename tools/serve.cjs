'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const port = Number(argument('--port', '7457'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node tools/serve.cjs [--port 7457] [--root build/web-mobile] [--open]');
  process.exit(1);
}
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'build-web.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') { console.error(error.message); process.exit(1); } }
let buildBase = config.buildPath || 'project://build';
if (buildBase.startsWith('project://')) buildBase = path.join(projectRoot, buildBase.slice(10));
else buildBase = path.resolve(projectRoot, buildBase);
const defaultRoot = path.join(buildBase, config.outputName || config.platform || 'web-mobile');
const root = path.resolve(projectRoot, argument('--root', defaultRoot));
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`No web build at ${root}. Run powershell -File tools/build.ps1 -Platform web first.`);
  process.exit(1);
}
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
};
const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
  }
  let filename;
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/play' || pathname === '/play/') {
      filename = path.join(__dirname, 'preview.html');
    } else {
      filename = path.resolve(root, `.${pathname}`);
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        response.writeHead(403).end('Forbidden'); return;
      }
      if (fs.statSync(filename).isDirectory()) filename = path.join(filename, 'index.html');
    }
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
  } catch (_) { response.writeHead(404).end('Not found'); }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is in use. Open http://127.0.0.1:${port}/play if the preview is already running, or use --port.`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/play`;
  console.log(`Serving ${root}\n${url}\nPress Ctrl+C to stop. Rebuild after changing source files.`);
  if (args.includes('--open') && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    browser.on('error', error => console.error(`Open this URL manually: ${url} (${error.message})`));
    browser.unref();
  }
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
