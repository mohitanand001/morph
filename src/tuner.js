(function () {
// The design tuner for the window pill (only drawn when the app runs with
// FB_TUNE=1): a panel under the pill with a slider for every number, colour
// and font. Moves are sent as short actions (tn:/tc:/tr:), the app answers with
// ready-made style rules, so what you drag is the real pill.
const api = window.pill;
const host = document.getElementById('tuner');
if (!host) return;
const sheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null;
let builtGen = null;
let msgEl = null, countEl = null;
const openGroups = new Set(['Panel']);
const timers = {};

function send(a) { if (api) api.action(a); }
function later(key, a) { clearTimeout(timers[key]); timers[key] = setTimeout(() => send(a), 30); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function hexToHsl(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function range(min, max, step, value, onInput) {
  const r = document.createElement('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
  r.addEventListener('input', () => onInput(Number(r.value)));
  return r;
}

function knobRow(d, vals) {
  const cur = d.i in vals.byIdx ? vals.byIdx[d.i] : d.d;
  const row = el('div', 'tk');
  const head = el('div', 'tk-head');
  head.append(el('span', 'tk-label', d.l));
  const out = el('span', 'tk-val');
  const reset = el('button', 'tk-reset', '↺'); reset.type = 'button'; reset.title = 'Back to default';
  reset.addEventListener('click', () => send('tr:' + d.i));
  head.append(out, reset);
  row.append(head);
  if (d.t === 'col') {
    let [h, s, l] = hexToHsl(cur);
    const sw = el('span', 'tk-sw'); sw.style.backgroundColor = cur;
    const push = () => { sw.style.backgroundColor = ''; later('c' + d.i, 'tc:' + d.i + 'h' + h + 's' + s + 'l' + l); };
    out.textContent = cur; out.append(' ', sw);
    row.append(range(0, 360, 1, h, (v) => { h = v; push(); }), range(0, 100, 1, s, (v) => { s = v; push(); }), range(0, 100, 1, l, (v) => { l = v; push(); }));
  } else if (d.t === 'font') {
    const sel = document.createElement('select');
    d.o.forEach((name, i) => { const o = el('option', '', name); o.value = i; sel.append(o); });
    sel.value = cur;
    sel.addEventListener('change', () => send('tn:' + d.i + 'v' + Math.round(Number(sel.value) * 10)));
    out.textContent = d.o[cur] || '';
    row.append(sel);
  } else {
    out.textContent = cur;
    row.append(range(d.a, d.b, d.s, cur, (v) => { out.textContent = v; later('n' + d.i, 'tn:' + d.i + 'v' + Math.round(v * 10)); }));
  }
  return row;
}

function build(t) {
  host.textContent = '';
  const top = el('div', 'tn-top');
  top.append(el('span', 'tn-title', 'Design tuner'));
  countEl = el('span', 'tn-count');
  msgEl = el('span', 'tn-msg');
  const copy = el('button', 'tn-btn primary-ish', 'Copy all'); copy.type = 'button';
  copy.addEventListener('click', () => send('tcopy:'));
  const all = el('button', 'tn-btn', 'Reset all'); all.type = 'button';
  all.addEventListener('click', () => send('tr:all'));
  top.append(countEl, msgEl, copy, all);
  host.append(top);
  const hint = el('p', 'tn-hint', 'Tuned on Medium; Small and Large scale from it.');
  host.append(hint);
  const vals = { byIdx: t.byIdx || {} };
  const groups = [];
  t.defs.forEach((d) => { let g = groups.find((x) => x.name === d.g); if (!g) { g = { name: d.g, items: [] }; groups.push(g); } g.items.push(d); });
  groups.forEach((g) => {
    const det = document.createElement('details');
    det.open = openGroups.has(g.name);
    det.addEventListener('toggle', () => { if (det.open) openGroups.add(g.name); else openGroups.delete(g.name); });
    det.append(el('summary', '', g.name));
    g.items.forEach((d) => det.append(knobRow(d, vals)));
    host.append(det);
  });
}

function apply(t) {
  if (!t || !t.defs) { host.hidden = true; if (sheet) document.adoptedStyleSheets = []; return false; }
  host.hidden = false;
  if (sheet) { try { sheet.replaceSync(String(t.cssW || '')); document.adoptedStyleSheets = [sheet]; } catch (e) { /* bad rule: ignore */ } }
  if (builtGen !== t.gen || !host.firstChild) { builtGen = t.gen; build(t); }
  if (msgEl) msgEl.textContent = t.msg || '';
  if (countEl) countEl.textContent = t.count ? t.count + ' changed' : 'defaults';
  return true;
}
window.FBTuner = { apply };
})();
