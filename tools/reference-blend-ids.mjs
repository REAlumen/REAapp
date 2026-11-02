// Traduce identificadores de mezcla de .avc observando: nombre según la API frente a número en el archivo guardado.
// Solo lee. Si la composición abierta tiene cambios sin guardar, la capa no coincidirá y se informa.
import fs from 'node:fs';
import path from 'node:path';
import { referenceConfig } from './reference-config.mjs';

const BASE = process.env.REFERENCE_URL || 'http://127.0.0.1:8080/api/v1';
const DIR = referenceConfig().compositions;
const comp = await (await fetch(`${BASE}/composition`)).json();
const name = comp.name?.value;
const candidates = fs.readdirSync(DIR).filter((f) => f.endsWith('.avc'));
console.log('Composición abierta:', name, '| archivos:', candidates.join(', '));
const file = candidates.find((f) => f.slice(0, -4) === name) || candidates.find((f) => name?.includes(f.slice(0, -4)));
console.log('Capas:', comp.layers.length, '| columnas:', comp.columns?.length, '| decks:', comp.decks?.length);
for (const l of comp.layers) console.log(`  API capa "${l.name?.value}": ${l.video?.mixer?.['Blend Mode']?.value}`);
if (!file) { console.log('Sin archivo guardado que coincida con la composición abierta.'); process.exit(0); }

const xml = fs.readFileSync(path.join(DIR, file), 'utf8');
const layers = [...xml.matchAll(/<Layer uniqueId="\d+" layerIndex="(\d+)"[\s\S]*?<\/Layer>/g)];
console.log('Archivo:', file, '| capas en archivo:', layers.length);
const counts = new Map();
for (const m of xml.matchAll(/<ParamChoice name="Blend Mode"[^>]*default="(\d+)"[^>]*value="(\d+)"/g)) counts.set(m[2], (counts.get(m[2]) || 0) + 1);
console.log('Valores de mezcla en el archivo:', JSON.stringify([...counts]));
const pairs = new Map();
for (const m of layers) {
  const index = Number(m[1]);
  const block = m[0];
  const video = block.slice(block.indexOf('<VideoTrack'));
  const value = /<ParamChoice name="Blend Mode"[^>]*value="(\d+)"/.exec(video)?.[1];
  const apiName = comp.layers[index]?.video?.mixer?.['Blend Mode']?.value;
  console.log(`  archivo capa ${index}: ${value} -> API: ${apiName}`);
  if (value && apiName) pairs.set(value, apiName);
}
console.log('Pares observados:', JSON.stringify([...pairs]));
