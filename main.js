// Format Bridge companion: main process.
//
// Lives in the system tray (menu bar on macOS) with no taskbar or dock
// entry. The popover window is created once, kept hidden, and shown from the
// tray menu or the global shortcut; it hides again when it loses focus.
// The tray menu can also convert the clipboard for a destination directly,
// without showing anything.
const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, globalShortcut, nativeImage, screen, shell, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DEFAULT_RULES, normalizeRules, matchRule, isSelf, addNewDefaults } = require('./lib/rules');
const { describeSource, siteOf } = require('./lib/source');
const { SHORTCUTS, normalizeShortcuts, accelLabel, accelToElectron, validAccel } = require('./lib/keys');
// Design tuner for the pill (FB_TUNE=1): sliders under the pill, see lib/tune.js.
const tune = process.env.FB_TUNE === '1' ? require('./lib/tune') : null;
const { createFocusWatcher, setShellPill, shellReadClipboard, shellWriteClipboard, shellPaste, setShellShortcuts } = require('./lib/focus');

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const POPOVER = { width: 460, height: 720 };
const DESTS = [
  ['slack', 'Slack'], ['jira', 'Jira'], ['confluence', 'Confluence'], ['email', 'Email'],
  ['gdocs', 'Google Docs'], ['markdown', 'Markdown'], ['text', 'Plain text'],
  ['notion', 'Notion'], ['linear', 'Linear'], ['teams', 'Teams'],
];

let tray = null;
let win = null;
let lastSig = '';
let trayStatus = 'Nothing copied yet';
let quitting = false;
let pill = null;
let focusWatcher = null;
let currentRule = null;
let pendingDest = null;
let pendingQuick = null; // 'pill' when the pill asked for the conversion

// On a Wayland desktop, run through XWayland: a native Wayland window can't
// keep itself on top or choose where it sits, and the pill needs both.
if (IS_LINUX && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
// On Linux the GPU often fails to start under XWayland, and see-through
// windows then don't draw at all. Software drawing is plenty for this app,
// and the pill is a solid black window there instead of a see-through one.
if (IS_LINUX) app.disableHardwareAcceleration();
const PILL_OPAQUE = IS_LINUX;

// FB_DEBUG=1 npm start  prints what the pill sees and decides.
const DEBUG = !!process.env.FB_DEBUG;
const log = (...a) => { if (DEBUG) console.log('[morph]', ...a); };

// ---------------------------------------------------------------- settings
// Saved in the app's own data folder: which apps the pill appears in, its
// mode and where on the edge it sits. Nothing you copy is stored.
const SETTINGS_DEFAULT = { rules: DEFAULT_RULES, pillEnabled: true, pillMode: 'apps', pillY: null, pillYFrac: 0.42, pillSide: 'r', pillMonitor: -1, autoFormat: false, macAutoPaste: false, linkBack: false, tabIcons: false, trayIcon: process.platform === 'darwin', theme: 'sol-light', size: 'm', shortcuts: null, pillDests: null, atlassianSite: '', seenDefaults: null, people: {}, tuneVals: {} };
let settings = Object.assign({}, SETTINGS_DEFAULT);
const SIZE_NAMES = { s: 'Small', m: 'Medium', l: 'Large' };
const THEMES = ['sol-light', 'sol-dark', 'graphite', 'soft', 'compact', 'outline', 'light', 'midnight'];
const THEME_NAMES = { 'sol-light': 'Light', 'sol-dark': 'Dark', graphite: 'Graphite', soft: 'Soft charcoal', compact: 'Compact icons', outline: 'Outline', light: 'Light graphite', midnight: 'Midnight' };
// Only Light and Dark are offered; the older looks stay behind this flag.
// Light only for now; Dark is ready behind FB_DARK=1, the older looks behind FB_LEGACY_THEMES=1.
const pickThemes = () => (FEATURES.legacyThemes ? THEMES : FEATURES.darkTheme ? ['sol-light', 'sol-dark'] : ['sol-light']);
const ALL_DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
// Which formats the pill offers (null = all of them).
function cleanDests(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach((d) => { if (ALL_DESTS.includes(d) && !out.includes(d)) out.push(d); });
  return out.length ? out : null;
}
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
// Saved name -> email pairs, so @mentions can become mail links on paste.
function cleanPeople(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  Object.keys(p).slice(0, 300).forEach((k) => {
    const name = String(k).trim().toLowerCase().slice(0, 80);
    const mail = String(p[k] || '').trim().slice(0, 120);
    if (name && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mail)) out[name] = mail;
  });
  return out;
}
function loadSettings() {
  try { settings = Object.assign({}, SETTINGS_DEFAULT, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) { settings = Object.assign({}, SETTINGS_DEFAULT); }
  settings.rules = normalizeRules(settings.rules);
  const merged = addNewDefaults(settings.rules, settings.seenDefaults);
  settings.rules = merged.rules;
  settings.seenDefaults = merged.seen;
  if (!['apps', 'always'].includes(settings.pillMode)) settings.pillMode = 'apps';
  if (!['l', 'r'].includes(settings.pillSide)) settings.pillSide = 'r';
  if (!Number.isInteger(settings.pillMonitor) || settings.pillMonitor < -1 || settings.pillMonitor > 9) settings.pillMonitor = -1;
  settings.autoFormat = settings.autoFormat === true;
  settings.people = cleanPeople(settings.people);
  settings.tuneVals = tune ? tune.cleanVals(settings.tuneVals) : {};
  settings.linkBack = settings.linkBack === true;
  settings.tabIcons = settings.tabIcons === true;
  settings.trayIcon = settings.trayIcon === true;
  settings.macAutoPaste = settings.macAutoPaste === true;
  if (!THEMES.includes(settings.theme) || (!FEATURES.legacyThemes && !pickThemes().includes(settings.theme))) settings.theme = 'sol-light';
  if (!['s', 'm', 'l'].includes(settings.size)) settings.size = 'm';
  settings.shortcuts = normalizeShortcuts(settings.shortcuts);
  settings.pillDests = cleanDests(settings.pillDests);
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(settings.atlassianSite || '')) settings.atlassianSite = '';
  if (typeof settings.pillYFrac !== 'number' || !(settings.pillYFrac >= 0.05 && settings.pillYFrac <= 0.95)) settings.pillYFrac = 0.42;
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { /* read-only disk: keep in memory */ }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showPopover());

// ---------------------------------------------------------------- popover
function createPopover() {
  win = new BrowserWindow({
    width: POPOVER.width,
    height: POPOVER.height,
    minWidth: 380,
    minHeight: 460,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { mode: 'companion' } });
  win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) win.hide(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Read what's already on the clipboard, not just later copies.
  win.webContents.on('did-finish-load', () => win.webContents.send('clip:changed'));
}

// Near the tray icon when the system says where it is (macOS, Windows);
// otherwise the top-right corner of the screen the mouse is on, which is
// where the tray sits on Ubuntu.
function position() {
  const b = tray && tray.getBounds ? tray.getBounds() : null;
  const display = screen.getDisplayNearestPoint(b && b.width ? { x: b.x, y: b.y } : screen.getCursorScreenPoint());
  const wa = display.workArea;
  const [w, h] = win.getSize();
  let x;
  let y;
  if (b && b.width) {
    x = Math.round(b.x + b.width / 2 - w / 2);
    y = b.y < wa.y + wa.height / 2 ? wa.y + 6 : wa.y + wa.height - h - 6;
  } else {
    x = wa.x + wa.width - w - 12;
    y = wa.y + 8;
  }
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - w - 6));
  win.setPosition(x, y, false);
}

function showPopover() {
  if (!win) return;
  position();
  win.show();
  win.focus();
  win.webContents.send('popover:shown');
}
function togglePopover() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showPopover();
}

// ---------------------------------------------------------------- pill
// Solid (Linux): the window is exactly the tab. See-through (macOS): a little
// room around it for the rounded edge and shadow.
// The window pill (Mac, and Linux desktops without the GNOME helper). It
// draws the same spec as the GNOME pill and tells us its size.
let pillSize = { width: 14, height: 64 };
let pillOpen = false;
function createPill() {
  pill = new BrowserWindow({
    width: pillSize.width,
    height: pillSize.height,
    show: false,
    frame: false,
    transparent: !PILL_OPAQUE,
    backgroundColor: PILL_OPAQUE ? '#111214' : '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false, // clicking it must not take focus from the app you'll paste into
    // macOS: a non-activating panel, so the app in front stays in front.
    ...(IS_MAC ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-pill.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  pill.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'floating');
  if (pill.setVisibleOnAllWorkspaces) pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.loadFile(path.join(__dirname, 'src', 'pill.html'), { query: PILL_OPAQUE ? { solid: '1' } : {} });
  pill.webContents.on('will-navigate', (e) => e.preventDefault());
  pill.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pill.webContents.on('did-finish-load', () => sendPillState());
}
function pillDisplay() {
  const all = screen.getAllDisplays();
  if (settings.pillMonitor >= 0 && all[settings.pillMonitor]) return all[settings.pillMonitor];
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function placePill() {
  if (!pill) return;
  const wa = pillDisplay().workArea;
  const { width, height } = pillSize;
  let y = Math.round(wa.y + wa.height * settings.pillYFrac - height / 2);
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - height - 8));
  const x = settings.pillSide === 'l' ? wa.x : wa.x + wa.width - width;
  pill.setBounds({ x, y, width, height }, false);
}
// The pill reports its size whenever what it shows changes.
ipcMain.on('pill:size', (_e, sz) => {
  if (!pill || !sz) return;
  const w = Math.round(Number(sz.width));
  const h = Math.round(Number(sz.height));
  if (!(w >= 8 && w <= 800 && h >= 20 && h <= 1200)) return;
  pillOpen = !!sz.open;
  pillSize = { width: w, height: h };
  placePill();
  if (!pillShouldShow() && !pillOpen && pill.isVisible()) pill.hide();
});
// Dragging: follow the pointer, then dock to the nearer edge of that screen.
let dragFrom = null;
ipcMain.on('pill:drag', (_e, d) => {
  if (!pill || !d) return;
  const p = screen.getCursorScreenPoint();
  if (d.phase === 'start') { const [x, y] = pill.getPosition(); dragFrom = { px: p.x, py: p.y, x, y }; return; }
  if (!dragFrom) return;
  if (d.phase === 'move') { pill.setPosition(Math.round(dragFrom.x + p.x - dragFrom.px), Math.round(dragFrom.y + p.y - dragFrom.py)); return; }
  if (d.phase === 'end') {
    dragFrom = null;
    const all = screen.getAllDisplays();
    const disp = screen.getDisplayNearestPoint(p);
    const idx = Math.max(0, all.findIndex((x) => x.id === disp.id));
    const wa = disp.workArea;
    const side = p.x < wa.x + wa.width / 2 ? 'l' : 'r';
    const pb = pill.getBounds();
    const yf = Math.round(Math.min(0.95, Math.max(0.05, (pb.y + pb.height / 2 - wa.y) / wa.height)) * 1000);
    handlePillAction('moved:' + side + Math.min(idx, 9) + 'y' + yf, 'window');
    placePill();
    sendPillState();
  }
});
ipcMain.on('pill:action', (_e, a) => handlePillAction(String(a || ''), 'window'));

function pillShouldShow() {
  if (!settings.pillEnabled) return false;
  if (tune || settings.pillMode === 'always') return true; // tuner: always there
  // Can't tell which app is in front (e.g. the GNOME helper isn't installed):
  // show everywhere rather than never.
  if (focusWatcher && focusWatcher.state.status === 'unavailable') return true;
  return !!currentRule;
}

// On GNOME (Wayland) the helper extension draws the pill as part of the
// desktop; app windows can't reliably float there.
function usingShellPill() { return !!(focusWatcher && focusWatcher.state.shellPill); }
// Helper v5+ can also read and write the clipboard.
function usingShellClip() { return !!(focusWatcher && focusWatcher.state.shellVersion >= 5); }
// What the GNOME pill shows. The helper just draws this, so the look can
// change here without reloading GNOME.
const OPTION_LABEL = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Docs', markdown: 'Markdown', text: 'Text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
// Each destination's dot colour in the pill (sent to GNOME, so changing
// these needs no logout).
const DEST_COLOR = { slack: '#e01e5a', jira: '#2684ff', confluence: '#1d9bd1', email: '#ea4335', gdocs: '#4285f4', markdown: '#9aa3ad', text: '#3fb950', notion: '#e8e6e1', linear: '#7c85f0', teams: '#7b83eb' };
const FIX_NAME = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'email', gdocs: 'Google Docs', markdown: 'Markdown', text: 'plain text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
let tick = null;           // { dest, until }: the ✓ on an app row/icon, shown for exactly TICK_MS whatever else redraws
const TICK_MS = 1500;
let shellFlash = null; // one-off message after a fix: { sub, tone, collapse }
let tickTimer = null;  // takes the ✓ back off a second or two after a convert
const APP_NAME = 'Morph'; // the name people see (one place to change it)
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

// ---------------------------------------------------------------- recent copies & auto-format
// Labels of earlier copies (the popover keeps the content, in memory only).
// Clipboard history in the pill is parked behind a flag for now (FB_HISTORY=1 brings it back).
const FEATURES = { clipboardHistory: process.env.FB_HISTORY === '1', legacyThemes: process.env.FB_LEGACY_THEMES === '1', darkTheme: process.env.FB_DARK === '1' };
let historyItems = [];
ipcMain.on('history:set', (_e, items) => {
  historyItems = (Array.isArray(items) ? items : []).slice(0, 8).map((h) => ({
    id: Math.max(0, Math.floor(Number(h && h.id) || 0)),
    label: String((h && h.label) || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 40),
    from: String((h && h.from) || '').slice(0, 24),
  })).filter((h) => h.id);
  sendPillState();
});
// Auto-format: when you switch into one of your apps, convert what you
// copied for it, so a plain Ctrl V pastes it right. Not for copies made in
// that same app.
let autoDoneDest = null;   // what the clipboard is converted for right now
let copyRuleId = null;     // the app you were in when you copied
let copyWin = null; // { text, source } for the latest copy made elsewhere
let copyFlashUntil = 0;    // Date.now() until which the dot shows green
let copyFlashTimer = null;
let copySeq = 0;          // counts copies, so every one gets its scribble even if it looks like the last
function onExternalCopy(text) {
  copySeq++;
  tick = null;
  autoDoneDest = null;
  copyRuleId = currentRule ? currentRule.id : '';
  const w = focusWatcher && focusWatcher.state.current;
  copyWin = { text: typeof text === 'string' ? text : null, win: w ? { app: w.app, title: w.title } : null, rule: currentRule };
  // Brief green flash so the user sees "copy detected".
  copyFlashUntil = Date.now() + 2000;
  clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlashUntil = 0; sendPillState(); }, 2000);
}
function maybeAutoFormat() {
  const rule = currentRule;
  if (!settings.autoFormat || !rule || pendingQuick || !copySummary()) return;
  if (copyRuleId === rule.id || autoDoneDest === rule.dest) return;
  log('auto-format for', rule.name);
  pendingQuick = 'auto';
  pendingDest = rule.dest;
  quickConvert(rule.dest);
}
function setAutoFormat(on) {
  settings.autoFormat = !!on;
  saveSettings();
  rebuildMenu();
  if (on) maybeAutoFormat();
  sendPillState();
}

// Helper v6+ can press Ctrl V for you.
function canAutoPaste() {
  if (focusWatcher && focusWatcher.state.shellVersion >= 6) return true;
  return IS_MAC && settings.macAutoPaste === true;
}
// Press Ctrl V (⌘V on Mac) in the app in front.
function pasteNow(shift) {
  if (usingShellPill()) { shellPaste(shift); return; }
  if (!IS_MAC) return;
  // System Events keystrokes need Accessibility permission for Format Bridge
  // (System Settings › Privacy & Security › Accessibility). Wait a moment so
  // you've let go of any shortcut keys.
  setTimeout(() => {
    execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down' + (shift ? ', shift down' : '') + '}'], { timeout: 3000 }, (err) => {
      if (!err) return;
      log('mac paste failed:', err.message);
      shellFlash = { sub: 'Copied. Press ⌘V to paste. (To paste for you, allow ' + APP_NAME + ' in System Settings › Privacy & Security › Accessibility.)', tone: 'warn', open: true };
      sendPillState();
    });
  }, 350);
}
const TERMINAL_RE = /terminal|konsole|kitty|alacritty|wezterm|tilix|xterm|ghostty/i;
function pasteNeedsShift() {
  const w = focusWatcher && focusWatcher.state.current;
  return !!(w && TERMINAL_RE.test(w.app || ''));
}
// "Last copy: Slack, table, 3 rows" -> { from: 'Slack', what: 'table, 3 rows' }
function copySummary() {
  if (trayStatus === 'Nothing copied yet' || /^Nothing to convert/.test(trayStatus)) return null;
  const t = trayStatus.replace(/^Last copy: /, '');
  const i = t.indexOf(', ');
  return i < 0 ? { from: t, what: '' } : { from: t.slice(0, i), what: t.slice(i + 2) };
}

// ---------------------------------------------------------------- keyboard shortcuts
// On GNOME (Wayland) the helper grabs them, since an app can't see keys
// while another app is in front; elsewhere Electron's global shortcuts do.
let keysFailed = [];
let keysMode = '';
const shortcutName = (id) => (SHORTCUTS.find((x) => x.id === id) || {}).name || id;
async function applyShortcuts() {
  const on = settings.shortcuts.filter((k) => k.on);
  globalShortcut.unregisterAll();
  if (focusWatcher && focusWatcher.state.shellVersion >= 10) {
    keysMode = 'gnome:' + focusWatcher.state.shellVersion;
    const failed = await setShellShortcuts(on.map((k) => ({ id: k.id, accel: k.accel })));
    keysFailed = failed || [];
  } else {
    keysMode = 'electron';
    keysFailed = [];
    on.forEach((k) => {
      let ok = false;
      try { ok = globalShortcut.register(accelToElectron(k.accel), () => onShortcut(k.id)); } catch (e) { ok = false; }
      if (!ok) keysFailed.push(k.id);
    });
  }
  log('shortcuts (' + keysMode + '):', on.map((k) => k.id + '=' + accelLabel(k.accel)).join(', ') || 'none', keysFailed.length ? '| taken: ' + keysFailed.join(', ') : '');
  rebuildMenu();
}
// Re-apply when the helper appears or changes version (e.g. after a login).
function ensureShortcuts() {
  const want = focusWatcher && focusWatcher.state.shellVersion >= 10 ? 'gnome:' + focusWatcher.state.shellVersion : 'electron';
  if (want !== keysMode) applyShortcuts();
}
function onShortcut(id) {
  log('shortcut:', id);
  const rule = currentRule;
  const autoPaste = canAutoPaste();
  if (id === 'pill') {
    // Hidden with ✕? This brings it back.
    if (!settings.pillEnabled) { settings.pillEnabled = true; saveSettings(); rebuildMenu(); updatePill(); }
    if (!usingShellPill() && pill) { if (!pill.isVisible()) { placePill(); pill.showInactive(); } pill.webContents.send('pill:toggle'); }
    return;
  }
  if (id === 'full') { togglePopover(); return; }
  if (id === 'pdf') { makePdf(); return; }
  if (id === 'auto') {
    setAutoFormat(!settings.autoFormat);
    shellFlash = { sub: 'Auto-format is ' + (settings.autoFormat ? 'on' : 'off') + '.', tone: 'ok', collapse: true, open: true };
    sendPillState();
    return;
  }
  if (id === 'paste' || id === 'plain') {
    const dest = id === 'plain' ? 'text' : rule && rule.dest;
    if (!dest) {
      shellFlash = { sub: 'Not one of your apps. Pick a format below.', tone: 'warn', open: true };
      sendPillState();
      return;
    }
    pendingQuick = autoPaste ? 'paste' : null;
    pendingDest = dest;
    quickConvert(dest);
    return;
  }
  if (id === 'prev') {
    const h = historyItems[0];
    if (!h || !win) { shellFlash = { sub: 'No earlier copy yet.', tone: 'warn', open: true }; sendPillState(); return; }
    pendingQuick = autoPaste ? 'paste' : null;
    pendingDest = rule ? rule.dest : null;
    win.webContents.send('history:use', h.id, rule ? rule.dest : '');
  }
}
function shortcutsForSettings() {
  return settings.shortcuts.map((k) => ({ id: k.id, name: shortcutName(k.id), accel: k.accel, label: accelLabel(k.accel, IS_MAC), on: k.on, taken: keysFailed.includes(k.id) }));
}

// The pill's own settings page (works even where the full view can't draw).
let pillView = 'main';
const OFF_DOT = '#3a3d42';
const ACCENT = '#6ea2ff'; // consistent blue accent for settings
function settingsSpec(base, page) {
  const offered = settings.pillDests || ALL_DESTS;
  const nav = [
    { id: 'settings', label: 'General', icon: 'tune' },
    { id: 'edit', label: 'Apps', icon: 'grid_view' },
    { id: 'keys', label: 'Shortcuts', icon: 'keyboard' },
  ].concat(pickThemes().length > 1 ? [{ id: 'look', label: 'Appearance', icon: 'palette' }] : [])
    .concat([{ id: 'size', label: 'Size', icon: 'aspect_ratio' }, { id: 'about', label: 'About', icon: 'info' }]);
  const cur = nav.some((n) => n.id === page) ? page : 'settings';
  const spec = Object.assign(base, {
    view: 'settings', title: 'Settings', sub: '', subTone: '', back: 'view:main',
    primary: null, secondary: null, options: [], section: '', groups: [], recentTitle: '', recent: [], links: [], collapseAfterMs: 0, home: false, edit: null, note: '',
    nav: nav.map((n) => ({ label: n.label, icon: n.icon, action: 'view:' + n.id, on: n.id === cur })),
  });
  const sw = (on) => (on ? 'on' : 'off');
  if (cur === 'edit') {
    const hidden = ALL_DESTS.filter((d) => !offered.includes(d));
    spec.pane = { title: 'Apps', lede: 'Drag to reorder. Switch apps on or off.',
      apps: offered.map((d, i) => ({ label: OPTION_LABEL[d], dest: d, sw: 'on', action: 'dest:' + d,
        up: i > 0 ? 'dmove:' + i + 'u' : '', down: i < offered.length - 1 ? 'dmove:' + i + 'd' : '' }))
        .concat(hidden.map((d) => ({ label: OPTION_LABEL[d], dest: d, sw: 'off', action: 'dest:' + d, up: '', down: '' }))) };
  } else if (cur === 'keys') {
    const KEY_SHORT = { paste: 'Paste, fixed', plain: 'Paste as plain text', pill: 'Open the pill', prev: 'Paste previous copy', auto: 'Auto-format on/off', full: 'Open full view', pdf: 'Save as PDF' };
    const KEY_ICON = { paste: 'content_paste', plain: 'notes', pill: 'grid_view', prev: 'restart_alt', auto: 'bolt', full: 'description', pdf: 'description' };
    spec.pane = { title: 'Shortcuts', lede: 'Click a shortcut to turn it on or off.',
      keys: shortcutsForSettings().map((k, i) => ({ label: KEY_SHORT[k.id] || k.name, icon: KEY_ICON[k.id] || 'keyboard', keys: k.label.split(' ').filter(Boolean).slice(0, 5), sw: sw(k.on && !k.taken), note: k.taken ? 'Taken by another app' : '', action: 'key:' + i })) };
  } else if (cur === 'look') {
    spec.pane = { title: 'Appearance', lede: 'Morph follows the look you pick here.',
      cards: pickThemes().map((id) => ({ label: THEME_NAMES[id], sub: '', look: id, on: settings.theme === id, action: 'theme:' + id })) };
  } else if (cur === 'size') {
    const SUB = { s: 'Compact', m: 'Default', l: 'Roomy' };
    spec.pane = { title: 'Size', lede: 'Pick the size that fits how you work.',
      cards: ['s', 'm', 'l'].map((z) => ({ label: SIZE_NAMES[z], sub: SUB[z], size: z, on: settings.size === z, action: 'size:' + z })) };
  } else if (cur === 'about') {
    spec.pane = { title: 'About', lede: APP_NAME + ' for Linux.',
      about: { name: APP_NAME, version: 'Version ' + app.getVersion() + (IS_LINUX ? ' · GNOME' : ''),
        text: 'Copy something formatted in one app, and ' + APP_NAME + ' re-shapes it for wherever you paste next. Nothing you copy leaves your computer.',
        legal: 'Slack, Jira, Confluence, Google Docs, Notion, Linear and other names and logos belong to their owners and only show which app a format is for. ' + APP_NAME + ' is not affiliated with or endorsed by them.' } };
  } else {
    spec.pane = { title: 'General', lede: 'How ' + APP_NAME + ' behaves when you copy.',
      opts: [
        { icon: 'bolt', label: 'Convert automatically', sub: 'Fix copies when you switch apps', sw: sw(settings.autoFormat), action: 'toggle:auto' },
        { icon: 'link', label: 'Keep the source link', sub: 'Add a link back to where it came from', sw: sw(settings.linkBack), action: 'toggle:link' },
        { icon: 'grid_view', label: 'App icons on the tab', sub: 'Convert with one click, without opening it', sw: sw(settings.tabIcons), action: 'toggle:tabicons' },
        { icon: 'more_horiz', label: 'Icon in the top bar', sub: 'The tray icon and its menu. Off by default on Linux', sw: sw(settings.trayIcon), action: 'toggle:tray' },
        { icon: 'public', label: 'Show the pill in every app', sub: 'Off: only in the apps you chose', sw: sw(settings.pillMode === 'always'), action: 'toggle:mode' },
      ].concat(IS_MAC ? [{ icon: 'content_paste', label: 'Paste for me', sub: 'Needs Accessibility permission.', sw: sw(settings.macAutoPaste), action: 'toggle:macpaste' }] : []) };
  }
  return spec;
}
const PILL_PAGES = ['settings', 'look', 'size', 'keys', 'edit', 'about'];
function onSettingsAction(kind, arg) {
  if (kind === 'view') pillView = PILL_PAGES.includes(arg) ? arg : 'main';
  // Edit apps (the home grid): rearrange, hide, add.
  if (kind === 'dswap' && /^\d{1,2}t\d{1,2}$/.test(arg)) {
    const list = (settings.pillDests || ALL_DESTS).slice();
    const [a, b] = arg.split('t').map(Number);
    if (a !== b && a < list.length && b < list.length) {
      [list[a], list[b]] = [list[b], list[a]];
      settings.pillDests = cleanDests(list);
      saveSettings();
    }
    sendPillState();
    return;
  }
  if (kind === 'dmove' && /^\d{1,2}[ud]$/.test(arg)) {
    const list = (settings.pillDests || ALL_DESTS).slice();
    const i = parseInt(arg, 10);
    const j = arg.endsWith('u') ? i - 1 : i + 1;
    if (i < list.length && j >= 0 && j < list.length) {
      [list[i], list[j]] = [list[j], list[i]];
      settings.pillDests = cleanDests(list);
      saveSettings();
    }
    sendPillState();
    return;
  }
  if (kind === 'dput' && /^\d{1,2}t\d{1,2}$/.test(arg)) {
    const list = (settings.pillDests || ALL_DESTS).slice();
    const [a, b] = arg.split('t').map(Number);
    if (a !== b && a < list.length && b < list.length) {
      const [d] = list.splice(a, 1);
      list.splice(b, 0, d);
      settings.pillDests = cleanDests(list);
      saveSettings();
    }
    sendPillState();
    return;
  }
  if (kind === 'dhide' && /^\d{1,2}$/.test(arg)) {
    const list = (settings.pillDests || ALL_DESTS).slice();
    if (list.length > 1 && Number(arg) < list.length) {
      list.splice(Number(arg), 1);
      settings.pillDests = cleanDests(list);
      saveSettings();
    }
    sendPillState();
    return;
  }
  if (kind === 'dadd' && ALL_DESTS.includes(arg)) {
    const list = (settings.pillDests || ALL_DESTS).slice();
    if (!list.includes(arg)) list.push(arg);
    settings.pillDests = cleanDests(list);
    saveSettings();
    sendPillState();
    return;
  }
  if (kind === 'size' && ['s', 'm', 'l'].includes(arg)) settings.size = arg;
  if (kind === 'key' && /^\d{1,2}$/.test(arg) && settings.shortcuts[Number(arg)]) {
    const k = settings.shortcuts[Number(arg)];
    k.on = !k.on;
    settings.shortcuts = normalizeShortcuts(settings.shortcuts);
    saveSettings();
    applyShortcuts().then(sendPillState);
    return;
  }
  if (kind === 'theme' && THEMES.includes(arg)) settings.theme = arg;
  if (kind === 'toggle' && arg === 'auto') { setAutoFormat(!settings.autoFormat); return; }
  if (kind === 'toggle' && arg === 'link') settings.linkBack = !settings.linkBack;
  if (kind === 'toggle' && arg === 'tabicons') settings.tabIcons = !settings.tabIcons;
  if (kind === 'toggle' && arg === 'tray') {
    settings.trayIcon = !settings.trayIcon;
    if (settings.trayIcon) createTray(); else if (tray) { try { tray.destroy(); } catch (e) { /* gone */ } tray = null; }
  }
  if (kind === 'toggle' && arg === 'mode') { settings.pillMode = settings.pillMode === 'always' ? 'apps' : 'always'; saveSettings(); rebuildMenu(); updatePill(); return; }
  if (kind === 'toggle' && arg === 'macpaste' && IS_MAC) settings.macAutoPaste = !settings.macAutoPaste;
  if (kind === 'dest' && ALL_DESTS.includes(arg)) {
    const set = new Set(settings.pillDests || ALL_DESTS);
    if (set.has(arg) && set.size > 1) set.delete(arg); else set.add(arg);
    settings.pillDests = cleanDests([...set]);
  }
  saveSettings();
  rebuildMenu();
  sendPillState();
}

// Where the current copy came from, read from the window title when you
// copied: "Slack · #design-review", "Jira · KAN-4 Login fails".
function copyPlace() {
  if (!copyWin || !copyWin.win) return null;
  const ctx = describeSource(copyWin.win, copyWin.rule, '', { atlassian: settings.atlassianSite });
  if (!ctx || !ctx.tool || !ctx.label) return null;
  return { tool: ctx.tool, where: ctx.label.replace(/\s+\([^)]*\)$/, ''), dest: copyWin.rule && ALL_DESTS.includes(copyWin.rule.dest) ? copyWin.rule.dest : '' };
}

function shellSpec() {
  const rule = currentRule;
  const place = copyPlace();
  const copy = copySummary();
  const flash = shellFlash;
  const tickDest = tick && Date.now() < tick.until ? tick.dest : null;
  const offered = settings.pillDests || ALL_DESTS;
  const others = offered.filter((d) => !rule || d !== rule.dest);
  const rows = [];
  // Nothing on the clipboard: the apps stay in place but can't be clicked (there's nothing to convert).
  const idle = !copy;
  const imageOnly = idle && /image$/.test(trayStatus);
  for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2).map((d) => (tickDest === d
    ? { label: OPTION_LABEL[d], done: true }
    : idle ? { label: OPTION_LABEL[d], dest: d, off: true }
    : { label: OPTION_LABEL[d], dest: d, action: 'fix:' + d, color: DEST_COLOR[d], busy: OPTION_LABEL[d] + '…' })));
  const spec = {
    visible: pillShouldShow(),
    theme: settings.theme,
    size: settings.size,
    openNow: !!(flash && flash.open),
    chips: settings.theme === 'compact' ? 'tiles' : 'chips',
    settled: !!flash, // an answer to your last click: stop showing "…"
    dot: flash && flash.tone === 'ok' ? 'ok' : Date.now() < copyFlashUntil ? 'ok' : copy ? 'has' : 'none',
    handleColor: rule ? DEST_COLOR[rule.dest] : '',
    copyId: copy ? copySeq : 0,
    yFrac: typeof settings.pillYFrac === 'number' ? settings.pillYFrac : 0.42,
    side: settings.pillSide,
    monitor: settings.pillMonitor,
    // "Copied from Slack" / "#design-review · Table, 3 rows"
    title: APP_NAME,
    sub: '',
    subTone: '',
    primary: null,
    secondary: null,
    section: '',
    options: [],
    recentTitle: '',
    recent: [],
    view: 'main',
    gear: 'view:settings',
    // the card under the title: what's on the clipboard
    source: copy ? { icon: /table/i.test(copy.what || '') ? 'table' : 'content_paste', dest: place ? place.dest : '', title: 'Copied from ' + (place ? place.tool : copy.from), sub: [place ? place.where : '', copy.what].filter(Boolean).join(' · ') }
      : imageOnly ? { icon: 'image', title: 'Image copied', sub: 'Nothing to convert. Paste it as it is.' }
      : { icon: 'content_paste', title: 'Nothing copied yet', sub: 'Copy something to start' },
    links: [],
    // quick mode: the first four apps sit on the closed tab, one click each
    tab: settings.tabIcons ? others.slice(0, 4).map((d) => (tickDest === d
      ? { label: OPTION_LABEL[d], dest: d, done: true }
      : idle ? { label: OPTION_LABEL[d], dest: d, off: true }
      : { label: OPTION_LABEL[d], dest: d, action: 'fix:' + d, color: DEST_COLOR[d] })) : [],
    original: null,
    collapseAfterMs: 0,
    note: '',
    edit: null,
  };
  if (pillView !== 'main') return settingsSpec(spec, pillView);
  if (copy && rule && settings.autoFormat && autoDoneDest === rule.dest) spec.sub = (copy.what ? copy.what + ' · ' : '') + 'already fixed, just press ' + MOD_KEY + ' V';
  if (FEATURES.clipboardHistory && historyItems.length) {
    spec.recentTitle = rule ? 'Earlier copies · click to paste' : 'Earlier copies · click to copy again';
    spec.recent = historyItems.slice(0, 2).map((h) => ({ label: h.label, hint: h.from, action: 'hist:' + h.id, busy: rule ? 'Pasting…' : 'Copying…' }));
  }
  // The apps are always there, copied or not (nothing copied: a click just says so).
  spec.section = rule ? 'Copy for another app' : 'Copy it for';
  spec.options = rows;
  if (copy) {
    // what you first copied, put back as it was
    spec.original = tickDest === 'original' ? { label: 'Original', done: true } : { label: 'Original', hint: 'as copied', action: 'orig:', busy: 'Restoring…' };
    // No "Paste into …" row: the app rows above already copy in one click.
    // What link back will add, so you see it before you paste.
    if (rule && settings.linkBack && place && copyWin && copyWin.rule && copyWin.rule.id !== rule.id && rule.dest !== 'text') {
      spec.note = 'Adds “Source: ' + place.tool + ' · ' + place.where + '”';
    }
  } else {
    spec.secondary = { label: 'Check again', action: 'refresh:', busy: 'Checking…' };
  }
  // Save as PDF sits with the formats: the last chip.
  if (spec.options.length) {
    const pdfChip = tickDest === 'pdf' ? { label: 'PDF ↓', done: true } : idle ? { label: 'PDF ↓', action: 'pdf:', off: true } : { label: 'PDF ↓', action: 'pdf:', color: '#d93025', busy: 'Saving…' };
    const last = spec.options[spec.options.length - 1];
    if (last.length < 2) last.push(pdfChip); else spec.options.push([pdfChip]);
  }
  if (flash && flash.pdf && lastPdf) spec.links = [{ label: 'Open the PDF', action: 'openpdf:' }, { label: 'Show in folder', action: 'showpdf:' }];
  if (flash) {
    if (flash.done && spec.primary) spec.primary = { label: flash.done, done: true };
    else { spec.sub = flash.sub; spec.subTone = flash.tone; }
    if (flash.collapse) spec.collapseAfterMs = tune && 'clMs' in settings.tuneVals ? settings.tuneVals.clMs : (flash.done ? 1200 : 1800);
  }
  return spec;
}
// (GNOME skips specs identical to what it's showing, so nothing is rebuilt
// under your mouse.)
// The tuner rides along with every spec: the knobs (sent again only when the
// list changes), their values, and ready-made style rules for each pill.
let tuneGen = 0, tuneMsg = '', tuneTimer = null, tuneOpened = false;
function addTune(spec) {
  if (!tune) return spec;
  spec.visible = true;
  if (!tuneOpened) { tuneOpened = true; spec.openNow = true; } // starts open
  const v = settings.tuneVals;
  spec.tune = {
    gen: tuneGen, vals: v, byIdx: Object.keys(v).reduce((o, id) => { o[tune.BY_ID[id].idx] = v[id]; return o; }, {}), msg: tuneMsg, count: Object.keys(v).length,
    defs: tune.describe(),
    cssG: tune.css(v, spec.size, 'g'), cssW: tune.css(v, spec.size, 'w'),
    minH: (tune.val(v, 'minh')) * (tune.SIZE_K[spec.size] || 1), opacity: tune.val(v, 'pop') / 100,
  };
  return spec;
}
function onTune(a) {
  const r = tune.parseAction(a);
  if (!r) return;
  if (r.op === 'set') { if (tune.cleanVals({ [r.id]: r.v })[r.id] !== undefined) settings.tuneVals[r.id] = tune.cleanVals({ [r.id]: r.v })[r.id]; else delete settings.tuneVals[r.id]; }
  else if (r.op === 'reset') { delete settings.tuneVals[r.id]; tuneGen++; }
  else if (r.op === 'resetall') { settings.tuneVals = {}; tuneGen++; }
  else if (r.op === 'copy') {
    const out = { formatBridgeTune: 1, base: 'medium', changed: settings.tuneVals };
    clipboard.writeText(JSON.stringify(out, null, 2));
    tuneMsg = '✓ Copied ' + Object.keys(settings.tuneVals).length + ' changes';
    setTimeout(() => { tuneMsg = ''; sendPillState(); }, 2500);
  }
  clearTimeout(tuneTimer);
  tuneTimer = setTimeout(() => { saveSettings(); sendPillState(); }, 25);
}
function sendShellPill() {
  const spec = addTune(shellSpec());
  shellFlash = null;
  setShellPill(spec);
}

function updatePill() {
  if (usingShellPill()) {
    if (pill && pill.isVisible()) pill.hide();
    log('pill (GNOME)', pillShouldShow() ? 'show' : 'hide', '| rule:', currentRule ? currentRule.name : 'none', '| mode:', settings.pillMode);
    sendShellPill();
    return;
  }
  if (!pill) return;
  log('pill', pillShouldShow() ? 'show' : 'hide', '| rule:', currentRule ? currentRule.name : 'none', '| detection:', focusWatcher ? focusWatcher.state.provider + '/' + focusWatcher.state.status : '-', '| mode:', settings.pillMode, '| enabled:', settings.pillEnabled);
  if (pillShouldShow()) {
    placePill();
    if (!pill.isVisible()) pill.showInactive();
  } else if (pill.isVisible() && !pillOpen) {
    pill.hide();
  }
  sendPillState();
}

function sendPillState() {
  if (usingShellPill()) { sendShellPill(); return; }
  if (!pill || pill.webContents.isLoading()) return;
  const spec = addTune(shellSpec());
  shellFlash = null;
  pill.webContents.send('pill:spec', spec);
}

function onFocusChange(win) {
  log('front window:', win ? JSON.stringify(win) : '(detection ' + (focusWatcher ? focusWatcher.state.status : '?') + ')');
  ensureShortcuts();
  if (win && isSelf(win)) return; // our own windows don't change "the app in front"
  const prevRule = currentRule;
  currentRule = win ? matchRule(settings.rules, win) : null;
  // Switching apps only tucks the pill away. It never opens by itself: you open it when you want it.
  if (pill && pillOpen && !usingShellPill() && win) pill.webContents.send('pill:collapse');
  updatePill();
  maybeAutoFormat();
}

// Settings, for the popover's Apps panel.
ipcMain.handle('settings:get', () => ({
  rules: settings.rules,
  pillEnabled: settings.pillEnabled,
  pillMode: settings.pillMode,
  autoFormat: settings.autoFormat,
  linkBack: settings.linkBack,
  theme: settings.theme,
  size: settings.size,
  sizes: ['s', 'm', 'l'].map((id) => ({ id, name: SIZE_NAMES[id] })),
  shortcuts: shortcutsForSettings(),
  keysOnGnome: keysMode.startsWith('gnome'),
  themes: pickThemes().map((id) => ({ id, name: THEME_NAMES[id] })),
  pillDests: settings.pillDests || ALL_DESTS,
  people: settings.people,
  canTheme: true,
  detection: focusWatcher ? { provider: focusWatcher.state.provider, status: focusWatcher.state.status, shellPill: !!focusWatcher.state.shellPill } : { provider: 'none', status: 'starting' },
  current: focusWatcher && focusWatcher.state.current ? focusWatcher.state.current : null,
}));
ipcMain.handle('settings:set', (_e, next) => {
  if (next && Array.isArray(next.rules)) settings.rules = normalizeRules(next.rules);
  if (next && typeof next.pillEnabled === 'boolean') settings.pillEnabled = next.pillEnabled;
  if (next && ['apps', 'always'].includes(next.pillMode)) settings.pillMode = next.pillMode;
  if (next && typeof next.linkBack === 'boolean') settings.linkBack = next.linkBack;
  if (next && THEMES.includes(next.theme)) settings.theme = next.theme;
  if (next && ['s', 'm', 'l'].includes(next.size)) settings.size = next.size;
  if (next && Array.isArray(next.shortcuts)) {
    settings.shortcuts = normalizeShortcuts(next.shortcuts.map((k) => ({ id: String(k && k.id), accel: k && validAccel(k.accel) ? k.accel : undefined, on: !!(k && k.on) })));
    setImmediate(() => applyShortcuts().then(sendPillState));
  }
  if (next && next.people && typeof next.people === 'object') settings.people = cleanPeople(next.people);
  if (next && Array.isArray(next.pillDests)) {
    // Keep the order you arranged on the pill; the full window only turns apps on or off.
    const want = cleanDests(next.pillDests);
    const cur = settings.pillDests || ALL_DESTS;
    settings.pillDests = want ? cur.filter((d) => want.includes(d)).concat(want.filter((d) => !cur.includes(d))) : null;
  }
  if (next && Array.isArray(next.pillDestsOrder)) { const o = cleanDests(next.pillDestsOrder); if (o) settings.pillDests = o; } // the window's own reordering
  if (next && typeof next.autoFormat === 'boolean') { settings.autoFormat = next.autoFormat; if (next.autoFormat) setImmediate(maybeAutoFormat); }
  saveSettings();
  if (focusWatcher && focusWatcher.state.current) currentRule = matchRule(settings.rules, focusWatcher.state.current);
  updatePill();
  rebuildMenu();
  return true;
});

// ---------------------------------------------------------------- clipboard
// Password managers mark secrets on the clipboard; never read those.
const SECRET_FORMATS = /x-kde-passwordmanagerhint|concealedtype|org\.nspasteboard\.(concealed|transient)|clipboard-history-exclude/i;
const STANDARD = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png', 'text/uri-list']);

function isSecret(formats) { return formats.some((f) => SECRET_FORMATS.test(f)); }
function printable(buf) {
  if (!buf.length) return true;
  const s = buf.subarray(0, 2048);
  let bad = 0;
  for (const b of s) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bad / s.length < 0.05;
}
function hex(buf) {
  return Array.from(buf.subarray(0, 512)).map((b) => b.toString(16).padStart(2, '0')).join(' ') + (buf.length > 512 ? ' …' : '');
}
function readClip() {
  const formats = clipboard.availableFormats();
  if (isSecret(formats)) return { formats, secret: true, text: '', html: '', rtf: '', image: null, others: [] };
  const out = { formats, text: clipboard.readText(), html: clipboard.readHTML(), rtf: '', image: null, others: [] };
  try { out.rtf = clipboard.readRTF(); } catch (e) { /* not everywhere */ }
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const size = img.getSize();
    out.image = { width: size.width, height: size.height, dataUrl: (size.width > 640 ? img.resize({ width: 640 }) : img).toDataURL() };
  }
  for (const f of formats) {
    if (STANDARD.has(f)) continue;
    try {
      const buf = clipboard.readBuffer(f);
      out.others.push({ format: f, bytes: buf.length, text: printable(buf) ? buf.toString('utf8').replace(/\u0000/g, '').slice(0, 200000) : null, hex: printable(buf) ? null : hex(buf) });
    } catch (e) { out.others.push({ format: f, bytes: 0, error: e.message }); }
  }
  return out;
}
function signature() {
  const formats = clipboard.availableFormats();
  if (isSecret(formats)) return 'secret';
  const text = clipboard.readText();
  return formats.join(',') + '|' + text.length + '|' + text.slice(0, 200) + '|' + clipboard.readHTML().length;
}

// Watch for new copies on Linux. macOS asks the user before an app reads
// the clipboard on its own, so there it reads only when you open the popover
// or use the tray menu.
function startWatching() {
  if (IS_MAC) return;
  lastSig = signature();
  setInterval(() => {
    let sig;
    try { sig = signature(); } catch (e) { return; }
    if (sig === lastSig) return;
    lastSig = sig;
    if (sig === 'secret') return;
    if (usingShellClip()) return; // GNOME's signal handles it, by content
    onExternalCopy(clipboard.readText());
    if (win) win.webContents.send('clip:changed');
  }, 700);
}

// On GNOME Wayland this app runs through XWayland and may not see what was
// copied in a Wayland app while it isn't in front, so ask GNOME as well.
async function readClipBest() {
  let out = null;
  try { out = readClip(); } catch (e) { out = { formats: [], text: '', html: '', rtf: '', image: null, others: [] }; }
  // On GNOME Wayland, GNOME's view of the clipboard is the reliable one: this
  // app runs through XWayland and may see an older copy. Images and other
  // formats still come from Electron for the inspector.
  if (usingShellClip()) {
    const sh = await shellReadClipboard();
    log('clipboard (GNOME):', sh ? sh.formats.join(',') + ' | text ' + sh.text.length + ' | html ' + sh.html.length + (sh.secret ? ' | secret' : '') : 'no answer, using Electron');
    if (sh) {
      const same = sh.text === out.text;
      out = Object.assign({}, same ? out : { rtf: '', image: null, others: [] }, { formats: sh.formats, secret: sh.secret, text: sh.text, html: sh.html, via: 'gnome' });
    }
  }
  if (out.secret) return out;
  // Where it came from (for "add a link back"), and the Atlassian site, once seen.
  const site = siteOf(out.html);
  if (site && site !== settings.atlassianSite) { settings.atlassianSite = site; saveSettings(); }
  out.context = copyWin && (copyWin.text === null || copyWin.text === out.text) ? describeSource(copyWin.win, copyWin.rule, out.html, { atlassian: settings.atlassianSite }) : null;
  out.linkBack = settings.linkBack;
  return out;
}
ipcMain.handle('clip:read', () => readClipBest());
let ownWriteUntil = 0;
let ownText = null; // what we last put on the clipboard
ipcMain.handle('clip:write', async (_e, payload) => {
  const html = payload && typeof payload.html === 'string' ? payload.html : '';
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  ownText = text;
  ownWriteUntil = Date.now() + 1500; // our own write is not "a new copy"
  if (html) clipboard.write({ html, text });
  else clipboard.writeText(text);
  lastSig = signature();
  // Check (and if needed repair) the write in the background: answering now makes the click feel instant.
  if (usingShellClip()) verifyWrite(html, text).catch((e) => log('write check failed:', e && e.message));
  return true;
});
// Make sure Wayland apps see what we wrote; if not, write through GNOME.
async function verifyWrite(html, text) {
  await new Promise((r) => setTimeout(r, 150));
  const sh = await shellReadClipboard();
  // Compare the text: leftover HTML from an older copy must not count.
  const ok = sh && sh.text === text;
  log('write check:', ok ? 'ok' : 'not visible to GNOME, writing through the helper');
  if (ok) return;
  ownWriteUntil = Date.now() + 1500;
  if (!(html && (await shellWriteClipboard('text/html', html)))) await shellWriteClipboard('text/plain', text);
}
ipcMain.handle('app:info', () => {
  const full = settings.shortcuts.find((k) => k.id === 'full');
  return { version: app.getVersion(), shortcut: full && full.on && !keysFailed.includes('full') ? accelToElectron(full.accel) : null, platform: process.platform, companion: true };
});
ipcMain.on('popover:hide', () => { if (win) win.hide(); });
ipcMain.on('tray:status', (_e, s) => {
  trayStatus = String(s || '').slice(0, 120) || 'Nothing copied yet';
  if (tray) { tray.setToolTip(APP_NAME + ' — ' + trayStatus); rebuildMenu(); }
  sendPillState();
  maybeAutoFormat();
});
ipcMain.on('quick:done', (_e, r) => {
  if (!r) return;
  const from = pendingQuick;
  pendingQuick = null;
  if (from === 'auto') {
    if (r.ok) autoDoneDest = pendingDest;
    log('auto-format', r.ok ? 'done for ' + r.name : 'skipped (nothing to convert)');
    sendPillState();
    return;
  }
  if (from === 'paste') {
    if (r.ok) {
      log('pasting into', r.name, pasteNeedsShift() ? '(Ctrl Shift V)' : '(Ctrl V)');
      pasteNow(pasteNeedsShift());
      autoDoneDest = pendingDest;
      shellFlash = { done: '✓ Pasted into ' + r.name, tone: 'ok', collapse: true };
    } else shellFlash = { sub: copySummary() ? 'Nothing to paste yet.' : '', tone: 'warn', collapse: false };
    sendPillState();
    return;
  }
  if (from === 'pill' && r.ok && !r.restored) autoDoneDest = pendingDest;
  if (from === 'pill') {
    shellFlash = r.ok
      ? { sub: '', tone: 'ok', collapse: false } // the row turns into a ✓ (see tick); no extra line, no auto-tuck
      : { sub: copySummary() ? 'Couldn’t convert that.' : '', tone: 'warn', collapse: false };
    if (r.ok) tick = { dest: r.restored ? 'original' : pendingDest, until: Date.now() + TICK_MS };
    sendPillState();
    // Any redraw in between still shows the ✓; this one takes it off, exactly TICK_MS after it appeared.
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tickTimer = null; tick = null; sendPillState(); }, TICK_MS);
    return;
  }
  if (Notification.isSupported()) {
    new Notification({ title: r.ok ? 'Ready to paste into ' + r.name : 'Nothing to convert', body: r.ok ? r.summary || '' : 'Copy something first.', silent: true }).show();
  }
});

// ---------------------------------------------------------------- pill clicks
// Every click on either pill (GNOME's, or the window pill on Mac and other
// Linux desktops) comes here as "<verb>:<arg>".
function handlePillAction(a, from) {
  if (typeof a !== 'string' || !/^[a-z]+:[a-z0-9]*$/.test(a)) return;
  log('pill click (' + from + '):', a);
  const [kind, dest] = a.split(':');
  if (kind === 'fix' && dest) { pendingQuick = 'pill'; pendingDest = dest; quickConvert(dest); }
  if (kind === 'paste' && dest) { pendingQuick = 'paste'; pendingDest = dest; quickConvert(dest); }
  if (kind === 'orig' && win) { pendingQuick = 'pill'; pendingDest = null; win.webContents.send('history:use', 0, ''); }
  if (kind === 'auto') setAutoFormat(!settings.autoFormat);
  // ✕: close the pill completely (everywhere) until you bring it back.
  if (kind === 'hide') hidePillCompletely();
  if (tune && ['tn', 'tc', 'tr', 'tcopy'].includes(kind)) { onTune(a); return; }
  if (kind === 'pdf') makePdf();
  if (kind === 'openpdf' && lastPdf) shell.openPath(lastPdf);
  if (kind === 'showpdf' && lastPdf) shell.showItemInFolder(lastPdf);
  if (['view', 'theme', 'toggle', 'dest', 'size', 'dswap', 'dhide', 'dadd', 'dmove', 'dput'].includes(kind)) onSettingsAction(kind, dest);
  // "key:paste" is a shortcut you pressed; "key:3" toggles one in Settings.
  if (kind === 'key' && /^[a-z]+$/.test(dest)) onShortcut(dest);
  if (kind === 'key' && /^\d{1,2}$/.test(dest)) onSettingsAction('key', dest);
  // An earlier copy: paste it fixed for this app, or put it back as it was.
  if (kind === 'hist' && /^\d{1,6}$/.test(dest) && win) {
    const rule = currentRule;
    if (rule && canAutoPaste()) { pendingQuick = 'paste'; pendingDest = rule.dest; }
    else { pendingQuick = 'pill'; pendingDest = null; }
    win.webContents.send('history:use', Number(dest), rule ? rule.dest : '');
  }
  if (kind === 'refresh' && win) win.webContents.send('clip:changed');
  if (kind === 'open') { showPopover(); if (dest && win) win.webContents.send('popover:select', dest); }
  if (kind === 'apps') { showPopover(); if (win) win.webContents.send('popover:apps'); }
  // Opening needs no refresh: copies are already tracked as they happen (and a redraw here made the panel jump).
  // You dragged it: remember the height (in thousandths of the screen).
  // "r0y420": right edge, monitor 0, 42% down.
  const mv = kind === 'moved' && /^([lr])(\d)y(\d{1,4})$/.exec(dest);
  if (mv) {
    settings.pillSide = mv[1];
    settings.pillMonitor = Number(mv[2]);
    settings.pillYFrac = Math.min(0.95, Math.max(0.05, Number(mv[3]) / 1000));
    saveSettings();
    log('pill moved to the', mv[1] === 'l' ? 'left' : 'right', 'edge of monitor', mv[2]);
  }
}

function hidePillCompletely() {
  settings.pillEnabled = false;
  saveSettings();
  rebuildMenu();
  updatePill();
  const keys = settings.shortcuts.find((k) => k.id === 'pill');
  const how = (keys && keys.on ? accelLabel(keys.accel, IS_MAC) + ' or ' : '') + '“Show the pill” in the ' + (IS_MAC ? 'menu bar' : 'tray') + ' menu';
  log('pill hidden by ✕');
  if (Notification.isSupported()) new Notification({ title: APP_NAME + ' pill hidden', body: 'Bring it back with ' + how + '.', silent: true }).show();
}

// ---------------------------------------------------------------- Save as PDF
// Prints the converted content to a PDF in Downloads. The page is our own
// generated HTML, shown in a hidden window with scripts off and nothing
// allowed to load except images; the temporary file is deleted right after.
let pdfFromPill = false;
let lastPdf = '';
function pdfName(title) {
  const base = String(title || APP_NAME).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || APP_NAME;
  const dir = app.getPath('downloads');
  let name = base + '.pdf';
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 100; i++) name = base + ' (' + i + ').pdf';
  return { dir, name };
}
const PRINT_CSS = 'body{font:11pt/1.5 "Inter","Ubuntu","Segoe UI",Arial,sans-serif;color:#1d1f23;margin:0}' +
  'table{border-collapse:collapse}td,th{border:1px solid #c9ced4;padding:4px 8px;vertical-align:top}' +
  'pre{white-space:pre-wrap;word-break:break-word}img{max-width:100%}h1,h2,h3{line-height:1.25}';
ipcMain.handle('pdf:save', async (_e, doc) => {
  const fromPill = pdfFromPill;
  pdfFromPill = false;
  const html = doc && typeof doc.html === 'string' ? doc.html.slice(0, 5000000) : '';
  if (!html) return { ok: false };
  const tmp = path.join(os.tmpdir(), 'morph-' + process.pid + '-' + Date.now() + '.html');
  const page = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\'">' +
    '<style>' + PRINT_CSS + '</style></head><body>' + html.replace(/<meta charset="utf-8">/i, '') + '</body></html>';
  let w = null;
  try {
    fs.writeFileSync(tmp, page, { mode: 0o600 });
    w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await w.loadFile(tmp);
    const data = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    const { dir, name } = pdfName(doc.title);
    fs.mkdirSync(dir, { recursive: true });
    lastPdf = path.join(dir, name);
    fs.writeFileSync(lastPdf, data);
    log('saved PDF:', lastPdf, '(' + data.length + ' bytes)');
    if (fromPill) {
      // The pill's own layout stays put: the PDF row shows the ✓ like the other apps, and a notification says where it went.
      tick = { dest: 'pdf', until: Date.now() + TICK_MS };
      sendPillState();
      clearTimeout(tickTimer);
      tickTimer = setTimeout(() => { tickTimer = null; tick = null; sendPillState(); }, TICK_MS);
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Saved ' + name, body: 'In your Downloads folder. Click to show it.', silent: true });
        n.on('click', () => { try { shell.showItemInFolder(lastPdf); } catch (e) { /* gone */ } });
        n.show();
      }
    }
    return { ok: true, name, folder: 'Downloads' };
  } catch (e) {
    log('PDF failed:', e.message);
    if (fromPill) { shellFlash = { sub: 'Couldn’t save the PDF.', tone: 'warn' }; sendPillState(); }
    return { ok: false };
  } finally {
    if (w) w.destroy();
    try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  }
});
ipcMain.on('pdf:done', (_e, r) => {
  pdfFromPill = false;
  if (r && !r.ok) { shellFlash = { sub: copySummary() ? 'Nothing to save yet.' : '', tone: 'warn' }; sendPillState(); }
});
function makePdf() {
  if (!win) return;
  pdfFromPill = true;
  win.webContents.send('pdf:make');
}

// ---------------------------------------------------------------- start at login
function autostartFile() { return path.join(os.homedir(), '.config', 'autostart', 'morph.desktop'); }
function getAutostart() {
  if (IS_LINUX) return fs.existsSync(autostartFile());
  return app.getLoginItemSettings().openAtLogin;
}
function setAutostart(on) {
  if (IS_LINUX) {
    const file = autostartFile();
    if (!on) { try { fs.unlinkSync(file); } catch (e) { /* not there */ } return; }
    // Packaged: the AppImage (or installed binary). Unpackaged: electron + this folder.
    const exec = process.env.APPIMAGE
      ? '"' + process.env.APPIMAGE + '"'
      : app.isPackaged ? '"' + process.execPath + '"' : '"' + process.execPath + '" "' + app.getAppPath() + '"';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=' + APP_NAME, 'Comment=Paste formatted content correctly anywhere', 'Exec=' + exec + ' --hidden', 'Icon=' + path.join(__dirname, 'build', 'icon.png'), 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join('\n'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

// ---------------------------------------------------------------- tray
// Tray / menu bar: a simple clipboard-and-bridge glyph. On Mac a "template"
// image, so it follows the light or dark menu bar; on Linux a white one for
// the dark top bar. (@2x versions are picked up for sharp screens.)
function trayIcon() {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
}
function quickConvert(dest) {
  if (win) win.webContents.send('quick:convert', dest);
}
function rebuildMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: trayStatus, enabled: false },
    { type: 'separator' },
    { label: 'Open ' + APP_NAME, click: showPopover },
    {
      label: 'Convert clipboard for',
      submenu: DESTS.map(([id, name]) => ({ label: name, click: () => quickConvert(id) })),
    },
    { type: 'separator' },
    {
      label: 'Pill',
      submenu: [
        { label: 'Show the pill', type: 'checkbox', checked: settings.pillEnabled, click: (i) => { settings.pillEnabled = i.checked; saveSettings(); updatePill(); } },
        { type: 'separator' },
        { label: 'Only in chosen apps', type: 'radio', checked: settings.pillMode === 'apps', click: () => { settings.pillMode = 'apps'; saveSettings(); updatePill(); } },
        { label: 'In every app', type: 'radio', checked: settings.pillMode === 'always', click: () => { settings.pillMode = 'always'; saveSettings(); updatePill(); } },
        { type: 'separator' },
        { label: 'Choose apps…', click: () => { showPopover(); if (win) win.webContents.send('popover:apps'); } },
      ],
    },
    { label: 'Look', submenu: pickThemes().map((id) => ({ label: THEME_NAMES[id], type: 'radio', checked: settings.theme === id, click: () => { settings.theme = id; saveSettings(); sendPillState(); } })) },
    { label: 'Size', submenu: ['s', 'm', 'l'].map((z) => ({ label: SIZE_NAMES[z], type: 'radio', checked: settings.size === z, click: () => { settings.size = z; saveSettings(); sendPillState(); } })) },
    {
      label: 'Keyboard shortcuts',
      submenu: shortcutsForSettings().map((k, i) => ({
        label: k.name + '   ' + k.label + (k.taken ? ' (taken)' : ''), type: 'checkbox', checked: k.on,
        click: (item) => { settings.shortcuts[i].on = item.checked; settings.shortcuts = normalizeShortcuts(settings.shortcuts); saveSettings(); applyShortcuts().then(sendPillState); },
      })),
    },
    { label: 'Add a link back to where I copied from', type: 'checkbox', checked: settings.linkBack, click: (i) => { settings.linkBack = i.checked; saveSettings(); sendPillState(); } },
    { label: 'Auto-format when I switch apps', type: 'checkbox', checked: settings.autoFormat, click: (i) => setAutoFormat(i.checked) },
    { label: 'Forget earlier copies', click: () => { if (win) win.webContents.send('history:clear'); } },
    { label: 'Start at login', type: 'checkbox', checked: getAutostart(), click: (item) => { setAutostart(item.checked); rebuildMenu(); } },
    { label: 'Quit ' + APP_NAME, click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}
function createTray() {
  if (tray || !settings.trayIcon) return; // the icon in the top bar is optional
  tray = new Tray(trayIcon());
  tray.setToolTip(APP_NAME);
  rebuildMenu();
  // macOS and Windows report clicks; Ubuntu's tray only opens the menu.
  tray.on('click', togglePopover);
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  if (IS_MAC && app.dock) app.dock.hide();
  // Copy/paste shortcuts inside the popover need an Edit menu on macOS.
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  loadSettings();
  createPopover();
  createPill();
  createTray();
  focusWatcher = createFocusWatcher({
    onChange: (w) => onFocusChange(w),
    // Clicks on the GNOME-drawn pill: "fix:jira", "open:slack", ...
    onAction: (a) => handlePillAction(a, 'GNOME'),
    // Something new was copied (GNOME tells us even when Electron can't see it).
    // Something was copied. Ours (a conversion we just wrote) or yours?
    // Decide by content, not by timing alone.
    onClipboard: async () => {
      const sh = usingShellClip() ? await shellReadClipboard() : null;
      // Ours if the text matches (ignoring line-ending and trailing-space differences that clipboards add),
      // or if it arrives right after our own write. Some conversions (Jira, for one) read back slightly
      // different, and counting those as a new copy wiped the ✓ at once.
      const norm = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n').replace(/\s+$/g, '');
      const sameText = !!sh && ownText !== null && norm(sh.text) === norm(ownText);
      const justWrote = Date.now() <= ownWriteUntil;
      const ours = sameText || justWrote;
      log('clipboard changed:', ours ? 'ours (' + (sameText ? 'same text' : 'just written') + ')' : 'a new copy');
      if (!ours) { onExternalCopy(sh ? sh.text : null); updatePill(); maybeAutoFormat(); }
      if (win) win.webContents.send('clip:changed'); // the popover ignores repeats
    },
  });
  ensureShortcuts();
  rebuildMenu();
  startWatching();
  // First run: turn on start-at-login once, so the companion is just there.
  const flag = path.join(app.getPath('userData'), 'first-run-done');
  if (!fs.existsSync(flag)) {
    try { setAutostart(true); fs.writeFileSync(flag, '1'); } catch (e) { /* not fatal */ }
    rebuildMenu();
    win.once('ready-to-show', () => showPopover());
  } else if (!process.argv.includes('--hidden')) {
    win.once('ready-to-show', () => showPopover());
  }
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (focusWatcher) focusWatcher.stop(); });
// A tray app keeps running with no windows open.
app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });
