// SVG preview of a composed sheet at true relative scale, with zoom and pan.
// Inches are SVG user units; y is flipped (sheet origin is bottom-left).

const NS = 'http://www.w3.org/2000/svg';

const STYLE = {
  outer: { stroke: '#0057A8', px: 1.4 },
  inner: { stroke: '#c62828', px: 1.4 },
  nominal: { stroke: '#333', px: 1 },
  calbox: { stroke: '#000', px: 1.2 },
};

const el = (name, attrs = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const f = (v) => +v.toFixed(5);

export function createPreview(svg) {
  let sheet = null;
  let view = null;
  let strokes = [];

  const pxPerIn = () => svg.clientWidth / view.w;

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const k = 1 / pxPerIn();
    for (const s of strokes) s.e.setAttribute('stroke-width', s.px * k);
  }

  function fit() {
    if (!sheet) return;
    const pad = 0.4;
    const aspect = svg.clientHeight / Math.max(1, svg.clientWidth);
    let w = sheet.w + 2 * pad, h = sheet.h + 2 * pad;
    if (h / w > aspect) w = h / aspect; else h = w * aspect;
    view = { x: sheet.w / 2 - w / 2, y: sheet.h / 2 - h / 2, w, h };
    applyView();
  }

  function render(next, { refit = false } = {}) {
    const sizeChanged = !sheet || sheet.w !== next.w || sheet.h !== next.h;
    sheet = next;
    svg.textContent = '';
    strokes = [];
    const H = sheet.h;
    const Y = (y) => f(H - y);
    const d = (subpaths) => subpaths.filter((sp) => sp.pts.length > 1)
      .map((sp) => 'M' + sp.pts.map(([x, y]) => `${f(x)} ${Y(y)}`).join('L') + (sp.closed ? 'Z' : '')).join('');

    svg.appendChild(el('rect', { x: 0, y: 0, width: sheet.w, height: sheet.h, fill: '#fff', class: 'sheet' }));
    const g = sheet.guides;
    if (g) {
      if (g.strip) svg.appendChild(el('rect', { x: g.strip.x0, y: Y(g.strip.y1), width: g.strip.x1 - g.strip.x0, height: g.strip.y1 - g.strip.y0, fill: '#eef3fa' }));
      const r = el('rect', { x: g.margin, y: g.margin, width: sheet.w - 2 * g.margin, height: sheet.h - 2 * g.margin, fill: 'none', stroke: '#7fb6e6', 'stroke-dasharray': '0.08 0.06' });
      svg.appendChild(r);
      strokes.push({ e: r, px: 1 });
    }
    for (const it of sheet.items) {
      if (it.kind === 'path') {
        const st = STYLE[it.role] || STYLE.nominal;
        const p = el('path', { d: d(it.subpaths), fill: 'none', stroke: st.stroke, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: `role-${it.role}` });
        if (it.dash) p.setAttribute('stroke-dasharray', it.dash.join(' '));
        svg.appendChild(p);
        strokes.push({ e: p, px: st.px });
      } else {
        const t = el('text', { x: f(it.x), y: Y(it.y), 'font-size': it.size / 72, 'font-family': 'Helvetica, Arial, sans-serif', 'font-weight': it.bold ? 700 : 400, fill: '#000' });
        t.textContent = it.text;
        svg.appendChild(t);
      }
    }
    if (refit || sizeChanged || !view) fit(); else applyView();
  }

  svg.addEventListener('wheel', (e) => {
    if (!view) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = view.x + ((e.clientX - r.left) / r.width) * view.w;
    const my = view.y + ((e.clientY - r.top) / r.height) * view.h;
    const z = Math.exp(Math.sign(e.deltaY) * 0.15);
    const w = Math.min(200, Math.max(0.01, view.w * z));
    const k = w / view.w;
    view = { x: mx - (mx - view.x) * k, y: my - (my - view.y) * k, w, h: view.h * k };
    applyView();
  }, { passive: false });

  let drag = null;
  svg.addEventListener('pointerdown', (e) => { if (view) { drag = { x: e.clientX, y: e.clientY, v: { ...view } }; svg.setPointerCapture(e.pointerId); } });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = view.w / svg.clientWidth;
    view = { ...drag.v, x: drag.v.x - (e.clientX - drag.x) * k, y: drag.v.y - (e.clientY - drag.y) * k };
    applyView();
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('dblclick', fit);
  new ResizeObserver(() => { if (sheet) fit(); }).observe(svg);

  return { render, fit };
}
