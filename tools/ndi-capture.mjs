// Captura cuadros de una fuente NDI con la API oficial, para comparar la salida real de la app de referencia.
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const koffi = require('koffi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dll = koffi.load(path.join(process.env.NDI_RUNTIME_DIR_V6, 'Processing.NDI.Lib.x64.dll'));
const Source = koffi.struct('OracleSource', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
const FindCreate = koffi.struct('OracleFind', { show_local_sources: 'bool', p_groups: 'const char *', p_extra_ips: 'const char *' });
const VideoFrame = koffi.struct('OracleFrame', {
  xres: 'int', yres: 'int', FourCC: 'uint32', frame_rate_N: 'int', frame_rate_D: 'int', picture_aspect_ratio: 'float',
  frame_format_type: 'int', timecode: 'int64', p_data: 'void *', line_stride_in_bytes: 'int', p_metadata: 'void *', timestamp: 'int64',
});
const RecvCreate = koffi.struct('OracleRecv', { source_to_connect_to: Source, color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *' });
const initialize = dll.func('NDIlib_initialize', 'bool', []);
const findCreate = dll.func('NDIlib_find_create_v2', 'void *', [koffi.pointer(FindCreate)]);
const findSources = dll.func('NDIlib_find_get_current_sources', 'void *', ['void *', koffi.out(koffi.pointer('uint32'))]);
const recvCreate = dll.func('NDIlib_recv_create_v3', 'void *', [koffi.pointer(RecvCreate)]);
const recvCapture = dll.func('NDIlib_recv_capture_v3', 'int', ['void *', koffi.out(koffi.pointer(VideoFrame)), 'void *', 'void *', 'uint32']);
const recvFree = dll.func('NDIlib_recv_free_video_v2', 'void', ['void *', koffi.pointer(VideoFrame)]);
const recvDestroy = dll.func('NDIlib_recv_destroy', 'void', ['void *']);

const RGBX_RGBA = 2;
const HIGHEST = 100;
const MIN_FRESH_FRAMES = 12;

export async function connect(match, timeoutMs = 8000) {
  if (!initialize()) throw new Error('NDI no pudo iniciarse');
  const finder = findCreate({ show_local_sources: true, p_groups: null, p_extra_ips: null });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = [0];
    const p = findSources(finder, n);
    const names = n[0] ? koffi.decode(p, Source, n[0]).map((s) => s.p_ndi_name) : [];
    const name = names.find((s) => s.includes(match));
    if (name) {
      const instance = recvCreate({ source_to_connect_to: { p_ndi_name: name, p_url_address: null }, color_format: RGBX_RGBA, bandwidth: HIGHEST, allow_video_fields: false, p_ndi_recv_name: 'REAlumen Oracle' });
      return { name, instance };
    }
    await sleep(200);
  }
  throw new Error(`Fuente NDI con "${match}" no encontrada`);
}

// Descarta cuadros antiguos durante `settleMs` y devuelve el siguiente como RGBA compacto.
export async function capture(recv, settleMs = 500) {
  // Al conectar, el primer cuadro de la app de referencia tardó unos 4 s.
  const end = Date.now() + settleMs + 10000;
  const settled = Date.now() + settleMs;
  let frames = 0;
  while (Date.now() < end) {
    const out = [{}];
    if (recvCapture(recv.instance, out, null, null, 50) !== 1) { await sleep(0); continue; }
    const f = out[0];
    // Exige cuadros nuevos: el primero tras conectar puede ser anterior al último cambio.
    if (Date.now() < settled || ++frames < MIN_FRESH_FRAMES) { recvFree(recv.instance, f); continue; }
    const raw = new Uint8Array(koffi.view(f.p_data, f.line_stride_in_bytes * f.yres));
    const data = new Uint8Array(f.xres * f.yres * 4);
    for (let y = 0; y < f.yres; y++) data.set(raw.subarray(y * f.line_stride_in_bytes, y * f.line_stride_in_bytes + f.xres * 4), y * f.xres * 4);
    const frame = { width: f.xres, height: f.yres, data };
    recvFree(recv.instance, f);
    return frame;
  }
  throw new Error('No llegaron cuadros NDI');
}

export const close = (recv) => recvDestroy(recv.instance);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function writePng(file, frame) {
  const { width, height, data } = frame;
  const row = width * 4;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * row, row).copy(raw, y * (row + 1) + 1);
  const chunk = (type, body) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]));
}
