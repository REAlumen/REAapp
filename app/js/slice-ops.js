// Operaciones geométricas puras sobre slices y máscaras, usadas por el editor de salidas.
import { bezierFromCorners, warpPoint } from './warp.js';

export function boundsOf(points) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { left, top, width: right - left, height: bottom - top, x: (left + right) / 2, y: (top + bottom) / 2 };
}

// Todos los puntos que definen la forma de un objeto en una etapa: se transforman juntos.
export function stagePoints(item, stage) {
  if (item.points) return item.points;
  if (stage === 'input') return item.input;
  const out = [...item.corners, ...item.bezier];
  if (item.grid) out.push(...item.grid.points);
  return out;
}

export function outlinePoints(item, stage) {
  if (item.points) return item.points;
  if (stage === 'input') return item.input;
  return item.corners;
}

export function mapPoints(points, fn) {
  for (const p of points) {
    const q = fn(p);
    p.x = q.x;
    p.y = q.y;
  }
}

export function scaleBounds(items, stage, from, to) {
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  for (const item of items) {
    mapPoints(stagePoints(item, stage), (p) => ({ x: to.left + (p.x - from.left) * sx, y: to.top + (p.y - from.top) * sy }));
  }
}

export function translate(items, stage, dx, dy) {
  for (const item of items) mapPoints(stagePoints(item, stage), (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function rotate(items, stage, cx, cy, radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  for (const item of items) {
    mapPoints(stagePoints(item, stage), (p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
    });
  }
}

export function rotationOf(item, stage) {
  const pts = outlinePoints(item, stage);
  if (pts.length < 2) return 0;
  return Math.round((Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI) * 100) / 100;
}

export function groupBounds(items, stage) {
  return boundsOf(items.flatMap((item) => outlinePoints(item, stage)));
}

export function setCenter(items, stage, axis, value) {
  const b = groupBounds(items, stage);
  if (axis === 'x') translate(items, stage, value - b.x, 0);
  else translate(items, stage, 0, value - b.y);
}

export function mirror(items, stage, axis, size) {
  for (const item of items) {
    mapPoints(stagePoints(item, stage), (p) => (axis === 'x' ? { x: size - p.x, y: p.y } : { x: p.x, y: size - p.y }));
  }
}

export function fitArea(items, stage, area) {
  scaleBounds(items, stage, groupBounds(items, stage), area);
}

export const AREAS = {
  left: (w, h) => ({ left: 0, top: 0, width: w / 2, height: h }),
  right: (w, h) => ({ left: w / 2, top: 0, width: w / 2, height: h }),
  top: (w, h) => ({ left: 0, top: 0, width: w, height: h / 2 }),
  bottom: (w, h) => ({ left: 0, top: h / 2, width: w, height: h / 2 }),
  whole: (w, h) => ({ left: 0, top: 0, width: w, height: h }),
};

const copyPoints = (pts) => pts.map((p) => ({ x: p.x, y: p.y }));

function resetWarp(slice) {
  if (slice.warpMode === 'polygon') return;
  slice.bezier = bezierFromCorners(slice.corners);
  slice.grid = null;
  slice.subdivX = 0;
  slice.subdivY = 0;
  slice.warpMode = 'perspective';
}

export function matchInputShape(slice) {
  slice.corners = copyPoints(slice.input);
  resetWarp(slice);
}

export function swapInputOutput(slice) {
  const input = copyPoints(slice.input);
  slice.input = copyPoints(slice.corners);
  slice.corners = input;
  resetWarp(slice);
}

// Subdivisiones de una rejilla lineal: conserva la forma actual del slice.
export function setSubdivisions(slice, subdivX, subdivY) {
  const sx = Math.max(0, Math.min(32, Math.round(subdivX)));
  const sy = Math.max(0, Math.min(32, Math.round(subdivY)));
  const old = { ...slice };
  const points = [];
  const nx = sx + 2;
  const ny = sy + 2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points.push(warpPoint(old, i / (nx - 1), j / (ny - 1)));
  slice.subdivX = sx;
  slice.subdivY = sy;
  if (sx === 0 && sy === 0) {
    slice.grid = null;
    slice.warpMode = 'perspective';
  } else {
    slice.grid = { nx, ny, points };
    slice.warpMode = 'grid';
  }
}

export function setPointMode(slice, mode) {
  if (mode === 'bezier') {
    if (slice.warpMode !== 'bezier') slice.bezier = bezierFromCorners(slice.corners);
    slice.warpMode = 'bezier';
    slice.grid = null;
    slice.subdivX = 0;
    slice.subdivY = 0;
  } else {
    slice.warpMode = 'perspective';
    slice.grid = null;
  }
}

export function editablePoints(item, stage) {
  if (item.points) return item.points;
  if (stage === 'input') return item.input;
  if (item.warpMode === 'bezier') return item.bezier;
  if (item.warpMode === 'grid' && item.grid) return item.grid.points;
  return item.corners;
}

// Orden de dibujo: de abajo arriba. Una máscara solo tapa lo que tiene debajo.
export function stackItems(screen) {
  const all = [...screen.slices, ...screen.masks];
  const byId = new Map(all.map((i) => [i.id, i]));
  const ordered = (screen.stack || []).map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered);
  return [...ordered, ...all.filter((i) => !seen.has(i))];
}

// Lo recién creado queda arriba de la lista, por encima de las máscaras existentes.
export function bringToTop(screen, item) {
  screen.stack = [...stackItems(screen).filter((x) => x !== item), item].map((x) => x.id);
}

export function moveInStack(screen, item, delta) {
  const order = stackItems(screen);
  const i = order.indexOf(item);
  const j = Math.max(0, Math.min(order.length - 1, i + delta));
  order.splice(j, 0, order.splice(i, 1)[0]);
  screen.stack = order.map((x) => x.id);
}

export function placeInStack(screen, item, target) {
  const order = stackItems(screen).filter((x) => x !== item);
  order.splice(order.indexOf(target) + 1, 0, item);
  screen.stack = order.map((x) => x.id);
}

// Cambia la forma de una máscara conservando el recuadro que ocupa.
export function reshapeMask(mask, kind) {
  const before = boundsOf(mask.points);
  const size = 1000;
  const points = shapePoints(kind, size, size);
  const from = boundsOf(points);
  const sx = from.width ? before.width / from.width : 1;
  const sy = from.height ? before.height / from.height : 1;
  mask.kind = kind === 'ellipse' ? 'ellipse' : 'polygon';
  mask.shape = kind;
  mask.points = points.map((p) => ({ x: before.left + (p.x - from.left) * sx, y: before.top + (p.y - from.top) * sy }));
}

export function shapePoints(kind, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 4;
  const ry = h / 4;
  if (kind === 'ellipse') return [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry }];
  if (kind === 'heart') {
    return Array.from({ length: 32 }, (_, i) => {
      const t = (i / 32) * Math.PI * 2;
      const hx = 16 * Math.sin(t) ** 3;
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return { x: cx + (hx / 16) * rx, y: cy - (hy / 16) * ry };
    });
  }
  const ring = (n, offset) => Array.from({ length: n }, (_, i) => {
    const a = offset + (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
  if (kind === 'triangle') return ring(3, -Math.PI / 2);
  if (kind === 'hexagon') return ring(6, 0);
  return [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy - ry }, { x: cx + rx, y: cy + ry }, { x: cx - rx, y: cy + ry }];
}
