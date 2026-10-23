// Sheet composition: part-scale geometry → a list of drawing items in
// PRINTED inches (origin bottom-left, y up), with calibration correction
// applied. The same sheet object feeds both the preview and the PDF, so what
// you see is exactly what is written.

import { bboxOf } from './geom.js';
import { calBoxPrintedSize, BOX_LINE_W } from './calibration.js';

export const PAPER = {
  letter: { name: 'Letter 8.5 × 11 in', w: 8.5, h: 11 },
  legal: { name: 'Legal 8.5 × 14 in', w: 8.5, h: 14 },
  tabloid: { name: 'Tabloid / Ledger 11 × 17 in', w: 11, h: 17 },
  a4: { name: 'A4 210 × 297 mm', w: 210 / 25.4, h: 297 / 25.4 },
  a3: { name: 'A3 297 × 420 mm', w: 297 / 25.4, h: 420 / 25.4 },
};

const STRIP_H = 0.45;   // info text strip at the bottom of the printable area
const TEXT_PT = 7;
const LINE_STEP = 0.125;
const CLEAR = 0.1;      // clearance between profile and calibration box
const LABEL_H = 0.16;

function pageSize(paper, orientation) {
  const p = PAPER[paper] || PAPER.letter;
  return orientation === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function correctionFn(w, h, printer) {
  const cx = printer?.cx ?? 1, cy = printer?.cy ?? 1;
  const px = w / 2, py = h / 2;
  return ([x, y]) => [px + (x - px) * cx, py + (y - py) * cy];
}

function boxItems(x, y, S) {
  // Inset the stroke centerline so the OUTSIDE edge of the printed line is exactly S.
  const i = BOX_LINE_W / 2;
  return {
    kind: 'path', role: 'calbox', width: BOX_LINE_W, dash: null,
    subpaths: [{ closed: true, pts: [[x + i, y + i], [x + S - i, y + i], [x + S - i, y + S - i], [x + i, y + S - i]] }],
  };
}

function finalize(sheet, printer) {
  const corr = correctionFn(sheet.w, sheet.h, printer);
  for (const it of sheet.items) {
    if (it.kind === 'path') for (const sp of it.subpaths) sp.pts = sp.pts.map(corr);
    else [it.x, it.y] = corr([it.x, it.y]);
  }
  return sheet;
}

function dateStamp(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

function printerLine(printer) {
  if (!printer) return 'PRINTER: (none) - UNCORRECTED';
  const cal = printer.calibratedAt ? printer.calibratedAt.slice(0, 10) : 'NEVER CALIBRATED';
  return `PRINTER: ${printer.name}   CORR X ${printer.cx.toFixed(6)}  Y ${printer.cy.toFixed(6)}   CAL ${cal}`;
}

/**
 * @param {object} o
 * @param o.profiles  [{pts, closed}] nominal, part scale (in)
 * @param o.limits    {outer, inner} from computeLimits
 * @param o.settings  app settings (mag, paper, orientation, margin, cal, lines)
 * @param o.printer   printer profile {name, cx, cy, calibratedAt} or null
 * @param o.labels    {file, tol, lineNote, calNote}
 * @param o.now       Date
 */
export function composeOverlay({ profiles, limits, settings, printer, labels = {}, now = new Date() }) {
  const s = settings;
  const mag = s.mag;
  const warnings = [];
  const nominal = profiles.map((p) => ({ pts: p.pts, closed: p.closed }));
  const all = [...nominal, ...limits.outer, ...limits.inner];
  const bb = bboxOf(all.map((p) => p.pts));
  const W = bb.w * mag, H = bb.h * mag;
  const m = s.margin;

  let orient = s.orientation;
  const fits = (o) => { const pg = pageSize(s.paper, o); return W <= pg.w - 2 * m && H <= pg.h - 2 * m - STRIP_H; };
  if (orient === 'auto') orient = fits('portrait') || !fits('landscape') ? 'portrait' : 'landscape';
  const { w, h } = pageSize(s.paper, orient);
  const area = { x0: m, y0: m + STRIP_H, x1: w - m, y1: h - m };
  const profileFits = W <= area.x1 - area.x0 && H <= area.y1 - area.y0;
  if (!profileFits) {
    warnings.push(`Magnified profile is ${W.toFixed(3)} × ${H.toFixed(3)} in but the printable area is ${(area.x1 - area.x0).toFixed(3)} × ${(area.y1 - area.y0).toFixed(3)} in. Geometry will be cut off. Use a larger sheet, lower magnification, or wait for tiling (Phase 2).`);
  }

  // Calibration box candidates: the four corners of the printable area.
  const S = calBoxPrintedSize(s.cal, mag);
  const boxFits = S <= Math.min(area.x1 - area.x0, area.y1 - area.y0 - LABEL_H);
  if (!boxFits) warnings.push(`Calibration box (${S.toFixed(3)} in printed) does not fit on the sheet. Switch the calibration box to a fixed printed size.`);
  const inside = S >= 1.5;
  const corners = [
    { name: 'BL', x: area.x0, y: area.y0, label: 'above' },
    { name: 'BR', x: area.x1 - S, y: area.y0, label: 'above' },
    { name: 'TL', x: area.x0, y: area.y1 - S, label: 'below' },
    { name: 'TR', x: area.x1 - S, y: area.y1 - S, label: 'below' },
  ];
  const reserved = (c) => {
    const r = { x0: c.x, y0: c.y, x1: c.x + S, y1: c.y + S };
    if (!inside) { if (c.label === 'above') r.y1 += LABEL_H; else r.y0 -= LABEL_H; }
    return r;
  };
  const bboxAt = (cx, cy) => ({ x0: cx - W / 2, y0: cy - H / 2, x1: cx + W / 2, y1: cy + H / 2 });
  const clearOf = (pb, c) => !overlaps(reserved(c), { x0: pb.x0 - CLEAR, y0: pb.y0 - CLEAR, x1: pb.x1 + CLEAR, y1: pb.y1 + CLEAR });

  // Profile placement: centered if a corner is free; otherwise centered in the
  // space left beside or above/below a corner box; otherwise centered anyway.
  let cxp = (area.x0 + area.x1) / 2, cyp = (area.y0 + area.y1) / 2;
  let corner = boxFits ? corners.find((c) => clearOf(bboxAt(cxp, cyp), c)) : null;
  if (boxFits && !corner) {
    for (const c of corners) {
      const r = reserved(c);
      const rests = [
        { x0: area.x0, x1: area.x1, y0: c.label === 'above' ? r.y1 + CLEAR : area.y0, y1: c.label === 'above' ? area.y1 : r.y0 - CLEAR },
        { y0: area.y0, y1: area.y1, x0: c.name.endsWith('L') ? r.x1 + CLEAR : area.x0, x1: c.name.endsWith('L') ? area.x1 : r.x0 - CLEAR },
      ];
      const rest = rests.find((q) => W <= q.x1 - q.x0 && H <= q.y1 - q.y0);
      if (rest) { cxp = (rest.x0 + rest.x1) / 2; cyp = (rest.y0 + rest.y1) / 2; corner = c; break; }
    }
    if (!corner) {
      corner = corners[0];
      warnings.push('No corner is clear of the profile: the calibration box overlaps geometry. Use a larger sheet or a smaller fixed-size box.');
    }
  }
  const bcx = (bb.x0 + bb.x1) / 2, bcy = (bb.y0 + bb.y1) / 2;
  const place = ([x, y]) => [cxp + (x - bcx) * mag, cyp + (y - bcy) * mag];
  const placed = bboxAt(cxp, cyp);
  const tr = (list) => list.map((p) => ({ closed: p.closed, pts: p.pts.map(place) }));

  const L = s.lines;
  const items = [];
  if (L.showNominal) {
    items.push({ kind: 'path', role: 'nominal', width: L.nominalW, dash: [L.dashOn, L.dashOff], subpaths: tr(nominal) });
  }
  items.push({ kind: 'path', role: 'outer', width: L.limitW, dash: null, subpaths: tr(limits.outer) });
  items.push({ kind: 'path', role: 'inner', width: L.limitW, dash: null, subpaths: tr(limits.inner) });

  let box = null;
  if (corner) {
    const c = corner;
    items.push(boxItems(c.x, c.y, S));
    const ly = inside ? c.y + S - 0.18 : c.label === 'above' ? c.y + S + 0.05 : c.y - LABEL_H + 0.03;
    const lx = inside ? c.x + 0.1 : c.x;
    items.push({ kind: 'text', x: lx, y: ly, size: 6, bold: true, text: `CAL ${labels.calNote || S.toFixed(4) + ' in'} - MEASURE OUTSIDE EDGES X & Y` });
    box = { ...c, S };
  }

  // Info strip.
  const lines = [
    `APW COMPARATOR OVERLAY   |   ${labels.file || '(no file)'}   |   MAG ${mag}X   |   PRINT AT 100% / ACTUAL SIZE - NO FIT-TO-PAGE`,
    `TOL ${labels.tol || '-'}   |   NOMINAL = DASHED, LIMITS = SOLID   |   ${labels.lineNote || ''}`,
    `${printerLine(printer)}   |   GENERATED ${dateStamp(now)}`,
  ];
  lines.forEach((t, k) => items.push({ kind: 'text', x: m, y: m + STRIP_H - 0.13 - k * LINE_STEP, size: TEXT_PT, bold: k === 0, text: t }));

  const sheet = {
    w, h, orientation: orient, items, warnings,
    guides: { margin: m, area, strip: { x0: m, y0: m, x1: w - m, y1: m + STRIP_H }, placed },
    info: { W, H, profileFits, calBox: box, bbox: bb },
  };
  return finalize(sheet, printer);
}

/** A standalone calibration sheet: one box, centered, with instructions. */
export function composeCalibrationSheet({ settings, printer, labels = {}, now = new Date() }) {
  const s = settings;
  const { w, h } = pageSize(s.paper, s.orientation === 'landscape' ? 'landscape' : 'portrait');
  const m = s.margin;
  const S = calBoxPrintedSize(s.cal, s.mag);
  const warnings = [];
  if (S > Math.min(w, h) - 2 * m - 1) warnings.push(`Calibration box (${S.toFixed(3)} in) is too large for this sheet. Use a fixed printed size or a larger sheet.`);
  const x = (w - S) / 2, y = (h - S) / 2;
  const items = [boxItems(x, y, S)];
  const t = (yy, text, size = 9, bold = false) => items.push({ kind: 'text', x: m + 0.1, y: yy, size, bold, text });
  t(h - m - 0.25, 'APW COMPARATOR OVERLAY - CALIBRATION SHEET', 12, true);
  t(h - m - 0.5, 'Print at 100% / Actual size (no fit-to-page, no scaling), on the same printer and media as your overlays.');
  t(h - m - 0.68, `Measure the box across its OUTSIDE edges in X (across the sheet) and Y (along the sheet). Nominal: ${labels.calNote || S.toFixed(4) + ' in'}.`);
  t(h - m - 0.86, 'Enter both measurements in the Calibration panel.');
  t(m + 0.3, `${printerLine(printer)}   |   GENERATED ${dateStamp(now)}`, 7);
  items.push({ kind: 'text', x: x, y: y - 0.2, size: 8, bold: true, text: '<- X ->  measure this width' });
  const sheet = {
    w, h, orientation: w > h ? 'landscape' : 'portrait', items, warnings,
    guides: { margin: m, area: { x0: m, y0: m, x1: w - m, y1: h - m }, strip: null, placed: null },
    info: { calBox: { x, y, S } },
  };
  return finalize(sheet, printer);
}
