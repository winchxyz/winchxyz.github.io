/* LED dot matrix in the look of the reference widget: square dots on a dark grid, one colour
   per category, levels drawn by ordered dithering, a soft bloom, focus, sparkle and particles.
   Plain script: defines window.LED. Every cell holds a colour and a level (0..1); the variant
   decides what the cells mean.

   Rendering, per frame: three tiny per-cell bitmaps (fill, dim, lit) are written with
   putImageData, scaled up nearest-neighbour, the dim and lit layers cut into square dots by a
   repeating mask, and the lit layer blurred cheaply (downscale, then smooth upscale) for bloom. */
(function () {
  'use strict';
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const hex = h => { h = String(h).replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
  const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  /* The reference's category colours, a little brighter than the compressed video. */
  const COLORS = {
    blue: '#3b8cf5', magenta: '#ee3c9f', green: '#3fd46a', cyan: '#34d0de', purple: '#9a5cf2',
    orange: '#f5873a', yellow: '#ffcc1a', red: '#f04a55', grey: '#b8bac2', white: '#ececf1',
  };
  const rgb = c => Array.isArray(c) ? c : hex(COLORS[c] || c);

  function canvas(w = 1, h = 1) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function dotMask(dp, size) {
    const c = canvas(dp, dp), g = c.getContext('2d');
    const s = Math.max(1, Math.round(dp * size)), o = Math.floor((dp - s) / 2);
    g.fillStyle = '#000';
    g.fillRect(o, o, s, s);
    return c;
  }

  class Matrix {
    /* o.pitch    CSS px from dot to dot (snapped to whole device px)
       o.lit      lit dot size as a share of the pitch; o.dim the unlit dot size
       o.off      colour of an empty cell's dot; null draws nothing there
       o.bg       the surface the matrix sits on (tints are mixed from it)
       o.tint     how much of its colour an unlit dot keeps (per cell override in set)
       o.fill     how much of its colour the square behind a dot keeps
       o.noise    0 = pure ordered dither, 1 = random threshold per dot
       o.glow     bloom strength; o.shimmer how much the threshold breathes */
    constructor(el, opts = {}) {
      this.cv = el;
      this.ctx = el.getContext('2d');
      this.o = Object.assign({
        pitch: 4, lit: 0.66, dim: 0.34, off: '#222326', bg: '#17181b',
        tint: 0.24, fill: 0.075, noise: 0.35, glow: 0.7, shimmer: 0, focusDim: 0.2, speed: 9, maxDpr: 2,
      }, opts);
      this.parts = [];
      this.t = 0; this.last = 0;
      this.focusGroup = -1;
      this.groupW = new Float32Array(256).fill(1);
      this.groupB = new Float32Array(256);
      this.L = { fill: canvas(), dim: canvas(), lit: canvas(), half: canvas(), quarter: canvas() };
      this.B = { dim: canvas(), lit: canvas() };
      this.resize();
    }

    resize() {
      const dpr = Math.min(this.o.maxDpr, window.devicePixelRatio || 1);
      const dp = Math.max(2, Math.round(this.o.pitch * dpr));
      /* o.rows / o.cols fix the grid and size the canvas to fit it exactly */
      if (this.o.rows) this.cv.style.height = (this.o.rows * dp / dpr) + 'px';
      if (this.o.cols) this.cv.style.width = (this.o.cols * dp / dpr) + 'px';
      const r = this.cv.getBoundingClientRect();
      this.dpr = dpr; this.dp = dp; this.pitch = dp / dpr;
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      this.cv.width = W; this.cv.height = H;
      this.W = W; this.H = H; this.w = r.width; this.h = r.height;
      const cols = Math.max(1, Math.floor(W / dp)), rows = Math.max(1, Math.floor(H / dp));
      this.cols = cols; this.rows = rows;
      this.ox = Math.floor((W - cols * dp) / 2);
      this.oy = Math.floor((H - rows * dp) / 2);
      const n = cols * rows; this.n = n;
      this.col = new Uint8ClampedArray(n * 3);
      this.has = new Uint8Array(n);
      this.grp = new Int16Array(n).fill(-1);
      this.lv = new Float32Array(n);
      this.cur = new Float32Array(n);
      this.hot = new Float32Array(n);
      this.tnt = new Float32Array(n).fill(-1);
      this.fil = new Float32Array(n).fill(-1);
      this.rnd = new Float32Array(n);
      this.ph = new Float32Array(n);
      for (let i = 0; i < n; i++) { this.rnd[i] = Math.random(); this.ph[i] = Math.random() * 6.283; }
      for (const k of ['fill', 'dim', 'lit']) { this.L[k].width = cols; this.L[k].height = rows; }
      this.L.half.width = Math.max(1, cols >> 1); this.L.half.height = Math.max(1, rows >> 1);
      this.L.quarter.width = Math.max(1, cols >> 2); this.L.quarter.height = Math.max(1, rows >> 2);
      for (const k of ['dim', 'lit']) { this.B[k].width = W; this.B[k].height = H; }
      this.img = {};
      for (const k of ['fill', 'dim', 'lit']) this.img[k] = this.L[k].getContext('2d').createImageData(cols, rows);
      const shift = new DOMMatrix().translate(this.ox, this.oy);
      this.mask = {
        lit: this.ctx.createPattern(dotMask(dp, this.o.lit), 'repeat'),
        dim: this.ctx.createPattern(dotMask(dp, this.o.dim), 'repeat'),
      };
      this.mask.lit.setTransform(shift); this.mask.dim.setTransform(shift);
      this.offRgb = this.o.off ? hex(this.o.off) : null;
      this.bgRgb = hex(this.o.bg);
      if (this.onresize) this.onresize(this);
    }

    /* cells */
    idx(c, r) { return r * this.cols + c; }
    clear() { this.has.fill(0); this.lv.fill(0); this.grp.fill(-1); this.tnt.fill(-1); this.fil.fill(-1); }
    set(i, color, level, group = -1, tint = -1, fill = -1) {
      const c = rgb(color);
      this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
      this.has[i] = 1; this.lv[i] = level; this.grp[i] = group; this.tnt[i] = tint; this.fil[i] = fill;
    }
    unset(i) { this.has[i] = 0; this.lv[i] = 0; this.cur[i] = 0; this.grp[i] = -1; }
    rect(c0, r0, c1, r1, color, level, group = -1, tint = -1, fill = -1) {
      for (let r = Math.max(0, r0); r < Math.min(this.rows, r1); r++)
        for (let c = Math.max(0, c0); c < Math.min(this.cols, c1); c++) this.set(r * this.cols + c, color, level, group, tint, fill);
    }
    /* Paint a picture into a block of cells. Brightness becomes the level, so the dither decides
       which dots light, and each dot keeps the picture's hue at full brightness. */
    image(src, c0, r0, cw, ch, opts = {}) {
      const o = Object.assign({ fit: 'cover', gain: 1.2, gamma: 0.85, floor: 0.05, group: -1, sat: 1.1, tint: 0.16, fill: 0.05, ax: 0.5, ay: 0.5 }, opts);
      const g = canvas(cw, ch), x = g.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#000'; x.fillRect(0, 0, cw, ch);
      const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
      const k = o.fit === 'cover' ? Math.max(cw / iw, ch / ih) : Math.min(cw / iw, ch / ih);
      const dw = iw * k, dh = ih * k;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, (cw - dw) * o.ax, (ch - dh) * o.ay, dw, dh);
      let d;
      try { d = x.getImageData(0, 0, cw, ch).data; } catch (e) { return false; } // a cross-origin picture
      for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
        const cc = c0 + c, rr = r0 + r;
        if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) continue;
        const p = (r * cw + c) * 4;
        let R = d[p], G = d[p + 1], B = d[p + 2];
        const L = (0.3 * R + 0.59 * G + 0.11 * B) / 255;
        const m = Math.max(R, G, B, 1), lift = 255 / m;
        R *= lift; G *= lift; B *= lift;
        if (o.sat !== 1) { const a = (R + G + B) / 3; R = a + (R - a) * o.sat; G = a + (G - a) * o.sat; B = a + (B - a) * o.sat; }
        const lvl = clamp(Math.pow(clamp((L - o.floor) * o.gain), o.gamma));
        this.set(rr * this.cols + cc, [clamp(R, 0, 255), clamp(G, 0, 255), clamp(B, 0, 255)], lvl, o.group, o.tint, o.fill);
      }
      return true;
    }

    /* focus: one group stays bright, the others fall back toward their unlit dots */
    focus(group) { this.focusGroup = group; }
    sparkle(n = 3, min = 0.25) {
      for (let k = 0; k < n; k++) {
        const i = (Math.random() * this.n) | 0;
        if (this.has[i] && this.cur[i] > min) this.hot[i] = Math.max(this.hot[i], 0.85 + Math.random() * 0.15);
      }
    }
    /* square particles from the given cells; the cells themselves go dark */
    burst(cells, o = {}) {
      const dp = this.dp, keep = o.keep ?? 0.6;
      for (const i of cells) {
        if (!this.has[i]) continue;
        const c = i % this.cols, r = (i / this.cols) | 0;
        const lit = this.cur[i] > BAYER[(r & 3) * 4 + (c & 3)];
        if (Math.random() < (lit ? keep : keep * 0.1)) {
          this.parts.push({
            x: this.ox + c * dp, y: this.oy + r * dp,
            vx: (o.vx ?? 14) * this.dpr * (Math.random() * 2 - 0.6),
            vy: -(o.vy ?? 60) * this.dpr * (0.35 + Math.random()),
            life: 0, max: (o.life ?? 1) * (0.45 + Math.random() * 0.75),
            c: [this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]],
            w: Math.random() < 0.25,
          });
        }
        if (o.clear !== false) this.unset(i);
      }
    }

    /* one frame: ease toward targets, then draw */
    frame(now) {
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
      this.last = now; this.t += dt; this.dt = dt;
      const ease = 1 - Math.exp(-dt * this.o.speed), ge = 1 - Math.exp(-dt * 10);
      const fd = this.o.focusDim, fg = this.focusGroup;
      for (let g = 0; g < this.groupW.length; g++) {
        const target = fg < 0 || fg === g ? 1 : fd;
        this.groupW[g] += (target - this.groupW[g]) * ge;
        this.groupB[g] += ((fg === g ? 1 : 0) - this.groupB[g]) * ge;
      }
      const { cur, lv, hot, n } = this, cool = dt * 2.4;
      for (let i = 0; i < n; i++) {
        cur[i] += (lv[i] - cur[i]) * ease;
        if (hot[i] > 0) hot[i] = hot[i] > cool ? hot[i] - cool : 0;
      }
      if (this.before) this.before(this, dt);
      this.render();
      return dt;
    }

    render() {
      const { cols, rows, img, col, has, cur, hot, grp, groupW, groupB, rnd, ph, tnt, fil } = this;
      const boost = this.o.boost ?? 0.5;
      const F = img.fill.data, D = img.dim.data, Lt = img.lit.data;
      const off = this.offRgb, bg = this.bgRgb, o = this.o;
      const noise = o.noise, sh = o.shimmer, t = this.t, dTint = o.tint, dFill = o.fill;
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          const p = i * 4;
          if (!has[i]) {
            F[p + 3] = 0; Lt[p + 3] = 0;
            if (off) { D[p] = off[0]; D[p + 1] = off[1]; D[p + 2] = off[2]; D[p + 3] = 255; } else D[p + 3] = 0;
            continue;
          }
          const gi = grp[i], gw = gi >= 0 ? groupW[gi] : 1, gb = gi >= 0 ? groupB[gi] : 0;
          const R = col[i * 3], G = col[i * 3 + 1], B = col[i * 3 + 2];
          const fk = (fil[i] >= 0 ? fil[i] : dFill) * (0.45 + 0.55 * gw);
          F[p] = bg[0] + (R - bg[0]) * fk; F[p + 1] = bg[1] + (G - bg[1]) * fk; F[p + 2] = bg[2] + (B - bg[2]) * fk; F[p + 3] = 255;
          const tk = (tnt[i] >= 0 ? tnt[i] : dTint) * (0.5 + 0.5 * gw);
          D[p] = bg[0] + (R - bg[0]) * tk; D[p + 1] = bg[1] + (G - bg[1]) * tk; D[p + 2] = bg[2] + (B - bg[2]) * tk; D[p + 3] = 255;
          let th = BAYER[(r & 3) * 4 + (c & 3)] * (1 - noise) + rnd[i] * noise;
          if (sh) th += sh * Math.sin(t * 1.7 + ph[i]);
          const level = cur[i] * (0.35 + 0.65 * gw) * (1 + boost * gb) + 0.05 * gb;
          const h = hot[i];
          if (level > th) {
            const a = 0.28 + 0.72 * gw;
            Lt[p] = R + (255 - R) * h; Lt[p + 1] = G + (255 - G) * h; Lt[p + 2] = B + (255 - B) * h; Lt[p + 3] = 255 * a;
          } else if (h > 0.05) {
            Lt[p] = 255; Lt[p + 1] = 255; Lt[p + 2] = 255; Lt[p + 3] = 255 * h * 0.9;
          } else Lt[p + 3] = 0;
        }
      }
      const ctx = this.ctx, W = this.W, H = this.H, sw = cols * this.dp, shh = rows * this.dp, L = this.L;
      for (const k of ['fill', 'dim', 'lit']) L[k].getContext('2d').putImageData(img[k], 0, 0);
      for (const k of ['dim', 'lit']) {
        const b = this.B[k].getContext('2d');
        b.globalCompositeOperation = 'source-over';
        b.clearRect(0, 0, W, H);
        b.imageSmoothingEnabled = false;
        b.drawImage(L[k], this.ox, this.oy, sw, shh);
        b.globalCompositeOperation = 'destination-in';
        b.fillStyle = this.mask[k];
        b.fillRect(0, 0, W, H);
      }
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      if (this.under) this.under(ctx, this);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(L.fill, this.ox, this.oy, sw, shh);
      ctx.drawImage(this.B.dim, 0, 0);
      if (o.glow > 0) {
        const hc = L.half.getContext('2d'), qc = L.quarter.getContext('2d');
        hc.clearRect(0, 0, L.half.width, L.half.height);
        hc.imageSmoothingEnabled = true; hc.drawImage(L.lit, 0, 0, L.half.width, L.half.height);
        qc.clearRect(0, 0, L.quarter.width, L.quarter.height);
        qc.imageSmoothingEnabled = true; qc.drawImage(L.half, 0, 0, L.quarter.width, L.quarter.height);
        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = o.glow * 0.55; ctx.drawImage(L.lit, this.ox, this.oy, sw, shh);
        ctx.globalAlpha = o.glow * 0.5; ctx.drawImage(L.half, this.ox, this.oy, sw, shh);
        ctx.globalAlpha = o.glow * 0.45; ctx.drawImage(L.quarter, this.ox - this.dp, this.oy - this.dp, sw + 2 * this.dp, shh + 2 * this.dp);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(this.B.lit, 0, 0);
      if (this.parts.length) this.drawParts(ctx);
      if (this.after) this.after(ctx, this);
      ctx.restore();
    }

    drawParts(ctx) {
      const dt = this.dt || 1 / 60, s = Math.max(1, Math.round(this.dp * this.o.lit)), keep = [];
      ctx.globalCompositeOperation = 'lighter';
      for (const q of this.parts) {
        q.life += dt; if (q.life > q.max) continue;
        q.x += q.vx * dt; q.y += q.vy * dt; q.vy -= 22 * this.dpr * dt; q.vx *= 0.99;
        const a = 1 - q.life / q.max;
        const wk = q.w ? 0.85 : 0.35 * a;
        ctx.globalAlpha = Math.min(1, a * 1.15);
        ctx.fillStyle = css(mix(q.c, [255, 255, 255], wk));
        const sz = Math.max(1, Math.round(s * (0.6 + 0.4 * a)));
        ctx.fillRect(Math.round(q.x), Math.round(q.y), sz, sz);
        keep.push(q);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      this.parts = keep;
    }

    /* cell <-> CSS px */
    cellAt(x, y) {
      const c = Math.floor((x * this.dpr - this.ox) / this.dp), r = Math.floor((y * this.dpr - this.oy) / this.dp);
      return c >= 0 && r >= 0 && c < this.cols && r < this.rows ? r * this.cols + c : -1;
    }
    colAt(x) { return Math.floor((x * this.dpr - this.ox) / this.dp); }
    rowAt(y) { return Math.floor((y * this.dpr - this.oy) / this.dp); }
    cssX(c) { return (this.ox + c * this.dp) / this.dpr; }
    cssY(r) { return (this.oy + r * this.dp) / this.dpr; }
  }

  /* Outlines for a row of segments in the reference style: each segment framed by a 1px line in
     its colour with a glow, light separators between segments, rounded outer corners.
     segs: [{c0, c1, color, a}] left to right, cells [c0, c1); rows [r0, r1). */
  function drawSegments(ctx, m, segs, r0, r1, o = {}) {
    if (!segs.length) return;
    const dp = m.dp, lw = Math.max(1, Math.round(m.dpr)), half = lw / 2;
    const y0 = m.oy + r0 * dp - half, y1 = m.oy + r1 * dp + half;
    const rad = (o.radius ?? 8) * m.dpr, blur = (o.blur ?? 9) * m.dpr;
    ctx.save();
    ctx.lineWidth = lw;
    segs.forEach((s, k) => {
      const a = s.a ?? 1;
      if (a <= 0.01) return;
      const x0 = m.ox + s.c0 * dp - half, x1 = m.ox + s.c1 * dp + half;
      const first = k === 0, last = k === segs.length - 1 || s.end;
      const c = rgb(s.color);
      ctx.strokeStyle = rgba(c, a);
      ctx.shadowColor = rgba(c, 0.9 * a);
      ctx.shadowBlur = blur * (s.glow ?? 1);
      ctx.beginPath();
      ctx.roundRect(x0, y0, x1 - x0, y1 - y0, [first ? rad : 0, last ? rad : 0, last ? rad : 0, first ? rad : 0]);
      ctx.stroke();
    });
    ctx.shadowBlur = 3 * m.dpr;
    ctx.shadowColor = 'rgba(255,255,255,.5)';
    for (let k = 1; k < segs.length; k++) {
      const s = segs[k], p = segs[k - 1];
      const a = Math.max(s.a ?? 1, p.a ?? 1);
      if (a <= 0.01 || p.end) continue;
      const x = m.ox + s.c0 * dp;
      ctx.fillStyle = `rgba(236,236,241,${(o.sep ?? 0.62) * a})`;
      ctx.fillRect(Math.round(x - half), Math.round(y0 + lw), lw, Math.round(y1 - y0 - lw * 2));
    }
    ctx.restore();
  }

  /* the empty part of a bar: a faint frame like the reference's free-space track */
  function drawTrack(ctx, m, c0, c1, r0, r1, o = {}) {
    const dp = m.dp, lw = Math.max(1, Math.round(m.dpr)), half = lw / 2;
    const x0 = m.ox + c0 * dp - half, x1 = m.ox + c1 * dp + half, y0 = m.oy + r0 * dp - half, y1 = m.oy + r1 * dp + half;
    const rad = (o.radius ?? 8) * m.dpr;
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = o.color || 'rgba(255,255,255,.07)';
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, [o.left ? rad : 0, rad, rad, o.left ? rad : 0]);
    ctx.stroke();
    ctx.restore();
  }

  /* a bright scan line at a column, as in the reference's intro */
  function drawScan(ctx, m, c, r0, r1, a = 1) {
    if (a <= 0) return;
    const dp = m.dp, x = m.ox + c * dp, y0 = m.oy + r0 * dp, y1 = m.oy + r1 * dp, lw = Math.max(1, Math.round(m.dpr * 1.5));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(x - dp * 6, 0, x + lw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, `rgba(255,255,255,${0.16 * a})`);
    ctx.fillStyle = g;
    ctx.fillRect(x - dp * 6, y0, dp * 6, y1 - y0);
    ctx.shadowColor = `rgba(255,255,255,${a})`;
    ctx.shadowBlur = 10 * m.dpr;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y0 - m.dpr, lw, y1 - y0 + 2 * m.dpr);
    ctx.restore();
  }

  /* run fn every frame while el is on screen */
  function run(el, fn) {
    let on = false, vis = !('IntersectionObserver' in window), id = 0;
    const step = t => { if (!on) return; fn(t); id = requestAnimationFrame(step); };
    const start = () => { if (on || !vis || document.hidden) return; on = true; id = requestAnimationFrame(step); };
    const stop = () => { on = false; cancelAnimationFrame(id); };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(es => { for (const e of es) { vis = e.isIntersecting; vis ? start() : stop(); } }, { rootMargin: '160px' }).observe(el);
    } else start();
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    return { start, stop };
  }

  function loadImage(src) {
    return new Promise(res => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }

  /* count a number up or down; calls fn(value) each frame */
  function tween(from, to, ms, fn, ease = t => 1 - Math.pow(1 - t, 3)) {
    return new Promise(res => {
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / ms);
        fn(from + (to - from) * ease(k));
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* the CSS pitch a Matrix will really use (whole device pixels) */
  const snap = (p, maxDpr = 2) => { const d = Math.min(maxDpr, window.devicePixelRatio || 1); return Math.max(2, Math.round(p * d)) / d; };

  window.LED = { Matrix, COLORS, rgb, hex, mix, clamp, css, rgba, drawSegments, drawTrack, drawScan, run, loadImage, tween, wait, snap, BAYER };
})();
