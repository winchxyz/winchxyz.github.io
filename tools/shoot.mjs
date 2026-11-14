// Screenshots live project pages for new thumbnails (then: python tools/thumbs.py <out folder>).
// Usage: node tools/shoot.mjs <out folder> <repo> [<repo> ...]
// Each repo is opened at https://winchxyz.github.io/<repo>/ at 1440x900 and saved as <out>/<repo>.png.
import fs from 'fs';
import path from 'path';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [out, ...repos] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const base = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
const dir = fs.readdirSync(base).filter(d => d.startsWith('chromium-') && !d.includes('headless')).sort().pop();
const browser = await chromium.launch({
  executablePath: path.join(base, dir, 'chrome-win64', 'chrome.exe'),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const repo of repos) {
  await page.goto(`https://winchxyz.github.io/${repo}/`, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log(repo, e.message));
  await page.waitForTimeout(Number(process.env.WAIT || 6000));
  await page.screenshot({ path: path.join(out, `${repo}.png`) });
  console.log('shot', repo);
}
await browser.close();
