/* winchxyz.github.io. A storage-style widget on top, then one page of dark widgets by kind:
   Tools, Hermes plugins, Visual tools, then games and experiments. The LED bar is the only LED
   on the page. It shows every project, sorted the same way as the list below it: by category,
   by stars or by language. The previews are the real screenshots. Data: assets/winch.js. */
(() => {
  'use strict';
  const W = window.WINCH, LED = window.LED, ICON = window.ICON;
  /* ?card and ?card=hero turn the page into a still picture for tools/share.mjs */
  const CARD = new URLSearchParams(location.search).get('card');
  if (CARD !== null) document.documentElement.classList.add('card', ...(CARD ? [`card-${CARD}`] : []));
  const LIVE = CARD === null; // the live page moves; a card is a still picture
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  /* ---------- data ---------- */
  const KINDS = W.sections; // tools, then the Hermes plugins, then the visual tools, then games and experiments
  const TOOL_KINDS = new Set(['tools', 'hermes', 'visual']);
  const ALL = [];
  KINDS.forEach((s, k) => s.items.forEach(it => ALL.push(Object.assign({}, it, { k, kind: s, tool: TOOL_KINDS.has(s.id), also: s.id === 'also', n: ALL.length }))));
  const BYID = Object.fromEntries(ALL.map(it => [it.id, it]));
  const N_TOOLS = ALL.filter(i => i.tool).length, N_REST = ALL.length - N_TOOLS;
  const STARS = W.stats.find(s => /stars/.test(s[1]))?.[0];
  const REPOS = W.stats.find(s => /repos/.test(s[1]))?.[0];
  const starsOf = list => list.reduce((a, i) => a + (i.stars || 0), 0);
  const byStars = (a, b) => (b.stars || 0) - (a.stars || 0) || (b.tool - a.tool) || a.n - b.n;

  /* GitHub's language colours, moved to the nearest colour of the LED palette */
  const LANG = { JavaScript: 'yellow', HTML: 'orange', Python: 'blue', TypeScript: 'cyan', CSS: 'purple', Shell: 'green', PowerShell: 'magenta' };
  const langColor = l => LANG[l] || 'grey';
  const hex = c => ICON.COLORS[c] || c;
  const kindIcon = (s, size = 20) => ICON.cat(s.icon, s.color, size);
  const langIcon = (l, size = 20) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="4" y="4" width="12" height="12" rx="3.5" fill="${hex(langColor(l))}"/></svg>`;

  const NOTE = {
    tools: 'For Claude Code and agents, X, video and 3D printing.',
    hermes: 'All four are in the official Hermes Agent plugin catalog.',
    visual: 'They run in your browser. Your pictures are not uploaded.',
    games: 'Most have no asset files: every mesh, texture and sound is made in code.',
    also: 'Graphics, sims and one-offs.',
  };

  /* ---------- the three ways to sort ---------- */
  let toolsOnly = false;
  const visible = it => !toolsOnly || it.tool;
  const shownOf = list => list.filter(visible);

  const KIND_ROWS = KINDS.map((s, k) => ({ key: s.id, title: s.id === 'games' ? 'Games' : s.title, color: s.color, icon: kindIcon(s), items: ALL.filter(i => i.k === k) }));
  const LANG_ROWS = (() => {
    const by = new Map();
    ALL.forEach(i => { const l = i.lang || 'Other'; if (!by.has(l)) by.set(l, []); by.get(l).push(i); });
    return [...by].map(([l, items]) => ({ key: l, title: l, color: langColor(l), icon: langIcon(l), items: items.sort(byStars) }))
      .sort((a, b) => b.items.length - a.items.length || starsOf(b.items) - starsOf(a.items));
  })();
  const LANG_INDEX = new Map(LANG_ROWS.map((r, q) => [r.key, q]));

  const VIEWS = {
    category: {
      name: 'category', rows: KIND_ROWS,
      order: KIND_ROWS.flatMap(r => r.items),
      rowOf: i => i.k, segOf: i => i.k,
      note: r => NOTE[r.key] || '',
      idle() { return sRow(this.rows[0]); },
      done: () => toolsOnly ? `${N_TOOLS} tools. The games are hidden, not gone.` : `${ALL.length} projects in ${REPOS} repos. ${STARS} stars on GitHub.`,
    },
    stars: {
      name: 'stars', rows: KIND_ROWS,
      order: ALL.slice().sort(byStars),
      rowOf: i => i.k, segOf: i => i.k,
      weight: i => i.stars || 0,
      note: r => `${starsOf(shownOf(r.items))} stars on GitHub`,
      idle() { const l = shownOf(this.order); return `${ICON.star(18)}<span>${starsOf(l)} stars on GitHub</span><span class="n">${esc(l[0].name)} has the most, ${l[0].stars}.</span>`; },
      done() { const t = shownOf(this.order)[0]; return `Sorted by stars. ${t.name} leads with ${t.stars}.`; },
    },
    language: {
      name: 'language', rows: LANG_ROWS,
      order: LANG_ROWS.flatMap(r => r.items),
      rowOf: i => LANG_INDEX.get(i.lang || 'Other'), segOf: i => i.lang || 'Other',
      note: r => { const l = shownOf(r.items); return `${plural(l.length, 'project', 'projects')}, ${starsOf(l)} stars`; },
      idle() { return sRow(this.rows.find(r => shownOf(r.items).length) || this.rows[0]); },
      done() {
        const rows = this.rows.map(r => [r, shownOf(r.items).length]).filter(x => x[1]).sort((a, b) => b[1] - a[1]);
        return `Sorted by language: ${rows.length} languages, mostly ${rows[0][0].title}.`;
      },
    },
  };
  let view = 'category';
  let V = VIEWS.category;  // what the list and the legend show
  let BV = V;              // what the bar shows; it follows V once the bar has been cleared

  /* ---------- status line, tip ---------- */
  const status = $('#status'), tip = $('#tip'), act = $('#act');
  function sRow(r) { return `${r.icon}<span>${esc(r.title)}</span><span class="v">${shownOf(r.items).length}</span><span class="n">${esc(V.note(r))}</span>`; }
  const sItem = it => `${BV.rows[BV.rowOf(it)].icon}<span>${esc(it.name)}</span>${it.stars ? `<span class="v">${it.stars} ★</span>` : ''}<span class="n">${esc(it.short)}</span>`;
  const sScan = repo => `<span>Scanning</span><span class="mono">~/winchxyz/${esc(repo)}</span>`;
  const sOk = text => `<span class="ok">${ICON.check(18)}${esc(text)}</span>`;
  let statusHold = 0;
  /* fade: the line rises in. For lines that end something, not for hover, which follows the pointer */
  const setStatus = (html, hold = 0, fade = false) => {
    status.innerHTML = html; statusHold = hold ? performance.now() + hold : 0;
    if (fade && LIVE) { status.classList.remove('in'); void status.offsetWidth; status.classList.add('in'); }
  };
  /* a message shown for a while (hold) gives way to the view's own line when it runs out */
  const idleStatus = () => { if (statusHold && performance.now() > statusHold && hoverQ < 0 && hoverItem < 0) setStatus(V.idle(), 0, true); };

  const TIP_ALL = `${ICON.cat('pad', 'purple', 20)}<span>Games and experiments are half of what is here. Tools come first now.</span>`;
  const TIP_TOOLS = `${ICON.cat('wrench', 'green', 20)}<span>Showing the ${N_TOOLS} tools. The games are hidden, not gone.</span>`;

  /* ---------- legend ---------- */
  const legend = $('#legend');
  let legendRows = [];
  function renderLegend() {
    legend.textContent = '';
    legendRows = V.rows.map((r, q) => {
      const short = r.key === 'hermes' ? 'Hermes' : r.title; // phones show the short name
      const b = h('button', 'lg', `${r.icon}<span class="t"><span class="full">${esc(r.title)}</span><span class="short">${esc(short)}</span></span><span class="v">${r.items.length}</span>`);
      b.type = 'button'; b.setAttribute('role', 'listitem');
      const on = () => hoverRow(q), off = () => hoverRow(-1);
      b.addEventListener('mouseenter', on); b.addEventListener('focus', on);
      b.addEventListener('mouseleave', off); b.addEventListener('blur', off);
      b.addEventListener('click', () => goRow(q));
      legend.append(b);
      return b;
    });
    dimLegend();
  }
  const dimLegend = () => legendRows.forEach((b, q) => {
    const n = shownOf(V.rows[q].items).length;
    b.classList.toggle('off', !n);
    b.querySelector('.v').textContent = n || V.rows[q].items.length;
  });

  /* ---------- the list ---------- */
  /* category view: hand-placed sizes, S small, W wide, L large, packed four across */
  const BENTO = {
    tools: [['loupe', 'L'], ['follower-sweep', 'W'], ['idea-to-build', 'S'], ['draft-desk', 'S'], ['x-ghostwriter', 'S'], ['crunch-time', 'S'], ['motion-studio', 'S'], ['mc-print-3d', 'S']],
    hermes: [['hermes-ghost-call', 'W'], ['hermes-x-bookmarks', 'L'], ['hermes-phone', 'S'], ['hermes-blueprint', 'S']],
    visual: [['afterglyph', 'L'], ['nightgrain', 'S'], ['spiralist', 'S'], ['typist', 'S'], ['pasteup', 'S'], ['mosaiz', 'W'], ['seedplot', 'S'], ['platen', 'S']],
  };

  function preview(it) {
    if (it.img) return `<figure class="pv"><img src="${it.img}" alt="" loading="lazy" decoding="async"></figure>`;
    if (it.id === 'draft-desk') return '<figure class="pv flow"><ol><li><b>Grok</b> researches X</li><li><b>Claude</b> drafts</li><li><b>Telegram</b> asks you</li></ol></figure>';
    return `<figure class="pv none">${kindIcon(it.kind, 34)}</figure>`;
  }

  function card(it, size = 'S') {
    const s = it.kind, el = h('article', `wg ${size} rv`);
    el.id = it.id;
    el.style.setProperty('--kind', hex(s.color));
    const main = it.live || it.code;
    const cover = `<a class="cover" href="${main}" target="_blank" rel="noopener" aria-label="${esc(`${it.label} ${it.name}`)}"></a>`;
    const head = `<header class="wh">${kindIcon(s, 18)}<h3>${esc(it.name)}</h3>${it.stars ? `<span class="v" aria-label="${it.stars} stars on GitHub">${ICON.star(11)}${it.stars}</span>` : ''}</header>`;
    const ws = `<p class="ws">${esc(it.short)}</p>`;
    const wd = size === 'S' ? '' : `<p class="wd">${esc(it.line)}</p>`;
    const lang = `<span class="lang">${it.lang ? `<i style="background:${hex(langColor(it.lang))}"></i>${esc(it.lang)}` : ''}</span>`;
    const code = it.live ? `<a class="code" href="${it.code}" target="_blank" rel="noopener">Code</a>` : '';
    const btn = `<a class="btn" href="${main}" target="_blank" rel="noopener">${esc(it.label)}${ICON.arrow(12)}</a>`;
    /* on a phone a small widget becomes a tile: its stars move down beside the language */
    const sv = size === 'S' && it.stars ? `<span class="sv" aria-label="${it.stars} stars on GitHub">${ICON.star(10)}${it.stars}</span>` : '';
    /* a wide widget's text column is narrow: its language gets a line of its own */
    el.innerHTML = size === 'W'
      ? `${cover}<div class="wl">${head}${ws}${wd}<p class="wm">${lang}</p><footer class="wf">${code}${btn}</footer></div>${preview(it)}`
      : `${cover}${head}${ws}${preview(it)}${wd}<footer class="wf">${lang}${sv}${code}${btn}</footer>`;
    return el;
  }

  const root = $('#groups');
  function section(id, icon, title, n, line) {
    const sec = h('section', 'group');
    sec.id = id;
    sec.innerHTML = `<div class="gh rv"><h2>${icon}${esc(title)}<span class="n">${n}</span></h2><p>${esc(line)}</p></div>`;
    root.append(sec);
    return sec;
  }
  function grid(sec, list) {
    const g = h('div', 'grid');
    list.forEach(([it, size]) => g.append(card(it, size)));
    sec.append(g);
  }

  function games() {
    const gs = KINDS.find(s => s.id === 'games'), al = KINDS.find(s => s.id === 'also');
    if (!gs) return;
    const sec = section('k-games', kindIcon(gs, 22), gs.title, gs.items.length + (al ? al.items.length : 0), gs.line);
    const box = h('div', 'widget games rv');
    const tile = it => `<a class="gm" id="${it.id}" style="--kind:${hex(gs.color)}" href="${it.live || it.code}" target="_blank" rel="noopener"><span class="th">${it.img ? `<img src="${it.img}" alt="" loading="lazy" decoding="async">` : ''}</span><b><span class="nm">${esc(it.name)}</span>${it.stars ? `<span class="v">${ICON.star(10)}${it.stars}</span>` : ''}</b><span>${esc(it.short)}</span></a>`;
    box.innerHTML = `<div class="gr">${gs.items.map(tile).join('')}</div>`
      + (al ? `<p class="also" id="k-also"><b>${esc(al.title)}</b>${al.items.map(it => `<a id="${it.id}" style="--kind:${hex(al.color)}" href="${it.live || it.code}" target="_blank" rel="noopener" title="${esc(it.short)}">${esc(it.name)}</a>`).join(' · ')}</p>` : '');
    sec.append(box);
  }

  function renderList() {
    root.textContent = '';
    if (view === 'category') {
      KINDS.filter(s => TOOL_KINDS.has(s.id)).forEach(s => {
        const plan = (BENTO[s.id] || []).filter(([id]) => BYID[id]);
        s.items.forEach(it => { if (!plan.some(([id]) => id === it.id)) plan.push([it.id, 'S']); });
        grid(section(`k-${s.id}`, kindIcon(s, 22), s.title, s.items.length, s.line), plan.map(([id, size]) => [BYID[id], size]));
      });
      if (!toolsOnly) games();
    } else if (view === 'stars') {
      const list = shownOf(V.order);
      grid(section('k-all', ICON.star(20), toolsOnly ? 'All tools' : 'All projects', list.length, `Sorted by stars on GitHub, ${starsOf(list)} in total.`), list.map(it => [it, 'S']));
    } else {
      V.rows.forEach(r => {
        const list = shownOf(r.items);
        if (!list.length) return;
        grid(section(`l-${slug(r.key)}`, r.icon, r.title, list.length, `${plural(list.length, 'project', 'projects')}, ${starsOf(list)} stars on GitHub.`), list.map(it => [it, 'S']));
      });
    }
    settle();
  }

  /* ---------- arrival: the cards rise as they come into view, the pictures fade in once loaded ---------- */
  const RISE = LIVE && 'IntersectionObserver' in window;
  if (RISE) document.documentElement.classList.add('rise');
  let armed = false;
  const riser = RISE ? new IntersectionObserver(es => {
    /* the ones that came into view together go top to bottom, left to right, a beat apart */
    const ins = es.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
    ins.forEach((e, k) => { e.target.style.setProperty('--d', `${Math.min(k, 8) * 60}ms`); e.target.classList.add('in'); riser.unobserve(e.target); });
  }, { rootMargin: '0px 0px -5% 0px' }) : null;
  function settle() {
    $$('img', root).forEach(i => { if (i.complete && i.naturalWidth) i.classList.add('ld'); });
    if (riser && armed) $$('.rv:not(.in)', root).forEach(el => riser.observe(el));
  }
  const arm = () => { if (!armed) { armed = true; settle(); } };
  root.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
  /* once risen, an element is plain again, so a later flash or hover starts from rest */
  root.addEventListener('animationend', e => { if (e.animationName === 'rise') e.target.classList.remove('rv', 'in'); });

  let swapT = 0;
  function renderListSoft(keepTop) {
    clearTimeout(swapT);
    root.classList.add('swap');
    swapT = setTimeout(() => {
      renderList();
      if (keepTop) {
        const y = root.getBoundingClientRect().top + scrollY - sortbar.offsetHeight - 8;
        if (scrollY > y) scrollTo({ top: y });
      }
      requestAnimationFrame(() => root.classList.remove('swap'));
    }, 170);
  }

  /* go to a project's card and light it up */
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  function go(id, smooth = true) {
    const el = document.getElementById(id);
    if (!el) return false;
    /* a card that has not risen yet shows at once */
    const rv = el.closest('.rv');
    if (rv && !rv.classList.contains('in')) { rv.style.setProperty('--d', '0ms'); rv.classList.add('in'); if (riser) riser.unobserve(rv); }
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    flash(el);
    return true;
  }
  function goRow(q) {
    const r = V.rows[q];
    if (view === 'stars') {
      const list = shownOf(V.order).filter(i => i.k === q);
      if (!list.length) return;
      go(list[0].id);
      list.slice(1).forEach(i => { const e = document.getElementById(i.id); if (e) flash(e); });
      return;
    }
    const el = document.getElementById(view === 'category' ? `k-${r.key}` : `l-${slug(r.key)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- the LED bar ---------- */
  const bar = $('#bar'), cv = $('#led'), count = $('#count'), unit = $('#unit'), of = $('#of'), rescanBtn = $('#rescan');
  rescanBtn.querySelector('.ri').outerHTML = ICON.rescan(19);
  of.textContent = ` and ${N_REST} games and experiments`;
  const MT = 18, MB = 5, MS = 5; // canvas margins around the bar, in cells
  let ROWS = 24;

  const hash = (x, y) => { let q = (x * 374761393 + y * 668265263) | 0; q = Math.imul(q ^ (q >>> 13), 1274126177); return ((q ^ (q >>> 16)) >>> 0) / 4294967295; };
  const sm = t => t * t * (3 - 2 * t);
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  function allocate(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return allocate(total, weights.map(() => 1));
    const raw = weights.map(w => w / sum * total), out = raw.map(Math.floor);
    const left = total - out.reduce((a, b) => a + b, 0);
    raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => out[i]++);
    return out;
  }

  let m = null, P = 4.5, barCols = 0, off = 0;
  let order = [], colItem = new Int16Array(0), colSeg = [], itemStart = new Int16Array(0), itemEnd = new Int16Array(0);
  let shown = new Uint8Array(0), rowFirst = [];
  let hoverQ = -1, hoverItem = -1, busy = false;
  let scanCol = -1, scanA = 0, anim = null, animStop = null, GEN = 0;

  function layout() {
    const narrow = innerWidth < 760;
    P = LED.snap(narrow ? 3.5 : 4.5);
    ROWS = narrow ? 22 : 24;
    const bw = bar.clientWidth;
    barCols = Math.max(40, Math.floor(bw / P));
    off = (bw - barCols * P) / 2;
    bar.style.height = `${ROWS * P}px`;
    cv.style.left = `${off - MS * P}px`;
    cv.style.top = `${-MT * P}px`;
    /* live, the dots breathe: the few near their threshold fade in and out, slowly. A card stays still */
    const opts = { pitch: P, rows: ROWS + MT + MB, cols: barCols + 2 * MS, off: null, tint: 0.24, fill: 0.1, noise: 0.16, glow: 0.42, focusDim: 0.22, boost: 0.4,
      shimmer: LIVE ? 0.06 : 0, soft: LIVE ? 0.07 : 0, flicker: LIVE ? 0.12 : 0 };
    if (!m) { m = new LED.Matrix(cv, opts); m.after = drawOver; m.before = step; }
    else { Object.assign(m.o, opts); m.resize(); }
    allot();
  }

  /* columns per project for the bar's view: equal, or by stars with a floor so every project shows */
  function allot() {
    BV = V;
    order = BV.order;
    const n = order.length;
    let cols;
    if (BV.weight) {
      const min = Math.max(1, Math.min(2, Math.floor(barCols / n / 2)));
      cols = allocate(barCols - min * n, order.map(BV.weight)).map(c => c + min);
    } else cols = allocate(barCols, order.map(() => 1));
    colItem = new Int16Array(barCols); colSeg = new Array(barCols);
    itemStart = new Int16Array(n); itemEnd = new Int16Array(n);
    let c = 0;
    order.forEach((it, j) => {
      itemStart[j] = c;
      const key = BV.segOf(it);
      for (let q = 0; q < cols[j]; q++, c++) { colItem[c] = j; colSeg[c] = key; }
      itemEnd[j] = c;
    });
    shown = new Uint8Array(barCols);
    /* the first column of each legend row, so the legend can light up as the scan reaches it */
    rowFirst = BV.rows.map(() => barCols);
    order.forEach((it, j) => { const q = BV.rowOf(it); rowFirst[q] = Math.min(rowFirst[q], itemStart[j]); });
  }

  const cellOf = (bc, r) => m.idx(MS + bc, MT + r);
  const want = bc => visible(order[colItem[bc]]);
  function base(bc, r) {
    const it = order[colItem[bc]], q = BV.rowOf(it);
    if (r === ROWS - 1) return it.also ? 0.2 : 0.85;
    if (it.also) return 0.06 + 0.14 * vnoise(bc * 0.3 + 40, r * 0.35);
    const g = 1 - r / (ROWS - 1);
    return 0.17 + 0.12 * g + 0.3 * (vnoise(bc * 0.16 + q * 9.7, r * 0.2) - 0.5) + 0.08 * (vnoise(bc * 0.6 + 3, r * 0.6 + q) - 0.5);
  }
  function setTrack(bc) {
    shown[bc] = 0;
    for (let r = 0; r < ROWS; r++) m.set(cellOf(bc, r), 'grey', 0, -1, 0.075, 0);
  }
  function setShown(bc, flashAmt = 0) {
    shown[bc] = 1;
    const j = colItem[bc], it = order[j], q = BV.rowOf(it), color = BV.rows[q].color;
    for (let r = 0; r < ROWS; r++) {
      const i = cellOf(bc, r), lv = base(bc, r) + (j === hoverItem ? 0.3 : 0);
      const tint = r === 0 ? (it.also ? 0.3 : 0.75) : it.also ? 0.15 : -1, fill = it.also ? 0.035 : -1;
      m.set(i, color, Math.min(1, lv), q, tint, fill);
      if (flashAmt) { m.cur[i] = Math.min(1, lv + 0.35); if (Math.random() < flashAmt) m.hot[i] = 0.5 + Math.random() * 0.5; }
    }
  }
  function relevel(j) { if (j < 0 || j >= order.length) return; for (let bc = itemStart[j]; bc < itemEnd[j]; bc++) if (shown[bc]) setShown(bc); }
  function fillAll() { for (let bc = 0; bc < barCols; bc++) want(bc) ? setShown(bc) : setTrack(bc); }

  /* drawn over the dots each frame: the free-space frame, the segment outlines, the scan line */
  function drawOver(ctx, mm) {
    LED.drawTrack(ctx, mm, MS, MS + barCols, MT, MT + ROWS, { left: true, radius: 7 });
    let run = [];
    const flush = () => {
      if (!run.length) return;
      run[run.length - 1].end = true;
      LED.drawSegments(ctx, mm, run, MT, MT + ROWS, { radius: 7, sep: 0.55 });
      run = [];
    };
    for (let c = 0; c < barCols;) {
      if (!shown[c]) { flush(); c++; continue; }
      const key = colSeg[c];
      let c1 = c + 1;
      while (c1 < barCols && shown[c1] && colSeg[c1] === key) c1++;
      const it = order[colItem[c]], q = BV.rowOf(it), focus = hoverQ < 0 || hoverQ === q;
      run.push({ c0: MS + c, c1: MS + c1, color: BV.rows[q].color, a: (it.also ? 0.4 : 1) * (focus ? 1 : 0.5), glow: (hoverQ === q ? 1.8 : it.also ? 0.4 : 1) * neon(mm, q, c, c1) });
      c = c1;
    }
    flush();
    if (scanA > 0 && scanCol >= 0) LED.drawScan(ctx, mm, MS + scanCol, MT, MT + ROWS, scanA);
  }
  /* live, each segment's glow breathes slowly on its own, and flares while a glint crosses it */
  function neon(mm, q, c0, c1) {
    if (!LIVE) return 1;
    let k = 0.84 + 0.32 * vnoise(mm.t * 0.5 + q * 5.3, q * 1.7 + 0.5);
    const g = mm.glint;
    if (g) {
      const x = g.x + g.k * ROWS / 2 - MS, d = Math.max(0, c0 - x, x - c1) / (g.w * 2.5);
      k += 0.8 * Math.exp(-d * d);
    }
    return k;
  }

  /* per frame: run the current animation. When idle, a dot twinkles every few frames, and now and
     then a glint of light runs along the bar; every scan ends with one */
  const GLINT_MS = 2400;
  let sparkT = 0, glintT = 0, glintAt = 4, glint0 = -1;
  function twinkle(mm) {
    for (let k = 0; k < 8; k++) {
      const bc = (Math.random() * barCols) | 0;
      if (!shown[bc]) continue;
      const i = cellOf(bc, (Math.random() * (ROWS - 1)) | 0);
      if (mm.cur[i] > 0.2) { mm.hot[i] = Math.max(mm.hot[i], 0.75 + Math.random() * 0.25); return; }
    }
  }
  function step(mm, dt) {
    const now = performance.now();
    if (anim) anim(now);
    if (!busy) {
      idleStatus();
      if (LIVE) {
        sparkT += dt;
        if (sparkT > 0.13) { sparkT = 0; twinkle(mm); }
        glintT += dt;
        if (glint0 < 0 && glintT > glintAt && hoverItem < 0 && hoverQ < 0) { glint0 = now; glintT = 0; glintAt = 7 + Math.random() * 4; }
      }
    }
    /* a glint that has started runs to its end, even if a scan begins meanwhile */
    if (glint0 >= 0) {
      const k = (now - glint0) / GLINT_MS;
      if (k >= 1) { glint0 = -1; mm.glint = null; }
      else {
        /* a band leaning like "/", from wholly left of the bar to wholly right of it */
        const w = 5, slant = -0.55, x0 = MS - 3 * w, x1 = MS + barCols + 3 * w - slant * (ROWS - 1);
        mm.glint = { x: x0 + (x1 - x0) * (1 - Math.cos(Math.PI * k)) / 2, k: slant, w, a: 0.3, r0: MT };
      }
    }
  }

  const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  /* one bar animation at a time; a newer action cuts the running one short */
  function animate(fn, ms) {
    return new Promise(res => {
      const t0 = performance.now();
      const end = () => { anim = null; animStop = null; scanA = 0; res(); };
      animStop = end;
      anim = now => { const k = Math.min(1, (now - t0) / ms); fn(k); if (k >= 1) end(); };
    });
  }
  const cut = () => { if (animStop) animStop(); };

  /* scan columns [from, to) into view, left to right */
  function scanIn(from, to, ms, counting = false) {
    let done = from;
    return animate(k => {
      const x = from + (to - from) * easeIO(k);
      for (; done < Math.min(to, Math.floor(x)); done++) if (want(done) && !shown[done]) setShown(done, 0.18);
      scanCol = x; scanA = k < 1 ? 1 : 0;
      const bc = Math.min(barCols - 1, Math.max(0, Math.floor(x)));
      const it = order[colItem[bc]];
      if (k < 1 && it && visible(it)) setStatus(sScan(it.repo));
      if (counting) {
        let tools = 0;
        for (let j = 0; j < order.length; j++) if (order[j].tool && itemStart[j] < x) tools++;
        const n = Math.max(Number(count.textContent) || 0, tools);
        count.textContent = n;
        unit.textContent = n === 1 ? ' tool' : ' tools';
        if (!toolsOnly && it && !it.tool) of.classList.remove('gone');
        legendRows.forEach((b, q) => { if (rowFirst[q] < x) b.classList.remove('wait'); });
      }
    }, ms);
  }
  /* scan in the wanted columns that are not showing yet */
  function fillIn(ms) {
    let lo = barCols, hi = -1;
    for (let bc = 0; bc < barCols; bc++) if (!shown[bc] && want(bc)) { lo = Math.min(lo, bc); hi = bc; }
    return hi < 0 ? Promise.resolve() : scanIn(lo, hi + 1, ms);
  }
  /* clear the columns that pass pred, right to left, sending their dots up */
  function clearOut(pred, ms, keep = 0.42) {
    let lo = barCols, hi = -1;
    for (let bc = 0; bc < barCols; bc++) if (shown[bc] && pred(bc)) { lo = Math.min(lo, bc); hi = bc; }
    if (hi < 0) return Promise.resolve();
    const from = lo, to = hi + 1;
    let done = to;
    return animate(k => {
      const x = to - (to - from) * easeIO(k);
      for (; done > Math.max(from, Math.ceil(x)); done--) {
        const bc = done - 1;
        if (!shown[bc] || !pred(bc)) continue;
        const cells = [];
        for (let r = 0; r < ROWS; r++) cells.push(cellOf(bc, r));
        m.burst(cells, { keep, vy: 105, vx: 16, life: 1.25, clear: false });
        setTrack(bc);
      }
      scanCol = x; scanA = k < 1 ? 1 : 0;
    }, ms);
  }

  function begin() {
    GEN++; cut();
    busy = true; rescanBtn.disabled = true; rescanBtn.classList.add('spin');
    if (hoverItem >= 0) { const p = hoverItem; hoverItem = -1; relevel(p); bar.classList.remove('link'); }
    hoverQ = -1; if (m) m.focus(-1);
    legendRows.forEach(b => b.classList.remove('on'));
    return GEN;
  }
  function finish(text, hold) {
    busy = false; rescanBtn.disabled = false; rescanBtn.classList.remove('spin');
    count.textContent = String(N_TOOLS);
    unit.textContent = N_TOOLS === 1 ? ' tool' : ' tools';
    of.classList.toggle('gone', toolsOnly);
    legendRows.forEach(b => b.classList.remove('wait'));
    setStatus(sOk(text), hold, true);
    glintT = 0; glintAt = 0.45; // every scan ends with a glint
  }

  async function intro() {
    const gen = begin();
    for (let bc = 0; bc < barCols; bc++) setTrack(bc);
    count.textContent = '0';
    of.classList.add('gone');
    legendRows.forEach(b => b.classList.add('wait')); // each row lights as the scan reaches it
    await LED.wait(250); if (gen !== GEN) return;
    await scanIn(0, barCols, toolsOnly ? 1600 : 2600, true); if (gen !== GEN) return;
    finish(V.done(), 2600);
  }

  async function toggle() {
    const gen = begin();
    toolsOnly = !toolsOnly;
    act.textContent = toolsOnly ? 'Show everything' : 'Show tools only';
    tip.innerHTML = toolsOnly ? TIP_TOOLS : TIP_ALL;
    dimLegend();
    renderListSoft(false);
    if (toolsOnly) {
      setStatus('<span>Hiding</span><span class="mono">~/winchxyz/games</span>');
      of.classList.add('gone');
      await clearOut(bc => !want(bc), 1300); if (gen !== GEN) return;
      await LED.wait(300); if (gen !== GEN) return;
      finish(`Showing ${N_TOOLS} tools. ${N_REST} games and experiments hidden.`, 3200);
    } else {
      of.classList.remove('gone');
      await fillIn(1500); if (gen !== GEN) return;
      finish(`All ${ALL.length} projects are back.`, 2400);
    }
  }

  const seg = $('#seg'), sortbar = $('#sortbar');
  /* a hairline under the sort bar once it sticks */
  new IntersectionObserver(([e]) => sortbar.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 0)).observe($('#sortsent'));
  /* a white thumb slides to the chosen button */
  const thumb = h('span', 'thumb');
  thumb.setAttribute('aria-hidden', 'true');
  seg.append(thumb);
  function moveThumb(smooth = true) {
    const b = $(`button[data-v="${view}"]`, seg);
    if (!b || !b.offsetWidth) return;
    if (!smooth) seg.classList.add('still');
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
    seg.classList.add('slid');
    if (!smooth) { void thumb.offsetWidth; seg.classList.remove('still'); }
  }
  new ResizeObserver(() => moveThumb(false)).observe(seg);
  const markSeg = () => { $$('button', seg).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === view))); moveThumb(); };
  async function sortBy(name) {
    if (!VIEWS[name] || name === view) return;
    const gen = begin();
    view = name; V = VIEWS[name];
    markSeg();
    renderLegend();
    renderListSoft(true);
    setStatus(`<span>Sorting by</span><span class="mono">${esc(name)}</span>`);
    await clearOut(() => true, 650, 0.22); if (gen !== GEN) return;
    allot();
    for (let bc = 0; bc < barCols; bc++) setTrack(bc);
    await LED.wait(120); if (gen !== GEN) return;
    await scanIn(0, barCols, 1500); if (gen !== GEN) return;
    finish(V.done(), 3000);
  }
  $$('button', seg).forEach(b => b.addEventListener('click', () => sortBy(b.dataset.v)));

  /* ---------- hover and click ---------- */
  function hoverRow(q) {
    if (busy && q >= 0) return;
    hoverQ = q;
    if (m) m.focus(q);
    legendRows.forEach((b, i) => b.classList.toggle('on', i === q));
    if (q >= 0) setStatus(sRow(V.rows[q]));
    else if (!busy && !statusHold) setStatus(V.idle());
  }
  function hoverAt(x) {
    if (busy || !m) return;
    const bc = Math.floor((x - off) / P);
    if (bc < 0 || bc >= barCols || !shown[bc]) { leave(); return; }
    const j = colItem[bc];
    if (j === hoverItem) return;
    const prev = hoverItem;
    hoverItem = j; relevel(prev); relevel(j);
    const it = order[j], q = BV.rowOf(it);
    hoverQ = q; m.focus(q);
    legendRows.forEach((b, i) => b.classList.toggle('on', i === q));
    setStatus(sItem(it));
    bar.href = `#${it.id}`; bar.classList.add('link');
    bar.setAttribute('aria-label', `Go to ${it.name}`);
  }
  function leave() {
    if (hoverItem < 0) return;
    const prev = hoverItem; hoverItem = -1; relevel(prev);
    bar.classList.remove('link');
    hoverRow(-1);
  }
  bar.addEventListener('pointermove', e => hoverAt(e.clientX - bar.getBoundingClientRect().left));
  bar.addEventListener('pointerdown', e => hoverAt(e.clientX - bar.getBoundingClientRect().left));
  bar.addEventListener('pointerleave', leave);
  bar.addEventListener('click', e => { e.preventDefault(); if (hoverItem >= 0) go(order[hoverItem].id); });

  rescanBtn.addEventListener('click', () => { if (!busy) intro(); });
  act.addEventListener('click', toggle);

  /* ---------- start ---------- */
  tip.innerHTML = TIP_ALL;
  renderLegend();
  if (LIVE) { // until the first scan: the legend dim, the games line hidden
    legendRows.forEach(b => b.classList.add('wait'));
    of.classList.add('gone');
  }
  renderList();
  layout();
  for (let bc = 0; bc < barCols; bc++) setTrack(bc);
  LED.run(bar, t => m.frame(t));
  let lastW = bar.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(bar.clientWidth - lastW) < 1) return;
    lastW = bar.clientWidth;
    const was = busy;
    GEN++; cut();
    busy = false; rescanBtn.disabled = false; rescanBtn.classList.remove('spin');
    layout(); fillAll();
    if (was) finish(V.done(), 2000);
  }).observe(bar);

  /* #project opens the page at that project's card */
  const deep = decodeURIComponent(location.hash.slice(1));
  if (deep && BYID[deep]) requestAnimationFrame(() => go(deep, false));

  const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
  if (LIVE) {
    /* the page arrives: the headline, the widget and the sort bar rise in (site.css, html.ready),
       the scan starts as the widget settles, and the cards rise as they come into view */
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      document.documentElement.classList.add('ready');
      setTimeout(arm, 260);
      setTimeout(intro, 380);
    };
    fontsReady.then(start);
    setTimeout(start, 3000); // in case the fonts never report
  } else fontsReady.then(() => {
    /* the whole bar, lit and still: no scan, no sparkle, no hover */
    layout(); fillAll();
    busy = true;
    count.textContent = String(N_TOOLS);
    setStatus(sOk(V.done()));
    setTimeout(() => { window.__ready = true; }, 1600);
  });
})();
