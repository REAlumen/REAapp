// Proceso aparte para NDI: las llamadas a la API oficial no deben frenar la interfaz.
// Usa el NDI Runtime instalado en el equipo (NDI Tools) a través de sus funciones NDIlib_*.
// Prácticas de la documentación del SDK: https://docs.ndi.video/all/developing-with-ndi/sdk
const koffi = require('koffi');
const { libcName, loadFirst } = require('./ndi-lib');

const FOURCC_RGBX = 0x58424752; // 'RGBX': las salidas son opacas, así NDI no codifica alfa.
const FRAME_PROGRESSIVE = 1;
const RECV_COLOR_RGBX_RGBA = 2;
const RECV_BANDWIDTH_HIGHEST = 100;
const FRAME_TYPE_VIDEO = 1;
const TIMECODE_SYNTHESIZE = 9223372036854775807n;
const MAX_PENDING_FRAMES = 2;
const MAX_NAME_LENGTH = 253;

let port = null;
let lib = null;
let finder = null;
const receivers = new Map();
let lastSources = '';

// Una entrada por salida (programa o pantalla): `latest` es el último cuadro; `onWire` lo retiene la API.
const outputs = new Map();

const send = (msg) => port?.postMessage(msg);

function loadNdi() {
  const dll = loadFirst((file) => koffi.load(file));
  const crt = koffi.load(libcName());

  const Source = koffi.struct('NDIlib_source_t', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
  const FindCreate = koffi.struct('NDIlib_find_create_t', { show_local_sources: 'bool', p_groups: 'const char *', p_extra_ips: 'const char *' });
  const SendCreate = koffi.struct('NDIlib_send_create_t', { p_ndi_name: 'const char *', p_groups: 'const char *', clock_video: 'bool', clock_audio: 'bool' });
  const VideoFrame = koffi.struct('NDIlib_video_frame_v2_t', {
    xres: 'int', yres: 'int', FourCC: 'uint32', frame_rate_N: 'int', frame_rate_D: 'int',
    picture_aspect_ratio: 'float', frame_format_type: 'int', timecode: 'int64',
    p_data: 'void *', line_stride_in_bytes: 'int', p_metadata: 'void *', timestamp: 'int64',
  });
  const RecvCreate = koffi.struct('NDIlib_recv_create_v3_t', {
    source_to_connect_to: Source, color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *',
  });
  const Tally = koffi.struct('NDIlib_tally_t', { on_program: 'bool', on_preview: 'bool' });

  lib = {
    Source, VideoFrame,
    memcpy: crt.func('memcpy', 'void *', ['void *', 'void *', 'size_t']),
    initialize: dll.func('NDIlib_initialize', 'bool', []),
    destroy: dll.func('NDIlib_destroy', 'void', []),
    version: dll.func('NDIlib_version', 'const char *', []),
    findCreate: dll.func('NDIlib_find_create_v2', 'void *', [koffi.pointer(FindCreate)]),
    findDestroy: dll.func('NDIlib_find_destroy', 'void', ['void *']),
    findSources: dll.func('NDIlib_find_get_current_sources', 'void *', ['void *', koffi.out(koffi.pointer('uint32'))]),
    sendCreate: dll.func('NDIlib_send_create', 'void *', [koffi.pointer(SendCreate)]),
    sendAsync: dll.func('NDIlib_send_send_video_async_v2', 'void', ['void *', koffi.pointer(VideoFrame)]),
    sendName: dll.func('NDIlib_send_get_source_name', 'void *', ['void *']),
    sendDestroy: dll.func('NDIlib_send_destroy', 'void', ['void *']),
    recvCreate: dll.func('NDIlib_recv_create_v3', 'void *', [koffi.pointer(RecvCreate)]),
    recvCapture: dll.func('NDIlib_recv_capture_v3', 'int', ['void *', koffi.out(koffi.pointer(VideoFrame)), 'void *', 'void *', 'uint32']),
    recvFreeVideo: dll.func('NDIlib_recv_free_video_v2', 'void', ['void *', koffi.pointer(VideoFrame)]),
    recvSetTally: dll.func('NDIlib_recv_set_tally', 'bool', ['void *', koffi.pointer(Tally)]),
    recvConnections: dll.func('NDIlib_recv_get_no_connections', 'int', ['void *']),
    recvDestroy: dll.func('NDIlib_recv_destroy', 'void', ['void *']),
  };
  if (!lib.initialize()) throw new Error('NDI no pudo iniciarse: la CPU no es compatible');
  finder = lib.findCreate({ show_local_sources: true, p_groups: null, p_extra_ips: null });
}

function pollSources() {
  const count = [0];
  const ptr = lib.findSources(finder, count);
  const names = count[0] && ptr ? koffi.decode(ptr, lib.Source, count[0]).map((s) => s.p_ndi_name) : [];
  const text = JSON.stringify(names);
  if (text !== lastSources) {
    lastSources = text;
    send({ type: 'sources', names });
  }
}

function pollStatus() {
  for (const [id, r] of receivers) {
    const connected = lib.recvConnections(r.instance) > 0;
    if (connected !== r.connected) {
      r.connected = connected;
      send({ type: 'recv-status', id, connected });
    }
  }
  for (const [key, o] of outputs) {
    send({ type: 'send-stats', key, wireFps: o.sent });
    o.sent = 0;
  }
}

// Copia con memcpy: Electron no permite exponer memoria externa como ArrayBuffer.
function copyFrame(f) {
  const row = f.xres * 4;
  const total = f.line_stride_in_bytes * f.yres;
  const raw = new Uint8Array(total);
  lib.memcpy(raw, f.p_data, total);
  if (f.line_stride_in_bytes === row) return raw;
  const data = new Uint8Array(row * f.yres);
  for (let y = 0; y < f.yres; y++) data.set(raw.subarray(y * f.line_stride_in_bytes, y * f.line_stride_in_bytes + row), y * row);
  return data;
}

function pollReceivers() {
  for (const [id, r] of receivers) {
    const out = [{}];
    if (lib.recvCapture(r.instance, out, null, null, 0) !== FRAME_TYPE_VIDEO) continue;
    const f = out[0];
    // Si el render va atrasado se descarta el cuadro en vez de acumular retraso. Siempre se libera.
    if (r.pending < MAX_PENDING_FRAMES) {
      const data = copyFrame(f);
      r.pending++;
      send({ type: 'frame', id, width: f.xres, height: f.yres, data });
    }
    lib.recvFreeVideo(r.instance, f);
  }
}

function destroyOutput(key) {
  const o = outputs.get(key);
  if (!o) return;
  if (o.instance) {
    lib.sendAsync(o.instance, null); // Punto de sincronía: la API suelta el búfer antes de destruir.
    lib.sendDestroy(o.instance);
  }
  outputs.delete(key);
  send({ type: 'send-name', key, name: null });
}

// Mantiene la cadencia declarada: si el render no entregó cuadro nuevo a tiempo, se repite el último.
function pumpOutputs() {
  const now = performance.now();
  for (const [key, o] of outputs) {
    const f = o.latest;
    if (!f) continue;
    if (o.name !== f.name) {
      if (o.instance) {
        lib.sendAsync(o.instance, null);
        lib.sendDestroy(o.instance);
      }
      o.instance = lib.sendCreate({ p_ndi_name: f.name.slice(0, MAX_NAME_LENGTH), p_groups: null, clock_video: false, clock_audio: false });
      if (!o.instance) throw new Error(`No se pudo crear la salida NDI ${f.name}`);
      o.name = f.name;
      o.next = 0;
      o.published = null;
    }
    const period = 1000 / f.fps;
    if (now < o.next) continue;
    o.next = o.next && now - o.next < period * 2 ? o.next + period : now + period;
    lib.sendAsync(o.instance, {
      xres: f.width, yres: f.height, FourCC: FOURCC_RGBX, frame_rate_N: f.fps * 1000, frame_rate_D: 1000,
      picture_aspect_ratio: f.width / f.height, frame_format_type: FRAME_PROGRESSIVE,
      timecode: TIMECODE_SYNTHESIZE, p_data: f.data, line_stride_in_bytes: f.width * 4, p_metadata: null, timestamp: 0n,
    });
    o.onWire = f;
    o.sent++;
    const ptr = lib.sendName(o.instance);
    const published = ptr ? koffi.decode(ptr, lib.Source).p_ndi_name : null;
    if (published !== o.published) {
      o.published = published;
      send({ type: 'send-name', key, name: published });
    }
  }
}

function closeReceiver(id) {
  const r = receivers.get(id);
  if (r) { lib.recvDestroy(r.instance); receivers.delete(id); }
}

function onMessage(m) {
  try {
    if (m.type === 'send-frame') {
      let o = outputs.get(m.key);
      if (!o) {
        o = { instance: null, name: null, latest: null, onWire: null, next: 0, sent: 0, published: null };
        outputs.set(m.key, o);
      }
      o.latest = m;
      send({ type: 'sent', key: m.key });
    } else if (m.type === 'send-stop') destroyOutput(m.key);
    else if (m.type === 'recv-open') {
      const instance = lib.recvCreate({
        source_to_connect_to: { p_ndi_name: m.name, p_url_address: null },
        color_format: RECV_COLOR_RGBX_RGBA, bandwidth: RECV_BANDWIDTH_HIGHEST, allow_video_fields: false, p_ndi_recv_name: `REAlumen ${m.id}`,
      });
      if (!instance) throw new Error(`No se pudo conectar a ${m.name}`);
      receivers.set(m.id, { instance, pending: 0, connected: null });
    } else if (m.type === 'recv-close') closeReceiver(m.id);
    else if (m.type === 'recv-tally') {
      const r = receivers.get(m.id);
      if (r) lib.recvSetTally(r.instance, { on_program: m.program, on_preview: m.preview });
    } else if (m.type === 'frame-done') {
      const r = receivers.get(m.id);
      if (r) r.pending = Math.max(0, r.pending - 1);
    }
  } catch (err) {
    send({ type: 'error', message: err.message, source: m.type, id: m.id, key: m.key });
  }
}

function shutdown() {
  if (lib) {
    for (const id of [...receivers.keys()]) closeReceiver(id);
    for (const key of [...outputs.keys()]) destroyOutput(key);
    lib.findDestroy(finder);
    lib.destroy();
  }
  process.exit(0);
}

const guarded = (fn) => () => {
  try {
    fn();
  } catch (err) {
    send({ type: 'error', message: err.message, source: fn.name });
  }
};

process.parentPort.on('message', (e) => {
  if (e.data?.type === 'shutdown') { shutdown(); return; }
  if (e.data?.type !== 'port') return;
  [port] = e.ports;
  port.on('message', (ev) => { if (lib) onMessage(ev.data); });
  port.start();
  try {
    loadNdi();
    send({ type: 'status', available: true, version: lib.version() });
    guarded(pollSources)();
    setInterval(guarded(pollSources), 1000);
    setInterval(guarded(pollStatus), 1000);
    setInterval(guarded(() => { pollReceivers(); pumpOutputs(); }), 2);
  } catch (err) {
    send({ type: 'status', available: false, error: err.message });
  }
});
