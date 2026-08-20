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
  // GPU=1 runs on the real adapter. The default forces the software GL
  // stack, because the point of this harness is to compile shaders on a
  // machine that may not have a working driver.
  ...(process.env.GPU
    ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  `--window-size=${process.env.WIN || '1280,800'}`,
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

async function waitFor(cdp, expr, timeoutMs, label, watch) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evaluate(cdp, expr)) return true; } catch { /* not ready */ }
    if (watch) {
      // Narrate the boot log while waiting. A page that is stuck and a page
      // that is merely slow look identical from outside; the stage it last
      // reached is the whole diagnosis.
      try {
        const v = await evaluate(cdp, watch);
        if (v !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${v}`); last = v; }
      } catch { /* page not ready */ }
    }
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
      if (e.method === 'Inspector.targetCrashed') consoleErrors.push('*** RENDERER CRASHED ***');
    }
    cdp.events.length = 0;
  };

  if (MODE === 'compile') {
    await cdp.send('Page.navigate', { url: `${SITE}/tools/${process.env.PAGE || 'shadertest.html'}` });

    /* Poll the progress list rather than just blocking on the result, so a
       driver that is merely slow can be told apart from one that has hung —
       and so the program it is stuck on is named. */
    const budget = Number(process.env.COMPILE_TIMEOUT || 60000);
    const t0 = Date.now();
    let lastSeen = 0;
    while (Date.now() - t0 < budget) {
      let done = false;
      try { done = await evaluate(cdp, 'window.__RESULT !== undefined'); } catch { /* still loading */ }
      if (done) break;
      try {
        const prog = await evaluate(cdp, 'JSON.stringify({p: window.__PROGRESS || [], cur: window.__CURRENT})');
        const { p, cur } = JSON.parse(prog);
        while (lastSeen < p.length) console.log('  ' + p[lastSeen++]);
        if (cur && lastSeen === p.length) process.stdout.write(`\r  compiling ${cur} … ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch { /* page not ready */ }
      await sleep(1000);
    }
    console.log('');
    if (!(await evaluate(cdp, 'window.__RESULT !== undefined').catch(() => false))) {
      collect();
      console.log(RED(`\ngave up after ${(budget / 1000).toFixed(0)}s — stuck on: `)
        + (await evaluate(cdp, 'window.__CURRENT').catch(() => '?')));
      consoleErrors.forEach((e) => console.log('  ' + e));
      cdp.close(); chrome.kill();
      process.exit(4);
    }
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
      if (p.ok) console.log(`  ${GRN('ok  ')} ${p.name.padEnd(18)} ${String(p.ms).padStart(7)} ms   ${p.uniforms.length} uniforms`);
      else { bad++; console.log(`  ${RED('FAIL')} ${p.name}\n${p.error.split('\n').map((l) => '        ' + l).join('\n')}`); }
    }
    if (r.fatal) { console.log('\n  ' + RED('fatal: ') + r.fatal); bad++; }
    if (consoleErrors.length) { console.log('\n  page errors:'); consoleErrors.forEach((e) => console.log('    ' + e)); }
    console.log('');
    cdp.close(); chrome.kill();
    process.exit(bad ? 1 : 0);
  }

  /* ── screenshot ────────────────────────────────────────────────────── */
  /* The page viewport, which is NOT the same thing as the browser window.
     This was pinned at 1280x800 while WIN only resized the window, so every
     screenshot taken during development was 16:10 and the 16:9 framing was
     never once looked at. */
  const [vw, vh] = (process.env.VIEW || '1280x800').split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vw, height: vh,
    deviceScaleFactor: Number(process.env.DPR || 1),
    mobile: process.env.MOBILE === '1',
  });
  await cdp.send('Page.navigate', { url: SITE });

  try {
    await waitFor(cdp, 'document.documentElement.classList.contains("booted")',
      Number(process.env.BOOT_TIMEOUT || 180000), 'boot',
      'document.querySelector("#boot-log")?.textContent + " | cls=" + document.documentElement.className');
  } catch (e) {
    collect();
    console.log('BOOT FAILED: ' + e.message);
    if (consoleErrors.length) consoleErrors.forEach((x) => console.log('  ' + x));
    console.log('chrome stderr tail: ' + chromeErr.slice(-2000));
    cdp.close(); chrome.kill();
    process.exit(3);
  }
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

  // arbitrary setup before the settle window (select a material, open a panel)
  if (process.env.PRE) {
    try { await evaluate(cdp, process.env.PRE); console.log('pre: ok'); }
    catch (e) { console.log('pre failed: ' + e.message); }
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

  /* SHOTS captures several sections in one browser session. Launching Chrome
     and waiting for boot costs far more than the screenshots do, so grabbing
     a whole page's worth in one run is the difference between auditing every
     section at every breakpoint and auditing one. */
  const shots = (process.env.SHOTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (shots.length) {
    const dwell = Number(process.env.DWELL || 3500);
    for (const sel of shots) {
      const id = sel.replace(/^#/, '');
      await evaluate(cdp, `(() => { const n = document.querySelector('${sel}'); if (n) scrollTo({top: n.offsetTop, behavior: 'auto'}); return !!n; })()`);
      await sleep(dwell);
      const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const path = OUT.replace(/\.png$/, '') + '-' + id + '.png';
      writeFileSync(path, Buffer.from(s2.data, 'base64'));
      console.log('wrote ' + path);
    }
    cdp.close(); chrome.kill();
    process.exit(0);
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
