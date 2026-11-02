// Trabajador por clip: lee del disco y descomprime fuera del hilo de render.
import { decodeDxv, dxtThumbnail } from './dxv.js';

let meta = null;
let url = null;
let busy = false;
let wanted = -1;

async function readAt(offset, length) {
  const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  return new Uint8Array(await res.arrayBuffer());
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (wanted >= 0) {
      const index = wanted;
      wanted = -1;
      const started = performance.now();
      const packet = await readAt(meta.offsets[index], meta.sizes[index]);
      const frame = decodeDxv(packet, meta.width, meta.height);
      const msg = {
        type: 'frame', index, format: frame.format, data: frame.data, codedWidth: frame.codedWidth,
        codedHeight: frame.codedHeight, ms: performance.now() - started,
      };
      const transfer = [frame.data.buffer];
      if (meta.needThumb) {
        meta.needThumb = false;
        msg.thumb = dxtThumbnail(frame, meta.width, meta.height, 160, 90);
        transfer.push(msg.thumb.buffer);
      }
      self.postMessage(msg, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  } finally {
    busy = false;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'open') {
    url = m.url;
    meta = { ...m.meta, needThumb: true };
    wanted = m.first ?? 0;
    pump();
  } else if (m.type === 'want') {
    wanted = m.index;
    pump();
  }
};
