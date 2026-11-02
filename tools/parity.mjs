// Mide la amplitud de funciones frente a la app de referencia con datos instalados en este equipo.
// No copia textos de la app de referencia al repositorio: solo títulos de la ayuda y cifras.
import fs from 'node:fs';
import path from 'node:path';
import { EFFECTS, GENERATORS } from '../app/js/shaders.js';
import { BLEND_MODES } from '../app/js/model.js';
import { referenceConfig } from './reference-config.mjs';

const { dir: REFERENCE_DIR } = referenceConfig();
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(REFERENCE_DIR, p), 'utf8');
const percent = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

const titles = [...new Set([...read('docs/help/English.xml').matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((m) => m[1].trim()))];
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'parity/status.json'), 'utf8'));

const known = new Set(titles);
const typos = [...status.present, ...status.partial].filter((t) => !known.has(t));
if (typos.length) {
  console.error(`Títulos que no existen en la ayuda de la app de referencia: ${typos.join(', ')}`);
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

// Referencia en vivo (tools/reference-snapshot.mjs), sin plugins de terceros ni dispositivos del equipo.
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'parity/reference.json'), 'utf8'));
const refEffects = reference.videoEffects;
const refSources = reference.sources;
const refBlends = reference.blendModes;
const effectsMatched = refEffects.filter((n) => EFFECTS[n]);
const sourcesMatched = refSources.filter((n) => GENERATORS[n] || (n === 'Solid Color' && GENERATORS['Color Sólido']));
const blendsMatched = refBlends.filter((n) => BLEND_MODES.includes(n));

const swagger = read('rest/docs/swagger.yaml').split(/\r?\n/);
const operations = swagger.filter((l) => /^ {4}(get|put|post|delete):/.test(l)).length;

const rows = [
  ['Temas de la ayuda presentes', present.length, titles.length],
  ['Temas de la ayuda parciales', partial.length, titles.length],
  ['Modos de mezcla con el mismo nombre', blendsMatched.length, refBlends.length],
  ['Efectos de video con el mismo nombre', effectsMatched.length, refEffects.length],
  ['Fuentes con el mismo nombre', sourcesMatched.length, refSources.length],
  ['Operaciones de la API REST', 0, operations],
];

const amplitud = percent(present.length + partial.length * 0.5, titles.length);
const today = new Date().toISOString().slice(0, 10);
const md = `# Igualdad con la app de referencia

Generado por \`node tools/parity.mjs\` el ${today}. No editar a mano.

**Amplitud: ${amplitud} %** (presentes + la mitad de los parciales, sobre ${titles.length} temas únicos de la ayuda de la app de referencia).

**Preparación para trabajo real: sin medir.** La amplitud solo dice que algo existe. Falta compararlo con la salida y los archivos de la app de referencia.

| Medida | REAlumen | Referencia | % |
|---|---|---:|---:|
${rows.map(([n, a, b]) => `| ${n} | ${a} | ${b} | ${percent(a, b)} |`).join('\n')}

La clasificación de la ayuda es manual (\`parity/status.json\`) y lo no listado cuenta como ausente.

Efectos y fuentes salen de la API en vivo de la app de referencia (\`parity/reference.json\`), sin plugins de terceros ni dispositivos de este equipo.

## Modos de mezcla que faltan
${refBlends.filter((n) => !blendsMatched.includes(n)).join(', ')}

## Efectos que faltan
${refEffects.filter((n) => !EFFECTS[n]).join(', ')}

## Fuentes que faltan
${refSources.filter((n) => !sourcesMatched.includes(n)).join(', ')}

## Temas ausentes (${missing.length})
${missing.join(', ')}
`;
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/target-app-parity.md'), md);
console.log(`Amplitud ${amplitud} %`);
for (const [n, a, b] of rows) console.log(`  ${n}: ${a}/${b} (${percent(a, b)} %)`);
