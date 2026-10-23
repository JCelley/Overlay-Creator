// Printer calibration math and printer profiles.
//
// Every sheet carries a calibration box. The box is drawn with the CURRENT
// correction already applied, so after measuring a print:
//   printerScale = measured / (expected · currentCorrection)
//   newCorrection = 1 / printerScale = currentCorrection · expected / measured
// For an uncorrected print (correction = 1) this is the textbook
// correction = expected / measured.

export const BOX_LINE_W = 0.01; // in, printed. Box path is inset so the OUTSIDE edges equal nominal.

/** Printed (magnified) size of the calibration box, inches. */
export function calBoxPrintedSize(cal, mag) {
  return cal.mode === 'part' ? cal.size * mag : cal.size;
}

export function newCorrection(current, expected, measured) {
  if (!(measured > 0) || !(expected > 0)) throw new Error('Measured and expected sizes must be positive');
  return current * expected / measured;
}

/** Verify-mode report: how far a print is from nominal (no change to the profile). */
export function deviation(expected, measured) {
  const err = measured - expected;
  return { err, pct: (err / expected) * 100, ppm: (err / expected) * 1e6 };
}

export function makePrinter(name) {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    cx: 1,
    cy: 1,
    calibratedAt: null,
    history: [],
  };
}

/** Apply a measurement to a printer profile; returns the updated profile. */
export function applyMeasurement(printer, expected, measuredX, measuredY, when = new Date()) {
  const cx = newCorrection(printer.cx, expected, measuredX);
  const cy = newCorrection(printer.cy, expected, measuredY);
  return {
    ...printer,
    cx, cy,
    calibratedAt: when.toISOString(),
    history: [...(printer.history || []), {
      at: when.toISOString(), expected, measuredX, measuredY, prevCx: printer.cx, prevCy: printer.cy, cx, cy,
    }].slice(-20),
  };
}
