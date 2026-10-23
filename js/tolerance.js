// Tolerance zone: offset the nominal profile to inner/outer limit curves at
// PART scale using Clipper (integer-robust polygon offsetting).
//
// Closed profiles: all closed loops are unioned (even-odd, so holes are holes)
// into the material region, then offset with round joins. Growing the region
// rounds convex corners (true constant-distance zone); shrinking it keeps
// convex corners sharp, rounds concave ones, and removes self-intersections.
//
// Open profiles: the path is offset as an open band (butt ends); the band
// boundary is split by side to give clean one-sided offset curves.

import { CHORD_TOL, segDist } from './geom.js';

/** Clipper works on integers: 1 unit = 1e-7 in (0.1 µin). */
export const CLIPPER_SCALE = 1e7;

function lib() {
  const L = globalThis.ClipperLib;
  if (!L) throw new Error('Clipper library not loaded');
  return L;
}

const toC = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) }));
const fromC = (path) => path.map((p) => [p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE]);

export const TOL_TYPES = {
  bilateral: 'Bilateral equal',
  outside: 'Unilateral outside (+t / 0)',
  inside: 'Unilateral inside (0 / −t)',
  unequal: 'Unequal bilateral (+a / −b)',
};

/**
 * Resolve a tolerance spec to offsets (inches, part scale, both ≥ 0).
 * spec = {type, value, mode: 'plusminus'|'total', plus, minus}
 */
export function toleranceOffsets(spec) {
  const v = Math.max(0, +spec.value || 0);
  switch (spec.type) {
    case 'bilateral': return spec.mode === 'total' ? { plus: v / 2, minus: v / 2 } : { plus: v, minus: v };
    case 'outside': return { plus: v, minus: 0 };
    case 'inside': return { plus: 0, minus: v };
    case 'unequal': return { plus: Math.max(0, +spec.plus || 0), minus: Math.max(0, +spec.minus || 0) };
    default: throw new Error(`Unknown tolerance type ${spec.type}`);
  }
}

/** Plain-language explanation of where the zone lies. fmt(vIn) formats a length. */
export function describeTolerance(spec, fmt) {
  const { plus, minus } = toleranceOffsets(spec);
  switch (spec.type) {
    case 'bilateral':
      return spec.mode === 'total'
        ? `Total zone ${fmt(plus + minus)} centered on nominal: limits ${fmt(plus)} outside and ${fmt(minus)} inside the nominal profile.`
        : `±${fmt(plus)}: limits ${fmt(plus)} outside and ${fmt(minus)} inside the nominal profile (total zone ${fmt(plus + minus)}).`;
    case 'outside':
      return `Zone lies entirely OUTSIDE nominal: the inner limit IS the nominal profile, the outer limit is ${fmt(plus)} out. Part may be up to ${fmt(plus)} large, never small.`;
    case 'inside':
      return `Zone lies entirely INSIDE nominal: the outer limit IS the nominal profile, the inner limit is ${fmt(minus)} in. Part may be up to ${fmt(minus)} small, never large.`;
    case 'unequal':
      return `Outer limit ${fmt(plus)} outside nominal, inner limit ${fmt(minus)} inside (total zone ${fmt(plus + minus)}).`;
    default: return '';
  }
}

export function shortTolerance(spec, fmt) {
  const { plus, minus } = toleranceOffsets(spec);
  switch (spec.type) {
    case 'bilateral': return spec.mode === 'total' ? `TOTAL ZONE ${fmt(plus + minus)} (BILATERAL)` : `±${fmt(plus)} BILATERAL`;
    case 'outside': return `+${fmt(plus)} / -0 UNILATERAL OUTSIDE`;
    case 'inside': return `+0 / -${fmt(minus)} UNILATERAL INSIDE`;
    case 'unequal': return `+${fmt(plus)} / -${fmt(minus)} UNEQUAL BILATERAL`;
    default: return '';
  }
}

/** Union all closed loops (even-odd) into the material region. */
export function materialRegion(closedPts) {
  const L = lib();
  const c = new L.Clipper();
  c.AddPaths(closedPts.map(toC), L.PolyType.ptSubject, true);
  const sol = [];
  c.Execute(L.ClipType.ctUnion, sol, L.PolyFillType.pftEvenOdd, L.PolyFillType.pftEvenOdd);
  return sol;
}

/** Offset a Clipper region by d inches (positive = material grows). Returns point lists. */
export function offsetRegion(region, d, arcTol = CHORD_TOL) {
  const L = lib();
  const co = new L.ClipperOffset(2, arcTol * CLIPPER_SCALE);
  co.AddPaths(region, L.JoinType.jtRound, L.EndType.etClosedPolygon);
  const out = [];
  co.Execute(out, d * CLIPPER_SCALE);
  return out.map(fromC);
}

function dedupe(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    if (p[0] !== pts[i][0] || p[1] !== pts[i][1]) out.push(pts[i]);
  }
  return out;
}

// Which side of the open path a point lies on: +1 left, -1 right (w.r.t. path direction).
function sideClassifier(path, d) {
  const n = path.length;
  const turn = (i) => {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  };
  // Coarse grid over segments for nearest-segment lookup.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of path) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // Band points are ~d from the path, so a cell ≥ d keeps the ring search to a few rings.
  const cell = Math.max((x1 - x0) / 64, (y1 - y0) / 64, d, 1e-6);
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (let s = 0; s < n - 1; s++) {
    const a = path[s], b = path[s + 1];
    for (let i = Math.floor((Math.min(a[0], b[0]) - x0) / cell); i <= Math.floor((Math.max(a[0], b[0]) - x0) / cell); i++) {
      for (let j = Math.floor((Math.min(a[1], b[1]) - y0) / cell); j <= Math.floor((Math.max(a[1], b[1]) - y0) / cell); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }
  return (q) => {
    const ci = Math.floor((q[0] - x0) / cell), cj = Math.floor((q[1] - y0) / cell);
    let best = Infinity, bs = -1;
    for (let rad = 0; rad < 2048; rad++) {
      for (let i = ci - rad; i <= ci + rad; i++) for (let j = cj - rad; j <= cj + rad; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== rad) continue;
        for (const s of grid.get(key(i, j)) || []) {
          const d = segDist(q, path[s], path[s + 1]);
          if (d < best) { best = d; bs = s; }
        }
      }
      // Anything in ring rad+1 is at least rad·cell away.
      if (bs >= 0 && best <= rad * cell) break;
    }
    const a = path[bs], b = path[bs + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy);
    // Nearest point is an interior vertex: q is on the convex side of that turn.
    if (t <= 0 && bs > 0) return turn(bs) > 0 ? -1 : 1;
    if (t >= 1 && bs + 1 < n - 1) return turn(bs + 1) > 0 ? -1 : 1;
    return dx * (q[1] - a[1]) - dy * (q[0] - a[0]) >= 0 ? 1 : -1;
  };
}

/**
 * One-sided offset of an open path by d > 0 on `side` (+1 left, -1 right).
 * Returns a list of polylines (normally one).
 */
export function offsetOpen(pts, d, side, arcTol = CHORD_TOL) {
  const L = lib();
  const path = dedupe(pts);
  if (path.length < 2) return [];
  const co = new L.ClipperOffset(2, arcTol * CLIPPER_SCALE);
  co.AddPath(toC(path), L.JoinType.jtRound, L.EndType.etOpenButt);
  const band = [];
  co.Execute(band, d * CLIPPER_SCALE);
  const sideOf = sideClassifier(path, d);
  const out = [];
  for (const ringC of band) {
    const ring = fromC(ringC);
    const s = ring.map(sideOf);
    const startIdx = s.findIndex((v, i) => v !== s[(i - 1 + s.length) % s.length]);
    if (startIdx < 0) { if (s[0] === side) out.push({ pts: ring, closed: true }); continue; }
    let run = [];
    for (let k = 0; k < ring.length; k++) {
      const i = (startIdx + k) % ring.length;
      if (k > 0 && s[i] !== s[(i - 1 + ring.length) % ring.length]) {
        if (s[(i - 1 + ring.length) % ring.length] === side && run.length > 1) out.push({ pts: run, closed: false });
        run = [];
      }
      run.push(ring[i]);
    }
    if (s[(startIdx - 1 + ring.length) % ring.length] === side && run.length > 1) out.push({ pts: run, closed: false });
  }
  return out;
}

/**
 * Compute limit curves for all profiles.
 * @param profiles [{pts, closed}]
 * @param offsets {plus, minus} inches, part scale
 * @param openFlip set/array of open-profile indices whose + side is flipped (to the right)
 * @returns {outer: {pts, closed}[], inner: {pts, closed}[], warnings: string[]}
 */
export function computeLimits(profiles, offsets, openFlip = []) {
  const warnings = [];
  const flip = new Set(openFlip);
  const closed = profiles.filter((p) => p.closed);
  const open = profiles.filter((p) => !p.closed);
  const outer = [], inner = [];

  if (closed.length) {
    const region = materialRegion(closed.map((p) => p.pts));
    const nominal = closed.map((p) => ({ pts: p.pts, closed: true }));
    if (offsets.plus > 0) outer.push(...offsetRegion(region, offsets.plus).map((pts) => ({ pts, closed: true })));
    else outer.push(...nominal);
    if (offsets.minus > 0) {
      const res = offsetRegion(region, -offsets.minus);
      if (!res.length) warnings.push('Inner limit vanishes: the tolerance is larger than half the narrowest section of the part.');
      inner.push(...res.map((pts) => ({ pts, closed: true })));
    } else inner.push(...nominal);
  }

  open.forEach((p, idx) => {
    const sgn = flip.has(idx) ? -1 : 1;
    if (offsets.plus > 0) outer.push(...offsetOpen(p.pts, offsets.plus, sgn));
    else outer.push({ pts: p.pts, closed: false });
    if (offsets.minus > 0) inner.push(...offsetOpen(p.pts, offsets.minus, -sgn));
    else inner.push({ pts: p.pts, closed: false });
  });

  return { outer, inner, warnings };
}
