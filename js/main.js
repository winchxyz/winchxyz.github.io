/* ══════════════════════════════════════════════════════════════════════════
   main.js — boot, input, and the loop.
   ══════════════════════════════════════════════════════════════════════════ */

import { Renderer, TIERS, TIER_ORDER } from './renderer.js';
import { Director } from './director.js';
import { UI, $, $$ } from './ui.js';
import { clamp, damp, fmt } from './math.js';
import { MATERIALS } from './content.js';

import { RAYMARCH_FRAG } from './shaders/raymarch.js';
import { PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders/particles.js';
import { COMPOSITE_FRAG, TAA_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, STREAK_FRAG, FINAL_FRAG } from './shaders/post.js';

const GLSL_LINES = [
  RAYMARCH_FRAG, PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG,
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
  // exist first — otherwise the wordmark texture is set in Times New Roman.
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
    // A load that never finished lowers the ceiling, not the starting tier —
    // everyone already starts at the bottom.
    const i = TIER_ORDER.indexOf(renderer.ceiling);
    renderer.ceiling = TIER_ORDER[Math.max(0, i - failed)];
    ui.boot(`previous load did not finish — capped at ${renderer.ceiling}`, 0.6);
  }

  // The driver is compiling on its own threads right now; this loop just
  // watches, and the boot bar keeps moving because the main thread is free.
  const compileMs = await renderer.awaitPrograms((frac) => {
    ui.boot('compiling shaders', 0.2 + frac * 0.5);
  });
  mark(`shaders ready in ${compileMs} ms`, 0.72);

  renderer.setPalette(MATERIALS);
  ui.initHud(renderer);
  wireInput();
  wireKeys();

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

  ui.refreshStats();

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


/* ── input ─────────────────────────────────────────────────────────────── */

function wireInput() {
  const canvas = $('#gl');
  const orbit = director.orbit;   // the director owns it; drag just adds velocity

  let dragging = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0, downOrb = -1;

  const norm = (e) => [(e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)];

  addEventListener('pointermove', (e) => {
    const [nx, ny] = norm(e);
    director.mouse.x = nx;
    director.mouse.y = ny;
    director.mouse.inside = true;

    if (dragging) {
      orbit.vy += (e.clientX - lastX) * 0.0045;
      orbit.vp += (e.clientY - lastY) * 0.0035;
      lastX = e.clientX; lastY = e.clientY;
    }

    // hovering a material orb lifts it and names it under the cursor
    if (!dragging && renderer) {
      const r = renderer.mouseRay(nx, ny);
      const k = director.pickOrb(r.ro, r.rd);
      if (k !== director.orbs.hover) {
        director.orbs.hover = k;
        document.body.classList.toggle('cur-hot', k >= 0);
        ui.setCursorLabel(k >= 0 ? MATERIALS[k].name : '');
      }
    }
  }, { passive: true });

  addEventListener('pointerdown', (e) => {
    // let the DOM have its clicks; only bare canvas starts a drag
    if (e.target.closest('a, button, input, #sheet, #hud')) return;
    dragging = true;
    director.mouse.down = true;
    lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY;

    // Remember what was under the cursor, but do not act yet — acting on
    // pointerdown would fire an absorb every time a drag happens to start
    // over an orb.
    const [nx, ny] = norm(e);
    const r = renderer ? renderer.mouseRay(nx, ny) : null;
    downOrb = r ? director.pickOrb(r.ro, r.rd) : -1;

    if (downOrb < 0) {
      document.body.classList.add('cur-drag');
      ui.setCursorLabel('orbit');
    }
  });

  const end = () => {
    dragging = false;
    director.mouse.down = false;
    downOrb = -1;
    document.body.classList.remove('cur-drag');
  };

  addEventListener('pointerup', (e) => {
    // a click, not a drag: within a few pixels of where it went down
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (downOrb >= 0 && moved < 7) {
      const [nx, ny] = norm(e);
      const r = renderer.mouseRay(nx, ny);
      if (director.pickOrb(r.ro, r.rd) === downOrb) ui.selectMaterial(downOrb);
    }
    end();
  });
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
    // In the materials section the orb flies in and the sculpture changes
    // when it lands; anywhere else there is no orb to send, so switch now.
    if (!director.absorb(i)) director.setMaterial(i);
  };

  addEventListener('resize', () => {
    ui.measure(); renderer?.resize(); renderer?.markCameraCut();
    // a different monitor can mean a different refresh rate
    refreshMs = 999; resetHeadroom();
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) last = performance.now();
  });
}

function wireKeys() {
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const k = e.key;

    if (k >= '1' && k <= '9' && +k <= MATERIALS.length) { ui.selectMaterial(+k - 1); return; }

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
/* ── how much headroom is there? ──────────────────────────────────────────
   Not milliseconds. Rendering is locked to the display, so the frame delta
   sits at the refresh interval — 16.7 ms on a 60 Hz panel — whether the GPU
   finished in two milliseconds or in sixteen. A threshold like "under 11 ms
   means promote" can therefore never be true, and the first version of this
   controller would have sat at the lowest tier forever on any machine.

   What vsync does reveal is MISSED frames. Take the fastest frame observed as
   the refresh interval, then count how often the delta runs long. A drop rate
   near zero means real headroom; a high one means the machine is struggling
   no matter what the average says. */
const DROP_WIN = 120;
const dropWin = new Uint8Array(DROP_WIN);
let dropIdx = 0, dropSum = 0, refreshMs = 999;

function noteFrame(rawMs) {
  if (rawMs > 5 && rawMs < 40) refreshMs = Math.min(refreshMs, rawMs);
  const bad = rawMs > refreshMs * 1.55 ? 1 : 0;
  dropSum -= dropWin[dropIdx];
  dropWin[dropIdx] = bad;
  dropSum += bad;
  dropIdx = (dropIdx + 1) % DROP_WIN;
}
const dropRate = () => dropSum / DROP_WIN;
function resetHeadroom() { dropWin.fill(0); dropSum = 0; dropIdx = 0; }

let comfy = 0;      // consecutive frames with real headroom, at full scale
let strained = 0;   // consecutive frames struggling at the smallest scale

function adapt(dt) {
  if (director.photo) return;
  scaleCooldown -= 1;
  if (scaleCooldown > 0) return;

  const t = renderer.tier;
  const atTop = renderer.renderScale >= t.scale - 1e-3;
  const atBottom = renderer.renderScale <= t.minScale + 1e-3;
  const drops = dropRate();

  // resolution first — it is free to change and invisible at these steps
  if (drops > 0.12 && !atBottom) {
    renderer.renderScale = Math.max(t.minScale, renderer.renderScale - 0.07);
    renderer.resize(true); renderer.markCameraCut();
    scaleCooldown = 60; comfy = 0; strained = 0; resetHeadroom();
    return;
  }
  if (drops < 0.02 && !atTop) {
    renderer.renderScale = Math.min(t.scale, renderer.renderScale + 0.05);
    renderer.resize(true); renderer.markCameraCut();
    scaleCooldown = 90; comfy = 0; resetHeadroom();
    return;
  }

  /* Then the tier. Promotion needs two seconds of genuine headroom at full
     scale, not one lucky frame — stepping up costs a reallocation and a
     bigger particle buffer, and thrashing between tiers is worse than
     sitting one below the best one. */
  if (atTop && drops < 0.02) {
    strained = 0;
    if (++comfy > 120) {
      comfy = 0;
      const now = renderer.stepTier(+1);
      if (now) { scaleCooldown = 150; resetHeadroom(); }
    }
  } else if (atBottom && drops > 0.30) {
    comfy = 0;
    if (++strained > 90) {
      strained = 0;
      const now = renderer.stepTier(-1);
      if (now) { scaleCooldown = 180; resetHeadroom(); }
    }
  } else {
    comfy = 0; strained = 0;
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

  // The orbit is folded into the framing solve inside the director now, so
  // that dragging cannot push the subject off the edge of a frame that was
  // just carefully composed for this aspect ratio.
  const p = director.update(dt, renderer);

  renderer.render(p, dt);

  const ms = performance.now() - now;
  noteFrame(raw * 1000);
  msAvg = damp(msAvg, Math.max(ms, raw * 1000), 3.0, dt);
  fpsAvg = damp(fpsAvg, 1 / Math.max(raw, 1e-4), 2.0, dt);
  adapt(dt);
  ui.updateHud(renderer, msAvg, fpsAvg);

}

/* ── go ────────────────────────────────────────────────────────────────── */

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();

window.__winch = { get renderer() { return renderer; }, director, ui, TIERS, bootMarks };
