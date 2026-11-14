// Takes the site's still pictures in headless Chromium:
//   assets/share.jpg     the link preview (index.html?card, 1200x630 at 2x)
//   assets/icon-180.png  the touch icon, from assets/icon.svg
//   node tools/share.mjs        (run node tools/build-site.mjs first)
// Needs playwright-core and its Chromium: set PLAYWRIGHT_CORE to playwright-core's index.mjs as a
// file:// URL, or install playwright-core next to this repo.
// The profile README's widget picture comes from index.html?card=hero; winchxyz/winchxyz takes it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const dir = fs.existsSync(base) ? fs.readdirSync(base).filter(d => d.startsWith('chromium-') && !d.includes('headless')).sort().pop() : null;
const browser = await chromium.launch(dir ? { executablePath: path.join(base, dir, 'chrome-win64', 'chrome.exe') } : {});

const errors = [];
async function open(url, viewport, dpr) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(ORIGIN + url, { waitUntil: 'load' });
  return { ctx, page };
}

{ // the link preview
  const { ctx, page } = await open('/index.html?card', { width: 1200, height: 630 }, 2);
  await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
  await page.screenshot({ path: path.join(ROOT, 'assets', 'share.jpg'), type: 'jpeg', quality: 90 });
  await ctx.close();
  console.log('assets/share.jpg');
}
{ // the touch icon: iOS rounds the corners itself, so the square is drawn edge to edge
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8').replace(/rx="15"/, 'rx="0"');
  const ctx = await browser.newContext({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:180px;height:180px}</style>${svg}`);
  await page.screenshot({ path: path.join(ROOT, 'assets', 'icon-180.png') });
  await ctx.close();
  console.log('assets/icon-180.png');
}

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
