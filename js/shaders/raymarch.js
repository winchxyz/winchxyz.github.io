/* ══════════════════════════════════════════════════════════════════════════
   raymarch.js: the hero pass.

   One fullscreen triangle. Every pixel sphere-traces a signed distance field,
   shades it with a hand-written BRDF against an environment that is a
   function rather than a photograph, and writes its own depth so that the
   cloth and the particles can be occluded by a surface that has no geometry.
   ══════════════════════════════════════════════════════════════════════════ */

import { HEAD, HASH, NOISE, SDF, PBR, COLOR } from './lib.js';

export const RAYMARCH_FRAG = HEAD + HASH + NOISE + SDF + PBR + COLOR + `

in vec2 vUv;

layout(location = 0) out vec4 oColor;   // HDR radiance
layout(location = 1) out vec4 oDist;    // ray distance to the hit, -1 on a miss

uniform vec2  uRes;
uniform float uTime;
uniform float uFrame;

uniform mat4  uInvViewProj;
uniform mat4  uViewProj;
uniform vec3  uCamPos;

uniform float uShape;      // 0..3, which form (and how far between two)
uniform float uDetail;     // surface displacement amount
uniform float uScale;      // overall size of the sculpture

uniform int   uMatId;
uniform float uRough;
uniform float uMetal;
uniform float uIor;
uniform float uAniso;
uniform float uFilm;
uniform float uTrans;
uniform float uEmissive;
uniform vec3  uAbsorb;       // Beer-Lambert coefficient, per channel
uniform float uDispersion;   // IOR spread between red and blue

/* ── the palette ───────────────────────────────────────────────────────────
   Every material, so the preview orbs can each wear a different one. The
   scalar uniforms above stay: they carry the sculpture's CURRENT material,
   which is a blend during an absorb and therefore not any one array entry. */
#define MAT_MAX 8
uniform float uMatRough[MAT_MAX];
uniform float uMatMetal[MAT_MAX];
uniform float uMatIor[MAT_MAX];
uniform float uMatAniso[MAT_MAX];
uniform float uMatFilm[MAT_MAX];
uniform float uMatTrans[MAT_MAX];
uniform float uMatEmis[MAT_MAX];
uniform float uMatDisp[MAT_MAX];
uniform vec3  uMatAbsorb[MAT_MAX];

/* Orb positions and radii come from the CPU rather than being recomputed
   here. One source of truth is the whole point: the click test in main.js
   and the pixels on screen cannot disagree about where an orb is. */
uniform vec3  uOrbPos[MAT_MAX];
uniform float uOrbR[MAT_MAX];
uniform int   uOrbCount;      // 0 outside the materials section; skips it all

/* The absorb. A ring wave crosses the sculpture and the switch happens under
   it, so the eye follows the ripple rather than catching the change. */
uniform float uPulse;         // 1 at impact, decaying to 0
uniform vec3  uPulseDir;      // where on the surface it landed
uniform float uFlash;         // emissive burst, same decay

/* The orb being absorbed stops being a sphere in the list and becomes part
   of the distance field, smooth-unioned with the sculpture. That is what
   grows the neck between them and lets the form reach out and swallow it;
   two separate primitives can only ever intersect. */
uniform vec3  uFlyPos;
uniform float uFlyR;          // 0 when nothing is being absorbed
uniform float uFlyK;          // blend radius of the smooth union
uniform float uBound;         // scene bounding radius, grown to cover the flight

/* Every one of these is a LOOP BOUND, and every one of them is a uniform
   rather than a constant on purpose.

   A loop whose trip count the compiler can determine statically is a
   candidate for full unrolling, and ANGLE hands these to the HLSL compiler
   which takes that offer enthusiastically. A count-to-160 loop
   wrapped around a signed distance field evaluation becomes 160 inlined
   copies of the field; four such loops in one shader produced a program that
   took sixty-eight seconds to compile on an RTX 4070 and then ran at two
   frames a minute, because the register pressure left almost no occupancy.

   Making the bound a uniform makes the trip count dynamic, the compiler
   emits a real loop, and both problems disappear. */
uniform int   uSteps;        // camera march budget, set by the quality tier
uniform int   uTransSteps;   // interior march budget for the glass preset
uniform int   uReflSteps;    // reflection march budget
uniform int   uShadowSteps;  // soft shadow march budget
uniform float uReflect;     // 0 or 1, one-bounce reflections on/off
uniform float uRimBoost;    // section-driven lift on the accent rim light
uniform float uExposure;

const float R_BOUND  = 1.62;   // bounding sphere of every form the sculpture takes
const float FLOOR_Y  = -1.62;
const float MAX_DIST = 42.0;
const float STEP_K   = 0.62;   // < 1 because the morph, the gyroid and the
                               // displaced sphere are Lipschitz-bounded
                               // rather than Lipschitz-exact

/* ── local wrappers so the SDF chunk's uniforms stay explicit ───────────── */

float mapS(vec3 p){
  float d = sculpture(p / uScale, uTime, uShape, uDetail) * uScale;

  /* Whatever is mid-exchange, fused rather than merely overlapping. One slot
     serves both directions, because the arriving orb is gone before the
     departing one starts out.

     The neck is this smooth minimum and nothing else. A capsule primitive
     drawn between the two would give a finer thread, and it cost 1.4 s of
     shader compile to find that out: mapS is inlined into the march, the
     normal, the shadow and the occlusion, so five lines here are twenty
     everywhere. The break falls out of k instead. Once the blend radius is
     smaller than the gap, smin stops bridging and there are simply two
     bodies, which is what a pinch is. */
  if (uFlyR > 0.001){
    d = smin(d, length(p - uFlyPos) - uFlyR, uFlyK);
  }

  /* The absorb ripple. A ring wave leaves the impact point and crosses the
     form; the material switches underneath it. Angular position is measured
     with a dot product rather than acos(): the shape of the falloff matters,
     its units do not, and this sits inside the march loop. */
  if (uPulse > 0.002){
    float ad = 1.0 - dot(normalize(p + 1e-5), uPulseDir);   // 0 at the impact, 2 opposite
    float w  = (1.0 - uPulse) * 2.6;
    d += sin((ad - w) * 7.0) * exp(-abs(ad - w) * 4.5) * 0.05 * uPulse;
  }
  return d;
}

/* The tetrahedron normal, written as a loop rather than four unrolled taps.
   Each textual mapS() is another whole copy of the distance field in the
   compiled program, so four of them here cost four times what one does. */
vec3 nrmS(vec3 p, float e){
  vec3 n = vec3(0.0);
  for (int i = 0; i < 4; i++){
    // the four vertices of a tetrahedron, as sign triples
    vec3 k = (i == 0) ? vec3( 1.0, -1.0, -1.0)
           : (i == 1) ? vec3(-1.0, -1.0,  1.0)
           : (i == 2) ? vec3(-1.0,  1.0, -1.0)
                      : vec3( 1.0,  1.0,  1.0);
    n += k * mapS(p + k * e);
  }
  return normalize(n);
}

/* ── bounding sphere ───────────────────────────────────────────────────────
   The single biggest win in the whole pass. Without it every pixel of empty
   background still runs the full step budget against a field it will never
   reach; with it, background pixels cost one quadratic. */
bool sphereRange(vec3 ro, vec3 rd, float r, out float t0, out float t1){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return false;
  h = sqrt(h);
  t0 = -b - h;
  t1 = -b + h;
  return t1 > 0.0;
}

/* ── the preview orbs ──────────────────────────────────────────────────────
   Spheres, so they are intersected rather than marched: seven ray-sphere
   tests once per pixel instead of seven more distance evaluations at every
   one of a hundred-odd march steps. Exact, and effectively free. */
float orbHit(vec3 ro, vec3 rd, float tMax, out int id){
  float best = tMax;
  id = -1;
  for (int k = 0; k < uOrbCount; k++){
    float r = uOrbR[k];
    if (r < 1e-3) continue;
    vec3 oc = ro - uOrbPos[k];
    float b = dot(oc, rd);
    float c = dot(oc, oc) - r * r;
    float h = b * b - c;
    if (h < 0.0) continue;
    float t = -b - sqrt(h);
    if (t > 0.02 && t < best){ best = t; id = k; }
  }
  return best;
}

// A tangent

/* One marcher, shared by the camera ray and by both reflection rays.

   It used to be written out three times. Deduplicating it is not tidiness:
   three copies of a march loop is three copies of the distance field in the
   compiled program, and shader compile time scales with that. */
float marchSDF(vec3 ro, vec3 rd, float tStart, float tEnd, float eps, int maxSteps, out bool hit){
  float t = tStart;
  hit = false;
  for (int i = 0; i < maxSteps; i++){
    if (t > tEnd) break;
    float d = mapS(ro + rd * t);
    if (d < eps * t + 2e-4){ hit = true; break; }
    t += d * STEP_K;
  }
  return t;
}

/* ── march ─────────────────────────────────────────────────────────────── */

struct Hit { float t; int id; };

Hit trace(vec3 ro, vec3 rd, float pixelRadius){
  Hit h;
  h.t = MAX_DIST;
  h.id = 0;

  // floor first: it is a plane, so it is one divide, not a loop
  if (rd.y < -1e-4){
    float tp = (FLOOR_Y - ro.y) / rd.y;
    if (tp > 0.0 && tp < MAX_DIST){ h.t = tp; h.id = 2; }
  }

  float t0, t1;
  if (sphereRange(ro, rd, uBound, t0, t1)){
    float t = max(t0, 0.02);
    float tEnd = min(t1, h.t);
    // Dither the entry point along the ray. Costs nothing and turns the
    // banding you get from a fixed start into noise the TAA then eats.
    t += (ign(gl_FragCoord.xy, uFrame) - 0.5) * 0.012;

    bool hit;
    float tHit = marchSDF(ro, rd, t, tEnd, pixelRadius, uSteps, hit);
    if (hit){ h.t = tHit; h.id = 1; }
  }

  // the preview orbs, intersected rather than marched
  int oid;
  float to = orbHit(ro, rd, h.t, oid);
  if (oid >= 0){ h.t = to; h.id = 10 + oid; }

  return h;
}

float softShadow(vec3 ro, vec3 rd, float k){
  float t0, t1;
  if (!sphereRange(ro, rd, uBound, t0, t1)) return 1.0;

  float res = 1.0;
  float t = max(t0, 0.03);
  float tEnd = min(t1, 12.0);
  float ph = 1e20;

  for (int i = 0; i < uShadowSteps; i++){
    if (t > tEnd) break;
    float d = mapS(ro + rd * t);
    if (d < 1e-4) return 0.0;
    // The y/d correction is what removes the banding the naive
    // min(res, k*h/t) version has along the shadow's soft edge.
    float y = (i == 0) ? 0.0 : d * d / (2.0 * ph);
    float w = sqrt(max(d * d - y * y, 0.0));
    res = min(res, k * w / max(1e-4, t - y));
    ph = d;
    t += clamp(d * STEP_K, 0.012, 0.34);
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n){
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.012 + 0.14 * float(i) / 4.0;
    float d = mapS(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.92;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

/* ── surface description ───────────────────────────────────────────────── */

struct Surf {
  vec3  albedo;
  float rough;
  float metal;
  vec3  emis;
  float aniso;
  float coat;
  float wrap;     // wrapped-diffuse amount, standing in for subsurface
};

/* One material, whether it came from the palette array or from the blended
   scalars the sculpture is currently wearing. */
struct Mat {
  int   id;
  float rough, metal, ior, aniso, film, trans, emis, disp;
  vec3  absorb;
};

Mat matAt(int i){
  Mat m;
  m.id = i;
  m.rough = uMatRough[i]; m.metal  = uMatMetal[i]; m.ior    = uMatIor[i];
  m.aniso = uMatAniso[i]; m.film   = uMatFilm[i];  m.trans  = uMatTrans[i];
  m.emis  = uMatEmis[i];  m.disp   = uMatDisp[i];  m.absorb = uMatAbsorb[i];
  return m;
}

Mat matCurrent(){
  Mat m;
  m.id = uMatId;
  m.rough = uRough; m.metal = uMetal; m.ior   = uIor;   m.aniso  = uAniso;
  m.film  = uFilm;  m.trans = uTrans; m.emis  = uEmissive;
  m.disp  = uDispersion; m.absorb = uAbsorb;
  return m;
}

// A tangent field on a surface with no UVs. Latitude lines around the local
// Y axis, which reads as a part turned on a lathe: exactly the grain
// direction brushed metal actually has.
vec3 tangentField(vec3 p, vec3 n){
  vec3 axis = vec3(0.0, 1.0, 0.0);
  vec3 t = cross(n, axis);
  if (dot(t, t) < 0.02) t = cross(n, vec3(1.0, 0.0, 0.0));
  t = normalize(t);
  // a slow wobble so the brush lines are not mathematically perfect
  vec3 w = (vec3(tnoise(p * 2.4), tnoise(p * 2.4 + 11.3), tnoise(p * 2.4 + 23.7)) - 0.5) * 0.22;
  return normalize(t + w - n * dot(n, w));
}

/* The first argument is the LOCAL space the procedural detail lives in (the
   sculpture's own coordinates, or an orb's) while the second stays world
   space for the view-dependent terms. Without that split an orb would wear a
   slice of the sculpture's noise field rather than its own. */
Surf describe(vec3 q, vec3 p, vec3 n, Mat m){
  Surf s;
  s.albedo = vec3(0.9);
  s.rough  = m.rough;
  s.metal  = m.metal;
  s.emis   = vec3(0.0);
  s.aniso  = m.aniso;
  s.coat   = 0.0;
  s.wrap   = 0.0;

  if (m.id == 0){                       // liquid chrome
    s.albedo = vec3(0.955, 0.960, 0.965);
    s.rough  = clamp(m.rough + tfbm3(q * 5.0) * 0.09 - 0.03, 0.012, 1.0);
  }
  else if (m.id == 1){                  // anodised titanium
    float thickness = 300.0 + 260.0 * tfbm3(q * 2.2 + uTime * 0.03)
                            + 90.0 * sin(q.y * 5.0 + uTime * 0.25);
    float cosT = clamp(dot(n, normalize(uCamPos - p)), 0.0, 1.0);
    vec3 film = thinFilm(cosT, thickness, 2.20);
    vec3 base = vec3(0.62, 0.60, 0.58);   // titanium F0
    s.albedo = mix(base, base * film * 1.9, m.film);
    s.rough  = clamp(m.rough + tfbm2(q * 6.0) * 0.10 - 0.04, 0.03, 1.0);
  }
  else if (m.id == 2 || m.id == 5){   // the two dielectrics
    // Whatever colour a piece of glass has comes from absorption along the
    // path, not from an albedo, so both share one branch here and differ
    // only in uAbsorb and uDispersion.
    s.albedo = vec3(0.03);
    s.metal  = 0.0;
    s.rough  = m.rough;
  }
  else if (m.id == 3){                  // brushed alloy
    s.albedo = vec3(0.90, 0.90, 0.88);
    // fine brush grain in the roughness, not the normal: cheaper, and it
    // survives minification without aliasing into sparkle
    float grain = tfbm2(vec3(q.x * 90.0, q.y * 3.0, q.z * 90.0));
    s.rough  = clamp(m.rough + (grain - 0.5) * 0.22, 0.04, 1.0);
  }
  else {                                  // molten core
    float depth = clamp(1.0 - length(q) / 1.05, 0.0, 1.0);
    float veins = tfbm3(q * 3.4 + vec3(0.0, uTime * 0.12, 0.0));
    float heat  = clamp(depth * 1.25 + veins * 0.55 - 0.25, 0.0, 1.0);
    float kelvin = mix(1100.0, 2400.0, heat);
    s.albedo = vec3(0.10, 0.085, 0.08);
    s.metal  = 0.15;
    s.rough  = clamp(m.rough + veins * 0.2, 0.1, 1.0);
    s.emis   = blackbody(kelvin) * pow(heat, 3.0) * 7.5 * m.emis
             * (0.85 + 0.15 * sin(uTime * 1.7 + veins * 9.0));
  }

  return s;
}

/* ── lighting ──────────────────────────────────────────────────────────── */

/* What a reflected ray is allowed to see.

   Deliberately cheap: no shadow marches, no ambient occlusion, and above all
   no second bounce. Calling the full shading function from inside a
   reflection is how a scene that renders in four milliseconds starts taking
   four hundred; every floor pixel would then run two soft-shadow marches and
   another reflection march of its own. At this size nobody can tell. */
vec3 shadeApprox(vec3 p, vec3 n, vec3 rd){
  Surf s = describe(p / uScale, p, n, matCurrent());
  vec3 f0 = mix(vec3(0.04), s.albedo, s.metal);
  float NoV = clamp(dot(n, -rd), 1e-4, 1.0);
  vec2 ab = envBRDFApprox(NoV, max(s.rough, 0.20));

  vec3 col = envColor(reflect(rd, n), max(s.rough, 0.20), uRimBoost) * (f0 * ab.x + ab.y);
  col += s.albedo * (1.0 - s.metal) * envColor(n, 0.92, uRimBoost) * 0.55;
  col += s.emis;
  return col;
}

vec3 brdfDirect(vec3 n, vec3 v, vec3 l, vec3 lcol, Surf s, vec3 f0, vec3 diffCol, vec3 T, vec3 B){
  vec3 h = normalize(v + l);
  float NoL = clamp(dot(n, l), 0.0, 1.0);
  if (NoL <= 0.0 && s.metal > 0.5) return vec3(0.0);
  float NoV = clamp(dot(n, v), 1e-4, 1.0);
  float NoH = clamp(dot(n, h), 0.0, 1.0);
  float VoH = clamp(dot(v, h), 0.0, 1.0);

  float a = max(s.rough * s.rough, 2e-3);

  float D, V;
  if (s.aniso > 0.01){
    // Filament's parameterisation: keeps the average roughness constant as
    // the anisotropy is dialled up, so the surface does not get brighter.
    float at = max(a * (1.0 + s.aniso), 2e-3);
    float ab = max(a * (1.0 - s.aniso), 2e-3);
    D = D_GGX_aniso(NoH, dot(T, h), dot(B, h), at, ab);
    V = V_SmithGGX_aniso(dot(T, v), dot(B, v), dot(T, l), dot(B, l), NoV, NoL, at, ab);
  } else {
    D = D_GGX(NoH, a);
    V = V_SmithGGX(NoV, NoL, a);
  }

  vec3 F = F_Schlick(f0, VoH);
  vec3 spec = D * V * F;

  // Wrapped diffuse. Half a subsurface term for the price of a max().
  float wrap = s.wrap;
  float diffN = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 diff = diffCol * INV_PI * diffN;

  vec3 outc = (diff + spec) * lcol * NoL;

  if (s.coat > 0.0){
    float Dc = D_GGX(NoH, 0.09);
    float Vc = V_SmithGGX(NoV, NoL, 0.09);
    float Fc = F_Schlick(0.04, 1.0, VoH) * s.coat;
    outc += Dc * Vc * Fc * lcol * NoL;
  }
  return outc;
}

vec3 shadeSurface(vec3 p, vec3 n, vec3 rd, Surf s, float ao, float shadowScale){
  vec3 v = -rd;
  float NoV = clamp(dot(n, v), 1e-4, 1.0);

  vec3 f0 = mix(vec3(0.04), s.albedo, s.metal);
  vec3 diffCol = s.albedo * (1.0 - s.metal);

  vec3 T = tangentField(p, n);
  vec3 B = normalize(cross(n, T));

  vec3 col = vec3(0.0);

  vec3 lk = normalize(L_KEY), lf = normalize(L_FILL), lr = normalize(L_RIM);
  float shK = mix(1.0, softShadow(p + n * 0.012, lk, 12.0), shadowScale);
  float shF = mix(1.0, softShadow(p + n * 0.012, lf,  9.0), shadowScale * 0.6);

  /* Written as a loop over the three sources. Measured: it makes no
     difference to compile time (a three-iteration constant-bound loop gets
     unrolled straight back into three copies) but it keeps the light rig in
     one place instead of three parallel edits. */
  vec3 lDir[3]; lDir[0] = lk; lDir[1] = lf; lDir[2] = lr;
  vec3 lCol[3]; lCol[0] = C_KEY * shK; lCol[1] = C_FILL * shF; lCol[2] = C_RIM * (1.0 + uRimBoost);
  for (int i = 0; i < 3; i++) col += brdfDirect(n, v, lDir[i], lCol[i], s, f0, diffCol, T, B);

  // ── image based ────────────────────────────────────────────────────────
  vec2 ab = envBRDFApprox(NoV, s.rough);

  vec3 R = reflect(rd, n);
  // Stretch the reflection vector for anisotropy: the bent normal trick.
  if (s.aniso > 0.01){
    vec3 aniDir = B;
    vec3 aniT = cross(aniDir, v);
    vec3 aniN = cross(aniT, aniDir);
    vec3 bent = normalize(mix(n, aniN, s.aniso * (1.0 - s.rough)));
    R = reflect(rd, bent);
  }

  vec3 envSpec = envColor(R, s.rough, uRimBoost);

  // one bounce: if the reflected ray hits the sculpture again, use what is
  // actually there instead of the sky. Only worth doing when smooth.
  if (uReflect > 0.5 && s.rough < 0.34){
    float t0, t1;
    vec3 ro2 = p + n * 0.02;
    if (sphereRange(ro2, R, uBound, t0, t1)){
      bool hit;
      float t = marchSDF(ro2, R, max(t0, 0.01), min(t1, 8.0), 0.0015, uReflSteps, hit);
      if (hit){
        vec3 p2 = ro2 + R * t;
        vec3 n2 = nrmS(p2, 0.0025);
        envSpec = mix(envSpec, shadeApprox(p2, n2, R), 0.9);
      }
    }
  }

  vec3 irradiance = envColor(n, 0.92, uRimBoost);   // a very rough lookup is a
                                                    // perfectly good diffuse probe
  col += diffCol * irradiance * ao * (1.0 - s.metal) * 0.65;
  vec3 specIBL = envSpec * (f0 * ab.x + ab.y) * ao;
  col += specIBL;
  col += multiScatter(f0, ab, envSpec) * ao;

  if (s.coat > 0.0){
    vec2 abc = envBRDFApprox(NoV, 0.09);
    col += envColor(reflect(rd, n), 0.09, uRimBoost) * (0.04 * abc.x + abc.y) * s.coat * ao;
  }

  col += s.emis;
  return col;
}

/* ── transmission ──────────────────────────────────────────────────────── */

// March from just inside the surface until the field turns positive again.
vec3 exitPoint(vec3 ro, vec3 rd, out bool ok){
  float t = 0.02;
  ok = false;
  for (int i = 0; i < uTransSteps; i++){
    vec3 p = ro + rd * t;
    float d = -mapS(p);              // inside: distance to the boundary
    if (d < 0.0012){ ok = true; break; }
    t += max(d * 0.75, 0.006);
    if (t > 5.0) break;
  }
  return ro + rd * t;
}

/* A cheap floor sample, for rays that are not primary.

   Without this the glass only ever refracts the sky, and the sky below the
   horizon is nearly black, so a clear dielectric came out looking like dark
   chrome. Letting the refracted ray find the floor grid gives it something
   with structure to bend, which is the cue that reads as glass rather than
   as a dark blob. No shadows and no reflections: it is seen through two
   refractions and a Beer-Lambert term, and none of that would survive. */
vec3 floorCheap(vec3 ro, vec3 rd, out bool hit){
  hit = false;
  if (rd.y > -1e-4) return vec3(0.0);
  float t = (FLOOR_Y - ro.y) / rd.y;
  if (t <= 0.0 || t > 30.0) return vec3(0.0);
  hit = true;

  vec3 p = ro + rd * t;
  float w = t * (2.4 / uRes.y) / max(abs(rd.y), 0.02);
  vec2 g  = abs(fract(p.xz * 0.5 - 0.5) - 0.5) / max(w * 0.5, 1e-4);
  vec2 g2 = abs(fract(p.xz * 0.1 - 0.5) - 0.5) / max(w * 0.1, 1e-4);
  float line  = 1.0 - min(min(g.x,  g.y),  1.0);
  float line2 = 1.0 - min(min(g2.x, g2.y), 1.0);

  vec3 c = vec3(0.020, 0.023, 0.025);
  c += vec3(0.55, 0.72, 0.20) * line  * 0.16;
  c += vec3(0.30, 0.36, 0.40) * line2 * 0.22;
  return c;
}

// One channel of dispersion: in through the surface, across the interior,
// out the far side, then whatever the environment has to say.
vec3 backdropFor(vec3 ro, vec3 rd, float rough){
  bool fh;
  vec3 fc = floorCheap(ro, rd, fh);
  return fh ? fc : envColor(rd, rough, uRimBoost);
}

vec3 refractChannel(vec3 p, vec3 n, vec3 rd, float ior){
  vec3 dir = refract(rd, n, 1.0 / ior);
  if (dot(dir, dir) < 1e-6) return envColor(reflect(rd, n), 0.02, uRimBoost);

  bool ok;
  vec3 p2 = exitPoint(p - n * 0.008, dir, ok);
  if (!ok) return backdropFor(p, dir, 0.05);

  vec3 n2 = -nrmS(p2, 0.0022);
  vec3 out2 = refract(dir, n2, ior);
  if (dot(out2, out2) < 1e-6) out2 = reflect(dir, n2);   // total internal reflection

  // Beer-Lambert. The obsidian absorbs hard so thickness reads as darkness;
  // the crystal barely absorbs at all, so thickness reads as depth.
  float pathLen = distance(p, p2);
  vec3 absorb = exp(-uAbsorb * pathLen * 1.1);

  return backdropFor(p2, normalize(out2), 0.03) * absorb;
}

/* ── the preview orbs ──────────────────────────────────────────────────────
   Same BRDF as the sculpture, none of the expensive parts: no shadow march,
   no ambient occlusion, no second bounce, and for the dielectrics a single
   refraction instead of an interior march per wavelength. They are 40 pixels
   across. Everything that got cut would be invisible at that size and each
   one of them would have cost as much as the sculpture itself. */
vec3 shadeOrb(vec3 q, vec3 p, vec3 n, vec3 rd, Mat m, float gain){
  Surf s = describe(q, p, n, m);
  vec3 v = -rd;
  float NoV = clamp(dot(n, v), 1e-4, 1.0);

  if (m.trans > 0.5){
    vec3 dir = refract(rd, n, 1.0 / m.ior);
    vec3 back = backdropFor(p + dir * 0.55, dir, 0.05) * exp(-m.absorb * 0.9);
    float F = F_Schlick(0.04, 1.0, NoV);
    return mix(back, envColor(reflect(rd, n), m.rough, uRimBoost), clamp(F * 3.1, 0.06, 1.0)) * gain;
  }

  vec3 f0 = mix(vec3(0.04), s.albedo, s.metal);
  vec3 diffCol = s.albedo * (1.0 - s.metal);
  vec3 T = normalize(cross(n, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 B = normalize(cross(n, T));

  vec3 col = vec3(0.0);
  vec3 oDir[3]; oDir[0] = normalize(L_KEY); oDir[1] = normalize(L_FILL); oDir[2] = normalize(L_RIM);
  vec3 oCol[3]; oCol[0] = C_KEY; oCol[1] = C_FILL; oCol[2] = C_RIM * (1.0 + uRimBoost);
  for (int i = 0; i < 3; i++) col += brdfDirect(n, v, oDir[i], oCol[i], s, f0, diffCol, T, B);

  /* Out on the ring an orb is lit a stop and a half brighter than the
     sculpture, because a mirror in a dark room is a dark ball: correct, and
     useless as a swatch. A preview has to be legible before it is accurate.

     The gain is handed in rather than fixed, and it falls to one as an orb
     nears the sculpture. Both handovers depend on that. An arriving orb stops
     being drawn and becomes part of the field at the moment of contact, and a
     departing one appears out of the field at the pinch; if the two were lit
     differently, the same ball would change brightness on the frame it
     changed owner. Tie the gain to how far out it is and the seam closes
     itself, for both directions, with no extra uniform. */
  vec2 ab = envBRDFApprox(NoV, s.rough);
  col += envColor(reflect(rd, n), s.rough, uRimBoost) * (f0 * ab.x + ab.y) * gain;
  col += diffCol * envColor(n, 0.92, uRimBoost) * 0.60 * gain;
  col *= gain;
  col += s.emis;
  return col;
}

/* ── the floor ─────────────────────────────────────────────────────────── */

vec3 shadeFloor(vec3 p, vec3 rd, float t){
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 v = -rd;

  // Analytic filter width instead of fwidth(): the derivative of a value that
  // came out of a branchy march is garbage at the silhouette, and a grid line
  // that flickers there is the first thing anyone notices.
  float w = t * (2.4 / uRes.y) / max(abs(rd.y), 0.02);

  vec2 g = abs(fract(p.xz * 0.5 - 0.5) - 0.5) / max(w * 0.5, 1e-4);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec2 g2 = abs(fract(p.xz * 0.1 - 0.5) - 0.5) / max(w * 0.1, 1e-4);
  float line2 = 1.0 - min(min(g2.x, g2.y), 1.0);

  float rough = 0.44 + 0.18 * tfbm2(vec3(p.x, 0.0, p.z) * 0.8);
  vec3 base = vec3(0.014, 0.016, 0.017);
  vec3 col = base;
  // The grid is a hint that there is a floor, not a feature. At any more
  // than this the accent colour stops being an accent.
  col += vec3(0.55, 0.72, 0.20) * line * 0.035;
  col += vec3(0.30, 0.36, 0.40) * line2 * 0.07;

  float sh = softShadow(p + n * 0.02, normalize(L_KEY), 8.0);
  float ao = 1.0;
  {
    // contact darkening under the sculpture, from the field itself
    float d = mapS(p + n * 0.05);
    ao = clamp(d * 1.6, 0.12, 1.0);
  }

  vec3 R = reflect(rd, n);
  vec3 env = envColor(R, rough, uRimBoost);

  // the sculpture, mirrored in the floor
  if (uReflect > 0.5){
    float t0, t1;
    vec3 ro2 = p + n * 0.02;
    if (sphereRange(ro2, R, uBound, t0, t1)){
      bool hit;
      float tt = marchSDF(ro2, R, max(t0, 0.01), min(t1, 10.0), 0.002, uReflSteps, hit);
      if (hit){
        vec3 p2 = ro2 + R * tt;
        vec3 n2 = nrmS(p2, 0.0025);
        env = mix(env, shadeApprox(p2, n2, R), 0.82);
      }
    }
  }

  float NoV = clamp(dot(n, v), 1e-4, 1.0);
  vec2 ab = envBRDFApprox(NoV, rough);
  vec3 f0 = vec3(0.035);

  col = col * (0.22 + 0.78 * sh) * ao;
  // ab.y is the grazing-angle bias term, and it gets large near the horizon —
  // which is correct, and is also why this needs no extra multiplier on top
  col += env * (f0 * ab.x + ab.y) * ao * 0.78;
  col += vec3(0.018, 0.021, 0.024) * ao;

  return col;
}

/* ── main ──────────────────────────────────────────────────────────────── */

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;

  vec4 pNear = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 pFar  = uInvViewProj * vec4(ndc,  1.0, 1.0);
  vec3 ro = uCamPos;
  vec3 rd = normalize(pFar.xyz / pFar.w - pNear.xyz / pNear.w);

  // half the angular size of one pixel: the march's stopping criterion
  // scales with distance so distant geometry is not marched to a precision
  // no one can see.
  float pixelRadius = 1.2 / uRes.y;

  Hit h = trace(ro, rd, pixelRadius);

  vec3 col;
  float dist = -1.0;

  if (h.id == 0){
    // The backdrop gets a tenth of the sources: enough that the room still
    // glows where a light is, not so much that a softbox becomes a panel.
    col = envColor(rd, 0.0, uRimBoost, 0.10);
    col = min(col, vec3(1.2));
    gl_FragDepth = 1.0;
  }
  else {
    vec3 p = ro + rd * h.t;
    dist = h.t;

    if (h.id == 2){
      col = shadeFloor(p, rd, h.t);
    } else if (h.id >= 10){
      int k = h.id - 10;
      vec3 c = uOrbPos[k];
      vec3 n = normalize(p - c);
      // 1.55 out on the ring, 1.0 once it is close enough to be merging
      float og = mix(1.0, 1.55, smoothstep(1.25, 1.95, length(c)));
      col = shadeOrb((p - c) / max(uOrbR[k], 1e-3), p, n, rd, matAt(k), og);
    } else {
      vec3 n = nrmS(p, max(0.0009, 0.0012 * h.t));
      Surf s = describe(p / uScale, p, n, matCurrent());
      float ao = calcAO(p, n);

      if (uTrans > 0.5){
        // dielectric: Fresnel splits the ray between a mirror and a prism
        float NoV = clamp(dot(n, -rd), 1e-4, 1.0);
        float F = F_Schlick(0.04, 1.0, NoV);
        vec3 refl = envColor(reflect(rd, n), s.rough, uRimBoost);

        // one interior march per channel; this is where dispersion comes
        // from, and doing it with a single shared path is exactly the
        // shortcut that makes most real-time glass look like plastic
        float d = uDispersion;
        vec3 tr = vec3(
          refractChannel(p, n, rd, uIor - d).r,
          refractChannel(p, n, rd, uIor    ).g,
          refractChannel(p, n, rd, uIor + d).b);

        col = mix(tr, refl, clamp(F * 3.1, 0.05, 1.0)) * ao;
        col += s.emis;
      } else {
        col = shadeSurface(p, n, rd, s, ao, 1.0);
      }
      // the absorb burst, bright enough to cover the switch happening under it
      col += vec3(0.80, 0.94, 0.52) * uFlash * uFlash * 4.5;
    }

    vec4 clip = uViewProj * vec4(p, 1.0);
    gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  }

  // A little distance haze so the floor recedes instead of just going flat.
  float fog = 1.0 - exp(-max(h.t - 3.0, 0.0) * 0.035);
  col = mix(col, vec3(0.011, 0.013, 0.015), clamp(fog, 0.0, 0.9));

  col *= uExposure;

  oColor = vec4(col, 1.0);
  oDist  = vec4(dist, 0.0, 0.0, 1.0);
}
`;
