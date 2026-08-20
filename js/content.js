/* ══════════════════════════════════════════════════════════════════════════
   content.js — everything the page says.

   The repo numbers are a verified snapshot (2026-08-20). At runtime the page
   tries the public GitHub API once and upgrades them if it answers; if it is
   rate-limited, offline, or blocked, nothing breaks and the snapshot stands.
   Set LIVE_STATS = false to make the page never touch the network at all.
   ══════════════════════════════════════════════════════════════════════════ */

export const LIVE_STATS = true;
export const GH_USER = 'winchxyz';

export const SNAPSHOT_DATE = '2026-08-20';

/* ── typing line under the wordmark ────────────────────────────────────── */

export const ROTATOR = [
  'Real-time graphics and AI dev tools',
  'Shaders on one end, agents on the other',
  'Local-first. Open source. Nothing hidden.',
  'Built because I wanted it to exist',
];

/* ── projects ──────────────────────────────────────────────────────────── */

export const LANG_COLOR = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  HTML:       '#e34c26',
  CSS:        '#663399',
  Shell:      '#89e051',
  PowerShell: '#012456',
  GLSL:       '#5686a5',
};

export const REPOS = [
  {
    name: 'moon-rover',
    group: 'graphics',
    desc: 'A 3D lunar rover survey game. WebGL2, no build step, no third-party assets — every texture and every sound is generated at runtime.',
    lang: 'JavaScript',
    stars: 97, forks: 21,
    tags: ['WebGL2', 'procedural-audio', 'zero-assets', 'gamedev'],
    url: 'https://github.com/winchxyz/moon-rover',
  },
  {
    name: 'tidewright',
    group: 'graphics',
    desc: 'A 3D sandcastle simulator that runs entirely on the GPU. No engine, no libraries, no asset files — and a beach that actually obeys the angle of repose.',
    lang: 'JavaScript',
    stars: 72, forks: 21,
    tags: ['WebGL2', 'GLSL', 'zero-deps', 'one-prompt'],
    url: 'https://github.com/winchxyz/tidewright',
    live: 'https://winchxyz.github.io/tidewright/',
  },
  {
    name: 'bikini-bottom',
    group: 'graphics',
    desc: 'A whole cartoon town generated from a seed string and rendered with a hand-written cel-shading pipeline.',
    lang: 'JavaScript',
    stars: 16, forks: 2,
    tags: ['cel-shading', 'procedural', 'seeded'],
    url: 'https://github.com/winchxyz/bikini-bottom',
  },
  {
    name: 'idea-to-build',
    group: 'tools',
    desc: 'Turn a raw idea into a plan you can build. A multi-agent methodology with isolated critique, fact-checking, and a handoff straight into Claude Code.',
    lang: 'Shell',
    stars: 9, forks: 1,
    tags: ['multi-agent', 'Claude Code', 'MCP', 'prompt-engineering'],
    url: 'https://github.com/winchxyz/idea-to-build',
  },
  {
    name: 'loupe',
    group: 'tools',
    desc: 'Open-source, local Windows AI website builder. AI builds the site, you refine it by hand on the live render — every edit verified against the real DOM.',
    lang: 'CSS',
    stars: 7, forks: 1,
    tags: ['Electron', 'Claude Agent SDK', 'BYOK', 'local-first'],
    url: 'https://github.com/winchxyz/loupe',
    live: 'https://tryloupe.app',
  },
  {
    name: 'navis',
    group: 'graphics',
    desc: 'A flooded Gothic cathedral rendered in real time. One HTML file, no assets — the rose window, the marble, the caustics and the reverb are all generated at load.',
    lang: 'HTML',
    stars: 6, forks: 1,
    tags: ['three.js', 'GLSL', 'single-file', 'procedural-audio'],
    url: 'https://github.com/winchxyz/navis',
    live: 'https://winchxyz.github.io/navis/',
  },
  {
    name: 'solebound',
    group: 'graphics',
    desc: 'A GPU shoe-repair simulator about roads that remember. One HTML file — geometry, materials, audio and portraits all generated at runtime.',
    lang: 'HTML',
    stars: 4, forks: 0,
    tags: ['WebGL', 'GLSL', 'procedural', 'single-file'],
    url: 'https://github.com/winchxyz/solebound',
  },
  {
    name: 'x-ghostwriter',
    group: 'tools',
    desc: 'Your AI ghostwriter for X — drafts posts and replies in your voice. Runs locally, costs nothing, and you always hit publish yourself.',
    lang: 'PowerShell',
    stars: 3, forks: 0,
    tags: ['n8n', 'self-hosted', 'Telegram', 'build-in-public'],
    url: 'https://github.com/winchxyz/x-ghostwriter',
  },
  {
    name: 'cut',
    group: 'graphics',
    desc: 'A quiet 3D slicing sandbox — cut objects apart along the exact path your mouse draws.',
    lang: 'JavaScript',
    stars: 1, forks: 0,
    tags: ['mesh-surgery', 'WebGL', 'sandbox'],
    url: 'https://github.com/winchxyz/cut',
  },
  {
    name: 'ar-butter',
    group: 'graphics',
    desc: 'A stick of butter under brittle wax, cracked apart with your hands through a webcam.',
    lang: 'TypeScript',
    stars: 1, forks: 0,
    tags: ['hand-tracking', 'AR', 'fracture'],
    url: 'https://github.com/winchxyz/ar-butter',
  },
  {
    name: 'endless-fishing',
    group: 'graphics',
    desc: 'An endless ocean under the sky that is actually above you right now. Physically correct astronomy, a JONSWAP spectrum, hand-written buoyancy.',
    lang: 'TypeScript',
    stars: 0, forks: 0,
    tags: ['JONSWAP', 'astronomy', 'buoyancy'],
    url: 'https://github.com/winchxyz/endless-fishing',
  },
  {
    name: 'loupe-website',
    group: 'tools',
    desc: 'The product site for Loupe — the AI web-design studio.',
    lang: 'HTML',
    stars: 0, forks: 0,
    tags: ['marketing', 'static'],
    url: 'https://github.com/winchxyz/loupe-website',
    live: 'https://tryloupe.app',
  },
];

/* ── materials ─────────────────────────────────────────────────────────────
   `p` maps straight onto the uniforms the raymarch shader reads. Everything
   here is analytic — there is not one texture file behind any of it.
   ─────────────────────────────────────────────────────────────────────── */

export const MATERIALS = [
  {
    id: 0,
    name: 'Liquid chrome',
    sw: '#cdd3cc',
    desc: 'A near-perfect mirror over a surface that will not hold still. Rough enough to catch the softboxes, smooth enough that the whole studio bends across it. The only reason it reads as metal is the Fresnel term — there is no reflection probe anywhere in this page.',
    p: { rough: 0.045, metal: 1.0, ior: 2.4, aniso: 0.0, film: 0.0, trans: 0.0 },
    stats: [['roughness', '0.045'], ['metalness', '1.00'], ['model', 'GGX · Smith'], ['env', 'analytic']],
  },
  {
    id: 1,
    name: 'Anodised titanium',
    sw: '#8ba8d8',
    desc: 'Thin-film interference: a nanometres-thick oxide layer where light reflecting off the top and the bottom of the film arrives out of phase and cancels itself, wavelength by wavelength. The colour is not a texture. It is the film thickness and the angle you are looking from.',
    p: { rough: 0.16, metal: 1.0, ior: 2.6, aniso: 0.0, film: 1.0, trans: 0.0 },
    stats: [['film', '380 nm'], ['roughness', '0.16'], ['model', 'thin-film'], ['η film', '2.20'] ],
  },
  {
    id: 2,
    name: 'Obsidian glass',
    sw: '#3a4b52',
    desc: 'Three refracted rays instead of one, at slightly different indices of refraction, recombined as red, green and blue. That is the whole trick behind dispersion — the reason a prism throws a rainbow and cheap CG glass never does.',
    p: { rough: 0.02, metal: 0.0, ior: 1.52, aniso: 0.0, film: 0.0, trans: 1.0 },
    stats: [['IOR r/g/b', '1.505 / 1.520 / 1.545'], ['abbe', '≈ 42'], ['bounces', '2'], ['model', 'dielectric']],
  },
  {
    id: 3,
    name: 'Brushed alloy',
    sw: '#9a9c93',
    desc: 'Anisotropic GGX with the tangent frame built from a procedural direction field wrapped around the form — no UVs, because a signed distance field does not have any. The highlight stretches perpendicular to the grain, which is the entire reason brushed metal looks brushed.',
    p: { rough: 0.30, metal: 1.0, ior: 1.9, aniso: 0.85, film: 0.0, trans: 0.0 },
    stats: [['α tangent', '0.42'], ['α bitangent', '0.06'], ['anisotropy', '0.85'], ['model', 'aniso GGX']],
  },
  {
    id: 4,
    name: 'Kiln ceramic',
    sw: '#e6e2d6',
    desc: 'A dielectric with a wrapped diffuse term standing in for subsurface scattering, under a clear specular coat. The glaze pools in the low places and thins over the high ones, because the roughness is driven by the same noise field that carves the surface.',
    p: { rough: 0.42, metal: 0.0, ior: 1.46, aniso: 0.0, film: 0.0, trans: 0.0 },
    stats: [['roughness', '0.42'], ['metalness', '0.00'], ['wrap', '0.55'], ['coat', '0.35']],
  },
  {
    id: 5,
    name: 'Molten core',
    sw: '#ff7a2f',
    desc: 'The lattice is opaque; what is behind it is not. Emission ramped along a blackbody curve from about 1100 K at the skin to 2400 K deep in, so the colour shift from dull red to white is the real Planck locus rather than a hand-picked gradient.',
    p: { rough: 0.55, metal: 0.15, ior: 1.7, aniso: 0.0, film: 0.0, trans: 0.0, emissive: 1.0 },
    stats: [['T skin', '1 100 K'], ['T core', '2 400 K'], ['curve', 'Planck'], ['exposure', '+1.4 EV']],
  },
];

/* ── physics sliders ───────────────────────────────────────────────────── */

export const SLIDERS = [
  { id: 'wind',    label: 'wind',        min: 0,   max: 3.0,  step: 0.01, val: 1.05, fmt: (v) => v.toFixed(2) + ' m/s' },
  { id: 'gravity', label: 'gravity',     min: 0,   max: 24,   step: 0.1,  val: 9.81, fmt: (v) => v.toFixed(2) + ' m/s²' },
  { id: 'stiff',   label: 'stiffness',   min: 0.1, max: 1.0,  step: 0.01, val: 0.72, fmt: (v) => v.toFixed(2) },
  { id: 'damp',    label: 'damping',     min: 0.8, max: 1.0,  step: 0.002, val: 0.986, fmt: (v) => v.toFixed(3) },
  { id: 'iters',   label: 'relaxations', min: 1,   max: 16,   step: 1,    val: 8,    fmt: (v) => v.toFixed(0) + ' / frame' },
];

/* ── keyboard ──────────────────────────────────────────────────────────── */

export const SHORTCUTS = [
  ['1 – 6',  'material preset'],
  ['drag',   'orbit the sculpture'],
  ['grab',   'pull the cloth around'],
  ['P',      'photo mode — UI off, 2× render scale'],
  ['Enter',  'save a PNG'],
  ['G',      'performance readout'],
  ['R',      'reset the cloth'],
  ['M',      'calm mode — halve the motion'],
  ['?',      'this list'],
];
