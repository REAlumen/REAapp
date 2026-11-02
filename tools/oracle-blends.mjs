// Fase 1 (`set`): en PrismaOracle crea una capa por modo de mezcla y asigna cada modo por la API de la app de referencia.
// Fase 2 (`map`): justo tras guardar en la app de referencia, lee el .avc y genera parity/blend-ids.json.
// Usar `map` solo si no se cambió ninguna mezcla desde que se guardó: empareja lo guardado con lo que la API lee ahora.
// Se detiene si la composición abierta no es PrismaOracle.
import fs from 'node:fs';
import path from 'node:path';
import { referenceConfig } from './reference-config.mjs';

const BASE = process.env.REFERENCE_URL || 'http://127.0.0.1:8080/api/v1';
const ORACLE = 'PrismaOracle';
const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(referenceConfig().compositions, `${ORACLE}.avc`);
const OUT = path.join(ROOT, 'parity/blend-ids.json');

async function composition() {
  const res = await fetch(`${BASE}/composition`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GET /composition: HTTP ${res.status}`);
  const comp = await res.json();
  if (comp.name?.value !== ORACLE) throw new Error(`La composición abierta es "${comp.name?.value}", no ${ORACLE}. No se cambia nada.`);
  return comp;
}

async function write(route, method, body, type = 'application/json') {
  await composition();
  const res = await fetch(BASE + route, { method, headers: { 'Content-Type': type }, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}`);
}

async function setBlends() {
  let comp = await composition();
  const modes = comp.layers[0].video.mixer['Blend Mode'].options;
  while (comp.layers.length < modes.length) {
    await write('/composition/layers/add', 'POST', '', 'text/plain');
    comp = await composition();
  }
  const send = (i, value) => write(`/composition/layers/${i + 1}`, 'PUT', JSON.stringify({ video: { mixer: { 'Blend Mode': { value } } } }));
  const current = async (i) => (await composition()).layers[i].video.mixer['Blend Mode'].value;
  for (let i = 0; i < modes.length; i++) {
    // Observado en la app de referencia: al escribir un nombre puede quedar el siguiente de la lista. Se verifica leyendo.
    for (const value of [modes[i], modes[(i - 1 + modes.length) % modes.length]]) {
      await send(i, value);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (await current(i) === modes[i]) break;
    }
  }
  comp = await composition();
  const wrong = modes.filter((m, i) => comp.layers[i].video.mixer['Blend Mode'].value !== m);
  console.log(`Modos: ${modes.length}; capas: ${comp.layers.length}; asignados bien: ${modes.length - wrong.length}`);
  if (wrong.length) console.log('No aplicados:', wrong.join(', '));
}

async function mapIds() {
  const comp = await composition();
  const xml = fs.readFileSync(FILE, 'utf8');
  const stat = fs.statSync(FILE);
  const layers = [...xml.matchAll(/<Layer uniqueId="\d+" layerIndex="(\d+)"[\s\S]*?<\/Layer>/g)];
  const ids = {};
  const conflicts = [];
  for (const m of layers) {
    const index = Number(m[1]);
    const name = comp.layers[index]?.video?.mixer?.['Blend Mode']?.value;
    const track = m[0].slice(m[0].indexOf('<VideoTrack'));
    const id = /<ParamChoice name="Blend Mode"[^>]*value="(\d+)"/.exec(track)?.[1];
    if (!id || !name) continue;
    if (ids[id] && ids[id] !== name) conflicts.push(`${id}: ${ids[id]} / ${name}`);
    ids[id] = name;
  }
  const modes = comp.layers[0].video.mixer['Blend Mode'].options;
  const missing = modes.filter((m) => !Object.values(ids).includes(m));
  console.log(`Archivo guardado ${stat.mtime.toISOString()}; capas en archivo: ${layers.length}; en la API: ${comp.layers.length}`);
  console.log(`Identificadores: ${Object.keys(ids).length}/${modes.length}; conflictos: ${conflicts.length}`);
  if (conflicts.length) console.log(conflicts.join('\n'));
  if (missing.length) console.log('Sin traducir:', missing.join(', '));
  if (layers.length !== comp.layers.length) throw new Error('El archivo no coincide con la app de referencia: falta guardar la composición.');
  fs.writeFileSync(OUT, `${JSON.stringify(ids, null, 1)}\n`);
  console.log('Escrito', OUT);
}

const phase = process.argv[2];
if (phase === 'set') await setBlends();
else if (phase === 'map') await mapIds();
else throw new Error('Uso: node tools/oracle-blends.mjs set|map');
