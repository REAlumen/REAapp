import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDxv, dxtThumbnail } from '../app/js/dxv.js';
import { buildIndex, frameAt, isDxvCodec } from '../app/js/mov.js';

const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
const packet = (tagText, payload) => {
  const tag = [...tagText].reverse().map((c) => c.charCodeAt(0));
  return new Uint8Array([...tag, 4, 0, 0, 0, ...le32(payload.length), ...payload]);
};
const words = (u8) => new Uint32Array(u8.buffer);

test('DXT1: un bloque nuevo seguido de copias de la distancia 2 repite el bloque', () => {
  // Textura de 16x16: 4x4 bloques de 8 bytes. Primer bloque literal; los 15 restantes, op=1.
  let ops = 0;
  for (let i = 0; i < 15; i++) ops |= 1 << (i * 2);
  const payload = [...le32(0xaabbccdd), ...le32(0x11223344), ...le32(ops >>> 0)];
  const frame = decodeDxv(packet('DXT1', payload), 16, 16);
  assert.equal(frame.format, 'dxt1');
  assert.equal(frame.data.length, 16 * 16 / 2);
  const w = words(frame.data);
  for (let i = 0; i < w.length; i += 2) {
    assert.equal(w[i], 0xaabbccdd);
    assert.equal(w[i + 1], 0x11223344);
  }
});

test('DXT1: el ancho se alinea a 16 y conserva el tamaño real de la textura', () => {
  let ops = 0;
  for (let i = 0; i < 16; i++) ops |= 1 << (i * 2);
  const payload = [...le32(1), ...le32(2), ...le32(ops >>> 0), ...le32(ops >>> 0)];
  const frame = decodeDxv(packet('DXT1', payload), 16, 12);
  assert.equal(frame.codedHeight, 16);
  assert.equal(frame.data.length, 16 * 16 / 2);
});

test('un paquete truncado falla con un error claro y no devuelve basura', () => {
  assert.throws(() => decodeDxv(packet('DXT1', [...le32(1), ...le32(2)]), 16, 16), /dañado/);
});

test('DXV de alta calidad se rechaza con un mensaje explicativo', () => {
  assert.throws(() => decodeDxv(packet('YCG6', [1, 2, 3, 4]), 16, 16), /alta calidad/);
});

test('la miniatura toma el color base de cada bloque', () => {
  const frame = { format: 'dxt1', codedWidth: 16, codedHeight: 16, data: new Uint8Array(128) };
  frame.data[0] = 0x00; frame.data[1] = 0xf8; // rojo puro en 565
  const rgba = dxtThumbnail(frame, 16, 16, 4, 4);
  assert.ok(rgba[0] > 250 && rgba[1] === 0 && rgba[2] === 0);
});

test('el índice MOV reparte muestras en fragmentos y localiza el cuadro por tiempo', () => {
  const idx = buildIndex({
    sizes: [10, 20, 30, 40], chunks: [100, 500], stsc: [[1, 3], [2, 1]], stts: [[4, 15]], timescale: 30, width: 8, height: 8, codec: 'DXD3',
  });
  assert.deepEqual(idx.offsets, [100, 110, 130, 500]);
  assert.equal(idx.duration, 2);
  assert.equal(frameAt(idx.times, 1.2), 2);
  assert.equal(frameAt(idx.times, 99), 3);
  assert.equal(isDxvCodec('DXD3'), true);
  assert.equal(isDxvCodec('avc1'), false);
});
