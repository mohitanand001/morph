// The upgrade path: version comparison, the daily check in the background program (fake desktop), and the
// real `morph --update` run against a pretend website made of local files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const { createCore, newer } = require('../daemon/core');
let passed = 0; let failed = 0;
function check(n, c, d) { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')); } }

check('0.14.0-rc.6 is newer than rc.5', newer('0.14.0-rc.6', '0.14.0-rc.5'));
check('rc.5 is not newer than rc.5', !newer('0.14.0-rc.5', '0.14.0-rc.5'));
check('0.14.0 is newer than any rc of it', newer('0.14.0', '0.14.0-rc.9'));
check('rc is not newer than the release', !newer('0.14.0-rc.9', '0.14.0'));
check('0.15.0-rc.1 is newer than 0.14.0', newer('0.15.0-rc.1', '0.14.0'));
check('0.9.0 is older than 0.10.0', !newer('0.9.0', '0.10.0'));
check('junk is never newer', !newer('latest', '0.14.0') && !newer('', '0.14.0') && !newer(undefined, '0.14.0'));

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
function desk(extra) {
  const d = { t: 1e12, timers: [], pills: [], notes: [], saved: (extra && extra.saved) || '{"setupDone":true}', checks: 0, runs: 0, remote: { version: '0.14.0-rc.9' } };
  d.advance = (ms) => { const end = d.t + ms; for (;;) { const due = d.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; d.timers = d.timers.filter((x) => x !== due); d.t = due.at; due.fn(); } d.t = end; };
  d.io = {
    version: '0.14.0-rc.5', home: '/h', log() {}, store: { read: () => d.saved, write: (s) => { d.saved = s; } },
    shell: { setPill: (s) => d.pills.push(JSON.parse(JSON.stringify(s))), readClip: async () => null, writeClip: async () => true, paste() {}, setShortcuts: async () => [] },
    notify: (t, b) => d.notes.push({ t, b }), savePdf: async () => ({ ok: false }), openPath() {}, openUri() {}, showInFolder() {},
    now: () => d.t, setTimeout: (fn, ms) => { const x = { fn, at: d.t + ms }; d.timers.push(x); return x; }, clearTimeout: (x) => { d.timers = d.timers.filter((y) => y !== x); },
    update: { check: async () => { d.checks++; return d.remote; }, run: () => { d.runs++; return new Promise((r) => { d.finish = r; }); } },
  };
  d.last = () => d.pills[d.pills.length - 1];
  return d;
}
const general = (d, c) => { c.action('view:settings'); return d.last().pane.opts; };

(async () => {
  {
    const d = desk(); const c = createCore(d.io);
    await c.start();
    check('no check at the very start (waits a moment)', d.checks === 0);
    d.advance(21000); await settle();
    check('checks shortly after start', d.checks === 1);
    check('says once that an update is available', d.notes.filter((n) => /0\.14\.0-rc\.9 is available/.test(n.t)).length === 1);
    const opts = general(d, c);
    check('General offers the update', opts.some((o) => /Update to 0\.14\.0-rc\.9/.test(o.label) && o.action === 'update:'));
    c.action('update:'); await settle();
    check('clicking it hands over to the updater once', d.runs === 1);
    check('the row shows it is working', general(d, c).some((o) => o.label === 'Updating…'));
    c.action('update:'); await settle();
    check('a second click does nothing while updating', d.runs === 1);
    d.finish(false); await settle();
    check('a failed update stops saying Updating… and tells you', !general(d, c).some((o) => o.label === 'Updating…') && d.notes.some((n) => /did not finish/.test(n.t)));
    const hours = async (n) => { for (let i = 0; i < n; i++) { d.advance(3600 * 1000); await settle(); } };
    await hours(5);
    check('not asked again within a day', d.checks === 1);
    await hours(20);
    check('asked again after a day', d.checks === 2, String(d.checks));
    check('the same version is not announced twice', d.notes.filter((n) => /is available/.test(n.t)).length === 1);
  }
  {
    const d = desk(); d.remote = { version: '0.14.0-rc.5' };
    const c = createCore(d.io); await c.start(); d.advance(21000); await settle();
    check('same version: nothing announced, no update row', d.notes.length === 0 && !general(d, c).some((o) => /Update/.test(o.label)));
  }
  {
    const d = desk({ saved: JSON.stringify({ updateCheck: false }) });
    const c = createCore(d.io); await c.start(); for (let i = 0; i < 30; i++) { d.advance(3600 * 1000); await settle(); }
    check('turned off: never asks', d.checks === 0);
    c.action('view:settings'); c.action('toggle:updates'); await settle();
    check('turning it on checks right away', d.checks === 1 && JSON.parse(d.saved).updateCheck === true);
  }
  {
    const d = desk(); d.io.update.check = async () => null;
    const c = createCore(d.io); await c.start(); d.advance(21000); await settle();
    check('website unreachable: quietly nothing', d.notes.length === 0);
  }

  // --- with a current helper (v12): real buttons, a manual check, and a confirmation dialog for Uninstall
  {
    const d = desk(); d.uninstalls = 0;
    d.io.uninstall = { run: async () => { d.uninstalls++; return true; } };
    const c = createCore(d.io); await c.start();
    c.focus({ app: 'firefox', title: 'x' }, 12);
    c.action('view:settings');
    check('v12: Updates and Uninstall have their own sections', d.last().nav.map((n) => n.label).join() === 'General,Apps,Shortcuts,Privacy,Size,Updates,Uninstall,About');
    check('v12: General no longer carries them', !(d.last().pane.actions || []).length && !d.last().pane.opts.some((o) => /pdate|ninstall/.test(o.label)));
    c.action('view:updates');
    const acts = () => d.last().pane.actions;
    check('Updates says you are on the latest, with a refresh button', /latest/.test(acts()[0].label) && acts()[0].trail === 'refresh' && acts()[0].action === 'checkupdate:');
    const before = d.checks;
    c.action('checkupdate:');
    check('refresh shows "Checking…" at once', acts()[0].label === 'Checking…');
    await settle();
    check('refresh asks the website now and shows the answer', d.checks === before + 1 && /0\.14\.0-rc\.9 is available/.test(acts()[0].label) && acts().some((a) => /^Update to/.test(a.label)));
    d.remote = { version: '0.14.0-rc.5' };
    d.io.update.check = async () => d.remote;
    c.action('checkupdate:'); await settle();
    check('refresh when current says latest', /latest/.test(acts()[0].label) && !acts().some((a) => /^Update to/.test(a.label)));
    d.io.update.check = async () => null;
    c.action('checkupdate:'); await settle();
    check('refresh with no connection says so', /Could not reach/.test(acts()[0].label));
    check('the daily switch lives in Updates', d.last().pane.opts.some((o) => o.action === 'toggle:updates'));
    c.action('view:uninstall');
    check('Uninstall section: one button with a confirmation for the helper', acts().length === 1 && acts()[0].action === 'uninstall:' && acts()[0].confirm && acts()[0].confirm.ok === 'Uninstall');
    c.action('uninstall:'); await settle();
    check('v12: the confirmed action uninstalls straight away (the dialog already asked)', d.uninstalls === 1);
  }
  // --- with the newest helper (v13): a status card, last-checked time, retry, and a real uninstall page
  {
    const d = desk(); d.uninstalls = 0;
    d.io.uninstall = { run: async () => { d.uninstalls++; return true; } };
    const c = createCore(d.io); await c.start();
    c.focus({ app: 'firefox', title: 'x' }, 13);
    c.action('view:updates');
    const card = () => d.last().pane.blocks[0];
    check('v13: up to date shows the teal check, a button, and version + last checked', card().tone === 'ok' && card().icon === 'check_circle' && card().button.label === 'Check for updates' && card().items[0] === 'Installed version: ' + d.io.version && /^Last checked: Not yet$/.test(card().items[1]));
    check('v13: automatic checking is its own row', d.last().pane.opts.length === 1 && d.last().pane.opts[0].action === 'toggle:updates');
    c.action('checkupdate:');
    check('v13: loading state while checking, button disabled', card().title === 'Checking for updates…' && card().button.disabled === true);
    await settle();
    check('v13: update available is amber with Update now', card().tone === 'warn' && /is available/.test(card().title) && card().button.label === 'Update now' && card().button.action === 'update:' && /^Last checked: Today at /.test(card().items[1]));
    d.io.update.check = async () => null;
    c.action('checkupdate:'); await settle();
    check('v13: an error offers Retry', card().icon === 'error' && card().button.label === 'Retry' && card().button.action === 'checkupdate:');
    d.remote = { version: '0.14.0-rc.5' }; d.io.update.check = async () => d.remote;
    c.action('checkupdate:'); await settle();
    check('v13: retry that works goes back to up to date', card().tone === 'ok');
    c.action('view:uninstall');
    const bl = d.last().pane.blocks, btns = bl[bl.length - 1].buttons;
    check('v13: uninstall page heading and two actions, secondary first', d.last().pane.title === 'Uninstall Morph' && btns.length === 2 && btns[0].label === 'Keep Morph' && btns[0].kind === 'secondary' && btns[1].kind === 'danger' && btns[1].confirm);
    check('v13: lists what is removed and says what happens to data', bl.some((b) => b.items && b.items.length === 6) && bl.some((b) => /settings/i.test(b.title || '') && b.tone === 'warn'));
    c.action('view:settings');
    check('v13: Keep Morph goes back, nothing removed', d.uninstalls === 0 && d.last().pane.title === 'General');
  }
  // --- the Uninstall row asks twice
  {
    const d = desk(); d.uninstalls = 0;
    d.io.uninstall = { run: async () => { d.uninstalls++; return true; } };
    const c = createCore(d.io); await c.start();
    const row = () => general(d, c).find((o) => o.action === 'uninstall:');
    check('the Uninstall row is offered', row() && row().label === 'Uninstall Morph');
    c.action('uninstall:'); await settle();
    check('one click only asks', d.uninstalls === 0 && row().label === 'Click again to uninstall');
    d.advance(9000); await settle();
    check('the question goes away by itself', row().label === 'Uninstall Morph');
    c.action('uninstall:'); c.action('uninstall:'); await settle();
    check('a second click uninstalls, once', d.uninstalls === 1 && d.notes.some((n) => /Removing Morph/.test(n.t)));
  }
  // --- the real installer script against a pretend website
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-upd-'));
  const site = path.join(tmp, 'site'); fs.mkdirSync(site);
  const build = (version) => {
    const copy = path.join(tmp, 'src-' + version); fs.mkdirSync(copy);
    execFileSync('bash', ['-c', `cd "${path.join(__dirname, '..')}" && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -xf - -C "${copy}"`]);
    const pj = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8')); pj.version = version; fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify(pj));
    return execFileSync('bash', [path.join(copy, 'tools', 'build-linux-zip.sh'), site], { encoding: 'utf8' }).trim();
  };
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch (e) { console.log('ok ' + passed + ' passed, 0 failed (update; installer part skipped, no zip tools)'); process.exit(0); }
  build('9.9.9');
  const meta = JSON.parse(fs.readFileSync(path.join(site, 'version.json'), 'utf8'));
  check('the build writes version.json with a fingerprint', meta.version === '9.9.9' && /^[0-9a-f]{64}$/.test(meta.sha256) && meta.zip === 'morph-9.9.9-linux.zip');
  const inst = path.join(tmp, 'install'); fs.mkdirSync(inst);
  execFileSync('unzip', ['-q', path.join(site, meta.zip), '-d', inst]);
  // An "old" install: same files with an older version number.
  const app = path.join(inst, 'morph');
  fs.writeFileSync(path.join(app, 'package.json'), '{\n  "name": "morph",\n  "version": "0.1.0"\n}\n');
  fs.writeFileSync(path.join(app, 'daemon', 'core.js'), '// old');
  const env = Object.assign({}, process.env, { MORPH_UPDATE_URL: 'file://' + path.join(site, 'version.json'), FB_NO_INSTALL: '1', HOME: tmp });
  const r = spawnSync('bash', [path.join(app, 'bin', 'morph'), '--update'], { env, encoding: 'utf8' });
  check('--update succeeds', r.status === 0, r.stdout + r.stderr);
  check('--update replaced the old files', /9\.9\.9/.test(fs.readFileSync(path.join(app, 'package.json'), 'utf8')) && fs.readFileSync(path.join(app, 'daemon', 'core.js'), 'utf8').length > 1000);
  check('the installer is still executable afterwards', (fs.statSync(path.join(app, 'bin', 'morph')).mode & 0o111) !== 0);
  const again = spawnSync('bash', [path.join(app, 'bin', 'morph'), '--update'], { env, encoding: 'utf8' });
  check('--update again says it is up to date', again.status === 0 && /up to date/.test(again.stdout), again.stdout + again.stderr);
  // A damaged download is refused.
  fs.writeFileSync(path.join(site, 'version.json'), JSON.stringify(Object.assign({}, meta, { sha256: '0'.repeat(64), version: '9.9.10' })));
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"morph","version":"0.1.0"}');
  const bad = spawnSync('bash', [path.join(app, 'bin', 'morph'), '--update'], { env, encoding: 'utf8' });
  check('a download that does not match its fingerprint is refused', bad.status !== 0 && /fingerprint/.test(bad.stdout) && /0\.1\.0/.test(fs.readFileSync(path.join(app, 'package.json'), 'utf8')), bad.stdout);
  // --- --purge removes everything it added, and only a real Morph folder
  {
    const home = path.join(tmp, 'home'); fs.mkdirSync(home);
    const mk = (f, c) => { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), c || 'x'); };
    execFileSync('unzip', ['-q', path.join(site, meta.zip), '-d', home]);
    mk('.config/morph/settings.json'); mk('.config/autostart/morph.desktop'); mk('.cache/morph.log'); mk('.local/bin/morph');
    mk('.local/share/morph-ocr/ready'); mk('.cache/formatter-icons/slack.svg'); mk('.config/formatter/settings.json'); mk('run/morph/clip-image.png');
    mk('.bashrc', 'keep me\n# morph PATH\nexport PATH="$HOME/.local/bin:$PATH"\nkeep me too\n');
    const penv = Object.assign({}, process.env, { HOME: home, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '', XDG_RUNTIME_DIR: path.join(home, 'run') });
    delete penv.XDG_CONFIG_HOME; delete penv.XDG_CACHE_HOME;
    const pr = spawnSync('bash', [path.join(home, 'morph', 'bin', 'morph'), '--uninstall'], { env: penv, encoding: 'utf8' });
    check('--uninstall succeeds', pr.status === 0, pr.stdout + pr.stderr);
    check('--uninstall leaves no trace: settings, login entry, command, log, OCR, caches, old Formatter data and the folder', ['.config/morph', '.config/formatter', '.config/autostart/morph.desktop', '.local/bin/morph', '.cache/morph.log', '.local/share/morph-ocr', '.cache/formatter-icons', 'run/morph', 'morph'].every((f) => !fs.existsSync(path.join(home, f))), pr.stdout);
    const rc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
    check('--uninstall takes only its own lines out of .bashrc', rc === 'keep me\nkeep me too\n', JSON.stringify(rc));
    // A folder that isn't Morph's is left alone.
    const odd = path.join(home, 'stuff', 'bin'); fs.mkdirSync(odd, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'bin', 'morph'), path.join(odd, 'morph'));
    fs.writeFileSync(path.join(home, 'stuff', 'precious.txt'), 'x');
    const pr2 = spawnSync('bash', [path.join(odd, 'morph'), '--uninstall'], { env: penv, encoding: 'utf8' });
    check('--uninstall leaves a folder that is not Morph\'s', fs.existsSync(path.join(home, 'stuff', 'precious.txt')) && /Left .* alone/.test(pr2.stdout), pr2.stdout);
  }
  {
    // --purge still works as the same thing.
    const home2 = path.join(tmp, 'home2'); fs.mkdirSync(home2);
    execFileSync('unzip', ['-q', path.join(site, meta.zip), '-d', home2]);
    const e2 = Object.assign({}, process.env, { HOME: home2 }); delete e2.XDG_CONFIG_HOME; delete e2.XDG_CACHE_HOME;
    const r3 = spawnSync('bash', [path.join(home2, 'morph', 'bin', 'morph'), '--purge'], { env: e2, encoding: 'utf8' });
    check('--purge is the same as --uninstall', r3.status === 0 && !fs.existsSync(path.join(home2, 'morph')), r3.stdout + r3.stderr);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (update)');
  process.exit(failed ? 1 : 0);
})();
