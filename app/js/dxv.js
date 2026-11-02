// Decodificador de paquetes DXV: devuelve la textura DXT lista para subir a la GPU, como hace Arena.
// La lógica de descompresión sigue libavcodec/dxv.c de FFmpeg (LGPL-2.1-or-later);
// este archivo se distribuye bajo esa misma licencia.

const FORMAT_DXT1 = 0x44585431; // 'DXT1'
const FORMAT_DXT5 = 0x44585435; // 'DXT5'
const FORMAT_YCG6 = 0x59434736; // 'YCG6'
const FORMAT_YG10 = 0x59473130; // 'YG10'

const align16 = (n) => (n + 15) & ~15;
const invalid = () => new Error('Paquete DXV dañado');

class Reader {
  constructor(src, pos = 0) { this.src = src; this.pos = pos; }

  get left() { return this.src.length - this.pos; }

  u8() {
    if (this.pos >= this.src.length) throw invalid();
    return this.src[this.pos++];
  }

  u16() {
    const { src, pos } = this;
    if (pos + 2 > src.length) throw invalid();
    this.pos = pos + 2;
    return src[pos] | (src[pos + 1] << 8);
  }

  u32() {
    const { src, pos } = this;
    if (pos + 4 > src.length) throw invalid();
    this.pos = pos + 4;
    return (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
  }
}

// Fuente de operaciones de 2 bits: 0 = nuevo; 1 = copia de -x; 2 y 3 = copia de una distancia leída.
function checkpoints(r, x) {
  let value = 0;
  let state = 0;
  const cp = {
    idx: 0,
    next(pos) {
      if (state === 0) {
        value = r.u32();
        state = 16;
      }
      const op = value & 3;
      value >>>= 2;
      state--;
      if (op === 1) cp.idx = x;
      else if (op === 2) {
        cp.idx = (r.u8() + 2) * x;
        if (cp.idx > pos) throw invalid();
      } else if (op === 3) {
        cp.idx = (r.u16() + 0x102) * x;
        if (cp.idx > pos) throw invalid();
      }
      return op;
    },
    bits() {
      if (state === 0) {
        value = r.u32();
        state = 16;
      }
      const op = value & 3;
      value >>>= 2;
      state--;
      return op;
    },
  };
  return cp;
}

function decompressDxt1(r, out) {
  const total = out.length;
  const cp = checkpoints(r, 2);
  out[0] = r.u32();
  out[1] = r.u32();
  let pos = 2;
  while (pos + 2 <= total) {
    if (cp.next(pos)) {
      out[pos] = out[pos - cp.idx]; pos++;
      out[pos] = out[pos - cp.idx]; pos++;
    } else {
      out[pos] = cp.next(pos) ? out[pos - cp.idx] : r.u32(); pos++;
      out[pos] = cp.next(pos) ? out[pos - cp.idx] : r.u32(); pos++;
    }
  }
}

function decompressDxt5(r, out) {
  const total = out.length;
  const cp = checkpoints(r, 4);
  for (let i = 0; i < 4; i++) out[i] = r.u32();
  let pos = 4;
  let run = 0;
  const checkIdx = (idx) => { if (idx > pos || pos - idx + 2 > total) throw invalid(); };
  while (pos + 2 <= total) {
    if (run) {
      run--;
      out[pos] = out[pos - 4]; pos++;
      out[pos] = out[pos - 4]; pos++;
    } else {
      if (r.left < 1) throw invalid();
      const op = cp.bits();
      if (op === 0) {
        let check = r.u8() + 1;
        if (check === 256) {
          let probe;
          do { probe = r.u16(); check += probe; } while (probe === 0xffff);
        }
        while (check && pos + 4 <= total) {
          out[pos] = out[pos - 4]; pos++;
          out[pos] = out[pos - 4]; pos++;
          out[pos] = out[pos - 4]; pos++;
          out[pos] = out[pos - 4]; pos++;
          check--;
        }
        continue;
      } else if (op === 1) {
        run = r.u8();
        if (run === 255) {
          let probe;
          do { probe = r.u16(); run += probe; } while (probe === 0xffff);
        }
        out[pos] = out[pos - 4]; pos++;
        out[pos] = out[pos - 4]; pos++;
      } else if (op === 2) {
        const idx = 8 + r.u16();
        checkIdx(idx);
        out[pos] = out[pos - idx]; pos++;
        out[pos] = out[pos - idx]; pos++;
      } else {
        out[pos++] = r.u32();
        out[pos++] = r.u32();
      }
    }
    if (cp.next(pos)) {
      if (pos + 2 > total) throw invalid();
      checkIdx(cp.idx);
      out[pos] = out[pos - cp.idx]; pos++;
      out[pos] = out[pos - cp.idx]; pos++;
    } else {
      if (pos + 2 > total) throw invalid();
      if (cp.next(pos)) {
        checkIdx(cp.idx);
        out[pos] = out[pos - cp.idx];
      } else out[pos] = r.u32();
      pos++;
      out[pos] = cp.next(pos) ? out[pos - cp.idx] : r.u32();
      pos++;
    }
  }
}

function decompressLzf(r, bytes) {
  let o = 0;
  while (r.left > 0) {
    const s = r.u8();
    if (s < 32) {
      const n = s + 1;
      if (o + n > bytes.length || r.left < n) throw invalid();
      bytes.set(r.src.subarray(r.pos, r.pos + n), o);
      r.pos += n;
      o += n;
    } else {
      let len = s >> 5;
      if (len === 7) len += r.u8();
      const off = ((s & 0x1f) << 8) + r.u8() + 1;
      len += 2;
      if (off > o || o + len > bytes.length) throw invalid();
      for (let i = 0; i < len; i++, o++) bytes[o] = bytes[o - off];
    }
  }
}

// Devuelve { format, data, codedWidth, codedHeight } con bloques DXT en orden de filas.
export function decodeDxv(packet, width, height) {
  const r = new Reader(packet);
  const tag = r.u32();
  const codedWidth = align16(width);
  const codedHeight = align16(height);
  let format;
  let mode;
  let size = 0;
  let oldType = 0;
  let ratio;
  if (tag === FORMAT_DXT1) { format = 'dxt1'; mode = 'dxt1'; ratio = 8; }
  else if (tag === FORMAT_DXT5) { format = 'dxt5'; mode = 'dxt5'; ratio = 4; }
  else if (tag === FORMAT_YCG6 || tag === FORMAT_YG10) {
    throw new Error('DXV de alta calidad (YCoCg) aún no compatible');
  } else {
    size = tag & 0x00ffffff;
    oldType = tag >>> 24;
    mode = oldType & 0x80 ? 'raw' : 'lzf';
    if (oldType & 0x40) format = 'dxt5';
    else if (oldType & 0x20 || (oldType & 0x0f) - 1 === 1) format = 'dxt1';
    else throw new Error('Cabecera DXV no reconocida');
    ratio = format === 'dxt1' ? 8 : 4;
  }
  if (!oldType) {
    r.u8();
    r.u8();
    if (r.u8()) mode = 'raw';
    r.u8();
    size = r.u32();
  }
  if (size !== r.left) throw invalid();
  // La textura ocupa 8 bytes (DXT1) o 16 (DXT5) por cada bloque de 4x4.
  const texSize = (codedWidth * codedHeight * 4) / ratio;
  const buffer = new ArrayBuffer(texSize);
  if (mode === 'dxt1') decompressDxt1(r, new Uint32Array(buffer));
  else if (mode === 'dxt5') decompressDxt5(r, new Uint32Array(buffer));
  else if (mode === 'raw') {
    if (r.left < texSize) throw invalid();
    new Uint8Array(buffer).set(packet.subarray(r.pos, r.pos + texSize));
  } else decompressLzf(r, new Uint8Array(buffer));
  return { format, data: new Uint8Array(buffer), codedWidth, codedHeight, leftover: r.left };
}

// Miniatura sin GPU: toma el color base del bloque más cercano a cada píxel.
export function dxtThumbnail(frame, width, height, tw, th) {
  const step = frame.format === 'dxt1' ? 8 : 16;
  const colorAt = frame.format === 'dxt1' ? 0 : 8;
  const blocksW = frame.codedWidth / 4;
  const rgba = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const by = Math.floor(((y + 0.5) / th) * (height / 4));
    for (let x = 0; x < tw; x++) {
      const bx = Math.floor(((x + 0.5) / tw) * (width / 4));
      const o = (by * blocksW + bx) * step + colorAt;
      const c = frame.data[o] | (frame.data[o + 1] << 8);
      const i = (y * tw + x) * 4;
      rgba[i] = ((c >> 11) & 31) * 8.226;
      rgba[i + 1] = ((c >> 5) & 63) * 4.048;
      rgba[i + 2] = (c & 31) * 8.226;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}
