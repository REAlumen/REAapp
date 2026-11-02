import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homography, applyHomography, bezierEval, bezierFromCorners, buildSliceMesh, pointInPolygon, warpPoint,
} from '../app/js/warp.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

test('la homografía lleva cada esquina origen a su destino', () => {
  const src = rect(0, 0, 1, 1);
  const dst = [{ x: 10, y: 20 }, { x: 900, y: 5 }, { x: 1000, y: 700 }, { x: -30, y: 640 }];
  const h = homography(src, dst);
  src.forEach((p, i) => {
    const q = applyHomography(h, p.x, p.y);
    near(q.x, dst[i].x); near(q.y, dst[i].y);
  });
});

test('una rejilla Bézier creada desde esquinas equivale a la interpolación bilineal', () => {
  const corners = rect(100, 50, 400, 200);
  const ctrl = bezierFromCorners(corners);
  assert.equal(ctrl.length, 16);
  const p = bezierEval(ctrl, 0.25, 0.75);
  near(p.x, 200); near(p.y, 200);
});

test('los datos de un slice real de Arena se reproducen (Slice 2 de AdvancedOutput.xml)', () => {
  const corners = rect(484.5, 0, 469.5, 1080);
  const slice = { warpMode: 'perspective', corners, input: rect(475.5, 0, 469.5, 1080) };
  near(warpPoint(slice, 1, 1).x, 954);
  near(warpPoint(slice, 1, 1).y, 1080);
  const mesh = buildSliceMesh(slice, 1920, 1080, 4);
  assert.equal(mesh.length, 4 * 4 * 6 * 6);
  near(mesh[0], 484.5, 1e-3); near(mesh[2], 475.5 / 1920, 1e-6);
});

test('pointInPolygon distingue dentro y fuera', () => {
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon(tri, 2, 2), true);
  assert.equal(pointInPolygon(tri, 9, 9), false);
});
