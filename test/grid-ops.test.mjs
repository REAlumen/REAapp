import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearColumn, clearLayerClips, columnInfo, duplicateColumn, duplicateLayer, insertColumn, insertLayer, removeColumns, removeLayer, setCompositionSize,
} from '../app/js/grid-ops.js';
import { getClip, isKnownFormat, migrateComposition, newClip, newComposition, setClip } from '../app/js/model.js';

const comp = () => {
  const c = newComposition();
  c.columns = 4;
  const [a, b] = c.layers;
  setClip(c, a.id, 0, newClip({ type: 'generator', gen: 'Lines' }, 'A0'));
  setClip(c, a.id, 2, newClip({ type: 'generator', gen: 'Lines' }, 'A2'));
  setClip(c, b.id, 3, newClip({ type: 'generator', gen: 'Lines' }, 'B3'));
  setClip(c, a.id, 1, newClip({ type: 'generator', gen: 'Lines' }, 'D2-A1'), 1);
  return c;
};

test('insertar antes corre los clips a la derecha en todos los decks', () => {
  const c = comp();
  const [a] = c.layers;
  insertColumn(c, 1);
  assert.equal(c.columns, 5);
  assert.equal(getClip(c, a.id, 0).name, 'A0');
  assert.equal(getClip(c, a.id, 1), null);
  assert.equal(getClip(c, a.id, 3).name, 'A2');
  assert.equal(getClip(c, a.id, 2, 1).name, 'D2-A1');
});

test('duplicar copia los clips con identidad nueva junto a la original', () => {
  const c = comp();
  const [a] = c.layers;
  const original = getClip(c, a.id, 2);
  const at = duplicateColumn(c, 2);
  assert.equal(at, 3);
  assert.equal(getClip(c, a.id, 3).name, 'A2');
  assert.notEqual(getClip(c, a.id, 3).id, original.id);
  assert.equal(getClip(c, c.layers[1].id, 4).name, 'B3');
});

test('vaciar quita los clips pero conserva la columna', () => {
  const c = comp();
  const removed = clearColumn(c, 0);
  assert.equal(removed.length, 1);
  assert.equal(c.columns, 4);
  assert.equal(getClip(c, c.layers[0].id, 0), null);
});

test('quitar una columna corre las siguientes a la izquierda y devuelve lo borrado', () => {
  const c = comp();
  const [a, b] = c.layers;
  const removed = removeColumns(c, 2, 3);
  assert.equal(c.columns, 3);
  assert.deepEqual(removed.map((x) => x.name), ['A2']);
  assert.equal(getClip(c, b.id, 2).name, 'B3');
  assert.equal(getClip(c, a.id, 0).name, 'A0');
});

test('quitar todas antes y después deja la columna elegida', () => {
  const c = comp();
  removeColumns(c, 0, 2);
  assert.equal(c.columns, 2);
  assert.equal(getClip(c, c.layers[0].id, 0).name, 'A2');
  removeColumns(c, 1, c.columns);
  assert.equal(c.columns, 1);
});

test('nunca se queda sin columnas ni sin capas', () => {
  const c = comp();
  removeColumns(c, 0, 99);
  assert.equal(c.columns, 1);
  removeLayer(c, c.layers[0]);
  removeLayer(c, c.layers[0]);
  assert.deepEqual(removeLayer(c, c.layers[0]), []);
  assert.equal(c.layers.length, 1);
});

test('los datos de columna se mueven con ella', () => {
  const c = comp();
  columnInfo(c, 1).name = 'Intro';
  insertColumn(c, 0);
  assert.equal(columnInfo(c, 2).name, 'Intro');
  removeColumns(c, 0, 1);
  assert.equal(columnInfo(c, 1).name, 'Intro');
});

test('insertar capa numera sin repetir y duplicar copia sus clips', () => {
  const c = comp();
  const made = insertLayer(c, c.layers.length);
  assert.equal(made.name, 'Layer 4');
  assert.equal(c.layers.at(-1), made);
  const below = insertLayer(c, 0);
  assert.equal(c.layers[0], below);
  assert.equal(below.name, 'Layer 5');
  const a = c.layers[1];
  const copy = duplicateLayer(c, a);
  assert.equal(c.layers[2], copy);
  assert.equal(getClip(c, copy.id, 0).name, 'A0');
  assert.notEqual(getClip(c, copy.id, 0).id, getClip(c, a.id, 0).id);
  assert.equal(copy.activeClip, null);
});

test('vaciar y quitar capa devuelven sus clips', () => {
  const c = comp();
  const [a] = c.layers;
  assert.equal(clearLayerClips(c, a).length, 3);
  assert.equal(getClip(c, a.id, 0), null);
  assert.equal(c.layers.length, 3);
});

test('cambiar el tamaño conserva la zona de entrada de los slices', () => {
  const c = comp();
  const s = c.screens[0].slices[0];
  s.input[1].x = 960;
  setCompositionSize(c, 3840, 2160);
  assert.equal(c.width, 3840);
  assert.equal(s.input[1].x, 1920);
  assert.equal(s.input[2].y, 2160);
});

test('los archivos con el nombre anterior de la app se siguen abriendo', () => {
  const old = newComposition();
  old.format = 'prisma-1';
  old.ndiOutput.name = 'Prisma VJ';
  assert.equal(isKnownFormat(old), true);
  assert.equal(isKnownFormat({ format: 'otra-cosa' }), false);
  migrateComposition(old);
  assert.equal(old.format, 'realumen-1');
  assert.equal(old.ndiOutput.name, 'REAlumen');
  assert.equal(newComposition().ndiOutput.name, 'REAlumen');
});
