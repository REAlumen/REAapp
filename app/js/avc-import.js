// Importa la estructura de archivos .avc y AdvancedOutput.xml observados en la instalación local.
// Formatos reales: Composition (.avc) y ScreenSetup (AdvancedOutput.xml).
import { BLEND_MODES, newClip, newComposition, newLayer, newScreen, newSlice, sourceFromPath, uid, clipKey } from './model.js';
import { bezierFromCorners } from './warp.js';

const parse = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es XML válido');
  return doc;
};
const direct = (el, name) => [...el.children].filter((c) => c.tagName === name);
const verts = (el) => [...el.children].filter((c) => c.tagName === 'v').map((v) => ({ x: Number(v.getAttribute('x')), y: Number(v.getAttribute('y')) }));
const paramValue = (el, name) => el?.querySelector(`:scope > Params > [name="${name}"]`)?.getAttribute('value') ?? null;

// Observado con tools/reference-blend-ids.mjs: valor del archivo frente al nombre que da la API de la app de referencia.
import { BLEND_IDS } from './avc-blend-ids.js';

export function parseAvc(text) {
  const doc = parse(text);
  const root = doc.documentElement;
  if (root.tagName !== 'Composition') throw new Error('No es una composición .avc de la app de referencia');
  const comp = newComposition();
  const numLayers = Number(root.getAttribute('numLayers')) || 1;
  comp.columns = Number(root.getAttribute('numColumns')) || 9;
  comp.name = paramValue(root, 'Name') || 'Composición importada';
  const tempo = root.querySelector('TempoController [name="Tempo"]');
  if (tempo) comp.bpm = Number(tempo.getAttribute('value')) || comp.bpm;

  const stats = { clips: 0, media: 0, unsupported: 0, unknownBlends: 0, unimplementedBlends: [] };
  const layerEls = direct(root, 'Layer');
  comp.layers = Array.from({ length: numLayers }, (_, i) => {
    const layer = newLayer(i);
    const el = layerEls.find((l) => Number(l.getAttribute('layerIndex')) === i);
    const name = el && paramValue(el, 'Name');
    // La app de referencia no guarda el nombre por defecto; su API lo presenta como "Layer #".
    layer.name = (name || 'Layer #').replace('#', String(i + 1));
    // Si el archivo no guarda la opacidad, la API de la app de referencia la lee como 1.
    const opacity = el?.querySelector(':scope > VideoTrack > Params > [name="Opacity"]')?.getAttribute('value');
    layer.opacity = opacity != null && Number.isFinite(Number(opacity)) ? Number(opacity) : 1;
    const blendId = el?.querySelector(':scope > VideoTrack [name="Blend Mode"]')?.getAttribute('value');
    if (blendId && BLEND_IDS[blendId]) {
      layer.blend = BLEND_IDS[blendId];
      if (!BLEND_MODES.includes(layer.blend)) stats.unimplementedBlends.push(layer.blend);
    } else if (blendId) stats.unknownBlends++;
    return layer;
  });

  const deckEls = direct(root, 'Deck');
  comp.decks = deckEls.map((deckEl, d) => {
    const deck = { id: uid(), name: paramValue(deckEl, 'Name') || `Deck ${d + 1}`, clips: {} };
    for (const clipEl of deckEl.querySelectorAll(':scope > Clip')) {
      const l = Number(clipEl.getAttribute('layerIndex'));
      const c = Number(clipEl.getAttribute('columnIndex'));
      if (!comp.layers[l]) continue;
      const file = clipEl.querySelector('PreloadData > VideoFile, PreloadData > AudioFile');
      const name = paramValue(clipEl, 'Name');
      let clip;
      if (file) {
        const made = sourceFromPath(file.getAttribute('value'));
        clip = newClip(made.source, name || made.name);
        stats.media++;
      } else {
        clip = newClip({ type: 'unsupported', reason: 'Fuente interna de la app de referencia sin importar' }, name || 'Fuente');
        stats.unsupported++;
      }
      const dur = clipEl.querySelector('Transport [name="Position"] ValueRange');
      if (dur) clip.importedDurationMs = Number(dur.getAttribute('max'));
      deck.clips[clipKey(comp.layers[l].id, c)] = clip;
      stats.clips++;
    }
    return deck;
  });
  if (!comp.decks.length) comp.decks = [{ id: uid(), name: 'Deck 1', clips: {} }];
  comp.activeDeck = Math.min(Number(root.getAttribute('currentDeckIndex')) || 0, comp.decks.length - 1);
  return { comp, stats };
}

export function parseAdvancedOutput(text) {
  const doc = parse(text);
  if (doc.documentElement.tagName !== 'ScreenSetup') throw new Error('No es un archivo AdvancedOutput.xml de la app de referencia');
  const size = doc.querySelector('CurrentCompositionTextureSize');
  const compW = Number(size?.getAttribute('width')) || 1920;
  const compH = Number(size?.getAttribute('height')) || 1080;
  const screens = [...doc.querySelectorAll('screens > Screen')].map((el, i) => {
    const device = el.querySelector('OutputDevice > *');
    const w = Number(device?.getAttribute('width')) || compW;
    const h = Number(device?.getAttribute('height')) || compH;
    const screen = newScreen(i + 1, w, h);
    screen.name = paramValue(el, 'Name') || screen.name;
    screen.sourceDevice = device?.getAttribute('name') || null;
    screen.slices = [...el.querySelectorAll(':scope > layers > Slice')].map((sEl, j) => {
      const slice = newSlice(j + 1, w, h);
      slice.name = sEl.querySelector(':scope > Params > [name="Name"]')?.getAttribute('value') || slice.name;
      const input = verts(sEl.querySelector('InputRect'));
      const dst = verts(sEl.querySelector('Warper Homography dst'));
      const output = verts(sEl.querySelector('OutputRect'));
      const bez = verts(sEl.querySelector('Warper BezierWarper vertices'));
      if (input.length === 4) slice.input = input;
      slice.corners = dst.length === 4 ? dst : output.length === 4 ? output : slice.corners;
      if (bez.length === 16) {
        slice.bezier = bez;
        const flat = bezierFromCorners(slice.corners);
        const bent = bez.some((p, k) => Math.hypot(p.x - flat[k].x, p.y - flat[k].y) > 0.5);
        slice.warpMode = bent ? 'bezier' : 'perspective';
      } else {
        slice.bezier = bezierFromCorners(slice.corners);
      }
      return slice;
    });
    return screen;
  });
  return { screens, compW, compH };
}
