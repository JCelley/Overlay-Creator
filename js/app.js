// UI wiring. All geometry work lives in the other modules; this file only
// moves values between the page, the stored state, and the pipeline:
//   DXF → curves → profiles → limits → sheet → (preview | PDF)

import { parseDxf } from './dxf.js';
import { buildProfiles } from './chain.js';
import { computeLimits, toleranceOffsets, describeTolerance, shortTolerance, TOL_TYPES } from './tolerance.js';
import { composeOverlay, composeCalibrationSheet, PAPER } from './layout.js';
import { buildPdf } from './pdf.js';
import { createPreview } from './preview.js';
import { calBoxPrintedSize, deviation, applyMeasurement, makePrinter } from './calibration.js';
import { loadState, saveState, exportJson, importJson, saveLastDxf, loadLastDxf } from './storage.js';
import { toIn, fromIn, fmtU, decimals } from './units.js';
import { CHORD_TOL } from './geom.js';

const $ = (id) => document.getElementById(id);
let state = loadState();
const S = () => state.settings;
const U = () => state.settings.units;
const L = (vIn) => fmtU(vIn, U());

let dxf = null;      // { name, text, parsed }
let geo = null;      // { profiles, branchPoints, key }
let lim = null;      // { outer, inner, warnings, key }
let sheet = null;
let pendingVerify = null;

const preview = createPreview($('preview'));

const LINE_PRESETS = [0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.010, 0.015];
const HAIRLINE_TYPICAL = 1 / 600; // a 600 dpi laser's single-dot line

const activePrinter = () => state.printers.find((p) => p.id === state.activePrinterId) || null;
const persist = () => saveState(state);

// ── Numbers in the current display unit ──────────────────────────────────
// Never rewrite a field the user is typing in.
function setLen(id, vIn) { if (document.activeElement !== $(id)) $(id).value = +fromIn(vIn, U()).toFixed(decimals(U()) + 1); }
function getLen(id) { const v = parseFloat($(id).value); return Number.isFinite(v) ? toIn(v, U()) : null; }

// ── Pipeline ─────────────────────────────────────────────────────────────
function recompute() {
  const warnings = [];
  if (!dxf) { renderEmpty(); return; }
  const s = S();

  const gKey = JSON.stringify([dxf.name, dxf.parsed.units, s.layersOff]);
  if (!geo || geo.key !== gKey) {
    const off = new Set(s.layersOff);
    const curves = dxf.parsed.items.filter((it) => !off.has(it.layer)).map((it) => it.curve);
    geo = { ...buildProfiles(curves), key: gKey };
    lim = null;
  }
  const offsets = toleranceOffsets(s.tol);
  const lKey = JSON.stringify([gKey, offsets, s.openFlip]);
  if (!lim || lim.key !== lKey) {
    lim = geo.profiles.length ? { ...computeLimits(geo.profiles, offsets, s.openFlip), key: lKey } : { outer: [], inner: [], warnings: [], key: lKey };
  }

  warnings.push(...dxf.parsed.warnings, ...lim.warnings);
  if (geo.branchPoints) warnings.push(`${geo.branchPoints} point(s) where more than two curve ends meet. Overlapping or duplicate entities can make chaining ambiguous; check the preview.`);
  const open = geo.profiles.filter((p) => !p.closed);
  if (open.length) warnings.push(`${open.length} open profile(s). Their tolerance lines are one-sided offsets; use the Open profiles list to choose which side is "+" (outside).`);
  renderGeoInfo();

  if (!geo.profiles.length) {
    renderEmpty('No usable geometry on the selected layers.');
    showWarnings(warnings);
    return;
  }

  const fmtTol = (v) => fmtU(v, U());
  sheet = composeOverlay({
    profiles: geo.profiles,
    limits: lim,
    settings: s,
    printer: activePrinter(),
    labels: { file: dxf.name, tol: shortTolerance(s.tol, fmtTol), lineNote: lineNote(true), calNote: calNote() },
  });
  warnings.push(...sheet.warnings);
  preview.render(sheet);
  $('sheetInfo').textContent = `${PAPER[s.paper].name} · ${sheet.orientation} · profile ${sheet.info.W.toFixed(3)} × ${sheet.info.H.toFixed(3)} in printed`;
  $('btnExport').disabled = false;
  showWarnings(warnings);
}

function renderEmpty(msg) {
  sheet = null;
  $('btnExport').disabled = true;
  const s = S();
  const pg = PAPER[s.paper];
  const land = s.orientation === 'landscape';
  preview.render({ w: land ? pg.h : pg.w, h: land ? pg.w : pg.h, items: [], guides: { margin: s.margin, area: null, strip: null } });
  $('sheetInfo').textContent = msg || 'Load a DXF to begin.';
  showWarnings([]);
}

function showWarnings(list) {
  const box = $('warnings');
  box.textContent = '';
  for (const w of list) { const d = document.createElement('div'); d.textContent = w; box.appendChild(d); }
}

// ── Readouts ─────────────────────────────────────────────────────────────
function lineNote(forSheet) {
  const s = S();
  const w = s.lines.limitW;
  const { plus, minus } = toleranceOffsets(s.tol);
  const zone = plus + minus;
  const eff = w === 0 ? HAIRLINE_TYPICAL : w;
  const atPart = eff / s.mag;
  const pct = zone > 0 ? ` = ${((atPart / zone) * 100).toFixed(1)}% of the ${L(zone)} zone` : '';
  if (forSheet) return `LIMIT LINE ${w === 0 ? 'HAIRLINE' : L(w)} PRINTED = ${w === 0 ? '~' : ''}${L(atPart)} AT PART`;
  return w === 0
    ? `Hairline = the printer's thinnest line (≈ ${L(HAIRLINE_TYPICAL)} on a 600 dpi laser) ≈ ${L(atPart)} at the part${pct}. Each limit line is centered on its limit.`
    : `${L(w)} printed ÷ ${s.mag}× = ${L(atPart)} at the part${pct}. Each limit line is centered on its limit, so half of it falls inside the zone.`;
}

function calNote() {
  const s = S();
  const P = calBoxPrintedSize(s.cal, s.mag);
  return s.cal.mode === 'part' ? `${L(P)} (${L(s.cal.size)} @ ${s.mag}X)` : `${L(P)} FIXED`;
}

function renderGeoInfo() {
  if (!dxf) { $('geoInfo').textContent = ''; return; }
  const p = dxf.parsed;
  const lines = [];
  lines.push(`Units: ${p.units.name} (${p.units.source === '$INSUNITS' ? 'from $INSUNITS' : 'NOT in file — using fallback'})`);
  lines.push(`Entities: ${p.items.length} curves${Object.keys(p.ignored).length ? ` · ignored ${Object.entries(p.ignored).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}`);
  if (geo) {
    const closed = geo.profiles.filter((q) => q.closed).length;
    const all = geo.profiles.flatMap((q) => q.pts);
    let bb = '';
    if (all.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of all) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      bb = `\nNominal extents: ${L(x1 - x0)} × ${L(y1 - y0)} (part)`;
    }
    lines.push(`Profiles: ${geo.profiles.length} (${closed} closed, ${geo.profiles.length - closed} open)${bb}`);
    lines.push(`Discretization: chord error ≤ ${CHORD_TOL} in at part scale`);
  }
  $('geoInfo').textContent = lines.join('\n');

  // Layers
  const lay = $('layers');
  lay.textContent = '';
  if (p.layers.length > 1) {
    const h = document.createElement('div'); h.className = 'head'; h.textContent = 'Layers'; lay.appendChild(h);
    for (const name of p.layers) {
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !S().layersOff.includes(name);
      cb.addEventListener('change', () => {
        const off = new Set(S().layersOff);
        if (cb.checked) off.delete(name); else off.add(name);
        S().layersOff = [...off]; S().openFlip = []; changed();
      });
      lab.append(cb, document.createTextNode(` ${name}  (${p.items.filter((it) => it.layer === name).length})`));
      lay.appendChild(lab);
    }
  }

  // Open profiles: choose the + side
  const ol = $('openList');
  ol.textContent = '';
  const open = geo ? geo.profiles.filter((q) => !q.closed) : [];
  if (open.length) {
    const h = document.createElement('div'); h.className = 'head'; h.textContent = 'Open profiles — flip "+" side'; ol.appendChild(h);
    open.forEach((q, i) => {
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = S().openFlip.includes(i);
      cb.addEventListener('change', () => {
        const f = new Set(S().openFlip);
        if (cb.checked) f.add(i); else f.delete(i);
        S().openFlip = [...f]; changed();
      });
      lab.append(cb, document.createTextNode(` Open #${i + 1} (gap ${L(q.gap)})`));
      ol.appendChild(lab);
    });
  }
}

function renderTolerance() {
  const t = S().tol;
  $('tolType').value = t.type;
  $('grpMode').style.display = t.type === 'bilateral' ? '' : 'none';
  $('grpValue').style.display = t.type === 'unequal' ? 'none' : '';
  $('grpUnequal').style.display = t.type === 'unequal' ? '' : 'none';
  document.querySelectorAll('input[name=tolMode]').forEach((r) => { r.checked = r.value === t.mode; });
  $('lblValue').textContent = t.type === 'bilateral' ? (t.mode === 'total' ? 'Total zone width' : 'Tolerance ± (each side)') : 'Tolerance t';
  setLen('tolValue', t.value); setLen('tolPlus', t.plus); setLen('tolMinus', t.minus);
  $('tolNote').textContent = describeTolerance(t, L);
}

function renderLineSelects() {
  for (const id of ['limitW', 'nominalW']) {
    const sel = $(id);
    const cur = S().lines[id];
    sel.textContent = '';
    const vals = LINE_PRESETS.includes(cur) ? LINE_PRESETS : [...LINE_PRESETS, cur].sort((a, b) => a - b);
    for (const v of vals) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 0 ? 'Hairline (printer thinnest)' : L(v);
      sel.appendChild(o);
    }
    sel.value = cur;
  }
  $('limitNote').textContent = lineNote(false);
}

function renderCalibration() {
  const sel = $('printer');
  sel.textContent = '';
  for (const p of state.printers) {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  }
  sel.value = state.activePrinterId;
  const p = activePrinter();
  $('corrInfo').innerHTML = p
    ? `Active correction  X <b>${p.cx.toFixed(6)}</b>  Y <b>${p.cy.toFixed(6)}</b>\nLast calibrated: ${p.calibratedAt ? new Date(p.calibratedAt).toLocaleString() : '<span class="warn">never</span>'}`
    : '';
  const c = S().cal;
  document.querySelectorAll('input[name=calMode]').forEach((r) => { r.checked = r.value === c.mode; });
  $('lblCalSize').textContent = c.mode === 'part' ? 'Box size at part scale' : 'Box printed size';
  setLen('calSize', c.size);
  const P = calBoxPrintedSize(c, S().mag);
  $('calExpected').textContent = `Expected printed box: ${L(P)} × ${L(P)}${c.mode === 'part' ? ` (${L(c.size)} × ${S().mag})` : ''}`;
  $('calHistory').textContent = p && p.history?.length
    ? p.history.slice().reverse().map((h) => `${new Date(h.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}  exp ${L(h.expected)}  meas ${L(h.measuredX)} / ${L(h.measuredY)}  → X ${h.cx.toFixed(6)} Y ${h.cy.toFixed(6)}`).join('\n')
    : 'No calibrations yet.';
}

function renderAll() {
  const s = S();
  $('units').value = s.units;
  $('fallbackUnit').value = s.fallbackUnit;
  if (document.activeElement !== $('mag')) $('mag').value = s.mag;
  document.querySelectorAll('#magChips button').forEach((b) => b.classList.toggle('on', +b.dataset.mag === s.mag));
  document.querySelectorAll('.suffix.u').forEach((e) => { e.textContent = s.units; });
  renderTolerance();
  renderLineSelects();
  $('showNominal').checked = s.lines.showNominal;
  setLen('dashOn', s.lines.dashOn); setLen('dashOff', s.lines.dashOff);
  $('paper').value = s.paper;
  $('orientation').value = s.orientation;
  setLen('margin', s.margin);
  renderCalibration();
  recompute();
}

let timer = null;
function changed() {
  persist();
  clearTimeout(timer);
  timer = setTimeout(renderAll, 120);
}

// ── File loading ─────────────────────────────────────────────────────────
function loadDxfText(name, text, remember = true) {
  try {
    const parsed = parseDxf(text, { fallbackUnit: S().fallbackUnit });
    dxf = { name, text, parsed };
    geo = null; lim = null;
    $('dropText').textContent = name;
    $('drop').classList.add('loaded');
    if (remember) saveLastDxf(name, text);
    renderAll();
  } catch (e) {
    dxf = null;
    renderEmpty();
    showWarnings([`Could not read ${name}: ${e.message}`]);
    $('warnings').firstChild?.classList.add('err');
  }
}

function readFile(file) {
  const r = new FileReader();
  r.onload = () => {
    S().layersOff = []; S().openFlip = [];
    loadDxfText(file.name, r.result);
  };
  r.readAsText(file);
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Events ───────────────────────────────────────────────────────────────
function bind() {
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
  // Allow dropping anywhere on the page.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });

  $('units').addEventListener('change', (e) => { S().units = e.target.value; changed(); });
  $('fallbackUnit').addEventListener('change', (e) => {
    S().fallbackUnit = e.target.value; persist();
    if (dxf) loadDxfText(dxf.name, dxf.text, false); else renderAll();
  });

  $('mag').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v > 0) { S().mag = v; changed(); } });
  document.querySelectorAll('#magChips button').forEach((b) => b.addEventListener('click', () => { S().mag = +b.dataset.mag; changed(); }));

  const tolType = $('tolType');
  for (const [k, v] of Object.entries(TOL_TYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = v; tolType.appendChild(o); }
  tolType.addEventListener('change', () => { S().tol.type = tolType.value; changed(); });
  document.querySelectorAll('input[name=tolMode]').forEach((r) => r.addEventListener('change', () => { S().tol.mode = r.value; changed(); }));
  const lenInput = (id, set) => $(id).addEventListener('input', () => { const v = getLen(id); if (v !== null && v >= 0) { set(v); changed(); } });
  lenInput('tolValue', (v) => { S().tol.value = v; });
  lenInput('tolPlus', (v) => { S().tol.plus = v; });
  lenInput('tolMinus', (v) => { S().tol.minus = v; });

  $('limitW').addEventListener('change', (e) => { S().lines.limitW = +e.target.value; changed(); });
  $('nominalW').addEventListener('change', (e) => { S().lines.nominalW = +e.target.value; changed(); });
  $('showNominal').addEventListener('change', (e) => { S().lines.showNominal = e.target.checked; changed(); });
  lenInput('dashOn', (v) => { if (v > 0) S().lines.dashOn = v; });
  lenInput('dashOff', (v) => { if (v > 0) S().lines.dashOff = v; });

  const paper = $('paper');
  for (const [k, v] of Object.entries(PAPER)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; paper.appendChild(o); }
  paper.addEventListener('change', () => { S().paper = paper.value; changed(); });
  $('orientation').addEventListener('change', (e) => { S().orientation = e.target.value; changed(); });
  lenInput('margin', (v) => { S().margin = v; });

  $('btnFit').addEventListener('click', () => preview.fit());

  $('btnExport').addEventListener('click', () => {
    if (!sheet) return;
    const base = dxf.name.replace(/\.dxf$/i, '');
    const bytes = buildPdf([sheet], { title: `${base} ${S().mag}x overlay` });
    download(bytes, `${base}_${S().mag}x_overlay.pdf`, 'application/pdf');
  });

  // Calibration
  $('printer').addEventListener('change', (e) => { state.activePrinterId = e.target.value; changed(); });
  $('btnNewPrinter').addEventListener('click', () => {
    const name = prompt('Name for the new printer profile (printer + media):', 'Office laser - transparency');
    if (!name) return;
    const p = makePrinter(name.trim());
    state.printers.push(p); state.activePrinterId = p.id; changed();
  });
  $('btnRenamePrinter').addEventListener('click', () => {
    const p = activePrinter(); if (!p) return;
    const name = prompt('Rename printer profile:', p.name);
    if (name) { p.name = name.trim(); changed(); }
  });
  $('btnDeletePrinter').addEventListener('click', () => {
    const p = activePrinter(); if (!p) return;
    if (state.printers.length === 1) { alert('Keep at least one printer profile.'); return; }
    if (!confirm(`Delete printer profile "${p.name}" and its calibration?`)) return;
    state.printers = state.printers.filter((q) => q.id !== p.id);
    state.activePrinterId = state.printers[0].id; changed();
  });
  document.querySelectorAll('input[name=calMode]').forEach((r) => r.addEventListener('change', () => {
    S().cal.mode = r.value;
    // Sensible starting size for each convention.
    S().cal.size = r.value === 'part' ? 0.5 : 2;
    changed();
  }));
  lenInput('calSize', (v) => { if (v > 0) S().cal.size = v; });

  $('btnCalSheet').addEventListener('click', () => {
    const cs = composeCalibrationSheet({ settings: S(), printer: activePrinter(), labels: { calNote: calNote() } });
    if (cs.warnings.length) alert(cs.warnings.join('\n'));
    download(buildPdf([cs], { title: 'Calibration sheet' }), `calibration_${activePrinter().name.replace(/[^\w-]+/g, '_')}.pdf`, 'application/pdf');
  });

  const readMeasure = () => {
    const mx = getLen('measX'), my = getLen('measY');
    if (!(mx > 0) || !(my > 0)) { $('calResult').innerHTML = '<span class="bad">Enter both measured X and Y.</span>'; return null; }
    return { mx, my, expected: calBoxPrintedSize(S().cal, S().mag) };
  };
  const report = (m) => {
    const dx = deviation(m.expected, m.mx), dy = deviation(m.expected, m.my);
    const cls = (d) => (Math.abs(d.pct) < 0.05 ? 'ok' : Math.abs(d.pct) < 0.2 ? 'warn' : 'bad');
    const line = (ax, d) => `<span class="${cls(d)}">${ax}: ${d.err >= 0 ? '+' : ''}${L(d.err)} (${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(3)}%)</span>`;
    return `Expected ${L(m.expected)}\n${line('X', dx)}\n${line('Y', dy)}`;
  };
  $('btnVerify').addEventListener('click', () => {
    const m = readMeasure(); if (!m) return;
    pendingVerify = m;
    $('calResult').innerHTML = `VERIFY (stored correction unchanged)\n${report(m)}\n<button id="btnAccept" class="btn small">Accept as new calibration</button>`;
    $('btnAccept').addEventListener('click', () => applyCal(pendingVerify));
  });
  const applyCal = (m) => {
    const p = activePrinter();
    const before = { cx: p.cx, cy: p.cy };
    Object.assign(p, applyMeasurement(p, m.expected, m.mx, m.my));
    pendingVerify = null;
    $('measX').value = ''; $('measY').value = '';
    changed();
    $('calResult').innerHTML = `${report(m)}\nCorrection X ${before.cx.toFixed(6)} → <b>${p.cx.toFixed(6)}</b>\nCorrection Y ${before.cy.toFixed(6)} → <b>${p.cy.toFixed(6)}</b>\nReprint the calibration sheet and verify.`;
  };
  $('btnApplyCal').addEventListener('click', () => { const m = readMeasure(); if (m) applyCal(m); });

  $('btnExportJson').addEventListener('click', () => {
    download(new TextEncoder().encode(exportJson(state)), `apw-overlay-settings-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  });
  $('importJson').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => {
      try { state = importJson(t); persist(); geo = null; lim = null; renderAll(); alert('Settings imported.'); }
      catch (err) { alert(`Import failed: ${err.message}`); }
    });
    e.target.value = '';
  });
}

bind();
if (!globalThis.ClipperLib) showWarnings(['Clipper geometry library failed to load (check the network connection). Tolerance offsets are unavailable.']);
const last = loadLastDxf();
if (last?.text) loadDxfText(last.name, last.text, false); else renderAll();
