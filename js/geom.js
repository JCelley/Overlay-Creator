// Exact 2D curve representation and controlled discretization.
//
// Curves are kept exact (line / circular arc / parametric) until the moment
// they must become points. Discretization is bounded by CHORD_TOL: the
// maximum chord-height (sagitta) deviation between any emitted segment and
// the true curve, measured at PART scale.

/** Max chord-height deviation of any discretized curve, inches at part scale. */
export const CHORD_TOL = 0.00001;

/** Endpoints closer than this (inches, part scale) are treated as connected. */
export const JOIN_TOL = 0.00001;

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

export const line = (a, b) => ({ type: 'line', a, b });
// sweep > 0 is counter-clockwise, < 0 clockwise (radians).
export const arc = (c, r, start, sweep) => ({ type: 'arc', c, r, start, sweep });
// fn(t) -> [x, y]; traversed from t0 to t1 (either order). breaks = parameter
// values where the curve may not be smooth (knots) and must get a vertex.
export const param = (fn, t0, t1, breaks = []) => ({ type: 'param', fn, t0, t1, breaks });

export const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

export function arcPt(cv, ang) {
  return [cv.c[0] + cv.r * Math.cos(ang), cv.c[1] + cv.r * Math.sin(ang)];
}

export function startPt(cv) {
  if (cv.type === 'line') return cv.a;
  if (cv.type === 'arc') return arcPt(cv, cv.start);
  return cv.fn(cv.t0);
}

export function endPt(cv) {
  if (cv.type === 'line') return cv.b;
  if (cv.type === 'arc') return arcPt(cv, cv.start + cv.sweep);
  return cv.fn(cv.t1);
}

export function reverse(cv) {
  if (cv.type === 'line') return line(cv.b, cv.a);
  if (cv.type === 'arc') return arc(cv.c, cv.r, cv.start + cv.sweep, -cv.sweep);
  return { ...cv, t0: cv.t1, t1: cv.t0 };
}

// ── Affine transforms: m = [a, b, c, d, e, f] → x' = a·x + c·y + e, y' = b·x + d·y + f
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function apply(m, p) {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Compose: returns the transform "first n, then m". */
export function compose(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const rotate = (ang) => [Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), 0, 0];

function isSimilarity(m) {
  const eps = 1e-12 * Math.max(1, Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
  const rot = Math.abs(m[0] - m[3]) <= eps && Math.abs(m[1] + m[2]) <= eps;
  const refl = Math.abs(m[0] + m[3]) <= eps && Math.abs(m[1] - m[2]) <= eps;
  return rot || refl;
}

export function transformCurve(cv, m) {
  if (cv.type === 'line') return line(apply(m, cv.a), apply(m, cv.b));
  if (cv.type === 'arc') {
    const det = m[0] * m[3] - m[1] * m[2];
    if (isSimilarity(m)) {
      const c = apply(m, cv.c);
      const s = apply(m, arcPt(cv, cv.start));
      return arc(c, cv.r * Math.sqrt(Math.abs(det)), Math.atan2(s[1] - c[1], s[0] - c[0]),
        det < 0 ? -cv.sweep : cv.sweep);
    }
    // Non-uniform scale turns a circle into an ellipse: keep it exact as a parametric curve.
    const src = cv;
    return param((t) => apply(m, arcPt(src, t)), cv.start, cv.start + cv.sweep, quadrantBreaks(cv.start, cv.start + cv.sweep));
  }
  const fn = cv.fn;
  return { ...cv, fn: (t) => apply(m, fn(t)) };
}

/** Multiples of π/2 strictly between a0 and a1 (either order). */
export function quadrantBreaks(a0, a1) {
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const out = [];
  for (let k = Math.floor(lo / HALF_PI) + 1; k * HALF_PI < hi; k++) out.push(k * HALF_PI);
  return out;
}

// ── Discretization ───────────────────────────────────────────────────────

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Max angular step for a chord of radius r whose sagitta is ≤ tol. */
export function arcStep(r, tol) {
  return r > tol ? 2 * Math.acos(1 - tol / r) : HALF_PI;
}

function tessArc(cv, tol) {
  const a0 = cv.start, a1 = cv.start + cv.sweep;
  // Split at quadrant angles so the extreme X/Y points of the arc are exact vertices.
  const cuts = quadrantBreaks(a0, a1);
  if (cv.sweep < 0) cuts.reverse();
  const stops = [a0, ...cuts, a1];
  const step = arcStep(cv.r, tol);
  const pts = [arcPt(cv, a0)];
  for (let i = 1; i < stops.length; i++) {
    const s = stops[i - 1], e = stops[i];
    const n = Math.max(1, Math.ceil(Math.abs(e - s) / step - 1e-9));
    for (let k = 1; k <= n; k++) pts.push(arcPt(cv, k === n ? e : s + (e - s) * k / n));
  }
  return pts;
}

function tessParam(cv, tol) {
  const { fn, t0, t1 } = cv;
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  const inner = [...new Set(cv.breaks)].filter((t) => t > lo && t < hi).sort((a, b) => a - b);
  if (t1 < t0) inner.reverse();
  const stops = [t0, ...inner, t1];
  const pts = [fn(t0)];
  const refine = (ta, pa, tb, pb, depth) => {
    let worst = 0;
    const probes = [0.25, 0.5, 0.75].map((f) => {
      const t = ta + (tb - ta) * f;
      const p = fn(t);
      worst = Math.max(worst, segDist(p, pa, pb));
      return [t, p];
    });
    if (worst > tol && depth < 30) {
      const [tm, pm] = probes[1];
      refine(ta, pa, tm, pm, depth + 1);
      refine(tm, pm, tb, pb, depth + 1);
    } else {
      pts.push(pb);
    }
  };
  for (let i = 1; i < stops.length; i++) {
    const s = stops[i - 1], e = stops[i];
    const N = 8; // seed subdivisions per span so small features can't hide between probes
    let ta = s, pa = fn(s);
    for (let k = 1; k <= N; k++) {
      const tb = k === N ? e : s + (e - s) * k / N;
      const pb = fn(tb);
      refine(ta, pa, tb, pb, 0);
      ta = tb; pa = pb;
    }
  }
  return pts;
}

/** Points along the curve; first = start, last = end. Chord error ≤ tol. */
export function tessellate(cv, tol = CHORD_TOL) {
  if (cv.type === 'line') return [cv.a, cv.b];
  if (cv.type === 'arc') return tessArc(cv, tol);
  return tessParam(cv, tol);
}

// ── NURBS (for DXF SPLINE) ───────────────────────────────────────────────

export function nurbs(degree, knots, ctrl, weights) {
  const p = degree, n = ctrl.length - 1;
  const w = weights && weights.length === ctrl.length ? weights : ctrl.map(() => 1);
  const t0 = knots[p], t1 = knots[n + 1];
  const fn = (tIn) => {
    const t = Math.min(t1, Math.max(t0, tIn));
    let k = n;
    while (k > p && !(knots[k] <= t && knots[k] < knots[k + 1])) k--;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const i = j + k - p;
      d.push([ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = j + k - p;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
  };
  return param(fn, t0, t1, knots.slice(p + 1, n + 1));
}

// ── Polyline helpers ─────────────────────────────────────────────────────

export function bboxOf(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of paths) for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Signed area (positive = counter-clockwise). */
export function area(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return s / 2;
}

export { segDist, TAU };
