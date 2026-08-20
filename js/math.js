/* ══════════════════════════════════════════════════════════════════════════
   math.js — the parts of a linear-algebra library this page actually uses.
   Column-major Float32Array(16) matrices, i.e. what WebGL wants without a
   transpose. No gl-matrix; there is no dependency to add.
   ══════════════════════════════════════════════════════════════════════════ */

export const clamp  = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp   = (a, b, t) => a + (b - a) * t;
export const sat    = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (e0, e1, x) => { const t = sat((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
export const smootherstep = (e0, e1, x) => { const t = sat((x - e0) / (e1 - e0)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const TAU = Math.PI * 2;

/* Frame-rate-independent exponential smoothing.
   `rate` is roughly "how many e-foldings per second"; higher = snappier.
   The pow() form is what makes it correct at 30fps AND 144fps — the naive
   `a += (b-a)*0.1` is not, and it is the single most common source of
   "why is the animation faster on my other monitor". */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/* Critically damped spring. Returns the new [value, velocity].
   Stable for large dt because it solves the ODE analytically rather than
   integrating it. omega = 2*PI*frequency. */
export function spring(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const nx = (f * x + dt * v + hhoo * target) * det;
  const nv = (v + hoo * (target - x)) * det;
  return [nx, nv];
}

/* ── vec3 ──────────────────────────────────────────────────────────────── */

export const v3 = (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]);

export function v3set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
export function v3copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
export function v3add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; }
export function v3sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; }
export function v3scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; }
export function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function v3len(a) { return Math.hypot(a[0], a[1], a[2]); }

export function v3cross(o, a, b) {
  const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
  o[0] = ay * bz - az * by;
  o[1] = az * bx - ax * bz;
  o[2] = ax * by - ay * bx;
  return o;
}

export function v3norm(o, a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l > 1e-8) { const i = 1 / l; o[0] = a[0] * i; o[1] = a[1] * i; o[2] = a[2] * i; }
  else { o[0] = 0; o[1] = 0; o[2] = 0; }
  return o;
}

export function v3lerp(o, a, b, t) {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}

export function v3damp(o, a, b, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return v3lerp(o, a, b, t);
}

/* ── mat4 ──────────────────────────────────────────────────────────────── */

export const m4 = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

export function m4identity(o) {
  o[0]=1;o[1]=0;o[2]=0;o[3]=0; o[4]=0;o[5]=1;o[6]=0;o[7]=0;
  o[8]=0;o[9]=0;o[10]=1;o[11]=0; o[12]=0;o[13]=0;o[14]=0;o[15]=1;
  return o;
}

/* Reverse-Z is not used here: WebGL clip space is [-1,1] in z and there is no
   glClipControl, so we stick to the classic OpenGL projection. */
export function m4perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  o[0]=f/aspect; o[1]=0; o[2]=0; o[3]=0;
  o[4]=0; o[5]=f; o[6]=0; o[7]=0;
  o[8]=0; o[9]=0; o[10]=(far + near) * nf; o[11]=-1;
  o[12]=0; o[13]=0; o[14]=2 * far * near * nf; o[15]=0;
  return o;
}

/* Sub-pixel jitter for TAA: shifts the projection by (jx,jy) in NDC units. */
export function m4jitter(o, jx, jy) { o[8] += jx; o[9] += jy; return o; }

export function m4lookAt(o, eye, center, up) {
  const z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
  let l = Math.hypot(z0, z1, z2);
  if (l < 1e-8) return m4identity(o);
  l = 1 / l;
  const zx = z0 * l, zy = z1 * l, zz = z2 * l;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-8) { xx = 1; xy = 0; xz = 0; } else { l = 1 / l; xx *= l; xy *= l; xz *= l; }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
  o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
  o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
  o[12]=-(xx*eye[0] + xy*eye[1] + xz*eye[2]);
  o[13]=-(yx*eye[0] + yy*eye[1] + yz*eye[2]);
  o[14]=-(zx*eye[0] + zy*eye[1] + zz*eye[2]);
  o[15]=1;
  return o;
}

export function m4mul(o, a, b) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  for (let i = 0; i < 4; i++) {
    const b0=b[i*4], b1=b[i*4+1], b2=b[i*4+2], b3=b[i*4+3];
    o[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
    o[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
    o[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
    o[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
  }
  return o;
}

export function m4invert(o, a) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];

  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10,
        b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12,
        b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30,
        b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;

  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return m4identity(o);
  det = 1 / det;

  o[0]=(a11*b11-a12*b10+a13*b09)*det;  o[1]=(a02*b10-a01*b11-a03*b09)*det;
  o[2]=(a31*b05-a32*b04+a33*b03)*det;  o[3]=(a22*b04-a21*b05-a23*b03)*det;
  o[4]=(a12*b08-a10*b11-a13*b07)*det;  o[5]=(a00*b11-a02*b08+a03*b07)*det;
  o[6]=(a32*b02-a30*b05-a33*b01)*det;  o[7]=(a20*b05-a22*b02+a23*b01)*det;
  o[8]=(a10*b10-a11*b08+a13*b06)*det;  o[9]=(a01*b08-a00*b10-a03*b06)*det;
  o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
  o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
  o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
  return o;
}

/* Transform a point (w=1) and divide through — used to project the mouse. */
export function m4xformPoint(o, m, p) {
  const x=p[0], y=p[1], z=p[2];
  let w = m[3]*x + m[7]*y + m[11]*z + m[15];
  w = w || 1;
  o[0] = (m[0]*x + m[4]*y + m[8]*z + m[12]) / w;
  o[1] = (m[1]*x + m[5]*y + m[9]*z + m[13]) / w;
  o[2] = (m[2]*x + m[6]*y + m[10]*z + m[14]) / w;
  return o;
}

/* ── Catmull-Rom through camera keyframes ──────────────────────────────── */

/* Centripetal Catmull-Rom (alpha=0.5). Uniform CR self-intersects on the kind
   of loose control points a camera path has; centripetal provably does not. */
export function catmullRom(out, pts, t) {
  const n = pts.length;
  const s = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(Math.floor(s), n - 2);
  const f = s - i;

  const p0 = pts[Math.max(i - 1, 0)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(i + 2, n - 1)];

  const f2 = f * f, f3 = f2 * f;
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (
      2 * p1[k] +
      (-p0[k] + p2[k]) * f +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3
    );
  }
  return out;
}

/* ── Halton, for TAA jitter ────────────────────────────────────────────── */

export function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/* The first 8 (Halton(2), Halton(3)) pairs, remapped to [-0.5, 0.5].
   Precomputed because they are needed every frame and never change. */
export const HALTON_8 = (() => {
  const a = [];
  for (let i = 1; i <= 8; i++) a.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  return a;
})();

/* ── misc ──────────────────────────────────────────────────────────────── */

export function hash11(n) {
  n = Math.sin(n) * 43758.5453123;
  return n - Math.floor(n);
}

export const fmt = (n) => n.toLocaleString('en-US');

export function fmtShort(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}
