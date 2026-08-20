/* ══════════════════════════════════════════════════════════════════════════
   gl.js: a thin WebGL2 layer. Programs, render targets, ping-pong, and
   shader errors that tell you the line instead of making you count.
   ══════════════════════════════════════════════════════════════════════════ */

export class GLError extends Error {}

/* ── context ───────────────────────────────────────────────────────────── */

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,            // the default framebuffer never needs one; our FBOs carry their own
    stencil: false,
    antialias: false,        // we do our own; MSAA on a raymarch buys nothing
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) throw new GLError('WebGL2 unavailable');

  /* EXT_color_buffer_float is the one that actually matters. Without it every
     float FBO comes back FRAMEBUFFER_INCOMPLETE_ATTACHMENT and the page is
     black with no GL error raised anywhere: the classic silent failure. */
  const caps = {
    colorFloat:  !!gl.getExtension('EXT_color_buffer_float'),
    halfFloat:   !!gl.getExtension('EXT_color_buffer_half_float'),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    floatBlend:  !!gl.getExtension('EXT_float_blend'),
    aniso:       gl.getExtension('EXT_texture_filter_anisotropic'),
    timer:       gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    /* Lets the driver compile and link on its own threads. Without it, the
       first getProgramParameter(LINK_STATUS) blocks the main thread until the
       program is ready, which for a heavy shader means a frozen tab and a
       browser offering to kill the page. */
    parallel:    gl.getExtension('KHR_parallel_shader_compile'),
    debugRender: gl.getExtension('WEBGL_debug_renderer_info'),
    maxTex:      gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxDrawBuf:  gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxUnits:    gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxPoint:    gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
  };

  caps.renderer = 'unknown gpu';
  try {
    caps.renderer = caps.debugRender
      ? gl.getParameter(caps.debugRender.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  } catch { /* masked in some browsers; that is fine, it is only a label */ }

  if (!caps.colorFloat && !caps.halfFloat) {
    throw new GLError('no float render targets (EXT_color_buffer_float missing)');
  }

  return { gl, caps };
}

/* ── shaders ───────────────────────────────────────────────────────────── */

function annotate(src, log) {
  const lines = src.split('\n');
  const out = [];
  const seen = new Set();
  const re = /ERROR:\s*\d+:(\d+):\s*(.*)/g;
  let m;
  while ((m = re.exec(log))) {
    const n = parseInt(m[1], 10);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(`\n  ▸ line ${n}: ${m[2]}`);
    for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) {
      out.push(`  ${i + 1 === n ? '→' : ' '} ${String(i + 1).padStart(4)} │ ${lines[i]}`);
    }
  }
  return out.length ? out.join('\n') : log;
}

/* Note what is deliberately NOT here any more: a COMPILE_STATUS query.
   Asking for it forces a synchronisation with the driver's compiler, which is
   precisely the stall this path exists to avoid. Compile errors are recovered
   later from the link failure, by checkShader(). */
export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

function checkShader(gl, sh, src, label) {
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
  const log = gl.getShaderInfoLog(sh) || '(no log)';
  return `${label} failed to compile:\n${annotate(src, log)}`;
}

const UNIFORM_SETTER = {};

export class Program {
  /* `deferred` splits construction in two: issue the work here, collect the
     result later with finalize(). In between, the driver is free to do it on
     another thread and the page is free to keep painting. */
  constructor(gl, vsSrc, fsSrc, label = 'program', deferred = false) {
    this.gl = gl;
    this.label = label;
    this.u = new Map();     // name -> { loc, type }
    this.unit = 0;
    this.ready = false;

    this._vsSrc = vsSrc;
    this._fsSrc = fsSrc;
    this._vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    this._fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);

    const p = gl.createProgram();
    gl.attachShader(p, this._vs);
    gl.attachShader(p, this._fs);
    gl.linkProgram(p);
    this.p = p;

    if (!deferred) this.finalize();
  }

  /* Whether the driver is done, asked in a way that does not force a wait.
     With no extension nothing is happening asynchronously, so the answer is
     always yes and finalize() blocks exactly as it used to. */
  isReady(ext) {
    if (this.ready) return true;
    if (!ext) return true;
    return this.gl.getProgramParameter(this.p, ext.COMPLETION_STATUS_KHR);
  }

  finalize() {
    if (this.ready) return this;
    const gl = this.gl, p = this.p;

    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      // Only now is the per-shader status worth paying for, to say which
      // stage failed, and on which line.
      const ve = checkShader(gl, this._vs, this._vsSrc, `${this.label}.vert`);
      const fe = checkShader(gl, this._fs, this._fsSrc, `${this.label}.frag`);
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new GLError(ve || fe || `${this.label} failed to link: ${log}`);
    }

    gl.deleteShader(this._vs);
    gl.deleteShader(this._fs);
    this._vs = this._fs = this._vsSrc = this._fsSrc = null;

    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      if (loc) this.u.set(name, { loc, type: info.type, size: info.size });
    }
    this.ready = true;
    return this;
  }

  use() { this.gl.useProgram(this.p); this.unit = 0; return this; }

  /* Silently ignores names the compiler optimised away; that is a feature,
     not a bug: it means uniforms can be set unconditionally by the caller. */
  set(name, v) {
    const e = this.u.get(name);
    if (!e) return this;
    const gl = this.gl, { loc, type } = e;
    switch (type) {
      // size > 1 means it was declared as an array, and the scalar setter
      // silently does nothing for those
      case gl.FLOAT:       e.size > 1 ? gl.uniform1fv(loc, v) : gl.uniform1f(loc, v); break;
      case gl.FLOAT_VEC2:  gl.uniform2fv(loc, v); break;
      case gl.FLOAT_VEC3:  gl.uniform3fv(loc, v); break;
      case gl.FLOAT_VEC4:  gl.uniform4fv(loc, v); break;
      case gl.INT: case gl.BOOL: e.size > 1 ? gl.uniform1iv(loc, v) : gl.uniform1i(loc, v); break;
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, v); break;
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, v); break;
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, v); break;
      case gl.UNSIGNED_INT: gl.uniform1ui(loc, v); break;
      case gl.FLOAT_MAT3:  gl.uniformMatrix3fv(loc, false, v); break;
      case gl.FLOAT_MAT4:  gl.uniformMatrix4fv(loc, false, v); break;
      default:
        if (Array.isArray(v) || ArrayBuffer.isView(v)) gl.uniform1fv(loc, v);
        else gl.uniform1f(loc, v);
    }
    return this;
  }

  /* Bind a texture to the next free unit and point the sampler at it. */
  tex(name, texture, target) {
    const e = this.u.get(name);
    if (!e || !texture) return this;
    const gl = this.gl;
    const unit = this.unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, texture);
    gl.uniform1i(e.loc, unit);
    return this;
  }

  setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }

  dispose() { this.gl.deleteProgram(this.p); }
}

/* ── textures & targets ────────────────────────────────────────────────── */

export const FMT = {
  RGBA16F: { internal: 0x881A, format: 0x1908, type: 0x140B, bytes: 8 },  // RGBA16F, RGBA, HALF_FLOAT
  RGBA32F: { internal: 0x8814, format: 0x1908, type: 0x1406, bytes: 16 }, // RGBA32F, RGBA, FLOAT
  R32F:    { internal: 0x822E, format: 0x1903, type: 0x1406, bytes: 4 },  // R32F,    RED,  FLOAT
  RG16F:   { internal: 0x822F, format: 0x8227, type: 0x140B, bytes: 4 },  // RG16F,   RG,   HALF_FLOAT
  RGBA8:   { internal: 0x8058, format: 0x1908, type: 0x1401, bytes: 4 },  // RGBA8,   RGBA, UNSIGNED_BYTE
};

export function createTexture(gl, w, h, fmt = FMT.RGBA16F, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, Math.max(1, w | 0), Math.max(1, h | 0));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  t._w = w; t._h = h; t._fmt = fmt;
  return t;
}

/* A render target with 1..4 colour attachments and an optional depth buffer.
   Attachments may have different formats; WebGL2 allows that as long as each
   one is colour-renderable on its own. */
export class Target {
  constructor(gl, w, h, opts = {}) {
    this.gl = gl;
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.formats = opts.formats || [FMT.RGBA16F];
    this.filter = opts.filter !== undefined ? opts.filter : gl.LINEAR;
    this.wrap = opts.wrap !== undefined ? opts.wrap : gl.CLAMP_TO_EDGE;
    this.useDepth = !!opts.depth;
    this.label = opts.label || 'target';
    this._build();
  }

  _build() {
    const gl = this.gl;
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    this.textures = this.formats.map((f, i) => {
      const t = createTexture(gl, this.w, this.h, f, this.filter, this.wrap);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      return t;
    });

    if (this.useDepth) {
      this.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.w, this.h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    this.buffers = this.formats.map((_, i) => gl.COLOR_ATTACHMENT0 + i);
    gl.drawBuffers(this.buffers);

    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new GLError(`${this.label}: framebuffer incomplete (0x${st.toString(16)}) at ${this.w}×${this.h}`);
    }

    /* texStorage2D leaves the contents undefined, and "undefined" in a float
       target can be NaN. One NaN sampled by a later pass propagates through
       the whole chain and the page is black with nothing in the console.
       Clearing once at allocation costs nothing and removes the class. */
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);        // a masked depth buffer ignores glClear entirely
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | (this.useDepth ? gl.DEPTH_BUFFER_BIT : 0));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get tex() { return this.textures[0]; }

  bind(clear = false, r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers(this.buffers);
    gl.viewport(0, 0, this.w, this.h);
    if (clear) {
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT | (this.useDepth ? gl.DEPTH_BUFFER_BIT : 0));
    }
    return this;
  }

  resize(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.w && h === this.h) return this;
    this.dispose();
    this.w = w; this.h = h;
    this._build();
    return this;
  }

  dispose() {
    const gl = this.gl;
    this.textures?.forEach((t) => gl.deleteTexture(t));
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.textures = null; this.depth = null; this.fbo = null;
  }
}

/* Two complete targets that swap. It has to be two whole framebuffers; you
   cannot keep one FBO and re-point its attachments each frame without a
   framebuffer re-validation, which costs more than the object it saves. */
export class PingPong {
  constructor(gl, w, h, opts = {}) {
    this.a = new Target(gl, w, h, { ...opts, label: (opts.label || 'pp') + '.a' });
    this.b = new Target(gl, w, h, { ...opts, label: (opts.label || 'pp') + '.b' });
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; return this; }
  resize(w, h) { this.a.resize(w, h); this.b.resize(w, h); return this; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/* ── fullscreen triangle ───────────────────────────────────────────────── */

/* One triangle, not two: no diagonal seam, one fewer vertex, and the
   rasteriser does not shade the quad edge twice. Attributeless: the vertex
   shader derives the position from gl_VertexID. */
export const FS_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Blitter {
  constructor(gl) {
    this.gl = gl;
    /* WebGL2 still requires a bound VAO for any draw call, even one that
       reads no attributes. Without this you get INVALID_OPERATION on some
       drivers and nothing at all on others. */
    this.vao = gl.createVertexArray();
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

/* ── state helpers ─────────────────────────────────────────────────────── */

export function toScreen(gl, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
}

export function additive(gl, on) {
  if (on) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
  else gl.disable(gl.BLEND);
}

export function alphaBlend(gl, on) {
  if (on) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
  else gl.disable(gl.BLEND);
}

/* Rough VRAM accounting so the HUD can be honest about what it is using. */
export function targetBytes(t) {
  if (!t || !t.formats) return 0;
  let b = t.formats.reduce((s, f) => s + f.bytes, 0) * t.w * t.h;
  if (t.useDepth) b += 4 * t.w * t.h;
  return b;
}
