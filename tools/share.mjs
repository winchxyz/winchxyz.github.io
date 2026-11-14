// Takes the site's still pictures in headless Chromium:
//   assets/share.jpg     the link preview (index.html?card, 1200x630 at 2x)
//   assets/icon-180.png  the touch icon, from assets/icon.svg
//   favicon.ico          the tab icon at 16, 32 and 48 px, for browsers without SVG icons
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
{ // the icons, drawn from assets/icon.svg at each size rather than scaled down from one picture
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const draw = async (src, size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`);
    return page.screenshot({ omitBackground: true });
  };
  // the touch icon: iOS rounds the corners itself, so the square is drawn edge to edge
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon-180.png'), await draw(svg.replace(/ rx="[\d.]+"/, ''), 180));
  console.log('assets/icon-180.png');
  // favicon.ico: PNG entries (every current browser reads them), corners kept round
  const pngs = [];
  for (const size of [16, 32, 48]) pngs.push({ size, buf: await draw(svg, size) });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);
    e.writeUInt8(size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  fs.writeFileSync(path.join(ROOT, 'favicon.ico'), Buffer.concat([head, ...entries, ...pngs.map(p => p.buf)]));
  console.log('favicon.ico');
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
