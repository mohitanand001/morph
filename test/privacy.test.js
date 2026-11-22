// Privacy and the one app list: "All apps" reads any app except password managers; "Only these apps" reads and
// converts only in the apps switched on. A one-time welcome card says so; it asks no questions.
const fs = require('fs');
const path = require('path');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const { createCore } = require('../daemon/core');
let passed = 0; let failed = 0;
function check(n, c, d) { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')); } }
function desk(saved) {
  const d = { reads: 0, pills: [], saved: saved || null, notes: [] };
  d.io = {
    version: '0.15.0', home: '/h', log() {}, store: { read: () => d.saved, write: (s) => { d.saved = s; } },
    shell: { setPill: (s) => d.pills.push(JSON.parse(JSON.stringify(s))), readClip: async () => { d.reads++; return { formats: ['text/plain'], text: 'hello', html: '' }; }, writeClip: async () => true, paste() {}, setShortcuts: async () => [] },
    notify: (t, b) => d.notes.push({ t, b }), savePdf: async () => ({ ok: false }), openPath() {}, openUri() {}, showInFolder() {},
    now: () => 1e12, setTimeout: () => ({}), clearTimeout() {}, update: { check: async () => null, run: async () => false },
  };
  d.last = () => d.pills[d.pills.length - 1];
  return d;
}
(async () => {
  {
    // A fresh install with a current helper: the welcome card, pill hidden behind it, and all apps by default.
    const d = desk(); const c = createCore(d.io);
    await c.start();
    check('fresh install reads from all apps (the current copy is read at start)', d.reads === 1 && c.readsEverything() === true);
    c.focus({ app: 'slack', title: 'x - Slack' }, 23);
    const w = d.last().setup;
    check('welcome card: no questions, says what Morph does', w && w.welcome === true && w.title === 'Morph is ready' && /any app, except password managers/.test(w.body[0]) && !w.opts && !w.start);
    check('welcome card lists the ten tools with their logos', w.apps.length === 10 && w.apps.find((a) => a.name === 'Slack').logo === 'slack' && w.apps.find((a) => a.name === 'GitHub').logo === 'github' && w.apps.find((a) => a.name === 'Terminal').logo === 'terminal');
    check('welcome card says where to change it, and mentions the update check', /Settings → Apps/.test(w.foot) && /checks for updates once a day/.test(w.foot) && /never leaves this computer/.test(w.foot));
    check('the pill waits behind the welcome card', d.last().visible === false);
    check('copies are read from any app', c.mayRead() === true);
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 23);
    check('…including apps that are not one of the ten', c.mayRead() === true);
    c.focus({ app: '1password', title: '1Password' }, 23);
    check('password managers are never read', c.mayRead() === false && /Password manager/.test(d.last().source.title));
    c.focus({ app: 'org.keepassxc.KeePassXC', title: 'Passwords - KeePassXC' }, 23);
    check('KeePassXC is skipped too', c.mayRead() === false);
    c.focus({ app: 'slack', title: 'x - Slack' }, 23);
    c.action('setup:ok');
    check('Got it: the card is gone and the pill shows', !d.last().setup && d.last().visible !== false && JSON.parse(d.saved).setupDone === true);
    c.action('setup:settings');
    check('the card cannot be answered twice', !d.last().setup);
  }
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 23);
    c.action('setup:settings');
    check('Open Settings: the pill opens on the Apps page', d.last().openNow === true && d.last().pane && d.last().pane.title === 'Apps');
  }
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 14);
    check('an older helper gets no card and shows the pill', !d.last().setup && d.last().visible !== false);
    c.action('setup:01111111100');
    check('an old-style setup answer is ignored', JSON.parse(d.saved || '{}').setupDone !== true);
  }
  {
    // Settings → Apps: one list, two ways.
    const d = desk(JSON.stringify({ setupDone: true })); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 23);
    c.action('view:edit');
    let pane = d.last().pane;
    check('Apps page: "All apps" is on by default, and lists what it converts for', pane.opts[0].label === 'All apps' && pane.opts[0].sw === 'on' && /Slack.*Terminal/.test(JSON.stringify(pane.blocks)) && !pane.apps);
    c.action('view:main');
    check('All apps: the pill offers every other format (Slack is the app in front)', ['jira', 'email', 'markdown', 'text', 'notion'].every((x) => JSON.stringify(d.last().options).includes('"dest":"' + x + '"')));
    c.action('view:edit');
    c.action('toggle:readfrom');
    pane = d.last().pane;
    check('Only these apps: the ten apps with switches, the usual eight on', JSON.parse(d.saved).readFrom === 'listed' && pane.apps.length === 10 && pane.apps.filter((a) => a.sw === 'on').length === 8 && pane.apps.every((a) => /^rule:/.test(a.action)) && pane.appsFixed === true);
    check('the switches change the same list that decides reading', c.mayRead() === true);
    c.action('view:main');
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 23);
    check('Only these apps: a copy from another app is not read', c.mayRead() === false && d.reads === 1);
    const sp = d.last();
    check('skipped copy: says why and how to change it', sp.source.title === 'Skipped on purpose' && /not one of your apps/.test(sp.source.sub) && /"All apps" in Settings, Apps/.test(sp.source.sub));
    check('skipped copy: an app can still be picked (a click is you asking)', JSON.stringify(sp).includes('"action":"fix:'));
    c.action('rule:terminal');
    check('switching Terminal on makes terminal copies readable', c.mayRead() === true);
    c.focus({ app: 'slack', title: 'x - Slack' }, 23);
    c.action('rule:slack');
    check('switching Slack off stops reading from Slack', c.mayRead() === false);
    c.action('view:main');
    check('…and the pill no longer offers Slack', !JSON.stringify(d.last().options || []).includes('"fix:slack"'));
    ['jira', 'confluence', 'outlook', 'gdocs', 'notion', 'linear', 'teams', 'github', 'terminal'].forEach((id) => c.action('rule:' + id));
    const left = JSON.parse(d.saved).rules.filter((r) => ['slack', 'jira', 'confluence', 'outlook', 'gdocs', 'notion', 'linear', 'teams', 'github', 'terminal'].includes(r.id) && r.enabled);
    check('the last app cannot be switched off', left.length === 1);
    c.action('toggle:readfrom');
    check('back to All apps reads everywhere again', JSON.parse(d.saved).readFrom === 'any' && c.mayRead() === true);
  }
  {
    // Privacy page: the read log and what is never read. Which apps lives on the Apps page only.
    const d = desk(JSON.stringify({ setupDone: true, readFrom: 'listed' })); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 23);
    c.mayRead();
    c.action('view:privacy');
    const pane = d.last().pane;
    const items = JSON.stringify(pane.blocks || []);
    check('Privacy: read log shows the skip, without content', /Skipped a copy from/.test(items) && !/hello/.test(items));
    check('Privacy: lists what is never read', /Never read/.test(items) && /Password managers/.test(items));
    check('Privacy: no switch of its own; it points to Apps', !pane.opts && pane.actions[0].action === 'view:edit');
    check('table OCR has its own page, not Privacy', !/table OCR/i.test(items) && d.last().nav.some((n) => n.action === 'view:ocr'));
    c.action('view:ocr');
    check('Image tables page shows the OCR controls', d.last().pane.title === 'Image tables' && /Enable table OCR|Table OCR/.test(JSON.stringify(d.last().pane.blocks)));
  }
  {
    const d = desk(JSON.stringify({ setupDone: true, readFrom: 'listed' })); const c = createCore(d.io);
    await c.start();
    check('only-these-apps mode never reads at start', d.reads === 0);
  }
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (privacy)');
  process.exit(failed ? 1 : 0);
})();
