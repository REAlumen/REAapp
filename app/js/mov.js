// Lector mínimo de contenedores MOV/MP4: localiza cada muestra (cuadro) de la pista de video.
// `readAt(offset, length)` devuelve un Uint8Array; así sirve tanto en Node como con fetch por rangos.

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function walk(b, start, end, visit) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = fourcc(b, o + 4);
    let header = 8;
    if (size === 1) { size = Number(v.getBigUint64(o + 8)); header = 16; } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    visit(type, o + header, o + size);
    if (CONTAINERS.has(type)) walk(b, o + header, o + size, visit);
    o += size;
  }
}

export async function findMoov(readAt, fileSize) {
  let o = 0;
  while (o + 8 <= fileSize) {
    const h = await readAt(o, Math.min(16, fileSize - o));
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = v.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = Number(v.getBigUint64(8));
    else if (size === 0) size = fileSize - o;
    if (size < 8) throw new Error('MOV dañado: átomo con tamaño inválido');
    if (type === 'moov') return readAt(o, size);
    o += size;
  }
  throw new Error('MOV sin átomo moov');
}

// Descripción de sonido QuickTime (versiones 0, 1 y 2) dentro de stsd.
function parseSoundDescription(b, v, entry, codec) {
  const entrySize = v.getUint32(entry);
  const version = v.getUint16(entry + 16);
  let channels;
  let bits;
  let sampleRate;
  let flags = 0;
  if (version === 2) {
    sampleRate = v.getFloat64(entry + 40);
    channels = v.getUint32(entry + 48);
    bits = v.getUint32(entry + 56);
    flags = v.getUint32(entry + 60);
  } else {
    channels = v.getUint16(entry + 24);
    bits = v.getUint16(entry + 26);
    sampleRate = v.getUint32(entry + 32) / 65536;
  }
  const fixedBits = { in32: 32, in24: 24, in16: 16, fl32: 32, fl64: 64, sowt: 16, twos: 16 }[codec];
  if (fixedBits) bits = fixedBits;
  // El átomo 'enda' declara el orden de bytes: 1 = little endian.
  let little = codec === 'sowt' || (version === 2 && !(flags & 2));
  for (let o = entry + 28; o + 10 <= entry + entrySize; o++) {
    if (fourcc(b, o) === 'enda') { little = v.getUint16(o + 4) !== 0; break; }
  }
  return { channels, bits, sampleRate, little, float: codec.startsWith('fl') || (version === 2 && !!(flags & 1)) };
}

export function parseMoov(moov) {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const tracks = [];
  let t = null;
  walk(moov, 0, moov.byteLength, (type, s) => {
    if (type === 'trak') { t = {}; tracks.push(t); }
    if (!t) return;
    if (type === 'mdhd') {
      const version = moov[s];
      t.timescale = v.getUint32(s + (version === 1 ? 20 : 12));
    } else if (type === 'hdlr') {
      // QuickTime repite hdlr dentro de minf ('dhlr'); el tipo de pista es el primero, el de mdia.
      t.handler ??= fourcc(moov, s + 8);
    } else if (type === 'stsd') {
      t.codec = fourcc(moov, s + 12);
      t.width = v.getUint16(s + 40);
      t.height = v.getUint16(s + 42);
      t.pcm = parseSoundDescription(moov, v, s + 8, t.codec);
    } else if (type === 'stts') {
      const n = v.getUint32(s + 4);
      t.stts = Array.from({ length: n }, (_, i) => [v.getUint32(s + 8 + i * 8), v.getUint32(s + 12 + i * 8)]);
    } else if (type === 'stsc') {
      const n = v.getUint32(s + 4);
      t.stsc = Array.from({ length: n }, (_, i) => [v.getUint32(s + 8 + i * 12), v.getUint32(s + 12 + i * 12)]);
    } else if (type === 'stsz') {
      const fixed = v.getUint32(s + 4);
      const n = v.getUint32(s + 8);
      t.sizes = Array.from({ length: n }, (_, i) => fixed || v.getUint32(s + 12 + i * 4));
    } else if (type === 'stco') {
      const n = v.getUint32(s + 4);
      t.chunks = Array.from({ length: n }, (_, i) => v.getUint32(s + 8 + i * 4));
    } else if (type === 'co64') {
      const n = v.getUint32(s + 4);
      t.chunks = Array.from({ length: n }, (_, i) => Number(v.getBigUint64(s + 8 + i * 8)));
    }
  });
  return tracks;
}

export function buildIndex(track) {
  const offsets = new Array(track.sizes.length);
  let sample = 0;
  track.chunks.forEach((chunkOffset, c) => {
    let perChunk = 1;
    for (const [first, count] of track.stsc) if (c + 1 >= first) perChunk = count;
    let o = chunkOffset;
    for (let i = 0; i < perChunk && sample < offsets.length; i++) {
      offsets[sample] = o;
      o += track.sizes[sample++];
    }
  });
  const times = new Float64Array(offsets.length);
  let i = 0;
  let ticks = 0;
  for (const [count, delta] of track.stts) {
    for (let k = 0; k < count && i < times.length; k++) { times[i++] = ticks / track.timescale; ticks += delta; }
  }
  return { offsets, sizes: track.sizes, times, duration: ticks / track.timescale, width: track.width, height: track.height, codec: track.codec };
}

export function frameAt(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const isDxvCodec = (codec) => /^DX[DV]/.test(codec || '') || codec === 'DXD3';

export async function openMov(readAt, fileSize) {
  const tracks = parseMoov(await findMoov(readAt, fileSize));
  const video = tracks.find((t) => t.handler === 'vide' && t.sizes?.length);
  if (!video) throw new Error('MOV sin pista de video');
  return { ...buildIndex(video), audio: tracks.find((t) => t.handler === 'soun') || null };
}

// Lee audio PCM entero de la pista de sonido. Devuelve un Float32Array por canal.
export async function readPcmAudio(track, readAt) {
  const { pcm } = track;
  if (!pcm || !['in32', 'in24', 'in16', 'sowt', 'twos', 'fl32', 'fl64', 'lpcm'].includes(track.codec)) {
    throw new Error(`Audio ${track.codec} no compatible`);
  }
  const bytesPerFrame = pcm.channels * (pcm.bits / 8);
  const totalFrames = track.stts.reduce((n, [count, delta]) => n + count * delta, 0);
  const channels = Array.from({ length: pcm.channels }, () => new Float32Array(totalFrames));
  let written = 0;
  for (let c = 0; c < track.chunks.length && written < totalFrames; c++) {
    let perChunk = 1;
    for (const [first, count] of track.stsc) if (c + 1 >= first) perChunk = count;
    const frames = Math.min(perChunk, totalFrames - written);
    const bytes = await readAt(track.chunks[c], frames * bytesPerFrame);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let f = 0; f < frames; f++) {
      for (let ch = 0; ch < pcm.channels; ch++) {
        const o = f * bytesPerFrame + ch * (pcm.bits / 8);
        let s;
        if (pcm.float) s = pcm.bits === 64 ? v.getFloat64(o, pcm.little) : v.getFloat32(o, pcm.little);
        else if (pcm.bits === 32) s = v.getInt32(o, pcm.little) / 2147483648;
        else if (pcm.bits === 24) {
          const hi = pcm.little ? v.getInt8(o + 2) : v.getInt8(o);
          const mid = v.getUint8(o + 1);
          const lo = pcm.little ? v.getUint8(o) : v.getUint8(o + 2);
          s = ((hi << 16) | (mid << 8) | lo) / 8388608;
        } else s = v.getInt16(o, pcm.little) / 32768;
        channels[ch][written + f] = s;
      }
    }
    written += frames;
  }
  return { channels, sampleRate: pcm.sampleRate, frames: totalFrames };
}
