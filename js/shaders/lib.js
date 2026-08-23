/* ══════════════════════════════════════════════════════════════════════════
   lib.js: shared GLSL. Every shader in this page is assembled from these
   chunks, so there is exactly one implementation of each hash, each noise
   and each BRDF term rather than six subtly different ones.

   Nothing here declares a uniform. Everything takes its parameters as
   arguments, which is what makes the same signed distance field usable from
   the raymarcher, the particle solver and the cloth collider without any of
   them having to agree on a uniform block.
   ══════════════════════════════════════════════════════════════════════════ */

export const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#define PI    3.14159265359
#define TAU   6.28318530718
#define INV_PI 0.31830988618
#define EPS   1e-6
`;

/* ── hashing ───────────────────────────────────────────────────────────── */

export const HASH = `
// Dave Hoskins' hashes. Chosen over the classic sin(dot(p,k))*43758.5453
// because that one has visible axis-aligned structure on some mobile GPUs
// where sin() is evaluated at lower precision.
float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash23(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// Integer hash: for anything that must be bit-exact and stable forever,
// like per-particle seeds. PCG-style; passes far better statistics than
// float hashes and costs the same.
uint pcg(uint v){
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
float pcgF(uint v){ return float(pcg(v)) * (1.0 / 4294967296.0); }

// Interleaved Gradient Noise (Jimenez, Next Generation Post Processing in
// Call of Duty: Advanced Warfare). The best value-for-ALU screen-space
// dither there is: one madd and a fract.
float ign(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float ign(vec2 p, float frame){
  p += 5.588238 * mod(frame, 64.0);   // the golden-ratio temporal offset
  return ign(p);
}
`;

/* ── noise ─────────────────────────────────────────────────────────────── */

export const NOISE = `
// Value noise with an ANALYTIC gradient (Inigo Quilez).
// Returns vec4(value, d/dx, d/dy, d/dz).
//
// The gradient is why this is here rather than simplex noise: curl noise
// needs six partial derivatives of a three-component potential. Done by
// finite differences that is eighteen noise evaluations per particle per
// frame. Done analytically it is three. At a quarter of a million particles
// that difference is the whole budget.
vec4 noised(vec3 x){
  vec3 p = floor(x);
  vec3 w = fract(x);

  vec3 u  = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);

  float a = hash13(p + vec3(0.0, 0.0, 0.0));
  float b = hash13(p + vec3(1.0, 0.0, 0.0));
  float c = hash13(p + vec3(0.0, 1.0, 0.0));
  float d = hash13(p + vec3(1.0, 1.0, 0.0));
  float e = hash13(p + vec3(0.0, 0.0, 1.0));
  float f = hash13(p + vec3(1.0, 0.0, 1.0));
  float g = hash13(p + vec3(0.0, 1.0, 1.0));
  float h = hash13(p + vec3(1.0, 1.0, 1.0));

  float k0 =   a;
  float k1 =   b - a;
  float k2 =   c - a;
  float k3 =   e - a;
  float k4 =   a - b - c + d;
  float k5 =   a - c - e + g;
  float k6 =   a - b - e + f;
  float k7 = - a + b + c - d + e - f - g + h;

  return vec4(
    k0 + k1*u.x + k2*u.y + k3*u.z + k4*u.x*u.y + k5*u.y*u.z + k6*u.z*u.x + k7*u.x*u.y*u.z,
    du * vec3(
      k1 + k4*u.y + k6*u.z + k7*u.y*u.z,
      k2 + k5*u.z + k4*u.x + k7*u.z*u.x,
      k3 + k6*u.x + k5*u.y + k7*u.x*u.y
    )
  );
}

float vnoise(vec3 x){ return noised(x).x; }

float fbm(vec3 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= octaves) break;
    s += a * vnoise(p);
    n += a;
    p = p * 2.02 + vec3(11.7, 5.3, 19.1);
    a *= 0.5;
  }
  return s / max(n, EPS);
}

// Divergence-free curl noise, built from the analytic gradients above.
// Exactly divergence-free, not approximately, which is what stops the
// particles from piling up in sinks over time.
vec3 curlNoise(vec3 p){
  vec4 nx = noised(p);
  vec4 ny = noised(p + vec3( 31.416,  17.130,  47.530));
  vec4 nz = noised(p + vec3(-13.700,  59.200,  23.900));
  // potential P = (nx.x, ny.x, nz.x); gradients live in .yzw
  return vec3(
    nz.z - ny.w,   // dPz/dy - dPy/dz
    nx.w - nz.y,   // dPx/dz - dPz/dx
    ny.y - nx.z    // dPy/dx - dPx/dy
  );
}

// Worley / cellular, F1 only. Used for the ceramic glaze and the carbon weave.
float worley(vec3 p){
  vec3 i = floor(p), f = fract(p);
  float d = 1.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++){
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(i + o) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
`;

/* ── signed distance fields ────────────────────────────────────────────── */

export const SDF = `
/* Value noise, read from a 64^3 texture instead of computed.

   This is the single most important line in the file for compile time. The
   analytic version, eight hash calls and a quintic interpolant, is perhaps
   a hundred instructions, which is nothing at runtime. But it lives inside
   the distance field, the distance field is inlined at every march step, at
   every normal tap and at every ambient occlusion tap, and the compiler
   expands all of it. Measured on an RTX 4070, stubbing this out took the
   raymarch program from 65 seconds of compilation to 15.

   The texture is a lattice of random bytes with REPEAT wrapping, so hardware
   trilinear filtering IS the interpolation. It is trilinear rather than
   quintic, which is very slightly blockier, and it is one fetch. */
uniform highp sampler3D uNoise;

float tnoise(vec3 x){ return texture(uNoise, x * (1.0 / 64.0)).r; }

float tfbm2(vec3 p){ return (tnoise(p) + 0.5 * tnoise(p * 2.03 + 7.31)) * (1.0 / 1.5); }
float tfbm3(vec3 p){ return (tnoise(p) + 0.5 * tnoise(p * 2.03 + 7.31) + 0.25 * tnoise(p * 4.07 + 13.7)) * (1.0 / 1.75); }

mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float sdSphere(vec3 p, float r){ return length(p) - r; }

float sdBox(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r){ return sdBox(p, b - r) - r; }

float sdTorus(vec3 p, vec2 t){
  return length(vec2(length(p.xz) - t.x, p.y)) - t.y;
}

float sdOctahedron(vec3 p, float s){
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

float sdBoxFrame(vec3 p, vec3 b, float e){
  p = abs(p) - b;
  vec3 q = abs(p + e) - e;
  return min(min(
    length(max(vec3(p.x, q.y, q.z), 0.0)) + min(max(p.x, max(q.y, q.z)), 0.0),
    length(max(vec3(q.x, p.y, q.z), 0.0)) + min(max(q.x, max(p.y, q.z)), 0.0)),
    length(max(vec3(q.x, q.y, p.z), 0.0)) + min(max(q.x, max(q.y, p.z)), 0.0));
}

// Inigo Quilez' polynomial smooth minimum. The -k*h*(1-h) term is what makes
// it C1 continuous; the naive exponential smin is not, and the seam shows up
// as a crease in the specular highlight even when the silhouette looks fine.
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k){ return -smin(-a, -b, k); }

/* ── the sculpture ─────────────────────────────────────────────────────────
   Four forms, cross-faded by \`shape\` in [0,3].

   Blending with mix() rather than smin() is deliberate. A convex combination
   of two 1-Lipschitz fields is itself 1-Lipschitz, so sphere tracing stays
   provably safe through the entire transition. smin() between two forms that
   are far apart is not, and the failure looks like the surface tearing open
   for half a second in the middle of the morph.
   ────────────────────────────────────────────────────────────────────────── */

// 0: a sphere the noise will not let settle
//
// The band test is the difference between this page running and this page
// tripping the driver's watchdog. Evaluating the noise at every one of a
// hundred-odd march steps costs three gradient-noise lookups per step for a
// value that only matters within a tenth of a unit of the surface. Outside
// that band the undisplaced sphere, minus the largest displacement the noise
// can possibly produce, is already a valid under-estimate of the true
// distance, which is the only thing sphere tracing requires, and it costs
// one length(). The march therefore pays for the noise perhaps five times
// per pixel instead of a hundred and thirty.
float formLiquid(vec3 p, float t, float detail){
  float d = length(p) - 1.0;
  if (detail <= 0.001) return d;

  const float K   = 0.18;    // displacement gain
  const float AMP = 0.131;   // = 0.725 * K, the largest |displacement|

  if (d > AMP * 2.0) return d - AMP * detail;

  vec3 q = p * 1.5 + vec3(0.0, t * 0.026, t * 0.012);
  float n = tnoise(q) + 0.45 * tnoise(q * 2.03 + 7.31);   // mean ~0.725
  return d + (n - 0.725) * K * detail;
}

// 1: a gyroid lattice carved out of a hollow shell
float formLattice(vec3 p, float t){
  vec3 q = p * 3.3;
  q.xz = rot2(t * 0.016) * q.xz;
  // |grad(dot(sin q, cos q.zxy))| is bounded by 2*sqrt(3); dividing by the
  // domain scale times three keeps the field an under-estimate, which is the
  // only thing sphere tracing actually requires.
  float g = (abs(dot(sin(q), cos(q.zxy))) - 0.47) / (3.3 * 3.0);
  float outer =  length(p) - 1.02;
  float inner =  0.58 - length(p);
  return max(max(outer, inner), g);
}

// 2: a rounded box frame, slowly turning
float formFrame(vec3 p, float t){
  vec3 q = p;
  q.xz = rot2(t * 0.022) * q.xz;
  q.xy = rot2(0.62) * q.xy;
  return sdBoxFrame(q, vec3(0.80), 0.06) - 0.035;
}

// 3: a rectangular torus given three half-turns of twist
float formRing(vec3 p, float t){
  vec3 q = p;
  q.xz = rot2(t * 0.028) * q.xz;
  float a = atan(q.z, q.x);
  vec2 pl = vec2(length(q.xz) - 0.82, q.y);
  pl = rot2(a * 1.5) * pl;
  vec2 e = abs(pl) - vec2(0.30, 0.085);
  float d = min(max(e.x, e.y), 0.0) + length(max(e, 0.0));
  return d * 0.62;   // the polar twist inflates the gradient; pay it back here
}

float sculpture(vec3 p, float t, float shape, float detail){
  p /= 1.0;
  /* The pair is chosen by the floor of s and weighted by what is left over,
     which works for every value except the top of the range, and the top of
     the range is where the last section sits.

     At s = 3 exactly, floor gives 3, no pair is named for it so the selector
     falls through to the frame, and fract gives 0 so the frame is what gets
     returned at full weight. Scrolling to the contact section therefore
     crossfaded almost all the way to the ring and then snapped back to a cube
     on the final value. Hold the index one below the top and let the leftover
     reach one instead. */
  float s = clamp(shape, 0.0, 3.0);
  int i = int(min(floor(s), 2.0));
  float f = smoothstep(0.0, 1.0, s - float(i));

  /* Select, then blend, rather than a branch per pair.

     The obvious formulation names formLattice in two branches, formFrame in
     two and formRing in two, so seven copies of form code get compiled into
     every one of the dozen places the field is inlined. Choosing by index
     compiles each form exactly once. */
  float d0 = formLiquid(p, t, detail);
  float d1 = formLattice(p, t);
  float d2 = formFrame(p, t);
  float d3 = formRing(p, t);

  float a = i == 0 ? d0 : (i == 1 ? d1 : d2);
  float b = i == 0 ? d1 : (i == 1 ? d2 : d3);
  return mix(a, b, f);
}

// The whole scene: sculpture (id 1) over an infinite floor (id 2).
vec2 mapScene(vec3 p, float t, float shape, float detail){
  float ds = sculpture(p, t, shape, detail);
  float dg = p.y + 1.62;
  return dg < ds ? vec2(dg, 2.0) : vec2(ds, 1.0);
}

float mapDist(vec3 p, float t, float shape, float detail){
  return mapScene(p, t, shape, detail).x;
}

// Tetrahedron-technique normal: four taps instead of six, and no separate
// centre sample. Forward differences need the centre value and are biased
// half a texel off the surface, which shows up as a lighting shift exactly
// where the silhouette is.
vec3 calcNormal(vec3 p, float t, float shape, float detail, float e){
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapDist(p + k.xyy * e, t, shape, detail) +
    k.yyx * mapDist(p + k.yyx * e, t, shape, detail) +
    k.yxy * mapDist(p + k.yxy * e, t, shape, detail) +
    k.xxx * mapDist(p + k.xxx * e, t, shape, detail));
}
`;

/* ── physically based shading ──────────────────────────────────────────── */

export const PBR = `
// ── microfacet terms ─────────────────────────────────────────────────────
// Trowbridge-Reitz (GGX) normal distribution.
float D_GGX(float NoH, float a){
  float a2 = a * a;
  float d  = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

// Height-correlated Smith visibility (Heitz). This is V, not G: the
// 1/(4·NoL·NoV) denominator is already folded in, so specular is D*V*F and
// dividing again is the single most common way to end up with a suspiciously
// dark metal.
float V_SmithGGX(float NoV, float NoL, float a){
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

vec3  F_Schlick(vec3 f0, float u){ float f = pow(1.0 - u, 5.0); return f0 + (1.0 - f0) * f; }
float F_Schlick(float f0, float f90, float u){ return f0 + (f90 - f0) * pow(1.0 - u, 5.0); }

// Anisotropic GGX (Burley / Filament form). at and ab are the roughness
// along the tangent and bitangent.
float D_GGX_aniso(float NoH, float ToH, float BoH, float at, float ab){
  float a2 = at * ab;
  vec3  v  = vec3(ab * ToH, at * BoH, a2 * NoH);
  float v2 = dot(v, v);
  float w2 = a2 / max(v2, 1e-8);
  return a2 * w2 * w2 * INV_PI;
}
float V_SmithGGX_aniso(float ToV, float BoV, float ToL, float BoL,
                       float NoV, float NoL, float at, float ab){
  float lv = NoL * length(vec3(at * ToV, ab * BoV, NoV));
  float ll = NoV * length(vec3(at * ToL, ab * BoL, NoL));
  return 0.5 / max(lv + ll, 1e-5);
}

// Charlie sheen: the cloth term. Inverted Gaussian; this is what makes
// fabric bright at grazing angles instead of dark like a dielectric.
float D_Charlie(float NoH, float r){
  float invR = 1.0 / max(r, 0.03);
  float cos2 = NoH * NoH;
  float sin2 = 1.0 - cos2;
  return (2.0 + invR) * pow(sin2, invR * 0.5) / TAU;
}
float V_Ashikhmin(float NoV, float NoL){
  return clamp(1.0 / (4.0 * (NoL + NoV - NoL * NoV)), 0.0, 1.0);
}

// Karis' mobile approximation of the split-sum environment BRDF (fitted by
// Dimitar Lazarov). Replaces the 2D LUT texture entirely, which matters here
// because there are no texture files.
vec2 envBRDFApprox(float NoV, float rough){
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572,  0.022);
  const vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.040);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

// Multi-scatter energy compensation (Fdez-Aguera). Without it every rough
// metal in the scene is visibly too dark, because single-scatter GGX throws
// away all the light that bounces twice inside the microsurface. Returns the
// extra radiance to ADD to the single-scatter specular.
vec3 multiScatter(vec3 f0, vec2 ab, vec3 irradiance){
  float Ess  = ab.x + ab.y;
  vec3  Favg = f0 + (1.0 - f0) * (1.0 / 21.0);
  vec3  Fms  = Favg * Ess / max(1.0 - Favg * (1.0 - Ess), 1e-4);
  return Fms * (1.0 - Ess) * irradiance;
}

// ── thin-film interference ───────────────────────────────────────────────
// Two reflections, one off the top of the oxide layer and one off the metal
// underneath, arriving out of phase by the optical path difference. The
// colour is a physical consequence of the film thickness and the viewing
// angle; there is no gradient texture and no palette anywhere in it.
vec3 thinFilm(float cosTheta, float thicknessNm, float etaFilm){
  float sinT2 = (1.0 - cosTheta * cosTheta) / (etaFilm * etaFilm);
  float cosT  = sqrt(max(0.0, 1.0 - sinT2));
  float opd   = 2.0 * etaFilm * thicknessNm * cosT;          // nanometres
  const vec3 lambda = vec3(680.0, 550.0, 440.0);             // R, G, B
  vec3 phase = TAU * opd / lambda + PI;                      // +PI: hard reflection
  return 0.5 + 0.5 * cos(phase);
}

// ── the environment ──────────────────────────────────────────────────────
// A studio, written down instead of photographed. Three soft rectangular
// sources and a graded backdrop. Roughness widens the sources, which is a
// cheap stand-in for a prefiltered radiance mip chain and is accurate enough
// that nobody has ever asked which HDRI this is.
float softbox(vec3 d, vec3 dir, vec2 halfSize, float soft){
  float z = dot(d, dir);
  if (z < 0.02) return 0.0;
  vec3 up = abs(dir.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 tx = normalize(cross(up, dir));
  vec3 ty = cross(dir, tx);
  vec2 q  = vec2(dot(d, tx), dot(d, ty)) / z;
  vec2 e  = max(abs(q) - halfSize, 0.0);
  return smoothstep(soft, 0.0, length(e)) * smoothstep(0.0, 0.06, z);
}

/* lightGain scales the emissive sources only, not the backdrop.

   A backlight points roughly where the camera is looking, so it lands in
   frame as a bright rectangle unless it is flagged off. A reflection of it
   is exactly what you want; a wall of it behind the type is not. Primary
   rays that hit nothing therefore ask for a fraction of the sources, and
   everything else asks for all of them. */
vec3 envColor(vec3 d, float rough, float rimBoost, float lightGain){
  float h = d.y * 0.5 + 0.5;

  // Backdrop. This is what a mirror sees when it is not looking at a light,
  // which on a chrome-heavy page is most of the surface; set it too dark and
  // the sculpture reads as a black ball with a hotspot rather than as metal.
  vec3 sky = mix(vec3(0.030, 0.034, 0.040), vec3(0.145, 0.156, 0.175), smoothstep(0.40, 1.0, h));
  sky = mix(vec3(0.016, 0.018, 0.022), sky, smoothstep(0.0, 0.46, h));

  // a broad overhead dome, so the top of every form is lifted off the floor
  sky += vec3(0.042, 0.048, 0.058) * smoothstep(-0.25, 1.0, d.y);

  float soft = 0.05 + rough * rough * 1.7;

  // key: large, high, slightly warm, camera left
  sky += lightGain * vec3(1.00, 0.96, 0.90) * 3.60 * softbox(d, normalize(vec3(-0.55, 0.72, 0.42)), vec2(0.30, 0.20), soft);
  // fill: cool, wide, camera right and low
  sky += lightGain * vec3(0.62, 0.72, 0.95) * 1.05 * softbox(d, normalize(vec3( 0.86, 0.10, 0.16)), vec2(0.62, 0.44), soft + 0.14);
  // Rim: the brand accent, behind the subject and hard off to camera right.
  // A backlight points roughly where the camera is looking, so it is visible
  // in frame unless it is pushed outside the field of view; at 60 degrees off
  // axis it rims the silhouette without becoming a green wall behind it.
  // This is the same reason a real product shot flags its backlight off.
  sky += lightGain * vec3(0.78, 0.95, 0.31) * (1.62 + rimBoost) * softbox(d, normalize(vec3(0.80, 0.30, -0.52)), vec2(0.26, 0.17), soft + 0.05);
  // a hard little specular sun so mirror-smooth metal has something to bite on
  sky += lightGain * vec3(1.0, 0.98, 0.94) * 5.5 * softbox(d, normalize(vec3(-0.30, 0.86, 0.40)), vec2(0.030, 0.030), soft * 0.35 + 0.006);

  return sky;
}

vec3 envColor(vec3 d, float rough, float rimBoost){ return envColor(d, rough, rimBoost, 1.0); }

// The three sources again, as punctual lights, for the diffuse and direct
// specular terms. Keeping them in one place means moving the key moves it
// in the reflections and in the shading at the same time.
const vec3 L_KEY  = vec3(-0.55,  0.72,  0.42);
const vec3 L_FILL = vec3( 0.86,  0.10,  0.16);
const vec3 L_RIM  = vec3( 0.80,  0.30, -0.52);
const vec3 C_KEY  = vec3(1.00, 0.96, 0.90) * 2.8;
const vec3 C_FILL = vec3(0.62, 0.72, 0.95) * 1.0;
const vec3 C_RIM  = vec3(0.78, 0.95, 0.31) * 1.5;
`;

/* ── colour ────────────────────────────────────────────────────────────── */

export const COLOR = `
// ACES, the full fit (Stephen Hill's RRT+ODT approximation) rather than the
// one-line Narkowicz curve. The difference only shows on very bright
// saturated highlights, which, on a page that is mostly chrome, is most of
// the interesting pixels. Written as columns because GLSL constructs
// matrices column-major and the published matrices are row-major.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);

const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 tonemapACES(vec3 c){
  c = ACES_IN * c;
  c = rrtOdtFit(c);
  c = ACES_OUT * c;
  return clamp(c, 0.0, 1.0);
}

vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// YCoCg. TAA neighbourhood clipping in RGB clips the chroma axes against a
// box that is wildly the wrong shape; in YCoCg the box is nearly aligned
// with how the error actually distributes, and the ghosting halves.
vec3 rgbToYCoCg(vec3 c){
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.50 * c.r             - 0.50 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycoCgToRgb(vec3 c){
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

// Planck locus, Neil Bartlett's fit. Used by the molten preset, so the shift
// from dull red to white is the real colour of a hot thing rather than a
// gradient somebody picked.
vec3 blackbody(float kelvin){
  float t = clamp(kelvin, 1000.0, 15000.0) / 100.0;
  vec3 c;
  if (t <= 66.0){
    c.r = 1.0;
    c.g = clamp(0.39008158 * log(t) - 0.63184144, 0.0, 1.0);
  } else {
    c.r = clamp(1.29293619 * pow(t - 60.0, -0.1332048), 0.0, 1.0);
    c.g = clamp(1.12989086 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  }
  if (t >= 66.0) c.b = 1.0;
  else if (t <= 19.0) c.b = 0.0;
  else c.b = clamp(0.54320679 * log(t - 10.0) - 1.19625409, 0.0, 1.0);
  return c;
}

// Dither, at exactly one 8-bit step. Without it the dark gradient behind the
// type bands into visible rings on an OLED.
//
// This uses interleaved gradient noise rather than an ordered Bayer matrix:
// Bayer needs a 64-entry lookup table, and a const int[64] indexed by a
// varying value is the kind of thing a driver is entitled to reject. IGN also
// looks better: no repeating 8x8 grid to spot once you have seen it once.
float ditherOffset(vec2 fragCoord, float frame){
  return (ign(fragCoord, frame) - 0.5) * (1.0 / 255.0);
}
`;

/* Convenience: the whole library, in dependency order. */
export const ALL = HEAD + HASH + NOISE + SDF + PBR + COLOR;
export const LIB_NO_SDF = HEAD + HASH + NOISE + PBR + COLOR;
