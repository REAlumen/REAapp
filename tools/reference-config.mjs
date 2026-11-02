// Datos de la app de referencia de cada colaborador: local/reference.json, que no se publica.
// Campos: dir (instalación), compositions (carpeta de composiciones), ndiSource (texto del nombre de su fuente NDI).
import fs from 'node:fs';
import path from 'node:path';

export function referenceConfig() {
  const file = path.resolve(import.meta.dirname, '../local/reference.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Falta ${file}. Estas herramientas necesitan tu propia copia de la app de referencia.`);
  }
}
