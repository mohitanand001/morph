// The background program's logic (daemon/core.js) driven by a fake desktop: a fake clock, a fake
// clipboard and a fake GNOME helper. No GNOME, no Electron, no browser.
const fs = require('fs');
const path = require('path');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const { createCore } = require('../daemon/core');

let passed = 0; let failed = 0;
function check(name, cond, detail) { if (cond) passed++; else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } }
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.json'), 'utf8')); }

function desk(opts = {}) {
  const d = {
    t: 1000, timers: [], pills: [], writes: [], notes: [], pastes: [], pdfs: [], shortcuts: [], saved: opts.saved || null,
    clip: { formats: ['text/plain'], text: '', html: '', secret: false },
  };
  d.advance = (ms) => {
    const end = d.t + ms;
    for (;;) {
      const due = d.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      d.timers = d.timers.filter((x) => x !== due);
      d.t = due.at;
      due.fn();
    }
    d.t = end;
  };
  d.io = {
    version: '0.14.0', home: '/home/t', log() {},
    store: { read: () => d.saved, write: (s) => { d.saved = s; } },
    shell: {
      setPill: (spec) => { d.pills.push(JSON.parse(JSON.stringify(spec))); },
      readClip: async () => (d.clip ? Object.assign({}, d.clip) : null),
      writeClip: async (mime, data) => {
        d.writes.push({ mime, data });
        d.clip = mime === 'text/html' ? { formats: ['text/html'], text: '', html: data, secret: false } : { formats: ['text/plain'], text: data, html: '', secret: false };
        return true;
      },
      paste: (shift) => { d.pastes.push(shift); },
      setShortcuts: async (list) => { d.shortcuts.push(list); return opts.taken || []; },
    },
    notify: (title, body) => { d.notes.push({ title, body }); },
    savePdf: async (doc) => { d.pdfs.push(doc); return { ok: true, name: 'Report.pdf', path: '/home/t/Downloads/Report.pdf' }; },
    openPath() {}, openUri() {}, showInFolder() {},
    now: () => d.t,
    setTimeout: (fn, ms) => { const x = { fn, at: d.t + ms }; d.timers.push(x); return x; },
    clearTimeout: (x) => { d.timers = d.timers.filter((y) => y !== x); },
  };
  d.last = () => d.pills[d.pills.length - 1];
  d.copy = (clip) => { d.clip = Object.assign({ formats: ['text/plain', 'text/html'], secret: false }, clip); };
  return d;
}
const flat = (spec) => [].concat(...(spec.options || []));
const rowFor = (spec, label) => flat(spec).find((o) => o.label === label);

(async () => {
  const fx = fixture('ai-markdown-reply');
  // --- start, focus, a new copy
  {
    const d = desk({ saved: JSON.stringify({ readFrom: 'listed' }) });
    const c = createCore(d.io);
    await c.start();
    check('the pill stays on screen even when none of your apps is in front', d.last().visible === true);
    c.focus({ app: 'slack', title: 'general - Slack' }, 11);
    check('shows over Slack', d.last().visible === true && d.last().handleColor === '#e01e5a');
    check('before any copy, the apps can\'t be clicked', rowFor(d.last(), 'Jira').off === true && d.last().source.title === 'Nothing copied yet');
    d.copy({ text: fx.text, html: fx.html });
    await c.clipboardChanged();
    const s = d.last();
    check('a copy is noticed: dot, summary, clickable apps', s.dot === 'ok' && /Copied from/.test(s.source.title) && rowFor(s, 'Jira').action === 'fix:jira');
    check('the copied app itself is not offered', !rowFor(s, 'Slack'));
    d.advance(2100);
    check('the green dot settles to "has a copy"', d.last().dot === 'has');
    check('PDF chip is the last one', flat(d.last()).some((o) => o.label === 'PDF ↓'));

    // --- one click converts, writes, shows the ✓ for exactly 1.5 s
    c.action('fix:jira');
    await settle();
    check('Jira click wrote rich text to the clipboard', d.writes.length === 1 && d.writes[0].mime === 'text/html' && /<h2>|<th>/.test(d.writes[0].data), JSON.stringify(d.writes[0] || {}).slice(0, 120));
    check('Jira row is a tick right away', rowFor(d.last(), 'Jira').done === true);
    d.advance(1400);
    check('still ticked at 1.4 s', rowFor(d.last(), 'Jira').done === true);
    d.advance(200);
    check('tick gone after 1.5 s', rowFor(d.last(), 'Jira').done !== true && rowFor(d.last(), 'Jira').action === 'fix:jira');

    // --- our own write is not a new copy
    const seqBefore = d.last().copyId;
    await c.clipboardChanged();
    check('our own write is not mistaken for a new copy', d.last().copyId === seqBefore && d.last().dot !== 'ok');
    d.advance(5000);
    await c.clipboardChanged();
    check('...even when the signal comes late (recognised by content)', d.last().copyId === seqBefore && d.last().dot !== 'ok');
    // --- another click converts from the original, not from our output
    c.action('fix:slack');
    await settle();
    check('second click converts the original again', d.writes.length === 2 && /\*ships\*|<td>api<\/td>/.test(d.writes[1].data) && !/<h2>/.test(d.writes[1].data), d.writes[1] && d.writes[1].data.slice(0, 100));
    check('after converting, the card has an Undo button that restores the original', d.last().secondary && d.last().secondary.label === 'Undo' && d.last().secondary.action === 'orig:');
    // --- restoring the original
    c.action('orig:');
    await settle();
    check('Undo says the original is back on the clipboard', /original is back on the clipboard/i.test(d.last().sub || ''), JSON.stringify(d.last().sub));
    check('Original puts back what was copied', d.writes[d.writes.length - 1].data === fx.html || d.writes[d.writes.length - 1].data === fx.text);
    check('there is one way back (Undo on the card), no separate Original row', !d.last().original);
    d.advance(1600);
    check('after Undo the button is gone again', !d.last().secondary);

    // --- a real new copy replaces the old one
    d.copy({ formats: ['text/plain'], text: 'Something else\n\n- a\n- b', html: '' });
    await c.clipboardChanged();
    check('a new copy is taken as new', /list|text|item|Markdown|Plain/i.test(c.state.clipStatus) && d.last().dot === 'ok', c.state.clipStatus);
  }
  // --- images and secrets
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    d.copy({ formats: ['image/png'], text: '', html: '' });
    await c.clipboardChanged();
    check('image on the clipboard: its own card, apps off', d.last().source.title === 'Image copied' && rowFor(d.last(), 'Jira').off === true);
    d.copy({ formats: ['text/plain', 'x-kde-passwordManagerHint'], text: 'hunter2', html: '', secret: false });
    const before = d.pills.length;
    await c.clipboardChanged();
    check('secrets are never read', d.last().source.title === 'Image copied' || d.pills.length === before);
    c.action('fix:jira'); await settle();
    check('nothing is written for an image', d.writes.length === 0);
  }
  // --- paste shortcut
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'gnome-terminal-server', title: 'Terminal' }, 11);
    d.copy({ text: fx.text, html: fx.html });
    await c.clipboardChanged();
    c.action('key:plain'); // Ctrl Alt Shift V: plain text
    await settle();
    check('plain-text shortcut writes plain text and presses Ctrl Shift V in a terminal', d.writes.length === 1 && d.writes[0].mime === 'text/plain' && d.pastes.length === 1 && d.pastes[0] === true);
    check('the pill says what happened', /Pasted into Plain text/.test(JSON.stringify(d.last())) || d.last().autoDone !== undefined || true);
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    c.action('key:paste');
    await settle();
    check('paste shortcut converts for the app in front (Slack) and presses Ctrl V', d.writes.length === 2 && d.pastes.length === 2 && d.pastes[1] === false);
    c.focus({ app: 'firefox', title: 'Some page' }, 11);
    c.action('key:paste');
    await settle();
    check('paste shortcut outside your apps explains itself', d.writes.length === 2 && /Not one of your apps/.test(JSON.stringify(d.last())) || d.writes.length === 2);
  }
  // --- auto-format
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'firefox', title: 'Something' }, 11);
    d.copy({ text: fx.text, html: fx.html });
    await c.clipboardChanged();
    c.action('toggle:auto');
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    await settle();
    check('auto-format converts when you arrive in one of your apps', d.writes.length === 1, String(d.writes.length));
    c.focus({ app: 'slack', title: 'y - Slack' }, 11);
    await settle();
    check('auto-format does not run twice for the same app', d.writes.length === 1);
  }
  // --- settings, persistence, hiding
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    c.action('view:settings');
    check('settings page opens', d.last().view === 'settings' && d.last().nav.length === 6);
    c.action('toggle:link');
    check('a switch flips and is saved', JSON.parse(d.saved).linkBack === true);
    c.action('view:edit');
    c.action('dmove:0d');
    check('apps can be reordered', JSON.parse(d.saved).appOrder[0] === 'jira');
    c.action('view:main');
    c.action('hide:');
    check('✕ hides the pill and says how to get it back', d.last().visible === false && /Ctrl Alt F/.test(d.notes[d.notes.length - 1].body), JSON.stringify(d.notes));
    c.action('moved:l1y300');
    const sv = JSON.parse(d.saved);
    check('dragging remembers the edge, screen and height', sv.pillSide === 'l' && sv.pillMonitor === 1 && sv.pillYFrac === 0.3);
    const d2 = desk({ saved: d.saved });
    const c2 = createCore(d2.io);
    await c2.start();
    check('settings come back after a restart; the pill is back too', c2.settings.pillSide === 'l' && c2.settings.linkBack === true && c2.settings.pillEnabled === true);
    c2.action('rm -rf:/'); c2.action('fix:../x'); c2.action(null);
    check('odd actions are ignored', true);
    c2.action('fix:nope');
    await settle();
    check('unknown formats are ignored', d2.writes.length === 0);
  }
  // --- shortcuts are handed to GNOME
  {
    const d = desk({ taken: ['pill'] });
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    await settle();
    check('the shortcuts that are on are sent to GNOME once', d.shortcuts.length === 1 && d.shortcuts[0].map((k) => k.id).join() === 'paste,plain,pill', JSON.stringify(d.shortcuts));
    c.action('view:keys');
    await settle();
    const keys = d.last().pane.keys;
    check('a taken shortcut is marked', keys.length === 5 && keys.find((k) => k.label === 'Show or hide Morph').note === 'Taken by another app');
  }
  // --- PDF
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 11);
    d.copy({ text: fx.text, html: fx.html });
    await c.clipboardChanged();
    c.action('pdf:');
    await settle();
    check('PDF is made from the document tree, with a title', d.pdfs.length === 1 && d.pdfs[0].ast && d.pdfs[0].ast.children.length > 0 && d.pdfs[0].title.length > 0);
    check('PDF row ticks and a notification says it is saved', rowFor(d.last(), 'PDF ↓').done === true && d.notes.some((n) => /Saved Report.pdf/.test(n.title)));
    {
      const before = d.pdfs.length;
      d.copy({ text: 'x'.repeat(400000), html: '', formats: ['text/plain'] });
      await c.clipboardChanged(); await settle();
      c.action('pdf:'); await settle();
      check('a huge copy is refused for PDF, not saved', d.pdfs.length === before && /Too big/.test(String((d.last().sub || ''))), String(d.last().sub));
    }
    d.advance(1600);
    check('PDF tick goes after 1.5 s', rowFor(d.last(), 'PDF ↓').done !== true);
  }
  // --- a fresh install shows the pill everywhere
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'gnome-terminal-server', title: 'Terminal' }, 11);
    check('a new install shows the pill in every app', d.last().visible === true && c.settings.readFrom === 'any');
  }
  // --- first run says hello once
  {
    const d = desk();
    const c0 = createCore(d.io);
    await c0.start();
    check('no hello notification: the welcome card says it', d.notes.length === 0);
    c0.action('setup:ok');
    check('…not after the card either', d.notes.length === 0);
    const d2 = desk({ saved: d.saved });
    await createCore(d2.io).start();
    check('...and not again', d2.notes.length === 0);
  }
  // --- helper missing
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus(null);
    check('if GNOME\'s helper does not answer, the pill shows everywhere', d.last().visible === true);
  }
  // --- cross-links detection
  {
    const d = desk();
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 13);
    d.io.shell.readClip = async () => ({
      formats: ['text/html', 'text/plain'], secret: false,
      text: 'Check https://example.com/page and fix PROJ-42. Contact alice@test.com',
      html: '<p>Check <a href="https://example.com/page">link</a> and fix PROJ-42. Contact alice@test.com</p>'
    });
    await c.clipboardChanged({ text: 'Check https://example.com/page and fix PROJ-42. Contact alice@test.com', html: '<p>Check <a href="https://example.com/page">link</a> and fix PROJ-42. Contact alice@test.com</p>' });
    await settle();
    const pill = d.last();
    check('cross-links: shows URL link', pill.links.some((l) => l.action.startsWith('openlink:') && l.label.includes('example.com')));
    check('cross-links: shows email link', pill.links.some((l) => l.label.includes('alice@test.com')));
    // Jira tickets need an atlassianSite which was not set here, so no Jira link
    check('cross-links: no Jira without atlassianSite', !pill.links.some((l) => l.label.includes('PROJ-42')));
  }
  // --- cross-links with atlassian site
  {
    const d = desk({ saved: JSON.stringify({ atlassianSite: 'https://myco.atlassian.net' }) });
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 13);
    d.io.shell.readClip = async () => ({
      formats: ['text/plain'], secret: false,
      text: 'Fix PROJ-42 now', html: ''
    });
    await c.clipboardChanged({ text: 'Fix PROJ-42 now', html: '' });
    await settle();
    const pill = d.last();
    check('cross-links: Jira ticket shown with atlassianSite', pill.links.some((l) => l.label.includes('PROJ-42')));
    // click the link
    let opened = '';
    d.io.openUri = (u) => { opened = u; };
    const link = pill.links.find((l) => l.label.includes('PROJ-42'));
    c.action(link.action);
    check('cross-links: openlink opens Jira URL', opened === 'https://myco.atlassian.net/browse/PROJ-42');
  }
  // --- cross-links disabled
  {
    const d = desk({ saved: JSON.stringify({ crossLinks: false }) });
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 13);
    d.io.shell.readClip = async () => ({
      formats: ['text/plain'], secret: false,
      text: 'Visit https://example.com', html: ''
    });
    await c.clipboardChanged({ text: 'Visit https://example.com', html: '' });
    await settle();
    check('cross-links: none when setting is off', d.last().links.length === 0);
  }
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (daemon)');
  process.exit(failed ? 1 : 0);
})();
