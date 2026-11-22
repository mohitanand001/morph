#!/usr/bin/env -S gjs -m
// Morph's background program for GNOME. GJS is part of GNOME itself, so nothing else is downloaded.
// This file only connects the logic in core.js to the desktop: the GNOME helper (pill, clipboard,
// shortcuts) over D-Bus, files, notifications and the PDF drawer.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const here = Gio.File.new_for_uri(import.meta.url).get_parent();     // .../daemon
const root = here.get_parent();                                       // the app folder
const DEBUG = !!GLib.getenv('FB_DEBUG');
const log = (...a) => { if (DEBUG) print('[morph] ' + a.join(' ')); };
// Problems always go to the log file, not only in debug mode.
const warn = (...a) => print('[morph] ' + a.join(' '));

// ---------------------------------------------------------------- loading the shared code
const readText = (path) => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const cache = {};
function makeRequire(dir) {
  return function require(rel) {
    let p = rel.startsWith('.') ? GLib.build_filenamev([dir, rel]) : rel;
    // Tidy "a/../b" and "./x".
    const parts = [];
    p.split('/').forEach((s) => { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); });
    p = '/' + parts.join('/');
    if (!/\.js$/.test(p)) p += '.js';
    if (cache[p]) return cache[p].exports;
    const module = { exports: {} };
    cache[p] = module;
    new Function('module', 'exports', 'require', readText(p))(module, module.exports, makeRequire(GLib.path_get_dirname(p)));
    return module.exports;
  };
}
// The converter: plain scripts that fill in window.FB. The same files the tests run.
// GJS already defines window (read-only); only add it if some version doesn't.
if (typeof globalThis.window === 'undefined') Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
const CORE = ['ast-utils', 'lift', 'lists', 'people', 'terminal', 'pdf', 'detect', 'minidom', 'normalize-html', 'normalize-markdown', 'normalize-mrkdwn', 'render-slack', 'render-slack-html', 'render-jira', 'render-github', 'render-gdocs', 'render-email', 'render-text', 'fidelity', 'engine'];
CORE.forEach((f) => new Function(readText(root.get_child('src').get_child('core').get_child(f + '.js').get_path()))());
const req = makeRequire(here.get_path());
const { createCore } = req('./core.js');
const { pdfItems } = req('./pdf-doc.js');

// ---------------------------------------------------------------- the GNOME helper over D-Bus
const bus = Gio.DBus.session;
const DEST = 'org.gnome.Shell';
const OBJ = '/dev/morph/Focus';
const IFACE = 'dev.morph.Focus';
const enc = (s) => GLib.base64_encode(new TextEncoder().encode(s));
const dec = (s) => new TextDecoder().decode(GLib.base64_decode(s));
function call(method, args, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      bus.call(DEST, OBJ, IFACE, method, args, null, Gio.DBusCallFlags.NONE, timeout, null, (c, res) => {
        try { resolve(c.call_finish(res)); } catch (e) { resolve(null); }
      });
    } catch (e) { resolve(null); }
  });
}
const text = (reply) => { try { return reply ? reply.deepUnpack()[0] : null; } catch (e) { return null; } };
const json = (reply) => { const t = text(reply); if (t === null) return null; try { return JSON.parse(dec(t)); } catch (e) { return null; } };

const shell = {
  setPill: (spec) => {
    call('SetPill', new GLib.Variant('(s)', [enc(JSON.stringify(spec))])).then((r) => { if (r === null) log('SetPill got no answer from the helper'); });
  },
  async readClip() {
    const j = json(await call('ReadClipboard', null));
    if (!j) return null;
    return { formats: Array.isArray(j.mimetypes) ? j.mimetypes.map(String) : [], secret: !!j.secret, text: typeof j.text === 'string' ? j.text : '', html: typeof j.html === 'string' ? j.html : '' };
  },
  // The copied image as a private temp file, or '' (needs helper version 15).
  async readImage() {
    const j = json(await call('ReadImage', null));
    return j && typeof j.path === 'string' ? j.path : '';
  },
  async writeClip(mime, data) {
    if (!/^text\/(plain|html)$/.test(mime)) return false;
    return (await call('WriteClipboard', new GLib.Variant('(ss)', [mime, enc(String(data))]))) !== null;
  },
  paste: (shift) => { call('Paste', new GLib.Variant('(b)', [!!shift])); },
  async setShortcuts(list) {
    const j = json(await call('SetShortcuts', new GLib.Variant('(s)', [enc(JSON.stringify(list))])));
    return Array.isArray(j) ? j.map(String) : null;
  },
};

// ---------------------------------------------------------------- files, notifications, PDF
const configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'morph']);
const settingsPath = GLib.build_filenamev([configDir, 'settings.json']);
const pkg = (() => { try { return JSON.parse(readText(root.get_child('package.json').get_path())); } catch (e) { return {}; } })();

function notify(title, body) {
  try {
    bus.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
      new GLib.Variant('(susssasa{sv}i)', ['Morph', 0, '', title, body || '', [], {}, 4000]), null, Gio.DBusCallFlags.NONE, 2000, null, null);
  } catch (e) { warn('notification failed:', e.message); }
}
function openUri(uri) { try { Gio.AppInfo.launch_default_for_uri(uri, null); } catch (e) { log('open failed:', e.message); } }
function showInFolder(path) {
  const uri = GLib.filename_to_uri(path, null);
  try {
    bus.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1', 'ShowItems',
      new GLib.Variant('(ass)', [[uri], 'morph']), null, Gio.DBusCallFlags.NONE, 2000, null, (c, res) => {
        try { c.call_finish(res); } catch (e) { openUri(GLib.filename_to_uri(GLib.path_get_dirname(path), null)); }
      });
  } catch (e) { openUri(GLib.filename_to_uri(GLib.path_get_dirname(path), null)); }
}
async function savePdf(doc) {
  try {
    const items = pdfItems(doc.ast);
    const { renderPdf } = await import('./pdf.js');
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    GLib.mkdir_with_parents(dir, 0o755);
    // The file name never comes from what was copied (it could be huge, or look like a command): date and time only.
    const base = 'Morph ' + GLib.DateTime.new_now_local().format('%Y-%m-%d %H.%M.%S');
    let name = base + '.pdf';
    for (let i = 2; GLib.file_test(GLib.build_filenamev([dir, name]), GLib.FileTest.EXISTS) && i < 100; i++) name = base + ' (' + i + ').pdf';
    const path = GLib.build_filenamev([dir, name]);
    renderPdf(items, path);
    log('saved PDF:', path);
    return { ok: true, name, path };
  } catch (e) {
    log('PDF failed:', e && e.message);
    return { ok: false };
  }
}

// ---------------------------------------------------------------- updates
// The website publishes version.json next to the download. We only ever ask; installing is the user's click.
const UPDATE_URL = GLib.getenv('MORPH_UPDATE_URL') || 'https://mohitanand001.github.io/morph/version.json';
function runCmd(argv) {
  return new Promise((resolve) => {
    try {
      const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
      p.communicate_utf8_async(null, null, (proc, res) => {
        try { const [, out] = proc.communicate_utf8_finish(res); resolve({ ok: proc.get_successful(), out: out || '' }); } catch (e) { resolve({ ok: false, out: '' }); }
      });
    } catch (e) { resolve({ ok: false, out: '' }); }
  });
}
const update = {
  async check() {
    const r = await runCmd(['curl', '-fsSL', '--max-time', '10', UPDATE_URL]);
    if (!r.ok) return null;
    try { const j = JSON.parse(r.out); return typeof j.version === 'string' ? { version: j.version } : null; } catch (e) { return null; }
  },
  // Hand over to the installer script in its own session: it replaces our files and restarts us.
  // Waits for it, so a failed or no-restart update never leaves the pill on "Updating…".
  run() {
    return new Promise((resolve) => {
      try {
        const log = GLib.build_filenamev([GLib.get_user_cache_dir(), 'morph.log']);
        const p = Gio.Subprocess.new(['setsid', 'bash', '-c', '"$0" --update >>"$1" 2>&1', root.get_child('bin').get_child('morph').get_path(), log], Gio.SubprocessFlags.NONE);
        p.wait_async(null, (proc, res) => { try { proc.wait_finish(res); resolve(proc.get_successful()); } catch (e) { resolve(false); } });
      } catch (e) { warn('could not start the updater:', e.message); resolve(false); }
    });
  },
};

// Optional table OCR (morph --enable-ocr). A private Python environment next to Morph, run only when you click.
const OCR_DIR = GLib.build_filenamev([GLib.getenv('XDG_DATA_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share']), 'morph-ocr']);
function ocrLog(text) {
  try {
    const dir = GLib.getenv('XDG_CACHE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.cache']);
    const f = Gio.File.new_for_path(GLib.build_filenamev([dir, 'morph-ocr.log']));
    const st = f.append_to(Gio.FileCreateFlags.PRIVATE, null);
    st.write_all(new TextEncoder().encode('--- read ' + new Date().toISOString() + '\n' + text + '\n'), null);
    st.close(null);
  } catch (e) { /* logging is best effort */ }
}
let ocrProc = null;
const ocr = {
  ready: () => GLib.file_test(GLib.build_filenamev([OCR_DIR, 'ready']), GLib.FileTest.EXISTS),
  // Settings → Privacy → Enable table OCR: runs `morph --enable-ocr` and reports its progress lines.
  install(onLine, onDone) {
    try {
      const morph = root.get_child('bin').get_child('morph').get_path();
      const p = Gio.Subprocess.new(['bash', morph, '--enable-ocr'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
      ocrProc = p;
      const reader = new Gio.DataInputStream({ base_stream: p.get_stdout_pipe() });
      const next = () => reader.read_line_async(GLib.PRIORITY_DEFAULT, null, (r, res) => {
        let line = null;
        try { [line] = r.read_line_finish_utf8(res); } catch (e) { line = null; }
        if (line === null) return;
        const t = String(line).trim();
        if (t) onLine(t);
        next();
      });
      next();
      p.wait_async(null, (proc, res) => {
        let ok = false;
        try { proc.wait_finish(res); ok = proc.get_successful(); } catch (e) { ok = false; }
        ocrProc = null;
        onDone(ok && ocr.ready());
      });
    } catch (e) { onDone(false); }
  },
  cancel() {
    try { if (ocrProc) ocrProc.force_exit(); } catch (e) { /* done */ }
    // Whatever was half installed goes too.
    try { Gio.Subprocess.new(['bash', root.get_child('bin').get_child('morph').get_path(), '--disable-ocr'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE); } catch (e) { /* nothing to remove */ }
  },
  remove() {
    return new Promise((resolve) => {
      try {
        const p = Gio.Subprocess.new(['bash', root.get_child('bin').get_child('morph').get_path(), '--disable-ocr'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        p.wait_async(null, () => resolve(true));
      } catch (e) { resolve(false); }
    });
  },
  // Reads the copied image and returns { ok, html } or { ok: false, error }. Never leaves a copy of the image behind.
  async run() {
    const img = await shell.readImage();
    if (!img) { ocrLog('GNOME\'s helper could not hand over the copied image.'); return { ok: false, error: 'no_image' }; }
    try {
      const py = GLib.build_filenamev([OCR_DIR, 'venv', 'bin', 'python']);
      const worker = root.get_child('ocr').get_child('morph_ocr.py').get_path();
      const r = await new Promise((resolve) => {
        try {
          // Same sandbox as the install: models and caches stay in Morph's OCR folder, never in your own ~/.paddlex.
          const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
          const ocrHome = GLib.build_filenamev([OCR_DIR, 'home']);
          GLib.mkdir_with_parents(ocrHome, 0o700);
          launcher.setenv('HOME', ocrHome, true);
          launcher.setenv('PADDLE_PDX_CACHE_HOME', GLib.build_filenamev([OCR_DIR, 'models']), true);
          launcher.setenv('PYTHONNOUSERSITE', '1', true);
          const p = launcher.spawnv([py, worker, img]);
          let timedOut = false;
          const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => { timedOut = true; try { p.force_exit(); } catch (e) { /* done */ } return GLib.SOURCE_REMOVE; });
          p.communicate_utf8_async(null, null, (proc, res) => {
            if (!timedOut) GLib.source_remove(timer);
            let out = '', err = '';
            try { [, out, err] = proc.communicate_utf8_finish(res); } catch (e) { /* nothing */ }
            // A failed read is logged so it can be fixed: the error and the end of PaddleOCR's messages, never the image or the table.
            const last = String(out || '').trim().split('\n').pop();
            if (!/"ok": true/.test(last)) ocrLog((timedOut ? 'timed out after 300 s. ' : '') + 'result: ' + last.slice(0, 300) + '\n' + String(err || '').slice(-1500));
            resolve(out || '');
          });
        } catch (e) { resolve(''); }
      });
      const line = String(r).trim().split('\n').pop();
      const j = JSON.parse(line);
      return j && j.ok && typeof j.html === 'string' ? { ok: true, html: j.html.slice(0, 400000) } : { ok: false, error: (j && j.error) || 'failed' };
    } catch (e) { return { ok: false, error: 'failed' }; }
    finally { try { Gio.File.new_for_path(img).delete(null); } catch (e) { /* gone */ } }
  },
};

// The pill's Uninstall row: hand over to the script, in its own session, since it removes us and our folder.
const uninstall = {
  async run() {
    try {
      const log = GLib.build_filenamev([GLib.get_user_cache_dir(), 'morph.log']);
      Gio.Subprocess.new(['setsid', '-f', 'bash', '-c', '"$0" --uninstall >>"$1" 2>&1', root.get_child('bin').get_child('morph').get_path(), log], Gio.SubprocessFlags.NONE);
      return true;
    } catch (e) { warn('could not start the uninstaller:', e.message); return false; }
  },
};

// ---------------------------------------------------------------- timers
const timers = new Set();
function setTimeoutG(fn, ms) {
  const t = { id: 0 };
  t.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => { timers.delete(t); try { fn(); } catch (e) { log('timer error:', e.message); } return GLib.SOURCE_REMOVE; });
  timers.add(t);
  return t;
}
function clearTimeoutG(t) { if (t && timers.has(t)) { timers.delete(t); GLib.source_remove(t.id); } }

// ---------------------------------------------------------------- go
const core = createCore({
  version: pkg.version || '0.0.0',
  home: GLib.get_home_dir(),
  log,
  store: {
    read: () => { try { return readText(settingsPath); } catch (e) { return null; } },
    write: (s) => { GLib.mkdir_with_parents(configDir, 0o700); GLib.file_set_contents(settingsPath, s); },
  },
  shell, notify, savePdf, update, uninstall, ocr,
  openPath: (p) => openUri(GLib.filename_to_uri(p, null)),
  openUri,
  showInFolder,
  now: () => Date.now(),
  setTimeout: setTimeoutG,
  clearTimeout: clearTimeoutG,
});

const safe = (what, fn) => (...a) => { try { const r = fn(...a); if (r && r.catch) r.catch((e) => warn(what + ' failed:', e && e.message, e && e.stack)); } catch (e) { warn(what + ' failed:', e && e.message, e && e.stack); } };

// Which window is in front: the helper tells us when it changes, and we ask now and then as a backup.
let lastKey = '';
let failures = 0;
let unavailable = false;
function windowInfo(j) {
  if (!j) return null;
  const pill = Number(j.pill) || 0;
  return { win: { app: String(j.app || ''), title: String(j.title || '') }, pill };
}
function onWindow(info) {
  const key = info.win.app + '\n' + info.win.title + '\n' + info.pill;
  if (key === lastKey && !unavailable) return;
  lastKey = key;
  failures = 0;
  unavailable = false;
  log('front window:', info.win.app, '(title:', info.win.title.length, 'chars)', 'helper v' + info.pill); // never the title itself
  core.focus(info.win, info.pill);
}
async function probe() {
  const info = windowInfo(json(await call('Get', null, 1500)));
  if (info) { onWindow(info); return; }
  failures++;
  if (failures >= 3 && !unavailable) { unavailable = true; lastKey = ''; core.focus(null); }
}

// What's on the clipboard changes in two ways: the helper tells us, and we also look every 700 ms
// (some sessions don't deliver the helper's signal). Each new copy is handled once.
let clipSig = null;
let clipAt = 0;
const sigOf = (sh) => (!sh ? 'none' : sh.secret ? 'secret' : (sh.formats || []).join(',') + '|' + sh.text.length + '|' + sh.text.slice(0, 200) + '|' + sh.html.length);
async function checkClip(fromSignal) {
  // Privacy: ask first. Nothing is read for a copy from an app that was not listed (or before setup is answered).
  if (!core.mayRead()) { clipSig = null; return; }
  const sh = await shell.readClip();
  const sig = sigOf(sh);
  const fresh = Date.now() - clipAt < 1000;
  if (!fromSignal && sig === clipSig) return;
  if (fromSignal && sig === clipSig && fresh) return; // the poll already caught this copy
  clipSig = sig;
  clipAt = Date.now();
  log('clipboard', fromSignal ? 'signal' : 'poll', sh ? (sh.secret ? 'secret' : (sh.text.length + ' chars text, ' + sh.html.length + ' chars html')) : 'unreadable');
  await core.clipboardChanged(sh && !sh.secret ? sh : (sh ? { secret: true } : null));
}

bus.signal_subscribe(DEST, IFACE, null, OBJ, null, Gio.DBusSignalFlags.NONE, safe('signal', (_c, _s, _p, _i, name, params) => {
  const arg = params.deepUnpack()[0];
  if (name !== 'Changed') log('signal:', name, String(arg).slice(0, 40));
  if (name === 'Action') core.action(arg);
  else if (name === 'ClipboardChanged') checkClip(true).catch((e) => warn('clipboard check failed:', e && e.message));
  else if (name === 'Changed') { let j = null; try { j = JSON.parse(dec(arg)); } catch (e) { j = null; } const info = windowInfo(j); if (info) onWindow(info); }
}));

const loop = new GLib.MainLoop(null, false);
let ownedName = false;
let duplicate = false;
Gio.bus_own_name(Gio.BusType.SESSION, 'dev.morph.Daemon', Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
  null,
  () => { ownedName = true; },
  () => { if (!ownedName) { duplicate = true; print('Morph is already running.'); loop.quit(); } });
// Quit cleanly on SIGINT/SIGTERM. Newer GLib moved this call into GLibUnix; look for it without waiting,
// because nothing may block the start-up below.
function onSignals(add) {
  [15, 2].forEach((sig) => { try { add(GLib.PRIORITY_DEFAULT, sig, () => { loop.quit(); return GLib.SOURCE_REMOVE; }); } catch (e) { /* not fatal */ } });
}
import('gi://GLibUnix').then((m) => onSignals(m.default.signal_add)).catch(() => { if (GLib.unix_signal_add) onSignals(GLib.unix_signal_add); });

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
  safe('start', async () => {
    if (!ownedName) await new Promise((r) => setTimeoutG(r, 300)); // give the name a moment
    if (duplicate) return;
    await probe();
    log('helper answered:', unavailable ? 'no' : failures === 0 ? 'yes' : 'not yet');
    await core.start();
    log('started');
    clipSig = core.readsEverything() ? sigOf(await shell.readClip()) : null; // what is there now is not "new"
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => { probe().catch(() => {}); return GLib.SOURCE_CONTINUE; });
    let polling = false;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
      // The poll reads, so it runs only when you chose "any app". Otherwise only the helper's copy signal triggers a read.
      if (!polling && core.readsEverything()) { polling = true; checkClip(false).catch((e) => warn('clipboard poll failed:', e && e.message)).finally(() => { polling = false; }); }
      return GLib.SOURCE_CONTINUE;
    });
  })();
  return GLib.SOURCE_REMOVE;
});
loop.run();
