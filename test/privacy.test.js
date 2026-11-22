// Privacy: nothing is read until setup is answered; in "only my apps" mode a copy from another app is never read.
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
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 14);
    check('before setup: no read at start', d.reads === 0);
    check('before setup: a copy is not read', c.mayRead() === false && d.reads === 0);
    check('before setup: the helper is asked for the setup page, pill hidden', !!d.last().setup && d.last().visible === false);
    const sp = d.last().setup;
    check('setup offers the ten apps with the usual defaults', sp.apps.length === 10 && sp.apps.filter((a) => a.on).length === 8 && !sp.apps.find((a) => a.name === 'Terminal').on && !sp.apps.find((a) => a.name === 'GitHub').on);
    check('each app carries its logo name', sp.apps.every((a) => typeof a.dest === 'string' && a.dest) && sp.apps.find((a) => a.name === 'Slack').dest === 'slack' && sp.apps.find((a) => a.name === 'Jira').dest === 'jira');
    check('setup wording', /Your clipboard stays on your device/.test(sp.lede) && sp.appsLabel === 'Choose your apps' && /reads and formats only in these apps\.$/.test(sp.appsNote) && sp.updSub === 'Automatically checks whether a newer version is available.' && sp.none === 'Select at least one app to continue.');
    c.action('setup:00000000000');
    check('no app ticked: setup does not finish', JSON.parse(d.saved || '{}').setupDone !== true && !!d.last().setup);
    c.action('setup:0');
    check('a malformed answer is ignored', JSON.parse(d.saved || '{}').setupDone !== true);
    c.action('setup:01111111100');
    check('setup saved: only my apps, updates off', JSON.parse(d.saved).readFrom === 'listed' && JSON.parse(d.saved).setupDone === true && JSON.parse(d.saved).updateCheck === false);
    const rules = JSON.parse(d.saved).rules;
    check('the ticked apps are the enabled rules', rules.find((r) => r.id === 'slack').enabled && !rules.find((r) => r.id === 'terminal').enabled);
    check('after setup the page is gone', !d.last().setup);
    check('listed app: copy may be read', c.mayRead() === true);
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 14);
    check('unlisted app: copy is not read', c.mayRead() === false && d.reads === 0);
    check('the pill says it was not read', /Not read: copied from/.test(c.state.clipStatus));
    {
      const sp2 = d.last();
      check('skipped copy: the pill says it was skipped on purpose, not "Copied from Not read"', sp2.source.title === 'Skipped on purpose' && /Copied from .*not one of your apps/.test(sp2.source.sub) && /Read copies from all apps/.test(sp2.source.sub) && !/Copied from Not read/.test(JSON.stringify(sp2.source)));
      check('skipped copy: apps can still be picked (a click is you asking)', (sp2.options || []).concat(sp2.tab || []).some((o) => o.action && /^fix:/.test(o.action)) || JSON.stringify(sp2).includes('"action":"fix:'));
    }
    c.action('view:settings'); c.action('view:privacy');
    const items = JSON.stringify(d.last().pane.blocks || []);
    check('read log shows the skip, without content', /Skipped a copy from/.test(items) && !/hello/.test(items));
    c.action('toggle:readfrom');
    check('switching to any app is saved', JSON.parse(d.saved).readFrom === 'any' && c.readsEverything() === true);
    check('any app: a copy may be read', c.mayRead() === true);
    c.focus({ app: '1password', title: '1Password' }, 14);
    check('all apps still skips password managers', c.mayRead() === false && /Password manager/.test(d.last().source.title));
    c.focus({ app: 'org.keepassxc.KeePassXC', title: 'Passwords - KeePassXC' }, 14);
    check('KeePassXC is skipped too', c.mayRead() === false);
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 14);
    check('other apps are read again', c.mayRead() === true);
  }
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'gnome-terminal-server', title: 'bash' }, 14);
    c.action('setup:11111111111');
    check('ticking Terminal in setup makes terminal copies readable', c.mayRead() === true);
  }
  {
    const d = desk(JSON.stringify({ setupDone: true, readFrom: 'any' })); const c = createCore(d.io);
    await c.start();
    check('any app mode reads at start', d.reads === 1);
  }
  {
    const d = desk(JSON.stringify({ setupDone: true, readFrom: 'listed' })); const c = createCore(d.io);
    await c.start();
    check('only-my-apps mode never reads at start', d.reads === 0);
    c.action('setup:11111111111');
    check('setup cannot be redone by a stray action', JSON.parse(d.saved).readFrom === 'listed');
  }
  {
    // The two new switches in the first-run page (helper 17): all apps on by default, auto format off.
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 22);
    const so = d.last().setup.opts || [];
    const pick = (g) => g && g.choices[g.sel];
    check('setup: "Where should Morph work?" defaults to All apps (any app, except password managers)', so[0] && so[0].id === 'all' && /Where should Morph work/.test(so[0].title) && pick(so[0]).bit === '1' && pick(so[0]).label === 'All apps' && /except password managers/.test(pick(so[0]).sub) && so[0].choices[1].bit === '0' && /Only the apps I choose/.test(so[0].choices[1].label));
    check('setup warns that formats cover only some tools for now', /Formats are supported for Slack.*Terminal for now/.test(d.last().setup.fmtNote) && /pick a format from the pill/.test(d.last().setup.fmtNote));
    check('setup: "Convert" defaults to picking in the pill; automatic says it rewrites the clipboard', so[1] && so[1].id === 'auto' && so[1].title === 'Convert' && pick(so[1]).bit === '0' && /pick an app in the pill/.test(pick(so[1]).label) && so[1].choices[1].bit === '1' && /rewrites your clipboard/.test(so[1].choices[1].sub));
    check('GitHub and Terminal tiles have their own icons', d.last().setup.apps.some((a) => a.name === 'GitHub' && a.logo === 'github') && d.last().setup.apps.some((a) => a.name === 'Terminal' && a.logo === 'terminal'));
    c.action('setup:1111111111' + '1' + '1' + '0');
    check('answer with defaults: reads from all apps, auto format off', JSON.parse(d.saved).readFrom === 'any' && JSON.parse(d.saved).autoFormat === false && c.readsEverything() === true);
  }
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 22);
    c.action('setup:1' + '1111111100' + '01');
    check('all apps off, auto format on are both honoured', JSON.parse(d.saved).readFrom === 'listed' && JSON.parse(d.saved).autoFormat === true);
  }
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 14);
    check('an older helper is not shown switches it cannot draw', (d.last().setup.opts || []).length === 0);
    c.action('setup:01111111100');
    check('an older helper answer keeps reading to the listed apps', JSON.parse(d.saved).readFrom === 'listed' && JSON.parse(d.saved).autoFormat === false);
  }
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (privacy)');
  process.exit(failed ? 1 : 0);
})();
