/* ══════════════════════════════════════════════════════════════════════════
   main.js — boot, input, and the loop.
   ══════════════════════════════════════════════════════════════════════════ */

import { Renderer, TIERS } from './renderer.js';
import { Director } from './director.js';
import { UI, $, $$ } from './ui.js';
import { clamp, damp, fmt } from './math.js';
import { MATERIALS } from './content.js';

import { RAYMARCH_FRAG } from './shaders/raymarch.js';
import { PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders/particles.js';
import { CLOTH_INTEGRATE_FRAG, CLOTH_RELAX_FRAG, CLOTH_VERT, CLOTH_FRAG } from './shaders/cloth.js';
import { COMPOSITE_FRAG, TAA_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, STREAK_FRAG, FINAL_FRAG } from './shaders/post.js';

const GLSL_LINES = [
  RAYMARCH_FRAG, PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG,
  CLOTH_INTEGRATE_FRAG, CLOTH_RELAX_FRAG, CLOTH_VERT, CLOTH_FRAG,
  COMPOSITE_FRAG, TAA_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG, STREAK_FRAG, FINAL_FRAG,
].reduce((n, s) => n + s.split('\n').filter((l) => l.trim()).length, 0);

/* Module scripts are deferred, so the DOM is parsed by the time this runs
   and the UI constructor can query it directly. */
const ui = new UI();
const director = new Director();

let renderer = null;
let running = false;
let last = performance.now();
let msAvg = 16.7;
let fpsAvg = 60;
let scaleCooldown = 0;

/* ── boot ──────────────────────────────────────────────────────────────── */

/* Boot timings, kept permanently. Every stage below happens on the main
   thread, so if one of them is slow the page is simply frozen and there is no
   way to tell from outside which one it was. `__winch.bootMarks` makes that
   answerable after the fact. */
const bootT0 = performance.now();
const bootMarks = [];
const mark = (msg, pct) => {
  bootMarks.push([msg, Math.round(performance.now() - bootT0)]);
  ui.boot(msg, pct);
};

/* If a previous load started and never finished, assume it was too much for
   this machine and come back quieter. Two failures in a row and it drops to
   the smallest tier. The flag is cleared the moment a boot completes, so a
   normal visit never sees this.

   Every WebGL page is one unfamiliar driver away from a first frame that
   takes a minute, and the failure mode is a tab the browser offers to kill —
   which the visitor cannot recover from by reloading, because the reload does
   exactly the same thing. */
const BOOT_FLAG = 'winch-boot-attempts';

function readBootAttempts() {
  try { return Number(localStorage.getItem(BOOT_FLAG) || 0); } catch { return 0; }
}
function setBootAttempts(n) {
  try { n ? localStorage.setItem(BOOT_FLAG, String(n)) : localStorage.removeItem(BOOT_FLAG); } catch { /* private mode */ }
}

async function boot() {
  ui.build();
  mark('reading the room', 0.08);

  const failed = readBootAttempts();
  setBootAttempts(failed + 1);

  // The wordmark is drawn into a texture with fillText, so the font has to
  // exist first — otherwise the cloth ends up printed in Times New Roman.
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* no font loading API — the fallback stack is fine */ }

  mark('opening a webgl2 context', 0.18);

  try {
    renderer = new Renderer($('#gl'), (msg) => mark(msg, null));
  } catch (err) {
    console.error(err);
    failGracefully(err);
    return;
  }

  // ?tier=low|medium|high|ultra overrides the auto-detected quality. Useful
  // on a machine whose renderer string is masked, and the only way to make
  // the software rasteriser in the headless harness finish a frame.
  const forced = new URLSearchParams(location.search).get('tier');
  if (forced && TIERS[forced]) {
    renderer.setTier(forced);
    ui.boot(`forced tier: ${forced}`, 0.6);
  } else if (failed > 0) {
    const step = ['low', 'medium', 'high', 'ultra'];
    const now = step.indexOf(renderer.tier.name);
    const down = step[Math.max(0, now - failed)];
    renderer.setTier(down);
    ui.boot(`previous load did not finish — using ${down}`, 0.6);
  }

  // The driver is compiling on its own threads right now; this loop just
  // watches, and the boot bar keeps moving because the main thread is free.
  const compileMs = await renderer.awaitPrograms((frac) => {
    ui.boot('compiling shaders', 0.2 + frac * 0.5);
  });
  mark(`shaders ready in ${compileMs} ms`, 0.72);

  ui.initHud(renderer);
  wireInput();
  wireKeys();
  populateNumbers();

  // Render a couple of frames before revealing anything, so the first thing
  // anyone sees is a finished image rather than a compile hitch.
  //
  // Deliberately at a low internal resolution. The first frame after a link
  // is also the frame that pays for every shader's first real execution, and
  // on Windows a frame that takes more than a couple of seconds is killed by
  // the display driver's watchdog — which reads as "the tab crashed" rather
  // than "that was slow". The adaptive controller walks the scale back up
  // over the first second once there are real frame times to go on.
  // Settle on the starting resolution BEFORE the warm frames, not after.
  // Resizing reallocates every render target, which forces the driver to
  // finish whatever is still queued — so doing it after the warm frames
  // turned their cost into one long synchronous block at the worst possible
  // moment. The adaptive controller takes it from here.
  renderer.renderScale = Math.min(renderer.tier.scale, 0.72);
  renderer.resize(true);
  renderer.markCameraCut();

  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  const p = director.update(1 / 60, renderer);

  // One warm frame per animation frame, not two back to back. The first one
  // is where the driver builds its pipeline state, and it is slow exactly
  // once; giving the browser a chance to paint between them is the difference
  // between a progress bar and a hung tab.
  for (let i = 0; i < 2; i++) {
    await nextFrame();
    mark(`warm frame ${i + 1}`, 0.78 + i * 0.08);
    renderer.render(p, 1 / 60);
  }
  await nextFrame();
  mark('warm frames done', 0.94);

  mark('ready', 1.0);
  await new Promise((r) => setTimeout(r, 220));

  document.documentElement.classList.add('booted', 'gl-up', 'hud-on');
  setBootAttempts(0);      // made it — forget the previous failures
  running = true;
  last = performance.now();
  requestAnimationFrame(loop);

  ui.refreshStats().then(() => populateNumbers());

  setTimeout(() => {
    if (!sessionStorage.getItem('winch-hint')) {
      sessionStorage.setItem('winch-hint', '1');
      ui.flash('drag to orbit · <b>?</b> for keys');
    }
  }, 2600);
}

function failGracefully(err) {
  document.documentElement.classList.add('booted');
  const n = $('#nogl');
  n.hidden = false;
  n.querySelector('p:last-of-type')?.insertAdjacentHTML(
    'afterend',
    `<p class="mono" style="font-size:11px;opacity:.6">${String(err.message || err).slice(0, 160)}</p>`,
  );
  $('[data-dismiss-nogl]').addEventListener('click', () => { n.hidden = true; });
  $$('[data-reveal]').forEach((x) => x.classList.add('in'));
}

/* ── numbers ───────────────────────────────────────────────────────────── */

function populateNumbers() {
  if (!renderer) return;
  const nodes = renderer.clothN * renderer.clothN;
  const links = nodes * 12;
  ui.buildNumbers([
    [fmt(renderer.particleCount), '', 'particles, solved on the gpu'],
    [fmt(nodes), '', 'cloth nodes, verlet integrated'],
    [fmt(links * Math.round(director.cloth.iters)), '', 'constraint solves per frame'],
    [fmt(GLSL_LINES), '', 'lines of glsl, hand written'],
    [String(renderer.drawCalls), '', 'draw calls per frame'],
    [`${renderer.iw}×${renderer.ih}`, '', 'internal render resolution'],
    [(renderer.vramBytes() / 1048576).toFixed(0), 'MB', 'render targets in vram'],
    ['0', '', 'dependencies · asset files · build steps'],
  ]);
}

/* ── input ─────────────────────────────────────────────────────────────── */

function wireInput() {
  const canvas = $('#gl');
  const orbit = { yaw: 0, pitch: 0, vy: 0, vp: 0 };
  director.orbit = orbit;

  let dragging = false;
  let mode = null;          // 'orbit' | 'cloth'
  let lastX = 0, lastY = 0;
  let grabDist = 3;

  const norm = (e) => [(e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)];

  addEventListener('pointermove', (e) => {
    const [nx, ny] = norm(e);
    director.mouse.x = nx;
    director.mouse.y = ny;
    director.mouse.inside = true;

    if (dragging && mode === 'orbit') {
      orbit.vy += (e.clientX - lastX) * 0.0045;
      orbit.vp += (e.clientY - lastY) * 0.0035;
      lastX = e.clientX; lastY = e.clientY;
    }
    if (dragging && mode === 'cloth' && renderer) {
      const r = renderer.mouseRay(nx, ny);
      director.grab.pos = [
        r.ro[0] + r.rd[0] * grabDist,
        r.ro[1] + r.rd[1] * grabDist,
        r.ro[2] + r.rd[2] * grabDist,
      ];
    }
  }, { passive: true });

  addEventListener('pointerdown', (e) => {
    // let the DOM have its clicks; only bare canvas starts a drag
    if (e.target.closest('a, button, input, #sheet, #hud')) return;
    dragging = true;
    director.mouse.down = true;
    lastX = e.clientX; lastY = e.clientY;

    const inPhysics = ui.section === 3;
    if (inPhysics && renderer) {
      mode = 'cloth';
      const [nx, ny] = norm(e);
      const r = renderer.mouseRay(nx, ny);
      // Intersect the mouse ray with the plane the cloth hangs in, then hold
      // the grabbed point at that distance for the rest of the drag — the
      // usual "drag parallel to the screen" behaviour.
      const planeZ = renderer.clothOrigin[2];
      const t = Math.abs(r.rd[2]) > 1e-4 ? (planeZ - r.ro[2]) / r.rd[2] : 3;
      grabDist = clamp(t, 1.2, 9);
      const hit = [r.ro[0] + r.rd[0] * grabDist, r.ro[1] + r.rd[1] * grabDist, r.ro[2] + r.rd[2] * grabDist];

      const [ox, oy] = renderer.clothOrigin;
      const [sw, sh] = renderer.clothSize;
      const u = clamp((hit[0] - ox) / sw + 0.5, 0, 1);
      const v = clamp((hit[1] - oy) / sh, 0, 1);
      director.grab.idx = [u * (renderer.clothN - 1), v * (renderer.clothN - 1)];
      director.grab.pos = hit;
      director.grab.active = 1;
      document.body.classList.add('cur-drag');
      ui.setCursorLabel('pulling');
    } else {
      mode = 'orbit';
      document.body.classList.add('cur-drag');
      ui.setCursorLabel('orbit');
    }
  });

  const end = () => {
    dragging = false;
    mode = null;
    director.mouse.down = false;
    director.grab.active = 0;
    document.body.classList.remove('cur-drag');
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  addEventListener('blur', end);

  addEventListener('pointerleave', () => { director.mouse.inside = false; });
  document.addEventListener('mouseleave', () => { director.mouse.inside = false; });

  // touch: let the page scroll, but still feed the particle force
  canvas.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!t) return;
    director.mouse.x = (t.clientX / innerWidth) * 2 - 1;
    director.mouse.y = -((t.clientY / innerHeight) * 2 - 1);
    director.mouse.inside = true;
  }, { passive: true });

  ui.onMaterial = (i) => {
    director.setMaterial(i);
    ui.flash(`material <b>${String(i + 1).padStart(2, '0')}</b> · ${MATERIALS[i].name.toLowerCase()}`);
  };

  ui.onSlider = (id, v) => {
    if (id === 'wind') director.cloth.wind = v;
    if (id === 'gravity') director.cloth.gravity = v;
    if (id === 'stiff') director.cloth.stiff = v;
    if (id === 'damp') director.cloth.damp = v;
    if (id === 'iters') { director.cloth.iters = v; populateNumbers(); }
  };

  $$('[data-action="reset-cloth"]').forEach((b) => b.addEventListener('click', () => {
    renderer?.resetCloth();
    director.cloth.pinned = 1;
    ui.flash('cloth reset');
  }));
  $$('[data-action="tear-cloth"]').forEach((b) => b.addEventListener('click', () => {
    director.cloth.pinned = director.cloth.pinned > 0.5 ? 0 : 1;
    ui.flash(director.cloth.pinned > 0.5 ? 'pinned' : 'cut loose');
  }));

  addEventListener('resize', () => { ui.measure(); renderer?.resize(); renderer?.markCameraCut(); }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) last = performance.now();
  });

  // orbit integration lives on the director so the loop can read it
  director.integrateOrbit = (dt) => {
    orbit.yaw += orbit.vy;
    orbit.pitch = clamp(orbit.pitch + orbit.vp, -0.75, 0.95);
    orbit.vy = damp(orbit.vy, 0, 9, dt);
    orbit.vp = damp(orbit.vp, 0, 9, dt);
    // ease back toward the directed framing, slowly enough not to fight
    orbit.yaw = damp(orbit.yaw, 0, 0.28, dt);
    orbit.pitch = damp(orbit.pitch, 0, 0.28, dt);
  };
}

function wireKeys() {
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const k = e.key;

    if (k >= '1' && k <= '6') { ui.selectMaterial(+k - 1); return; }

    switch (k.toLowerCase()) {
      case 'p': {
        const on = document.documentElement.classList.toggle('photo');
        director.photo = on;
        renderer.dprCap = on ? 2.6 : 2.0;
        renderer.renderScale = on ? Math.min(1.25, renderer.tier.scale * 1.35) : renderer.tier.scale;
        renderer.resize(true);
        renderer.markCameraCut();
        ui.flash(on ? 'photo mode · <b>enter</b> to save' : 'photo mode off');
        break;
      }
      case 'g': ui.flash(ui.toggleHud() ? 'readout on' : 'readout off'); break;
      case 'r': renderer?.resetCloth(); ui.flash('cloth reset'); break;
      case 'm': {
        director.calm = !director.calm;
        ui.flash(director.calm ? 'calm mode' : 'calm mode off');
        break;
      }
      case '?': case '/': ui.toggleSheet(); e.preventDefault(); break;
      case 'escape': $('#sheet').hidden = true; break;
      case 'enter': {
        e.preventDefault();
        ui.flash('saving…', 900);
        renderer?.requestScreenshot((url) => {
          if (!url) { ui.flash('could not save'); return; }
          const a = document.createElement('a');
          a.href = url;
          a.download = `winch-${Date.now()}.png`;
          a.click();
          ui.flash('saved <b>png</b>');
        });
        break;
      }
      default: break;
    }
  });
}

/* ── adaptive resolution ─────────────────────────────────────────────────
   Hysteresis, a dead band, and a cooldown. Without all three it oscillates
   between two scales at exactly the frequency that is most visible. */
function adapt(dt) {
  if (director.photo) return;
  scaleCooldown -= 1;
  if (scaleCooldown > 0) return;

  const t = renderer.tier;
  if (msAvg > 22 && renderer.renderScale > t.minScale) {
    renderer.renderScale = Math.max(t.minScale, renderer.renderScale - 0.07);
    renderer.resize(true); renderer.markCameraCut();
    scaleCooldown = 60;
  } else if (msAvg < 12.5 && renderer.renderScale < t.scale) {
    renderer.renderScale = Math.min(t.scale, renderer.renderScale + 0.05);
    renderer.resize(true); renderer.markCameraCut();
    scaleCooldown = 90;
  }
}

/* ── loop ──────────────────────────────────────────────────────────────── */

function loop(now) {
  requestAnimationFrame(loop);
  if (!running || !renderer) return;

  const raw = (now - last) / 1000;
  last = now;
  if (document.hidden) return;

  const dt = clamp(raw, 1 / 480, 1 / 20);

  ui.readScroll(dt);
  ui.cursorTick?.(dt);

  director.setSection(ui.section, ui.local);
  director.integrateOrbit?.(dt);
  director.fade = damp(director.fade, 1, 2.4, dt);

  const p = director.update(dt, renderer);

  // user orbit, applied on top of the directed camera
  const o = director.orbit;
  if (o && (Math.abs(o.yaw) > 1e-4 || Math.abs(o.pitch) > 1e-4)) {
    const t = p.camTarget;
    let dx = p.camPos[0] - t[0], dy = p.camPos[1] - t[1], dz = p.camPos[2] - t[2];
    const r = Math.hypot(dx, dy, dz);
    let yaw = Math.atan2(dx, dz) + o.yaw;
    let pitch = Math.asin(clamp(dy / r, -1, 1)) + o.pitch;
    pitch = clamp(pitch, -0.55, 1.15);
    const cp = Math.cos(pitch);
    p.camPos = [
      t[0] + Math.sin(yaw) * cp * r,
      t[1] + Math.sin(pitch) * r,
      t[2] + Math.cos(yaw) * cp * r,
    ];
  }

  renderer.render(p, dt);

  const ms = performance.now() - now;
  msAvg = damp(msAvg, Math.max(ms, raw * 1000), 3.0, dt);
  fpsAvg = damp(fpsAvg, 1 / Math.max(raw, 1e-4), 2.0, dt);
  adapt(dt);
  ui.updateHud(renderer, msAvg, fpsAvg);

  if (renderer.frame % 90 === 0) populateNumbers();
}

/* ── go ────────────────────────────────────────────────────────────────── */

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();

window.__winch = { get renderer() { return renderer; }, director, ui, TIERS, bootMarks };
