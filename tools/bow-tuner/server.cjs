'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const port = Number(process.argv[2] || 7474);
const site = path.join(__dirname, 'dist'), runtime = path.resolve(__dirname, '../../build/web-mobile');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
// The preview reuses game rendering with an in-memory save store in its iframe.
// Tuner settings remain in the parent page's separate persistent localStorage.
const isolate = `<script>Object.defineProperty(window,'localStorage',{value:(()=>{const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(String(k))??null,setItem:(k,v)=>m.set(String(k),String(v)),removeItem:k=>m.delete(String(k)),clear:()=>m.clear()}})()});</script>`;
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const isRuntime = url.startsWith('/runtime/'), root = isRuntime ? runtime : site;
    const relativeUrl = isRuntime ? url.slice('/runtime/'.length) : url.slice(1);
    const file = path.resolve(root, relativeUrl || 'index.html'), rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return res.writeHead(403).end();
    let body = fs.readFileSync(file);
    if (isRuntime && rel === 'index.html') body = Buffer.from(body.toString().replace('<head>', '<head>' + isolate));
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('文件不存在。请先构建 Web 试玩包。'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Bow tuner: http://127.0.0.1:${port}/`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
