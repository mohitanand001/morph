#!/usr/bin/env node
// Morph Lab runner.   npm run lab            all scenarios
//                     npm run lab -- paste   only scenarios whose name contains "paste"
// Starts a throwaway GNOME Shell (headless, its own home folder and session bus), runs each scenario against
// Morph's real helper and program, and writes test-results/lab/index.html: every step, screenshot and check.
'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results', 'lab');

function need(cmd, pkg) {
  if (spawnSync('sh', ['-c', 'command -v ' + cmd]).status !== 0) {
    console.error('Morph Lab needs ' + cmd + '. On Ubuntu:  sudo apt install ' + pkg);
    process.exit(2);
  }
}

// ---- Outside: a clean home and session for the whole run, then this script again inside it.
if (!process.env.MORPH_LAB_INNER) {
  need('gnome-shell', 'gnome-shell'); need('gjs', 'gjs'); need('dbus-run-session', 'dbus');
  if (spawnSync('gjs', ['-c', 'imports.gi.versions.Gtk = "4.0"; imports.gi.Gtk;']).status !== 0) { console.error('Morph Lab needs GTK 4 for gjs. On Ubuntu:  sudo apt install gir1.2-gtk-4.0'); process.exit(2); }
  // Remove only what an earlier run wrote (its own folder of results), by name.
  for (const f of ['index.html', 'results.json', 'gnome-shell.log', 'morph-daemon.log']) { try { fs.unlinkSync(path.join(OUT, f)); } catch (e) { /* none */ } }
  try { for (const f of fs.readdirSync(path.join(OUT, 'shots'))) if (/^\d+\.png$/.test(f)) fs.unlinkSync(path.join(OUT, 'shots', f)); } catch (e) { /* none */ }
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'morph-lab-'));
  const env = Object.assign({}, process.env, {
    MORPH_LAB_INNER: '1', HOME: home, XDG_CONFIG_HOME: home + '/.config', XDG_DATA_HOME: home + '/.local/share', XDG_CACHE_HOME: home + '/.cache',
    XDG_RUNTIME_DIR: home + '/run', XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  });
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY; delete env.DBUS_SESSION_BUS_ADDRESS;
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  // GNOME Shell needs a system bus and asks logind about the session. In a container without logind, the shell
  // is told there is no systemd seat (a private mount over /run/systemd, for this run only).
  const ping = (bus, dest) => spawnSync('gdbus', ['call', bus, '--dest', dest, '--object-path', '/', '--method', 'org.freedesktop.DBus.Peer.Ping'], { timeout: 3000 }).status === 0;
  const isRoot = process.getuid && process.getuid() === 0;
  if (!fs.existsSync('/run/dbus/system_bus_socket')) {
    if (!isRoot) { console.error('Morph Lab needs a system D-Bus (it is missing here). Run it as root in a container, or on a normal desktop/CI machine.'); process.exit(2); }
    fs.mkdirSync('/run/dbus', { recursive: true });
    spawnSync('dbus-daemon', ['--system', '--fork']);
  }
  const noLogind = fs.existsSync('/run/systemd/seats') && !ping('--system', 'org.freedesktop.login1');
  const inner = ['dbus-run-session', '--', process.execPath, __filename, ...process.argv.slice(2)];
  let cmd = inner;
  if (noLogind) {
    if (!isRoot) { console.error('logind is not running here, and hiding /run/systemd needs root. Run the lab with sudo, or on a desktop/CI machine.'); process.exit(2); }
    cmd = ['unshare', '-m', 'sh', '-c', 'mount -t tmpfs none /run/systemd && exec "$@"', 'sh', ...inner];
  }
  const p = spawn(cmd[0], cmd.slice(1), { env, stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code === null ? 1 : code));
  return;
}

// ---- Inside: run the scenarios.
const { Lab } = require('./lab');
const filter = process.argv.slice(2).join(' ').toLowerCase();
const files = fs.readdirSync(path.join(__dirname, 'scenarios')).filter((f) => /\.js$/.test(f)).sort();
const scenarios = [];
for (const f of files) for (const s of require(path.join(__dirname, 'scenarios', f))) scenarios.push(Object.assign({ file: f }, s));
const chosen = scenarios.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.file.includes(filter));

(async () => {
  const lab = new Lab(OUT);
  const results = [];
  const t0 = Date.now();
  try {
    await lab.start();
  } catch (e) {
    console.error('The lab could not start GNOME Shell: ' + e.message + '\nSee ' + path.join(OUT, 'gnome-shell.log'));
    await lab.stop();
    process.exit(2);
  }
  for (const s of chosen) {
    const checks = [];
    lab.steps = [];
    const t = {
      check(name, ok, detail) { checks.push({ name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) }); lab.steps.push({ kind: 'check', name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) }); },
      // A known limitation: checked and shown (amber), but it does not fail the run. When it starts passing, the
      // report says so, so it can become a normal check.
      known(name, ok, detail, why) { const d = ok ? 'now passes: make it a normal check' : String(detail === undefined ? '' : detail); checks.push({ name, ok: true, known: true, passes: !!ok, detail: d, why: why || '' }); lab.steps.push({ kind: 'known', name, passes: !!ok, detail: d, why: why || '' }); },
    };
    let error = '';
    const s0 = Date.now();
    try {
      await lab.reset({ settings: s.settings === undefined ? {} : s.settings });
      await s.run(lab, t);
    } catch (e) {
      error = e.message || String(e);
      try { await lab.shot('When it failed'); } catch (e2) { /* no screen */ }
    }
    const ok = !error && checks.every((c) => c.ok);
    results.push({ name: s.name, file: s.file, ok, error, checks, steps: lab.steps, ms: Date.now() - s0 });
    console.log((ok ? 'ok    ' : 'FAIL  ') + s.name + (error ? '\n      ' + error : '') + checks.filter((c) => !c.ok).map((c) => '\n      ✗ ' + c.name + (c.detail ? ': ' + c.detail : '')).join('') + checks.filter((c) => c.known).map((c) => '\n      ' + (c.passes ? '✓ known issue now passes: ' : '~ known issue: ') + c.name).join(''));
  }
  await lab.stop();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, 'index.html'), require('./report').html(results, Date.now() - t0));
  const bad = results.filter((r) => !r.ok).length;
  console.log((bad ? 'FAILED ' : 'ok ') + (results.length - bad) + ' of ' + results.length + ' scenarios (Morph Lab). Report: ' + path.join(OUT, 'index.html'));
  process.exit(bad ? 1 : 0);
})();
