// Browser persistence + JSON export/import.

import { makePrinter } from './calibration.js';

const KEY = 'apw_comparator_overlay_v1';
const DXF_KEY = 'apw_comparator_overlay_last_dxf';
const MAX_DXF_CHARS = 2_000_000;

export function defaultSettings() {
  return {
    units: 'in',
    fallbackUnit: 'in',
    mag: 10,
    tol: { type: 'bilateral', mode: 'plusminus', value: 0.005, plus: 0.005, minus: 0.003 },
    lines: { limitW: 0.004, nominalW: 0.002, showNominal: true, dashOn: 0.06, dashOff: 0.04 },
    paper: 'letter',
    orientation: 'auto',
    margin: 0.25,
    cal: { mode: 'part', size: 0.5 },
    layersOff: [],
    openFlip: [],
  };
}

export function defaultState() {
  const p = makePrinter('Office laser - transparency');
  return { settings: defaultSettings(), printers: [p], activePrinterId: p.id };
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function normalize(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const printers = Array.isArray(raw.printers) && raw.printers.length
    ? raw.printers.filter((p) => p && p.id && p.name && +p.cx > 0 && +p.cy > 0)
    : d.printers;
  const list = printers.length ? printers : d.printers;
  return {
    settings: merge(d.settings, raw.settings),
    printers: list,
    activePrinterId: list.some((p) => p.id === raw.activePrinterId) ? raw.activePrinterId : list[0].id,
  };
}

export function loadState() {
  try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultState(); }
}

export function saveState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

export function exportJson(state) {
  return JSON.stringify({ app: 'apw-comparator-overlay', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function importJson(text) {
  const raw = JSON.parse(text);
  if (raw.app !== 'apw-comparator-overlay') throw new Error('Not an APW Comparator Overlay settings file');
  return normalize(raw);
}

export function saveLastDxf(name, text) {
  try {
    if (text.length > MAX_DXF_CHARS) { localStorage.removeItem(DXF_KEY); return; }
    localStorage.setItem(DXF_KEY, JSON.stringify({ name, text }));
  } catch { /* quota: just don't remember it */ }
}

export function loadLastDxf() {
  try { return JSON.parse(localStorage.getItem(DXF_KEY)); } catch { return null; }
}
