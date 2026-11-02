// Cliente NDI del renderer: habla con ndi-host.js por un MessagePort.
export class NdiClient {
  constructor() {
    this.available = false;
    this.error = 'Iniciando NDI…';
    this.sources = [];
    this.handlers = new Map();
    this.nextId = 1;
    this.onChange = () => {};
    this.outputs = new Map();
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    window.addEventListener('message', (e) => {
      if (e.data === 'ndi-port' && e.ports[0]) this.attach(e.ports[0]);
      if (e.data === 'ndi-exit') {
        this.available = false;
        this.error = 'El proceso de NDI se detuvo. Reinicia la app.';
        this.resolveReady();
        this.onChange();
      }
    });
  }

  attach(port) {
    this.port = port;
    port.onmessage = (e) => this.onMessage(e.data);
    port.start();
  }

  // Estado de una salida: 'program' para la composición o el id de una pantalla.
  output(key) {
    let o = this.outputs.get(key);
    if (!o) {
      o = { waiting: 0, sentFrames: 0, wireFps: 0, publishedName: null, error: null };
      this.outputs.set(key, o);
    }
    return o;
  }

  onMessage(m) {
    if (m.type === 'status') {
      this.available = m.available;
      this.error = m.available ? null : m.error;
      this.version = m.version;
      this.resolveReady();
      this.onChange();
    } else if (m.type === 'sources') {
      this.sources = m.names;
      this.onChange();
    } else if (m.type === 'frame') {
      this.port.postMessage({ type: 'frame-done', id: m.id });
      this.handlers.get(m.id)?.onFrame(m);
    } else if (m.type === 'sent') {
      const o = this.output(m.key);
      o.waiting = Math.max(0, o.waiting - 1);
      o.sentFrames++;
    } else if (m.type === 'send-stats') {
      this.output(m.key).wireFps = m.wireFps;
    } else if (m.type === 'send-name') {
      this.output(m.key).publishedName = m.name;
      this.onChange();
    } else if (m.type === 'recv-status') {
      this.handlers.get(m.id)?.onStatus(m.connected);
    } else if (m.type === 'error') {
      console.error('NDI:', m.message);
      if (m.id) this.handlers.get(m.id)?.onError(m.message);
      else if (m.key) {
        const o = this.output(m.key);
        o.error = m.message;
        o.waiting = 0;
        this.onChange();
      }
    }
  }

  openReceiver(name, { onFrame, onError, onStatus }) {
    const id = this.nextId++;
    this.handlers.set(id, { onFrame, onError, onStatus });
    this.port.postMessage({ type: 'recv-open', id, name });
    return id;
  }

  setTally(id, program, preview) {
    this.port.postMessage({ type: 'recv-tally', id, program, preview });
  }

  closeReceiver(id) {
    this.handlers.delete(id);
    this.port?.postMessage({ type: 'recv-close', id });
  }

  sendFrame(key, name, width, height, fps, data) {
    this.output(key).waiting++;
    this.port.postMessage({ type: 'send-frame', key, name, width, height, fps, data });
  }

  stopSending(key) {
    const o = this.output(key);
    o.waiting = 0;
    this.port?.postMessage({ type: 'send-stop', key });
  }
}

// Lee un framebuffer con un búfer asíncrono para no frenar el render y lo envía a NDI.
export class FrameSender {
  constructor(gl, ndi, key) {
    this.gl = gl;
    this.ndi = ndi;
    this.key = key;
    this.pbo = null;
    this.fence = null;
    this.last = 0;
  }

  // `flip`: un framebuffer de pantalla llega con la primera fila abajo.
  tap(fbo, width, height, name, fps, flip) {
    const { gl } = this;
    const size = width * height * 4;
    if (this.fence) {
      const state = gl.clientWaitSync(this.fence, 0, 0);
      if (state === gl.TIMEOUT_EXPIRED) return;
      gl.deleteSync(this.fence);
      this.fence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      if (this.bytes?.length !== size) {
        this.bytes = new Uint8Array(size);
        this.flipped = flip ? new Uint8Array(size) : null;
      }
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (this.pendingSize === size) {
        let data = this.bytes;
        if (flip) {
          const row = width * 4;
          for (let y = 0; y < height; y++) this.flipped.set(this.bytes.subarray((height - 1 - y) * row, (height - y) * row), y * row);
          data = this.flipped;
        }
        this.ndi.sendFrame(this.key, name, width, height, fps, data);
      }
    }
    const now = performance.now();
    // Con un cuadro ya en camino se puede leer el siguiente; con dos, el proceso NDI va atrasado.
    if (this.ndi.output(this.key).waiting >= 2 || now - this.last < 1000 / fps - 2) return;
    this.last = now;
    if (!this.pbo) this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (this.pboSize !== size) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      this.pboSize = size;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pendingSize = size;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  stop() {
    if (this.fence) { this.gl.deleteSync(this.fence); this.fence = null; }
    this.ndi.stopSending(this.key);
  }
}

// Salida NDI de la composición completa.
export class ProgramSender {
  constructor(engine, ndi) {
    this.engine = engine;
    this.ndi = ndi;
    this.sender = new FrameSender(engine.gl, ndi, 'program');
    this.running = false;
  }

  sync(config) {
    this.config = config;
    const want = !!config?.enabled && this.ndi.available;
    if (want && !this.running) {
      this.running = true;
      this.engine.programTap = (target) => {
        const { width, height } = this.engine.comp;
        this.sender.tap(target.fbo, width, height, this.config.name || 'REAlumen', this.config.fps, false);
      };
    } else if (!want && this.running) {
      this.running = false;
      this.engine.programTap = null;
      this.sender.stop();
    }
  }
}
