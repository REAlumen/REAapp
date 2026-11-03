import { BLEND_MODES, STILL_DURATION, autopilotColumn, getClip, isStill } from './model.js';
import { BLEND_GLSL, EFFECTS, GENERATORS } from './shaders.js';
import { frameAt, isDxvCodec, openMov, readPcmAudio } from './mov.js';

async function fileReader(url) {
  const readAt = async (offset, length) => {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    return new Uint8Array(await res.arrayBuffer());
  };
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const total = Number(head.headers.get('Content-Range')?.split('/')[1]);
  await head.arrayBuffer();
  return { readAt, total };
}

// Un valor dañado en el archivo no puede detener el transporte.
const stillDuration = (clip) => {
  const d = Number(clip.transport.duration);
  return Number.isFinite(d) && d > 0 ? Math.max(0.001, d) : STILL_DURATION;
};

const VS = `#version 300 es
in vec2 a; out vec2 uv; void main(){uv=a*.5+.5;gl_Position=vec4(a,0,1);}`;
const HEADER = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform float time, beat; uniform vec2 res; uniform float p[8];
`;
const TRANSFORM = `${HEADER}
uniform vec2 srcSize, offset, crop; uniform float scale, rot, opacity;
void main(){
  vec2 q=(uv-.5)*res-offset; float c=cos(-rot), s=sin(-rot);
  q=vec2(c*q.x-s*q.y,s*q.x+c*q.y)/max(scale,1e-4);
  float f=min(res.x/srcSize.x,res.y/srcSize.y); vec2 t=q/(srcSize*f)+.5;
  if(t.x<0.||t.y<0.||t.x>1.||t.y>1.){o=vec4(0);return;}
  o=texture(tex,t*crop); o.a*=opacity;
}`;
const BLEND = `${HEADER}
uniform sampler2D over; uniform int mode; uniform float opacity, gain;
${BLEND_GLSL}
// Medido contra la app de referencia: Alpha funde con la opacidad; los demás modos la usan como crossfade
// (0 = base, 0.5 = mezcla completa, 1 = capa superior).
void main(){
  vec4 a=texture(tex,uv), b=texture(over,uv);
  vec3 s=mix(a.rgb,b.rgb,b.a), r;
  if(mode==0) r=mix(a.rgb,s,opacity);
  else {
    vec3 f=mix(a.rgb,blendFn(mode,a.rgb,b.rgb),b.a);
    r=opacity<.5?mix(a.rgb,f,opacity*2.):mix(f,s,opacity*2.-1.);
  }
  o=vec4(mix(a.rgb,r,gain),a.a);
}`;
const COPY = `${HEADER}
uniform float flip, gain;
void main(){vec2 v=uv; if(flip>.5)v.y=1.-v.y; vec4 c=texture(tex,v); o=vec4(c.rgb*gain*c.a,1);}`;
const MIX = `${HEADER}
uniform sampler2D over; uniform float k;
void main(){o=mix(texture(tex,uv),texture(over,uv),k);}`;

export class Engine {
  constructor(canvas, comp, onEvent = () => {}) {
    this.canvas = canvas;
    this.onEvent = onEvent;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.programs = new Map();
    this.runtimes = new Map();
    this.layerState = new Map();
    this.pool = [];
    this.pending = [];
    this.time = 0;
    this.beat = 0;
    this.last = performance.now();
    this.fps = 0;
    this.setComposition(comp);
  }

  setComposition(comp) {
    for (const rt of this.runtimes.values()) this.disposeRuntime(rt);
    this.runtimes.clear();
    this.layerState.clear();
    this.pending = [];
    this.previewTarget = null;
    this.comp = comp;
    this.resize();
    for (const layer of comp.layers) {
      if (layer.activeClip) {
        const clip = this.findActive(layer);
        if (clip) this.connect(layer, clip);
        else layer.activeClip = null;
      } else if (layer.triggerFirst) {
        for (let c = 0; c < comp.columns; c++) {
          const clip = getClip(comp, layer.id, c);
          if (clip) { this.connect(layer, clip); break; }
        }
      }
    }
  }

  findActive(layer) {
    for (const deck of this.comp.decks) {
      for (const clip of Object.values(deck.clips)) if (clip.id === layer.activeClip) return clip;
    }
    return null;
  }

  resize() {
    const { gl, comp } = this;
    this.canvas.width = comp.width;
    this.canvas.height = comp.height;
    if (this.previewCtx) {
      this.previewCtx.canvas.width = 640;
      this.previewCtx.canvas.height = Math.round((640 * comp.height) / comp.width);
    }
    for (const t of this.pool) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.pool = [];
  }

  program(key, fs) {
    let p = this.programs.get(key);
    if (p) return p;
    const { gl } = this;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'a');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(prog)}`);
    p = { prog, u: new Map() };
    this.programs.set(key, p);
    return p;
  }

  use(p, target, uniforms = {}) {
    const { gl, comp } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, comp.width, comp.height);
    gl.useProgram(p.prog);
    const loc = (n) => {
      if (!p.u.has(n)) p.u.set(n, gl.getUniformLocation(p.prog, n));
      return p.u.get(n);
    };
    gl.uniform1f(loc('time'), this.time);
    gl.uniform1f(loc('beat'), this.beat);
    gl.uniform2f(loc('res'), comp.width, comp.height);
    let unit = 0;
    for (const [name, v] of Object.entries(uniforms)) {
      const l = loc(name);
      if (v && v.tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v.tex);
        gl.uniform1i(l, unit++);
      } else if (name === 'p') gl.uniform1fv(l, v);
      else if (name === 'mode') gl.uniform1i(l, v);
      else if (Array.isArray(v)) gl.uniform2f(l, v[0], v[1]);
      else gl.uniform1f(l, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  acquire() {
    const free = this.pool.find((t) => !t.busy);
    if (free) { free.busy = true; return free; }
    const { gl, comp } = this;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, comp.width, comp.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams();
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, busy: true };
    this.pool.push(t);
    return t;
  }

  release(t) { t.busy = false; }

  clear(t, alpha = 0) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(0, 0, 0, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  texParams() {
    const { gl } = this;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---- Runtime de clips ----
  // `key` separa la reproducción del Preview de la que está al aire.
  runtime(clip, key = clip.id) {
    let rt = this.runtimes.get(key);
    if (rt) return rt;
    const { gl } = this;
    rt = { clip, key, preview: key !== clip.id, t: 0, dur: 8, dir: clip.transport.dir || 1, tex: null, w: this.comp.width, h: this.comp.height, ready: false, error: null };
    this.runtimes.set(key, rt);
    const { source } = clip;
    if (isStill(source)) rt.dur = stillDuration(clip);
    if (source.type === 'capture' || source.type === 'ndi') {
      rt.live = true;
      rt.dur = 1;
      rt.ready = true;
    } else if (source.type === 'video' && /\.mov$/i.test(source.path)) {
      this.openMovClip(clip, rt);
    } else if (source.type === 'video' || source.type === 'audio') {
      this.openMedia(clip, rt);
    } else if (source.type === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        rt.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, rt.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        this.texParams();
        rt.w = img.naturalWidth; rt.h = img.naturalHeight; rt.ready = true;
        this.onEvent('clip', clip);
      };
      img.onerror = () => { rt.error = 'Imagen no compatible'; this.onEvent('clip', clip); };
      img.src = `app://media/${encodeURIComponent(source.path)}`;
    } else if (source.type === 'generator') {
      if (!GENERATORS[source.gen]) rt.error = `Fuente no disponible: ${source.gen}`;
      rt.ready = !rt.error;
    } else if (source.type === 'text') {
      rt.canvas = document.createElement('canvas');
      rt.ready = true;
    } else {
      rt.error = source.reason || 'Fuente no importada';
    }
    return rt;
  }

  // Un .mov puede ser DXV (decodificación propia) o un códec que el navegador ya entiende.
  async openMovClip(clip, rt) {
    const url = `app://media/${encodeURIComponent(clip.source.path)}`;
    try {
      const { readAt, total } = await fileReader(url);
      const meta = await openMov(readAt, total);
      if (!isDxvCodec(meta.codec)) { this.openMedia(clip, rt); return; }
      if (!this.s3tc) {
        this.s3tc = this.gl.getExtension('WEBGL_compressed_texture_s3tc');
        if (!this.s3tc) throw new Error('La GPU no admite texturas S3TC, necesarias para DXV');
      }
      rt.dur = meta.duration;
      rt.w = meta.width;
      rt.h = meta.height;
      rt.times = meta.times;
      rt.fps = meta.offsets.length / meta.duration;
      rt.requested = 0;
      const worker = new Worker('js/dxv-worker.js', { type: 'module' });
      rt.worker = worker;
      worker.onmessage = (e) => this.onDxvMessage(clip, rt, e.data);
      worker.onerror = (e) => { rt.error = `Error en el decodificador DXV: ${e.message}`; this.onEvent('clip', clip); };
      worker.postMessage({
        type: 'open', url, first: 0,
        meta: { offsets: meta.offsets, sizes: meta.sizes, width: meta.width, height: meta.height },
      });
      rt.ready = true;
      this.onEvent('clip', clip);
      if (meta.audio && !rt.preview) {
        rt.hasAudio = true;
        this.loadAudio(clip, rt, meta.audio, readAt);
      }
    } catch (err) {
      if (!rt.disposed) { rt.error = err.message; this.onEvent('clip', clip); }
    }
  }

  onDxvMessage(clip, rt, m) {
    if (rt.disposed) return;
    if (m.type === 'error') { rt.error = m.message; this.onEvent('clip', clip); return; }
    const { gl } = this;
    if (!rt.tex) {
      rt.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, rt.tex);
      this.texParams();
    }
    const internal = m.format === 'dxt1' ? this.s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT : this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internal, m.codedWidth, m.codedHeight, 0, m.data);
    rt.frame = m.index;
    rt.crop = [rt.w / m.codedWidth, rt.h / m.codedHeight];
    rt.decodeMs = m.ms;
    if (m.thumb) {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 90;
      c.getContext('2d').putImageData(new ImageData(m.thumb, 160, 90), 0, 0);
      rt.thumb = c.toDataURL('image/jpeg', 0.7);
      this.onEvent('clip', clip);
    }
  }

  async loadAudio(clip, rt, track, readAt) {
    try {
      const pcm = await readPcmAudio(track, readAt);
      if (rt.disposed) return;
      this.audio ??= new AudioContext();
      const buffer = this.audio.createBuffer(pcm.channels.length, pcm.frames, pcm.sampleRate);
      pcm.channels.forEach((data, i) => buffer.copyToChannel(data, i));
      rt.audioBuffer = buffer;
    } catch (err) {
      rt.audioError = err.message;
      console.warn(`Audio de ${clip.name}:`, err.message);
    }
  }

  stopAudio(rt) {
    if (rt.voice) {
      try { rt.voice.src.stop(); } catch { /* ya detenido */ }
      rt.voice = null;
    }
  }

  // Mantiene la voz alineada con el transporte: se reinicia si hay salto o cambio de velocidad.
  stepAudio(rt, rate, dir, volume) {
    if (!rt.audioBuffer) return;
    const now = this.audio.currentTime;
    const v = rt.voice;
    if (dir <= 0 || rate <= 0) { this.stopAudio(rt); return; }
    const expected = v ? v.t0 + (now - v.at) * v.rate : 0;
    if (!v || v.rate !== rate || Math.abs(expected - rt.t) > 0.12) {
      this.stopAudio(rt);
      const src = this.audio.createBufferSource();
      const gain = this.audio.createGain();
      src.buffer = rt.audioBuffer;
      src.playbackRate.value = rate;
      src.connect(gain).connect(this.audio.destination);
      src.start(0, Math.min(rt.t, rt.audioBuffer.duration));
      rt.voice = { src, gain, t0: rt.t, at: now, rate };
    }
    rt.voice.gain.gain.value = volume;
    if (this.audio.state === 'suspended') this.audio.resume();
  }

  openMedia(clip, rt) {
    const { source } = clip;
    {
      const v = document.createElement(source.type);
      v.preload = 'auto';
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.muted = false;
      v.volume = 0;
      v.addEventListener('loadedmetadata', () => {
        // Algunos WebM no declaran duración: buscar al final obliga al navegador a calcularla.
        if (Number.isFinite(v.duration)) rt.dur = v.duration || 8;
        else v.currentTime = 1e9;
        rt.ready = true;
        this.onEvent('clip', clip);
      });
      v.addEventListener('durationchange', () => {
        if (Number.isFinite(v.duration) && v.duration > 0) rt.dur = v.duration;
      });
      v.addEventListener('error', () => {
        rt.error = 'Códec o archivo no compatible';
        this.onEvent('clip', clip);
      });
      v.src = `app://media/${encodeURIComponent(source.path)}`;
      rt.media = v;
    }
  }

  // ---- Fuentes en vivo: se conectan al usarse y se liberan al dejar de usarse ----
  ensureLive(clip, rt) {
    rt.usedAt = performance.now();
    if (rt.active) return;
    rt.active = true;
    rt.error = null;
    if (clip.source.type === 'ndi') this.openNdi(clip, rt);
    else this.openCapture(clip, rt);
  }

  openNdi(clip, rt) {
    if (!this.ndi?.available) {
      rt.error = this.ndi?.error || 'NDI no disponible';
      this.onEvent('clip', clip);
      return;
    }
    const { gl } = this;
    rt.tally = null;
    rt.ndiId = this.ndi.openReceiver(clip.source.name, {
      onFrame: (m) => {
        if (!rt.tex) {
          rt.tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, rt.tex);
          this.texParams();
        }
        gl.bindTexture(gl.TEXTURE_2D, rt.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.width, m.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data);
        rt.w = m.width;
        rt.h = m.height;
        rt.frames = (rt.frames || 0) + 1;
      },
      onError: (message) => {
        rt.error = message;
        this.onEvent('clip', clip);
      },
      onStatus: (connected) => {
        rt.connected = connected;
        this.onEvent('clip', clip);
      },
    });
  }

  // Tally NDI: avisa a la fuente (por ejemplo, la luz de una cámara) si está al aire o en preview.
  updateTally(rt) {
    if (!rt.ndiId) return;
    const program = this.comp.layers.some((l) => l.activeClip === rt.clip.id && !l.bypass && l.opacity > 0);
    const preview = this.previewTarget?.clip === rt.clip;
    const tally = `${program}:${preview}`;
    if (tally !== rt.tally) {
      rt.tally = tally;
      this.ndi.setTally(rt.ndiId, program, preview);
    }
  }

  async openCapture(clip, rt) {
    const { deviceId, label } = clip.source;
    const video = (id) => ({ deviceId: id ? { exact: id } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } });
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: video(deviceId), audio: false });
      } catch (err) {
        // Windows puede cambiar el identificador entre sesiones: se busca por nombre.
        const devices = await navigator.mediaDevices.enumerateDevices();
        const same = devices.find((d) => d.kind === 'videoinput' && d.label === label);
        if (!same) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video: video(same.deviceId), audio: false });
      }
      if (rt.disposed || !rt.active) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      await v.play();
      rt.media = v;
      rt.stream = stream;
    } catch (err) {
      rt.error = err.name === 'NotReadableError' ? 'El dispositivo está en uso por otra aplicación' : `No se pudo abrir el dispositivo: ${err.message}`;
      this.onEvent('clip', clip);
    }
  }

  closeLive(rt) {
    rt.active = false;
    if (rt.ndiId) { this.ndi.closeReceiver(rt.ndiId); rt.ndiId = null; }
    if (rt.stream) { rt.stream.getTracks().forEach((t) => t.stop()); rt.stream = null; }
    if (rt.media) { rt.media.srcObject = null; rt.media = null; }
  }

  // ---- Preview: un clip, una capa o la composición, sin afectar la salida ----
  previewKey(clip) {
    return clip.source.type === 'capture' || clip.source.type === 'ndi' ? clip.id : `preview:${clip.id}`;
  }

  setPreview(target) {
    const old = this.previewTarget;
    if (old?.kind === 'clip' && old.clip !== target?.clip) {
      const key = this.previewKey(old.clip);
      const rt = this.runtimes.get(key);
      if (rt?.preview) { this.disposeRuntime(rt); this.runtimes.delete(key); }
    }
    if (target?.kind === 'clip') {
      const rt = this.runtime(target.clip, this.previewKey(target.clip));
      if (rt.live && rt.error) { this.closeLive(rt); rt.error = null; }
    }
    this.previewTarget = target;
    this.previewFrames = 0;
    if (this.previewCtx) {
      this.previewCtx.fillStyle = '#000';
      this.previewCtx.fillRect(0, 0, this.previewCtx.canvas.width, this.previewCtx.canvas.height);
    }
  }

  showPreview(tex) {
    this.use(this.program('copy', COPY), null, { tex, flip: 1, gain: 1 });
    this.drawPreviewFromCanvas();
  }

  drawPreviewFromCanvas() {
    const c = this.previewCtx;
    if (!c) return;
    c.drawImage(this.canvas, 0, 0, c.canvas.width, c.canvas.height);
    this.previewFrames++;
  }

  renderPreviewClip(dt) {
    const target = this.previewTarget;
    if (target?.kind !== 'clip' || !this.previewCtx) return;
    const { clip } = target;
    const tex = this.renderClip({ volume: 0 }, clip, dt, 0, this.runtime(clip, this.previewKey(clip)));
    if (!tex) return;
    this.showPreview(tex);
    this.release(tex);
  }

  // El transporte que se edita: el del aire si el clip está conectado; si no, el del Preview.
  displayRuntime(clip) {
    const onAir = this.comp.layers.some((l) => l.activeClip === clip.id);
    if (!onAir && this.previewTarget?.clip === clip) return this.runtime(clip, this.previewKey(clip));
    return this.runtime(clip);
  }

  disposeRuntime(rt) {
    rt.disposed = true;
    if (rt.live) { this.closeLive(rt); if (rt.tex) this.gl.deleteTexture(rt.tex); return; }
    this.stopAudio(rt);
    if (rt.worker) rt.worker.terminate();
    if (rt.media) { rt.media.pause(); rt.media.removeAttribute('src'); rt.media.load(); }
    if (rt.tex) this.gl.deleteTexture(rt.tex);
  }

  forget(clip) {
    if (this.previewTarget?.clip === clip) this.setPreview(null);
    for (const key of [clip.id, `preview:${clip.id}`]) {
      const rt = this.runtimes.get(key);
      if (rt) { this.disposeRuntime(rt); this.runtimes.delete(key); }
    }
  }

  // ---- Disparo ----
  trigger(layer, clip) {
    const snap = clip.beatSnap || 0;
    if (snap > 0) {
      const at = (Math.floor(this.beat / snap) + 1) * snap;
      this.pending = this.pending.filter((q) => q.layer !== layer);
      this.pending.push({ at, layer, clip });
      return;
    }
    this.connect(layer, clip);
  }

  connect(layer, clip) {
    const st = this.state(layer);
    if (st.clip && st.clip !== clip && layer.transition > 0) {
      st.prev = st.clip; st.fadeStart = this.time;
    } else if (st.clip && st.clip !== clip) {
      this.pause(st.clip);
    }
    st.clip = clip;
    layer.activeClip = clip.id;
    const rt = this.runtime(clip);
    if (rt.live && rt.error) { this.closeLive(rt); rt.error = null; }
    const { in: i } = clip.transport;
    rt.t = i * rt.dur;
    rt.dir = clip.transport.dir || 1;
    if (rt.media) { try { rt.media.currentTime = rt.t; } catch { /* metadatos aún no listos */ } }
    this.onEvent('connect', { layer, clip });
  }

  disconnect(layer) {
    const st = this.state(layer);
    if (st.clip) this.pause(st.clip);
    if (st.prev) this.pause(st.prev);
    st.clip = null; st.prev = null;
    layer.activeClip = null;
    this.onEvent('connect', { layer, clip: null });
  }

  pause(clip) {
    const rt = this.runtimes.get(clip.id);
    if (rt && rt.media) { rt.media.pause(); rt.media.volume = 0; }
    if (rt) this.stopAudio(rt);
  }

  state(layer) {
    let st = this.layerState.get(layer.id);
    if (!st) { st = { clip: null, prev: null, fadeStart: 0 }; this.layerState.set(layer.id, st); }
    return st;
  }

  triggerColumn(column) {
    for (const layer of this.comp.layers) {
      if (layer.ignoreColumn) continue;
      const clip = getClip(this.comp, layer.id, column);
      if (clip) this.trigger(layer, clip);
      else this.disconnect(layer);
    }
  }

  // ---- Cue points ----
  addCue(clip) {
    const rt = this.displayRuntime(clip);
    const t = rt.t;
    clip.cues.push({ id: `${Date.now()}${clip.cues.length}`, name: String.fromCharCode(65 + clip.cues.length % 26), t });
    clip.cues.sort((a, b) => a.t - b.t);
  }

  jumpCue(clip, cue) {
    const rt = this.displayRuntime(clip);
    rt.t = cue.t;
    if (rt.media) rt.media.currentTime = cue.t;
  }

  seek(clip, frac) {
    const rt = this.displayRuntime(clip);
    rt.t = frac * rt.dur;
    if (rt.media && rt.ready) rt.media.currentTime = rt.t;
  }

  // ---- Transporte ----
  step(layer, clip, dt, gain, rt = this.runtime(clip)) {
    if (rt.error || rt.live) return rt;
    const tr = clip.transport;
    if (isStill(clip.source)) rt.dur = stillDuration(clip);
    const lo = tr.in * rt.dur;
    const hi = Math.max(tr.out * rt.dur, lo + 0.001);
    const rate = tr.mode === 'bpm' ? rt.dur / Math.max(0.25, tr.beats * 60 / this.comp.bpm) : tr.speed;
    const dir = tr.dir === 0 ? 0 : rt.dir;
    rt.t += dt * rate * dir;
    let wrapped = false;
    if (rt.t >= hi || rt.t < lo) {
      wrapped = true;
      if (tr.loop === 'loop') rt.t = dir >= 0 ? lo + (rt.t - hi) % (hi - lo) : hi - (lo - rt.t) % (hi - lo);
      else if (tr.loop === 'bounce') { rt.dir = -rt.dir; rt.t = Math.min(hi, Math.max(lo, rt.t)); }
      else rt.t = Math.min(hi - 0.001, Math.max(lo, rt.t));
    }
    if (rt.media && rt.ready) {
      const m = rt.media;
      m.volume = Math.max(0, Math.min(1, clip.volume * layer.volume * this.comp.volume * gain));
      if (dir > 0 && rate > 0) {
        m.playbackRate = Math.min(16, Math.max(0.0625, rate));
        if (m.paused) m.play().catch(() => {});
        if (Math.abs(m.currentTime - rt.t) > 0.25 && !m.seeking) m.currentTime = rt.t;
      } else {
        if (!m.paused) m.pause();
        if (Math.abs(m.currentTime - rt.t) > 1 / 30 && !m.seeking) m.currentTime = rt.t;
      }
    }
    this.stepAudio(rt, rate, dir, Math.max(0, Math.min(1, clip.volume * layer.volume * this.comp.volume * gain)));
    if (wrapped && !rt.preview && tr.loop !== 'bounce') this.autopilot(layer, clip);
    return rt;
  }

  autopilot(layer, clip) {
    const { comp } = this;
    const deck = comp.decks[comp.activeDeck];
    const cols = [];
    for (let c = 0; c < comp.columns; c++) if (deck.clips[`${layer.id}:${c}`]) cols.push(c);
    const current = cols.find((c) => deck.clips[`${layer.id}:${c}`] === clip);
    const target = autopilotColumn(layer.autopilot || 'off', clip.autopilot, cols, current);
    if (target !== null) this.connect(layer, deck.clips[`${layer.id}:${target}`]);
  }

  // ---- Render ----
  sourceTexture(clip, rt) {
    const { gl } = this;
    const { source } = clip;
    if (source.type === 'generator') {
      const def = GENERATORS[source.gen];
      const t = this.acquire();
      const values = new Float32Array(8);
      def.params.forEach((pd, i) => { values[i] = source.values?.[i] ?? pd.def; });
      this.use(this.program(`gen:${source.gen}`, `${HEADER}${def.glsl} void main(){o=fx(uv);}`), t, { p: values });
      return { target: t, w: this.comp.width, h: this.comp.height };
    }
    if (source.type === 'text') {
      this.drawText(source, rt);
      return { tex: rt.tex, w: rt.w, h: rt.h };
    }
    if (rt.live) this.ensureLive(clip, rt);
    if (source.type === 'ndi') return rt.tex ? { tex: rt.tex, w: rt.w, h: rt.h } : null;
    if ((source.type === 'video' || source.type === 'capture') && rt.media && rt.media.readyState >= 2) {
      if (!rt.tex) {
        rt.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, rt.tex);
        this.texParams();
      }
      gl.bindTexture(gl.TEXTURE_2D, rt.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rt.media);
      rt.w = rt.media.videoWidth; rt.h = rt.media.videoHeight;
      return { tex: rt.tex, w: rt.w, h: rt.h };
    }
    if (source.type === 'image' && rt.tex) return { tex: rt.tex, w: rt.w, h: rt.h };
    if (rt.worker) {
      const index = frameAt(rt.times, rt.t);
      if (index !== rt.requested) {
        rt.requested = index;
        rt.worker.postMessage({ type: 'want', index });
      }
      if (rt.tex) return { tex: rt.tex, w: rt.w, h: rt.h, crop: rt.crop };
    }
    return null;
  }

  drawText(source, rt) {
    const { gl, comp } = this;
    const sig = JSON.stringify([source.text, source.size, source.color, comp.width, comp.height]);
    if (rt.sig === sig && rt.tex) return;
    rt.sig = sig;
    const c = rt.canvas;
    c.width = comp.width; c.height = comp.height;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = source.color || '#ffffff';
    ctx.font = `bold ${source.size || 160}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    String(source.text || '').split('\n').forEach((line, i, all) => {
      ctx.fillText(line, c.width / 2, c.height / 2 + (i - (all.length - 1) / 2) * (source.size || 160) * 1.15);
    });
    if (!rt.tex) rt.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    this.texParams();
    rt.w = c.width; rt.h = c.height;
  }

  applyEffects(input, effects) {
    let cur = input;
    for (const fx of effects) {
      const def = EFFECTS[fx.type];
      if (!def || fx.bypass) continue;
      const values = new Float32Array(8);
      def.params.forEach((pd, i) => { values[i] = fx.values?.[i] ?? pd.def; });
      const next = this.acquire();
      this.use(this.program(`fx:${fx.type}`, `${HEADER}${def.glsl} void main(){o=fx(uv);}`), next, { tex: cur, p: values });
      this.release(cur);
      cur = next;
    }
    return cur;
  }

  renderClip(layer, clip, dt, gain, runtime) {
    const rt = this.step(layer, clip, dt, gain, runtime);
    if (rt.error) return null;
    const src = this.sourceTexture(clip, rt);
    if (!src) return null;
    const out = this.acquire();
    this.clear(out);
    this.use(this.program('transform', TRANSFORM), out, {
      tex: src.target || { tex: src.tex }, srcSize: [src.w, src.h], offset: [clip.x, clip.y], crop: src.crop || [1, 1],
      scale: clip.scale, rot: clip.rotation, opacity: clip.opacity,
    });
    if (src.target) this.release(src.target);
    return this.applyEffects(out, clip.effects);
  }

  frame(now = performance.now()) {
    const { comp } = this;
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
    this.time += dt;
    this.beat += dt * comp.bpm / 60;
    this.pending = this.pending.filter((q) => {
      if (this.beat < q.at) return true;
      this.connect(q.layer, q.clip);
      return false;
    });

    this.renderPreviewClip(dt);
    let base = this.acquire();
    this.clear(base, 1); // La composición parte de negro opaco.
    const anySolo = comp.layers.some((l) => l.solo);
    const x = comp.crossfader;
    for (const layer of comp.layers) {
      const st = this.state(layer);
      const sideGain = layer.side === 'A' ? Math.min(1, 1 - x) : layer.side === 'B' ? Math.min(1, 1 + x) : 1;
      const visible = !layer.bypass && (!anySolo || layer.solo);
      const gain = visible ? sideGain : 0;
      let tex = st.clip ? this.renderClip(layer, st.clip, dt, gain) : null;
      if (st.prev) {
        const k = layer.transition > 0 ? (this.time - st.fadeStart) / layer.transition : 1;
        if (k >= 1 || !tex) {
          this.pause(st.prev);
          st.prev = null;
        } else {
          const old = this.renderClip(layer, st.prev, dt, gain * (1 - k));
          if (old) {
            const mixed = this.acquire();
            this.use(this.program('mix', MIX), mixed, { tex: old, over: tex, k });
            this.release(old); this.release(tex);
            tex = mixed;
          }
        }
      }
      if (!tex) continue;
      tex = this.applyEffects(tex, layer.effects);
      if (this.previewTarget?.kind === 'layer' && this.previewTarget.layer === layer) this.showPreview(tex);
      if (visible && gain > 0) {
        const next = this.acquire();
        this.use(this.program('blend', BLEND), next, {
          tex: base, over: tex, mode: Math.max(0, BLEND_MODES.indexOf(layer.blend)), opacity: layer.opacity, gain,
        });
        this.release(base);
        base = next;
      }
      this.release(tex);
    }
    base = this.applyEffects(base, comp.effects);
    if (this.programTap) {
      const program = this.acquire();
      this.use(this.program('copy', COPY), program, { tex: base, flip: 0, gain: comp.opacity });
      this.programTap(program);
      this.release(program);
    }
    this.use(this.program('copy', COPY), null, { tex: base, flip: 1, gain: comp.opacity });
    this.release(base);
    if (this.previewTarget?.kind === 'comp') this.drawPreviewFromCanvas();
    for (const rt of this.runtimes.values()) {
      if (rt.live && rt.active && now - rt.usedAt > 2000) this.closeLive(rt);
      else if (rt.live) this.updateTally(rt);
    }
  }

  readPixel(x, y) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Uint8Array(4);
    gl.readPixels(x, this.comp.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out];
  }
}
