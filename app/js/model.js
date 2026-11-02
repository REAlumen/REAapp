import { bezierFromCorners } from './warp.js';
import { shapePoints } from './slice-ops.js';

let nextId = 1;
export const uid = () => `${Date.now().toString(36)}${(nextId++).toString(36)}`;

export const BLEND_MODES = [
  'Alpha', 'Add', 'Multiply', 'Screen', 'Overlay', 'Difference', 'Subtract', 'Lighten', 'Darken',
  'Exclusion', 'Hard Light', 'Soft Light', 'Luma Key', 'Luma Key I', 'Luma Is Alpha', 'Difference I', 'Dodge', 'Burn',
];

export const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

export function newLayer(i) {
  return {
    // Valores por defecto declarados en los .avc de Arena: mezcla Add y opacidad 0.5 (mezcla completa).
    id: uid(), name: `Layer ${i + 1}`, opacity: 0.5, volume: 1, bypass: false, solo: false,
    blend: 'Add', side: '', transition: 0, effects: [], activeClip: null,
  };
}

export function newClip(source, name) {
  return {
    id: uid(), name, source, opacity: 1, volume: 1, x: 0, y: 0, scale: 1, rotation: 0,
    effects: [], cues: [], trigger: 'normal', beatSnap: 0, autopilot: 'off',
    transport: { mode: 'timeline', speed: 1, dir: 1, loop: 'loop', beats: 16, in: 0, out: 1 },
  };
}

export function newSlice(n, w, h, x = 0, y = 0, sw = w, sh = h) {
  const corners = rect(x, y, sw, sh);
  return {
    id: uid(), name: `Slice ${n}`, enabled: true, solo: false,
    input: rect(x, y, sw, sh), corners, warpMode: 'perspective', bezier: bezierFromCorners(corners), grid: null, subdivX: 0, subdivY: 0,
    // Brillo, contraste y color centrados en 0, como en el panel de Arena.
    opacity: 1, brightness: 0, contrast: 0, r: 0, g: 0, b: 0, flipX: false, flipY: false, isKey: false, blackBg: false,
    edge: { enabled: false, left: 0, right: 0, top: 0, bottom: 0, gamma: 1.8 },
    inputMasks: [],
  };
}

// Slice de forma libre: cada punto de salida corresponde a un punto de entrada.
export function newPolygon(n, kind, screenW, screenH, compW, compH, points) {
  const corners = points || shapePoints(kind, screenW, screenH);
  const s = newSlice(n, screenW, screenH);
  return {
    ...s,
    name: `Polígono ${n}`,
    warpMode: 'polygon',
    corners,
    bezier: [],
    input: corners.map((p) => ({ x: (p.x / screenW) * compW, y: (p.y / screenH) * compH })),
  };
}

export function newMask(stage, kind, w, h, n) {
  return {
    id: uid(), name: `Máscara ${n}`, stage, shape: kind, kind: kind === 'ellipse' ? 'ellipse' : 'polygon', enabled: true, invert: false, feather: 0,
    points: shapePoints(kind, w, h),
  };
}

export function newScreen(n, w, h) {
  return {
    id: uid(), name: `Screen ${n}`, width: w, height: h, device: { type: 'virtual' }, enabled: true,
    opacity: 1, brightness: 0, contrast: 0, r: 0, g: 0, b: 0, testPattern: false, slices: [newSlice(1, w, h)], masks: [],
  };
}

// Actualiza composiciones guardadas con versiones anteriores de REAlumen.
export const isKnownFormat = (comp) => comp?.format === 'realumen-1' || comp?.format === 'prisma-1';

export function migrateComposition(comp) {
  // Archivos creados cuando la app se llamaba de otra forma.
  comp.format = 'realumen-1';
  if (['Prisma VJ', 'Realumen'].includes(comp.ndiOutput?.name)) comp.ndiOutput.name = 'REAlumen';
  for (const screen of comp.screens || []) {
    if (!screen.device) {
      screen.device = { type: 'virtual' };
      delete screen.displayId;
    }
    screen.brightness ??= 0;
    screen.contrast ??= 0;
    screen.r ??= 0;
    screen.g ??= 0;
    screen.b ??= 0;
    // Antes las máscaras de entrada eran de la pantalla; ahora pertenecen a cada slice.
    const shared = screen.masks.filter((m) => m.stage === 'input');
    screen.masks = screen.masks.filter((m) => m.stage !== 'input');
    for (const s of screen.slices) {
      s.inputMasks ??= shared.map((m) => ({ ...JSON.parse(JSON.stringify(m)), id: uid() }));
      if (s.subdivX === undefined) {
        s.contrast = (s.contrast ?? 1) - 1;
        s.r = (s.r ?? 1) - 1;
        s.g = (s.g ?? 1) - 1;
        s.b = (s.b ?? 1) - 1;
        s.subdivX = 0;
        s.subdivY = 0;
        s.grid = null;
      }
    }
  }
  return comp;
}

export function newComposition() {
  const width = 1920;
  const height = 1080;
  const layers = [newLayer(0), newLayer(1), newLayer(2)];
  return {
    format: 'realumen-1', name: 'Composición', width, height, bpm: 120, opacity: 1, volume: 1, crossfader: 0,
    description: '', columns: 9, columnInfo: [], layers, effects: [], activeDeck: 0,
    decks: [{ id: uid(), name: 'Deck 1', clips: {} }, { id: uid(), name: 'Deck 2', clips: {} }],
    screens: [newScreen(1, width, height)],
    ndiOutput: { enabled: false, name: 'REAlumen', fps: 30 },
  };
}

export const clipKey = (layerId, column) => `${layerId}:${column}`;
export const getClip = (comp, layerId, column, deck = comp.activeDeck) => comp.decks[deck].clips[clipKey(layerId, column)] || null;
export const setClip = (comp, layerId, column, clip, deck = comp.activeDeck) => {
  const key = clipKey(layerId, column);
  if (clip) comp.decks[deck].clips[key] = clip;
  else delete comp.decks[deck].clips[key];
};

export function findClip(comp, clipId) {
  for (const deck of comp.decks) {
    for (const [key, clip] of Object.entries(deck.clips)) {
      if (clip.id === clipId) {
        const sep = key.lastIndexOf(':');
        return { clip, deck, layerId: key.slice(0, sep), column: Number(key.slice(sep + 1)) };
      }
    }
  }
  return null;
}

export function sourceFromPath(path) {
  const ext = path.split('.').pop().toLowerCase();
  const name = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const type = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) ? 'image'
    : ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'].includes(ext) ? 'audio' : 'video';
  return { source: { type, path }, name };
}
