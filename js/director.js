/* ══════════════════════════════════════════════════════════════════════════
   director.js — what the scene is doing, and why.

   Each section owns a keyframe. Scrolling through a section holds its
   keyframe for the first half and then eases into the next one, so the
   camera arrives as the next block of type does rather than drifting the
   whole way. Everything that reaches the renderer is damped, frame-rate
   independently, so a section jump is a move rather than a cut.
   ══════════════════════════════════════════════════════════════════════════ */

import { damp, clamp, lerp, smoothstep } from './math.js';
import { MATERIALS } from './content.js';

/* ── keyframes ─────────────────────────────────────────────────────────── */

const K = [
  { /* 00 hero */
    camPos: [-1.05, 0.26, 4.35], camTarget: [-0.92, 0.00, 0], fov: 42,
    shape: 0.00, detail: 1.00, scale: 1.00, rimBoost: 0.0, sceneExposure: 1.0,
    pGain: 1.00, pCurl: 1.15, pAttract: 0.85, pTangent: 0.85, pSpin: 0.30, pSize: 1.6, pDamp: 0.55, pLife: 0.13,
    clothOn: 0.0, bloom: 0.85, streak: 0.30, ca: 0.55, vignette: 0.72, grain: 0.030,
  },
  { /* 01 whoami */
    camPos: [-2.75, 0.62, 3.45], camTarget: [-0.62, 0.02, 0], fov: 39,
    shape: 0.85, detail: 0.75, scale: 0.98, rimBoost: 0.25, sceneExposure: 0.98,
    pGain: 0.62, pCurl: 0.85, pAttract: 1.15, pTangent: 0.95, pSpin: 0.20, pSize: 1.3, pDamp: 0.70, pLife: 0.11,
    clothOn: 0.0, bloom: 0.72, streak: 0.22, ca: 0.45, vignette: 0.80, grain: 0.030,
  },
  { /* 02 materials */
    camPos: [-2.60, 0.30, 4.00], camTarget: [-0.75, -0.05, 0], fov: 38,
    shape: 0.06, detail: 0.55, scale: 1.06, rimBoost: 0.55, sceneExposure: 1.05,
    pGain: 0.30, pCurl: 0.55, pAttract: 1.35, pTangent: 1.00, pSpin: 0.12, pSize: 1.0, pDamp: 0.85, pLife: 0.09,
    clothOn: 0.0, bloom: 0.95, streak: 0.42, ca: 0.60, vignette: 0.78, grain: 0.026,
  },
  { /* 03 physics */
    camPos: [-0.97, 0.34, 4.80], camTarget: [-1.05, -0.26, -0.30], fov: 47,
    shape: 1.00, detail: 0.60, scale: 0.92, rimBoost: 0.30, sceneExposure: 0.95,
    pGain: 0.22, pCurl: 0.70, pAttract: 0.60, pTangent: 0.60, pSpin: 0.10, pSize: 1.0, pDamp: 0.80, pLife: 0.10,
    clothOn: 1.0, bloom: 0.70, streak: 0.18, ca: 0.40, vignette: 0.74, grain: 0.030,
  },
  { /* 04 work */
    camPos: [-2.85, 1.45, 3.40], camTarget: [-0.70, 0.10, 0], fov: 35,
    shape: 2.00, detail: 0.45, scale: 1.00, rimBoost: 0.15, sceneExposure: 0.92,
    pGain: 0.48, pCurl: 0.95, pAttract: 0.95, pTangent: 0.80, pSpin: 0.26, pSize: 1.2, pDamp: 0.65, pLife: 0.12,
    clothOn: 0.0, bloom: 0.62, streak: 0.20, ca: 0.42, vignette: 0.86, grain: 0.032,
  },
  { /* 05 numbers */
    camPos: [-1.35, 1.95, 3.30], camTarget: [0, -0.08, 0], fov: 37,
    shape: 2.55, detail: 0.50, scale: 0.96, rimBoost: 0.45, sceneExposure: 0.98,
    pGain: 0.78, pCurl: 1.20, pAttract: 1.05, pTangent: 0.90, pSpin: 0.34, pSize: 1.4, pDamp: 0.60, pLife: 0.14,
    clothOn: 0.0, bloom: 0.78, streak: 0.30, ca: 0.50, vignette: 0.82, grain: 0.030,
  },
  { /* 06 contact */
    camPos: [-1.05, 0.14, 3.60], camTarget: [-0.60, 0.0, 0], fov: 46,
    shape: 3.00, detail: 0.55, scale: 1.02, rimBoost: 1.05, sceneExposure: 1.08,
    pGain: 1.25, pCurl: 1.45, pAttract: 1.25, pTangent: 0.95, pSpin: 0.44, pSize: 1.8, pDamp: 0.50, pLife: 0.16,
    clothOn: 0.0, bloom: 1.05, streak: 0.55, ca: 0.70, vignette: 0.66, grain: 0.028,
  },
];

const NUMERIC = Object.keys(K[0]).filter((k) => typeof K[0][k] === 'number');
const VECTOR  = Object.keys(K[0]).filter((k) => Array.isArray(K[0][k]));

export class Director {
  constructor() {
    this.section = 0;
    this.local = 0;
    this.materialIndex = 0;
    this.calm = false;
    this.photo = false;

    this.target = structuredClone(K[0]);
    this.current = structuredClone(K[0]);

    this.mouse = { x: 0, y: 0, sx: 0, sy: 0, down: false, inside: false };
    this.mouseForce = 0;
    this.burst = 0;
    this.fade = 0;

    // physics sliders, owned by the UI
    this.cloth = { wind: 1.05, gravity: 9.81, stiff: 0.72, damp: 0.986, iters: 8, pinned: 1 };
    this.grab = { active: 0, pos: [0, 0, 0], idx: [0, 0] };

    this.out = {};
  }

  setSection(i, local) {
    if (i !== this.section) this.burst = 0.45;
    this.section = clamp(i, 0, K.length - 1);
    this.local = clamp(local, 0, 1);
  }

  setMaterial(i) {
    if (i === this.materialIndex) return;
    this.materialIndex = clamp(i, 0, MATERIALS.length - 1);
    this.burst = 0.65;
  }

  /* Blend the current keyframe into the next one across the back half of the
     section, so the move lands with the next block of type. */
  computeTarget() {
    const i = this.section;
    const j = Math.min(i + 1, K.length - 1);
    const t = smoothstep(0.52, 1.0, this.local);

    for (const k of NUMERIC) this.target[k] = lerp(K[i][k], K[j][k], t);
    for (const k of VECTOR) {
      const a = K[i][k], b = K[j][k];
      const o = this.target[k];
      for (let n = 0; n < a.length; n++) o[n] = lerp(a[n], b[n], t);
    }
  }

  update(dt, renderer) {
    const d = Math.min(dt, 0.05);
    this.computeTarget();

    const rate = this.calm ? 1.6 : 2.8;
    for (const k of NUMERIC) this.current[k] = damp(this.current[k], this.target[k], rate, d);
    for (const k of VECTOR) {
      const c = this.current[k], t = this.target[k];
      for (let n = 0; n < c.length; n++) c[n] = damp(c[n], t[n], rate, d);
    }

    // pointer parallax — small, damped, and disabled entirely in calm mode
    this.mouse.sx = damp(this.mouse.sx, this.mouse.x, 3.2, d);
    this.mouse.sy = damp(this.mouse.sy, this.mouse.y, 3.2, d);
    const par = this.calm ? 0.0 : 1.0;

    const c = this.current;
    const camPos = [
      c.camPos[0] + this.mouse.sx * 0.55 * par,
      c.camPos[1] + this.mouse.sy * 0.35 * par,
      c.camPos[2],
    ];
    const camTarget = [
      c.camTarget[0] + this.mouse.sx * 0.10 * par,
      c.camTarget[1] + this.mouse.sy * 0.06 * par,
      c.camTarget[2],
    ];

    this.burst = damp(this.burst, 0, 6.0, d);

    // mouse force ramps in only while the pointer is over the canvas
    const wantForce = this.mouse.inside ? (this.mouse.down ? -3.4 : 1.9) : 0;
    this.mouseForce = damp(this.mouseForce, wantForce, 6.0, d);

    const ray = renderer.mouseRay(this.mouse.x, this.mouse.y);

    const mat = MATERIALS[this.materialIndex];
    const mp = mat.p;

    const calmK = this.calm ? 0.45 : 1.0;

    const o = this.out;
    o.camPos = camPos;
    o.camTarget = camTarget;
    o.fov = c.fov;

    o.shape = c.shape;
    o.detail = c.detail;
    o.scale = c.scale;
    o.rimBoost = c.rimBoost;
    o.sceneExposure = c.sceneExposure;

    o.matId = mat.id;
    o.rough = mp.rough;
    o.metal = mp.metal;
    o.ior = mp.ior;
    o.aniso = mp.aniso;
    o.film = mp.film;
    o.trans = mp.trans;
    o.emissive = mp.emissive ?? 0;

    o.pGain = c.pGain;
    o.pCurl = c.pCurl * calmK;
    o.pAttract = c.pAttract;
    o.pTangent = c.pTangent;
    o.pSpin = c.pSpin * calmK;
    o.pSize = c.pSize;
    o.pDamp = c.pDamp;
    o.pLife = c.pLife;
    o.pBurst = this.burst;

    o.mouseRo = ray.ro;
    o.mouseRd = ray.rd;
    o.mouseForce = this.mouseForce;

    o.clothOn = c.clothOn;
    o.cWind = this.cloth.wind;
    o.cGravity = this.cloth.gravity;
    o.cStiff = this.cloth.stiff;
    o.cDamp = this.cloth.damp;
    o.cIters = this.cloth.iters;
    o.cPinned = this.cloth.pinned;
    o.grabActive = this.grab.active;
    o.grabPos = this.grab.pos;
    o.grabIdx = this.grab.idx;

    o.bloom = c.bloom;
    o.bloomThreshold = 1.05;
    o.bloomRadius = 1.0;
    o.streak = c.streak;
    o.ca = c.ca * 0.0018;
    o.vignette = c.vignette;
    o.grain = this.photo ? 0.012 : c.grain;
    o.sat = 1.06;
    o.contrast = 1.045;
    o.lift = [0.004, 0.006, 0.008];
    o.gain = [1.00, 1.005, 0.995];
    o.exposure = 1.0;
    o.scanline = 0;
    o.fade = this.fade;
    o.taaFeedback = this.calm ? 0.93 : 0.90;

    return o;
  }
}

export const SECTION_COUNT = K.length;
