/* ══════════════════════════════════════════════════════════════════════════
   director.js: what the scene is doing, and why.

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
   the sculpture outward until it runs off the edge, which is exactly what
   happened at 16:9.

   So a keyframe now says where the sculpture should appear *on screen* and
   how much of the frame it should fill, and the camera is solved from that
   every frame against the current aspect ratio. The horizontal position is
   given as a fraction of the CONTENT COLUMN rather than of the viewport, so
   the sculpture tracks the type instead of the window.
   ══════════════════════════════════════════════════════════════════════════ */

import { damp, clamp, lerp, smoothstep } from './math.js';
import { MATERIALS, DEFAULT_MATERIAL } from './content.js';

/* Bounding radius of every form the sculpture takes. Must match R_BOUND in
   the raymarch shader, or the framing solve and the marcher disagree. */
const R_BOUND = 1.62;

/* How lively the particle field is, as one dial.

   The first pass had the cloud whipping around the sculpture fast enough to
   read as agitation rather than as atmosphere; it pulled the eye off the
   type, which is the opposite of what a background is for. Orbit speed is
   halved; the curl flow is toned down less, because that one contributes
   shape as much as speed. */
const SPIN_SCALE = 0.18;
const CURL_SCALE = 0.34;

/* ── the material palette ──────────────────────────────────────────────────
   Seven orbs on a tilted ring around the sculpture, each wearing one of the
   materials. Click one and it falls inward; the sculpture takes the material
   as it lands. Positions are computed here and handed to the shader, so the
   click test and the pixels are reading the same numbers. */
const ORB_RING = 2.15;    // ring radius, world units
/* Tilt reads as an ellipse and gives the ring depth, but every degree of it
   also spreads the orbs in Z, and a near orb sits at half the camera
   distance of a far one, so it projects twice the size. Too much tilt and the
   near ones grow out of frame while the far ones shrink to specks. */
const ORB_TILT = 0.34;    // tilt about X, radians
const ORB_R    = 0.34;    // orb radius
/* ── the exchange ──────────────────────────────────────────────────────────
   Clicking an orb used to fly it in and end there, which read as an arrival
   rather than an absorption. Now the sculpture gives something back: the
   material it was wearing leaves as a droplet and takes the slot the
   arriving one vacated.

   That only adds up because a ring slot is empty exactly while its material
   is on the sculpture. One orb leaves the ring, one returns, and the count
   never changes. It also means the empty slot is always the one about to be
   filled, so nothing has to be renumbered.

   Phases as fractions of one exchange. Every boundary is joined by curves
   that reach it with zero velocity, so no frame of this can snap. */
const EX_TIME = 2.35;     // seconds, click to settled
const P_TOUCH = 0.32;     // surfaces meet; the material switches here
const P_EATEN = 0.52;     // the arriving orb is all the way in
const P_PUSH  = 0.56;     // the replacement starts out
const P_PINCH = 0.86;     // the neck gives; it is an orb again
/* And the body finishes changing a little before that, so the last of the old
   material is the drop about to leave rather than a cap still stuck to the
   body when the thread gives. */
const P_DRAIN = 0.80;

const c01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
// zero velocity AND zero acceleration at both ends
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* ── keyframes ─────────────────────────────────────────────────────────────
   yaw / pitch  direction from the subject to the camera, radians
   fov          vertical field of view, degrees
   fill         subject diameter as a fraction of viewport HEIGHT
   fillW        the same as a fraction of viewport WIDTH, a cap, so a narrow
                window pulls the camera back instead of cropping
   fx           horizontal placement, as a fraction across the content column
   fy           vertical placement, as a fraction of viewport height
   pivot        world point to frame (the sculpture's centre unless the
                section has something else in shot)
   radius       what to fit, when it is not just the sculpture
   ─────────────────────────────────────────────────────────────────────── */

const K = [
  { /* 00 hero */
    yaw: -0.03, pitch: 0.06, fov: 42, fill: 0.50, fillW: 0.30, fx: 1.06, fy: 0.44,
    orbShow: 0, pivot: [0, 0, 0], radius: R_BOUND,
    shape: 0.00, detail: 1.00, scale: 1.00, rimBoost: 0.0, sceneExposure: 1.0,
    pGain: 1.00, pCurl: 1.15, pAttract: 0.85, pTangent: 0.85, pSpin: 0.30, pSize: 1.6, pDamp: 0.55, pLife: 0.13,
    bloom: 0.85, streak: 0.30, ca: 0.55, vignette: 0.72, grain: 0.030,
  },
  { /* 01 whoami: measured against the yaml card rather than eyeballed. The
       card sits at y 0.15 to 0.45 of the viewport and the sculpture was
       centred at 0.52 with a radius of 0.33, which put its entire upper left
       quadrant behind glass. Dropped below the card and shrunk enough to
       still clear the bottom edge: 0.74 + 0.26 lands exactly on the clamp the
       solver would apply anyway. */
    yaw: -0.60, pitch: 0.17, fov: 39, fill: 0.52, fillW: 0.34, fx: 0.84, fy: 0.74,
    orbShow: 0, pivot: [0, 0, 0], radius: R_BOUND,
    shape: 0.85, detail: 0.75, scale: 0.98, rimBoost: 0.25, sceneExposure: 0.98,
    pGain: 0.62, pCurl: 0.85, pAttract: 1.15, pTangent: 0.95, pSpin: 0.20, pSize: 1.3, pDamp: 0.70, pLife: 0.11,
    bloom: 0.72, streak: 0.22, ca: 0.45, vignette: 0.80, grain: 0.030,
  },
  { /* 02 materials */
    // framed to hold the whole ring, not just the sculpture
    yaw: -0.40, pitch: 0.22, fov: 40, fill: 0.60, fillW: 0.38, fx: 0.86, fy: 0.50,
    orbShow: 1, pivot: [0, 0, 0], radius: 2.55,
    shape: 0.06, detail: 0.55, scale: 0.86, rimBoost: 0.55, sceneExposure: 1.05,
    pGain: 0.30, pCurl: 0.55, pAttract: 1.35, pTangent: 1.00, pSpin: 0.12, pSize: 1.0, pDamp: 0.85, pLife: 0.09,
    bloom: 0.95, streak: 0.42, ca: 0.60, vignette: 0.78, grain: 0.026,
  },
  { /* 03 work: the grid owns the page, so the sculpture sits high and small */
    yaw: -0.68, pitch: 0.40, fov: 35, fill: 0.46, fillW: 0.28, fx: 0.74, fy: 0.24,
    orbShow: 0, pivot: [0, 0, 0], radius: R_BOUND,
    shape: 2.00, detail: 0.45, scale: 1.00, rimBoost: 0.15, sceneExposure: 0.92,
    pGain: 0.48, pCurl: 0.95, pAttract: 0.95, pTangent: 0.80, pSpin: 0.26, pSize: 1.2, pDamp: 0.65, pLife: 0.12,
    bloom: 0.62, streak: 0.20, ca: 0.42, vignette: 0.86, grain: 0.032,
  },
  { /* 04 contact */
    yaw: -0.26, pitch: 0.05, fov: 46, fill: 0.66, fillW: 0.38, fx: 0.80, fy: 0.52,
    orbShow: 0, pivot: [0, 0, 0], radius: R_BOUND,
    shape: 3.00, detail: 0.55, scale: 1.02, rimBoost: 1.05, sceneExposure: 1.08,
    pGain: 1.25, pCurl: 1.45, pAttract: 1.25, pTangent: 0.95, pSpin: 0.44, pSize: 1.8, pDamp: 0.50, pLife: 0.16,
    bloom: 1.05, streak: 0.55, ca: 0.70, vignette: 0.66, grain: 0.028,
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
    this.materialIndex = DEFAULT_MATERIAL;
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

    this.orbs = {
      show: 0, spin: 0, hover: -1,
      fly: 0, flyId: -1, pending: -1, outMat: -1, switched: false, parted: false,
      partAt: 0, partD: 0, partR: 0,
      swapC: [0, 0, 0], swapR: 0, newBlob: [0, 0, 0, 0], swapDir: [0, 1, 0],
      outDir: [0, 1, 0], outD: 0, outRad: 0,
      flyPos: [0, 0, 0], flyR: 0, flyK: 0.3, bound: R_BOUND,
      pulse: 0, pulseDir: [0, 1, 0], flash: 0,
      pos: MATERIALS.map(() => [0, 0, 0]),
      rad: MATERIALS.map(() => 0),
    };


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

  /* The direction of a ring slot, and it takes a fractional index as readily
     as a whole one, because the front has to sit between two of them. The
     vector is already unit: cos(a)^2 + sin(a)^2(sin^2 t + cos^2 t) is one. */
  slotDir(k, out) {
    const a = this.orbs.spin + (Math.PI * 2 * k) / MATERIALS.length;
    const s = Math.sin(a);
    out[0] = Math.cos(a);
    out[1] = -s * Math.sin(ORB_TILT);
    out[2] = s * Math.cos(ORB_TILT);
    return out;
  }

  /* Start an exchange. The material does not change now; it changes when the
     surfaces meet, under the ripple, and the one being replaced leaves
     afterwards on a thread of its own. */
  absorb(i) {
    const o = this.orbs;
    if (i === this.materialIndex || o.flyId >= 0 || o.show < 0.35) return false;
    o.flyId = clamp(i, 0, MATERIALS.length - 1);
    o.pending = o.flyId;
    o.outMat = this.materialIndex;
    o.fly = 0;
    o.switched = false;
    o.parted = false;
    const p = o.pos[o.flyId] || [0, 1, 0];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    o.pulseDir = [p[0] / l, p[1] / l, p[2] / l];
    return true;
  }

  /* Ray against every orb. Same numbers the shader draws with, so what you
     click is what you saw. */
  pickOrb(ro, rdv) {
    const o = this.orbs;
    if (o.show < 0.35) return -1;
    let best = 1e9, id = -1;
    for (let k = 0; k < o.pos.length; k++) {
      const r = o.rad[k] * 1.35;           // a forgiving hit radius
      if (r < 0.02) continue;
      const c = o.pos[k];
      const ox = ro[0] - c[0], oy = ro[1] - c[1], oz = ro[2] - c[2];
      const b = ox * rdv[0] + oy * rdv[1] + oz * rdv[2];
      const cc = ox * ox + oy * oy + oz * oz - r * r;
      const h = b * b - cc;
      if (h < 0) continue;
      const t = -b - Math.sqrt(h);
      if (t > 0.05 && t < best) { best = t; id = k; }
    }
    return id;
  }

  updateOrbs(dt) {
    const o = this.orbs;
    o.show = damp(o.show, this.current.orbShow, 3.2, dt);
    o.spin += dt * 0.085;

    const flying = o.flyId >= 0;
    if (flying) {
      o.fly = Math.min(1, o.fly + dt / EX_TIME);

      /* The switch happens when the two forms actually touch. Everything
         after it is the sculpture closing over something that is already
         wearing the new material, which is what makes it read as becoming
         rather than as replacing. */
      if (!o.switched && o.fly >= P_TOUCH) {
        o.switched = true;
        this.materialIndex = o.pending;
        /* A third of what this used to be. The burst was there to cover an
           instant edit, and there is no longer an instant edit to cover: the
           change takes half a second and is the thing worth watching, so a
           flash bright enough to hide it is now working against the shot. It
           stays as an impact accent, nothing more. */
        o.pulse = 1; o.flash = 0.35;
        this.burst = 0.7;
      }
      if (o.fly >= 1) {
        o.flyId = -1; o.fly = 0; o.pending = -1;
        o.outMat = -1; o.switched = false; o.parted = false;
      }
    }
    o.pulse = Math.max(0, o.pulse - dt / 0.85);
    o.flash = Math.max(0, o.flash - dt / 0.32);

    const f = o.fly;
    const sculptR = this.current.scale * 1.02;      // nominal surface radius
    const contact = sculptR + ORB_R * 0.92;         // centre distance at touch
    /* Where the neck gives. Chosen so the geometry breaks on its own within
       a frame or two of P_PINCH: the head has to clear the body by slightly
       more than the blend radius left at that moment, and no more, or there
       is a stretch of detached ball still wearing the body's material. */
    const apart = sculptR + ORB_R + 0.035;

    o.flyR = 0; o.outRad = 0; o.outD = 0;

    const n = o.pos.length;
    const ct = Math.cos(ORB_TILT), st = Math.sin(ORB_TILT);
    for (let k = 0; k < n; k++) {
      const a = o.spin + (Math.PI * 2 * k) / n;
      const x = Math.cos(a) * ORB_RING;
      const z0 = Math.sin(a) * ORB_RING;
      let px = x, py = -z0 * st, pz = z0 * ct;
      const ux = px / ORB_RING, uy = py / ORB_RING, uz = pz / ORB_RING;

      let r = ORB_R * o.show;
      if (k === o.hover) r *= 1.18;

      if (!flying) {
        // a slot stands empty exactly while its material is on the sculpture
        if (k === this.materialIndex) r = 0;

      } else if (k === o.flyId) {
        /* Coming in. It decelerates to a stop as the surfaces meet and only
           then sinks, so contact has no step in it. The blob is handed to
           the distance field from the first frame rather than at impact,
           which is what lets the neck grow while there is still a gap.

           The drawn orb rides on top of that blob wearing its own material,
           so what you see is the arriving material as a ball and the old one
           as the neck reaching for it: two liquids meeting, for free, with no
           second material anywhere in the shader. */
        let d, rr;
        if (f < P_TOUCH) {
          d = lerp(ORB_RING, contact, smoother(f / P_TOUCH));
          rr = r;
        } else {
          const q = c01((f - P_TOUCH) / (P_EATEN - P_TOUCH));
          d = lerp(contact, sculptR * 0.18, easeIO(q));
          rr = r * Math.cbrt(Math.max(0, 1 - q));
        }
        px = ux * d; py = uy * d; pz = uz * d;
        if (f < P_EATEN) {
          o.flyPos[0] = px; o.flyPos[1] = py; o.flyPos[2] = pz;
          o.flyR = rr;
          /* The blend follows a curve with no corner in it, so the neck
             swells rather than appearing. This used to jump from 0.03 to
             0.56 on the frame of impact, which is the whole reason the old
             version read as a collision. */
          /* Capped well below the radius of the body. Past about 0.4 the
             blend spreads far enough to soften the whole field, and the
             dielectrics cannot survive that: their interior march wanders in
             the low-gradient region and the cast crystal came back crumpled
             and speckled. The metals never showed it, which is what made it
             worth checking every material rather than the default one. */
          o.flyK = 0.02 + 0.38 * Math.pow(smoother(c01(f / P_TOUCH)), 1.6);
        }
        /* The drawn orb hands over to the field at contact. It rides a
           little proud of the blob underneath so the two never fight over a
           pixel, and the blob it hands over to is the same size in the same
           place wearing the same material, because the sculpture became that
           material on this very frame. */
        r = f < P_TOUCH ? rr * 1.015 : 0;

      } else if (k === o.outMat) {
        r = 0;
        o.outDir[0] = ux; o.outDir[1] = uy; o.outDir[2] = uz;
        if (f >= P_PUSH) {
          const s2 = c01((f - P_PUSH) / (P_PINCH - P_PUSH));
          /* It starts just under the surface rather than at the middle. Time
             spent animating a head that is still buried is time the departure
             is not visible, and this one only clears the body for the last
             half of its push. */
          const dOut = lerp(sculptR * 0.55, apart, easeIO(s2));
          const rOut = ORB_R * o.show * easeIO(Math.min(1, s2 * 1.3));

          /* The neck is this number. It starts wide enough to bridge the
             gap the head is opening and falls away faster than the gap grows,
             so the two stop being joined without anything deciding that they
             should. */
          const kOut = 0.02 + 0.46 * Math.pow(1 - s2, 1.35);

          /* And the pinch is that moment, found rather than scheduled. A
             smooth minimum bridges a gap only while its blend radius is wider
             than the gap; the frame that stops being true is the frame the
             thread gives. Testing for it instead of picking a time means the
             handover from field to orb lands exactly on the break at any
             scale, which a hand-tuned constant only managed at one. */
          if (!o.parted && kOut < dOut - rOut - sculptR) {
            o.parted = true;
            o.partAt = f; o.partD = dOut; o.partR = rOut;
            o.flash = Math.max(o.flash, 0.28);
          }

          o.outDir[0] = ux; o.outDir[1] = uy; o.outDir[2] = uz;
          o.outD = dOut; o.outRad = rOut;

          if (!o.parted) {
            o.flyPos[0] = ux * dOut; o.flyPos[1] = uy * dOut; o.flyPos[2] = uz * dOut;
            o.flyR = rOut;
            o.flyK = kOut;

            /* And it is drawn as an orb at the same place, in the material it
               is carrying away, one and a half per cent proud of the blob so
               the two cannot fight over which owns a pixel. While it is still
               inside the body the orb is hidden, because orbs are only drawn
               nearer than the sculpture; as it clears the surface it appears
               already wearing the old material. So the ball is the material
               leaving and the neck is the material staying, and nothing has
               to change colour at the break. */
            px = ux * dOut; py = uy * dOut; pz = uz * dOut;
            r = rOut * 1.015;
          } else {
            // parted: an orb again, wearing the material it carried away
            const g = c01((f - o.partAt) / Math.max(0.08, 1 - o.partAt));
            const dr = lerp(o.partD, ORB_RING, easeIO(g));
            px = ux * dr; py = uy * dr; pz = uz * dr;
            r = lerp(o.partR, ORB_R * o.show, easeIO(g));
          }
        }

      } else if (k === this.materialIndex) {
        r = 0;
      }

      o.pos[k][0] = px; o.pos[k][1] = py; o.pos[k][2] = pz;
      o.rad[k] = r;
    }

    /* ── the change itself ──────────────────────────────────────────────
       The body is two materials at once for as long as this lasts. The old
       one occupies a region that contracts onto the drop carrying it away, so
       the new material floods in from where its own drop landed and the last
       of the old is what leaves: taking one in is what puts the other out,
       and you can watch it happen rather than being told it did.

       This replaces a switch that fired on one frame at contact, which
       changed the whole body long before anything departed and so connected
       nothing to nothing. */
    if (flying && o.switched && !o.parted) {
      const fr = easeIO(c01((f - P_TOUCH) / (P_DRAIN - P_TOUCH)));

      /* The front travels the ring between the two slots involved, and it
         reads both of them live, this frame, rather than sampling a direction
         once at the click.

         It used to contract onto the departing slot alone, and the numbers
         said what that looked like: over one exchange the anchor moved six
         degrees while the change itself crossed a hundred and ten, so nothing
         about where the change went had anything to do with where the orbs
         were. Interpolating the slot index rather than the vector matters
         here: two slots can be exactly opposite, and a spherical interpolation
         between opposite directions has no defined path, while a ring has an
         obvious one. */
      const N = MATERIALS.length;
      let dk = ((o.outMat - o.flyId) % N + N) % N;
      if (dk > N / 2) dk -= N;                     // the short way round
      const u = this.slotDir(o.flyId + dk * fr, o.swapDir);
      const d = lerp(sculptR, o.outRad > 0 ? o.outD : sculptR, fr);
      o.swapC[0] = u[0] * d; o.swapC[1] = u[1] * d; o.swapC[2] = u[2] * d;
      // wide enough at the start to cover every point of the body, or the far
      // side of it changes on the frame of the switch and the drain has
      // already lost the argument
      const cover = R_BOUND * this.current.scale + sculptR + 0.06;
      o.swapR = lerp(cover, Math.max(o.outRad, 0.02) * 1.06, fr);
    } else {
      o.swapR = 0;
    }

    /* The arriving drop carries its own material the whole way in, from the
       frame it enters the field rather than from the frame the body switches.
       Those are two thirds of a second apart, and for all of it the drop was
       being painted with the material of the body it was flying towards. */
    if (flying && f < P_EATEN && o.flyR > 0) {
      o.newBlob[0] = o.flyPos[0]; o.newBlob[1] = o.flyPos[1];
      o.newBlob[2] = o.flyPos[2]; o.newBlob[3] = o.flyR * 1.2;
    } else {
      o.newBlob[3] = 0;
    }

    // the marcher's bounding sphere has to reach whatever has left the body
    const blob = o.flyR > 0
      ? Math.hypot(o.flyPos[0], o.flyPos[1], o.flyPos[2]) + o.flyR + o.flyK
      : 0;
    o.bound = Math.max(R_BOUND * this.current.scale, blob) + 0.02;
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
    /* Scaled by dt, which it was not. Everything else in this file goes
       through damp() precisely so it behaves the same at 30 fps and at 144;
       these two lines added a whole frame's velocity per frame regardless,
       so the same drag turned the camera two and a half times further on a
       144 Hz panel than on a 60. The 60 keeps the tuning the constants were
       chosen for. */
    o.yaw += o.vy * dt * 60;
    o.pitch = clamp(o.pitch + o.vp * dt * 60, -0.7, 1.0);
    o.vy = damp(o.vy, 0, 9, dt);
    o.vp = damp(o.vp, 0, 9, dt);
    // ease back toward the directed framing, slowly enough not to fight a drag
    o.yaw = damp(o.yaw, 0, 0.28, dt);
    o.pitch = damp(o.pitch, 0, 0.28, dt);
  }

  /* Solve a camera that puts a sphere of `radius` at `pivot` on screen at
     (fx, fy) filling `fill` of the height, at whatever aspect we happen to
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
       entirely off the right edge, which is what it did: the whole reason
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
    let screenX = (col.left + col.width * fx) / vw;

    /* Keep the subject inside the frame, whatever fx asked for.

       fx is a fraction of the CONTENT COLUMN, and on a narrow window the
       column is most of the viewport, so an fx past 1.0, which sits neatly
       just outside the column on a wide screen, lands half off the edge on a
       smaller one. Clamping against the subject's own projected radius makes
       "just outside the column" mean that at every width, and makes clipping
       impossible at any aspect ratio rather than merely unlikely at the ones
       that happened to get tested. */
    const rFrac = R / (2.0 * d * aspect * tanV);   // half-width, as a fraction of the viewport
    const margin = 0.012;
    const lo = margin + rFrac, hi = 1 - margin - rFrac;
    screenX = lo > hi ? 0.5 : clamp(screenX, lo, hi);

    // the same clamp vertically, so a tall subject cannot run off the top or
    // bottom either
    const rFracY = R / (2.0 * d * tanV);
    const loY = margin + rFracY, hiY = 1 - margin - rFracY;
    const screenY = loY > hiY ? 0.5 : clamp(fy, loY, hiY);

    const ndcX = screenX * 2 - 1;
    const ndcY = (1 - screenY) * 2 - 1;

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
    // visual viewport, and it is the canvas the composition is being solved
    // against, so that is the number that has to be right.
    const cam = this.solveCamera(c, aspect, renderer.canvas.clientWidth || innerWidth);
    this.orbit.yaw = saveYaw; this.orbit.pitch = savePitch;

    this.updateOrbs(d);
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
    o.orbPos = this.orbs.pos;
    o.orbRad = this.orbs.rad;
    o.orbCount = this.orbs.show > 0.01 ? this.orbs.pos.length : 0;
    o.flyPos = this.orbs.flyPos;
    o.flyR = this.orbs.flyR;
    o.flyK = this.orbs.flyK;
    o.bound = this.orbs.bound;
    // the two-material split, for as long as the body is two materials
    o.swapC = this.orbs.swapC;
    o.swapR = this.orbs.swapR;
    o.newBlob = this.orbs.newBlob;
    o.matOld = Math.max(0, this.orbs.outMat);
    o.matNew = Math.max(0, this.orbs.pending);
    o.pulse = this.orbs.pulse;
    o.pulseDir = this.orbs.pulseDir;
    o.flash = this.orbs.flash;

    o.fade = this.fade;
    o.taaFeedback = this.calm ? 0.93 : 0.90;

    return o;
  }
}

export const SECTION_COUNT = K.length;
