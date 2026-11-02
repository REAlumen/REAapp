// Genera degradados ideales para probar REAlumen sin la distorsión que añade la captura NDI.
import path from 'node:path';
import { writePng } from './ndi-capture.mjs';

const OUT = path.resolve(import.meta.dirname, '../parity/oracle');
const W = 1920;
const H = 1080;

const ramp = (value) => {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round(value(x, y) * 255);
      const o = (y * W + x) * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
};

writePng(path.join(OUT, 'ideal-base.png'), ramp((x) => x / (W - 1)));
writePng(path.join(OUT, 'ideal-over.png'), ramp((_x, y) => y / (H - 1)));
console.log('Degradados ideales escritos');
process.exit(0);
