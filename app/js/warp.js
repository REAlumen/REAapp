// Geometría de slices: homografía de 4 esquinas y superficie Bézier de 4x4 puntos de control.
// Las coordenadas están en píxeles con origen arriba a la izquierda.

function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-12) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solve8(A, b);
  return h ? [...h, 1] : null;
}

export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

const bernstein = (t) => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

export function bezierEval(ctrl, u, v) {
  const bu = bernstein(u);
  const bv = bernstein(v);
  let x = 0;
  let y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const w = bu[i] * bv[j];
      x += w * ctrl[j * 4 + i].x;
      y += w * ctrl[j * 4 + i].y;
    }
  }
  return { x, y };
}

export function bilinear(q, u, v) {
  const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
  const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

export function bezierFromCorners(corners) {
  const pts = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) pts.push(bilinear(corners, i / 3, j / 3));
  return pts;
}

const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

function gridEval(grid, u, v) {
  const fx = Math.min(grid.nx - 2, Math.floor(u * (grid.nx - 1)));
  const fy = Math.min(grid.ny - 2, Math.floor(v * (grid.ny - 1)));
  const at = (i, j) => grid.points[j * grid.nx + i];
  return bilinear([at(fx, fy), at(fx + 1, fy), at(fx + 1, fy + 1), at(fx, fy + 1)], u * (grid.nx - 1) - fx, v * (grid.ny - 1) - fy);
}

export function warpPoint(slice, u, v) {
  if (slice.warpMode === 'bezier') return bezierEval(slice.bezier, u, v);
  if (slice.warpMode === 'grid' && slice.grid) return gridEval(slice.grid, u, v);
  const h = homography(UNIT, slice.corners);
  return h ? applyHomography(h, u, v) : bilinear(slice.corners, u, v);
}

// Triangula un polígono simple (también cóncavo) recortando orejas. Devuelve índices.
export function triangulate(points) {
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  const sign = area >= 0 ? 1 : -1;
  const cross = (a, b, c) => ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * sign;
  const inTriangle = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const rest = points.map((_, i) => i);
  const out = [];
  let guard = points.length * points.length;
  while (rest.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < rest.length; k++) {
      const i = rest[(k + rest.length - 1) % rest.length];
      const j = rest[k];
      const l = rest[(k + 1) % rest.length];
      const [a, b, c] = [points[i], points[j], points[l]];
      if (cross(a, b, c) <= 0) continue;
      if (rest.some((m) => m !== i && m !== j && m !== l && inTriangle(points[m], a, b, c))) continue;
      out.push(i, j, l);
      rest.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // Polígono que se cruza a sí mismo: se dibuja lo posible sin colgar la app.
  }
  if (rest.length === 3) out.push(...rest);
  return out;
}

function buildPolygonMesh(slice, compW, compH) {
  const pts = slice.corners;
  const indices = triangulate(pts);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const w = Math.max(...xs) - left || 1;
  const h = Math.max(...ys) - top || 1;
  const data = new Float32Array(indices.length * 6);
  indices.forEach((index, k) => {
    const p = pts[index];
    const q = slice.input[index] || p;
    data.set([p.x, p.y, q.x / compW, q.y / compH, (p.x - left) / w, (p.y - top) / h], k * 6);
  });
  return data;
}

// Malla de triángulos: x, y en píxeles de salida; u, v en la composición (0-1); s, t locales al slice (0-1).
export function buildSliceMesh(slice, compW, compH, n = 32) {
  if (slice.warpMode === 'polygon') return buildPolygonMesh(slice, compW, compH);
  const data = new Float32Array(n * n * 6 * 6);
  let k = 0;
  const put = (i, j) => {
    const s = i / n;
    const t = j / n;
    const p = warpPoint(slice, s, t);
    const q = bilinear(slice.input, slice.flipX ? 1 - s : s, slice.flipY ? 1 - t : t);
    data[k++] = p.x; data[k++] = p.y;
    data[k++] = q.x / compW; data[k++] = q.y / compH;
    data[k++] = s; data[k++] = t;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      put(i, j); put(i + 1, j); put(i + 1, j + 1);
      put(i, j); put(i + 1, j + 1); put(i, j + 1);
    }
  }
  return data;
}

export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
