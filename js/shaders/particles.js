/* ══════════════════════════════════════════════════════════════════════════
   particles.js — a GPU particle system with no vertex buffer.

   State lives in two RGBA32F textures. The solver is a fullscreen pass with
   two colour attachments, so position and velocity are written in the same
   draw. The renderer binds no attributes at all: gl_VertexID indexes straight
   into the state texture, which is the cheapest way there is to draw a
   quarter of a million points.
   ══════════════════════════════════════════════════════════════════════════ */

import { HEAD, HASH, NOISE, SDF } from './lib.js';

/* ── solver ────────────────────────────────────────────────────────────── */

export const PARTICLE_SIM_FRAG = HEAD + HASH + NOISE + SDF + `

in vec2 vUv;

layout(location = 0) out vec4 oPos;   // xyz = position, w = life in [0,1]
layout(location = 1) out vec4 oVel;   // xyz = velocity, w = per-particle seed

uniform sampler2D uPos;
uniform sampler2D uVel;

uniform vec2  uSimRes;
uniform float uDt;
uniform float uTime;
uniform float uFrame;

uniform float uShape;
uniform float uDetail;
uniform float uScale;

uniform vec3  uMouseRo;
uniform vec3  uMouseRd;
uniform float uMouseForce;

uniform float uCurl;       // strength of the ambient flow
uniform float uAttract;    // pull onto the sculpture's surface
uniform float uTangent;    // how much of the normal velocity to strip
uniform float uDamp;
uniform float uSpin;       // orbital swirl about Y
uniform float uLifeRate;
uniform float uBurst;      // section transitions kick the whole field

float sdfAt(vec3 p){ return sculpture(p / uScale, uTime, uShape, uDetail) * uScale; }

vec3 sdfGrad(vec3 p){
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.02;
  return normalize(
    k.xyy * sdfAt(p + k.xyy * e) +
    k.yyx * sdfAt(p + k.yyx * e) +
    k.yxy * sdfAt(p + k.yxy * e) +
    k.xxx * sdfAt(p + k.xxx * e));
}

// Archimedes' hat-box theorem: sampling z uniformly and then taking the
// circle of the matching radius gives a genuinely uniform sphere. Picking
// two angles uniformly instead — the version everyone writes first — piles
// a third of the particles onto the two poles.
vec3 uniformSphere(vec2 u){
  float z = u.x * 2.0 - 1.0;
  float a = u.y * TAU;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z);
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, tc, 0);
  vec4 V = texelFetch(uVel, tc, 0);

  vec3 p = P.xyz;
  vec3 v = V.xyz;
  float life = P.w;
  float seed = V.w;

  uint id = uint(tc.y) * uint(uSimRes.x) + uint(tc.x);

  float dt = clamp(uDt, 0.0, 1.0 / 45.0);   // a stalled tab must not detonate the sim

  // ── forces ─────────────────────────────────────────────────────────────
  vec3 acc = vec3(0.0);

  // ambient divergence-free flow
  vec3 flow = curlNoise(p * 0.62 + vec3(0.0, uTime * 0.024, 0.0));
  flow += 0.42 * curlNoise(p * 1.71 + vec3(11.0, uTime * 0.045, 3.0));
  acc += flow * uCurl;

  // slow orbit, so the cloud reads as one body rather than a fog
  acc += vec3(-p.z, 0.0, p.x) * uSpin;

  // pull onto the level set, then take away the velocity component that
  // points through it — the result is particles that flow ALONG the
  // surface instead of oscillating across it
  float d = sdfAt(p);
  vec3  n = sdfGrad(p);
  acc -= n * clamp(d, -0.9, 0.9) * uAttract;

  float nearSurf = exp(-abs(d) * 3.4);
  v -= n * dot(n, v) * uTangent * nearSurf;

  // gentle containment so nothing escapes to infinity
  float rr = length(p);
  acc -= p * smoothstep(2.6, 5.2, rr) * 2.4;

  // ── mouse ──────────────────────────────────────────────────────────────
  if (uMouseForce != 0.0){
    vec3 toP = p - uMouseRo;
    float tt = max(dot(toP, uMouseRd), 0.0);
    vec3 closest = uMouseRo + uMouseRd * tt;
    vec3 dv = p - closest;
    float dl = length(dv) + 1e-5;
    acc += (dv / dl) * uMouseForce * exp(-dl * dl * 1.9);
  }

  // ── integrate ──────────────────────────────────────────────────────────
  v += acc * dt;
  v *= exp(-uDamp * dt);                 // frame-rate independent drag
  float sp = length(v);
  if (sp > 1.9) v *= 1.9 / sp;           // clamp before it can tunnel, and
                                         // well below anything that reads as fast
  p += v * dt;

  life -= dt * uLifeRate * (0.55 + seed * 0.9);

  // ── respawn ────────────────────────────────────────────────────────────
  // The !(x < big) form is deliberate: every comparison against NaN is
  // false, so this catches a poisoned particle as well as a distant one.
  // Without it a single NaN is permanent — it never leaves the buffer.
  bool bad = !(dot(p, p) < 1.0e8) || !(dot(v, v) < 1.0e8);

  if (life <= 0.0 || rr > 6.0 || bad){
    uint s = pcg(id + uint(uFrame) * 9781u);
    vec2 u = vec2(pcgF(s), pcgF(s + 1u));
    float rad = 1.28 + 0.85 * pcgF(s + 2u);
    p = uniformSphere(u) * rad * uScale;
    p.y += (pcgF(s + 3u) - 0.5) * 0.4;
    v = curlNoise(p * 0.7) * 0.35;
    life = 1.0;
    seed = pcgF(s + 4u);
  }

  // a transition kick, so changing section visibly disturbs the field
  if (uBurst > 0.0){
    v += normalize(p + 1e-4) * uBurst * (0.5 + seed);
  }

  oPos = vec4(p, life);
  oVel = vec4(v, seed);
}
`;

/* ── renderer ──────────────────────────────────────────────────────────── */

export const PARTICLE_VERT = HEAD + `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform vec2  uSimRes;
uniform mat4  uViewProj;
uniform vec3  uCamPos;
uniform float uPointScale;
uniform float uSizeJitter;

out vec3  vVel;
out float vLife;
out float vDist;
out float vSeed;

void main(){
  int w = int(uSimRes.x);
  ivec2 tc = ivec2(gl_VertexID % w, gl_VertexID / w);

  vec4 P = texelFetch(uPos, tc, 0);
  vec4 V = texelFetch(uVel, tc, 0);

  vec4 clip = uViewProj * vec4(P.xyz, 1.0);
  gl_Position = clip;

  vDist = distance(P.xyz, uCamPos);
  vVel  = V.xyz;
  vLife = P.w;
  vSeed = V.w;

  // Perspective size attenuation. clip.w is the view depth, so 1/w is the
  // correct falloff; clamping the low end stops near particles becoming
  // screen-filling discs when the camera moves inside the cloud.
  float s = uPointScale / max(clip.w, 0.25);
  s *= 0.6 + uSizeJitter * V.w;
  s *= smoothstep(0.0, 0.12, P.w) * smoothstep(1.0, 0.86, P.w) + 0.15;

  gl_PointSize = clamp(s, 1.0, 40.0);

  // a point behind the eye still rasterises unless it is pushed out of clip
  if (clip.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const PARTICLE_FRAG = HEAD + HASH + `
in vec3  vVel;
in float vLife;
in float vDist;
in float vSeed;

out vec4 oColor;

uniform sampler2D uSceneDist;   // ray distance from the raymarch pass
uniform vec2  uRes;
uniform float uIntensity;
uniform float uFade;

void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;

  // A Gaussian rather than a hard disc. Additive blending sums thousands of
  // these; a hard edge turns the cloud into visible confetti the moment two
  // of them overlap.
  float a = exp(-r2 * 3.6) * (1.0 - r2);

  // Soft particles: fade out as the sprite approaches the surface behind it,
  // so the cloud intersects the sculpture instead of stamping a flat disc on
  // it. The raymarch wrote its ray distance to attachment 1 for exactly this.
  float sd = texture(uSceneDist, gl_FragCoord.xy / uRes).x;
  if (sd > 0.0) a *= smoothstep(0.0, 0.30, sd - vDist);

  // life envelope
  a *= smoothstep(0.0, 0.14, vLife) * smoothstep(1.0, 0.80, vLife);

  float sp = length(vVel);
  vec3 col = mix(vec3(0.055, 0.085, 0.030), vec3(0.78, 0.95, 0.31), smoothstep(0.015, 0.5, sp));
  col = mix(col, vec3(1.00, 1.00, 0.93), smoothstep(0.5, 1.25, sp));
  col *= 0.72 + 0.55 * vSeed;

  oColor = vec4(col * a * uIntensity * uFade, a);
}
`;
