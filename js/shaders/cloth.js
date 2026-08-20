/* ══════════════════════════════════════════════════════════════════════════
   cloth.js — a Verlet cloth solved in fragment shaders.

   State is two RGBA32F attachments on one target: the current positions and
   the previous ones. Verlet needs nothing else — velocity is implicit in the
   difference between them, which is also why constraints can be applied by
   simply moving a point: the correction becomes an impulse for free.

   Constraints are relaxed with Jacobi rather than Gauss-Seidel, because a
   fragment shader cannot see the corrections its neighbours are making in
   the same pass. Jacobi converges more slowly for it, so the stiffness is
   over-relaxed to compensate — see OMEGA below.
   ══════════════════════════════════════════════════════════════════════════ */

import { HEAD, HASH, NOISE, SDF, PBR, COLOR } from './lib.js';

const CLOTH_COMMON = `
uniform vec2  uN;          // grid resolution
uniform vec3  uOrigin;     // bottom-centre of the rest plane
uniform vec2  uSize;       // width, height in world units

vec3 restPos(ivec2 tc){
  vec2 uv = vec2(tc) / (uN - 1.0);
  return uOrigin + vec3((uv.x - 0.5) * uSize.x, uv.y * uSize.y, 0.0);
}

bool inGrid(ivec2 c){
  return c.x >= 0 && c.y >= 0 && c.x < int(uN.x) && c.y < int(uN.y);
}
`;

/* ── integrate ─────────────────────────────────────────────────────────── */

export const CLOTH_INTEGRATE_FRAG = HEAD + HASH + NOISE + CLOTH_COMMON + `

in vec2 vUv;

layout(location = 0) out vec4 oCur;
layout(location = 1) out vec4 oPrev;

uniform sampler2D uCur;
uniform sampler2D uPrev;

uniform float uDt;
uniform float uPrevDt;
uniform float uTime;
uniform float uGravity;
uniform float uWind;
uniform float uDamp;
uniform float uPinned;      // 1 = top row held, 0 = cut loose

uniform vec3  uGrabPos;
uniform vec2  uGrabIdx;
uniform float uGrabActive;

vec3 fetchC(ivec2 c){
  c = clamp(c, ivec2(0), ivec2(uN) - 1);
  return texelFetch(uCur, c, 0).xyz;
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);

  vec3 cur  = texelFetch(uCur,  tc, 0).xyz;
  vec3 prev = texelFetch(uPrev, tc, 0).xyz;

  bool pinned = (uPinned > 0.5) && (tc.y == int(uN.y) - 1) && (tc.x % 6 == 0 || tc.x == int(uN.x) - 1);

  if (pinned){
    vec3 r = restPos(tc);
    oCur  = vec4(r, 1.0);
    oPrev = vec4(r, 1.0);
    return;
  }

  // face normal from the four neighbours, for the wind term
  vec3 pL = fetchC(tc + ivec2(-1, 0));
  vec3 pR = fetchC(tc + ivec2( 1, 0));
  vec3 pD = fetchC(tc + ivec2( 0,-1));
  vec3 pU = fetchC(tc + ivec2( 0, 1));
  vec3 n  = normalize(cross(pR - pL, pU - pD) + vec3(0.0, 0.0, 1e-5));

  vec3 acc = vec3(0.0, -uGravity, 0.0);

  // Aerodynamic pressure, not a uniform push: the force is along the face
  // normal, scaled by how square-on the face is to the wind. That is what
  // makes a cloth billow and luff instead of sliding sideways as one sheet.
  vec3 windDir = normalize(vec3(-1.0, 0.06, 0.32));   // blows it onto the sculpture
  vec3 gust = curlNoise(cur * 1.1 + vec3(0.0, 0.0, uTime * 0.55)) * 0.55;
  vec3 w = (windDir + gust) * uWind;
  acc += n * dot(n, w) * 2.4;
  acc += w * 0.22;

  // Time-corrected Verlet. The (dt/prevDt) factor is what keeps the sim from
  // gaining or losing energy when the frame time changes — without it,
  // one dropped frame permanently speeds the cloth up.
  float r = (uPrevDt > 1e-5) ? (uDt / uPrevDt) : 1.0;
  r = clamp(r, 0.6, 1.4);

  vec3 vel = (cur - prev) * r * uDamp;
  vec3 next = cur + vel + acc * uDt * uDt;

  if (uGrabActive > 0.5){
    float dGrab = distance(vec2(tc), uGrabIdx);
    float k = exp(-dGrab * dGrab / 12.0);
    next = mix(next, uGrabPos, clamp(k, 0.0, 0.92));
  }

  oCur  = vec4(next, 1.0);
  oPrev = vec4(cur,  1.0);
}
`;

/* ── constraints ───────────────────────────────────────────────────────── */

/* Chunk order matters: GLSL has no forward declarations, so SDF must come
   after the HASH and NOISE it calls into. */
export const CLOTH_RELAX_FRAG = HEAD + HASH + NOISE + SDF + CLOTH_COMMON + `

in vec2 vUv;

layout(location = 0) out vec4 oCur;
layout(location = 1) out vec4 oPrev;

uniform sampler2D uCur;
uniform sampler2D uPrev;

uniform float uStiff;
uniform float uPinned;
uniform float uTime;
uniform float uShape;
uniform float uDetail;
uniform float uScale;
uniform float uFloorY;
uniform float uFriction;

// Jacobi cannot see its neighbours' corrections, so it under-relaxes badly
// compared with Gauss-Seidel at the same stiffness — cloth that should be
// canvas ends up behaving like a knitted jumper. Over-relaxing by this
// factor buys most of it back. Above about 1.9 it rings.
const float OMEGA = 1.72;

float sdfAt(vec3 p){ return sculpture(p / uScale, uTime, uShape, uDetail) * uScale; }

vec3 sdfGrad(vec3 p){
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.012;
  return normalize(
    k.xyy * sdfAt(p + k.xyy * e) +
    k.yyx * sdfAt(p + k.yyx * e) +
    k.yxy * sdfAt(p + k.yxy * e) +
    k.xxx * sdfAt(p + k.xxx * e));
}

void accumulate(inout vec3 corr, inout float wsum, vec3 p, ivec2 c, float rest, float w){
  if (!inGrid(c)) return;
  vec3 q = texelFetch(uCur, c, 0).xyz;
  vec3 d = q - p;
  float l = length(d);
  if (l < 1e-7) return;
  corr += d * (1.0 - rest / l) * 0.5 * w;
  wsum += w;
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);

  vec3 p    = texelFetch(uCur,  tc, 0).xyz;
  vec3 prev = texelFetch(uPrev, tc, 0).xyz;

  bool pinned = (uPinned > 0.5) && (tc.y == int(uN.y) - 1) && (tc.x % 6 == 0 || tc.x == int(uN.x) - 1);
  if (pinned){
    vec3 r = restPos(tc);
    oCur = vec4(r, 1.0);
    oPrev = vec4(r, 1.0);
    return;
  }

  vec2 cell = uSize / (uN - 1.0);
  float rS  = (cell.x + cell.y) * 0.5;

  vec3 corr = vec3(0.0);
  float wsum = 0.0;

  // structural — the weave itself
  accumulate(corr, wsum, p, tc + ivec2( 1, 0), cell.x, 1.0);
  accumulate(corr, wsum, p, tc + ivec2(-1, 0), cell.x, 1.0);
  accumulate(corr, wsum, p, tc + ivec2( 0, 1), cell.y, 1.0);
  accumulate(corr, wsum, p, tc + ivec2( 0,-1), cell.y, 1.0);

  // shear — resists the weave collapsing into a rhombus
  float dg = length(cell);
  accumulate(corr, wsum, p, tc + ivec2( 1, 1), dg, 0.55);
  accumulate(corr, wsum, p, tc + ivec2(-1, 1), dg, 0.55);
  accumulate(corr, wsum, p, tc + ivec2( 1,-1), dg, 0.55);
  accumulate(corr, wsum, p, tc + ivec2(-1,-1), dg, 0.55);

  // bend — two cells out; this is what stops paper-thin creasing
  accumulate(corr, wsum, p, tc + ivec2( 2, 0), cell.x * 2.0, 0.18);
  accumulate(corr, wsum, p, tc + ivec2(-2, 0), cell.x * 2.0, 0.18);
  accumulate(corr, wsum, p, tc + ivec2( 0, 2), cell.y * 2.0, 0.18);
  accumulate(corr, wsum, p, tc + ivec2( 0,-2), cell.y * 2.0, 0.18);

  if (wsum > 0.0) p += corr / wsum * OMEGA * uStiff;

  // ── collisions ─────────────────────────────────────────────────────────
  // Moving the point without moving prev is what gives the collision its
  // impulse — the implicit Verlet velocity changes by exactly the push-out.
  // Dragging prev partway along with it is friction.
  float d = sdfAt(p);
  float thick = 0.028;
  if (d < thick){
    vec3 n = sdfGrad(p);
    vec3 push = n * (thick - d);
    p += push;
    vec3 vel = p - prev;
    vec3 vn = n * dot(n, vel);
    vec3 vt = vel - vn;
    prev = p - (vt * (1.0 - uFriction) + vn * 0.0);
  }

  if (p.y < uFloorY + 0.012){
    float pen = (uFloorY + 0.012) - p.y;
    p.y += pen;
    vec3 vel = p - prev;
    vec3 vt = vec3(vel.x, 0.0, vel.z);
    prev = p - vt * (1.0 - uFriction * 1.4);
  }

  oCur  = vec4(p, 1.0);
  oPrev = vec4(prev, 1.0);
}
`;

/* ── render ────────────────────────────────────────────────────────────── */

export const CLOTH_VERT = HEAD + CLOTH_COMMON + `
uniform sampler2D uCur;
uniform mat4  uViewProj;
uniform vec3  uCamPos;

out vec3 vPos;
out vec3 vNrm;
out vec3 vTan;
out vec2 vUv2;
out float vDist;

vec3 fetchC(ivec2 c){
  c = clamp(c, ivec2(0), ivec2(uN) - 1);
  return texelFetch(uCur, c, 0).xyz;
}

void main(){
  int w = int(uN.x);
  ivec2 tc = ivec2(gl_VertexID % w, gl_VertexID / w);

  vec3 p = fetchC(tc);

  vec3 pL = fetchC(tc + ivec2(-1, 0));
  vec3 pR = fetchC(tc + ivec2( 1, 0));
  vec3 pD = fetchC(tc + ivec2( 0,-1));
  vec3 pU = fetchC(tc + ivec2( 0, 1));

  vec3 n = cross(pR - pL, pU - pD);
  float nl = length(n);
  vNrm = nl > 1e-7 ? n / nl : vec3(0.0, 0.0, 1.0);
  vTan = normalize(pR - pL + vec3(1e-6, 0.0, 0.0));

  vPos  = p;
  vUv2  = vec2(tc) / (uN - 1.0);
  vDist = distance(p, uCamPos);

  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const CLOTH_FRAG = HEAD + HASH + NOISE + PBR + COLOR + `
in vec3 vPos;
in vec3 vNrm;
in vec3 vTan;
in vec2 vUv2;
in float vDist;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDist;

uniform sampler2D uPrint;     // the wordmark, drawn to a 2D canvas at load
uniform vec3  uCamPos;
uniform float uRimBoost;
uniform float uExposure;
uniform float uFade;

void main(){
  // Two-sided: a cloth has a back, and lighting it with the front face's
  // normal is what makes the classic black-underside look.
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;

  vec3 v = normalize(uCamPos - vPos);

  // ── procedural weave ───────────────────────────────────────────────────
  // A plain over-under weave in the normal, at a frequency high enough that
  // it reads as fibre rather than as a pattern.
  vec2 wv = vUv2 * 620.0;
  float warp = sin(wv.x * TAU);
  float weft = sin(wv.y * TAU);
  float threads = warp * weft;
  vec3 T = normalize(vTan - n * dot(n, vTan));
  vec3 B = normalize(cross(n, T));
  n = normalize(n + (T * warp * 0.055 + B * weft * 0.055));

  float lint = fbm(vec3(vUv2 * 90.0, 3.1), 2);

  // ── albedo ─────────────────────────────────────────────────────────────
  float print = texture(uPrint, vec2(vUv2.x, 1.0 - vUv2.y)).r;
  // Real canvas has an albedo around 0.2-0.4. The first pass at this used
  // 0.05, which is closer to charcoal than to cloth, and no amount of light
  // rescues a surface that absorbs 95% of what hits it.
  vec3 cloth = mix(vec3(0.085, 0.092, 0.080), vec3(0.125, 0.135, 0.115), lint);
  // Chalk, not lime. The accent was the obvious choice and it was wrong: the
  // rim light on this cloth IS lime, so lime ink on grey canvas renders as
  // lime on lime and the wordmark disappears into its own lighting.
  vec3 ink   = vec3(0.86, 0.90, 0.82);
  vec3 albedo = mix(cloth, ink, print);

  float rough = mix(0.86, 0.55, print) - threads * 0.05;
  rough = clamp(rough, 0.2, 1.0);

  float NoV = clamp(dot(n, v), 1e-4, 1.0);
  vec3 col = vec3(0.0);

  vec3 lights[3];
  lights[0] = normalize(L_KEY);
  lights[1] = normalize(L_FILL);
  lights[2] = normalize(L_RIM);
  vec3 cols[3];
  cols[0] = C_KEY; cols[1] = C_FILL; cols[2] = C_RIM * (1.0 + uRimBoost);

  for (int i = 0; i < 3; i++){
    vec3 l = lights[i];
    vec3 h = normalize(v + l);
    float NoL = clamp(dot(n, l), 0.0, 1.0);
    float NoH = clamp(dot(n, h), 0.0, 1.0);

    // Wrapped diffuse standing in for the light that gets through the weave.
    float wrapped = clamp((dot(n, l) + 0.4) / 1.4, 0.0, 1.0);
    col += albedo * INV_PI * wrapped * cols[i];

    // Charlie sheen — the reason velvet and canvas glow at the edges.
    float Ds = D_Charlie(NoH, rough);
    float Vs = V_Ashikhmin(NoV, NoL);
    col += Ds * Vs * 0.45 * cols[i] * NoL;
  }

  // transmission: a backlit cloth is lit from behind, not black
  float back = clamp(dot(-n, normalize(L_KEY)), 0.0, 1.0);
  col += albedo * pow(back, 2.5) * C_KEY * 0.30;

  col += albedo * envColor(n, 0.95, uRimBoost) * 0.55;
  vec2 ab = envBRDFApprox(NoV, rough);
  col += envColor(reflect(-v, n), rough, uRimBoost) * (0.04 * ab.x + ab.y) * 0.7;

  float fog = 1.0 - exp(-max(vDist - 3.0, 0.0) * 0.035);
  col = mix(col, vec3(0.011, 0.013, 0.015), clamp(fog, 0.0, 0.9));

  col *= uExposure * uFade;

  oColor = vec4(col, 1.0);
  oDist  = vec4(vDist, 0.0, 0.0, 1.0);
}
`;
