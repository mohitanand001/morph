// Morph Lab: drives a real, headless GNOME Shell with Morph's real helper and real background program, and
// stand-in apps that copy and paste through the real Wayland clipboard. Tests read like what a person does:
//
//   const docs = await lab.app('gdocs');  await docs.focus();  await docs.copy({ text, html });
//   const jira = await lab.app('jira');   await jira.focus();
//   await lab.open();  await lab.click('Jira');  const got = await jira.paste();
//
// Everything a step sees (Morph's actors with their positions, its state, the screen) is recorded for the report.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const UUID = 'morph-focus@morph.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The apps the lab can stand in for: the app id and window title Morph's rules look for.
const APPS = {
  slack: { app: 'com.slack.Slack', title: 'general - Slack', color: '#4a154b' },
  jira: { app: 'firefox', title: 'PROJ-1 Fix login - Jira', color: '#0052cc' },
  confluence: { app: 'firefox', title: 'Team home - Confluence', color: '#1868db' },
  gdocs: { app: 'firefox', title: 'Plan - Google Docs', color: '#1a73e8' },
  outlook: { app: 'outlook', title: 'Inbox - Outlook', color: '#0f6cbd' },
  notion: { app: 'notion', title: 'Roadmap - Notion', color: '#191919' },
  editor: { app: 'org.gnome.TextEditor', title: 'notes.txt - Text Editor', color: '#777777' },
  keepass: { app: 'org.keepassxc.KeePassXC', title: 'Passwords - KeePassXC', color: '#3c7b3c' },
};

class Lab {
  constructor(dir) {
    this.dir = dir;                       // test-results/lab
    this.home = process.env.HOME;
    this.env = Object.assign({}, process.env, { GTK_A11Y: 'none', NO_AT_BRIDGE: '1', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', GDK_BACKEND: 'wayland' });
    this.pending = new Map();
    this.seq = 0;
    this.apps = new Map();
    this.steps = [];                      // the current scenario's record
    this.shotN = 0;
  }

  // ---- the desktop
  async start() {
    for (const [schema, key, val] of [
      ['org.gnome.shell', 'enabled-extensions', `['${UUID}']`],
      ['org.gnome.shell', 'disable-user-extensions', 'false'],
      ['org.gnome.shell', 'disable-extension-version-validation', 'true'],
      ['org.gnome.shell', 'welcome-dialog-last-shown-version', "'999'"],
      ['org.gnome.desktop.interface', 'enable-animations', 'false'],
      ['org.gnome.desktop.notifications', 'show-banners', 'false'],
    ]) spawnSync('gsettings', ['set', schema, key, val], { env: this.env });
    this.installHelper();
    fs.mkdirSync(this.dir, { recursive: true });
    this.shellLog = fs.openSync(path.join(this.dir, 'gnome-shell.log'), 'w');
    this.shell = spawn('gnome-shell', ['--headless', '--wayland', '--no-x11', '--virtual-monitor', '1280x800', '--unsafe-mode', '--sm-disable'], { env: this.env, stdio: ['ignore', this.shellLog, this.shellLog] });
    this.bridge = spawn('gjs', ['-m', path.join(__dirname, 'bridge.js')], { env: this.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    this.bridge.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
      }
    });
    await this.waitFor('GNOME Shell answers', async () => { try { return (await this.eval('1')) === 1; } catch (e) { return false; } }, 30000);
    await this.eval(fs.readFileSync(path.join(__dirname, 'driver.js'), 'utf8'));
    await this.waitFor('Morph\'s GNOME helper is loaded', async () => (await this.lab('state()')).loaded, 20000);
  }
  // As bin/morph --install lays it out: the loader, and the real helper under its fingerprint.
  installHelper() {
    const src = path.join(ROOT, 'gnome-extension', UUID);
    const dest = path.join(process.env.XDG_DATA_HOME, 'gnome-shell', 'extensions', UUID);
    fs.mkdirSync(dest, { recursive: true });
    const impl = 'impl-' + crypto.createHash('sha256').update(fs.readFileSync(path.join(src, 'extension.js'))).digest('hex').slice(0, 8) + '.js';
    fs.copyFileSync(path.join(src, 'loader.js'), path.join(dest, 'extension.js'));
    fs.copyFileSync(path.join(src, 'extension.js'), path.join(dest, impl));
    fs.copyFileSync(path.join(src, 'metadata.json'), path.join(dest, 'metadata.json'));
    fs.copyFileSync(path.join(src, 'stylesheet.css'), path.join(dest, 'stylesheet.css'));
    fs.writeFileSync(path.join(dest, 'impl.txt'), impl + '\n');
  }
  async stop() {
    await this.closeApps();
    this.stopDaemon();
    try { this.bridge.stdin.end(); } catch (e) { /* gone */ }
    if (this.shell) { this.shell.kill('SIGTERM'); await new Promise((r) => { this.shell.once('exit', r); setTimeout(r, 4000); }); }
  }

  // ---- talking to it
  request(o) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.bridge.stdin.write(JSON.stringify(Object.assign({ id }, o)) + '\n');
    });
  }
  async eval(code) {
    const m = await this.request({ op: 'eval', code });
    if (!m.ok) throw new Error('Eval failed: ' + m.error);
    const [ok, out] = m.result;
    if (!ok) throw new Error('In GNOME Shell: ' + out);
    return out === '' || out === undefined ? undefined : JSON.parse(out);
  }
  lab(expr) { return this.eval('__morphLab.' + expr); }
  call(dest, objPath, iface, method, sig, args, out) { return this.request({ op: 'call', dest, path: objPath, iface, method, sig, args, out }); }
  async waitFor(what, fn, timeout = 8000, every = 100) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try { last = await fn(); if (last) return last; } catch (e) { last = e; }
      await sleep(every);
    }
    throw new Error('Timed out waiting: ' + what + (last instanceof Error ? ' (' + last.message + ')' : ''));
  }
  // Waits until Morph has stopped changing (same state and same actors for a moment).
  async settle(ms = 250) {
    let prev = '';
    await this.waitFor('Morph to settle', async () => {
      const now = JSON.stringify([await this.lab('state()'), await this.lab('tree()')]);
      const same = now === prev; prev = now; return same;
    }, 8000, ms);
  }

  // ---- Morph's background program, fresh for every scenario
  // trace: run Morph's program under strace, recording every network connection it (or a child) opens.
  async reset({ settings, trace } = {}) {
    if (this.shell && this.shell.exitCode !== null) {
      // GNOME Shell stopped (it can, in a headless test session): start a fresh one so one crash doesn't fail every
      // scenario after it. The report says so.
      this.restarts = (this.restarts || 0) + 1;
      this.steps.push({ kind: 'step', text: 'GNOME Shell had stopped; the lab started it again' });
      this.apps.clear();
      await this.start();
    }
    await this.closeApps();
    const old = this.daemon;
    this.stopDaemon();
    if (old) await new Promise((r) => { if (old.exitCode !== null) r(); else { old.once('exit', r); setTimeout(r, 3000); } });
    const cfg = path.join(process.env.XDG_CONFIG_HOME, 'morph');
    fs.mkdirSync(cfg, { recursive: true });
    const file = path.join(cfg, 'settings.json');
    if (settings === null) { try { fs.unlinkSync(file); } catch (e) { /* none */ } }
    else fs.writeFileSync(file, JSON.stringify(Object.assign({ setupDone: true }, settings || {})));
    this.daemonLog = fs.openSync(path.join(this.dir, 'morph-daemon.log'), 'a');
    const main = ['gjs', '-m', path.join(ROOT, 'daemon', 'gjs-main.js')];
    this.traceFile = trace ? path.join(this.dir, 'network-trace.txt') : '';
    const cmd = trace ? ['strace', '-f', '-qq', '-e', 'trace=connect,execve', '-s', '300', '-o', this.traceFile, ...main] : main;
    this.daemon = spawn(cmd[0], cmd.slice(1), { env: Object.assign({}, this.env, { FB_DEBUG: '1' }), stdio: ['ignore', this.daemonLog, this.daemonLog] });
    await this.waitFor('Morph\'s helper to accept Morph\'s program', async () => (await this.lab('state()')).peer, 15000);
    await this.waitFor('the tab (or the welcome card) to show', async () => { const st = await this.lab('state()'); return st.visible || st.setup; }, 15000);
    await this.settle();
  }
  // Stops only the program this lab started (never anything else running on the computer).
  stopDaemon() {
    if (this.daemon) { try { this.daemon.kill('SIGTERM'); } catch (e) { /* gone */ } this.daemon = null; }
  }

  // ---- stand-in apps
  async app(key, over = {}) {
    if (this.apps.has(key)) return this.apps.get(key);
    const spec = Object.assign({}, APPS[key] || { app: 'lab.' + key, title: key }, over);
    const appLog = fs.openSync(path.join(this.dir, 'apps.log'), 'a');
    const proc = spawn('gjs', ['-m', path.join(__dirname, 'fakeapp.js'), '--key', key, '--app', spec.app, '--title', spec.title, '--color', spec.color || '#555'], { env: this.env, stdio: ['ignore', appLog, appLog] });
    const a = new App(this, key, spec, proc);
    this.apps.set(key, a);
    await this.waitFor('the ' + key + ' window', async () => (await this.lab('windows()')).some((w) => w.title === spec.title), 10000);
    await this.waitFor(key + ' to answer', async () => (await a.info()).key === key, 5000);
    return a;
  }
  async closeApps() {
    for (const a of this.apps.values()) { await a.call('Quit', '', []); try { a.proc.kill(); } catch (e) { /* gone */ } }
    this.apps.clear();
    await sleep(150);
  }

  // ---- what a person does
  async open() {
    const st = await this.lab('state()');
    if (!st.open) {
      const r = await this.lab('openPanel()');
      if (!r.ok) throw new Error(r.error);
      await this.waitFor('the panel to open', async () => (await this.lab('state()')).open);
    }
    await this.settle();
    this.note('Opened Morph');
  }
  async click(text, nth) {
    const r = await this.lab('clickText(' + JSON.stringify(text) + ', ' + (nth || 0) + ')');
    if (!r.ok) throw new Error('Click "' + text + '": ' + r.error + '. On screen: ' + (await this.texts()).join(' | '));
    await this.settle();
    this.note('Clicked "' + text + '"');
  }
  async hover(text) { await this.lab('hoverText(' + JSON.stringify(text) + ')'); await sleep(900); this.note('Pointed at "' + text + '"'); }
  async key(combo) { await this.lab('keys(' + JSON.stringify(combo) + ')'); await this.settle(); this.note('Pressed ' + combo); }
  state() { return this.lab('state()'); }
  tree() { return this.lab('tree()'); }
  async texts() { return (await this.tree()).filter((n) => n.text && n.shown).map((n) => n.text); }
  async focused() { return (await this.tree()).find((n) => n.focus) || null; }

  // Runs a step and lists every part of Morph that moved, changed size, appeared or disappeared because of it.
  // "A part" is a box a person can see as a place on the panel: rows, buttons, cards, labels. Glyphs inside a
  // tile and the tooltip don't count. `allow` lists paths that may change (the control you pressed, its slot,
  // the card's message line).
  async shifts(fn, allow = []) {
    // Position and size only: fading in or out in place is not a move.
    const parts = (tr) => tr.filter((n) => !n.path.startsWith('tip') && (n.text || n.box[2] >= 22 || n.box[3] >= 22));
    const key = (n) => n.path + ' @' + n.box.join(',');
    const before = parts(await this.tree());
    await fn();
    await this.settle();
    const after = parts(await this.tree());
    // The card's message line may change (that is the answer to your click); it has room for two lines.
    const msg = before.concat(after).filter((n) => /\bfb-sub\b/.test(n.cls)).map((n) => n.path);
    const allowed = (n) => allow.concat(msg).some((p) => n.path === p || n.path.startsWith(p + '/'));
    const was = new Set(before.map(key)); const now = new Set(after.map(key));
    const moved = before.filter((n) => !now.has(key(n)) && !allowed(n)).map((n) => (n.text ? '"' + n.text + '" ' : '') + n.path + ' was ' + n.box.join(','));
    const appeared = after.filter((n) => !was.has(key(n)) && !allowed(n)).map((n) => (n.text ? '"' + n.text + '" ' : '') + n.path + ' now ' + n.box.join(','));
    return { moved, appeared, ok: !moved.length && !appeared.length, detail: moved.concat(appeared).slice(0, 10).join(' ; ') };
  }
  // The path of the clickable part that shows this text (a row or a button).
  async partOf(text) {
    const tr = await this.tree();
    const label = tr.find((n) => n.text === text || n.name === text);
    if (!label) return null;
    const owners = tr.filter((n) => n.button && (label.path === n.path || label.path.startsWith(n.path + '/')));
    return owners.length ? owners[owners.length - 1].path : label.path;
  }

  // Every connection Morph's program opened that left the computer (anything but local sockets), from strace.
  networkConnections() {
    if (!this.traceFile) return null;
    let t = '';
    try { t = fs.readFileSync(this.traceFile, 'utf8'); } catch (e) { return []; }
    return t.split('\n').filter((l) => /connect\(/.test(l) && /AF_INET6?/.test(l) && !/127\.0\.0\.1|::1|inet_addr\("0\.0\.0\.0"\)/.test(l));
  }
  // Every file under the lab's home folder (where Morph keeps settings, caches and logs) and its private runtime
  // folder, with its content, so a scenario can search all of it.
  filesWritten() {
    const out = [];
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { let c = ''; try { c = fs.readFileSync(p).toString('latin1'); } catch (x) { /* unreadable */ } out.push({ path: p, mode: (fs.statSync(p).mode & 0o777).toString(8), content: c }); } } };
    walk(this.home);
    return out;
  }

  // ---- the record
  note(text) { this.steps.push({ kind: 'step', text, at: Date.now() }); }
  async shot(caption) {
    const file = path.join(this.dir, 'shots', String(++this.shotN).padStart(3, '0') + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await this.call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot', 'Screenshot', 'bbs', [false, false, file], 'bs');
    this.steps.push({ kind: 'shot', caption, file: r.ok ? path.relative(this.dir, file) : '', error: r.ok ? '' : r.error });
  }
}

class App {
  constructor(lab, key, spec, proc) { this.lab = lab; this.key = key; this.spec = spec; this.proc = proc; this.name = 'dev.morph.Lab.App_' + key.replace(/[^A-Za-z0-9_]/g, '_'); }
  call(method, sig, args, out) { return this.lab.call(this.name, '/dev/morph/Lab/App', 'dev.morph.Lab.App', method, sig, args, out); }
  async info() { const r = await this.call('Info', '', [], 's'); return r.ok ? JSON.parse(r.result[0]) : {}; }
  async focus() {
    // In front for GNOME (it decides where keys go) and for the app itself. (Asked again while it isn't: right
    // after GNOME starts, the overview can swallow the first request.)
    let n = 0;
    await this.lab.waitFor(this.key + ' to be in front', async () => {
      if (n++ % 5 === 0) await this.lab.lab('activate(' + JSON.stringify(this.spec.title) + ')');
      const wins = await this.lab.lab('windows()');
      const me = wins.find((w) => w.title === this.spec.title);
      if (!me || !me.focused || wins.some((w) => w.focused && w.title !== this.spec.title)) return false;
      return (await this.info()).focused;
    });
    await sleep(250); // the keyboard follows GNOME's focus a moment later
    await this.lab.settle();
    this.lab.note('Switched to ' + this.key);
  }
  // Selects this text (and formatting) in the app, then presses Ctrl+C in it.
  async copy({ text, html = '' }) {
    await this.call('SetSelection', 'ss', [text, html]);
    // The app confirms it copied (keys sent right after a focus change can still land on the window before).
    const before = (await this.info()).copies;
    for (let i = 0; i < 4; i++) {
      await this.lab.lab('keys("ctrl+c")');
      try { await this.lab.waitFor(this.key + ' to copy', async () => (await this.info()).copies > before, 1500); break; } catch (e) { if (i === 3) throw e; await this.focus(); }
    }
    await sleep(400);
    await this.lab.settle();
    this.lab.note('Copied in ' + this.key + ' (' + text.length + ' characters' + (html ? ', with formatting' : '') + ')');
  }
  // Presses Ctrl+V in the app and returns what it received: { formats, text, html }.
  async paste() {
    const pastedNow = async () => JSON.parse((await this.call('Pasted', '', [], 's')).result[0]);
    const before = (await pastedNow()).n;
    let got = null;
    for (let i = 0; i < 4 && !got; i++) {
      await this.lab.lab('keys("ctrl+v")');
      try { got = await this.lab.waitFor(this.key + ' to paste', async () => { const p = await pastedNow(); return p.n > before ? p : null; }, 2000); } catch (e) { if (i === 3) throw e; await this.focus(); }
    }
    this.lab.note('Pasted in ' + this.key + ': ' + got.text.length + ' characters' + (got.html ? ', with formatting' : ''));
    return got;
  }
}

module.exports = { Lab, APPS, ROOT };
