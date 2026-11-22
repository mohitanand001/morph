// Finds out which window is in front, so the pill can appear only in the
// apps you chose. Three ways, picked by platform:
//  - GNOME on Wayland: ask the small Morph GNOME extension over D-Bus
//    (Wayland gives apps no other way to see other windows);
//  - X11: read the active window with xprop;
//  - macOS: ask System Events for the front app, and the browser for its
//    front tab title.
// Each reports { app, title } or null. If none works, state is
// 'unavailable' and the pill falls back to always being shown.
'use strict';
const { execFile, spawn } = require('child_process');

const run = (cmd, args, timeout = 1500) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

// ---------------------------------------------------------------- GNOME (Wayland)
const GNOME_ARGS = ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/dev/morph/Focus', '--method', 'dev.morph.Focus.Get'];
// The extension answers with base64-encoded JSON, so no quoting can break it:
// ('eyJhcHAiOiJTbGFjayJ9',)
function parseGnome(out) {
  const m = out && out.match(/'([A-Za-z0-9+/=]*)'/);
  if (!m) return null;
  try {
    const j = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    const pill = Number(j && j.pill) || 0;
    if (!j || (!j.app && !j.title)) return { app: '', title: '', pill };
    return { app: String(j.app || ''), title: String(j.title || ''), pill };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- X11
function parseXActive(out) {
  const m = out && out.match(/window id # (0x[0-9a-f]+)/i);
  return m && m[1] !== '0x0' ? m[1] : null;
}
function parseXWindow(out) {
  if (!out) return null;
  const cls = out.match(/WM_CLASS\(STRING\) = "([^"]*)"(?:, "([^"]*)")?/);
  const name = out.match(/_NET_WM_NAME\(UTF8_STRING\) = "((?:[^"\\]|\\.)*)"/) || out.match(/WM_NAME\(\w+\) = "((?:[^"\\]|\\.)*)"/);
  return {
    app: cls ? (cls[2] || cls[1]) : '',
    title: name ? name[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '',
  };
}

// ---------------------------------------------------------------- macOS
const MAC_SCRIPT = [
  'tell application "System Events" to set frontApp to name of first application process whose frontmost is true',
  'set t to ""',
  'try',
  '  if frontApp is in {"Google Chrome", "Brave Browser", "Microsoft Edge", "Arc", "Chromium", "Vivaldi"} then',
  '    tell application frontApp to set t to title of active tab of front window',
  '  else if frontApp is "Safari" then',
  '    tell application "Safari" to set t to name of front document',
  '  end if',
  'end try',
  // Any other app (Slack, Outlook…): its front window title. Mac only allows
  // this with Accessibility permission; without it this is just skipped.
  'if t is "" then',
  '  try',
  '    tell application "System Events" to set t to name of front window of (first application process whose frontmost is true)',
  '  end try',
  'end if',
  'return frontApp & linefeed & t',
].join('\n');
function parseMac(out) {
  if (!out) return null;
  const [app, ...rest] = out.replace(/\n$/, '').split('\n');
  return { app: app || '', title: rest.join(' ') };
}

// ---------------------------------------------------------------- watcher
// The GNOME helper (version 2+) can also draw the pill. Tell it what to show.
function setShellPill(state) {
  const b = Buffer.from(JSON.stringify(state)).toString('base64');
  return run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/dev/morph/Focus', '--method', 'dev.morph.Focus.SetPill', "'" + b + "'"]);
}
function parseAction(line) {
  const m = String(line || '').match(/Action \('([a-z]+:[a-z0-9]*)',\)/);
  return m ? m[1] : null;
}

// The GNOME helper (version 5+) reads and writes the clipboard for us:
// on Wayland an app that isn't in front may not see what you copied.
const SHELL_CALL = ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/dev/morph/Focus', '--method'];
function parseShellClip(out) {
  const m = out && out.match(/'([A-Za-z0-9+/=]*)'/);
  if (!m) return null;
  try {
    const j = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return {
      formats: Array.isArray(j.mimetypes) ? j.mimetypes.map(String) : [],
      secret: !!j.secret,
      text: typeof j.text === 'string' ? j.text : '',
      html: typeof j.html === 'string' ? j.html : '',
    };
  } catch (e) { return null; }
}
async function shellReadClipboard() {
  return parseShellClip(await run('gdbus', SHELL_CALL.concat(['dev.morph.Focus.ReadClipboard']), 3000));
}
// One format only (GNOME's clipboard API sets a single type). Command-line
// arguments are capped near 128 KB, so very large content can't go this way.
// Helper v6+: press Ctrl V (or Ctrl Shift V) in the window in front.
async function shellPaste(shift) {
  return (await run('gdbus', SHELL_CALL.concat(['dev.morph.Focus.Paste', shift ? 'true' : 'false']), 3000)) !== null;
}
// Helper v10+: grab global shortcuts. Returns the ids GNOME refused (taken
// by another shortcut), or null if the helper didn't answer.
async function setShellShortcuts(list) {
  const b = Buffer.from(JSON.stringify(list)).toString('base64');
  const out = await run('gdbus', SHELL_CALL.concat(['dev.morph.Focus.SetShortcuts', "'" + b + "'"]), 3000);
  const m = out && out.match(/'([A-Za-z0-9+/=]*)'/);
  if (!m) return null;
  try { const f = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); return Array.isArray(f) ? f.map(String) : []; } catch (e) { return null; }
}
async function shellWriteClipboard(mimetype, data) {
  if (!/^text\/(plain|html)$/.test(mimetype)) return false;
  const b = Buffer.from(String(data)).toString('base64');
  if (b.length > 120000) return false;
  return (await run('gdbus', SHELL_CALL.concat(['dev.morph.Focus.WriteClipboard', "'" + mimetype + "'", "'" + b + "'"]), 3000)) !== null;
}

function createFocusWatcher({ platform = process.platform, session = process.env.XDG_SESSION_TYPE, onChange, onAction = () => {}, onClipboard = () => {}, intervalMs = 600 }) {
  let timer = null;
  let monitor = null;
  let last = '';
  let failures = 0;
  const state = { provider: 'none', status: 'starting', current: null, shellPill: false, shellVersion: 0 };

  const emit = (win) => {
    const key = win ? win.app + '\n' + win.title : '';
    if (key === last) return;
    last = key;
    state.current = win;
    onChange(win, state);
  };

  async function probe() {
    let win = null;
    if (state.provider === 'gnome') {
      win = parseGnome(await run('gdbus', GNOME_ARGS));
    } else if (state.provider === 'x11') {
      const id = parseXActive(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']));
      win = id ? parseXWindow(await run('xprop', ['-id', id, 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'])) : { app: '', title: '' };
    } else if (state.provider === 'mac') {
      win = parseMac(await run('osascript', ['-e', MAC_SCRIPT], 2500));
    }
    if (win === null) {
      failures++;
      if (failures >= 3 && state.status !== 'unavailable') {
        state.status = 'unavailable';
        onChange(null, state);
      }
      return;
    }
    failures = 0;
    if (state.status !== 'ok') { state.status = 'ok'; last = '\u0000'; }
    if (win.pill >= 2) state.shellPill = true;
    state.shellVersion = win.pill || 0;
    emit(win);
  }

  async function start() {
    if (platform === 'darwin') state.provider = 'mac';
    else if (platform === 'linux' && session === 'wayland') state.provider = 'gnome';
    else if (platform === 'linux') state.provider = 'x11';
    if (state.provider === 'none') { state.status = 'unavailable'; onChange(null, state); return; }
    await probe();
    // GNOME: also listen for the extension's change signal, so switching
    // windows or browser tabs is picked up immediately; polling is the backup.
    if (state.provider === 'gnome') {
      try {
        monitor = spawn('gdbus', ['monitor', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/dev/morph/Focus']);
        let buf = '';
        monitor.stdout.on('data', (d) => {
          buf += String(d);
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const a = parseAction(line);
            if (a) { onAction(a); continue; }
            if (/ClipboardChanged \(/.test(line)) { onClipboard(); continue; }
            const m = line.match(/Changed \('([A-Za-z0-9+/=]*)',\)/);
            if (m) { const w = parseGnome("'" + m[1] + "'"); if (w) { failures = 0; if (state.status !== 'ok') state.status = 'ok'; if (w.pill >= 2) state.shellPill = true; state.shellVersion = w.pill || 0; emit(w); } }
          }
        });
        monitor.on('error', () => { monitor = null; });
      } catch (e) { monitor = null; }
    }
    timer = setInterval(probe, state.provider === 'gnome' && monitor ? intervalMs * 3 : intervalMs);
  }

  start();
  return {
    state,
    stop() { clearInterval(timer); if (monitor) monitor.kill(); },
  };
}

module.exports = { createFocusWatcher, setShellPill, shellReadClipboard, shellWriteClipboard, shellPaste, setShellShortcuts, parseShellClip, parseAction, parseGnome, parseXActive, parseXWindow, parseMac };
