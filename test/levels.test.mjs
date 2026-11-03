import test from 'node:test';
import assert from 'node:assert/strict';
import { audioLevels, layerOpacity, migrateComposition, newClip, newComposition, toDb } from '../app/js/model.js';

const setup = () => {
  const comp = newComposition();
  const layer = comp.layers[0];
  const clip = newClip({ type: 'video', path: 'a.mp4' }, 'a');
  return { comp, layer, clip };
};

test('el Master del layer escala opacidad y volumen a la vez', () => {
  const { comp, layer, clip } = setup();
  layer.opacity = 0.8;
  layer.volume = 0.5;
  layer.master = 0.5;
  assert.equal(layerOpacity(layer), 0.4);
  assert.equal(audioLevels(comp, layer, clip).volume, 0.25);
});

test('el volumen y el paneo de cada clip se suman a los del layer', () => {
  const { comp, layer, clip } = setup();
  clip.volume = 0.5;
  clip.pan = -0.5;
  layer.pan = -0.75;
  const { volume, pan } = audioLevels(comp, layer, clip, 0.5);
  assert.equal(volume, 0.25);
  assert.equal(pan, -1);
});

test('valores dañados no dan niveles inválidos', () => {
  const { comp, layer, clip } = setup();
  layer.master = Number.NaN;
  clip.pan = Number.POSITIVE_INFINITY;
  const { volume, pan } = audioLevels(comp, layer, clip);
  assert.ok(volume >= 0 && volume <= 1);
  assert.ok(pan >= -1 && pan <= 1);
  assert.equal(layerOpacity(layer), 0);
});

test('el volumen se muestra en decibelios', () => {
  assert.equal(toDb(1), '0.0 dB');
  assert.equal(toDb(0.5), '-6.0 dB');
  assert.equal(toDb(0), '-∞ dB');
});

test('las composiciones anteriores reciben Master y paneo neutros', () => {
  const { comp, layer, clip } = setup();
  delete layer.master;
  delete layer.pan;
  delete clip.pan;
  comp.decks[0].clips[`${layer.id}:0`] = clip;
  migrateComposition(comp);
  assert.equal(layer.master, 1);
  assert.equal(layer.pan, 0);
  assert.equal(clip.pan, 0);
});
