/* ══════════════════════════════════════════════════════════════════════════
   ui.js: the DOM half.

   Scroll is read once per frame from a cached offset table rather than by
   asking the layout engine where things are; the only getBoundingClientRect
   calls happen on resize.
   ══════════════════════════════════════════════════════════════════════════ */

import { MATERIALS, SHORTCUTS, REPOS, ROTATOR, LANG_COLOR, LIVE_STATS, GH_USER, DEFAULT_MATERIAL } from './content.js';
import { clamp, damp, fmt, fmtShort } from './math.js';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

export class UI {
  constructor() {
    this.sections = $$('.sec');
    this.offsets = [];
    this.scrollY = 0;
    this.smoothY = 0;
    this.section = 0;
    this.local = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.onMaterial = () => {};
    this.onAction = () => {};
  }

  /* ── build ─────────────────────────────────────────────────────────── */

  build() {
    this.buildMaterials();
    this.buildWork();
    this.buildRail();
    this.buildShortcuts();
    this.buildReveal();
    this.buildCursor();
    this.buildRotator();
    this.buildNav();
    this.measure();
    $('#year').textContent = new Date().getFullYear();
  }

  buildMaterials() {
    const list = $('#mat-list');
    list.setAttribute('role', 'tablist');   // the buttons already say role=tab
    list.setAttribute('aria-label', 'material presets');
    MATERIALS.forEach((m, i) => {
      const li = el('li');
      const b = el('button', '', `
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="nm">${m.name}</span>`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.selectMaterial(i));
      li.appendChild(b);
      list.appendChild(li);
    });
    this.selectMaterial(DEFAULT_MATERIAL, true);
  }

  selectMaterial(i, silent = false) {
    const m = MATERIALS[i];
    if (!m) return;

    /* Ask before committing. An absorb already in flight refuses a second
       one, and the panel must not say a material the sculpture is not going
       to become. */
    if (!silent && this.onMaterial(i) === false) return;

    this.materialIndex = i;
    $$('#mat-list li').forEach((li, n) => li.classList.toggle('is-on', n === i));
    $$('#mat-list button').forEach((b, n) => b.setAttribute('aria-selected', String(n === i)));

    const name = $('#mat-name'), desc = $('#mat-desc'), par = $('#mat-params');
    name.textContent = m.name;
    desc.textContent = m.desc;
    par.innerHTML = '';
    m.stats.forEach(([k, v]) => {
      const d = el('div');
      d.appendChild(el('dt', '', k));
      d.appendChild(el('dd', '', v));
      par.appendChild(d);
    });

    // a small re-entry animation so switching preset feels like a switch
    [name, desc, par].forEach((n, k) => {
      n.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 420, delay: k * 45, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' },
      );
    });

  }

  buildWork() {
    const grid = $('#work-grid');
    REPOS.forEach((r) => {
      const li = el('li');
      li.dataset.group = r.group;
      const a = el('a', 'card');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `
        <div class="card-top">
          <h3 class="card-name">${r.name}</h3>
          <span class="card-arrow" aria-hidden="true">↗</span>
        </div>
        <p class="card-desc">${r.desc}</p>
        <ul class="card-tags">${r.tags.map((t) => `<li>${t}</li>`).join('')}</ul>
        <div class="card-stats">
          <span>★ <b data-stars="${r.name}">${r.stars}</b></span>
          <span>⑂ <b data-forks="${r.name}">${r.forks}</b></span>
          <span class="lang"><i style="background:${LANG_COLOR[r.lang] || '#888'}"></i>${r.lang}</span>
        </div>
        <i class="card-bar"></i>`;

      // pointer-tracked glow + a very small 3D tilt
      a.addEventListener('pointermove', (e) => {
        const b = a.getBoundingClientRect();
        const x = e.clientX - b.left, y = e.clientY - b.top;
        a.style.setProperty('--mx', x + 'px');
        a.style.setProperty('--my', y + 'px');
        if (this.reduced) return;
        const rx = ((y / b.height) - 0.5) * -4;
        const ry = ((x / b.width) - 0.5) * 4;
        a.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      });
      a.addEventListener('pointerleave', () => { a.style.transform = ''; });

      li.appendChild(a);
      grid.appendChild(li);
    });

    $$('.work-filters .chip').forEach((c) => {
      c.addEventListener('click', () => {
        $$('.work-filters .chip').forEach((o) => o.classList.toggle('is-on', o === c));
        const f = c.dataset.filter;
        $$('#work-grid li').forEach((li) => {
          li.classList.toggle('is-off', f !== 'all' && li.dataset.group !== f);
        });
      });
    });
  }


  buildRail() {
    const ol = $('#rail-ticks');
    this.sections.forEach((s, i) => {
      const li = el('li');
      li.style.top = ((i / (this.sections.length - 1)) * 100) + '%';
      li.innerHTML = `<span>${(s.dataset.label || '').split('/').pop().trim()}</span>`;
      li.addEventListener('click', () => this.scrollTo('#' + s.id));
      ol.appendChild(li);
    });
    this.railTicks = $$('#rail-ticks li');
  }

  buildShortcuts() {
    const dl = $('#sheet-list');
    SHORTCUTS.forEach(([k, v]) => {
      const d = el('div');
      d.innerHTML = `<dt>${v}</dt><dd>${k.split(' ').map((s) => `<kbd>${s}</kbd>`).join(' ')}</dd>`;
      dl.appendChild(d);
    });
    const close = () => { $('#sheet').hidden = true; };
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') close(); });
    $$('[data-action="close-sheet"]').forEach((b) => b.addEventListener('click', close));
    $$('[data-action="shortcuts"]').forEach((b) => b.addEventListener('click', () => this.toggleSheet()));
  }

  toggleSheet() { const s = $('#sheet'); s.hidden = !s.hidden; }

  buildReveal() {
    $$('[data-reveal]').forEach((n) => n.style.setProperty('--d', n.dataset.revealDelay || 0));
    if (this.reduced) { $$('[data-reveal]').forEach((n) => n.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });
    $$('[data-reveal]').forEach((n) => io.observe(n));
  }

  buildNav() {
    $$('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); this.scrollTo(a.getAttribute('href')); });
    });
    $$('[data-scrollto]').forEach((b) => {
      b.addEventListener('click', () => this.scrollTo(b.dataset.scrollto));
    });
    this.navLinks = $$('#nav nav a');
  }

  scrollTo(sel) {
    const n = sel && document.querySelector(sel);
    if (!n) return;
    // offsetTop puts the section's top edge at the viewport's top edge, which
    // is underneath the fixed navigation. Back off by its height.
    const nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 68;
    scrollTo({ top: Math.max(0, n.offsetTop - nav), behavior: this.reduced ? 'auto' : 'smooth' });
  }

  /* ── cursor ────────────────────────────────────────────────────────── */

  buildCursor() {
    if (matchMedia('(pointer: coarse)').matches) return;
    const root = $('#cursor');
    const dot = $('.c-dot', root), ring = $('.c-ring', root), lbl = $('.c-lbl', root);
    document.body.classList.add('has-cursor');

    this.cur = { x: innerWidth / 2, y: innerHeight / 2, rx: innerWidth / 2, ry: innerHeight / 2 };

    addEventListener('pointermove', (e) => {
      this.cur.x = e.clientX; this.cur.y = e.clientY;
      dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%,-50%)`;
    }, { passive: true });

    const hot = 'a, button, input, .chip, [data-magnetic], #rail li';
    addEventListener('pointerover', (e) => {
      document.body.classList.toggle('cur-hot', !!e.target.closest?.(hot));
    }, { passive: true });

    this.cursorTick = (dt) => {
      this.cur.rx = damp(this.cur.rx, this.cur.x, 14, dt);
      this.cur.ry = damp(this.cur.ry, this.cur.y, 14, dt);
      ring.style.transform = `translate(${this.cur.rx}px, ${this.cur.ry}px) translate(-50%,-50%)`;
      lbl.style.transform = `translate(${this.cur.rx}px, ${this.cur.ry + 44}px) translate(-50%,-50%)`;
    };

    // magnetic links
    $$('[data-magnetic]').forEach((n) => {
      n.addEventListener('pointermove', (e) => {
        if (this.reduced) return;
        const b = n.getBoundingClientRect();
        const dx = e.clientX - (b.left + b.width / 2);
        const dy = e.clientY - (b.top + b.height / 2);
        n.style.transform = `translate(${dx * 0.22}px, ${dy * 0.28}px)`;
      });
      n.addEventListener('pointerleave', () => { n.style.transform = ''; });
    });
  }

  setCursorLabel(t) {
    const lbl = $('.c-lbl');
    if (lbl) lbl.textContent = t || '';
  }

  /* ── rotator ───────────────────────────────────────────────────────── */

  buildRotator() {
    const out = $('#rotator-text');
    if (!out) return;
    if (this.reduced) { out.textContent = ROTATOR[0]; return; }

    let li = 0, ci = 0, dir = 1, hold = 0;
    const tick = () => {
      const line = ROTATOR[li];
      if (hold > 0) { hold--; }
      else if (dir > 0) {
        ci++;
        if (ci >= line.length) { dir = -1; hold = 34; }
      } else {
        ci -= 2;
        if (ci <= 0) { ci = 0; dir = 1; li = (li + 1) % ROTATOR.length; hold = 6; }
      }
      out.textContent = line.slice(0, Math.max(0, ci));
      this._rot = setTimeout(tick, dir > 0 ? 42 : 20);
    };
    tick();
  }

  /* ── scroll ────────────────────────────────────────────────────────── */

  measure() {
    this.offsets = this.sections.map((s) => ({ top: s.offsetTop, h: s.offsetHeight, id: s.id }));
    this.docH = document.documentElement.scrollHeight - innerHeight;
  }

  readScroll(dt) {
    this.scrollY = scrollY;
    this.smoothY = this.reduced ? this.scrollY : damp(this.smoothY, this.scrollY, 9, dt);

    const probe = this.smoothY + innerHeight * 0.42;
    let idx = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (probe >= this.offsets[i].top) idx = i;
    }
    const o = this.offsets[idx];
    this.section = idx;
    this.local = clamp((probe - o.top) / Math.max(o.h, 1), 0, 1);
    this.progress = clamp(this.scrollY / Math.max(this.docH, 1), 0, 1);

    document.documentElement.classList.toggle('scrolled', this.scrollY > 40);

    const fill = $('#rail-fill');
    if (fill) fill.style.height = (this.progress * 100) + '%';
    this.railTicks?.forEach((t, i) => t.classList.toggle('is-on', i === idx));

    const id = o.id;
    this.navLinks?.forEach((a) => a.classList.toggle('is-current', a.getAttribute('href') === '#' + id));
  }

  /* ── HUD ───────────────────────────────────────────────────────────── */

  initHud(renderer) {
    this.hudCanvas = $('#hud-graph');
    this.hudCtx = this.hudCanvas.getContext('2d');
    this.hudHist = new Float32Array(110);
    this.hudI = 0;

    $('#hud-gpu').textContent = renderer.caps.renderer.replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 44);
    $('#hud-toggle').addEventListener('click', () => this.toggleHud());
  }

  toggleHud() {
    const on = document.documentElement.classList.toggle('hud-on');
    document.documentElement.classList.toggle('hud-off', !on);
    return on;
  }

  updateHud(renderer, ms, fps) {
    if (!document.documentElement.classList.contains('hud-on')) return;
    $('#hud-fps').textContent = fps.toFixed(0);
    $('#hud-ms').textContent = ms.toFixed(1);
    $('#hud-res').textContent = `${renderer.iw}×${renderer.ih} · ${(renderer.renderScale * 100).toFixed(0)}%`;
    $('#hud-parts').textContent = fmt(renderer.particleCount);
    $('#hud-passes').textContent = `${renderer.drawCalls} draws · ${(renderer.vramBytes() / 1048576).toFixed(0)} MB`;
    $('#hud-tier').textContent = renderer.tier.name;

    const h = this.hudHist;
    h[this.hudI % h.length] = ms;
    this.hudI++;

    const c = this.hudCtx, W = this.hudCanvas.width, H = this.hudCanvas.height;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = 'rgba(233,237,227,.10)';
    c.beginPath();
    const y16 = H - (16.7 / 40) * H;
    c.moveTo(0, y16); c.lineTo(W, y16); c.stroke();

    c.beginPath();
    for (let i = 0; i < h.length; i++) {
      const v = h[(this.hudI + i) % h.length] || 0;
      const x = (i / (h.length - 1)) * W;
      const y = H - clamp(v / 40, 0, 1) * H;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = ms > 20 ? '#E4B34E' : '#C6F24E';
    c.lineWidth = 1;
    c.stroke();
  }

  /* The physics readout. This element existed in the markup from the start
     and nothing ever wrote to it, so it rendered as an empty bordered box —
     which reads as a loading state that never finishes. */

  /* ── toast ─────────────────────────────────────────────────────────── */

  flash(html, ms = 1900) {
    const f = $('#flash');
    f.innerHTML = html;
    f.classList.add('on');
    clearTimeout(this._flash);
    this._flash = setTimeout(() => f.classList.remove('on'), ms);
  }

  boot(msg, pct) {
    const l = $('#boot-log'), b = $('.boot-bar i');
    if (l && msg) l.textContent = msg;
    if (b && pct != null) b.style.width = clamp(pct, 0, 1) * 100 + '%';
  }

  /* ── live stats ────────────────────────────────────────────────────────
     One request, no key, and the page is entirely correct if it fails —
     the numbers baked into content.js are a verified snapshot, not a guess.
     ───────────────────────────────────────────────────────────────────── */

  async refreshStats() {
    if (!LIVE_STATS) return;
    try {
      const r = await fetch(`https://api.github.com/users/${GH_USER}/repos?per_page=100&sort=updated`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return;
      const data = await r.json();
      if (!Array.isArray(data)) return;

      let stars = 0, forks = 0, own = 0;
      const byName = new Map();
      for (const repo of data) {
        if (repo.fork) continue;
        own++;
        stars += repo.stargazers_count || 0;
        forks += repo.forks_count || 0;
        byName.set(repo.name, repo);
      }
      if (!own) return;

      this.countTo($('#stat-stars'), stars);
      this.countTo($('#stat-forks'), forks);
      this.countTo($('#stat-repos'), own);

      for (const [name, repo] of byName) {
        const s = document.querySelector(`[data-stars="${CSS.escape(name)}"]`);
        const f = document.querySelector(`[data-forks="${CSS.escape(name)}"]`);
        if (s) this.countTo(s, repo.stargazers_count || 0);
        if (f) this.countTo(f, repo.forks_count || 0);
      }

      $('#stat-src').textContent = 'live';
      $('.hero-meta .live')?.classList.add('is-live');
      this.liveStars = stars;
    } catch { /* offline, rate-limited, or blocked; the snapshot stands */ }
  }

  countTo(node, to) {
    if (!node) return;
    const from = parseInt(node.textContent.replace(/\D/g, ''), 10) || 0;
    if (from === to) return;
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

export { $, $$, el, fmtShort };
