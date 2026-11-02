// Captura por NDI la salida real de la app de referencia para cada modo de mezcla, sobre PrismaOracle.
// Base: degradado horizontal negro a blanco. Encima: degradado vertical negro a blanco.
// Así cada píxel es una combinación distinta de base y superior. Genera parity/oracle/.
import fs from 'node:fs';
import path from 'node:path';
import { connect, capture, close, writePng } from './ndi-capture.mjs';
import { referenceConfig } from './reference-config.mjs';

const BASE = process.env.REFERENCE_URL || 'http://127.0.0.1:8080/api/v1';
const ORACLE = 'PrismaOracle';
const OUT = path.resolve(import.meta.dirname, '../parity/oracle');
const GRID = 17;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comp() {
  const c = await (await fetch(`${BASE}/composition`, { signal: AbortSignal.timeout(15000) })).json();
  if (c.name?.value !== ORACLE) throw new Error(`La composición abierta es "${c.name?.value}", no ${ORACLE}. No se cambia nada.`);
  return c;
}

async function send(method, route, body, type = 'application/json') {
  await comp();
  const res = await fetch(BASE + route, { method, headers: { 'Content-Type': type }, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}`);
}

const put = (route, obj) => send('PUT', route, JSON.stringify(obj));
const post = (route, body = '') => send('POST', route, body, 'text/plain');

// La app de referencia puede dejar la opción siguiente al escribir un nombre: se comprueba leyendo.
async function setChoice(route, wrap, read, options, target) {
  const i = options.indexOf(target);
  for (const value of [target, options[(i - 1 + options.length) % options.length]]) {
    await put(route, wrap(value));
    await sleep(100);
    if (read(await comp()) === target) return true;
  }
  return false;
}

const blendOf = (n) => (c) => c.layers[n].video.mixer['Blend Mode'].value;
const setBlend = (n, options, target) => setChoice(`/composition/layers/${n + 1}`, (value) => ({ video: { mixer: { 'Blend Mode': { value } } } }), blendOf(n), options, target);

async function prepareGradient(n, type) {
  await post(`/composition/layers/${n + 1}/clips/1/open`, 'source:///video/Gradient');
  await sleep(500);
  const route = `/composition/layers/${n + 1}/clips/1`;
  const params = (await comp()).layers[n].clips[0].video.sourceparams;
  await put(route, { video: { sourceparams: { 'Color 1': { value: '#000000ff' }, 'Color 2': { value: '#ffffffff' } } } });
  const ok = await setChoice(route, (value) => ({ video: { sourceparams: { Type: { value } } } }), (c) => c.layers[n].clips[0].video.sourceparams.Type.value, params.Type.options, type);
  if (!ok) throw new Error(`No se pudo poner el degradado ${type} en la capa ${n + 1}`);
  await post(`${route}/connect`);
}

const sample = (f) => {
  const rows = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = Math.min(f.width - 1, Math.round((i / (GRID - 1)) * (f.width - 1)));
      const y = Math.min(f.height - 1, Math.round((j / (GRID - 1)) * (f.height - 1)));
      const o = (y * f.width + x) * 4;
      rows.push([f.data[o], f.data[o + 1], f.data[o + 2]]);
    }
  }
  return rows;
};

fs.mkdirSync(OUT, { recursive: true });
let c = await comp();
const modes = c.layers[0].video.mixer['Blend Mode'].options;
await setBlend(0, modes, 'Alpha');
await prepareGradient(0, 'Horizontal');
await prepareGradient(1, 'Vertical');
await setBlend(1, modes, 'Alpha');
await put('/composition/layers/2', { video: { opacity: { value: 1 } }, bypassed: { value: false } });
await put('/composition/layers/1', { video: { opacity: { value: 1 } }, bypassed: { value: false } });
await put('/composition/layers/1/clips/1', { video: { opacity: { value: 1 } } });
await put('/composition/layers/2/clips/1', { video: { opacity: { value: 1 } } });
await sleep(300);
c = await comp();
const opacities = [c.layers[0].video.opacity.value, c.layers[1].video.opacity.value];
if (opacities[0] !== 1 || opacities[1] !== 1) throw new Error(`La opacidad no quedó en 100 %: ${opacities.join(', ')}`);

const recv = await connect(referenceConfig().ndiSource);
const lut = { source: 'La app de referencia por NDI', grid: GRID, modes: {} };

const overFrame = await capture(recv, 800);
writePng(path.join(OUT, 'over.png'), overFrame);
// La app de referencia aplica algunos cambios con retraso: se espera hasta leerlos.
const waitFor = async (test, label) => {
  for (let i = 0; i < 30; i++) {
    if (test(await comp())) return;
    await sleep(100);
  }
  throw new Error(label);
};
await put('/composition/layers/2', { bypassed: { value: true } });
await waitFor((s) => s.layers[1].bypassed.value === true, 'La capa 2 no quedó en bypass');
const baseFrame = await capture(recv, 800);
writePng(path.join(OUT, 'base.png'), baseFrame);
await put('/composition/layers/2', { bypassed: { value: false } });
await waitFor((s) => s.layers[1].bypassed.value === false, 'La capa 2 no salió de bypass');
lut.base = sample(baseFrame);
lut.over = sample(overFrame);
const row = (s) => Array.from({ length: GRID }, (_, i) => s[i * GRID + 0][0]);
console.log('Base, fila superior:', lut.base.slice(0, GRID).map((p) => p[0]).join(','));
console.log('Superior, columna izquierda:', row(lut.over).join(','));

// La opacidad de capa de la app de referencia funciona como crossfade: 0 base, 0.5 mezcla completa, 1 capa superior.
const setOpacity = async (value) => {
  await put('/composition/layers/2', { video: { opacity: { value } } });
  await waitFor((s) => s.layers[1].video.opacity.value === value, `La opacidad no quedó en ${value}`);
};
const untouched = (await comp()).layers.slice(2).map((l) => `${l.video.opacity.value}`);
console.log('Opacidad de capas nuevas:', [...new Set(untouched)].join(', '));

lut.opacity = 0.5;
lut.phases = {};
await setOpacity(0.5);
const failed = [];
for (const mode of modes) {
  if (!(await setBlend(1, modes, mode))) { failed.push(mode); continue; }
  const frame = await capture(recv, 450);
  lut.modes[mode] = sample(frame);
  writePng(path.join(OUT, `mode-${mode.replace(/[^\w]+/g, '_')}.png`), frame);
  process.stdout.write('.');
}
for (const mode of ['Alpha', 'Add', 'Multiply', 'Screen', 'Difference']) {
  await setBlend(1, modes, mode);
  for (const o of [0, 0.25, 0.75, 1]) {
    await setOpacity(o);
    lut.phases[`${mode}@${o}`] = sample(await capture(recv, 450));
    process.stdout.write('+');
  }
  await setOpacity(0.5);
}
await setOpacity(1);
await setBlend(1, modes, 'Alpha');
close(recv);
fs.writeFileSync(path.join(OUT, 'blend-lut.json'), `${JSON.stringify(lut)}\n`);
console.log(`\nCapturados ${Object.keys(lut.modes).length}/${modes.length}; sin aplicar: ${failed.join(', ') || 'ninguno'}`);
process.exit(0);
