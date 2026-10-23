// Minimal vector PDF writer (and reader for verification).
//
// Written by hand rather than via a library so every coordinate is under our
// control: 1 pt = 1/72 in, identity CTM, no page scaling, uncompressed
// content streams (so the output can be read back and checked).

import { PT_PER_IN } from './units.js';

const n = (v) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

function pdfString(str) {
  let out = '(';
  for (const ch of str) {
    let c = ch.codePointAt(0);
    // Map a few common symbols to WinAnsi; anything else unknown → '?'.
    const map = { 0x2212: 0x2d, 0x2013: 0x96, 0x2014: 0x97, 0x00d7: 0xd7, 0x00b1: 0xb1, 0x00b0: 0xb0, 0x00b5: 0xb5, 0x2192: 0x3e, 0x2190: 0x3c };
    if (map[c] !== undefined) c = map[c];
    if (c > 0xff) c = 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

function pageContent(sheet) {
  const ops = ['1 J 1 j 0 G 0 g'];
  for (const it of sheet.items) {
    if (it.kind === 'path') {
      const live = it.subpaths.filter((sp) => sp.pts.length >= 2);
      if (!live.length) continue;
      ops.push(`${n(it.width * PT_PER_IN)} w`);
      ops.push(it.dash ? `[${it.dash.map((d) => n(d * PT_PER_IN)).join(' ')}] 0 d` : '[] 0 d');
      for (const sp of live) {
        const [x0, y0] = sp.pts[0];
        ops.push(`${n(x0 * PT_PER_IN)} ${n(y0 * PT_PER_IN)} m`);
        for (let i = 1; i < sp.pts.length; i++) ops.push(`${n(sp.pts[i][0] * PT_PER_IN)} ${n(sp.pts[i][1] * PT_PER_IN)} l`);
        if (sp.closed) ops.push('h');
      }
      ops.push('S');
    } else if (it.kind === 'text') {
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${n(it.size)} Tf ${n(it.x * PT_PER_IN)} ${n(it.y * PT_PER_IN)} Td ${pdfString(it.text)} Tj ET`);
    }
  }
  return ops.join('\n');
}

/** Build a PDF from one or more sheets. Returns Uint8Array. */
export function buildPdf(sheets, meta = {}) {
  const objs = []; // index i ↔ object number i+1
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const sh of sheets) {
    const content = pageContent(sh);
    const cs = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const W = n(sh.w * PT_PER_IN), H = n(sh.h * PT_PER_IN);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /CropBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cs} 0 R >>`));
  }
  // PrintScaling /None asks viewers to default the print dialog to "Actual size".
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /ViewerPreferences << /PrintScaling /None >> >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(meta.title || 'APW Comparator Overlay')} /Producer (APW Comparator Overlay Tool) >>`);

  let out = '%PDF-1.6\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every char is ≤ 0xFF, so char offsets == byte offsets.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

/**
 * Read back a PDF produced by buildPdf: page sizes and stroked subpaths in points.
 * Used by tests to verify physical dimensions independently of the layout code.
 */
export function readPdf(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const pages = [];
  const pageRe = /\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[([^\]]+)\][^]*?\/Contents (\d+) 0 R/g;
  let mt;
  while ((mt = pageRe.exec(s))) {
    const box = mt[1].trim().split(/\s+/).map(Number);
    const objRe = new RegExp(`(?:^|\\n)${mt[2]} 0 obj\\n<< /Length (\\d+) >>\\nstream\\n`);
    const om = objRe.exec(s);
    const content = s.substr(om.index + om[0].length, +om[1]);
    const paths = [];
    let cur = null, width = 1, dash = [];
    const stack = [];
    for (const tok of content.replace(/\(([^)\\]|\\.)*\)/g, '()').split(/\s+/)) {
      if (tok === 'm') { cur = { pts: [[+stack[0], +stack[1]]], closed: false, width, dash }; paths.push(cur); stack.length = 0; }
      else if (tok === 'l') { cur.pts.push([+stack[0], +stack[1]]); stack.length = 0; }
      else if (tok === 'h') { cur.closed = true; }
      else if (tok === 'w') { width = +stack[0]; stack.length = 0; }
      else if (tok === 'd') { dash = stack.slice(0, -1).join(' ').replace(/[[\]]/g, '').trim().split(/\s+/).filter(Boolean).map(Number); stack.length = 0; }
      else if (/^[-\d.]+$/.test(tok) || tok.startsWith('[') || tok.endsWith(']')) stack.push(tok);
      else stack.length = 0;
    }
    pages.push({ width: box[2], height: box[3], paths });
  }
  return { pages };
}
