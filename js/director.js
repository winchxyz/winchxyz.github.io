/* ══════════════════════════════════════════════════════════════════════════
   director.js — what the scene is doing, and why.

   Each section owns a keyframe. Scrolling through a section holds its
   keyframe for the first half and then eases into the next one, so the camera
   arrives as the next block of type does rather than drifting the whole way.
   Everything that reaches the renderer is damped, frame-rate independently,
   so a section jump is a move rather than a cut.

   ── Composition is specified on the SCREEN, not in the world ──────────────

   The first version of this file named a camera position in world units per
   section. That framing is only correct at the one aspect ratio it was tuned
   at: the page's type sits in a centred, max-width column, so as the viewport
   widens the column stays put while a world-space camera offset keeps sliding
   the sculpture outward until it runs off the edge — which is exactly what
   happened at 16:9.

   So a keyframe now says where the sculpture should appear *on screen* and
   how much of the frame it should fill, and the camera is solved from that
   every frame against the current aspect ratio. The horizontal position is
   given as a fraction of the CONTENT COLUMN rather than of the viewport, so
   the sculpture tracks the type instead of the window.
   ══════════════════════════════════════════════════════════════════════════ */

import { damp, clamp, lerp, smoothstep } from './math.js';
import { MATERIALS } from './content.js';

/* Bounding radius of every form the sculpture takes. Must match R_BOUND in
   the raymarch shader, or the framing solve and the marcher disagree. */
const R_BOUND = 1.62;

/* How lively the particle field is, as one dial.

   The first pass had the cloud whipping around the sculpture fast enough to
   read as agitation rather than as atmosphere — it pulled the eye off the
   type, which is the opposite of what a background is for. Orbit speed is
   halved; the curl flow is toned down less, because that one contributes
   shape as much as speed. */
const SPIN_SCALE = 0.42;
const CURL_SCALE = 0.62;

/* ── keyframes ─────────────────────────────────────────────────────────────
   yaw / pitch  direction from the subject to the camera, radians
   fov          vertical field of view, degrees
   fill         subject diameter as a fraction of viewport HEIGHT
   fillW        the same as a fraction of viewport WIDTH — a cap, so a narrow
                window pulls the camera back instead of cropping
   fx           horizontal placement, as a fraction across the content column
   fy           vertical placement, as a fraction of viewport height
   pivot        world point to frame (the sculpture's centre unless the
                section has something else in shot)
   radius       what to fit, when it is not just the sculpture
   ─────────────────────────────────────────────────────────────────────── */

const K = [
  { /* 00 hero */
    yaw: -0.03, pitch: 0.06, fov: 42, fill: 0.58, fillW: 0.34, fx: 0.88, fy: 0.46,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 0.00, detail: 1.00, scale: 1.00, rimBoost: 0.0, sceneExposure: 1.0,
    pGain: 1.00, pCurl: 1.15, pAttract: 0.85, pTangent: 0.85, pSpin: 0.30, pSize: 1.6, pDamp: 0.55, pLife: 0.13,
    clothOn: 0.0, bloom: 0.85, streak: 0.30, ca: 0.55, vignette: 0.72, grain: 0.030,
  },
  { /* 01 whoami */
    yaw: -0.60, pitch: 0.17, fov: 39, fill: 0.66, fillW: 0.38, fx: 0.80, fy: 0.52,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 0.85, detail: 0.75, scale: 0.98, rimBoost: 0.25, sceneExposure: 0.98,
    pGain: 0.62, pCurl: 0.85, pAttract: 1.15, pTangent: 0.95, pSpin: 0.20, pSize: 1.3, pDamp: 0.70, pLife: 0.11,
    clothOn: 0.0, bloom: 0.72, streak: 0.22, ca: 0.45, vignette: 0.80, grain: 0.030,
  },
  { /* 02 materials */
    yaw: -0.52, pitch: 0.08, fov: 38, fill: 0.52, fillW: 0.30, fx: 0.97, fy: 0.50,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 0.06, detail: 0.55, scale: 1.06, rimBoost: 0.55, sceneExposure: 1.05,
    pGain: 0.30, pCurl: 0.55, pAttract: 1.35, pTangent: 1.00, pSpin: 0.12, pSize: 1.0, pDamp: 0.85, pLife: 0.09,
    clothOn: 0.0, bloom: 0.95, streak: 0.42, ca: 0.60, vignette: 0.78, grain: 0.026,
  },
  { /* 03 physics — the cloth is the subject here, not the sculpture.

       The sculpture used to sit at full size in front of the cloth, which
       hid the one thing this section exists to show. It is now small and
       BEHIND the cloth, so what you see is fabric deforming around a shape
       you can only make out through it — which is the demonstration. */
    // A three-quarter view, not head-on: folds and the bulge where the cloth
    // meets the sculpture read in silhouette, and face-on they do not.
    yaw: -0.30, pitch: 0.15, fov: 46, fill: 0.62, fillW: 0.35, fx: 0.86, fy: 0.50,
    pivot: [0.35, -0.32, 0.42], radius: 2.6,
    shape: 1.00, detail: 0.60, scale: 0.85, rimBoost: 0.30, sceneExposure: 0.95,
    pGain: 0.22, pCurl: 0.70, pAttract: 0.60, pTangent: 0.60, pSpin: 0.10, pSize: 1.0, pDamp: 0.80, pLife: 0.10,
    clothOn: 1.0, bloom: 0.70, streak: 0.18, ca: 0.40, vignette: 0.74, grain: 0.030,
  },
  { /* 04 work — the grid owns the page, so the sculpture sits high and small */
    yaw: -0.68, pitch: 0.40, fov: 35, fill: 0.46, fillW: 0.28, fx: 0.74, fy: 0.24,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 2.00, detail: 0.45, scale: 1.00, rimBoost: 0.15, sceneExposure: 0.92,
    pGain: 0.48, pCurl: 0.95, pAttract: 0.95, pTangent: 0.80, pSpin: 0.26, pSize: 1.2, pDamp: 0.65, pLife: 0.12,
    clothOn: 0.0, bloom: 0.62, streak: 0.20, ca: 0.42, vignette: 0.86, grain: 0.032,
  },
  { /* 05 numbers */
    yaw: -0.36, pitch: 0.50, fov: 37, fill: 0.54, fillW: 0.32, fx: 0.72, fy: 0.36,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 2.55, detail: 0.50, scale: 0.96, rimBoost: 0.45, sceneExposure: 0.98,
    pGain: 0.78, pCurl: 1.20, pAttract: 1.05, pTangent: 0.90, pSpin: 0.34, pSize: 1.4, pDamp: 0.60, pLife: 0.14,
    clothOn: 0.0, bloom: 0.78, streak: 0.30, ca: 0.50, vignette: 0.82, grain: 0.030,
  },
  { /* 06 contact */
    yaw: -0.26, pitch: 0.05, fov: 46, fill: 0.66, fillW: 0.38, fx: 0.80, fy: 0.52,
    pivot: [0, 0, 0], radius: R_BOUND,
    shape: 3.00, detail: 0.55, scale: 1.02, rimBoost: 1.05, sceneExposure: 1.08,
    pGain: 1.25, pCurl: 1.45, pAttract: 1.25, pTangent: 0.95, pSpin: 0.44, pSize: 1.8, pDamp: 0.50, pLife: 0.16,
    clothOn: 0.0, bloom: 1.05, streak: 0.55, ca: 0.70, vignette: 0.66, grain: 0.028,
  },
];

const NUMERIC = Object.keys(K[0]).filter((k) => typeof K[0][k] === 'number');
const VECTOR = Object.keys(K[0]).filter((k) => Array.isArray(K[0][k]));

/* The content column, matching --gut and --maxw in the stylesheet. The 3D is
   placed against this rather than against the window, so it stays in the same
   relationship to the type at every width. */
function contentColumn(vw) {
  const gut = Math.max(20, Math.min(76, vw * 0.05));
  const outer = Math.min(1320, vw);
  const left = (vw - outer) / 2 + gut;
  return { left, width: Math.max(120, outer - gut * 2) };
}

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

    // user orbit, layered on top of the keyframe direction
    this.orbit = { yaw: 0, pitch: 0, vy: 0, vp: 0 };

    this.cloth = { wind: 1.45, gravity: 9.81, stiff: 0.72, damp: 0.986, iters: 8, pinned: 1 };
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

  computeTarget() {
    const i = this.section;
    const j = Math.min(i + 1, K.length - 1);
    const t = smoothstep(0.52, 1.0, this.local);

    for (const k of NUMERIC) this.target[k] = lerp(K[i][k], K[j][k], t);
    for (const k of VECTOR) {
      const a = K[i][k], b = K[j][k], o = this.target[k];
      for (let n = 0; n < a.length; n++) o[n] = lerp(a[n], b[n], t);
    }
  }

  integrateOrbit(dt) {
    const o = this.orbit;
    o.yaw += o.vy;
    o.pitch = clamp(o.pitch + o.vp, -0.7, 1.0);
    o.vy = damp(o.vy, 0, 9, dt);
    o.vp = damp(o.vp, 0, 9, dt);
    // ease back toward the directed framing, slowly enough not to fight a drag
    o.yaw = damp(o.yaw, 0, 0.28, dt);
    o.pitch = damp(o.pitch, 0, 0.28, dt);
  }

  /* Solve a camera that puts a sphere of `radius` at `pivot` on screen at
     (fx, fy) filling `fill` of the height — at whatever aspect we happen to
     have this frame. */
  solveCamera(c, aspect, vw) {
    const tanV = Math.tan((c.fov * Math.PI) / 180 / 2);
    const R = c.radius * c.scale;

    let { fx, fy, fill, fillW } = c;

    /* Portrait needs a different composition, not a squeezed one.

       Every keyframe here places the subject to the right of the content
       column, which works because on a landscape screen there is a column of
       empty page over there. On a phone the type runs down the middle and
       that space does not exist, so the same framing puts the sculpture
       entirely off the right edge — which is what it did: the whole reason
       the page exists, cropped to a green sliver.

       So on a portrait viewport it moves to the top centre and is allowed to
       use the width, sitting above the type like a plate. */
    if (aspect < 0.95) {
      fx = 0.5 + (fx - 0.5) * 0.15;
      fy = Math.min(fy, 0.26);
      fill *= 1.15;
      fillW = 0.74;
    }

    // far enough back that neither the height nor the width cap is exceeded
    const dH = R / Math.max(fill * tanV, 1e-4);
    const dW = R / Math.max(fillW * aspect * tanV, 1e-4);
    const d = Math.max(dH, dW);

    const yaw = c.yaw + this.orbit.yaw;
    const pitch = clamp(c.pitch + this.orbit.pitch, -0.55, 1.15);

    const cp = Math.cos(pitch);
    const dir = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
    const fwd = [-dir[0], -dir[1], -dir[2]];

    // right = normalize(fwd × worldUp) = (-fwd.z, 0, fwd.x); up = right × fwd.
    // Check it against the canonical case rather than trusting the algebra:
    // looking down -Z, fwd = (0,0,-1), this gives right = (1,0,0). Negating
    // it mirrors the whole composition, left for right and top for bottom,
    // because `up` is derived from it.
    let rx = -fwd[2], ry = 0, rz = fwd[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * fwd[2] - rz * fwd[1];
    const uy = rz * fwd[0] - rx * fwd[2];
    const uz = rx * fwd[1] - ry * fwd[0];

    // where on screen, in NDC
    const col = contentColumn(vw);
    const screenX = (col.left + col.width * fx) / vw;
    const ndcX = screenX * 2 - 1;
    const ndcY = (1 - fy) * 2 - 1;

    // translating the camera by L along right moves the subject by -L/(d·tan)
    const L = -ndcX * d * aspect * tanV;
    const U = -ndcY * d * tanV;

    const px = c.pivot[0], py = c.pivot[1], pz = c.pivot[2];
    const ox = rx * L + ux * U;
    const oy = ry * L + uy * U;
    const oz = rz * L + uz * U;

    return {
      camPos: [px + dir[0] * d + ox, py + dir[1] * d + oy, pz + dir[2] * d + oz],
      camTarget: [px + ox, py + oy, pz + oz],
    };
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

    this.mouse.sx = damp(this.mouse.sx, this.mouse.x, 3.2, d);
    this.mouse.sy = damp(this.mouse.sy, this.mouse.y, 3.2, d);
    const par = this.calm ? 0.0 : 1.0;

    const c = this.current;
    const aspect = Math.max(0.2, renderer.iw / renderer.ih);

    // Pointer parallax as a small rotation, so it cannot break the framing.
    const saveYaw = this.orbit.yaw, savePitch = this.orbit.pitch;
    this.orbit.yaw += this.mouse.sx * 0.085 * par;
    this.orbit.pitch += this.mouse.sy * 0.055 * par;
    // The canvas's own width, not innerWidth. They are the same on a desktop
    // browser and they are not under mobile emulation or with a pinch-zoomed
    // visual viewport — and it is the canvas the composition is being solved
    // against, so that is the number that has to be right.
    const cam = this.solveCamera(c, aspect, renderer.canvas.clientWidth || innerWidth);
    this.orbit.yaw = saveYaw; this.orbit.pitch = savePitch;

    this.burst = damp(this.burst, 0, 6.0, d);

    const wantForce = this.mouse.inside ? (this.mouse.down ? -3.4 : 1.9) : 0;
    this.mouseForce = damp(this.mouseForce, wantForce, 6.0, d);

    const ray = renderer.mouseRay(this.mouse.x, this.mouse.y);
    const mat = MATERIALS[this.materialIndex];
    const mp = mat.p;
    const calmK = this.calm ? 0.45 : 1.0;

    const o = this.out;
    o.camPos = cam.camPos;
    o.camTarget = cam.camTarget;
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
    o.absorb = mp.absorb ?? [0.62, 0.42, 0.36];
    o.dispersion = mp.dispersion ?? 0.017;

    o.pGain = c.pGain;
    o.pCurl = c.pCurl * calmK * CURL_SCALE;
    o.pAttract = c.pAttract;
    o.pTangent = c.pTangent;
    o.pSpin = c.pSpin * calmK * SPIN_SCALE;
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
