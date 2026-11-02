// Operaciones sobre capas y columnas de la composición. Devuelven los clips eliminados para liberar sus recursos.
import { clipKey, newLayer, uid } from './model.js';

const cloneClip = (clip) => ({ ...JSON.parse(JSON.stringify(clip)), id: uid() });

export function columnInfo(comp, index) {
  comp.columnInfo ??= [];
  comp.columnInfo[index] ??= { name: null, color: null };
  return comp.columnInfo[index];
}

function splitKey(key) {
  const sep = key.lastIndexOf(':');
  return [key.slice(0, sep), Number(key.slice(sep + 1))];
}

// Reescribe las claves de todos los decks. `map` da la columna nueva, o null para borrar el clip.
function remapColumns(comp, map) {
  const removed = [];
  for (const deck of comp.decks) {
    const clips = {};
    for (const [key, clip] of Object.entries(deck.clips)) {
      const [layerId, column] = splitKey(key);
      const next = map(column);
      if (next === null) removed.push(clip);
      else clips[clipKey(layerId, next)] = clip;
    }
    deck.clips = clips;
  }
  return removed;
}

export function insertColumn(comp, index) {
  const at = Math.max(0, Math.min(comp.columns, index));
  remapColumns(comp, (c) => (c >= at ? c + 1 : c));
  comp.columnInfo ??= [];
  comp.columnInfo.splice(at, 0, { name: null, color: null });
  comp.columns++;
  return at;
}

export function duplicateColumn(comp, index) {
  const at = insertColumn(comp, index + 1);
  for (const deck of comp.decks) {
    for (const [key, clip] of Object.entries(deck.clips)) {
      const [layerId, column] = splitKey(key);
      if (column === index) deck.clips[clipKey(layerId, at)] = cloneClip(clip);
    }
  }
  const info = columnInfo(comp, index);
  comp.columnInfo[at] = { name: info.name ? `${info.name} copia` : null, color: info.color };
  return at;
}

export function clearColumn(comp, index) {
  const removed = [];
  for (const deck of comp.decks) {
    for (const [key, clip] of Object.entries(deck.clips)) {
      if (splitKey(key)[1] === index) {
        removed.push(clip);
        delete deck.clips[key];
      }
    }
  }
  return removed;
}

// Quita las columnas [from, to). Siempre queda al menos una.
export function removeColumns(comp, from, to) {
  const start = Math.max(0, from);
  const end = Math.min(comp.columns, to);
  const count = Math.min(end - start, comp.columns - 1);
  if (count <= 0) return [];
  const removed = remapColumns(comp, (c) => {
    if (c < start) return c;
    return c < start + count ? null : c - count;
  });
  comp.columnInfo?.splice(start, count);
  comp.columns -= count;
  return removed;
}

function nextLayerNumber(comp) {
  let max = comp.layers.length;
  for (const l of comp.layers) {
    const m = /(\d+)$/.exec(l.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// `index` es la posición en comp.layers: 0 es la capa de más abajo.
export function insertLayer(comp, index) {
  const layer = newLayer(nextLayerNumber(comp));
  const at = Math.max(0, Math.min(comp.layers.length, index));
  comp.layers.splice(at, 0, layer);
  return layer;
}

export function duplicateLayer(comp, layer) {
  const at = comp.layers.indexOf(layer);
  const copy = JSON.parse(JSON.stringify(layer));
  Object.assign(copy, { id: uid(), name: `${layer.name} copia`, activeClip: null });
  copy.effects = layer.effects.map((fx) => ({ ...JSON.parse(JSON.stringify(fx)), id: uid() }));
  comp.layers.splice(at + 1, 0, copy);
  for (const deck of comp.decks) {
    for (const [key, clip] of Object.entries(deck.clips)) {
      const [layerId, column] = splitKey(key);
      if (layerId === layer.id) deck.clips[clipKey(copy.id, column)] = cloneClip(clip);
    }
  }
  return copy;
}

export function clearLayerClips(comp, layer) {
  const removed = [];
  for (const deck of comp.decks) {
    for (const [key, clip] of Object.entries(deck.clips)) {
      if (splitKey(key)[0] === layer.id) {
        removed.push(clip);
        delete deck.clips[key];
      }
    }
  }
  return removed;
}

export function removeLayer(comp, layer) {
  if (comp.layers.length < 2) return [];
  const removed = clearLayerClips(comp, layer);
  comp.layers.splice(comp.layers.indexOf(layer), 1);
  return removed;
}

export function setCompositionSize(comp, width, height) {
  const sx = width / comp.width;
  const sy = height / comp.height;
  // La selección de entrada es relativa a la composición: conserva la misma zona de imagen.
  for (const screen of comp.screens) {
    for (const s of screen.slices) {
      for (const p of s.input) { p.x *= sx; p.y *= sy; }
      for (const m of s.inputMasks || []) for (const p of m.points) { p.x *= sx; p.y *= sy; }
    }
  }
  comp.width = width;
  comp.height = height;
}
