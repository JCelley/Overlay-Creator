// Browser test suite. Open tests/index.html through the local server.

import { parseDxf } from '../js/dxf.js';
import { chainCurves, buildProfiles } from '../js/chain.js';
import { tessellate, arc, line, startPt, endPt, CHORD_TOL, bboxOf, area, segDist } from '../js/geom.js';
import { toleranceOffsets, computeLimits, offsetOpen } from '../js/tolerance.js';
import { newCorrection, applyMeasurement, makePrinter, deviation, calBoxPrintedSize, BOX_LINE_W } from '../js/calibration.js';
import { composeOverlay, composeCalibrationSheet } from '../js/layout.js';
import { buildPdf, readPdf } from '../js/pdf.js';
import { toIn, fromIn } from '../js/units.js';
import { defaultSettings } from '../js/storage.js';

// ── Harness ──────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, tol, msg = '') => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} ±${tol}, got ${a} (Δ ${(a - b).toExponential(3)})`); };

// ── DXF builder ──────────────────────────────────────────────────────────
const ent = (type, pairs, layer = '0') => `0\n${type}\n8\n${layer}\n` + pairs.map(([c, v]) => `${c}\n${v}\n`).join('');
function dxf(entities, { insunits = 1, blocks = '' } = {}) {
  const header = insunits === null ? '' : `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n`;
  const blk = blocks ? `0\nSECTION\n2\nBLOCKS\n${blocks}0\nENDSEC\n` : '';
  return `${header}${blk}0\nSECTION\n2\nENTITIES\n${entities.join('')}0\nENDSEC\n0\nEOF\n`;
}
const LINE = (x1, y1, x2, y2) => ent('LINE', [[10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]]);
const CIRCLE = (x, y, r, extra = []) => ent('CIRCLE', [[10, x], [20, y], [30, 0], [40, r], ...extra]);
const LWPOLY = (verts, closed, extra = []) => ent('LWPOLYLINE', [[90, verts.length], [70, closed ? 1 : 0],
  ...verts.flatMap(([x, y, b]) => [[10, x], [20, y], ...(b ? [[42, b]] : [])]), ...extra]);
const square = (x, y, s) => LWPOLY([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], true);

const curves = (text, opts) => parseDxf(text, opts).items.map((it) => it.curve);
const profilesOf = (text) => buildProfiles(curves(text)).profiles;

// Distance from point to a closed or open polyline set.
function distToPaths(p, paths) {
  let best = Infinity;
  for (const { pts, closed } of paths) {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) best = Math.min(best, segDist(p, pts[i], pts[(i + 1) % n]));
  }
  return best;
}
// Every vertex of the offset must sit at distance d from the nominal (constant-distance zone).
function checkConstantDistance(offsetPaths, nominal, d, msg) {
  let lo = Infinity, hi = -Infinity;
  for (const { pts } of offsetPaths) for (const p of pts) { const q = distToPaths(p, nominal); lo = Math.min(lo, q); hi = Math.max(hi, q); }
  // Allow chord error + Clipper integer rounding (1e-7) on both sides.
  near(lo, d, CHORD_TOL + 2e-7, `${msg} min distance`);
  near(hi, d, CHORD_TOL + 2e-7, `${msg} max distance`);
}

// ── Units ────────────────────────────────────────────────────────────────
test('units: mm ↔ in', () => {
  near(toIn(25.4, 'mm'), 1, 1e-15);
  near(fromIn(1, 'mm'), 25.4, 1e-12);
  near(toIn(0.5, 'in'), 0.5, 0);
});

test('DXF $INSUNITS=4 (mm) converts to inches', () => {
  const [cv] = curves(dxf([LINE(0, 0, 25.4, 0)], { insunits: 4 }));
  near(endPt(cv)[0], 1, 1e-12);
});

test('DXF without $INSUNITS uses fallback unit', () => {
  const p = parseDxf(dxf([LINE(0, 0, 50.8, 0)], { insunits: null }), { fallbackUnit: 'mm' });
  assert(p.units.source === 'fallback', 'source should be fallback');
  near(endPt(p.items[0].curve)[0], 2, 1e-12);
  const p2 = parseDxf(dxf([LINE(0, 0, 2, 0)], { insunits: 0 }), { fallbackUnit: 'in' });
  near(endPt(p2.items[0].curve)[0], 2, 1e-12, 'unitless code 0 → fallback');
});

// ── DXF entities ─────────────────────────────────────────────────────────
test('DXF ARC angles (degrees, CCW)', () => {
  const [cv] = curves(dxf([ent('ARC', [[10, 1], [20, 1], [40, 0.5], [50, 0], [51, 90]])]));
  const s = startPt(cv), e = endPt(cv);
  near(s[0], 1.5, 1e-12); near(s[1], 1, 1e-12);
  near(e[0], 1, 1e-12); near(e[1], 1.5, 1e-12);
});

test('DXF ARC crossing 0° (350° → 10°)', () => {
  const [cv] = curves(dxf([ent('ARC', [[10, 0], [20, 0], [40, 1], [50, 350], [51, 10]])]));
  near(cv.sweep, 20 * Math.PI / 180, 1e-12, 'sweep');
  const bb = bboxOf([tessellate(cv)]);
  near(bb.x1, 1, 1e-12, 'passes through 0° exactly');
});

test('LWPOLYLINE bulge = 1 is a semicircle (CCW bulges right of travel)', () => {
  const cs = curves(dxf([LWPOLY([[0, 0, 1], [1, 0]], false)]));
  assert(cs.length === 1 && cs[0].type === 'arc', 'one arc');
  near(cs[0].r, 0.5, 1e-12, 'radius');
  near(cs[0].c[0], 0.5, 1e-12); near(cs[0].c[1], 0, 1e-12);
  const bb = bboxOf([tessellate(cs[0])]);
  near(bb.y0, -0.5, 1e-12, 'CCW from (0,0) to (1,0) dips to y=-0.5');
  const neg = curves(dxf([LWPOLY([[0, 0, -1], [1, 0]], false)]));
  near(bboxOf([tessellate(neg[0])]).y1, 0.5, 1e-12, 'negative bulge goes the other way');
});

test('LWPOLYLINE quarter-arc bulge tan(22.5°)', () => {
  const b = Math.tan(Math.PI / 8);
  const [cv] = curves(dxf([LWPOLY([[1, 0, b], [0, 1]], false)]));
  near(cv.r, 1, 1e-12, 'radius'); near(cv.c[0], 0, 1e-12); near(cv.c[1], 0, 1e-12);
  near(cv.sweep, Math.PI / 2, 1e-12, 'sweep');
});

test('LWPOLYLINE bulge > 1 (major arc, 270°)', () => {
  const b = Math.tan(3 * Math.PI / 8); // 270° included angle
  const [cv] = curves(dxf([LWPOLY([[1, 0, b], [0, 1]], false)]));
  near(cv.r, Math.SQRT2 / 2 / Math.sin(3 * Math.PI / 4), 1e-12, 'radius');
  near(cv.sweep, 1.5 * Math.PI, 1e-12, 'sweep');
  const e = endPt(cv); near(e[0], 0, 1e-12); near(e[1], 1, 1e-12);
});

test('Closed LWPOLYLINE with bulge on closing segment', () => {
  // 1 × 1 square whose closing edge (0,1)→(0,0) is a semicircle bulging outward (to -x).
  const ps = profilesOf(dxf([LWPOLY([[0, 0], [1, 0], [1, 1], [0, 1, 1]], true)]));
  assert(ps.length === 1 && ps[0].closed, 'one closed profile');
  const bb = bboxOf([ps[0].pts]);
  near(bb.x0, -0.5, 1e-12, 'semicircle reaches x = -0.5');
  // Inscribed chords lose ≈ ⅔·sagitta·arc length of area (~1e-5 here).
  near(Math.abs(area(ps[0].pts)), 1 + Math.PI * 0.125, 2e-5, 'area');
});

test('OCS extrusion (0,0,-1) mirrors CIRCLE and LWPOLYLINE', () => {
  const ext = [[210, 0], [220, 0], [230, -1]];
  const [c] = curves(dxf([CIRCLE(2, 0, 1, ext)]));
  near(c.c[0], -2, 1e-12, 'circle center x mirrored');
  const b = Math.tan(Math.PI / 8);
  const [a] = curves(dxf([LWPOLY([[1, 0, b], [0, 1]], false, ext)]));
  const mid = tessellate(a)[Math.floor(tessellate(a).length / 2)];
  assert(mid[0] < 0 && mid[1] > 0, `arc should be in the 2nd quadrant, mid = ${mid}`);
  near(Math.hypot(...mid), 1, 1e-12);
});

test('POLYLINE / VERTEX / SEQEND with bulge', () => {
  const v = (x, y, b = 0) => ent('VERTEX', [[10, x], [20, y], [30, 0], [42, b]]);
  const text = dxf([ent('POLYLINE', [[66, 1], [70, 1]]), v(0, 0), v(2, 0, 1), v(2, 1), v(0, 1), '0\nSEQEND\n8\n0\n']);
  const ps = profilesOf(text);
  assert(ps.length === 1 && ps[0].closed, 'closed');
  near(bboxOf([ps[0].pts]).x1, 2.5, 1e-12, 'bulge on (2,0)→(2,1) reaches x = 2.5');
});

test('SPLINE rational quadratic = exact quarter circle', () => {
  const w = Math.SQRT1_2;
  const spl = ent('SPLINE', [[70, 12], [71, 2], [72, 6], [73, 3], [74, 0],
    [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1],
    [41, 1], [41, w], [41, 1],
    [10, 1], [20, 0], [30, 0], [10, 1], [20, 1], [30, 0], [10, 0], [20, 1], [30, 0]]);
  const [cv] = curves(dxf([spl]));
  const pts = tessellate(cv);
  for (const p of pts) near(Math.hypot(...p), 1, 1e-12, 'on circle');
  for (let i = 1; i < pts.length; i++) {
    const m = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
    assert(1 - Math.hypot(...m) <= CHORD_TOL, 'chord error within CHORD_TOL');
  }
});

test('SPLINE non-rational cubic with interior knots evaluates endpoints', () => {
  const spl = ent('SPLINE', [[70, 8], [71, 3], [72, 9], [73, 5],
    ...[0, 0, 0, 0, 0.5, 1, 1, 1, 1].map((k) => [40, k]),
    ...[[0, 0], [1, 2], [2, -1], [3, 2], [4, 0]].flatMap(([x, y]) => [[10, x], [20, y], [30, 0]])]);
  const [cv] = curves(dxf([spl]));
  const s = startPt(cv), e = endPt(cv);
  near(s[0], 0, 1e-12); near(s[1], 0, 1e-12); near(e[0], 4, 1e-12); near(e[1], 0, 1e-12);
});

test('ELLIPSE full: 4 × 2 extents', () => {
  const [cv] = curves(dxf([ent('ELLIPSE', [[10, 0], [20, 0], [30, 0], [11, 2], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]])]));
  const bb = bboxOf([tessellate(cv)]);
  near(bb.w, 4, 1e-12, 'width'); near(bb.h, 2, 1e-12, 'height');
});

test('INSERT: translate, scale, rotate a block', () => {
  const blocks = `0\nBLOCK\n8\n0\n2\nB1\n70\n0\n10\n0\n20\n0\n30\n0\n${LINE(0, 0, 1, 0)}${CIRCLE(0, 0, 1)}0\nENDBLK\n8\n0\n`;
  const ins = ent('INSERT', [[2, 'B1'], [10, 5], [20, 5], [30, 0], [41, 2], [42, 2], [50, 90]]);
  const cs = curves(dxf([ins], { blocks }));
  assert(cs.length === 2, `2 curves, got ${cs.length}`);
  const ln = cs.find((c) => c.type === 'line');
  near(ln.b[0], 5, 1e-12); near(ln.b[1], 7, 1e-12);
  const c = cs.find((q) => q.type === 'arc');
  near(c.r, 2, 1e-12); near(c.c[0], 5, 1e-12); near(c.c[1], 5, 1e-12);
});

// ── Chaining & discretization ────────────────────────────────────────────
test('Chaining: shuffled, mixed-direction lines → one closed square', () => {
  const cs = [line([1, 1], [1, 0]), line([0, 0], [1, 0]), line([0, 1], [1, 1]), line([0, 0], [0, 1])];
  const { chains } = chainCurves(cs);
  assert(chains.length === 1 && chains[0].closed, 'one closed chain');
  const ps = buildProfiles(cs).profiles;
  near(Math.abs(area(ps[0].pts)), 1, 1e-15);
});

test('Chaining: open chain reports gap', () => {
  const { chains } = chainCurves([line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 1]), line([0, 1], [0, 0.001])]);
  assert(chains.length === 1 && !chains[0].closed, 'open');
  near(chains[0].gap, 0.001, 1e-12);
});

test(`Arc discretization: chord error ≤ CHORD_TOL (${CHORD_TOL} in)`, () => {
  for (const r of [0.005, 0.01, 0.25, 1, 10]) {
    const pts = tessellate(arc([0, 0], r, 0.3, 5.1));
    let worst = 0;
    for (let i = 1; i < pts.length; i++) {
      const m = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
      worst = Math.max(worst, r - Math.hypot(...m));
    }
    assert(worst <= CHORD_TOL, `r=${r}: sagitta ${worst}`);
  }
});

test('Full circle discretization hits exact quadrant extremes', () => {
  const bb = bboxOf([tessellate(arc([0, 0], 0.25, 0, 2 * Math.PI))]);
  near(bb.w, 0.5, 1e-15); near(bb.h, 0.5, 1e-15);
});

// ── Tolerance ────────────────────────────────────────────────────────────
test('Tolerance types → offsets', () => {
  const o = (s) => toleranceOffsets(s);
  assert(JSON.stringify(o({ type: 'bilateral', mode: 'plusminus', value: 0.002 })) === JSON.stringify({ plus: 0.002, minus: 0.002 }), '±');
  assert(JSON.stringify(o({ type: 'bilateral', mode: 'total', value: 0.002 })) === JSON.stringify({ plus: 0.001, minus: 0.001 }), 'total');
  assert(JSON.stringify(o({ type: 'outside', value: 0.003 })) === JSON.stringify({ plus: 0.003, minus: 0 }), 'outside');
  assert(JSON.stringify(o({ type: 'inside', value: 0.003 })) === JSON.stringify({ plus: 0, minus: 0.003 }), 'inside');
  assert(JSON.stringify(o({ type: 'unequal', plus: 0.004, minus: 0.001 })) === JSON.stringify({ plus: 0.004, minus: 0.001 }), 'unequal');
});

const SQ = [{ pts: [[0, 0], [1, 0], [1, 1], [0, 1]], closed: true }];

test('Square outward offset: rounded corners, constant distance', () => {
  const d = 0.01;
  const { outer } = computeLimits(SQ, { plus: d, minus: 0 });
  assert(outer.length === 1, 'one loop');
  const bb = bboxOf(outer.map((p) => p.pts));
  near(bb.w, 1 + 2 * d, 2e-7, 'width'); near(bb.h, 1 + 2 * d, 2e-7, 'height');
  near(Math.abs(area(outer[0].pts)), 1 + 4 * d + Math.PI * d * d, 2e-6, 'area (round corners)');
  checkConstantDistance(outer, SQ, d, 'outer');
});

test('Square inward offset: sharp corners stay sharp', () => {
  const d = 0.01;
  const { inner } = computeLimits(SQ, { plus: 0, minus: d });
  assert(inner.length === 1, 'one loop');
  near(Math.abs(area(inner[0].pts)), (1 - 2 * d) ** 2, 1e-9, 'area');
  assert(inner[0].pts.length === 4, `4 vertices, got ${inner[0].pts.length}`);
  checkConstantDistance(inner, SQ, d, 'inner');
});

test('Unilateral outside: inner limit = nominal; inside: outer limit = nominal', () => {
  const a = computeLimits(SQ, toleranceOffsets({ type: 'outside', value: 0.01 }));
  assert(a.inner[0].pts === SQ[0].pts, 'inner is nominal');
  const b = computeLimits(SQ, toleranceOffsets({ type: 'inside', value: 0.01 }));
  assert(b.outer[0].pts === SQ[0].pts, 'outer is nominal');
});

test('Unequal bilateral +a/−b on a Ø0.5 circle', () => {
  const nominal = [{ pts: tessellate(arc([0, 0], 0.25, 0, 2 * Math.PI)).slice(0, -1), closed: true }];
  const { outer, inner } = computeLimits(nominal, { plus: 0.004, minus: 0.001 });
  for (const p of outer[0].pts) near(Math.hypot(...p), 0.254, CHORD_TOL + 2e-7, 'outer radius');
  for (const p of inner[0].pts) near(Math.hypot(...p), 0.249, CHORD_TOL + 2e-7, 'inner radius');
});

test('Holes: outward offset grows the part and shrinks the hole', () => {
  const hole = tessellate(arc([0.5, 0.5], 0.25, 0, 2 * Math.PI)).slice(0, -1);
  const nominal = [...SQ, { pts: hole, closed: true }];
  const { outer } = computeLimits(nominal, { plus: 0.01, minus: 0 });
  assert(outer.length === 2, `two loops, got ${outer.length}`);
  const small = outer.find((p) => bboxOf([p.pts]).w < 0.6);
  for (const p of small.pts) near(Math.hypot(p[0] - 0.5, p[1] - 0.5), 0.24, CHORD_TOL + 2e-7, 'hole radius');
});

test('Self-intersection cleanup: narrow slot fills, constant distance holds', () => {
  // U shape: 1 wide, slot 0.015 wide, 0.5 deep, from the top.
  const U = [{ closed: true, pts: [[0, 0], [1, 0], [1, 1], [0.5075, 1], [0.5075, 0.5], [0.4925, 0.5], [0.4925, 1], [0, 1]] }];
  const { outer } = computeLimits(U, { plus: 0.01, minus: 0 });
  assert(outer.length === 1, `slot closes into one loop, got ${outer.length}`);
  checkConstantDistance(outer, U, 0.01, 'outer');
});

test('Inner limit vanishes when tolerance exceeds half the part width', () => {
  const strip = [{ closed: true, pts: [[0, 0], [1, 0], [1, 0.015], [0, 0.015]] }];
  const r = computeLimits(strip, { plus: 0, minus: 0.01 });
  assert(r.inner.length === 0 && r.warnings.length === 1, 'empty + warning');
});

test('Open path: one-sided offsets of a straight line', () => {
  const p = [[0, 0], [1, 0]];
  const L = offsetOpen(p, 0.01, +1);
  assert(L.length === 1, `one polyline, got ${L.length}`);
  for (const q of L[0].pts) near(q[1], 0.01, 1e-7, 'left side y');
  const xs = L[0].pts.map((q) => q[0]);
  near(Math.min(...xs), 0, 1e-7); near(Math.max(...xs), 1, 1e-7);
  const R = offsetOpen(p, 0.01, -1);
  for (const q of R[0].pts) near(q[1], -0.01, 1e-7, 'right side y');
});

test('Open path: L-bend — convex side rounds, concave side stays sharp', () => {
  const p = [[0, 0], [1, 0], [1, 1]]; // turns left at (1,0)
  const nominal = [{ pts: p, closed: false }];
  const right = offsetOpen(p, 0.01, -1); // convex (outside of the turn)
  assert(right.length === 1, 'one polyline');
  checkConstantDistance(right, nominal, 0.01, 'convex');
  assert(right[0].pts.length > 4, 'has a rounded corner');
  const left = offsetOpen(p, 0.01, +1);
  assert(left.length === 1, 'one polyline');
  checkConstantDistance(left, nominal, 0.01, 'concave');
  assert(left[0].pts.some((q) => Math.abs(q[0] - 0.99) < 1e-7 && Math.abs(q[1] - 0.01) < 1e-7), 'sharp inside corner at (0.99, 0.01)');
});

// ── Calibration ──────────────────────────────────────────────────────────
test('Calibration: correction = expected / measured', () => {
  near(newCorrection(1, 5, 5.02), 5 / 5.02, 1e-15);
});

test('Calibration converges: a 2nd print with the correction measures nominal', () => {
  const kx = 1.0040, ky = 0.9985; // simulated printer scale error
  const expected = 5;
  let p = makePrinter('sim');
  p = applyMeasurement(p, expected, expected * p.cx * kx, expected * p.cy * ky);
  near(expected * p.cx * kx, expected, 1e-12, 'X after one pass');
  near(expected * p.cy * ky, expected, 1e-12, 'Y after one pass');
  // A noisy re-measure refines rather than replaces.
  const p2 = applyMeasurement(p, expected, 5.001, 4.999);
  near(p2.cx, p.cx * 5 / 5.001, 1e-15);
  assert(p2.history.length === 2, 'history kept');
});

test('Verify mode reports deviation without changing anything', () => {
  const d = deviation(5, 5.005);
  near(d.err, 0.005, 1e-12); near(d.pct, 0.1, 1e-9);
});

test('Calibration box size conventions', () => {
  near(calBoxPrintedSize({ mode: 'part', size: 0.5 }, 10), 5, 0);
  near(calBoxPrintedSize({ mode: 'fixed', size: 2 }, 50), 2, 0);
});

// ── Golden: PDF physical dimensions ──────────────────────────────────────
function goldenSheet(printer) {
  const text = dxf([square(0, 0, 1), CIRCLE(2, 0.5, 0.25)]);
  const profiles = profilesOf(text);
  const limits = computeLimits(profiles, { plus: 0, minus: 0 });
  const settings = { ...defaultSettings(), mag: 10, paper: 'tabloid', orientation: 'landscape', cal: { mode: 'fixed', size: 2 } };
  settings.lines = { ...settings.lines, showNominal: false, limitW: 0.004 };
  return composeOverlay({ profiles, limits, settings, printer, labels: { file: 'golden.dxf' } });
}

function pdfExtents(pdfPage, pred) {
  const shapes = pdfPage.paths.filter(pred).map((p) => bboxOf([p.pts]));
  return shapes;
}

test('GOLDEN: 1.000 in square → 10.000 in, Ø0.500 circle → 5.000 in at 10× (uncorrected)', () => {
  const sheet = goldenSheet({ name: 't', cx: 1, cy: 1 });
  const pdf = readPdf(buildPdf([sheet]));
  const pg = pdf.pages[0];
  near(pg.width, 17 * 72, 1e-9, 'page width'); near(pg.height, 11 * 72, 1e-9, 'page height');
  const shapes = pdfExtents(pg, (p) => p.width === 0.288);
  const sq = shapes.filter((b) => Math.abs(b.w - 720) < 1);
  const ci = shapes.filter((b) => Math.abs(b.w - 360) < 1);
  assert(sq.length === 2 && ci.length === 2, `outer+inner limit for each shape; got ${shapes.map((b) => b.w.toFixed(2))}`);
  for (const b of sq) { near(b.w, 720, 1e-4, 'square W pt'); near(b.h, 720, 1e-4, 'square H pt'); }
  for (const b of ci) { near(b.w, 360, 1e-4, 'circle W pt'); near(b.h, 360, 1e-4, 'circle H pt'); }
});

test('GOLDEN: correction X 1.01 / Y 0.99 scales output per axis', () => {
  const sheet = goldenSheet({ name: 't', cx: 1.01, cy: 0.99 });
  const pg = readPdf(buildPdf([sheet])).pages[0];
  const sq = pdfExtents(pg, (p) => p.width === 0.288).filter((b) => Math.abs(b.w - 727) < 2);
  assert(sq.length === 2, 'found square');
  near(sq[0].w, 727.2, 1e-4, 'square W'); near(sq[0].h, 712.8, 1e-4, 'square H');
});

test('GOLDEN: calibration box outside edges = nominal × correction', () => {
  const sheet = goldenSheet({ name: 't', cx: 1.002, cy: 0.997 });
  const pg = readPdf(buildPdf([sheet])).pages[0];
  const box = pg.paths.find((p) => Math.abs(p.width - BOX_LINE_W * 72) < 1e-9);
  assert(box, 'box present');
  const bb = bboxOf([box.pts]);
  // Outside edge = centerline extent + line width (centerline inset by half width on each side).
  // The inset is applied before correction, so compare centerline extents.
  near(bb.w, (2 - BOX_LINE_W) * 72 * 1.002, 1e-4, 'box X centerline');
  near(bb.h, (2 - BOX_LINE_W) * 72 * 0.997, 1e-4, 'box Y centerline');
});

test('GOLDEN: calibration sheet box (0.500 in @ 10× = 5.000 in)', () => {
  const settings = { ...defaultSettings(), mag: 10, paper: 'letter', cal: { mode: 'part', size: 0.5 } };
  const cs = composeCalibrationSheet({ settings, printer: { name: 't', cx: 1, cy: 1 } });
  const pg = readPdf(buildPdf([cs])).pages[0];
  const bb = bboxOf([pg.paths[0].pts]);
  near(bb.w + BOX_LINE_W * 72, 360, 1e-4, 'outside edge X'); near(bb.h + BOX_LINE_W * 72, 360, 1e-4, 'outside edge Y');
});

test('Full pipeline: DXF with bulge-filleted plate in mm', () => {
  // 50 × 25 mm plate with 5 mm corner radii (bulge tan(22.5°) on each fillet).
  const b = Math.tan(Math.PI / 8);
  const text = dxf([LWPOLY([[5, 0], [45, 0, b], [50, 5], [50, 20, b], [45, 25], [5, 25, b], [0, 20], [0, 5, b]], true)], { insunits: 4 });
  const ps = profilesOf(text);
  assert(ps.length === 1 && ps[0].closed, 'closed');
  const bb = bboxOf([ps[0].pts]);
  near(bb.w, 50 / 25.4, 1e-12, 'width'); near(bb.h, 25 / 25.4, 1e-12, 'height');
  near(Math.abs(area(ps[0].pts)), (50 * 25 - (4 - Math.PI) * 25) / 645.16, 1e-5, 'area');
  const { outer } = computeLimits(ps, { plus: 0.002, minus: 0 });
  checkConstantDistance(outer, ps, 0.002, 'outer');
});

// ── Run ──────────────────────────────────────────────────────────────────
const out = document.getElementById('out');
let pass = 0, fail = 0;
const results = [];
for (const t of tests) {
  const div = document.createElement('div');
  div.className = 't';
  const t0 = performance.now();
  try {
    t.fn();
    pass++;
    div.innerHTML = `<span class="pass">PASS</span> ${t.name} <span style="color:#6b7a99">${(performance.now() - t0).toFixed(0)} ms</span>`;
    results.push({ name: t.name, ok: true });
  } catch (e) {
    fail++;
    div.innerHTML = `<span class="fail">FAIL</span> ${t.name}<pre></pre>`;
    div.querySelector('pre').textContent = e.stack || e.message;
    results.push({ name: t.name, ok: false, error: e.message });
  }
  out.appendChild(div);
}
const sum = document.getElementById('summary');
sum.innerHTML = `<span class="${fail ? 'fail' : 'pass'}">${pass} passed, ${fail} failed</span>`;
window.__results = { pass, fail, results };
