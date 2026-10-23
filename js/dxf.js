// ASCII DXF reader → exact curves in INCHES.
//
// Supported: LINE, ARC, CIRCLE, LWPOLYLINE / POLYLINE (with bulges), SPLINE,
// ELLIPSE, and INSERT (block references, recursively). 2D entities in an
// object coordinate system with extrusion (0,0,-1) are mirrored correctly.

import { line, arc, param, nurbs, transformCurve, compose, translate, scale, rotate,
  IDENTITY, quadrantBreaks, dist, TAU } from './geom.js';
import { insunits } from './units.js';

const DEG = Math.PI / 180;

function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const tags = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new Error(`Malformed DXF near line ${i + 1}: expected a group code, got "${lines[i].trim().slice(0, 40)}"`);
    tags.push([code, lines[i + 1].trim()]);
  }
  return tags;
}

// Split the tag stream into { header, blocks, entities }.
function structure(tags) {
  const header = {};
  const blocks = {};
  const entities = [];
  let i = 0;
  const readEntity = () => {
    const ent = { type: tags[i][1], tags: [] };
    i++;
    while (i < tags.length && tags[i][0] !== 0) { ent.tags.push(tags[i]); i++; }
    return ent;
  };
  // Gather POLYLINE + VERTEX… + SEQEND into a single entity.
  const readList = (stop) => {
    const list = [];
    while (i < tags.length && !(tags[i][0] === 0 && stop.includes(tags[i][1]))) {
      if (tags[i][0] !== 0) { i++; continue; }
      const ent = readEntity();
      if (ent.type === 'POLYLINE') {
        ent.vertices = [];
        while (i < tags.length && tags[i][0] === 0 && tags[i][1] === 'VERTEX') ent.vertices.push(readEntity());
        if (i < tags.length && tags[i][1] === 'SEQEND') readEntity();
      }
      list.push(ent);
    }
    return list;
  };

  while (i < tags.length) {
    if (tags[i][0] === 0 && tags[i][1] === 'SECTION') {
      const name = tags[i + 1] && tags[i + 1][1];
      i += 2;
      if (name === 'HEADER') {
        let v = null;
        while (i < tags.length && !(tags[i][0] === 0 && tags[i][1] === 'ENDSEC')) {
          if (tags[i][0] === 9) { v = tags[i][1]; header[v] = []; } else if (v) header[v].push(tags[i]);
          i++;
        }
      } else if (name === 'BLOCKS') {
        while (i < tags.length && !(tags[i][0] === 0 && tags[i][1] === 'ENDSEC')) {
          if (tags[i][0] === 0 && tags[i][1] === 'BLOCK') {
            const blk = readEntity();
            const g = groups(blk.tags);
            const entsInBlock = readList(['ENDBLK', 'ENDSEC']);
            if (tags[i] && tags[i][1] === 'ENDBLK') readEntity();
            blocks[first(g, 2, '')] = { base: [num(g, 10, 0), num(g, 20, 0)], entities: entsInBlock };
          } else i++;
        }
      } else if (name === 'ENTITIES') {
        entities.push(...readList(['ENDSEC']));
      } else {
        while (i < tags.length && !(tags[i][0] === 0 && tags[i][1] === 'ENDSEC')) i++;
      }
    }
    i++;
  }
  return { header, blocks, entities };
}

function groups(tags) {
  const g = new Map();
  for (const [c, v] of tags) { if (!g.has(c)) g.set(c, []); g.get(c).push(v); }
  return g;
}
const first = (g, code, def) => (g.has(code) ? g.get(code)[0] : def);
const num = (g, code, def) => (g.has(code) ? parseFloat(g.get(code)[0]) : def);
const nums = (g, code) => (g.get(code) || []).map(parseFloat);

// Ordered (x,y) pairs from repeated 10/20 groups (or other codes).
function pairs(tags, cx, cy) {
  const out = [];
  let x = null;
  for (const [c, v] of tags) {
    if (c === cx) x = parseFloat(v);
    else if (c === cy && x !== null) { out.push([x, parseFloat(v)]); x = null; }
  }
  return out;
}

// Object coordinate system → WCS for planar entities. Only ±Z extrusions are
// meaningful for a 2D profile; others are reported and skipped.
function ocs(g) {
  const nx = num(g, 210, 0), ny = num(g, 220, 0), nz = num(g, 230, 1);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9) return nz < 0 ? [-1, 0, 0, 1, 0, 0] : IDENTITY;
  return null;
}

function bulgeSeg(p1, p2, b) {
  if (Math.abs(b) < 1e-12) return line(p1, p2);
  const d = dist(p1, p2);
  if (d === 0) return null;
  const ux = (p2[0] - p1[0]) / d, uy = (p2[1] - p1[1]) / d;
  const h = d * (1 - b * b) / (4 * b); // signed distance of center left of chord
  const c = [(p1[0] + p2[0]) / 2 - uy * h, (p1[1] + p2[1]) / 2 + ux * h];
  const r = d * (1 + b * b) / (4 * Math.abs(b));
  return arc(c, r, Math.atan2(p1[1] - c[1], p1[0] - c[0]), 4 * Math.atan(b));
}

function polyCurves(verts, bulges, closed) {
  const out = [];
  const n = verts.length;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p1 = verts[k], p2 = verts[(k + 1) % n];
    if (dist(p1, p2) === 0) continue;
    const s = bulgeSeg(p1, p2, bulges[k] || 0);
    if (s) out.push(s);
  }
  return out;
}

function entityCurves(ent, ctx, depth) {
  const g = groups(ent.tags);
  const t = ent.type;
  switch (t) {
    case 'LINE': {
      const a = [num(g, 10, 0), num(g, 20, 0)], b = [num(g, 11, 0), num(g, 21, 0)];
      return dist(a, b) > 0 ? [line(a, b)] : [];
    }
    case 'CIRCLE':
    case 'ARC': {
      const m = ocs(g);
      if (!m) { ctx.warn(`${t} with non-Z extrusion skipped`); return []; }
      const c = [num(g, 10, 0), num(g, 20, 0)], r = num(g, 40, 0);
      if (!(r > 0)) return [];
      let cv;
      if (t === 'CIRCLE') cv = arc(c, r, 0, TAU);
      else {
        const a0 = num(g, 50, 0) * DEG;
        let a1 = num(g, 51, 360) * DEG;
        while (a1 <= a0) a1 += TAU;
        cv = arc(c, r, a0, a1 - a0);
      }
      return [transformCurve(cv, m)];
    }
    case 'LWPOLYLINE': {
      const m = ocs(g);
      if (!m) { ctx.warn('LWPOLYLINE with non-Z extrusion skipped'); return []; }
      // Walk tags in order so each bulge (42) pairs with the vertex before it.
      const verts = [], bulges = [];
      let x = null;
      for (const [c, v] of ent.tags) {
        if (c === 10) x = parseFloat(v);
        else if (c === 20 && x !== null) { verts.push([x, parseFloat(v)]); bulges.push(0); x = null; }
        else if (c === 42 && verts.length) bulges[verts.length - 1] = parseFloat(v);
      }
      const closed = (num(g, 70, 0) & 1) === 1;
      return polyCurves(verts, bulges, closed).map((cv) => transformCurve(cv, m));
    }
    case 'POLYLINE': {
      const flags = num(g, 70, 0);
      if (flags & (16 | 64)) { ctx.warn('Polygon mesh / polyface POLYLINE skipped'); return []; }
      const m = flags & 8 ? IDENTITY : ocs(g); // 3D polylines are already in WCS
      if (!m) { ctx.warn('POLYLINE with non-Z extrusion skipped'); return []; }
      const verts = [], bulges = [];
      for (const v of ent.vertices || []) {
        const vg = groups(v.tags);
        if (num(vg, 70, 0) & 16) continue; // spline frame control point, not on the curve
        verts.push([num(vg, 10, 0), num(vg, 20, 0)]);
        bulges.push(num(vg, 42, 0));
      }
      return polyCurves(verts, bulges, (flags & 1) === 1).map((cv) => transformCurve(cv, m));
    }
    case 'ELLIPSE': {
      const c = [num(g, 10, 0), num(g, 20, 0)];
      const mj = [num(g, 11, 0), num(g, 21, 0)];
      const ratio = num(g, 40, 1);
      const nz = num(g, 230, 1);
      if (Math.abs(num(g, 210, 0)) > 1e-9 || Math.abs(num(g, 220, 0)) > 1e-9) { ctx.warn('ELLIPSE with non-Z extrusion skipped'); return []; }
      // Minor axis = N × major · ratio
      const mn = nz < 0 ? [mj[1] * ratio, -mj[0] * ratio] : [-mj[1] * ratio, mj[0] * ratio];
      const s = num(g, 41, 0);
      let e = num(g, 42, TAU);
      while (e <= s) e += TAU;
      const fn = (u) => [c[0] + mj[0] * Math.cos(u) + mn[0] * Math.sin(u), c[1] + mj[1] * Math.cos(u) + mn[1] * Math.sin(u)];
      return [param(fn, s, e, quadrantBreaks(s, e))];
    }
    case 'SPLINE': {
      const flags = num(g, 70, 0);
      const degree = num(g, 71, 3);
      const knots = nums(g, 40);
      const weights = nums(g, 41);
      const ctrl = pairs(ent.tags, 10, 20);
      const fit = pairs(ent.tags, 11, 21);
      if (ctrl.length > degree && knots.length === ctrl.length + degree + 1) {
        return [nurbs(degree, knots, ctrl, (flags & 4) && weights.length === ctrl.length ? weights : null)];
      }
      if (fit.length >= 2) {
        ctx.warn('SPLINE defined only by fit points: approximated by straight segments between fit points. Re-export with control points for full accuracy.');
        const out = [];
        for (let k = 1; k < fit.length; k++) if (dist(fit[k - 1], fit[k]) > 0) out.push(line(fit[k - 1], fit[k]));
        return out;
      }
      ctx.warn('Malformed SPLINE skipped');
      return [];
    }
    case 'INSERT': {
      const blk = ctx.blocks[first(g, 2, '')];
      if (!blk) { ctx.warn(`INSERT of missing block "${first(g, 2, '')}" skipped`); return []; }
      if (depth > 16) { ctx.warn('Block nesting too deep; INSERT skipped'); return []; }
      if (num(g, 70, 1) > 1 || num(g, 71, 1) > 1) ctx.warn('INSERT arrays (rows/columns) not supported; only the first instance is used');
      const m0 = ocs(g);
      if (!m0) { ctx.warn('INSERT with non-Z extrusion skipped'); return []; }
      let m = translate(-blk.base[0], -blk.base[1]);
      m = compose(scale(num(g, 41, 1), num(g, 42, 1)), m);
      m = compose(rotate(num(g, 50, 0) * DEG), m);
      m = compose(translate(num(g, 10, 0), num(g, 20, 0)), m);
      m = compose(m0, m);
      const layer = first(g, 8, '0');
      const out = [];
      for (const sub of blk.entities) {
        for (const item of collect(sub, ctx, depth + 1)) {
          out.push({ ...item, curve: transformCurve(item.curve, m), layer: item.layer === '0' ? layer : item.layer });
        }
      }
      return out;
    }
    default:
      ctx.ignored[t] = (ctx.ignored[t] || 0) + 1;
      return [];
  }
}

function collect(ent, ctx, depth) {
  const g = groups(ent.tags);
  if (num(g, 67, 0) === 1) { ctx.paperSpace++; return []; }
  const layer = first(g, 8, '0');
  const res = entityCurves(ent, ctx, depth);
  // INSERT already returns tagged items.
  return ent.type === 'INSERT' ? res : res.map((curve) => ({ curve, layer, entity: ent.type }));
}

/**
 * Parse DXF text.
 * @param {string} text
 * @param {{fallbackUnit?: 'in'|'mm'}} opts unit to assume when $INSUNITS is absent/unitless
 * @returns {{items: {curve, layer, entity}[], layers: string[], units: {source, name, inchesPerUnit}, warnings: string[], ignored: Object}}
 */
export function parseDxf(text, opts = {}) {
  const { header, blocks, entities } = structure(tokenize(text));
  const warnSet = new Map();
  const ctx = {
    blocks,
    ignored: {},
    paperSpace: 0,
    warn: (w) => warnSet.set(w, (warnSet.get(w) || 0) + 1),
  };
  const raw = [];
  for (const ent of entities) raw.push(...collect(ent, ctx, 0));

  const code = header.$INSUNITS ? parseInt(header.$INSUNITS.find((t) => t[0] === 70)?.[1] ?? '0', 10) : 0;
  const u = insunits(code);
  let units;
  if (u) units = { source: '$INSUNITS', name: u.name, inchesPerUnit: u.f };
  else {
    const fb = opts.fallbackUnit === 'mm' ? 'mm' : 'in';
    units = { source: 'fallback', name: fb, inchesPerUnit: fb === 'mm' ? 1 / 25.4 : 1 };
  }
  const k = units.inchesPerUnit;
  const items = k === 1 ? raw : raw.map((it) => ({ ...it, curve: transformCurve(it.curve, scale(k)) }));

  const warnings = [...warnSet].map(([w, n]) => (n > 1 ? `${w} (×${n})` : w));
  if (ctx.paperSpace) warnings.push(`${ctx.paperSpace} paper-space entities ignored`);
  const layers = [...new Set(items.map((it) => it.layer))].sort();
  return { items, layers, units, warnings, ignored: ctx.ignored };
}
