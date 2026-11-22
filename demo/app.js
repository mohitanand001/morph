(function () {
// The website demo: pick a sample (or paste your own), choose where it is going, see what Morph pastes.
// It calls the same converter as the app (FB.engine.run) and never sends anything anywhere.
const $ = (id) => document.getElementById(id);
const E = FB.engine;
const SAMPLES = window.FB_SAMPLES;
const ORDER = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
const SHORT = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Docs', markdown: 'Markdown', text: 'Text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
const WHERE = {
  slack: 'Paste into a Slack message box.', jira: 'Paste into a Jira description or comment.', confluence: 'Paste into a Confluence page while editing.',
  email: 'Gmail, Outlook and Apple Mail.', gdocs: 'Paste into a Google Doc.', markdown: 'GitHub, Claude, ChatGPT, Cursor and anything that reads markdown.',
  text: 'Terminals, commit messages and plain text boxes. No formatting at all.', notion: 'Paste into a Notion page: headings, lists, tables and code become blocks.',
  linear: 'Paste into a Linear issue or comment.', teams: 'Paste into a Microsoft Teams message.',
};
const BRAND = { slack: '#4a154b', jira: '#0c66e4', confluence: '#1868db', email: '#b3261e', gdocs: '#1a73e8', markdown: '#24292f', text: '#2e7d32', notion: '#37352f', linear: '#5e6ad2', teams: '#5b5fc7' };
const PAGE = {
  slack: 'font:15px/1.46 "Lato",system-ui,sans-serif;color:#1d1c1d', jira: 'font:14px/1.6 system-ui,sans-serif;color:#172b4d', confluence: 'font:14px/1.7 system-ui,sans-serif;color:#172b4d',
  email: 'font:14px/1.5 Calibri,Arial,sans-serif;color:#222', gdocs: 'font:11pt/1.5 Arial,sans-serif;color:#000', notion: 'font:16px/1.55 system-ui,sans-serif;color:#37352f',
  teams: 'font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#242424',
};
// Brand marks carry their own colours, so they sit on a light tile; the generic ones take the app's colour.
const tile = (k) => '<span class="tile" style="' + (window.FBI && window.FBI.isBrand(k) ? 'background:#fffbf0;border:1px solid rgba(7,54,66,.14)' : 'background:#eef0f2;color:' + (BRAND[k] || '#333')) + '">' + (window.FBI ? window.FBI.dest(k, 16) : '') + '</span>';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const st = { id: '', clip: null, dest: 'slack', src: 'rich', mode: 'morph', run: null };

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }

// A sandboxed frame: no scripts, no links followed, no remote images (a pasted page can't phone home).
function frame(html, style) {
  const f = document.createElement('iframe');
  f.className = 'view'; f.setAttribute('sandbox', 'allow-same-origin'); f.title = 'Preview';
  f.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
    '<style>html{background:#fff}body{margin:0;padding:12px 14px;' + (style || 'font:14px/1.5 system-ui,sans-serif;color:#222') + '}table{border-collapse:collapse;margin:6px 0;max-width:100%;width:auto!important}td,th{border:1px solid #cfcfcf;padding:4px 9px;text-align:left;overflow-wrap:anywhere}' +
    'pre{background:#f6f6f6;border:1px solid #ddd;border-radius:6px;padding:8px 10px;white-space:pre;overflow-x:auto;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:8px 0}p{margin:0 0 8px}a{color:#1264a3}img{max-width:100%}</style><body>' + html;
  f.addEventListener('load', () => { try { f.style.height = Math.min(520, Math.max(90, f.contentDocument.documentElement.scrollHeight + 2)) + 'px'; } catch (e) { /* keep the default */ } });
  return f;
}
function pre(text) { const p = document.createElement('pre'); p.className = 'view'; p.textContent = text; return p; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function setHash() { try { history.replaceState(null, '', '#s=' + encodeURIComponent(st.id) + '&d=' + st.dest); } catch (e) { /* ignore */ } }

function renderSamples() {
  const box = $('samples'); box.textContent = '';
  let cards = null, group = '';
  const open = (name) => { box.appendChild(el('h3', 'grp', name)); cards = el('div', 'cards'); box.appendChild(cards); };
  SAMPLES.forEach((s) => {
    if (s.group !== group) { group = s.group; open(group); }
    const b = el('button', 'sample'); b.type = 'button'; b.setAttribute('aria-pressed', String(st.id === s.id)); b.dataset.id = s.id;
    b.innerHTML = '<span class="t">' + tile(s.app) + esc(s.title) + '</span><p>' + esc(s.blurb) + '</p>';
    b.addEventListener('click', () => pick(s.id));
    cards.appendChild(b);
  });
  open('Your own');
  const own = el('div', 'sample own');
  own.innerHTML = '<span class="t"><span class="tile">' + (window.FBI ? window.FBI.ui('content_paste', 16) : '') + '</span>Paste your own</span><p>Copy anything, click here and press Ctrl V (or ⌘V).</p>';
  const ta = el('textarea'); ta.setAttribute('aria-label', 'Paste your own content here'); ta.placeholder = 'Paste here…';
  ta.addEventListener('paste', (e) => {
    const cd = e.clipboardData; if (!cd) return;
    e.preventDefault();
    take(cd.getData('text/html'), cd.getData('text/plain'), 'own');
    ta.value = '';
  });
  ta.addEventListener('input', () => { if (ta.value.trim()) take('', ta.value, 'own'); });
  own.appendChild(ta);
  cards.appendChild(own);
}

function pick(id) {
  const s = SAMPLES.find((x) => x.id === id); if (!s) return;
  if (st.id !== id) st.dest = st.destChosen ? st.dest : s.best[0];
  take(s.html, s.text, id);
  toast('Copied: ' + s.title.toLowerCase());
}

function take(html, text, id) {
  st.id = id; st.clip = { html: html || '', text: text || '' };
  if (!st.clip.html && !st.clip.text.trim()) return;
  renderSamples(); render(); setHash();
}

function render() {
  if (!st.clip) return;
  st.run = E.run(st.clip, st.dest);
  renderSrc(); renderOut();
}

function renderSrc() {
  const r = st.run, box = $('src'); box.textContent = '';
  if (!r.has) { box.appendChild(el('div', 'empty', 'Nothing to convert in that.')); return; }
  const b = el('div', 'badge'); b.innerHTML = '<span class="dot"></span>'; b.appendChild(document.createTextNode('Copied from ' + (FB.SOURCES[r.source] || 'somewhere')));
  box.appendChild(b); box.appendChild(el('p', 'sum', r.summary.replace(/^[^:]*: /, '')));
  const smp = SAMPLES.find((x) => x.id === st.id);
  if (smp && smp.look) { const l = el('p', 'look'); l.appendChild(el('b', null, 'Look for: ')); l.appendChild(document.createTextNode(smp.look)); box.appendChild(l); }
  if (st.src === 'rich' && st.clip.html) box.appendChild(frame(st.clip.html));
  else {
    box.appendChild(pre(st.clip.text));
    if (st.src === 'text' && st.clip.html) box.appendChild(el('p', 'hint', 'This is all a plain text box receives. The headings, bold, lists and tables are gone.'));
  }
}

const KIND = { converted: 'c', cleanup: 't', same: 'n', untouched: 'n' };
const LABEL = { converted: 'Morph converts it', cleanup: 'only tidied, same words and layout', same: 'nothing to change', untouched: 'left exactly as copied' };
const verdicts = {};
function levelFor(k) { return verdicts[k].level; }
function computeVerdicts() {
  ORDER.forEach((k) => { const r = E.run(st.clip, k); verdicts[k] = FBV.verdict(st.clip, r, E.notes(k, r.ast, r.opts)); });
}

function renderOut() {
  const r = st.run, box = $('out'); box.textContent = '';
  if (!r.has) { box.appendChild(el('div', 'empty', 'Nothing to convert in that.')); return; }
  computeVerdicts();
  box.appendChild(el('div', 'sec', 'Copy it for')); box.lastChild.style.marginTop = '0';
  const chips = el('div', 'chips'); chips.style.marginTop = '8px';
  ORDER.forEach((k) => {
    const c = el('button', 'chip'); c.type = 'button'; c.setAttribute('aria-pressed', String(k === st.dest));
    const kind = KIND[levelFor(k)];
    c.innerHTML = tile(k) + esc(SHORT[k]) + '<span class="mk ' + kind + '"></span>';
    c.title = SHORT[k] + ': ' + LABEL[levelFor(k)];
    c.addEventListener('click', () => { st.dest = k; st.destChosen = true; render(); setHash(); });
    chips.appendChild(c);
  });
  box.appendChild(chips);
  const key = el('div', 'key'); key.innerHTML = '<span><i style="background:var(--accent)"></i>converted</span><span><i style="background:var(--paper);box-shadow:inset 0 0 0 2px var(--accent)"></i>only tidied</span><span><i style="background:#9aa6a6"></i>nothing to change</span>';
  box.appendChild(key);
  box.style.setProperty('--brand', BRAND[st.dest]);
  box.appendChild(el('p', 'hint', WHERE[st.dest])).style.marginTop = '12px';
  const name = E.NAMES[st.dest];
  const out = r.out || { html: '', text: '' };
  const v = verdicts[st.dest];
  const vl = el('div', 'verdict ' + KIND[v.level]); vl.appendChild(el('b', null, { converted: 'Converted', cleanup: 'Only tidied', same: 'Nothing to change', untouched: 'Left alone' }[v.level]));
  vl.appendChild(el('span', null, { converted: 'Morph changes something real for ' + name + '.', cleanup: 'Same words and layout. Morph only tidies the source styling.', same: 'It already reads the same in ' + name + '.', untouched: 'It came from this kind of app, so it is pasted as copied.' }[v.level]));
  if (st.mode !== 'plain') box.appendChild(vl);
  if (st.mode === 'plain') {
    if (st.clip.html) {
      box.appendChild(el('div', 'chrome', 'Without Morph: the formatting as it was copied'));
      box.appendChild(frame(st.clip.html));
      box.appendChild(el('p', 'hint', 'Apps that read formatting take this as it is, source styling included. Many handle it well; some keep colours, fonts or wrappers from the source app.'));
      const d0 = el('details'); d0.appendChild(el('summary', null, 'What an app that reads only text would get'));
      d0.appendChild(pre(st.clip.text)); box.appendChild(d0);
    } else {
      box.appendChild(el('div', 'chrome', 'Without Morph: the copied text as it is'));
      box.appendChild(pre(st.clip.text));
      box.appendChild(el('p', 'hint', 'Only text was copied, so any markup in it shows up as symbols unless ' + name + ' happens to read that syntax itself.'));
    }
  } else {
    box.appendChild(el('div', 'chrome', r.passthrough ? 'Already right for ' + name + ': pasted untouched' : 'What ' + name + ' receives'));
    if (r.passthrough) box.appendChild(frame(st.clip.html, PAGE[st.dest]));
    else if (out.html) box.appendChild(frame(out.html, PAGE[st.dest]));
    else box.appendChild(pre(out.text));
    if (out.html && !r.passthrough) {
      const d = el('details'); d.appendChild(el('summary', null, 'The plain-text version that travels with it'));
      d.appendChild(pre(out.text)); box.appendChild(d);
    }
    const did = (r.repairs || []).concat(E.notes(st.dest, r.ast, r.opts) || []);
    if (r.passthrough) { const u = el('ul', 'notes ok'); u.appendChild(el('li', null, 'Slack to Slack and Atlassian to Atlassian already paste perfectly, so Morph leaves them alone.')); box.appendChild(u); }
    else if (did.length) { const u = el('ul', 'notes'); did.forEach((n) => u.appendChild(el('li', null, n))); box.appendChild(u); }
  }
  const row = el('div', 'row');
  const cp = el('button', 'btn', 'Copy for ' + name); cp.type = 'button';
  cp.addEventListener('click', () => copyOut(out, name, r));
  row.appendChild(cp); row.appendChild(el('span', 'spacer'));
  row.appendChild(el('span', 'hint', 'Then paste it into ' + name + ' to try it for real.')); row.lastChild.style.margin = '0';
  box.appendChild(row);
}

async function copyOut(out, name, r) {
  const html = r.passthrough ? st.clip.html : out.html, text = r.passthrough ? st.clip.text : out.text;
  let ok = false;
  try {
    if (html && navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      ok = true;
    } else if (!html && navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (e) { ok = false; }
  if (!ok) {
    const h = (e) => { e.preventDefault(); if (html) e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', text); };
    document.addEventListener('copy', h, { once: true });
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.removeEventListener('copy', h);
  }
  toast(ok ? 'Copied for ' + name + '. Now paste it there.' : 'Your browser blocked the copy. Select the preview and copy it by hand.');
}

function segment(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    st[key] = b.dataset.v;
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (st.clip) render();
  });
}
segment('srcseg', 'src'); segment('modeseg', 'mode');

renderSamples();
const h = new URLSearchParams(location.hash.replace(/^#/, ''));
if (ORDER.includes(h.get('d'))) { st.dest = h.get('d'); st.destChosen = true; }
const first = SAMPLES.find((s) => s.id === h.get('s')) || SAMPLES.find((s) => s.id === 'slack') || SAMPLES[0];
if (!h.get('d')) st.dest = first.best[0];
take(first.html, first.text, first.id);
})();
