(function () {
// The window pill: draws the spec main.js sends (the same one the GNOME pill
// draws), reports clicks as "<verb>:<arg>", and tells main.js its size so the
// window is exactly as big as what it shows. Text is only ever set with
// textContent; colours are checked before use.
const api = window.pill;
const $ = (id) => document.getElementById(id);
const root = $('pill-root');
const panel = $('panel');
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ACTION_RE = /^[a-z]+:[a-z0-9]*$/;
const THEMES = ['sol-light', 'sol-dark', 'graphite', 'soft', 'compact', 'outline', 'light', 'midnight'];
const IDLE_MS = 12000;
const LEAVE_MS = 1500; // mouse gone this long: tuck away (clicks elsewhere can't be seen)
const BUSY_MAX_MS = 6000;
if (new URLSearchParams(location.search).get('solid') === '1') document.documentElement.classList.add('solid');

let spec = { visible: true, title: 'Morph', options: [] };
let busy = null; // { action, label }
let busyTimer = null;
let idleTimer = null;
let leaveTimer = null;
let collapseTimer = null;
let hovering = false;
let chipDragging = false;
let lastSize = '';
let maxH = 0;
let maxHKey = '';
let tuning = false;
let tuneFloor = 0;

const str = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max || 80);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
// Icons come from icons.js (Material Symbols for buttons, official marks for
// apps): never drawn by hand. Only that file's own markup is ever inserted.
const UI_NAME = { back: 'arrow_back', home: 'home', min: 'remove' };
function svgFrom(markup) {
  if (!markup) return document.createTextNode('');
  const doc = new DOMParser().parseFromString(markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}
function icon(name, size) {
  return svgFrom(window.FBI ? window.FBI.ui(UI_NAME[name] || name, size || 16) : '');
}
// An app's mark on a light tile (so dark marks like Notion read on dark themes).
function destIcon(id) {
  if (!window.FBI || !id || !window.FBI.DEST[id]) return null;
  const brand = window.FBI.isBrand(id);
  const t = el('span', 'dico' + (brand ? ' brand' : ''));
  t.appendChild(svgFrom(window.FBI.dest(id, 14)));
  return t;
}
function isOpen() { return root.dataset.open === 'true'; }

// ---------------------------------------------------------------- size
// One panel height for every page: it only ever grows to the tallest page
// shown (so nothing jumps), and starts from a floor set in CSS (--ph).
function fitHeight() {
  // As tall as what's showing; settings has its own fixed height (CSS).
  if (!isOpen()) return;
  panel.style.minHeight = tuneFloor ? tuneFloor + 'px' : '';
}
function reportSize() {
  requestAnimationFrame(() => {
    const r = (isOpen() ? panel : $('handle')).getBoundingClientRect();
    const tn = $('tuner');
    const tnR = isOpen() && tn && !tn.hidden ? tn.getBoundingClientRect() : null;
    const w = Math.ceil(r.width) + (tnR ? Math.ceil(tnR.width) : 0);
    const h = Math.max(Math.ceil(r.height), tnR ? Math.ceil(tnR.height) : 0);
    const key = w + 'x' + h + (isOpen() ? 'o' : 'c');
    if (key === lastSize) return;
    lastSize = key;
    if (api) api.size(w, h, isOpen());
  });
}

// ---------------------------------------------------------------- open / tuck
function setOpen(open) {
  if (isOpen() === open) return;
  root.dataset.open = String(open);
  $('handle').setAttribute('aria-expanded', String(open));
  if (open && api) api.action('opened:');
  clearTimeout(leaveTimer);
  armIdle();
  if (open) fitHeight();
  reportSize();
}
function armIdle() {
  clearTimeout(idleTimer);
  if (isOpen() && !tuning) idleTimer = setTimeout(() => { if (hovering) armIdle(); else setOpen(false); }, IDLE_MS);
}
root.addEventListener('mouseenter', () => { hovering = true; clearTimeout(leaveTimer); });
root.addEventListener('mouseleave', () => {
  hovering = false;
  armIdle();
  clearTimeout(leaveTimer);
  if (isOpen() && !dragging && !chipDragging && !tuning) leaveTimer = setTimeout(() => setOpen(false), LEAVE_MS);
});

// ---------------------------------------------------------------- dragging
// Press on the tab (or the ⋮⋮ grip) and move: the window follows; let go and
// it docks to the nearer edge. A press without moving opens the pill.
let press = null;
let dragging = false;
function pressStart(e, isHandle) {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, isHandle };
  dragging = false;
  try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
  e.preventDefault();
}
document.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    dragging = true;
    if (api) api.drag('start');
  }
  if (dragging && api) api.drag('move');
});
document.addEventListener('pointerup', () => {
  if (!press) return;
  const p = press;
  press = null;
  if (dragging) { dragging = false; if (api) api.drag('end'); return; }
  if (p.isHandle) setOpen(true);
});
// The tab: a blank clipboard (Material's outline) that gets scribbled on when
// something is copied. The lines draw themselves in, one after another.
const TAB_BOARD = 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h167q11-35 43-57.5t70-22.5q40 0 71.5 22.5T594-840h166q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560h-80v80q0 17-11.5 28.5T640-640H320q-17 0-28.5-11.5T280-680v-80h-80v560Zm280-560q17 0 28.5-11.5T520-800q0-17-11.5-28.5T480-840q-17 0-28.5 11.5T440-800q0 17 11.5 28.5T480-760Z';
const TAB_SCRIBBLE = ["M270 -525 q35 -42 70 0 t70 0 t70 0 t70 0 t70 0 t70 0", "M270 -415 q35 -42 70 0 t70 0 t70 0 t70 0 t70 0 t70 0", "M270 -305 q35 -42 70 0 t70 0 t70 0 t70 0"];
(function tabIcon() {
  const t = el('span', 'tabgl');
  const svg = svgFrom('<svg viewBox="0 -960 960 960" width="18" height="18"><path fill="currentColor" d="' + TAB_BOARD + '"/><g class="scribble" fill="none" stroke-width="46" stroke-linecap="round" stroke-linejoin="round">' +
    TAB_SCRIBBLE.map((d) => '<path pathLength="1" d="' + d + '"/>').join('') + '</g></svg>');
  t.appendChild(svg);
  $('handle').insertBefore(t, $('dot'));
})();
let tabCopyKey = '';
$('handle').addEventListener('pointerdown', (e) => pressStart(e, true));
$('handle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } });
// Quick mode: the first four apps sit under the clipboard, one click each.
const strip = el('span', 'strip');
$('handle').appendChild(strip);
function renderStrip(items) {
  strip.textContent = '';
  const list = Array.isArray(items) ? items.filter((o) => o && typeof o === 'object').slice(0, 4) : [];
  $('handle').classList.toggle('has-strip', list.length > 0);
  list.forEach((o) => {
    const b = el('button', 'sbtn' + (o.done ? ' done' : ''));
    b.type = 'button';
    b.title = (o.done ? 'Copied for ' : 'Copy for ') + str(o.label, 20);
    b.setAttribute('aria-label', b.title);
    if (o.done) { b.appendChild(glyph('check', 'sico')); b.disabled = true; }
    else { const di = destIcon(str(o.dest, 16)); if (di) b.appendChild(di); }
    if (o.off) { b.classList.add('off'); b.disabled = true; b.title = 'Copy something first'; }
    const act = ACT(o.action);
    b.addEventListener('pointerdown', (e) => e.stopPropagation()); // a press here is a click, never a drag
    b.addEventListener('click', (e) => { e.stopPropagation(); if (act && !o.off) { b.classList.add('busy'); send(act); } });
    strip.appendChild(b);
  });
}

// ---------------------------------------------------------------- buttons
function setBusy(action, label) {
  busy = { action, label };
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { busy = null; render(); }, BUSY_MAX_MS);
}
// o: { label, hint, action, color, busy, done, sw }
function makeButton(cls, o) {
  const b = el('button', 'btn ' + cls);
  b.type = 'button';
  const row = el('span', 'row');
  const di = !o.done && o.dest ? destIcon(str(o.dest, 16)) : null;
  if (di) row.appendChild(di);
  else if (o.color && COLOR_RE.test(o.color) && !o.done) {
    const d = el('span', 'kdot');
    d.style.backgroundColor = o.color;
    row.appendChild(d);
  }
  const label = el('span', 'label', str(o.label, 40));
  row.appendChild(label);
  if (o.hint) row.appendChild(el('span', 'hint', str(o.hint, 24)));
  if (o.sw) row.appendChild(el('span', 'sw' + (o.sw === 'on' ? ' on' : '')));
  b.appendChild(row);
  const action = str(o.action);
  if (o.done) { b.classList.add('done'); b.disabled = true; return b; }
  if (busy && busy.action === action) { b.classList.add('busy'); }
  if (action && ACTION_RE.test(action)) {
    b.addEventListener('click', () => {
      if (o.busy) { setBusy(action, str(o.busy, 40)); b.classList.add('busy'); }
      if (api) api.action(action);
      armIdle();
    });
  }
  return b;
}
// Apps pane: press a row and drag it; the others slide to make room. Let go
// and the app moves there ("dput:<from>t<to>").
function listDrag(e, rowEl, list) {
  if (e.button !== 0) return;
  e.preventDefault();
  const rows = [...list.children];
  const from = rows.indexOf(rowEl);
  const slots = rows.map((r) => ({ t: r.offsetTop - list.offsetTop, h: r.offsetHeight }));
  const pane = list.closest('.content');
  const r0 = rowEl.getBoundingClientRect();
  const offY = e.clientY - r0.top;
  const sy = e.clientY;
  let py = e.clientY;
  let float = null;
  let to = from;
  let timer = 0;
  // Rows slide out of the way as soon as the held one covers half of them.
  const place = () => {
    const pr = pane ? pane.getBoundingClientRect() : { top: -1e9, bottom: 1e9 };
    const top = Math.max(pr.top - r0.height / 2, Math.min(py - offY, pr.bottom - r0.height / 2));
    float.style.top = top + 'px';
    const ly = list.getBoundingClientRect().top;
    const fTop = top - ly;
    const fBot = fTop + r0.height;
    let t = from;
    for (let i = from + 1; i < slots.length; i++) if (fBot > slots[i].t + slots[i].h * 0.33) t = i;
    for (let i = from - 1; i >= 0; i--) if (fTop < slots[i].t + slots[i].h * 0.67) t = i;
    if (t === to) return;
    to = t;
    const order = rows.filter((r) => r !== rowEl);
    order.splice(to, 0, rowEl);
    order.forEach((r) => list.appendChild(r));
  };
  // Near the pane's top or bottom edge, it scrolls by itself.
  const edge = () => {
    if (!pane || !float) return;
    const pr = pane.getBoundingClientRect();
    const zone = 36;
    let d = 0;
    if (py < pr.top + zone) d = -Math.ceil((pr.top + zone - py) / 3);
    else if (py > pr.bottom - zone) d = Math.ceil((py - (pr.bottom - zone)) / 3);
    if (!d) return;
    const before = pane.scrollTop;
    pane.scrollTop += d;
    if (pane.scrollTop !== before) place();
  };
  const move = (ev) => {
    py = ev.clientY;
    if (!float) {
      if (Math.abs(py - sy) < 4) return;
      chipDragging = true;
      float = rowEl.cloneNode(true);
      float.classList.add('floating');
      float.style.width = r0.width + 'px';
      float.style.left = r0.left + 'px';
      root.appendChild(float);
      rowEl.classList.add('gap');
      timer = setInterval(edge, 30);
    }
    place();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    clearInterval(timer);
    if (float) float.remove();
    rowEl.classList.remove('gap');
    const moved = !!float;
    chipDragging = false;
    armIdle();
    if (moved && to !== from && api) api.action('dput:' + from + 't' + to);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- render
// Laid out like the design: a title bar (logo · Morph · gear · – ✕), a card
// saying what's on the clipboard, then one row per app. Settings swaps the body
// for a sidebar (General, Apps, Shortcuts, Size, About) and a pane.
const ACT = (a) => { const v = str(a); return ACTION_RE.test(v) ? v : ''; };
function send(a) { const v = ACT(a); if (v && api) api.action(v); armIdle(); }
function iconBtn(cls, name, title, onClick) {
  const b = el('button', 'btn ib ' + cls);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(icon(name, 18));
  b.addEventListener('click', onClick);
  return b;
}
function glyph(name, cls) {
  const t = el('span', cls || 'gl');
  t.appendChild(icon(name, 18));
  return t;
}
function toggle(on) {
  const t = el('span', 'sw' + (on ? ' on' : ''));
  t.setAttribute('aria-hidden', 'true');
  return t;
}
// One app row: mark, name, and (for the suggested one) a teal badge.
function appRow(o, primary) {
  const b = el('button', 'btn row ' + (primary ? 'primary' : 'option'));
  b.type = 'button';
  const label = el('span', 'label', str(o.label, 40));
  if (o.done) {
    b.classList.add('done');
    b.disabled = true;
    b.append(glyph('check', 'dico ok'), label);
    return b;
  }
  const di = o.dest ? destIcon(str(o.dest, 16)) : null;
  b.appendChild(di || glyph(/pdf/i.test(str(o.action)) ? 'description' : 'content_paste', 'dico'));
  b.appendChild(label);
  if (o.off) { b.classList.add('off'); b.disabled = true; b.title = 'Copy something first'; return b; }
  if (primary && !o.done && o.hint) b.appendChild(el('span', 'badge', str(o.hint, 24)));
  const action = ACT(o.action);
  if (busy && busy.action === action) { b.classList.add('busy'); }
  if (action) {
    b.addEventListener('click', () => {
      if (o.busy) { setBusy(action, str(o.busy, 40)); b.classList.add('busy'); }
      send(action);
    });
  }
  return b;
}
function renderBar(s, settingsView) {
  const bar = el('div', 'bar');
  bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) pressStart(e, false); });
  if (settingsView) bar.appendChild(iconBtn('back', 'arrow_back', 'Back', () => send(s.back || 'view:main')));
  else bar.appendChild(glyph('content_paste', 'logo'));
  bar.appendChild(el('span', 'title', settingsView ? str(s.title, 40) || 'Settings' : 'Morph'));
  bar.appendChild(el('span', 'spacer'));
  if (!settingsView && s.gear) bar.appendChild(iconBtn('gear', 'settings', 'Settings', () => send(s.gear)));
  const wc = el('div', 'controls');
  wc.append(
    iconBtn('tuck', 'remove', 'Tuck away', () => setOpen(false)),
    iconBtn('x', 'close', 'Close the pill (bring it back from the menu or Ctrl Alt F)', () => { setOpen(false); send('hide:'); }),
  );
  bar.appendChild(wc);
  return bar;
}
function renderMain(s, body) {
  const src = s.source && typeof s.source === 'object' ? s.source : { icon: 'content_paste', title: s.title, sub: '' };
  const card = el('div', 'source');
  // where it was copied from: that app's own mark (Slack, Jira…), else a plain clipboard/table glyph
  const logo = src.dest ? destIcon(str(src.dest, 16)) : null;
  if (logo) { const t = el('span', 'stile logo'); t.appendChild(logo); card.appendChild(t); }
  else card.appendChild(glyph(['table', 'content_paste', 'notes', 'description', 'image'].includes(src.icon) ? src.icon : 'content_paste', 'stile'));
  const meta = el('div', 'meta');
  meta.appendChild(el('b', 'src-title', str(src.title, 60)));
  if (src.sub) meta.appendChild(el('span', 'sub', str(src.sub, 160)));
  card.appendChild(meta);
  if (s.secondary && s.secondary.label && ACT(s.secondary.action)) {
    const act = ACT(s.secondary.action);
    const go = () => { if (s.secondary.busy) setBusy(act, str(s.secondary.busy, 40)); send(act); };
    // "Check again" is a refresh icon, so the title keeps its room.
    if (act === 'refresh:') card.appendChild(iconBtn('ghost-ib secondary', 'restart_alt', str(s.secondary.label, 40), go));
    else {
      const g = el('button', 'btn ghost secondary', str(s.secondary.label, 40));
      g.type = 'button';
      g.addEventListener('click', go);
      card.appendChild(g);
    }
  }
  body.appendChild(card);
  // What the app just said (copied, nothing there, …): its own line under the card.
  if (s.sub) body.appendChild(el('p', 'msg sub' + (s.subTone === 'ok' ? ' ok' : s.subTone === 'warn' ? ' warn' : ''), str(s.sub, 160)));
  if (s.note) body.appendChild(el('p', 'note', str(s.note, 90)));
  if (s.primary && s.primary.label) {
    const top = el('div', 'list top');
    const pr = appRow(s.primary, true);
    top.appendChild(pr);
    body.appendChild(top);
  }
  const list = el('div', 'list');
  const opts = [].concat(...(Array.isArray(s.options) ? s.options : []).filter(Array.isArray)).filter((o) => o && typeof o === 'object').slice(0, 14);
  opts.forEach((o) => list.appendChild(appRow(o, false)));
  // the copy as it was, before any fixing
  if (s.original && s.original.label && (s.original.done || ACT(s.original.action))) {
    const og = appRow({ label: str(s.original.label, 24), action: s.original.action, busy: s.original.busy, done: !!s.original.done }, false);
    og.classList.add('original');
    if (s.original.hint) og.appendChild(el('span', 'badge soft', str(s.original.hint, 24)));
    list.appendChild(og);
  }
  if (list.children.length) {
    body.appendChild(el('p', 'section', str(s.section, 60) || 'Copy it for'));
    body.appendChild(list);
  }
  if (Array.isArray(s.recent) && s.recent.length) {
    if (s.recentTitle) body.appendChild(el('p', 'section', str(s.recentTitle, 60)));
    const r = el('div', 'recent');
    s.recent.slice(0, 6).forEach((h) => { if (h && typeof h === 'object') r.appendChild(makeButton('', h)); });
    body.appendChild(r);
  }
}
let paneY = {}; // where each settings pane was scrolled to, so a switch or an added app doesn't send you back to the top
function renderSettings(s, body) {
  const wrap = el('div', 'settings');
  const side = el('nav', 'side');
  (Array.isArray(s.nav) ? s.nav : []).slice(0, 8).forEach((n) => {
    if (!n || typeof n !== 'object') return;
    const b = el('button', 'btn navitem' + (n.on ? ' on' : ''));
    b.type = 'button';
    b.append(glyph(str(n.icon, 20)), el('span', 'label', str(n.label, 20)));
    b.addEventListener('click', () => { paneY = {}; send(n.action); });
    side.appendChild(b);
  });
  const pane = el('div', 'content');
  const p = s.pane && typeof s.pane === 'object' ? s.pane : {};
  const paneKey = str(p.title, 40);
  pane.addEventListener('scroll', () => { paneY[paneKey] = pane.scrollTop; });
  pane.appendChild(el('h2', '', paneKey));
  if (p.lede) pane.appendChild(el('p', 'lede', str(p.lede, 120)));
  if (Array.isArray(p.opts)) p.opts.slice(0, 8).forEach((o) => {
    const b = el('button', 'btn opt');
    b.type = 'button';
    const t = el('span', 'ot');
    t.append(el('b', '', str(o.label, 50)), el('span', '', str(o.sub, 120)));
    b.append(glyph(str(o.icon, 24), 'oi'), t, toggle(o.sw === 'on'));
    b.addEventListener('click', () => send(o.action));
    pane.appendChild(b);
  });
  if (Array.isArray(p.apps)) {
    const apps = p.apps.slice(0, 14).filter((x) => x && typeof x === 'object');
    const shown = apps.filter((x) => x.sw === 'on');
    const hidden = apps.filter((x) => x.sw !== 'on');
    const row = (a, drag) => {
      const r = el('div', 'app-row' + (drag ? ' drag' : ' off'));
      const grip = drag ? glyph('drag_indicator', 'grip') : el('span', 'grip');
      const t = el('button', 'btn swbtn');
      t.type = 'button';
      t.title = (drag ? 'Hide ' : 'Show ') + str(a.label, 30);
      t.appendChild(toggle(drag));
      t.addEventListener('pointerdown', (e) => e.stopPropagation());
      t.addEventListener('click', () => send(a.action));
      r.append(grip, destIcon(str(a.dest, 16)) || glyph('content_paste', 'dico'), el('span', 'name', str(a.label, 30)), t);
      return r;
    };
    const ul = el('div', 'applist');
    shown.forEach((a) => {
      const r = row(a, true);
      r.addEventListener('pointerdown', (e) => listDrag(e, r, ul));
      ul.appendChild(r);
    });
    pane.appendChild(ul);
    if (hidden.length) {
      pane.appendChild(el('p', 'subhead', 'Hidden'));
      const hl = el('div', 'applist');
      hidden.forEach((a) => hl.appendChild(row(a, false)));
      pane.appendChild(hl);
    }
  }
  if (Array.isArray(p.keys)) p.keys.slice(0, 10).forEach((k) => {
    const b = el('button', 'btn sc');
    b.type = 'button';
    const lbl = el('span', 'ot');
    lbl.appendChild(el('b', '', str(k.label, 50)));
    const keys = el('span', 'keys');
    (Array.isArray(k.keys) ? k.keys : []).slice(0, 5).forEach((x) => keys.appendChild(el('kbd', '', str(x, 8))));
    lbl.appendChild(keys);
    if (k.note) lbl.appendChild(el('span', 'warn', str(k.note, 40)));
    b.append(glyph(str(k.icon, 24), 'oi'), lbl, toggle(k.sw === 'on'));
    b.addEventListener('click', () => send(k.action));
    pane.appendChild(b);
  });
  if (Array.isArray(p.cards)) {
    const cards = el('div', 'cards c' + Math.min(3, p.cards.length));
    p.cards.slice(0, 3).forEach((c) => {
      const b = el('button', 'btn card' + (c.on ? ' on' : ''));
      b.type = 'button';
      let sw;
      if (c.size) { sw = el('span', 'wg-holder'); const wg = el('span', 'wg wg-' + str(c.size, 1)); wg.appendChild(el('span', 'wg-bar')); sw.appendChild(wg); } else sw = el('span', 'swatch look-' + str(c.look, 12));
      b.append(sw, el('span', 'cl', str(c.label, 20)));
      if (c.sub) b.appendChild(el('span', 'cs', str(c.sub, 30)));
      b.addEventListener('click', () => send(c.action));
      cards.appendChild(b);
    });
    pane.appendChild(cards);
  }
  if (p.about && typeof p.about === 'object') {
    const hero = el('div', 'hero');
    const ht = el('div', '');
    ht.append(el('b', '', str(p.about.name, 30)), el('span', '', str(p.about.version, 60)));
    hero.append(glyph('content_paste', 'logo big'), ht);
    pane.append(hero, el('p', 'about-text', str(p.about.text, 300)), el('p', 'about-legal', str(p.about.legal, 400)));
  }
  wrap.append(side, pane);
  body.appendChild(wrap);
  requestAnimationFrame(() => { pane.scrollTop = paneY[paneKey] || 0; });
}
let mainY = 0; // where the main app list was scrolled to, so clicking a row near the bottom doesn't send it to the top
function render() {
  const s = spec;
  const theme = THEMES.includes(s.theme) ? s.theme : 'sol-light';
  const size = ['s', 'm', 'l'].includes(s.size) ? s.size : 'm';
  const side = s.side === 'l' ? 'l' : 'r';
  const settingsView = s.view === 'settings';
  root.className = 'pill theme-' + theme + ' size-' + size + ' side-' + side + (settingsView ? ' view-settings' : '');

  // scribble the board when there's something copied; scribble again for each new copy
  const copied = s.dot === 'has' || s.dot === 'ok';
  const key = copied ? JSON.stringify([s.copyId || 0, s.source && s.source.title, s.source && s.source.sub, s.title]) : '';
  if (copied && key !== tabCopyKey && root.classList.contains('copied')) { root.classList.remove('copied'); void root.offsetWidth; }
  root.classList.toggle('copied', copied);
  tabCopyKey = key;
  renderStrip(s.tab);
  const dot = $('dot');
  dot.className = 'dot' + (s.dot === 'has' ? ' has' : s.dot === 'ok' ? ' ok' : '');
  dot.style.backgroundColor = s.dot === 'has' && COLOR_RE.test(s.handleColor || '') && !/^sol-/.test(theme) ? s.handleColor : '';

  panel.textContent = '';
  panel.appendChild(renderBar(s, settingsView));
  const body = el('div', 'body');
  // Smaller sizes show fewer rows and scroll the rest
  const cap = ({ s: 250, m: 330, l: 420 })[s.size] || 330;
  body.style.maxHeight = Math.min(cap, Math.max(200, Math.floor(((window.screen && window.screen.availHeight) || 800) * 0.8 - 80))) + 'px';
  panel.appendChild(body);
  if (settingsView) renderSettings(s, body); else {
    renderMain(s, body);
    body.scrollTop = mainY;
    body.addEventListener('scroll', () => { mainY = body.scrollTop; });
  }
  if (Array.isArray(s.links) && s.links.length) {
    const foot = el('div', 'foot');
    s.links.slice(0, 4).forEach((l) => { if (l && typeof l === 'object') foot.appendChild(makeButton('link', l)); });
    panel.appendChild(foot);
  }
  fitHeight();
  reportSize();
}

function applySpec(next) {
  if (!next || typeof next !== 'object') return;
  spec = next;
  tuning = !!(window.FBTuner && window.FBTuner.apply(spec.tune));
  if (tuning) {
    const f = Math.round(Number(spec.tune.minH) || 0);
    if (f !== tuneFloor) { tuneFloor = f; maxH = 0; }
    root.style.setProperty('--ph', f + 'px');
  } else if (tuneFloor) { tuneFloor = 0; root.style.removeProperty('--ph'); }
  if (spec.settled) { busy = null; clearTimeout(busyTimer); }
  render();
  if (spec.openNow && !isOpen()) setOpen(true);
  if (spec.collapseAfterMs && isOpen() && !tuning) {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => { if (tuning && hovering) return; setOpen(false); }, Math.min(Number(spec.collapseAfterMs) || 1800, 10000));
  }
}

if (window.ResizeObserver && $('tuner')) new ResizeObserver(() => reportSize()).observe($('tuner'));
if (api) {
  api.onSpec(applySpec);
  api.onCollapse(() => { if (!hovering && !tuning) setOpen(false); });
  api.onToggle(() => setOpen(!isOpen()));
}
window.__pillApply = applySpec; // for tests (no bridge there)
render();
})();
