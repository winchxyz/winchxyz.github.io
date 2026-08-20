/* ══════════════════════════════════════════════════════════════════════════
   tools/audit.js: a layout auditor that runs inside the page.

   Screenshots catch what you happen to look at. This walks every element and
   measures the three things that actually go wrong in a layout:

     1. content wider than the box that holds it,
     2. anything reaching past the right edge of the viewport,
     3. two pieces of text sitting on top of each other.

   It is a dev tool. Nothing imports it, and it never ships in the page —
   the harness loads it over http and calls run().

     await import('/tools/audit.js').then(m => m.run())
   ══════════════════════════════════════════════════════════════════════════ */

/* Fixed chrome is meant to sit over the content; flagging it would bury the
   real findings. Everything else is fair game. */
const OVERLAY = '#hud, #hud-toggle, #cursor, #flash, #boot, #sheet, #nogl, #rail, #nav, #gl, #grain, #vignette';

const isOverlay = (el) => !!el.closest?.(OVERLAY);

/* Inside a deliberate horizontal scroller, being wider than the viewport is
   the entire point. Flagging those buries the real findings. */
function inScroller(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const ox = getComputedStyle(n).overflowX;
    if (ox === 'auto' || ox === 'scroll') return true;
  }
  return false;
}

const visible = (el, r) => {
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  if (parseFloat(cs.opacity) < 0.05) return false;
  return true;
};

/* An element that holds text directly, rather than one that only wraps other
   elements: those are the ones whose boxes overlapping actually means
   something. */
function isTextLeaf(el) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
  }
  return false;
}

const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);

function intersection(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

const describe = (el) => {
  const id = el.id ? '#' + el.id : '';
  const cls = typeof el.className === 'string' && el.className
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 42);
  return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
};

export function run() {
  const out = { viewport: [innerWidth, innerHeight], overflow: [], offscreen: [], overlap: [], clipped: [] };

  const docOver = document.body.scrollWidth - document.documentElement.clientWidth;
  if (docOver > 1) out.documentOverflow = docOver;

  const all = [...document.querySelectorAll('body *')].filter((el) => !isOverlay(el));

  // ── 1 & 2: boxes that cannot hold their contents, and boxes off the edge ──
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);

    // content wider than the box, with no scroller to reach it
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2 && el.clientWidth > 0 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
      out.overflow.push({ el: describe(el), by: over, box: Math.round(el.clientWidth) });
    }

    // text clipped vertically by a fixed height
    if (cs.overflowY === 'hidden' && el.scrollHeight - el.clientHeight > 2 && isTextLeaf(el)) {
      out.clipped.push({ el: describe(el), by: el.scrollHeight - el.clientHeight });
    }

    if (r.right > innerWidth + 2 || r.left < -2) {
      if (cs.position !== 'fixed' && !inScroller(el)) {
        out.offscreen.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
      }
    }
  }

  // ── 3: text sitting on text ─────────────────────────────────────────────
  /* Compared per LINE BOX, not per element.

     getBoundingClientRect() on an inline span that wraps returns the union of
     its line boxes, a rectangle covering everything from the middle of one
     line to the middle of another, including all the text in between that
     belongs to its neighbours. Comparing those unions reports every wrapped
     inline as overlapping every sibling, at frac 1.0, which is entirely an
     artifact of the measurement. getClientRects() gives the real boxes. */
  const leaves = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || !isTextLeaf(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'absolute' || pos === 'fixed') continue;   // stacked on purpose
    const rects = [...el.getClientRects()].filter((q) => q.width > 2 && q.height > 2);
    if (rects.length) leaves.push({ el, rects });
  }

  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const A = leaves[i], B = leaves[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;

      let worst = 0;
      for (const ra of A.rects) {
        for (const rb of B.rects) {
          const inter = intersection(ra, rb);
          if (inter <= 0) continue;
          worst = Math.max(worst, inter / Math.max(1, Math.min(area(ra), area(rb))));
        }
      }
      if (worst < 0.22) continue;
      out.overlap.push({ a: describe(A.el), b: describe(B.el), frac: +worst.toFixed(2) });
    }
  }

  out.counts = {
    overflow: out.overflow.length,
    offscreen: out.offscreen.length,
    overlap: out.overlap.length,
    clipped: out.clipped.length,
  };
  return out;
}

/* Every distinct text style on the page, with its computed size, so type
   can be argued about with numbers instead of adjectives. */
export function type() {
  const seen = new Map();
  for (const el of document.querySelectorAll('body *')) {
    if (isOverlay(el) || !isTextLeaf(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);
    const key = `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || '-'}`;
    if (seen.has(key)) return_or_skip: { continue; }
    seen.set(key, {
      px: +parseFloat(cs.fontSize).toFixed(1),
      weight: cs.fontWeight,
      lh: +parseFloat(cs.lineHeight).toFixed(1),
      sample: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28),
    });
  }
  return [...seen.entries()]
    .map(([k, v]) => ({ sel: k, ...v }))
    .sort((a, b) => a.px - b.px);
}

/* Walk every section first, so anything gated on scrolling into view has
   actually been laid out before it is measured. */
export async function sweep() {
  const secs = [...document.querySelectorAll('.sec')];
  for (const s of secs) {
    scrollTo({ top: s.offsetTop, behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 220));
  }
  scrollTo({ top: 0, behavior: 'auto' });
  await new Promise((r) => setTimeout(r, 260));
  return run();
}

export async function sweepType() {
  const secs = [...document.querySelectorAll('.sec')];
  const all = new Map();
  for (const s of secs) {
    scrollTo({ top: s.offsetTop, behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 200));
    for (const t of type()) if (!all.has(t.sel)) all.set(t.sel, t);
  }
  return [...all.values()].sort((a, b) => a.px - b.px);
}
