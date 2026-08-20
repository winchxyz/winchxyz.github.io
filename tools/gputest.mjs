/* ══════════════════════════════════════════════════════════════════════════
   tools/gputest.mjs — drive headless Chrome over CDP with nothing but the
   Node standard library, so the shaders can be compiled by a real GLSL
   translator on a machine with no GPU.

     node tools/gputest.mjs                 compile every shader
     node tools/gputest.mjs shot out.png    load the site and grab a frame

   SwiftShader is a software rasteriser, so the screenshot mode is slow and
   the image is not what a GPU would produce pixel for pixel. It is still the
   difference between "the shaders compile" and "the page draws something".
   ══════════════════════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODE = process.argv[2] === 'shot' ? 'shot' : 'compile';
const OUT = process.argv[3] || 'docs/headless.png';
const PORT = 9333;
const SITE = process.env.SITE || 'http://localhost:8141';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => { try { return existsSync(p); } catch { return false; } })
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'winch-cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio',
  // Force the software GL stack and allow it explicitly — recent Chrome
  // refuses to fall back to SwiftShader without this flag.
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,800',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome never opened a debugging port\n' + chromeErr.slice(-1200));
}

function client(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];

    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const n = ++id;
        ws.send(JSON.stringify({ id: n, method, params }));
        return new Promise((res, rej) => pending.set(n, { res, rej }));
      },
      events,
      close: () => ws.close(),
    }));
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
  });
}

const evaluate = async (cdp, expr) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};

async function waitFor(cdp, expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evaluate(cdp, expr)) return true; } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
}

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;

try {
  const cdp = await client(await target());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  const consoleErrors = [];
  const collect = () => {
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('exception: ' + (e.params.exceptionDetails?.exception?.description
          || e.params.exceptionDetails?.text || '?'));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        consoleErrors.push('log: ' + e.params.entry.text);
      }
    }
    cdp.events.length = 0;
  };

  if (MODE === 'compile') {
    await cdp.send('Page.navigate', { url: `${SITE}/tools/shadertest.html` });
    await waitFor(cdp, 'window.__RESULT !== undefined', 60000, 'the compile harness');
    const res = await evaluate(cdp, 'JSON.stringify(window.__RESULT)');
    const r = JSON.parse(res);
    collect();

    console.log('─'.repeat(72));
    console.log('shader compile — ' + r.renderer);
    console.log('─'.repeat(72));
    console.log('  extensions      ', JSON.stringify(r.exts));
    console.log('  MRT hdr + r32f  ', r.fbo);
    console.log('  MRT sim rgba32f ', r.fboSim);
    console.log('');
    let bad = 0;
    for (const p of r.programs) {
      if (p.ok) console.log(`  ${GRN('ok  ')} ${p.name.padEnd(18)} ${p.uniforms.length} uniforms`);
      else { bad++; console.log(`  ${RED('FAIL')} ${p.name}\n${p.error.split('\n').map((l) => '        ' + l).join('\n')}`); }
    }
    if (r.fatal) { console.log('\n  ' + RED('fatal: ') + r.fatal); bad++; }
    if (consoleErrors.length) { console.log('\n  page errors:'); consoleErrors.forEach((e) => console.log('    ' + e)); }
    console.log('');
    cdp.close(); chrome.kill();
    process.exit(bad ? 1 : 0);
  }

  /* ── screenshot ────────────────────────────────────────────────────── */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: SITE });

  await waitFor(cdp, 'document.documentElement.classList.contains("booted")', 180000, 'boot');
  const diag = await evaluate(cdp, `JSON.stringify({
    cls: document.documentElement.className,
    gl: !!window.__winch?.renderer,
    tier: window.__winch?.renderer?.tier?.name,
    renderer: window.__winch?.renderer?.caps?.renderer,
    nogl: !document.querySelector('#nogl').hidden,
    msg: document.querySelector('#nogl')?.innerText?.slice(0,200)
  })`);
  console.log('boot: ' + diag);

  // optional: jump to a section before capturing
  const goto = process.env.SECTION;
  if (goto) {
    await evaluate(cdp, `(() => { const n = document.querySelector('${goto}'); if (n) scrollTo({top: n.offsetTop, behavior: 'auto'}); return !!n; })()`);
    console.log('scrolled to ' + goto);
  }

  // let the software rasteriser grind out some frames
  const startFrame = await evaluate(cdp, 'window.__winch?.renderer?.frame ?? -1');
  await sleep(Number(process.env.SETTLE || 25000));
  const endFrame = await evaluate(cdp, 'window.__winch?.renderer?.frame ?? -1');
  console.log(`frames rendered: ${startFrame} -> ${endFrame}`);

  collect();
  if (consoleErrors.length) { console.log('page errors:'); consoleErrors.forEach((e) => console.log('  ' + e)); }

  if (process.env.PROBE) {
    try { console.log('probe: ' + await evaluate(cdp, process.env.PROBE)); }
    catch (e) { console.log('probe failed: ' + e.message); }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('wrote ' + OUT);

  cdp.close(); chrome.kill();
  process.exit(0);
} catch (e) {
  console.error(RED('harness failed: ') + e.message);
  try { chrome.kill(); } catch { /* already gone */ }
  process.exit(2);
} finally {
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ } }, 500);
}
