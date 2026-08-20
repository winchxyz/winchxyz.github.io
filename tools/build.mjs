/* ══════════════════════════════════════════════════════════════════════════
   tools/build.mjs — flatten the whole site into one HTML file.

   Not a build step in the sense of a toolchain: the site runs perfectly well
   as plain ES modules off any static server, and that is the version to
   develop against. This exists so the thing can also be handed over as a
   single file you double-click, the way solebound and navis are.

   It resolves the module graph, topologically sorts it, strips the import and
   export syntax, and concatenates. That works here because every module is
   side-effect free apart from main.js, and no two of them declare the same
   top-level name — which the script checks rather than assumes.

     node tools/build.mjs
   ══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'js/main.js');

const IMPORT_RE = /^[ \t]*import\s+(?:[\w$*]+\s*,\s*)?(?:\{[^}]*\}|[\w$*]+|\*\s+as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const BARE_EXPORT_RE = /^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm;

const seen = new Map();
const order = [];

function load(file) {
  const abs = resolve(file);
  if (seen.has(abs)) return;
  seen.set(abs, true);

  const src = readFileSync(abs, 'utf8');

  // depth first, so dependencies land before the module that needs them
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) throw new Error(`${abs}: bare import "${spec}" — this bundler only handles relative paths`);
    load(resolve(dirname(abs), spec));
  }

  order.push({ abs, src });
}

load(ENTRY);

/* Collision check. Concatenating module scopes into one scope is only safe if
   the top-level names are unique; if two modules both declare `P`, the bundle
   is a SyntaxError at best and silently wrong at worst.

   Only column-zero declarations count. Anything indented is inside a function
   and has its own scope, and template literals have to be stripped first or
   every GLSL function in the shader chunks — which are perfectly happy to
   start a line with `float foo(...)` — is mistaken for a JavaScript one. */
const DECL_RE = /^(?:export\s+)?(?:const|let|var|function|class)\s+([\w$]+)/gm;

const topLevelOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '')
  .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``');

const owner = new Map();
const clashes = [];
for (const { abs, src: raw } of order) {
  const src = topLevelOnly(raw);
  for (const m of src.matchAll(DECL_RE)) {
    const name = m[1];
    if (owner.has(name)) clashes.push(`${name}: ${relative(ROOT, owner.get(name))} vs ${relative(ROOT, abs)}`);
    else owner.set(name, abs);
  }
}
if (clashes.length) {
  console.error('top-level name collisions — cannot flatten:\n  ' + clashes.join('\n  '));
  process.exit(1);
}

const bundle = order.map(({ abs, src }) => {
  const body = src
    .replace(IMPORT_RE, '')
    .replace(BARE_EXPORT_RE, '')
    .replace(/^[ \t]*export\s+(const|let|var|function|class|async)\b/gm, '$1');
  return `/* ── ${relative(ROOT, abs).replace(/\\/g, '/')} ${'─'.repeat(Math.max(2, 58 - abs.length % 40))} */\n${body.trim()}\n`;
}).join('\n');

const css = readFileSync(join(ROOT, 'css/main.css'), 'utf8');
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* The replacements go through a function, not a string. A string replacement
   runs the inserted text through $-pattern substitution, which turns every
   `$$` in the source into a single `$` — so `const $$ = ...` in ui.js quietly
   became `const $ = ...` and collided with the `$` two lines above it. A
   replacer function is passed through verbatim. */
html = html.replace(
  '<link rel="stylesheet" href="css/main.css" />',
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  '<script type="module" src="js/main.js"></script>',
  () => `<script type="module">\n${bundle}\n</script>`,
);

mkdirSync(join(ROOT, 'dist'), { recursive: true });

const out = join(ROOT, 'dist/winch.html');
writeFileSync(out, html);

/* The artifact variant: same page, but with the document skeleton removed,
   because the artifact host supplies its own <head> and <body>. */
const inner = html
  .replace(/^[\s\S]*?<head>/, '')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<\/body>\s*<\/html>\s*$/, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  // The site's <title> is written for a browser tab and a search result, so
  // it carries the descriptive tail. In a gallery of artifacts the page needs
  // a name instead.
  .replace(/<title>[\s\S]*?<\/title>/i, () => '<title>Winch GPU Portfolio</title>');
writeFileSync(join(ROOT, 'dist/artifact.html'), inner.trim() + '\n');

const kb = (n) => (n / 1024).toFixed(0) + ' kB';
console.log(`modules   ${order.length}`);
console.log(`css       ${kb(css.length)}`);
console.log(`js        ${kb(bundle.length)}`);
console.log(`→ dist/winch.html     ${kb(html.length)}`);
console.log(`→ dist/artifact.html  ${kb(inner.length)}`);
