/* ══════════════════════════════════════════════════════════════════════════
   tools/lint.mjs — a static check for the GLSL, because the shaders are
   assembled from string chunks and the compiler that would catch this lives
   on a GPU.

   It checks the two things that actually go wrong when you build shaders by
   concatenation:

     1. a function called before it is defined — GLSL has no forward
        declarations, so getting the chunk order wrong is a compile error
        that only appears on a machine with a working driver;
     2. a uniform the JavaScript sets that the shader never declares (a typo
        that fails completely silently, because setting an unknown uniform is
        a no-op by design).

   Run with:  node tools/lint.mjs
   ══════════════════════════════════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { RAYMARCH_FRAG } = await import('../js/shaders/raymarch.js');
const { PARTICLE_SIM_FRAG, PARTICLE_VERT, PARTICLE_FRAG } = await import('../js/shaders/particles.js');
const {
  COMPOSITE_FRAG, TAA_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG, STREAK_FRAG, FINAL_FRAG,
} = await import('../js/shaders/post.js');
const { FS_VERT } = await import('../js/gl.js');

/* Programs exactly as renderer.js builds them. */
const PROGRAMS = {
  'raymarch':          [FS_VERT, RAYMARCH_FRAG],
  'particle.sim':      [FS_VERT, PARTICLE_SIM_FRAG],
  'particle.draw':     [PARTICLE_VERT, PARTICLE_FRAG],
  'composite':         [FS_VERT, COMPOSITE_FRAG],
  'taa':               [FS_VERT, TAA_FRAG],
  'bloom.prefilter':   [FS_VERT, BLOOM_PREFILTER_FRAG],
  'bloom.down':        [FS_VERT, BLOOM_DOWN_FRAG],
  'bloom.up':          [FS_VERT, BLOOM_UP_FRAG],
  'bloom.streak':      [FS_VERT, STREAK_FRAG],
  'final':             [FS_VERT, FINAL_FRAG],
};

const TYPES = new Set([
  'float','int','uint','bool','void',
  'vec2','vec3','vec4','ivec2','ivec3','ivec4','uvec2','uvec3','uvec4',
  'bvec2','bvec3','bvec4',
  'mat2','mat3','mat4','mat2x2','mat2x3','mat2x4','mat3x2','mat3x3','mat3x4',
  'mat4x2','mat4x3','mat4x4',
  'sampler2D','sampler3D','samplerCube','sampler2DArray',
  'isampler2D','usampler2D','sampler2DShadow',
]);

const KEYWORDS = new Set([
  'if','else','for','while','do','switch','case','return','break','continue',
  'discard','struct','const','uniform','in','out','inout','layout','precision',
  'highp','mediump','lowp','flat','smooth','centroid','invariant','defined',
]);

const BUILTINS = new Set([
  'abs','acos','acosh','all','any','asin','asinh','atan','atanh','ceil','clamp',
  'cos','cosh','cross','degrees','determinant','distance','dot','equal','exp',
  'exp2','faceforward','floatBitsToInt','floatBitsToUint','floor','fract',
  'greaterThan','greaterThanEqual','intBitsToFloat','inverse','inversesqrt',
  'isinf','isnan','length','lessThan','lessThanEqual','log','log2',
  'matrixCompMult','max','min','mix','mod','modf','normalize','not','notEqual',
  'outerProduct','packHalf2x16','packSnorm2x16','packUnorm2x16','pow','radians',
  'reflect','refract','round','roundEven','sign','sin','sinh','smoothstep',
  'sqrt','step','tan','tanh','texelFetch','texelFetchOffset','texture',
  'textureGrad','textureGradOffset','textureLod','textureLodOffset',
  'textureOffset','textureProj','textureProjLod','textureSize','transpose',
  'trunc','uintBitsToFloat','unpackHalf2x16','unpackSnorm2x16','unpackUnorm2x16',
  'dFdx','dFdy','fwidth','imulExtended','bitCount','findLSB','findMSB',
]);

const errors = [];
const warnings = [];

/* ── 1. per-stage source analysis ──────────────────────────────────────── */

function stripComments(src) {
  // keep the character count identical so indices stay meaningful
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function analyse(name, stage, src) {
  const clean = stripComments(src);

  if (!src.startsWith('#version 300 es')) {
    errors.push(`${name}.${stage}: #version must be the very first characters of the source`);
  }
  const versions = (clean.match(/#version/g) || []).length;
  if (versions !== 1) {
    errors.push(`${name}.${stage}: found ${versions} #version directives, expected exactly 1`);
  }

  // declared functions:  <type> <name> ( ... ) {
  const defs = new Map();
  const defRe = /\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{)]*)\)\s*\{/g;
  let m;
  while ((m = defRe.exec(clean))) {
    const [, retType, fname] = m;
    if (KEYWORDS.has(retType) && retType !== 'const') continue;
    if (!defs.has(fname)) defs.set(fname, []);
    defs.get(fname).push(m.index);
  }

  // declared structs
  const structs = new Set();
  const structRe = /\bstruct\s+([A-Za-z_]\w*)/g;
  while ((m = structRe.exec(clean))) structs.add(m[1]);

  // uniforms
  const uniforms = new Set();
  const uniRe = /\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/g;
  while ((m = uniRe.exec(clean))) uniforms.add(m[2]);

  // every call site
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  while ((m = callRe.exec(clean))) {
    const fname = m[1];
    const at = m.index;
    if (KEYWORDS.has(fname) || TYPES.has(fname) || BUILTINS.has(fname) || structs.has(fname)) continue;

    // skip the definition site itself
    const before = clean.slice(Math.max(0, at - 40), at);
    if (/\b(?:float|int|uint|bool|void|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|[A-Z]\w*)\s+$/.test(before)
        && defs.has(fname)) {
      continue;
    }

    if (!defs.has(fname)) {
      errors.push(`${name}.${stage}: calls '${fname}()' which is never defined (missing chunk?)`);
      continue;
    }
    const firstDef = Math.min(...defs.get(fname));
    if (at < firstDef) {
      errors.push(
        `${name}.${stage}: calls '${fname}()' at char ${at} but it is not defined until ${firstDef} — ` +
        `GLSL has no forward declarations, so the chunks are in the wrong order`,
      );
    }
  }

  return { uniforms, defs, clean };
}

const analysed = {};
for (const [name, [vs, fs]] of Object.entries(PROGRAMS)) {
  analysed[name] = {
    vert: analyse(name, 'vert', vs),
    frag: analyse(name, 'frag', fs),
  };

  // varyings the fragment stage reads must be written by the vertex stage
  const vsOut = new Set([...vs.matchAll(/^\s*out\s+(?:\w+\s+)?(\w+)\s+(\w+)\s*;/gm)].map((x) => x[2]));
  const fsIn = [...fs.matchAll(/^\s*in\s+(?:\w+\s+)?(\w+)\s+(\w+)\s*;/gm)].map((x) => x[2]);
  for (const v of fsIn) {
    if (!vsOut.has(v)) errors.push(`${name}: fragment reads varying '${v}' that the vertex stage never writes`);
  }
}

/* ── 2. uniforms the renderer sets vs uniforms the shaders declare ─────── */

const rendererSrc = readFileSync(join(ROOT, 'js/renderer.js'), 'utf8');

/* Map each `this.pXxx` program handle to its lint name. */
const HANDLE = {
  pRaymarch: 'raymarch', pPartSim: 'particle.sim', pPartDraw: 'particle.draw',
  pComposite: 'composite', pTaa: 'taa', pPrefilter: 'bloom.prefilter',
  pDown: 'bloom.down', pUp: 'bloom.up', pStreak: 'bloom.streak', pFinal: 'final',
};

/* Split renderer.js on each `this.pXxx.use()` and attribute every uniform
   name mentioned before the next one to that program. Crude, but the file is
   written in exactly that shape. */
const blocks = [];
const useRe = /this\.(p[A-Za-z]+)\.use\(\)/g;
let mm, prev = null, prevIdx = 0;
while ((mm = useRe.exec(rendererSrc))) {
  if (prev) blocks.push([prev, rendererSrc.slice(prevIdx, mm.index)]);
  prev = mm[1]; prevIdx = mm.index;
}
if (prev) blocks.push([prev, rendererSrc.slice(prevIdx)]);

for (const [handle, body] of blocks) {
  const prog = HANDLE[handle];
  if (!prog || !analysed[prog]) continue;
  const declared = new Set([
    ...analysed[prog].vert.uniforms,
    ...analysed[prog].frag.uniforms,
  ]);
  const used = new Set();
  for (const x of body.matchAll(/\b(?:set|tex)\(\s*'([A-Za-z_]\w*)'/g)) used.add(x[1]);
  // setAll({...}) keys, wherever they sit on the line
  for (const x of body.matchAll(/\b(u[A-Z]\w*)\s*:/g)) used.add(x[1]);

  for (const u of used) {
    if (!declared.has(u)) {
      warnings.push(`${prog}: renderer sets '${u}' but no shader stage declares it — silently ignored`);
    }
  }
  for (const u of declared) {
    if (!used.has(u) && !/^u(Res|Texel)$/.test(u)) {
      warnings.push(`${prog}: declares uniform '${u}' that the renderer never sets`);
    }
  }
}

/* ── report ────────────────────────────────────────────────────────────── */

const line = '─'.repeat(72);
console.log(line);
console.log(`glsl lint — ${Object.keys(PROGRAMS).length} programs, ` +
            `${Object.values(PROGRAMS).flat().reduce((n, s) => n + s.split('\n').length, 0)} lines`);
console.log(line);

if (errors.length) {
  console.log(`\n${errors.length} ERROR${errors.length > 1 ? 'S' : ''}\n`);
  errors.forEach((e) => console.log('  ✗ ' + e));
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning${warnings.length > 1 ? 's' : ''}\n`);
  warnings.forEach((w) => console.log('  · ' + w));
}
if (!errors.length && !warnings.length) console.log('\nclean\n');
console.log('');

process.exit(errors.length ? 1 : 0);
