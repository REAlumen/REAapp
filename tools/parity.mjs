// Mide la amplitud de funciones frente a Resolume Arena con datos instalados en este equipo.
// No copia textos de Arena al repositorio: solo títulos de la ayuda y cifras.
import fs from 'node:fs';
import path from 'node:path';
import { EFFECTS, GENERATORS } from '../app/js/shaders.js';
import { BLEND_MODES } from '../app/js/model.js';

const ARENA = process.env.ARENA_DIR || 'C:/Program Files/Resolume Arena';
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ARENA, p), 'utf8');
const percent = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

const titles = [...new Set([...read('docs/help/English.xml').matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((m) => m[1].trim()))];
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'parity/status.json'), 'utf8'));

const known = new Set(titles);
const typos = [...status.present, ...status.partial].filter((t) => !known.has(t));
if (typos.length) {
  console.error(`Títulos que no existen en la ayuda de Arena: ${typos.join(', ')}`);
  process.exit(1);
}
const both = status.present.filter((t) => status.partial.includes(t));
if (both.length) {
  console.error(`Títulos clasificados dos veces: ${both.join(', ')}`);
  process.exit(1);
}

const present = titles.filter((t) => status.present.includes(t));
const partial = titles.filter((t) => status.partial.includes(t));
const missing = titles.filter((t) => !status.present.includes(t) && !status.partial.includes(t));

// Referencia en vivo (tools/arena-snapshot.mjs), sin plugins de terceros ni dispositivos del equipo.
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'parity/arena-reference.json'), 'utf8'));
const arenaEffects = reference.videoEffects;
const arenaSources = reference.sources;
const arenaBlends = reference.blendModes;
const effectsMatched = arenaEffects.filter((n) => EFFECTS[n]);
const sourcesMatched = arenaSources.filter((n) => GENERATORS[n] || (n === 'Solid Color' && GENERATORS['Color Sólido']));
const blendsMatched = arenaBlends.filter((n) => BLEND_MODES.includes(n));

const swagger = read('rest/docs/swagger.yaml').split(/\r?\n/);
const operations = swagger.filter((l) => /^ {4}(get|put|post|delete):/.test(l)).length;

const rows = [
  ['Temas de la ayuda presentes', present.length, titles.length],
  ['Temas de la ayuda parciales', partial.length, titles.length],
  ['Modos de mezcla con el mismo nombre', blendsMatched.length, arenaBlends.length],
  ['Efectos de video con el mismo nombre', effectsMatched.length, arenaEffects.length],
  ['Fuentes con el mismo nombre', sourcesMatched.length, arenaSources.length],
  ['Operaciones de la API REST', 0, operations],
];

const amplitud = percent(present.length + partial.length * 0.5, titles.length);
const today = new Date().toISOString().slice(0, 10);
const md = `# Igualdad con Resolume Arena 7.21

Generado por \`node tools/parity.mjs\` el ${today}. No editar a mano.

**Amplitud: ${amplitud} %** (presentes + la mitad de los parciales, sobre ${titles.length} temas únicos de la ayuda de Arena).

**Preparación para trabajo real: sin medir.** La amplitud solo dice que algo existe. Falta compararlo con la salida y los archivos de Arena.

| Medida | REAlumen | Arena | % |
|---|---|---:|---:|
${rows.map(([n, a, b]) => `| ${n} | ${a} | ${b} | ${percent(a, b)} |`).join('\n')}

La clasificación de la ayuda es manual (\`parity/status.json\`) y lo no listado cuenta como ausente.

Efectos y fuentes salen de la API en vivo de Arena (\`parity/arena-reference.json\`), sin plugins de terceros ni dispositivos de este equipo.

## Modos de mezcla que faltan
${arenaBlends.filter((n) => !blendsMatched.includes(n)).join(', ')}

## Efectos que faltan
${arenaEffects.filter((n) => !EFFECTS[n]).join(', ')}

## Fuentes que faltan
${arenaSources.filter((n) => !sourcesMatched.includes(n)).join(', ')}

## Temas ausentes (${missing.length})
${missing.join(', ')}
`;
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/target-app-parity.md'), md);
console.log(`Amplitud ${amplitud} %`);
for (const [n, a, b] of rows) console.log(`  ${n}: ${a}/${b} (${percent(a, b)} %)`);
