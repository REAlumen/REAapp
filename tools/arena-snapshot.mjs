// Lee de la API pública de Arena (solo GET) los nombres que sirven de referencia y los guarda en parity/arena-reference.json.
// ARENA_EXCLUDE es una expresión regular para omitir plugins de terceros y dispositivos propios de tu equipo.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.ARENA_URL || 'http://127.0.0.1:8080/api/v1';
const ROOT = path.resolve(import.meta.dirname, '..');
const exclude = process.env.ARENA_EXCLUDE ? new RegExp(process.env.ARENA_EXCLUDE) : null;

async function get(route) {
  const res = await fetch(BASE + route, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

const names = (list) => (list || []).map((e) => e.name).filter((n) => !exclude?.test(n));

const product = await get('/product');
const effects = await get('/effects');
const sources = await get('/sources');
const composition = await get('/composition');

const reference = {
  product,
  note: 'Solo nombres públicos de la API de Arena, para medir qué falta. Sin plugins de terceros ni dispositivos.',
  blendModes: composition.layers?.[0]?.video?.mixer?.['Blend Mode']?.options || [],
  videoEffects: names(effects.video),
  sources: names(sources.video),
};

fs.mkdirSync(path.join(ROOT, 'parity'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'parity/arena-reference.json'), `${JSON.stringify(reference, null, 1)}\n`);
console.log(`${product.name} ${product.major}.${product.minor}: ${reference.blendModes.length} mezclas, ${reference.videoEffects.length} efectos, ${reference.sources.length} fuentes`);
