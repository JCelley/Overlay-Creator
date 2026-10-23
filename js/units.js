// Unit handling. Everything inside the tool is stored in INCHES; conversion
// happens only at input/display boundaries.

export const MM_PER_IN = 25.4;
export const PT_PER_IN = 72;

export function toIn(v, unit) { return unit === 'mm' ? v / MM_PER_IN : v; }
export function fromIn(v, unit) { return unit === 'mm' ? v * MM_PER_IN : v; }

// Decimal places that make sense for a display unit.
export function decimals(unit) { return unit === 'mm' ? 4 : 5; }

export function fmt(vIn, unit, places) {
  const p = places ?? decimals(unit);
  return fromIn(vIn, unit).toFixed(p);
}

export function fmtU(vIn, unit, places) { return `${fmt(vIn, unit, places)} ${unit}`; }

// DXF $INSUNITS code -> inches per drawing unit. null = unitless / unknown.
const INSUNITS = {
  1: { name: 'in', f: 1 },
  2: { name: 'ft', f: 12 },
  4: { name: 'mm', f: 1 / MM_PER_IN },
  5: { name: 'cm', f: 10 / MM_PER_IN },
  6: { name: 'm', f: 1000 / MM_PER_IN },
  8: { name: 'microinch', f: 1e-6 },
  9: { name: 'mil', f: 1e-3 },
  10: { name: 'yd', f: 36 },
  13: { name: 'micron', f: 1e-3 / MM_PER_IN },
  14: { name: 'dm', f: 100 / MM_PER_IN },
};

export function insunits(code) { return INSUNITS[code] || null; }
