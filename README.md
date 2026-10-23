# APW Comparator Overlay Tool

A browser tool that makes true-scale, magnified profile overlays for an optical comparator. You load a DXF, set the magnification and tolerance, export a vector PDF, and print it on transparency film. When the operator lays the film on the comparator screen, the part's shadow has to fall between the two solid limit lines.

It's a static site with no build step and no backend. It runs on GitHub Pages next to the other APW tools.

**Status: Phase 1 (DXF overlay MVP).** Phase 2 (tiling, label block, registration marks, ruler, mirror/rotate, saved jobs) and Phase 3 (STEP silhouette) are not built yet.

## Using it

1. Open `index.html` from GitHub Pages, or run it locally (see below).
2. Drop a DXF on the page. The units come from `$INSUNITS`. If the file has no units, the tool uses the unit you pick under "If the DXF has no units".
3. Set the magnification, the tolerance type and value, and the line widths.
4. **Calibrate once per printer and media.** Download the calibration sheet and print it at 100%. Measure the box across its **outside edges** in X and Y, enter both numbers, then click **Apply correction**. Reprint and use **Verify only** to confirm. Verify reports the deviation and leaves the stored correction alone unless you accept it.
5. Click **Export overlay PDF** and print it at **100% / Actual size**. Turn off "Fit to page" and "Shrink oversized pages".

Settings and printer profiles are kept in this browser's localStorage. Use **Export JSON** to back them up.

## Running locally

ES modules need `http://`, so opening the file directly (`file://`) won't work. Start the included PowerShell server:

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

Then open http://localhost:8137/. The tests are at http://localhost:8137/tests/.

## How accuracy is protected

| Stage | What happens |
|---|---|
| DXF read | Lines, arcs, and NURBS splines stay exact until they have to become points. Bulges, OCS mirroring (extrusion 0,0,-1), and INSERT transforms are handled exactly. |
| Discretization | `CHORD_TOL = 0.00001 in` at part scale (`js/geom.js`) is the maximum chord-height error for any curve. Arcs are split at quadrant angles, so their X/Y extremes are exact vertices. |
| Offsetting | Clipper with integer coordinates at 1e-7 in resolution and round joins (arc tolerance = `CHORD_TOL`). Outward corners round, inward self-intersections are removed, and holes shrink when the part grows. |
| Layout | Geometry is scaled by the magnification and placed in printed inches. The printer correction is applied per axis to every coordinate (profile, limits, box, text positions). Line widths are not scaled. |
| PDF | A hand-written PDF with 1 pt = 1/72 in, an identity transform, 4-decimal coordinates (≤ 1.4 µin printed), and uncompressed content so it can be read back. `/PrintScaling /None` is set so viewers default to actual size. |
| Verification | `tests/` holds the DXF parsing tests (arcs and bulges), unit tests, offset tests for every tolerance type (sharp corners, holes, slot filling), calibration math, and golden PDF read-back. For example, a 1.000 in square must come out at exactly 720 pt at 10×. |

**Calibration box:** the box is drawn with the current correction already applied, so a new measurement refines the correction: `new = current × expected / measured`. The stroke is inset so that the outside edge of the printed line equals the nominal size. That's the edge you measure with calipers.

**Line width:** each limit line is centered on its limit, so half the line sits inside the tolerance zone. The UI shows the printed width converted to part scale and as a percentage of the zone.

## Known accuracy limits

The digital geometry is effectively exact. The remaining error comes from the physical print:

- **Printer resolution:** about 0.0017 in per dot at 600 dpi. A hairline is one dot wide.
- **Toner spread:** lines print slightly wider than specified. Calibrate with the same media you use for overlays.
- **Film stability:** transparency film can shrink or grow with fuser heat and humidity. Recalibrate when you change media, and measure the box on each critical overlay.
- **Feed error:** scale along the paper feed (Y) can differ from scale across it (X). That's why X and Y are corrected separately.

## Layout

```
index.html        UI
css/app.css       APW styles
js/units.js       in/mm, $INSUNITS
js/geom.js        exact curves, NURBS, CHORD_TOL discretization
js/dxf.js         DXF reader
js/chain.js       endpoint chaining → profiles
js/tolerance.js   tolerance types, Clipper offsets (closed + open)
js/calibration.js correction math, printer profiles
js/layout.js      sheet composition (shared by preview and PDF)
js/pdf.js         PDF writer + reader
js/preview.js     SVG preview
js/storage.js     localStorage, JSON export/import
tests/            browser test suite
samples/          sample DXFs
tools/serve.ps1   local static server
```

## Phase 1 limitations

- Geometry that doesn't fit the sheet is reported but not tiled (tiling is Phase 2).
- Open profiles get one-sided offsets. Use the "flip + side" checkboxes to choose which side counts as outside.
- SPLINEs defined only by fit points (no control points) are joined with straight segments between the fit points, and a warning is shown.
- The default calibration box (0.500 in at part scale) is 5 in at 10×, which often won't fit next to a large profile on Letter paper. Switch to a fixed printed size, or use a larger sheet.
