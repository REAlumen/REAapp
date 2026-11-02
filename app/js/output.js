import { buildSliceMesh } from './warp.js';
import { FrameSender } from './ndi.js';
import { stackItems } from './slice-ops.js';

const VS = `#version 300 es
in vec2 pos; in vec2 uvIn; in vec2 stIn; out vec2 uv; out vec2 st; uniform vec2 size;
void main(){uv=uvIn; st=stIn; vec2 c=pos/size*2.-1.; gl_Position=vec4(c.x,-c.y,0,1);}`;
const FS = `#version 300 es
precision highp float; in vec2 uv; in vec2 st; out vec4 o;
uniform sampler2D comp, inMask; uniform float opacity, brightness, contrast, gamma, test, isKey, blackOut; uniform vec3 gainRGB; uniform vec4 edge;
void main(){
  if(blackOut>.5){o=vec4(0,0,0,1);return;}
  vec4 c=texture(comp,uv);
  if(test>.5){
    vec2 g=fract(st*8.); float l=step(g.x,.02)+step(g.y,.02);
    c=vec4(mix(vec3(st,.5),vec3(1),clamp(l,0.,1.)),1);
  }
  c.rgb=(c.rgb-.5)*contrast+.5+brightness;
  c.rgb*=gainRGB;
  float k=opacity*texture(inMask,uv).r;
  if(isKey>.5)k*=dot(clamp(c.rgb,0.,1.),vec3(.299,.587,.114));
  if(edge.x>0.)k*=pow(clamp(st.x/edge.x,0.,1.),gamma);
  if(edge.y>0.)k*=pow(clamp((1.-st.x)/edge.y,0.,1.),gamma);
  if(edge.z>0.)k*=pow(clamp(st.y/edge.z,0.,1.),gamma);
  if(edge.w>0.)k*=pow(clamp((1.-st.y)/edge.w,0.,1.),gamma);
  o=vec4(clamp(c.rgb,0.,1.)*k,1);
}`;
const MASK_VS = `#version 300 es
in vec2 pos; out vec2 uv; void main(){uv=vec2(pos.x*.5+.5,.5-pos.y*.5); gl_Position=vec4(pos,0,1);}`;
const MASK_FS = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D mask; uniform float opacity;
void main(){o=vec4(0,0,0,mix(1.,texture(mask,uv).r,opacity));}`;

// Convierte la lista de máscaras en una textura de luminancia: blanco = visible.
export function rasterizeMasks(canvas, masks, w, h) {
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const path = (m, c) => {
    c.beginPath();
    if (m.kind === 'ellipse') {
      const [a, b] = m.points;
      c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    } else {
      m.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
    }
  };
  for (const m of masks) {
    if (!m.enabled) continue;
    // Cada máscara recorta lo visible: normal oculta su interior; invertida oculta su exterior.
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const c = layer.getContext('2d');
    if (m.feather > 0) c.filter = `blur(${m.feather}px)`;
    c.fillStyle = '#000';
    if (m.invert) {
      c.fillRect(0, 0, layer.width, layer.height);
      c.globalCompositeOperation = 'destination-out';
      c.filter = m.feather > 0 ? `blur(${m.feather}px)` : 'none';
      path(m, c);
      c.fillStyle = '#000';
      c.fill();
    } else {
      path(m, c);
      c.fill();
    }
    ctx.drawImage(layer, 0, 0);
  }
}

export class OutputRenderer {
  constructor(screen, comp) {
    this.screen = screen;
    this.comp = comp;
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 no disponible para la salida');
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = (vs, fs, attrs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    this.prog = link(VS, FS, ['pos', 'uvIn', 'stIn']);
    this.maskProg = link(MASK_VS, MASK_FS, ['pos']);
    this.loc = {};
    for (const n of ['size', 'comp', 'inMask', 'opacity', 'brightness', 'contrast', 'gamma', 'test', 'gainRGB', 'edge', 'isKey', 'blackOut']) {
      this.loc[n] = gl.getUniformLocation(this.prog, n);
    }
    this.maskLoc = { mask: gl.getUniformLocation(this.maskProg, 'mask'), opacity: gl.getUniformLocation(this.maskProg, 'opacity') };
    this.compTex = this.newTex();
    // Blanco de 1 píxel: un slice sin máscara de entrada se ve completo.
    this.noMaskTex = this.newTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.maskTextures = new Map();
    this.maskCanvas = document.createElement('canvas');
    this.vbo = gl.createBuffer();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.meshes = new Map();
    this.invalidate();
  }

  newTex() {
    const { gl } = this;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  invalidate() {
    this.meshes.clear();
    this.masksDirty = true;
  }

  uploadMask(id, masks, w, h) {
    const { gl } = this;
    rasterizeMasks(this.maskCanvas, masks, w, h);
    let tex = this.maskTextures.get(id);
    if (!tex) {
      tex = this.newTex();
      this.maskTextures.set(id, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
  }

  updateMasks() {
    const { gl, screen, comp } = this;
    const used = new Set();
    for (const m of screen.masks) {
      used.add(m.id);
      this.uploadMask(m.id, [m], screen.width, screen.height);
    }
    for (const s of screen.slices) {
      if (!s.inputMasks?.length) continue;
      used.add(s.id);
      this.uploadMask(s.id, s.inputMasks, comp.width, comp.height);
    }
    for (const [id, tex] of this.maskTextures) {
      if (!used.has(id)) {
        gl.deleteTexture(tex);
        this.maskTextures.delete(id);
      }
    }
    this.masksDirty = false;
  }

  render(source) {
    const { gl, screen, comp, canvas, loc } = this;
    if (canvas.width !== screen.width || canvas.height !== screen.height) {
      canvas.width = screen.width;
      canvas.height = screen.height;
      this.masksDirty = true;
    }
    if (this.masksDirty) this.updateMasks();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.enable(gl.BLEND);
    const anySolo = screen.slices.some((s) => s.solo);
    const useSliceProgram = () => {
      gl.useProgram(this.prog);
      gl.uniform1i(loc.comp, 0);
      gl.uniform1i(loc.inMask, 1);
      gl.uniform2f(loc.size, screen.width, screen.height);
      gl.uniform1f(loc.test, screen.testPattern ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 8);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.compTex);
      gl.blendFunc(gl.ONE, gl.ONE); // Los solapes con soft edge suman luz, como en un proyector real.
    };
    useSliceProgram();
    for (const s of stackItems(screen)) {
      if (!s.enabled) continue;
      if (s.points) {
        // Máscara de salida: tapa en negro lo ya dibujado debajo de ella.
        const tex = this.maskTextures.get(s.id);
        if (!tex) continue;
        gl.useProgram(this.maskProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(this.maskLoc.mask, 0);
        gl.uniform1f(this.maskLoc.opacity, 1);
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        useSliceProgram();
        continue;
      }
      if (anySolo && !s.solo) continue;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (s.inputMasks?.length && this.maskTextures.get(s.id)) || this.noMaskTex);
      let mesh = this.meshes.get(s.id);
      if (!mesh) {
        mesh = buildSliceMesh(s, comp.width, comp.height);
        this.meshes.set(s.id, mesh);
      }
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);
      if (s.blackBg) {
        // Black BG: tapa lo que haya debajo del slice antes de dibujarlo.
        gl.uniform1f(loc.blackOut, 1);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.length / 6);
        gl.blendFunc(gl.ONE, gl.ONE);
      }
      gl.uniform1f(loc.blackOut, 0);
      gl.uniform1f(loc.opacity, s.opacity * screen.opacity);
      gl.uniform1f(loc.brightness, s.brightness + screen.brightness);
      gl.uniform1f(loc.contrast, (1 + s.contrast) * (1 + screen.contrast));
      gl.uniform3f(loc.gainRGB, (1 + s.r) * (1 + screen.r), (1 + s.g) * (1 + screen.g), (1 + s.b) * (1 + screen.b));
      gl.uniform1f(loc.isKey, s.isKey ? 1 : 0);
      const edge = s.edge.enabled === false ? { left: 0, right: 0, top: 0, bottom: 0 } : s.edge;
      gl.uniform1f(loc.gamma, s.edge.gamma);
      gl.uniform4f(loc.edge, edge.left, edge.right, edge.top, edge.bottom);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.length / 6);
    }
    gl.disable(gl.BLEND);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// Coordina los renderers y las ventanas de salida física.
export class OutputManager {
  constructor(sourceCanvas, ndi) {
    this.source = sourceCanvas;
    this.ndi = ndi;
    this.renderers = new Map();
    this.windows = new Map();
    this.senders = new Map();
    this.previewActive = false;
  }

  setComposition(comp) {
    this.closeAll();
    for (const id of [...this.senders.keys()]) this.stopNdi(id);
    for (const r of this.renderers.values()) r.dispose();
    this.renderers.clear();
    this.comp = comp;
  }

  // Aplica el dispositivo de la pantalla: virtual, ventana, pantalla completa o NDI.
  applyDevice(screen) {
    const { device } = screen;
    if (device.type !== 'ndi') this.stopNdi(screen.id);
    const wantsWindow = device.type === 'fullscreen' || device.type === 'windowed';
    const open = this.windows.get(screen.id);
    const same = open && open.displayId === device.displayId && open.mode === device.type;
    if (!wantsWindow) this.closeWindow(screen.id);
    else if (!same) this.openWindow(screen);
  }

  stopNdi(id) {
    const sender = this.senders.get(id);
    if (sender) {
      sender.stop();
      this.senders.delete(id);
    }
  }

  ndiName(screen) {
    return `REAlumen - ${screen.device.name || screen.name}`;
  }

  renderer(screen) {
    let r = this.renderers.get(screen.id);
    if (!r) {
      r = new OutputRenderer(screen, this.comp);
      this.renderers.set(screen.id, r);
    }
    r.screen = screen;
    r.comp = this.comp;
    return r;
  }

  invalidate(screen) {
    this.renderers.get(screen.id)?.invalidate();
  }

  removeScreen(screen) {
    this.closeWindow(screen.id);
    this.stopNdi(screen.id);
    this.renderers.get(screen.id)?.dispose();
    this.renderers.delete(screen.id);
  }

  openWindow(screen) {
    this.closeWindow(screen.id);
    const { device } = screen;
    const win = window.open('about:blank', `output:${device.displayId}:${device.type}:${screen.id}`);
    if (!win) throw new Error('No se pudo abrir la ventana de salida');
    // Salida de emergencia: Esc o Ctrl+Mayús+D desactivan la salida, incluso a pantalla completa.
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.ctrlKey && e.shiftKey && e.code === 'KeyD')) {
        screen.device = { type: 'virtual' };
        this.closeWindow(screen.id);
        this.onWindowClosed?.();
      }
    });
    const doc = win.document;
    doc.title = `Salida — ${screen.name}`;
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
    const canvas = doc.createElement('canvas');
    canvas.style.cssText = 'width:100vw;height:100vh;display:block;';
    canvas.width = screen.width;
    canvas.height = screen.height;
    doc.body.appendChild(canvas);
    const entry = { win, canvas, ctx: canvas.getContext('2d', { alpha: false }), displayId: device.displayId, mode: device.type };
    this.windows.set(screen.id, entry);
    win.focus();
    return entry;
  }

  closeWindow(id) {
    const w = this.windows.get(id);
    if (w && !w.win.closed) w.win.close();
    this.windows.delete(id);
  }

  closeAll() {
    for (const id of [...this.windows.keys()]) this.closeWindow(id);
  }

  frame() {
    if (!this.comp) return;
    for (const screen of this.comp.screens) {
      const w = this.windows.get(screen.id);
      if (w && w.win.closed) { this.windows.delete(screen.id); screen.device = { type: 'virtual' }; this.onWindowClosed?.(); continue; }
      const toNdi = screen.device.type === 'ndi' && this.ndi?.available;
      if (!w && !toNdi && !this.previewActive) continue;
      if (screen.enabled === false && !this.previewActive) continue;
      const r = this.renderer(screen);
      r.render(this.source);
      if (toNdi) {
        let sender = this.senders.get(screen.id);
        if (!sender) {
          sender = new FrameSender(r.gl, this.ndi, screen.id);
          this.senders.set(screen.id, sender);
        }
        sender.tap(null, screen.width, screen.height, this.ndiName(screen), screen.device.fps || 30, true);
      }
      if (w) {
        if (w.canvas.width !== screen.width || w.canvas.height !== screen.height) {
          w.canvas.width = screen.width;
          w.canvas.height = screen.height;
        }
        w.ctx.drawImage(r.canvas, 0, 0);
      }
    }
  }
}
