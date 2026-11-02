import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AREAS, boundsOf, bringToTop, fitArea, groupBounds, matchInputShape, mirror, moveInStack, placeInStack, reshapeMask, rotate, rotationOf, scaleBounds, setCenter, setSubdivisions, shapePoints, stackItems, swapInputOutput, translate,
} from '../app/js/slice-ops.js';
import { bezierFromCorners, buildSliceMesh, triangulate, warpPoint } from '../app/js/warp.js';

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const slice = (x = 100, y = 50, w = 400, h = 200) => {
  const corners = rect(x, y, w, h);
  return { input: rect(0, 0, 960, 540), corners, bezier: bezierFromCorners(corners), warpMode: 'perspective', grid: null };
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('mover un slice mueve también su malla Bézier', () => {
  const s = slice();
  translate([s], 'output', 10, 20);
  near(s.corners[0].x, 110);
  near(s.bezier[0].y, 70);
  near(s.input[0].x, 0);
});

test('escalar respeta el ancla izquierda-arriba del destino', () => {
  const s = slice();
  scaleBounds([s], 'output', groupBounds([s], 'output'), { left: 0, top: 0, width: 800, height: 400 });
  const b = groupBounds([s], 'output');
  near(b.left, 0); near(b.width, 800); near(b.height, 400);
});

test('rotar 90 grados informa la rotación y conserva el centro', () => {
  const s = slice();
  const before = groupBounds([s], 'output');
  rotate([s], 'output', before.x, before.y, Math.PI / 2);
  near(rotationOf(s, 'output'), 90, 0.01);
  const after = groupBounds([s], 'output');
  near(after.x, before.x); near(after.y, before.y);
});

test('Left Half y Whole Area ocupan la zona correcta', () => {
  const s = slice();
  fitArea([s], 'input', AREAS.left(1920, 1080));
  assert.deepEqual(boundsOf(s.input), { left: 0, top: 0, width: 960, height: 1080, x: 480, y: 540 });
  fitArea([s], 'input', AREAS.whole(1920, 1080));
  near(boundsOf(s.input).width, 1920);
});

test('Mirror X refleja respecto al escenario y Center X centra', () => {
  const s = slice();
  mirror([s], 'output', 'x', 1000);
  near(groupBounds([s], 'output').x, 700);
  setCenter([s], 'output', 'x', 500);
  near(groupBounds([s], 'output').x, 500);
});

test('Match Input Shape y Swap intercambian entrada y salida', () => {
  const s = slice();
  matchInputShape(s);
  near(s.corners[1].x, 960);
  const t = slice();
  swapInputOutput(t);
  near(t.input[0].x, 100);
  near(t.corners[1].x, 960);
});

test('subdividir conserva la forma y permite deformar un punto interior', () => {
  const s = slice();
  setSubdivisions(s, 1, 2);
  assert.equal(s.grid.points.length, 3 * 4);
  assert.equal(s.warpMode, 'grid');
  near(warpPoint(s, 0.5, 0.5).x, 300);
  s.grid.points[1 * 3 + 1].x += 50;
  assert.ok(warpPoint(s, 0.5, 1 / 3).x > 340);
  setSubdivisions(s, 0, 0);
  assert.equal(s.warpMode, 'perspective');
});

test('invertir horizontalmente solo cambia las coordenadas de entrada', () => {
  const s = slice();
  const plain = buildSliceMesh(s, 960, 540, 2);
  s.flipX = true;
  const flipped = buildSliceMesh(s, 960, 540, 2);
  near(plain[0], flipped[0]);
  near(plain[2], 0);
  near(flipped[2], 1);
});

test('la pila ordena slices y máscaras, y sobrevive a altas y bajas', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const m = { id: 'm', points: [] };
  const screen = { slices: [a, b], masks: [m] };
  assert.deepEqual(stackItems(screen).map((x) => x.id), ['a', 'b', 'm']);
  moveInStack(screen, m, -1);
  assert.deepEqual(stackItems(screen).map((x) => x.id), ['a', 'm', 'b']);
  placeInStack(screen, b, a);
  assert.deepEqual(stackItems(screen).map((x) => x.id), ['a', 'b', 'm']);
  screen.slices.splice(0, 1);
  screen.slices.push({ id: 'c' });
  assert.deepEqual(stackItems(screen).map((x) => x.id), ['b', 'm', 'c']);
});

test('triangular un polígono cóncavo cubre su área sin salirse', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 3 }, { x: 0, y: 10 }];
  const idx = triangulate(pts);
  assert.equal(idx.length, 3 * 3);
  const area = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  let total = 0;
  for (let i = 0; i < idx.length; i += 3) total += area(pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]);
  near(total, 65);
});

test('un polígono genera malla con su propia entrada', () => {
  const s = { warpMode: 'polygon', corners: rect(0, 0, 100, 100), input: rect(10, 20, 50, 50) };
  const mesh = buildSliceMesh(s, 100, 100);
  assert.equal(mesh.length, 6 * 6);
  // La triangulación puede empezar en cualquier vértice: se busca el de la esquina de origen.
  let found = false;
  for (let v = 0; v < mesh.length; v += 6) {
    if (mesh[v] === 0 && mesh[v + 1] === 0) {
      near(mesh[v + 2], 0.1);
      near(mesh[v + 3], 0.2);
      found = true;
    }
  }
  assert.ok(found);
});

test('lo recién creado queda arriba de la pila, sobre las máscaras', () => {
  const a = { id: 'a' };
  const m = { id: 'm', points: [] };
  const screen = { slices: [a], masks: [m] };
  const p = { id: 'p' };
  screen.slices.push(p);
  bringToTop(screen, p);
  assert.deepEqual(stackItems(screen).map((x) => x.id), ['a', 'm', 'p']);
});

test('una forma que se cruza no cuelga la triangulación', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.ok(Array.isArray(triangulate(pts)));
});

test('cambiar la forma de una máscara conserva su recuadro', () => {
  const m = { kind: 'polygon', points: rect(100, 200, 300, 400) };
  reshapeMask(m, 'heart');
  const b = boundsOf(m.points);
  near(b.left, 100, 1e-6);
  near(b.width, 300, 1e-6);
  near(b.height, 400, 1e-6);
  reshapeMask(m, 'ellipse');
  assert.equal(m.kind, 'ellipse');
  assert.equal(m.points.length, 2);
});

test('las formas de máscara tienen el número de puntos esperado', () => {
  assert.equal(shapePoints('rect', 100, 100).length, 4);
  assert.equal(shapePoints('triangle', 100, 100).length, 3);
  assert.equal(shapePoints('hexagon', 100, 100).length, 6);
  assert.equal(shapePoints('ellipse', 100, 100).length, 2);
});
