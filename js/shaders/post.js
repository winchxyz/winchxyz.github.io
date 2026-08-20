/* ══════════════════════════════════════════════════════════════════════════
   post.js — everything that happens after the scene exists.

   composite → TAA → bloom (prefilter, 6 down, 6 up) → streak → final grade.
   All of it in linear HDR until the very last line, where the only sRGB
   conversion in the whole page happens.
   ══════════════════════════════════════════════════════════════════════════ */

import { HEAD, HASH, NOISE, COLOR } from './lib.js';

const P = HEAD + HASH + COLOR + `in vec2 vUv;\n`;

/* ── composite: scene + additive particles ─────────────────────────────── */

export const COMPOSITE_FRAG = P + `
out vec4 oColor;
uniform sampler2D uScene;
uniform sampler2D uParticles;
uniform float uParticleGain;

void main(){
  vec3 s = texture(uScene, vUv).rgb;
  vec3 p = texture(uParticles, vUv).rgb;
  oColor = vec4(s + p * uParticleGain, 1.0);
}
`;

/* ── temporal anti-aliasing ────────────────────────────────────────────────
   The raymarch is dithered per pixel and jittered per frame, so TAA is not
   just anti-aliasing here — it is what turns the noise the marcher is
   deliberately introducing back into detail. Turning it off does not make
   the image sharper, it makes it grainy.
   ─────────────────────────────────────────────────────────────────────── */

export const TAA_FRAG = P + `
out vec4 oColor;

uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDist;      // ray distance from the raymarch pass, -1 = sky

uniform mat4  uInvViewProj;      // this frame, unjittered
uniform mat4  uPrevViewProj;     // last frame, unjittered
uniform vec3  uCamPos;
uniform vec2  uRes;
uniform float uFeedback;
uniform float uReset;

vec3 clipAABB(vec3 mn, vec3 mx, vec3 q){
  vec3 c = 0.5 * (mx + mn);
  vec3 e = 0.5 * (mx - mn) + 1e-5;
  vec3 o = q - c;
  vec3 ts = abs(o / e);
  float t = max(ts.x, max(ts.y, ts.z));
  return t > 1.0 ? c + o / t : q;
}

void main(){
  vec3 cur = texture(uCurrent, vUv).rgb;

  if (uReset > 0.5){ oColor = vec4(cur, 1.0); return; }

  // ── reproject ──────────────────────────────────────────────────────────
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 nearP = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 farP  = uInvViewProj * vec4(ndc,  1.0, 1.0);
  vec3 rd = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);

  float dist = texture(uDist, vUv).x;
  // A sky pixel has no position, only a direction. Reprojecting it at a very
  // large distance is exactly right for a rotating camera and costs nothing.
  vec3 world = uCamPos + rd * (dist > 0.0 ? dist : 6000.0);

  vec4 pc = uPrevViewProj * vec4(world, 1.0);
  vec2 prevUv = (pc.xy / pc.w) * 0.5 + 0.5;

  bool valid = pc.w > 0.0 &&
               all(greaterThanEqual(prevUv, vec2(0.0))) &&
               all(lessThanEqual(prevUv, vec2(1.0)));

  if (!valid){ oColor = vec4(cur, 1.0); return; }

  vec3 hist = texture(uHistory, prevUv).rgb;

  // ── neighbourhood clipping ─────────────────────────────────────────────
  // In YCoCg, not RGB. The error distribution is close to axis-aligned in
  // YCoCg, so the clip box actually fits it; in RGB the box is far too
  // generous on the chroma axes and colour ghosts survive it.
  vec2 tx = 1.0 / uRes;
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 mn = vec3( 1e9), mx = vec3(-1e9);

  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec3 c = rgbToYCoCg(texture(uCurrent, vUv + vec2(float(x), float(y)) * tx).rgb);
      m1 += c; m2 += c * c;
      mn = min(mn, c); mx = max(mx, c);
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  const float GAMMA = 1.25;
  vec3 lo = max(mu - GAMMA * sigma, mn);
  vec3 hi = min(mu + GAMMA * sigma, mx);

  vec3 histY = clipAABB(lo, hi, rgbToYCoCg(hist));
  hist = ycoCgToRgb(histY);

  // Luminance weighting (Karis / Lottes): weight each sample by 1/(1+luma)
  // so a single very bright pixel cannot dominate the blend and smear.
  float wc = 1.0 / (1.0 + luma(cur));
  float wh = 1.0 / (1.0 + luma(hist));
  float f = uFeedback;
  vec3 result = (cur * wc * (1.0 - f) + hist * wh * f) / max((wc * (1.0 - f) + wh * f), 1e-5);

  oColor = vec4(result, 1.0);
}
`;

/* ── bloom ─────────────────────────────────────────────────────────────── */

export const BLOOM_PREFILTER_FRAG = P + `
out vec4 oColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

// Karis average: weight each 2x2 group by 1/(1+luma) before summing. A single
// firefly pixel otherwise survives the whole mip chain and pulses.
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d){
  float wa = 1.0 / (1.0 + luma(a));
  float wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-5);
}

void main(){
  vec3 a = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 col = karis(a, b, c, d);

  col = min(col, vec3(uClamp));

  // Unity's soft-knee curve: quadratic between threshold-knee and
  // threshold+knee, linear above. A hard cutoff makes bloom pop on and off
  // as a highlight drifts across the threshold.
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / max(4.0 * uKnee + 1e-5, 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);

  oColor = vec4(col * contrib, 1.0);
}
`;

/* 13-tap downsample (Jimenez, Next Generation Post Processing in Call of Duty:
   Advanced Warfare). Five overlapping 2x2 groups: the centre one carries half
   the weight, the four corner ones an eighth each. It is stable under motion
   in a way a plain box filter is not. */
export const BLOOM_DOWN_FRAG = P + `
out vec4 oColor;
uniform sampler2D uTex;
uniform vec2 uTexel;

void main(){
  vec2 t = uTexel;
  vec3 a = texture(uTex, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture(uTex, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture(uTex, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture(uTex, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 e = texture(uTex, vUv + t * vec2( 1.0, -1.0)).rgb;
  vec3 f = texture(uTex, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 g = texture(uTex, vUv                        ).rgb;
  vec3 h = texture(uTex, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 i = texture(uTex, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 j = texture(uTex, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 k = texture(uTex, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 l = texture(uTex, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 m = texture(uTex, vUv + t * vec2( 2.0,  2.0)).rgb;

  vec3 r  = (d + e + i + j) * 0.125;        // centre group, half the weight
  r += (a + b + g + f) * 0.03125;
  r += (b + c + h + g) * 0.03125;
  r += (f + g + l + k) * 0.03125;
  r += (g + h + m + l) * 0.03125;

  oColor = vec4(r, 1.0);
}
`;

/* 9-tap tent upsample. This outputs ONLY the blurred contribution — the
   accumulation onto the larger level is done by hardware additive blending,
   which is why there is no uBase sampler here. Sampling the destination and
   adding it in the shader as well would double every level on the way back
   up the chain, and the result looks like a plausible but far too hot bloom. */
export const BLOOM_UP_FRAG = P + `
out vec4 oColor;
uniform sampler2D uTex;      // the smaller level being upsampled
uniform vec2  uTexel;
uniform float uRadius;

void main(){
  vec2 t = uTexel * uRadius;
  vec3 s =
      texture(uTex, vUv + t * vec2(-1.0, -1.0)).rgb * 1.0
    + texture(uTex, vUv + t * vec2( 0.0, -1.0)).rgb * 2.0
    + texture(uTex, vUv + t * vec2( 1.0, -1.0)).rgb * 1.0
    + texture(uTex, vUv + t * vec2(-1.0,  0.0)).rgb * 2.0
    + texture(uTex, vUv                        ).rgb * 4.0
    + texture(uTex, vUv + t * vec2( 1.0,  0.0)).rgb * 2.0
    + texture(uTex, vUv + t * vec2(-1.0,  1.0)).rgb * 1.0
    + texture(uTex, vUv + t * vec2( 0.0,  1.0)).rgb * 2.0
    + texture(uTex, vUv + t * vec2( 1.0,  1.0)).rgb * 1.0;
  s *= 1.0 / 16.0;

  oColor = vec4(s, 1.0);
}
`;

/* Anamorphic streak: a wide horizontal-only blur on the smallest bloom level.
   Real anamorphic lenses do this because the cylindrical element focuses one
   axis differently. It is the single cheapest thing that makes a render look
   photographed rather than rendered. */
export const STREAK_FRAG = P + `
out vec4 oColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec2  uDir;
uniform float uSpread;

void main(){
  vec3 s = vec3(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++){
    float fi = float(i);
    float w = exp(-fi * fi / 40.0);
    s += texture(uTex, vUv + uDir * uTexel * fi * uSpread).rgb * w;
    wsum += w;
  }
  oColor = vec4(s / wsum, 1.0);
}
`;

/* ── final ─────────────────────────────────────────────────────────────── */

export const FINAL_FRAG = HEAD + HASH + NOISE + COLOR + `
in vec2 vUv;
out vec4 oColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uStreak;

uniform vec2  uRes;
uniform float uTime;
uniform float uFrame;

uniform float uBloomAmount;
uniform float uStreakAmount;
uniform float uExposure;
uniform float uCA;          // chromatic aberration
uniform float uVignette;
uniform float uGrain;
uniform float uSat;
uniform float uContrast;
uniform vec3  uLift;
uniform vec3  uGain;
uniform float uFade;        // page-load / photo-mode wipe
uniform float uScanline;

vec3 sampleCA(sampler2D t, vec2 uv, float amt){
  // Radial: the aberration must grow toward the edges the way a real lens
  // does. Applying it uniformly across the frame reads as a broken decode.
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * r2 * amt;
  return vec3(
    texture(t, uv + off).r,
    texture(t, uv).g,
    texture(t, uv - off).b);
}

void main(){
  vec2 uv = vUv;

  // very slight barrel distortion, so the frame has a lens
  vec2 cc = uv - 0.5;
  uv = 0.5 + cc * (1.0 + dot(cc, cc) * 0.022);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 col = sampleCA(uScene, uv, uCA);
  vec3 bloom  = sampleCA(uBloom, uv, uCA * 1.6);
  vec3 streak = texture(uStreak, uv).rgb;

  col += bloom * uBloomAmount;
  col += streak * uStreakAmount * vec3(0.70, 0.85, 1.0);

  col *= uExposure;

  // ── tone ───────────────────────────────────────────────────────────────
  col = tonemapACES(col);

  // ── grade ──────────────────────────────────────────────────────────────
  col = col * uGain + uLift * (1.0 - col);
  col = (col - 0.5) * uContrast + 0.5;
  float l = luma(col);
  col = mix(vec3(l), col, uSat);
  col = clamp(col, 0.0, 1.0);

  // ── lens ───────────────────────────────────────────────────────────────
  float r = length((vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
  col *= 1.0 - smoothstep(0.42, 1.15, r) * uVignette;

  // Grain in the shadows more than the highlights, which is how film
  // actually behaves and why uniform grain always looks like an overlay.
  float g = ign(gl_FragCoord.xy, uFrame) - 0.5;
  col += g * uGrain * (0.35 + 0.65 * (1.0 - luma(col)));

  col *= 1.0 - uScanline * 0.06 * (0.5 + 0.5 * sin(gl_FragCoord.y * 2.0));

  col *= uFade;

  // sRGB, then one 8-bit step of dither. Without the dither the near-black
  // gradient behind the type bands into rings on any decent display.
  col = toSRGB(col);
  col += ditherOffset(gl_FragCoord.xy, uFrame);

  oColor = vec4(col, 1.0);
}
`;
