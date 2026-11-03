import test from 'node:test';
import assert from 'node:assert/strict';
import { STILL_DURATION, autopilotColumn, migrateComposition, newClip, newComposition } from '../app/js/model.js';

const cols = [0, 2, 5];

test('con el autopilot del layer apagado no cambia de clip', () => {
  assert.equal(autopilotColumn('off', 'layer', cols, 2), null);
  assert.equal(autopilotColumn('off', 'next', cols, 2), null);
});

test('el clip sigue la dirección del layer y salta columnas vacías', () => {
  assert.equal(autopilotColumn('next', 'layer', cols, 2), 5);
  assert.equal(autopilotColumn('next', 'layer', cols, 5), 0);
  assert.equal(autopilotColumn('prev', 'layer', cols, 0), 5);
});

test('la acción del clip manda sobre la dirección del layer', () => {
  assert.equal(autopilotColumn('next', 'prev', cols, 2), 0);
  assert.equal(autopilotColumn('next', 'first', cols, 5), 0);
  assert.equal(autopilotColumn('next', 'last', cols, 0), 5);
  assert.equal(autopilotColumn('next', 'none', cols, 0), null);
  assert.equal(autopilotColumn('next', 'last', cols, 5), null);
});

test('el azar nunca repite el clip actual', () => {
  for (const r of [0, 0.49, 0.99]) assert.notEqual(autopilotColumn('random', 'layer', cols, 2, () => r), 2);
});

test('un layer con un solo clip no cambia', () => {
  assert.equal(autopilotColumn('next', 'layer', [3], 3), null);
});

test('las composiciones anteriores pasan el autopilot del clip al layer', () => {
  const comp = newComposition();
  const [l1, l2] = comp.layers;
  delete l1.autopilot;
  delete l2.autopilot;
  const a = newClip({ type: 'image', path: 'a.png' }, 'a');
  a.autopilot = 'random';
  delete a.transport.duration;
  const b = newClip({ type: 'image', path: 'b.png' }, 'b');
  b.autopilot = 'off';
  comp.decks[0].clips[`${l1.id}:0`] = a;
  comp.decks[0].clips[`${l2.id}:0`] = b;
  migrateComposition(comp);
  assert.equal(l1.autopilot, 'random');
  assert.equal(l2.autopilot, 'off');
  assert.equal(a.autopilot, 'random');
  assert.equal(b.autopilot, 'layer');
  assert.equal(a.transport.duration, STILL_DURATION);
});
