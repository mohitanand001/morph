(function () {
// Format Bridge app window. Runs the same in the desktop app (where
// window.bridge reads and writes the system clipboard) and in a plain
// browser tab (paste with Ctrl+V, copy with the Copy button).
const $ = (id) => document.getElementById(id);
const bridge = window.bridge || null;
const IS_MAC = (bridge ? bridge.platform === 'darwin' : /Mac/.test(navigator.platform));
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const COMPANION = new URLSearchParams(location.search).get('mode') === 'companion';
if (COMPANION) document.body.classList.add('companion');

const DESTS = {
  slack: { name: 'Slack', sub: 'Paste into a Slack message box (desktop or web).' },
  jira: { name: 'Jira', sub: 'Paste into a Jira description or comment.' },
  confluence: { name: 'Confluence', sub: 'Paste into a Confluence page while editing.' },
  email: { name: 'Email', sub: 'Gmail, Outlook (desktop, web, Mac) and Apple Mail.' },
  gdocs: { name: 'Google Docs', sub: 'Paste into a Google Doc.' },
  markdown: { name: 'Markdown', sub: 'GitHub, Claude, ChatGPT, Cursor, and anything that reads markdown.' },
  text: { name: 'Plain text', sub: 'Terminals, commit messages and plain text boxes. No formatting at all.' },
  notion: { name: 'Notion', sub: 'Paste into a Notion page: headings, lists, tables and code become Notion blocks.' },
  linear: { name: 'Linear', sub: 'Paste into a Linear issue or comment, as markdown.' },
  teams: { name: 'Teams', sub: 'Paste into a Microsoft Teams message.' },
};
const TEXT_SOURCES = new Set(['markdown', 'slack-mrkdwn', 'plain-text', 'code', 'log', 'terminal', 'pdf']);
const LIST_REPAIR_SOURCES = new Set(['markdown', 'slack-mrkdwn', 'plain-text']);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

const state = {
  html: '',
  text: '',
  source: 'plain-text',
  how: 'text',
  dest: store.get('fb.dest', 'slack'),
  ast: { type: 'doc', children: [] },
  repairs: [],
  clip: null, // last inspector snapshot
  lastClipKey: '',
  ownKey: '', // what our last copy put on the clipboard
  context: null, // where it was copied from (desktop app only)
  linkBack: false,
};
if (!DESTS[state.dest]) state.dest = 'slack';

const input = $('input-box');
const sourceSelect = $('source-select');
const preview = $('preview');
const changes = $('changes');
const copyBtn = $('copy-btn');
const copyLabel = $('copy-label');
const statusEl = $('status');
const dests = Array.from(document.querySelectorAll('.dest'));

document.querySelectorAll('kbd.mod').forEach((k) => { k.textContent = MOD; });

// ---------------------------------------------------------------- intake
function setStatus(msg, bad) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('bad', !!bad);
}

function take(html, text, how, snapshot) {
  state.html = html || '';
  state.text = text || '';
  input.textContent = state.text;
  const det = FB.engine.detect(state.html, state.text, state.context);
  state.source = det.source;
  state.how = how || det.how;
  if (snapshot) setInspector(snapshot);
  convert();
}

// Paste anywhere in the window (both desktop and browser).
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  if (e.target && e.target.closest && e.target.closest('select, input')) return;
  e.preventDefault();
  const snap = { formats: Array.from(cd.types || []), text: cd.getData('text/plain'), html: cd.getData('text/html'), rtf: '', image: null, others: [] };
  snap.formats.forEach((t) => {
    if (['text/plain', 'text/html', 'Files'].includes(t)) return;
    let v = '';
    try { v = cd.getData(t); } catch (err) { /* ignore */ }
    snap.others.push({ format: t, bytes: v.length, text: v, hex: null });
  });
  state.context = null;
  take(snap.html, snap.text, null, snap);
  setStatus('');
});

input.addEventListener('input', () => {
  state.html = '';
  state.text = input.textContent;
  const det = FB.detectSource('', state.text);
  if (state.how !== 'manual') { state.source = det.source; state.how = det.how; }
  convert();
});

sourceSelect.addEventListener('change', () => {
  state.source = sourceSelect.value;
  state.how = 'manual';
  convert();
});

$('clear-btn').addEventListener('click', () => {
  state.html = '';
  state.text = '';
  input.textContent = '';
  state.ast = { type: 'doc', children: [] };
  state.repairs = [];
  setInspector(null);
  store.del('fb.last');
  render();
  setStatus('');
  input.focus();
});

// ---------------------------------------------------------------- desktop clipboard
const clipKey = (c) => (c.formats || []).join(',') + '|' + (c.html || '').length + '|' + (c.text || '');

async function readSystemClipboard(reason) {
  if (!bridge) return null;
  let clip;
  try { clip = await bridge.readClipboard(); } catch (e) { setStatus('Couldn’t read the clipboard.', true); return null; }
  if (clip.secret) {
    if (reason === 'button') setStatus('Skipped: a password manager marked that copy as secret.');
    return null;
  }
  const key = clipKey(clip);
  // The clipboard still holds our own conversion: convert again from the
  // original you copied, not from our output.
  if (reason === 'quick' && key === state.ownKey && hasContent()) return clip;
  // Opening the popover or a background change with the same content must
  // not throw away anything you edited.
  if (reason !== 'button' && reason !== 'quick' && key === state.lastClipKey) return clip;
  state.lastClipKey = key;
  if (!clip.text && !clip.html) {
    // An image (or nothing): there is no text to convert, so the pill must not keep offering the last copy.
    if (bridge && bridge.setTrayStatus) bridge.setTrayStatus(clip.image ? 'Nothing to convert: the clipboard holds an image' : 'Nothing to convert');
    setInspector(clip);
    if (reason === 'button' || reason === 'quick') setStatus(clip.image ? 'The clipboard holds an image only. See the inspector.' : 'The clipboard is empty.');
    return clip;
  }
  state.context = clip.context && clip.context.label ? clip.context : null;
  state.linkBack = !!clip.linkBack;
  take(clip.html, clip.text, null, clip);
  remember(clip);
  if (reason === 'button') setStatus('');
  return clip;
}

// ---------------------------------------------------------------- recent copies
// The last few things you copied, kept in memory only (never written to
// disk), so the pill can paste an earlier one.
const HISTORY_MAX = 6;
let history = [];
let historySeq = 0;
function historyLabel(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || '';
  return line.length > 38 ? line.slice(0, 37) + '…' : line;
}
function remember(clip) {
  if (!bridge || !hasContent()) return;
  const key = clipKey(clip);
  history = history.filter((h) => h.key !== key);
  history.unshift({
    id: ++historySeq, key, html: clip.html || '', text: clip.text || '',
    label: historyLabel(clip.text) || FB.astStats(state.ast).summary || 'Copied content',
    context: state.context,
    from: FB.SOURCES[state.source] || 'Text', at: Date.now(),
  });
  history = history.slice(0, HISTORY_MAX);
  sendHistory();
}
function sendHistory() {
  if (bridge && bridge.setHistory) bridge.setHistory(history.slice(1).map((h) => ({ id: h.id, label: h.label, from: h.from, at: h.at })));
}
// Use an earlier copy: convert it for dest, or put the original back.
async function useHistory(id, dest) {
  const h = id ? history.find((x) => x.id === id) : history[0]; // 0: the copy on the clipboard now
  if (!h) { bridge.quickDone({ ok: false }); return; }
  state.context = h.context || null;
  take(h.html, h.text, null, null);
  state.lastClipKey = h.key;
  history = [h].concat(history.filter((x) => x !== h));
  sendHistory();
  if (dest && DESTS[dest]) {
    selectDest(dest);
    const ok = await copy();
    bridge.quickDone({ ok: !!ok, name: DESTS[dest].name });
    return;
  }
  try {
    await bridge.writeClipboard({ html: h.html, text: h.text });
    const c = await bridge.readClipboard();
    state.lastClipKey = state.ownKey = clipKey(c);
    bridge.quickDone({ ok: true, name: 'your clipboard', restored: true });
  } catch (e) { bridge.quickDone({ ok: false }); }
}
// ---------------------------------------------------------------- Save as PDF
// The content as a clean, printable page (the email-style HTML: simple,
// inline-styled, tables and code kept), handed to the app to print.
function pdfTitle() { return FB.engine.pdfTitle(state.ast); }
async function savePdf(fromPill) {
  if (!bridge || !bridge.savePdf) return false;
  if (fromPill) await readSystemClipboard('quick');
  if (!hasContent()) { if (fromPill) bridge.pdfDone({ ok: false }); else setStatus('Nothing to save yet.', true); return false; }
  const ast = withSourceLink(FB.applyPeople(state.ast, state.people || {}), 'email');
  const r = await bridge.savePdf({ html: FB.astToEmailHtml(ast), title: pdfTitle() });
  if (!fromPill) setStatus(r && r.ok ? 'Saved ' + r.name + ' in ' + r.folder + '.' : 'Couldn’t save the PDF.', !(r && r.ok));
  return !!(r && r.ok);
}

function clearHistory() {
  history = history.slice(0, 1);
  sendHistory();
}

// Tray menu: convert whatever is on the clipboard for a destination and put
// the result back, without needing the window.
async function quickConvert(dest) {
  const clip = await readSystemClipboard('quick');
  if (!clip || (!clip.text && !clip.html) || !hasContent()) { bridge.quickDone({ ok: false }); return; }
  selectDest(dest);
  const ok = await copy();
  bridge.quickDone({ ok: !!ok, name: DESTS[dest].name, summary: (FB.SOURCES[state.source] || 'Clipboard') + ': ' + (FB.astStats(state.ast).summary || 'text') });
}

if (bridge) {
  $('read-btn').hidden = false;
  $('read-btn').addEventListener('click', () => readSystemClipboard('button'));
  if (bridge.onShown) bridge.onShown(() => readSystemClipboard('shown'));
  if (bridge.onClipboardChange) bridge.onClipboardChange(() => readSystemClipboard('watch'));
  if (bridge.onQuickConvert) bridge.onQuickConvert((d) => { if (DESTS[d]) quickConvert(d); });
  if (bridge.onUseHistory) bridge.onUseHistory((id, d) => useHistory(id, DESTS[d] ? d : null));
  if (bridge.onClearHistory) bridge.onClearHistory(() => clearHistory());
  if (bridge.onMakePdf) bridge.onMakePdf(() => savePdf(true));
  if (bridge.savePdf) {
    $('pdf-btn').hidden = false;
    $('pdf-btn').addEventListener('click', () => savePdf(false));
  }
  if (bridge.onSelect) bridge.onSelect((d) => { if (DESTS[d]) selectDest(d); });
  if (COMPANION && bridge.getSettings) {
    bridge.getSettings().then((st) => { state.people = (st && st.people) || {}; applyTheme(st && st.theme); }).catch(() => {});
    $('apps-btn').hidden = false;
    $('apps-btn').addEventListener('click', () => openApps(true));
    if (bridge.onApps) bridge.onApps(() => openApps(true));
  }
  if (COMPANION && bridge.hide) {
    $('hide-btn').hidden = false;
    $('hide-btn').addEventListener('click', () => bridge.hide());
  }
  bridge.info().then((i) => {
    $('ver').textContent = 'v' + i.version;
    $('about-ver').textContent = 'v' + i.version;
    if (i.shortcut) $('empty-sub').textContent = 'Copy anything. ' + i.shortcut.replace('CommandOrControl', MOD).replace(/\+/g, ' ') + ' opens this from anywhere, and the tray menu converts the clipboard without opening it.';
  }).catch(() => {});
  $('empty-title').textContent = 'Copy something, and it shows up here';
} else {
  $('empty-title').textContent = 'Paste here with ' + MOD + ' V';
}

// ---------------------------------------------------------------- apps panel (pill rules)
const DEST_SHORT = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Docs', markdown: 'Markdown', text: 'Text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
let appSettings = null;

// The window follows the chosen look: Solarized Light or Dark (older looks fall back to the system setting).
function applyTheme(t) {
  const el = document.documentElement;
  if (t === 'sol-dark' || t === 'sol-light') el.dataset.theme = t === 'sol-dark' ? 'dark' : 'light';
  else delete el.dataset.theme;
}
const ico = (name, size) => (window.FBI ? window.FBI.ui(name, size || 18) : '');
function showPane(id) {
  document.querySelectorAll('.snav-btn').forEach((b) => {
    const on = b.dataset.pane === id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.spane').forEach((p) => { p.hidden = p.id !== 'spane-' + id; });
  $('spanes').scrollTop = 0;
}
document.querySelectorAll('.snav-btn').forEach((b) => {
  b.insertAdjacentHTML('afterbegin', ico(b.dataset.icon, 18));
  b.addEventListener('click', () => showPane(b.dataset.pane));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...document.querySelectorAll('.snav-btn')];
    const next = all[(all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    showPane(next.dataset.pane); next.focus(); e.preventDefault();
  });
});

async function openApps(open) {
  document.body.classList.toggle('apps-open', open);
  $('apps-panel').hidden = !open;
  if (!open) return;
  showPane('general');
  appSettings = await bridge.getSettings();
  renderApps();
  renderPeople();
}
// Names from the current copy first, then everyone saved.
function renderPeople() {
  const ul = $('people');
  const saved = (appSettings && appSettings.people) || {};
  const names = FB.collectMentions(state.ast || { children: [] });
  const keys = names.map((n) => FB.mentionKey(n));
  const rows = names.map((n) => [n, saved[FB.mentionKey(n)] || ''])
    .concat(Object.keys(saved).filter((k) => !keys.includes(k)).map((k) => [k, saved[k]]));
  ul.textContent = '';
  $('people-block').hidden = !rows.length;
  rows.forEach(([name, mail]) => {
    const li = document.createElement('li');
    const lab = document.createElement('span'); lab.textContent = '@' + name;
    const inp = document.createElement('input'); inp.type = 'email'; inp.placeholder = 'name@company.com'; inp.value = mail; inp.maxLength = 120;
    inp.addEventListener('change', async () => {
      const v = inp.value.trim();
      const next = Object.assign({}, appSettings.people || {});
      if (!v) delete next[FB.mentionKey(name)];
      else if (FB.EMAIL_RE.test(v)) next[FB.mentionKey(name)] = v;
      else { inp.setCustomValidity('Not an email'); inp.reportValidity(); return; }
      inp.setCustomValidity('');
      appSettings.people = next; state.people = next;
      await bridge.setSettings({ people: next });
      render();
    });
    li.append(lab, inp); ul.append(li);
  });
}
$('apps-done').addEventListener('click', () => openApps(false));

function saveApps() {
  const order = appSettings.pillDestsOrder;
  delete appSettings.pillDestsOrder; // sent once, so the pill's own reordering isn't overwritten later
  state.linkBack = !!appSettings.linkBack;
  render();
  // Shortcuts are applied a moment later; then show any GNOME refused.
  setTimeout(async () => {
    if ($('apps-panel').hidden || !bridge.getSettings) return;
    if (document.querySelector('.kbtn.rec')) return; // you're typing a new key: don't redraw under you
    try { const fresh = await bridge.getSettings(); appSettings.shortcuts = fresh.shortcuts; renderKeys(); } catch (e) { /* closed */ }
  }, 700);
  return bridge.setSettings({ rules: appSettings.rules, pillMode: appSettings.pillMode, pillEnabled: appSettings.pillEnabled, autoFormat: !!appSettings.autoFormat, linkBack: !!appSettings.linkBack, theme: appSettings.theme, size: appSettings.size, shortcuts: appSettings.shortcuts, pillDests: appSettings.pillDests, pillDestsOrder: order });
}

// Apps pane: the pill's apps in the order it shows them. Drag a row, or use the arrows.
function destOrder() {
  const on = (appSettings.pillDests && appSettings.pillDests.length ? appSettings.pillDests : Object.keys(DEST_SHORT)).filter((d) => DEST_SHORT[d]);
  return on.concat(Object.keys(DEST_SHORT).filter((d) => !on.includes(d)));
}
function renderDests() {
  const pd = $('pill-dests');
  const order = destOrder();
  const enabled = new Set((appSettings.pillDests && appSettings.pillDests.length ? appSettings.pillDests : Object.keys(DEST_SHORT)));
  pd.textContent = '';
  const commit = (next) => {
    appSettings.pillDests = next.filter((d) => enabled.has(d));
    appSettings.pillDestsOrder = appSettings.pillDests.slice();
    saveApps();
    renderDests();
  };
  let dragFrom = -1;
  order.forEach((k, i) => {
    const li = document.createElement('li');
    li.className = 'drow' + (enabled.has(k) ? '' : ' off');
    li.draggable = true;
    li.dataset.dest = k;
    const grip = document.createElement('span'); grip.className = 'grip'; grip.innerHTML = ico('drag_indicator', 18); grip.setAttribute('aria-hidden', 'true');
    const tile = document.createElement('span'); tile.className = 'dtile' + (window.FBI && window.FBI.isBrand(k) ? ' brand' : ''); tile.innerHTML = window.FBI ? window.FBI.dest(k, 16) : '';
    const nm = document.createElement('span'); nm.className = 'dname'; nm.textContent = DEST_SHORT[k];
    const up = document.createElement('button'); up.type = 'button'; up.className = 'dmove'; up.innerHTML = ico('expand_less', 18); up.setAttribute('aria-label', 'Move ' + DEST_SHORT[k] + ' up'); up.disabled = i === 0;
    const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'dmove'; dn.innerHTML = ico('expand_more', 18); dn.setAttribute('aria-label', 'Move ' + DEST_SHORT[k] + ' down'); dn.disabled = i === order.length - 1;
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = enabled.has(k); c.setAttribute('aria-label', 'Show ' + DEST_SHORT[k] + ' in the pill');
    const move = (from, to) => { const n = order.slice(); const [x] = n.splice(from, 1); n.splice(to, 0, x); commit(n); };
    up.addEventListener('click', () => move(i, i - 1));
    dn.addEventListener('click', () => move(i, i + 1));
    c.addEventListener('change', () => {
      if (c.checked) enabled.add(k); else enabled.delete(k);
      if (!enabled.size) { enabled.add(k); c.checked = true; return; } // keep at least one
      commit(order);
    });
    li.addEventListener('dragstart', (e) => { dragFrom = i; li.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); } catch (err) { /* fine */ } });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); pd.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('over'); if (dragFrom >= 0 && dragFrom !== i) move(dragFrom, i); dragFrom = -1; });
    li.append(grip, tile, nm, up, dn, c);
    pd.appendChild(li);
  });
}

function renderApps() {
  const s = appSettings;
  const d = s.detection || {};
  const det = $('apps-detect');
  det.classList.toggle('warn', d.status === 'unavailable');
  det.textContent = d.status === 'ok'
    ? (d.provider === 'gnome' && !d.shellPill
      ? 'Front-app detection works, but GNOME is still running the old helper. Run "morph --install" in a terminal to update it, so it can draw the pill.'
      : 'Front-app detection is working' + (d.provider === 'gnome' ? ' (GNOME helper, which also draws the pill).' : d.provider === 'x11' ? ' (X11).' : d.provider === 'mac' ? ' (macOS).' : '.'))
    : d.status === 'unavailable'
      ? (d.provider === 'gnome'
        ? 'Can’t see which app is in front: the GNOME helper isn’t installed or enabled yet (see the README). Until then the pill shows in every app.'
        : 'Can’t see which app is in front on this system, so the pill shows in every app.')
      : 'Checking which app is in front…';
  document.querySelectorAll('input[name="pill-mode"]').forEach((r) => { r.checked = r.value === s.pillMode; });
  $('pill-on').checked = !!s.pillEnabled;
  $('auto-on').checked = !!s.autoFormat;
  $('link-on').checked = !!s.linkBack;
  const cards = (box, items, current, key) => {
    box.textContent = '';
    items.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card card-' + key + '-' + t.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(t.id === current));
      b.dataset.id = t.id;
      const sw = document.createElement('span'); sw.className = 'card-sw';
      const nm = document.createElement('span'); nm.className = 'card-name'; nm.textContent = t.name;
      b.append(sw, nm);
      b.addEventListener('click', () => {
        appSettings[key] = t.id;
        if (key === 'theme') applyTheme(t.id);
        saveApps();
        renderApps();
      });
      box.appendChild(b);
    });
  };
  cards($('theme-cards'), s.themes || [], s.theme, 'theme');
  $('nav-look').hidden = (s.themes || []).length < 2; // Light only for now
  cards($('size-cards'), s.sizes || [], s.size, 'size');
  renderKeys();
  renderDests();
  const list = $('rules');
  list.innerHTML = '';
  s.rules.forEach((r, idx) => {
    const li = document.createElement('li');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = r.enabled;
    on.setAttribute('aria-label', 'Show the pill in ' + r.name);
    on.addEventListener('change', () => { r.enabled = on.checked; saveApps(); });
    const label = document.createElement('div');
    const match = [r.app ? 'app “' + r.app + '”' : '', r.title ? 'title has “' + r.title + '”' : ''].filter(Boolean).join(' or ');
    label.innerHTML = '<span class="rname"></span><span class="rmatch"></span>';
    label.querySelector('.rname').textContent = r.name;
    label.querySelector('.rmatch').textContent = match;
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Fix for');
    Object.entries(DEST_SHORT).forEach(([k, v]) => { const o = document.createElement('option'); o.value = k; o.textContent = '→ ' + v; o.selected = k === r.dest; sel.appendChild(o); });
    sel.addEventListener('change', () => { r.dest = sel.value; saveApps(); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove ' + r.name);
    del.addEventListener('click', () => { s.rules.splice(idx, 1); saveApps(); renderApps(); });
    li.append(on, label, sel, del);
    list.appendChild(li);
  });
  const cur = s.current;
  $('current-win').textContent = cur && (cur.app || cur.title) ? 'In front just before this opened: app “' + cur.app + '”, title “' + (cur.title || '').slice(0, 70) + '”.' : '';
}
document.querySelectorAll('input[name="pill-mode"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) { appSettings.pillMode = r.value; saveApps(); } }));
$('pill-on').addEventListener('change', () => { appSettings.pillEnabled = $('pill-on').checked; saveApps(); });
$('auto-on').addEventListener('change', () => { appSettings.autoFormat = $('auto-on').checked; saveApps(); });
$('link-on').addEventListener('change', () => { appSettings.linkBack = $('link-on').checked; saveApps(); });

// Shortcuts: a switch each, and a key you can re-record. Keys are stored in
// GNOME's notation ("<Control><Alt>v"), shown as "Ctrl Alt V".
const KEY_MODS = [['ctrlKey', 'Control', 'Ctrl'], ['altKey', 'Alt', 'Alt'], ['shiftKey', 'Shift', 'Shift'], ['metaKey', 'Super', 'Super']];
function keyLabel(accel) {
  const mods = (accel.match(/<(\w+)>/g) || []).map((m) => m.slice(1, -1));
  const key = accel.replace(/<\w+>/g, '');
  return KEY_MODS.filter((m) => mods.includes(m[1])).map((m) => (IS_MAC ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }[m[1]] : m[2])).concat([key.toUpperCase()]).join(IS_MAC ? '' : ' ');
}
function accelFromEvent(e) {
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.key)) key = e.key;
  if (!key) return null;
  const mods = KEY_MODS.filter((m) => e[m[0]]).map((m) => '<' + m[1] + '>');
  if (!mods.some((m) => /Control|Alt|Super/.test(m))) return null; // a plain letter would steal typing
  return mods.join('') + key;
}
function renderKeys() {
  const ul = $('keys');
  ul.innerHTML = '';
  (appSettings.shortcuts || []).forEach((k) => {
    const li = document.createElement('li');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = k.on;
    on.setAttribute('aria-label', k.name);
    on.addEventListener('change', () => { k.on = on.checked; saveApps(); });
    const name = document.createElement('span');
    name.className = 'kname';
    name.textContent = k.name;
    const rec = document.createElement('button');
    rec.type = 'button';
    rec.className = 'kbtn';
    rec.textContent = keyLabel(k.accel);
    rec.title = 'Click, then press the new keys';
    rec.addEventListener('click', () => {
      rec.textContent = 'Press keys…';
      rec.classList.add('rec');
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { done(); return; }
        const a = accelFromEvent(e);
        if (!a) return; // still holding only modifiers
        const clash = appSettings.shortcuts.find((x) => x !== k && x.accel === a);
        if (clash) { rec.textContent = 'Used by “' + clash.name + '”'; return; }
        k.accel = a;
        k.on = true;
        done();
        saveApps();
      };
      const done = () => { window.removeEventListener('keydown', onKey, true); rec.classList.remove('rec'); renderKeys(); };
      window.addEventListener('keydown', onKey, true);
    });
    const warn = document.createElement('span');
    warn.className = 'ktaken';
    warn.textContent = k.taken ? 'taken by another app' : '';
    li.append(on, name, rec, warn);
    ul.appendChild(li);
  });
}
$('add-rule').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('add-title').value.trim();
  const appId = $('add-app').value.trim();
  if (!title && !appId) { $('add-title').focus(); return; }
  appSettings.rules.push({ id: 'custom-' + Date.now().toString(36), name: $('add-name').value.trim() || 'App', title, app: appId, dest: $('add-dest').value, enabled: true });
  saveApps();
  e.target.reset();
  $('add-dest').value = 'markdown';
  renderApps();
});

// ---------------------------------------------------------------- conversion
function convert() {
  const r = FB.engine.toAst(state.html, state.text, state.source);
  const ast = r.ast;
  const repairs = r.repairs;
  if (r.failed) setStatus('Couldn’t read this content. Try choosing a different source.', true);
  state.ast = ast;
  state.repairs = repairs;
  // The desktop app sees everything you copy, so nothing is written to disk
  // there. In a browser tab, the last paste is kept for convenience.
  if (!bridge) store.set('fb.last', { html: state.html.length < 1500000 ? state.html : '', text: state.text, source: state.source, how: state.how });
  if (bridge && bridge.setTrayStatus) {
    bridge.setTrayStatus(hasContentAst(ast) ? 'Last copy: ' + (FB.SOURCES[state.source] || 'text') + ', ' + (FB.astStats(ast).summary || 'text') : 'Nothing to convert');
  }
  render();
}

// ---------------------------------------------------------------- outputs
// "Source: Slack · #design-review (acme)", linked when we know the address.
// Only when you turned it on, only into a different app, and not into plain
// text (terminals, commit messages).
const engineOpts = () => ({ html: state.html, source: state.source, context: state.context, linkBack: state.linkBack, people: state.people || {} });
function linkingTo(dest) { return FB.engine.linkingTo(dest, engineOpts()); }
function withSourceLink(ast, dest) { return FB.engine.withSourceLink(ast, dest, engineOpts()); }
function outputs(dest, rawAst) { return FB.engine.outputs(dest, rawAst, engineOpts()); }
// Pairs that already paste perfectly without us: say so, and hand back the original untouched.
function passthrough(dest) { return FB.engine.passthrough(dest, engineOpts()); }
function notesFor(dest, ast) { return FB.engine.notes(dest, ast, engineOpts()); }

// ---------------------------------------------------------------- render
function hasContentAst(a) { return !!(a && a.children && a.children.length); }
function hasContent() { return hasContentAst(state.ast); }

function render() {
  const has = hasContent();
  document.body.dataset.dest = state.dest;
  document.body.classList.toggle('has-content', has);
  $('empty-hint').hidden = !!input.textContent;
  $('clear-btn').hidden = !input.textContent && !state.clip;
  sourceSelect.hidden = !has;
  sourceSelect.value = state.source;

  const meta = $('from-meta');
  if (has) {
    const summary = FB.astStats(state.ast).summary || 'text';
    const how = state.how === 'markup' ? 'Detected from the copied formatting.' : state.how === 'manual' ? 'Chosen by you.' : 'Guessed from the text; change it if it’s wrong.';
    meta.textContent = summary.charAt(0).toUpperCase() + summary.slice(1) + '. ' + how;
  } else {
    meta.textContent = '';
  }
  const rep = $('repairs');
  rep.hidden = !state.repairs.length || !has;
  rep.innerHTML = state.repairs.map((r) => '<li>' + FB.escapeHtml(r) + '</li>').join('');

  dests.forEach((b) => {
    const d = b.dataset.dest;
    b.setAttribute('aria-checked', String(d === state.dest));
    b.tabIndex = d === state.dest ? 0 : -1;
    const note = b.querySelector('.note');
    if (!has) { note.textContent = ''; b.classList.remove('changed'); return; }
    if (passthrough(d)) { note.textContent = 'as is'; b.classList.remove('changed'); return; }
    const n = notesFor(d, state.ast).length;
    note.textContent = n ? n + (n === 1 ? ' change' : ' changes') : 'exact';
    b.classList.toggle('changed', n > 0);
  });

  $('dest-sub').textContent = DESTS[state.dest].sub;
  copyBtn.disabled = !has;
  $('pdf-btn').disabled = !has;
  copyLabel.textContent = 'Copy for ' + DESTS[state.dest].name;
  renderPreview();
}

function renderPreview() {
  const dest = state.dest;
  preview.className = 'frame ' + dest;
  if (!hasContent()) {
    preview.innerHTML = '<p class="frame-empty">The ' + FB.escapeHtml(DESTS[dest].name) + ' version appears here.</p>';
    changes.innerHTML = '';
    return;
  }
  const ast = state.ast;
  const out = outputs(dest, ast);
  if (passthrough(dest)) {
    preview.innerHTML = state.html;
  } else if (dest === 'slack') {
    preview.innerHTML = '<div class="slack-msg"><div class="avatar" aria-hidden="true">Y</div><div><div class="who"><b>You</b><span>now</span></div><div class="slack-body">' + out.html + '</div></div></div>';
  } else if (dest === 'markdown' || dest === 'text' || dest === 'linear') {
    preview.innerHTML = '<pre class="plain">' + FB.escapeHtml(out.text.replace(/\n$/, '')) + '</pre>';
  } else {
    preview.innerHTML = out.html.replace('<meta charset="utf-8">', '');
  }
  // Previews are for looking: neutralise links and scripts-free images.
  preview.querySelectorAll('a[href]').forEach((a) => {
    if (!/^(https?:|mailto:)/i.test(a.getAttribute('href'))) a.removeAttribute('href');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  preview.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());

  const notes = notesFor(dest, ast);
  if (passthrough(dest)) {
    changes.innerHTML = '<p class="ok">This already pastes perfectly into ' + FB.escapeHtml(DESTS[dest].name) + '. Copy gives back exactly what you copied.</p>';
  } else if (!notes.length) {
    changes.innerHTML = '<p class="ok">Everything carries over to ' + FB.escapeHtml(DESTS[dest].name) + '.</p>';
  } else {
    changes.innerHTML = '<p class="changes-title">' + (notes.length === 1 ? '1 thing changes' : notes.length + ' things change') + '</p><ul>' +
      notes.map((n) => '<li>' + FB.escapeHtml(n) + '</li>').join('') + '</ul>';
  }
}

// ---------------------------------------------------------------- destinations
function selectDest(d) {
  if (!DESTS[d]) return;
  state.dest = d;
  store.set('fb.dest', d);
  render();
}
dests.forEach((b) => {
  b.addEventListener('click', () => selectDest(b.dataset.dest));
  b.addEventListener('keydown', (e) => {
    const i = dests.indexOf(b);
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = dests[(i + 1) % dests.length];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = dests[(i - 1 + dests.length) % dests.length];
    if (n) { e.preventDefault(); selectDest(n.dataset.dest); n.focus(); }
  });
});

// ---------------------------------------------------------------- copy
let resetTimer = null;
async function copy() {
  if (!hasContent()) return;
  const dest = state.dest;
  const out = passthrough(dest) ? { html: state.html, text: state.text } : outputs(dest, state.ast);
  try {
    if (bridge) {
      await bridge.writeClipboard({ html: out.html, text: out.text });
    } else if (out.html) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([out.html], { type: 'text/html' }),
        'text/plain': new Blob([out.text], { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(out.text);
    }
    // Our own copy shouldn't be re-imported as "a new copy".
    if (bridge) { try { const c = await bridge.readClipboard(); state.lastClipKey = state.ownKey = clipKey(c); } catch (e) { /* ignore */ } }
    copyLabel.textContent = 'Copied for ' + DESTS[dest].name;
    setStatus('Now paste into ' + DESTS[dest].name + ' with ' + MOD + ' V.');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copyLabel.textContent = 'Copy for ' + DESTS[state.dest].name; }, 2500);
    return true;
  } catch (err) {
    console.error(err);
    setStatus('Couldn’t copy. Click anywhere in the window and try again.', true);
    return false;
  }
}
copyBtn.addEventListener('click', copy);

// ---------------------------------------------------------------- inspector
function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

function setInspector(clip) {
  state.clip = clip;
  const list = $('formats');
  const view = $('format-view');
  list.innerHTML = '';
  view.innerHTML = '';
  $('inspect-copy').disabled = !clip;
  if (!clip) { $('inspect-summary').textContent = 'Nothing read yet.'; return; }
  const entries = [];
  if (clip.text) entries.push({ id: 'text', label: 'Plain text', bytes: new Blob([clip.text]).size });
  if (clip.html) entries.push({ id: 'html', label: 'HTML', bytes: new Blob([clip.html]).size });
  if (clip.rtf) entries.push({ id: 'rtf', label: 'Rich text (RTF)', bytes: new Blob([clip.rtf]).size });
  if (clip.image) entries.push({ id: 'image', label: 'Image ' + clip.image.width + '×' + clip.image.height, bytes: null });
  (clip.others || []).forEach((o, i) => entries.push({ id: 'other' + i, label: o.format, bytes: o.bytes }));
  $('inspect-summary').textContent = entries.length
    ? entries.length + (entries.length === 1 ? ' format' : ' formats') + ' on the clipboard. Detected source: ' + (FB.SOURCES[state.source] || state.source) + '.'
    : 'The clipboard is empty.';
  entries.forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fmt';
    b.setAttribute('aria-pressed', String(i === 0));
    b.innerHTML = '<span>' + FB.escapeHtml(e.label) + '</span><span class="muted">' + (e.bytes === null ? '' : fmtBytes(e.bytes)) + '</span>';
    b.addEventListener('click', () => {
      list.querySelectorAll('.fmt').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      showFormat(e.id);
    });
    list.appendChild(b);
  });
  if (entries.length) showFormat(entries[0].id);
}

function showFormat(id) {
  const c = state.clip;
  const view = $('format-view');
  const pre = (s) => '<pre class="raw">' + FB.escapeHtml(s) + '</pre>';
  if (id === 'text') view.innerHTML = pre(c.text);
  else if (id === 'rtf') view.innerHTML = pre(c.rtf);
  else if (id === 'image') view.innerHTML = '<img class="clip-img" alt="Image on the clipboard" src="' + c.image.dataUrl + '">';
  else if (id === 'html') {
    view.innerHTML = '<div class="seg"><button type="button" data-v="src" aria-pressed="true">Source</button><button type="button" data-v="look" aria-pressed="false">Rendered</button></div><div id="html-view"></div>';
    const hv = view.querySelector('#html-view');
    const show = (v) => {
      view.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      if (v === 'src') hv.innerHTML = pre(c.html);
      else {
        const f = document.createElement('iframe');
        f.className = 'html-frame';
        f.setAttribute('sandbox', '');
        f.title = 'Clipboard HTML, rendered';
        f.srcdoc = c.html;
        hv.innerHTML = '';
        hv.appendChild(f);
      }
    };
    view.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => show(b.dataset.v)));
    show('src');
  } else {
    const o = c.others[parseInt(id.slice(5), 10)];
    view.innerHTML = o.error ? '<p class="muted">Couldn’t read: ' + FB.escapeHtml(o.error) + '</p>' : o.text !== null && o.text !== undefined ? pre(o.text) : '<p class="muted">Binary data, first bytes:</p>' + pre(o.hex || '');
  }
}

$('inspect-copy').addEventListener('click', async () => {
  const c = state.clip;
  if (!c) return;
  const report = JSON.stringify({
    formatBridge: $('ver').textContent || 'web',
    platform: bridge ? bridge.platform : navigator.platform,
    detectedSource: state.source,
    formats: c.formats,
    html: (c.html || '').slice(0, 300000),
    text: (c.text || '').slice(0, 100000),
    rtf: (c.rtf || '').slice(0, 100000),
    others: (c.others || []).map((o) => ({ format: o.format, bytes: o.bytes, text: o.text ? o.text.slice(0, 50000) : null, hex: o.hex })),
  }, null, 2);
  try {
    if (bridge) await bridge.writeClipboard({ html: '', text: report });
    else await navigator.clipboard.writeText(report);
    state.lastClipKey = '';
    setStatus('Clipboard report copied. Paste it into the chat to share it.');
  } catch (e) { setStatus('Couldn’t copy the report.', true); }
});

// tabs
function selectTab(which) {
  const isInspect = which === 'inspect';
  $('tab-content').setAttribute('aria-selected', String(!isInspect));
  $('tab-inspect').setAttribute('aria-selected', String(isInspect));
  $('pane-content').hidden = isInspect;
  $('pane-inspect').hidden = !isInspect;
}
$('tab-content').addEventListener('click', () => selectTab('content'));
$('tab-inspect').addEventListener('click', () => selectTab('inspect'));

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); copy(); return; }
  if (e.key === 'Escape' && document.body.classList.contains('apps-open')) { openApps(false); return; }
  if (e.key === 'Escape' && COMPANION && bridge && bridge.hide) { bridge.hide(); return; }
  if (bridge && mod && (e.key === 'r' || e.key === 'R') && !e.shiftKey) { e.preventDefault(); readSystemClipboard('button'); return; }
  const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (!typing && !mod && !e.altKey && /^[1-7]$/.test(e.key)) selectDest(Object.keys(DESTS)[parseInt(e.key, 10) - 1]);
});

// ---------------------------------------------------------------- start
const last = bridge ? null : store.get('fb.last', null);
if (last && (last.text || last.html)) {
  state.html = last.html || '';
  state.text = last.text || '';
  state.source = last.source || 'plain-text';
  state.how = last.how || 'text';
  input.textContent = state.text;
  convert();
} else {
  render();
}
})();
