/* ══════════════════════════════════════════════════════════════════════════
   renderer.js — the frame.

   raymarch ─┬─► scene HDR ──┐
             └─► ray dist ───┤
   particles ────────────────┼─► composite ─► TAA ─► bloom chain ─► final
   cloth ────────────────────┘                        └─► streak ──┘

   Two float ping-pongs feed it: a quarter of a million particles and a
   16 384-node cloth, both solved on the GPU before any of the above runs.
   ══════════════════════════════════════════════════════════════════════════ */

import {
  createContext, Program, Target, PingPong, Blitter, FMT,
  FS_VERT, toScreen, additive, targetBytes, GLError,
} from './gl.js';

import { RAYMARCH_FRAG } from './shaders/raymarch.js';
import { PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders/particles.js';
import {
  CLOTH_INTEGRATE_FRAG, CLOTH_RELAX_FRAG, CLOTH_VERT, CLOTH_FRAG,
} from './shaders/cloth.js';
import {
  COMPOSITE_FRAG, TAA_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG, STREAK_FRAG, FINAL_FRAG,
} from './shaders/post.js';

import {
  m4, m4perspective, m4lookAt, m4mul, m4invert, v3, HALTON_8, clamp,
} from './math.js';

/* ── quality tiers ─────────────────────────────────────────────────────── */

export const TIERS = {
  ultra:  { name: 'ultra',  steps: 128, transSteps: 44, reflSteps: 48, shadowSteps: 32, reflect: 1, sim: 512, cloth: 128, taa: 1, mips: 6, scale: 1.00, minScale: 0.60 },
  high:   { name: 'high',   steps: 100, transSteps: 32, reflSteps: 40, shadowSteps: 28, reflect: 1, sim: 384, cloth: 128, taa: 1, mips: 6, scale: 0.90, minScale: 0.54 },
  medium: { name: 'medium', steps:  74, transSteps: 20, reflSteps: 32, shadowSteps: 24, reflect: 1, sim: 256, cloth:  96, taa: 1, mips: 5, scale: 0.78, minScale: 0.48 },
  low:    { name: 'low',    steps:  50, transSteps: 12, reflSteps: 20, shadowSteps: 14, reflect: 0, sim: 176, cloth:  72, taa: 0, mips: 4, scale: 0.60, minScale: 0.40 },
};

/* An upper bound on internal pixels, independent of the tier.

   The scale factor alone is not a budget: on a high-DPI display the canvas is
   already the CSS size times the device pixel ratio, so "ultra at 100%" on a
   4K panel asks for fourteen million pixels of raymarching. This clamps the
   product rather than the factor. */
export const MAX_INTERNAL_PIXELS = 2_400_000;

export class Renderer {
  constructor(canvas, onLog = () => {}) {
    this.canvas = canvas;
    this.onLog = onLog;

    const { gl, caps } = createContext(canvas);
    this.gl = gl;
    this.caps = caps;

    this.tier = TIERS[this.detectTier()];
    this.renderScale = this.tier.scale;
    this.dprCap = 2.0;

    this.frame = 0;
    this.drawCalls = 0;
    this.simTime = 0;
    this.taaReset = 1;

    // camera state
    this.proj = m4(); this.view = m4(); this.viewProj = m4();
    this.invViewProj = m4(); this.prevViewProj = m4();
    this.projJ = m4(); this.viewProjJ = m4(); this.invViewProjJ = m4();
    this.camPos = v3(0, 0, 4);

    this.blit = new Blitter(gl);

    onLog('compiling shaders');
    this.buildPrograms();
    onLog('allocating targets');
    this.resize(true);
    onLog('seeding particles');
    this.initParticles();
    onLog('weaving cloth');
    this.initCloth();
    onLog('drawing the wordmark');
    this.printTex = this.makePrintTexture();
    this.noiseTex = this.makeNoiseTexture();

    this.pending = { screenshot: null };
    this.installContextLossHandlers();
  }

  /* ── device tiering ──────────────────────────────────────────────────────
     No user-agent sniffing. The renderer string is a hint when it is
     available and masked noise when it is not, so it only ever downgrades —
     the real signals are core count, memory, and whether the primary
     pointer is coarse. */
  detectTier() {
    const r = (this.caps.renderer || '').toLowerCase();
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const small = Math.min(innerWidth, innerHeight) < 700;

    if (coarse || small) return cores >= 8 && mem >= 6 ? 'medium' : 'low';

    const weak = /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(r);
    if (weak) return 'low';

    const integrated = /intel|uhd|iris|hd graphics|vega \d|radeon\(tm\) graphics|adreno|mali|apple a\d/.test(r);
    const strong = /rtx|radeon rx|geforce (gtx )?1[6-9]|geforce (gtx )?[2-9]0[6-9]0|apple m[1-9]|arc a\d/.test(r);

    if (strong && cores >= 8) return 'ultra';
    if (integrated) return cores >= 8 && mem >= 8 ? 'medium' : 'low';
    if (cores >= 12 && mem >= 8) return 'ultra';
    if (cores >= 6) return 'high';
    return 'medium';
  }

  setTier(name) {
    if (!TIERS[name] || this.tier.name === name) return;
    const old = this.tier;
    this.tier = TIERS[name];
    this.renderScale = this.tier.scale;
    if (old.sim !== this.tier.sim) { this.particles?.dispose(); this.initParticles(); }
    if (old.cloth !== this.tier.cloth) { this.disposeCloth(); this.initCloth(); }
    this.resize(true);
  }

  /* ── programs ──────────────────────────────────────────────────────── */

  /* Issue every compile, wait for none of them. awaitPrograms() collects the
     results later, so the several seconds the driver spends on the raymarch
     program happen while the boot screen is still animating rather than with
     the whole tab frozen. */
  buildPrograms() {
    const gl = this.gl;
    const mk = (fs, label, vs = FS_VERT) => new Program(gl, vs, fs, label, true);

    this.pRaymarch  = mk(RAYMARCH_FRAG, 'raymarch');
    this.pPartSim   = mk(PARTICLE_SIM_FRAG, 'particle.sim');
    this.pPartDraw  = new Program(gl, PARTICLE_VERT, PARTICLE_FRAG, 'particle.draw');
    this.pClothInt  = mk(CLOTH_INTEGRATE_FRAG, 'cloth.integrate');
    this.pClothRel  = mk(CLOTH_RELAX_FRAG, 'cloth.relax');
    this.pClothDraw = new Program(gl, CLOTH_VERT, CLOTH_FRAG, 'cloth.draw');
    this.pComposite = mk(COMPOSITE_FRAG, 'composite');
    this.pTaa       = mk(TAA_FRAG, 'taa');
    this.pPrefilter = mk(BLOOM_PREFILTER_FRAG, 'bloom.prefilter');
    this.pDown      = mk(BLOOM_DOWN_FRAG, 'bloom.down');
    this.pUp        = mk(BLOOM_UP_FRAG, 'bloom.up');
    this.pStreak    = mk(STREAK_FRAG, 'bloom.streak');
    this.pFinal     = mk(FINAL_FRAG, 'final');

    this.programs = [
      this.pRaymarch, this.pPartSim, this.pPartDraw, this.pClothInt,
      this.pClothRel, this.pClothDraw, this.pComposite, this.pTaa,
      this.pPrefilter, this.pDown, this.pUp, this.pStreak, this.pFinal,
    ];
  }

  /* Poll until the driver has them all, yielding a frame between checks, then
     finalize. Resolves with the number of milliseconds it actually took. */
  async awaitPrograms(onProgress = () => {}) {
    const ext = this.caps.parallel;
    const t0 = performance.now();
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    for (;;) {
      const done = this.programs.filter((p) => p.isReady(ext)).length;
      onProgress(done / this.programs.length);
      if (done === this.programs.length) break;
      await frame();
    }
    // finalize is the blocking part, but by now the work is already done
    for (const p of this.programs) p.finalize();
    return Math.round(performance.now() - t0);
  }

  /* ── targets ───────────────────────────────────────────────────────── */

  resize(force = false) {
    const gl = this.gl;
    const dpr = Math.min(devicePixelRatio || 1, this.dprCap);
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));

    if (!force && cw === this.canvas.width && ch === this.canvas.height && this._lastScale === this.renderScale) return;

    this.canvas.width = cw;
    this.canvas.height = ch;
    this._lastScale = this.renderScale;

    let w = Math.max(64, Math.round(cw * this.renderScale));
    let h = Math.max(64, Math.round(ch * this.renderScale));

    // Hard ceiling on the pixel count, whatever the scale factor says.
    const over = (w * h) / MAX_INTERNAL_PIXELS;
    if (over > 1) {
      const k = 1 / Math.sqrt(over);
      w = Math.max(64, Math.round(w * k));
      h = Math.max(64, Math.round(h * k));
    }
    this.iw = w; this.ih = h;

    const HDR = FMT.RGBA16F;

    const mkOrResize = (t, ww, hh, opts) => {
      if (t) { t.resize(ww, hh); return t; }
      return new Target(gl, ww, hh, opts);
    };

    // scene: HDR colour + ray distance, sharing one depth buffer so the
    // cloth can be occluded by a surface that exists only as a distance field
    this.tScene = this.tScene
      ? (this.tScene.resize(w, h), this.tScene)
      : new Target(gl, w, h, { formats: [HDR, FMT.R32F], depth: true, label: 'scene' });

    this.tParticles = mkOrResize(this.tParticles, w, h, { formats: [HDR], label: 'particles' });
    this.tComposite = mkOrResize(this.tComposite, w, h, { formats: [HDR], label: 'composite' });

    if (this.ppTaa) this.ppTaa.resize(w, h);
    else this.ppTaa = new PingPong(gl, w, h, { formats: [HDR], label: 'taa' });

    // bloom chain — separate textures per level rather than mip levels of one
    // texture. Sampling level N while rendering to level N+1 of the same
    // texture is a feedback loop; separate textures make that impossible.
    this.bloom?.forEach((t) => t.dispose());
    this.bloom = [];
    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < this.tier.mips; i++) {
      if (bw < 8 || bh < 8) break;
      this.bloom.push(new Target(gl, bw, bh, { formats: [HDR], label: `bloom${i}` }));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }

    const sw = this.bloom.length ? this.bloom[this.bloom.length - 1].w : 32;
    const sh = this.bloom.length ? this.bloom[this.bloom.length - 1].h : 32;
    this.tStreakA = mkOrResize(this.tStreakA, sw, sh, { formats: [HDR], label: 'streakA' });
    this.tStreakB = mkOrResize(this.tStreakB, sw, sh, { formats: [HDR], label: 'streakB' });

    this.taaReset = 1;
    gl.viewport(0, 0, cw, ch);
  }

  vramBytes() {
    let b = 0;
    for (const t of [this.tScene, this.tParticles, this.tComposite, this.tStreakA, this.tStreakB]) b += targetBytes(t);
    if (this.ppTaa) b += targetBytes(this.ppTaa.a) + targetBytes(this.ppTaa.b);
    this.bloom?.forEach((t) => { b += targetBytes(t); });
    if (this.particles) b += targetBytes(this.particles.a) + targetBytes(this.particles.b);
    if (this.cloth) b += targetBytes(this.cloth.a) + targetBytes(this.cloth.b);
    return b;
  }

  /* ── particles ─────────────────────────────────────────────────────── */

  initParticles() {
    const gl = this.gl;
    const N = this.tier.sim;
    this.simN = N;
    this.particleCount = N * N;

    this.particles = new PingPong(gl, N, N, {
      formats: [FMT.RGBA32F, FMT.RGBA32F],
      filter: gl.NEAREST,
      label: 'particles.state',
    });

    const pos = new Float32Array(N * N * 4);
    const vel = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      // the same uniform-sphere construction the solver uses on respawn
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const rad = 1.28 + 0.85 * Math.random();
      pos[i * 4 + 0] = r * Math.cos(a) * rad;
      pos[i * 4 + 1] = r * Math.sin(a) * rad;
      pos[i * 4 + 2] = z * rad;
      pos[i * 4 + 3] = Math.random();          // staggered life, so nothing pops in unison
      vel[i * 4 + 3] = Math.random();          // seed
    }

    for (const t of [this.particles.a, this.particles.b]) {
      gl.bindTexture(gl.TEXTURE_2D, t.textures[0]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, pos);
      gl.bindTexture(gl.TEXTURE_2D, t.textures[1]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, vel);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.particleVao = this.particleVao || gl.createVertexArray();
  }

  /* ── cloth ─────────────────────────────────────────────────────────── */

  initCloth() {
    const gl = this.gl;
    const N = this.tier.cloth;
    this.clothN = N;

    // Offset to camera right rather than dead centre. Hung directly behind
    // the sculpture the cloth still collides correctly, but every interesting
    // part of it — the drape, the printed wordmark — ends up hidden behind
    // the thing it is colliding with.
    this.clothOrigin = [1.05, -1.52, -0.55];
    this.clothSize = [2.60, 2.50];

    this.cloth = new PingPong(gl, N, N, {
      formats: [FMT.RGBA32F, FMT.RGBA32F],
      filter: gl.NEAREST,
      label: 'cloth.state',
    });

    this.resetCloth();

    // index buffer for the triangle grid
    const quads = (N - 1) * (N - 1);
    const idx = new Uint16Array(quads * 6);
    let o = 0;
    for (let y = 0; y < N - 1; y++) {
      for (let x = 0; x < N - 1; x++) {
        const i0 = y * N + x, i1 = i0 + 1, i2 = i0 + N, i3 = i2 + 1;
        idx[o++] = i0; idx[o++] = i2; idx[o++] = i1;
        idx[o++] = i1; idx[o++] = i2; idx[o++] = i3;
      }
    }
    this.clothIndexCount = idx.length;

    this.clothVao = this.clothVao || gl.createVertexArray();
    gl.bindVertexArray(this.clothVao);
    this.clothIbo = this.clothIbo || gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.clothIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  resetCloth() {
    const gl = this.gl;
    const N = this.clothN;
    const data = new Float32Array(N * N * 4);
    const [ox, oy, oz] = this.clothOrigin;
    const [sw, sh] = this.clothSize;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        const u = x / (N - 1), v = y / (N - 1);
        data[i + 0] = ox + (u - 0.5) * sw;
        data[i + 1] = oy + v * sh;
        data[i + 2] = oz;
        data[i + 3] = 1;
      }
    }
    for (const t of [this.cloth.a, this.cloth.b]) {
      for (const tex of t.textures) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.clothPrevDt = 1 / 60;
  }

  disposeCloth() {
    this.cloth?.dispose();
    this.cloth = null;
  }

  /* A 64^3 lattice of random bytes, sampled with hardware trilinear filtering
     and REPEAT wrapping — which makes the filtering itself the interpolation,
     so this IS value noise, in one fetch.

     The generator is a seeded xorshift rather than Math.random(), so the
     sculpture's surface is identical on every load and between machines. */
  makeNoiseTexture() {
    const gl = this.gl;
    const N = 64;
    const data = new Uint8Array(N * N * N);

    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;  seed >>>= 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < data.length; i++) data[i] = (rnd() * 256) | 0;

    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, N, N, N);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, N, N, N, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return t;
  }

  /* The only raster image on the page, and it is drawn here rather than
     loaded — a 2D canvas, one fillText, uploaded once. */
  makePrintTexture() {
    const gl = this.gl;
    const S = 512;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');

    x.fillStyle = '#000';
    x.fillRect(0, 0, S, S);
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.textBaseline = 'middle';

    /* Fit the wordmark to the full width rather than picking a point size.
       Whatever the cloth is draped over will hide part of it, so the print
       has to be big enough that the visible part still reads — and the
       repeated strips above and below guarantee something legible survives
       wherever the drape happens to fall. */
    const fit = (text, targetW, weight, family) => {
      let size = S * 0.5;
      x.font = `${weight} ${size}px ${family}`;
      const w = x.measureText(text).width;
      size *= targetW / Math.max(w, 1);
      x.font = `${weight} ${size}px ${family}`;
      return size;
    };

    fit('winch', S * 0.90, 800, '"Inter Tight", system-ui, sans-serif');
    x.fillText('winch', S / 2, S * 0.50);

    x.fillStyle = '#8e8e8e';
    const strip = ' no engine · no libraries · no asset files ·';
    fit(strip.repeat(3), S * 0.98, 500, '"JetBrains Mono", monospace');
    x.fillText(strip.repeat(3), S / 2, S * 0.17);
    x.fillText(strip.repeat(3), S / 2, S * 0.85);

    this.printCanvas = c;   // kept so the harness can verify fillText actually drew

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, S, S);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /* ── camera ────────────────────────────────────────────────────────── */

  updateCamera(p) {
    const aspect = this.iw / this.ih;
    this.prevViewProj.set(this.viewProj);

    m4perspective(this.proj, (p.fov * Math.PI) / 180, aspect, 0.05, 120);
    m4lookAt(this.view, p.camPos, p.camTarget, [0, 1, 0]);
    m4mul(this.viewProj, this.proj, this.view);
    m4invert(this.invViewProj, this.viewProj);

    // jittered copies, for the raymarch only
    this.projJ.set(this.proj);
    if (this.tier.taa && p.taa !== 0) {
      const j = HALTON_8[this.frame % 8];
      this.projJ[8] += (j[0] * 2) / this.iw;
      this.projJ[9] += (j[1] * 2) / this.ih;
    }
    m4mul(this.viewProjJ, this.projJ, this.view);
    m4invert(this.invViewProjJ, this.viewProjJ);

    this.camPos = p.camPos;
  }

  /* Screen point in [0,1] → a world-space ray, for the mouse forces. */
  mouseRay(nx, ny) {
    const inv = this.invViewProj;
    const un = (x, y, z) => {
      const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15] || 1;
      return [
        (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w,
        (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w,
        (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w,
      ];
    };
    const a = un(nx, ny, -1);
    const b = un(nx, ny, 1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return { ro: a, rd: [d[0] / l, d[1] / l, d[2] / l] };
  }

  /* ── the frame ─────────────────────────────────────────────────────── */

  render(p, dt) {
    const gl = this.gl;
    if (this.lost) return;

    this.drawCalls = 0;
    this.simTime += dt;
    this.updateCamera(p);

    const draw = () => { this.blit.draw(); this.drawCalls++; };

    /* ── 1. particle solver ──────────────────────────────────────────── */
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    {
      const src = this.particles.read, dst = this.particles.write;
      dst.bind(false);
      const s = this.pPartSim.use();
      s.tex('uPos', src.textures[0]).tex('uVel', src.textures[1])
       .tex('uNoise', this.noiseTex, gl.TEXTURE_3D);
      s.setAll({
        uSimRes: [this.simN, this.simN],
        uDt: dt, uTime: this.simTime, uFrame: this.frame,
        uShape: p.shape, uDetail: p.detail, uScale: p.scale,
        uMouseRo: p.mouseRo, uMouseRd: p.mouseRd, uMouseForce: p.mouseForce,
        uCurl: p.pCurl, uAttract: p.pAttract, uTangent: p.pTangent,
        uDamp: p.pDamp, uSpin: p.pSpin, uLifeRate: p.pLife, uBurst: p.pBurst,
      });
      draw();
      this.particles.swap();
    }

    /* ── 2. cloth solver ─────────────────────────────────────────────── */
    if (p.clothOn > 0.001) {
      const sub = clamp(dt, 1 / 240, 1 / 45);
      {
        const src = this.cloth.read, dst = this.cloth.write;
        dst.bind(false);
        const s = this.pClothInt.use();
        s.tex('uCur', src.textures[0]).tex('uPrev', src.textures[1]);
        s.setAll({
          uN: [this.clothN, this.clothN],
          uOrigin: this.clothOrigin, uSize: this.clothSize,
          uDt: sub, uPrevDt: this.clothPrevDt, uTime: this.simTime,
          uGravity: p.cGravity, uWind: p.cWind, uDamp: p.cDamp,
          uPinned: p.cPinned,
          uGrabPos: p.grabPos, uGrabIdx: p.grabIdx, uGrabActive: p.grabActive,
        });
        draw();
        this.cloth.swap();
        this.clothPrevDt = sub;
      }

      const iters = Math.round(p.cIters);
      for (let i = 0; i < iters; i++) {
        const src = this.cloth.read, dst = this.cloth.write;
        dst.bind(false);
        const s = this.pClothRel.use();
        s.tex('uCur', src.textures[0]).tex('uPrev', src.textures[1])
         .tex('uNoise', this.noiseTex, gl.TEXTURE_3D);
        s.setAll({
          uN: [this.clothN, this.clothN],
          uOrigin: this.clothOrigin, uSize: this.clothSize,
          uStiff: p.cStiff, uPinned: p.cPinned, uTime: this.simTime,
          uShape: p.shape, uDetail: p.detail, uScale: p.scale,
          uFloorY: -1.62, uFriction: 0.24,
        });
        draw();
        this.cloth.swap();
      }
    }

    /* ── 3. raymarch ─────────────────────────────────────────────────── */
    this.tScene.bind(true, 0, 0, 0, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.ALWAYS);   // a fullscreen pass that supplies its own depth
    {
      const s = this.pRaymarch.use();
      s.tex('uNoise', this.noiseTex, gl.TEXTURE_3D);
      s.setAll({
        uRes: [this.iw, this.ih],
        uTime: this.simTime, uFrame: this.frame,
        uInvViewProj: this.invViewProjJ, uViewProj: this.viewProjJ,
        uCamPos: this.camPos,
        uShape: p.shape, uDetail: p.detail, uScale: p.scale,
        uMatId: p.matId,
        uRough: p.rough, uMetal: p.metal, uIor: p.ior,
        uAniso: p.aniso, uFilm: p.film, uTrans: p.trans, uEmissive: p.emissive,
        uSteps: this.tier.steps, uTransSteps: this.tier.transSteps,
        uReflSteps: this.tier.reflSteps, uShadowSteps: this.tier.shadowSteps,
        uReflect: this.tier.reflect * (p.reflect ?? 1),
        uRimBoost: p.rimBoost, uExposure: p.sceneExposure,
      });
      draw();
    }

    /* ── 4. cloth raster, into the same target ───────────────────────── */
    if (p.clothOn > 0.001) {
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      const s = this.pClothDraw.use();
      s.tex('uCur', this.cloth.read.textures[0]).tex('uPrint', this.printTex);
      s.setAll({
        uN: [this.clothN, this.clothN],
        uOrigin: this.clothOrigin, uSize: this.clothSize,
        uViewProj: this.viewProj, uCamPos: this.camPos,
        uRimBoost: p.rimBoost, uExposure: p.sceneExposure, uFade: p.clothOn,
      });
      gl.bindVertexArray(this.clothVao);
      gl.drawElements(gl.TRIANGLES, this.clothIndexCount, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      this.drawCalls++;
    }

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    /* ── 5. particles, additive, soft against the scene ──────────────── */
    this.tParticles.bind(true, 0, 0, 0, 1);
    if (p.pGain > 0.001) {
      additive(gl, true);
      const s = this.pPartDraw.use();
      s.tex('uPos', this.particles.read.textures[0])
       .tex('uVel', this.particles.read.textures[1])
       .tex('uSceneDist', this.tScene.textures[1]);
      s.setAll({
        uSimRes: [this.simN, this.simN],
        uViewProj: this.viewProj, uCamPos: this.camPos,
        uRes: [this.iw, this.ih],
        uPointScale: p.pSize * this.ih * 0.0016,
        uSizeJitter: 0.9,
        /* Normalise brightness against the particle count.

           Additive blending sums every sprite, so quadrupling the count
           quadruples the glow — the ultra tier was washing the entire frame
           lime while medium looked right, because the gain was tuned at
           medium and never re-checked at ultra. More particles should buy
           finer structure, not more light. */
        uIntensity: clamp(65536 / this.particleCount, 0.22, 1.3),
        uFade: p.pGain,
      });
      gl.bindVertexArray(this.particleVao);
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
      gl.bindVertexArray(null);
      this.drawCalls++;
      additive(gl, false);
    }

    /* ── 6. composite ────────────────────────────────────────────────── */
    this.tComposite.bind(false);
    {
      const s = this.pComposite.use();
      s.tex('uScene', this.tScene.textures[0]).tex('uParticles', this.tParticles.tex);
      s.set('uParticleGain', 1.0);
      draw();
    }

    /* ── 7. TAA ──────────────────────────────────────────────────────── */
    let lit = this.tComposite.tex;
    if (this.tier.taa && p.taa !== 0) {
      const dst = this.ppTaa.write;
      dst.bind(false);
      const s = this.pTaa.use();
      s.tex('uCurrent', this.tComposite.tex)
       .tex('uHistory', this.ppTaa.read.tex)
       .tex('uDist', this.tScene.textures[1]);
      s.setAll({
        uInvViewProj: this.invViewProj,
        uPrevViewProj: this.prevViewProj,
        uCamPos: this.camPos,
        uRes: [this.iw, this.ih],
        uFeedback: p.taaFeedback ?? 0.9,
        uReset: this.taaReset,
      });
      draw();
      this.ppTaa.swap();
      lit = this.ppTaa.read.tex;
      this.taaReset = 0;
    }

    /* ── 8. bloom ────────────────────────────────────────────────────── */
    if (this.bloom.length) {
      this.bloom[0].bind(false);
      {
        const s = this.pPrefilter.use();
        s.tex('uTex', lit);
        s.setAll({
          uTexel: [1 / this.iw, 1 / this.ih],
          uThreshold: p.bloomThreshold, uKnee: 0.55, uClamp: 24.0,
        });
        draw();
      }
      for (let i = 1; i < this.bloom.length; i++) {
        this.bloom[i].bind(false);
        const s = this.pDown.use();
        s.tex('uTex', this.bloom[i - 1].tex);
        s.set('uTexel', [1 / this.bloom[i - 1].w, 1 / this.bloom[i - 1].h]);
        draw();
      }
      for (let i = this.bloom.length - 1; i > 0; i--) {
        // Read level i, blend into level i-1. Each level is its own texture,
        // never a mip of a shared one, so the source is never also the
        // destination and there is no feedback loop to reason about.
        const dst = this.bloom[i - 1];
        const src = this.bloom[i];
        dst.bind(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);   // the accumulation, done in hardware
        const s = this.pUp.use();
        s.tex('uTex', src.tex);
        s.setAll({ uTexel: [1 / src.w, 1 / src.h], uRadius: p.bloomRadius });
        draw();
        gl.disable(gl.BLEND);
      }
    }

    /* ── 9. anamorphic streak ────────────────────────────────────────── */
    if (this.bloom.length && p.streak > 0.001) {
      const smallest = this.bloom[this.bloom.length - 1];
      this.tStreakA.bind(false);
      {
        const s = this.pStreak.use();
        s.tex('uTex', smallest.tex);
        s.setAll({ uTexel: [1 / smallest.w, 1 / smallest.h], uDir: [1, 0], uSpread: 3.2 });
        draw();
      }
      this.tStreakB.bind(false);
      {
        const s = this.pStreak.use();
        s.tex('uTex', this.tStreakA.tex);
        s.setAll({ uTexel: [1 / this.tStreakA.w, 1 / this.tStreakA.h], uDir: [1, 0], uSpread: 9.0 });
        draw();
      }
    }

    /* ── 10. final ───────────────────────────────────────────────────── */
    toScreen(gl, this.canvas.width, this.canvas.height);
    {
      const s = this.pFinal.use();
      s.tex('uScene', lit)
       .tex('uBloom', this.bloom.length ? this.bloom[0].tex : lit)
       .tex('uStreak', this.tStreakB.tex);
      s.setAll({
        uRes: [this.canvas.width, this.canvas.height],
        uTime: this.simTime, uFrame: this.frame,
        uBloomAmount: p.bloom, uStreakAmount: p.streak,
        uExposure: p.exposure, uCA: p.ca, uVignette: p.vignette,
        uGrain: p.grain, uSat: p.sat, uContrast: p.contrast,
        uLift: p.lift, uGain: p.gain, uFade: p.fade, uScanline: p.scanline ?? 0,
      });
      draw();
    }

    this.frame++;

    if (this.pending.screenshot) {
      const cb = this.pending.screenshot;
      this.pending.screenshot = null;
      try { cb(this.canvas.toDataURL('image/png')); } catch { cb(null); }
    }
  }

  requestScreenshot(cb) { this.pending.screenshot = cb; }

  markCameraCut() { this.taaReset = 1; }

  installContextLossHandlers() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLog('gpu context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.onLog('gpu context restored — rebuilding');
      try {
        this.buildPrograms();
        this.resize(true);
        this.initParticles();
        this.initCloth();
        this.printTex = this.makePrintTexture();
        this.lost = false;
      } catch (err) {
        console.error(err);
      }
    });
  }

  dispose() {
    for (const k of Object.keys(this)) {
      const v = this[k];
      if (v && typeof v.dispose === 'function' && v !== this) v.dispose();
    }
    this.bloom?.forEach((t) => t.dispose());
  }
}

export { GLError };
