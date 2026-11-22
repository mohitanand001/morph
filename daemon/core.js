// Morph's background program, the logic only. No Electron, no window, no Node-only calls.
// It talks to the world through an "io" object (clipboard and pill through the GNOME helper, files,
// notifications, PDF), so the same code runs under GJS on the desktop and under Node in the tests.
//
// io = {
//   version, home,
//   store: { read() -> string|null, write(string) },
//   shell: { setPill(spec), readClip() -> Promise<{formats,secret,text,html}|null>,
//            writeClip(mime, data) -> Promise<bool>, paste(shift), setShortcuts([{id,accel}]) -> Promise<string[]|null> },
//   uninstall: { run() -> Promise<bool> },   (optional)
//   update: { check() -> Promise<{version}|null>, run() -> Promise<bool> },   (optional)
//   notify(title, body), savePdf({ast,title}) -> Promise<{ok,name,path}>, openPath(path), openUri(uri), showInFolder(path),
//   now(), setTimeout(fn, ms), clearTimeout(id), log(...args),
// }
// Events in: core.focus(win|null, shellVersion), core.action('verb:arg'), core.clipboardChanged().
'use strict';

const { DEFAULT_RULES, normalizeRules, matchRule, isSelf, addNewDefaults } = require('../lib/rules');
const { describeSource, siteOf } = require('../lib/source');
const { extractLinks } = require('../lib/links');
const { SHORTCUTS, normalizeShortcuts, accelLabel } = require('../lib/keys');

const ALL_DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
const OPTION_LABEL = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Docs', markdown: 'Markdown', text: 'Text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
const DEST_COLOR = { slack: '#e01e5a', jira: '#2684ff', confluence: '#1d9bd1', email: '#ea4335', gdocs: '#4285f4', markdown: '#9aa3ad', text: '#3fb950', notion: '#e8e6e1', linear: '#7c85f0', teams: '#7b83eb' };
const DEST_NAME = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Google Docs', markdown: 'Markdown', text: 'Plain text', notion: 'Notion', linear: 'Linear', teams: 'Teams' };
const SIZE_NAMES = { s: 'Small', m: 'Medium', l: 'Large' };
// The shortcuts this version offers (the full view and "previous copy" went with the window).
const KEY_IDS = ['paste', 'plain', 'pill', 'auto', 'pdf'];
const APP_NAME = 'Morph';
const TICK_MS = 1500;
const PILL_PAGES = ['settings', 'size', 'keys', 'privacy', 'ocr', 'edit', 'updates', 'uninstall', 'about'];
const TERMINAL_RE = /terminal|konsole|kitty|alacritty|wezterm|tilix|xterm|ghostty/i;
// Apps that hold passwords: with "read from all apps", copies made in them are never read.
const PASSWORD_APPS = /1password|bitwarden|keepass|proton[ ._-]?pass|lastpass|dashlane|enpass|nordpass|keeper|roboform|authenticator|seahorse|gnome-keyring|passwords/i;
const SECRET_FORMATS = /x-kde-passwordmanagerhint|concealedtype|org\.nspasteboard\.(concealed|transient)|clipboard-history-exclude/i;

function cleanDests(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach((d) => { if (ALL_DESTS.includes(d) && !out.includes(d)) out.push(d); });
  return out.length ? out : null;
}
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
// Is version a newer than version b? "0.14.0" beats "0.14.0-rc.5" beats "0.14.0-rc.4".
function newer(a, b) {
  const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null; };
  const x = parse(a); const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const PDF_MAX_CHARS = 300000; // a PDF is made from what you copied; refuse absurdly large copies
const norm = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n').replace(/\s+$/g, '');

function createCore(io) {
  const FB = globalThis.FB;
  const log = io.log || (() => {});
  const SETTINGS_DEFAULT = { rules: DEFAULT_RULES, pillEnabled: true, pillMode: 'always', pillYFrac: 0.42, pillSide: 'r', pillMonitor: -1, autoFormat: false, linkBack: false, crossLinks: true, tabIcons: false, theme: 'sol-light', size: 'm', shortcuts: null, pillDests: null, atlassianSite: '', seenDefaults: null, people: {}, updateCheck: true, readFrom: 'any', setupDone: false, appOrder: null, lastCheck: 0, lastOk: 0, notifiedVersion: '' };
  let settings = Object.assign({}, SETTINGS_DEFAULT);

  let currentRule = null;
  let winNow = null;          // { app, title } of the window in front
  let shellVersion = 0;
  let loginHinted = false;
  let shellStatus = 'starting'; // 'starting' | 'ok' | 'unavailable'
  let pillView = 'main';
  let clipStatus = 'Nothing copied yet';
  let tick = null;            // { dest, until }: the ✓ on an app row or icon, for exactly TICK_MS
  let tickTimer = null;
  let flash = null;           // one-off message after a click: { sub, tone, collapse, open, done }
  let copySeq = 0;
  let copyWin = null;         // { text, win, rule } for the latest copy made elsewhere
  let copyFlashUntil = 0;
  let copyFlashTimer = null;
  let copyRuleId = null;
  let autoDoneDest = null;
  let crossLinks = [];        // detected URLs/tickets/emails from the last copy
  let original = null;        // what was copied, as it was: { html, text, context }
  let ownText = null;
  let ownHtml = null;
  let ownWriteUntil = 0;
  let pending = null;         // what to do when the next conversion finishes: 'pill' | 'paste' | 'auto' | null
  let pendingDest = null;
  let lastPdf = '';
  let keysFailed = [];
  let keysSent = '';
  let updateInfo = null;      // { version } when a newer one is out
  let updating = false;
  let confirmUninstall = false; // older helpers: the Uninstall row was clicked once
  let checking = false;
  let checkFailed = false;      // the last manual check could not reach the website
  // Everything Morph has to say is said in its own panel, never with a desktop notification.
  let updateFailed = false;     // the last "Update now" did not finish
  let uninstallFailed = false;  // the uninstall did not finish
  let helperHint = false;       // the GNOME helper is too old for the current Settings
  let checkNote = '';           // what the last manual check found
  let confirmTimer = null;
  let readLog = [];           // what Morph read or skipped: time, kind, app, size. Never titles or content. Memory only.
  let lastSkip = null;        // { app } of the latest copy Morph did not read

  // ---------------------------------------------------------------- settings
  function load() {
    let saved = null;
    try { const t = io.store.read(); saved = t ? JSON.parse(t) : null; } catch (e) { saved = null; }
    settings = Object.assign({}, SETTINGS_DEFAULT, saved && typeof saved === 'object' ? saved : {});
    settings.rules = normalizeRules(settings.rules);
    const merged = addNewDefaults(settings.rules, settings.seenDefaults);
    settings.rules = merged.rules;
    settings.seenDefaults = merged.seen;
    if (!['apps', 'always'].includes(settings.pillMode)) settings.pillMode = 'always';
    if (!['l', 'r'].includes(settings.pillSide)) settings.pillSide = 'r';
    if (!Number.isInteger(settings.pillMonitor) || settings.pillMonitor < -1 || settings.pillMonitor > 9) settings.pillMonitor = -1;
    settings.updateCheck = settings.updateCheck !== false;
    settings.lastCheck = Number.isFinite(settings.lastCheck) ? settings.lastCheck : 0;
    settings.lastOk = Number.isFinite(settings.lastOk) ? settings.lastOk : 0;
    settings.notifiedVersion = typeof settings.notifiedVersion === 'string' ? settings.notifiedVersion : '';
    settings.readFrom = settings.readFrom === 'listed' ? 'listed' : 'any';
    settings.setupDone = settings.setupDone === true;
    settings.autoFormat = settings.autoFormat === true;
    settings.linkBack = settings.linkBack === true;
    settings.crossLinks = settings.crossLinks !== false; // default on
    settings.tabIcons = settings.tabIcons === true;
    settings.people = cleanPeople(settings.people);
    settings.theme = 'sol-light';
    if (!['s', 'm', 'l'].includes(settings.size)) settings.size = 'm';
    settings.shortcuts = normalizeShortcuts(settings.shortcuts);
    settings.pillDests = cleanDests(settings.pillDests);
    if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(settings.atlassianSite || '')) settings.atlassianSite = '';
    if (typeof settings.pillYFrac !== 'number' || !(settings.pillYFrac >= 0.05 && settings.pillYFrac <= 0.95)) settings.pillYFrac = 0.42;
    // The ✕ on the pill lasts until the next start, so it can never be lost for good.
    settings.pillEnabled = true;
  }
  function save() { try { io.store.write(JSON.stringify(settings, null, 2)); } catch (e) { /* read-only disk: keep in memory */ } }


  // ---------------------------------------------------------------- privacy
  // One list, two ways (Settings → Apps): "All apps" reads copies from any app except password managers and converts
  // for every supported tool; "Only these apps" reads and converts only in the apps switched on. Reads you ask for
  // with a click are always fine.
  const SETUP_APP_IDS = ['slack', 'jira', 'confluence', 'outlook', 'gdocs', 'notion', 'linear', 'teams', 'github', 'terminal'];
  const appOrder = () => {
    const o = (Array.isArray(settings.appOrder) ? settings.appOrder : []).filter((id, i, a) => SETUP_APP_IDS.includes(id) && a.indexOf(id) === i);
    SETUP_APP_IDS.forEach((id) => { if (!o.includes(id)) o.push(id); });
    return o;
  };
  const setupApps = () => appOrder().map((id) => settings.rules.find((r) => r.id === id)).filter(Boolean);
  const shownApps = () => setupApps().filter((r) => allApps() || r.enabled);
  const allApps = () => settings.readFrom !== 'listed';
  const readsEverything = () => allApps();
  // In "All apps", every supported tool counts as one of your apps, whatever its switch says.
  const activeRules = () => (allApps() ? settings.rules.map((r) => (SETUP_APP_IDS.includes(r.id) ? Object.assign({}, r, { enabled: true }) : r)) : settings.rules);
  // The formats the pill offers: all of them, or only those of the apps switched on.
  const offeredDests = () => {
    const out = [];
    shownApps().forEach((r) => { if (ALL_DESTS.includes(r.dest) && !out.includes(r.dest)) out.push(r.dest); });
    return out.length ? out : ALL_DESTS.slice();
  };
  const logoOf = (r) => (r.id === 'github' || r.id === 'terminal' ? r.id : r.dest);
  // A name people recognise: the supported app it is (even when switched off), else a tidied app id.
  const appLabel = (w) => {
    if (!w) return 'another app';
    const r = matchRule(settings.rules.map((x) => Object.assign({}, x, { enabled: true })), w);
    if (r) return r.name;
    const id = String(w.app || '').replace(/\.desktop$/, '').replace(/^(org|com|io|net)\.[^.]+\./, '').replace(/[-_](server|bin|app)$/i, '').replace(/[-_.]+/g, ' ').trim();
    return id ? (id.charAt(0).toUpperCase() + id.slice(1)).slice(0, 30) : 'another app';
  };
  function note(kind, app, chars) {
    if (winNow && (isSelf(winNow) || /^gjs$/i.test(String(winNow.app || '')))) return; // Morph's own windows
    readLog.push({ at: io.now(), kind, app: String(app || '').slice(0, 30), chars: chars || 0 });
    if (readLog.length > 30) readLog.shift();
  }
  // Called for every "something was copied" signal, before anything is read. true: go ahead and read.
  function mayRead() {
    const pm = !!winNow && PASSWORD_APPS.test(String(winNow.app || '') + ' ' + String(winNow.title || ''));
    if (!pm && (settings.readFrom === 'any' || currentRule)) return true;
    lastSkip = { app: appLabel(winNow), pm };
    note('skipped', lastSkip.app, 0);
    clipStatus = 'Not read: copied from ' + lastSkip.app;
    original = null;
    crossLinks = [];
    sendPill();
    return false;
  }
  // Optional table OCR in Settings → Privacy: install and remove with a button, progress shown while it works.
  let ocrJob = null;     // { line } while the install runs
  let ocrFail = '';      // why the last install did not finish
  const ocrCanManage = () => !!(io.ocr && io.ocr.install && io.ocr.remove);
  // Confirmations happen inside the pill (a system dialog would cover it and close it): one button asks, the
  // next shows the question with the two answers right there.
  let ocrAsk = '';       // 'on' | 'stop' | 'off' while a question is showing
  function ocrBlocks() {
    if (shellVersion < 15) return [];
    const ask = (title, text, yes, yesAction, no) => [
      { kind: 'panel', tone: 'warn', icon: 'warning', title, text },
      { kind: 'buttons', buttons: [{ label: yes, action: yesAction, kind: 'primary' }, { label: no, action: 'ocr:no', kind: 'secondary' }] }];
    if (ocrJob) {
      if (ocrAsk === 'stop') return ask('Stop installing?', 'What was downloaded so far is removed. You can start again later.', 'Stop', 'ocr:cancel', 'Keep installing');
      return [{ kind: 'status', tone: 'plain', icon: 'download', title: 'Installing table OCR' + (ocrJob.step ? ' · step ' + ocrJob.step : '…'), progress: ocrJob.progress || 0.02, items: [ocrJob.line || 'Starting…', 'About 1 GB, a few minutes. You can keep using your computer.'] },
        { kind: 'buttons', buttons: [{ label: 'Stop installing', action: 'ocr:askstop', kind: 'secondary' }] }];
    }
    if (ocrReady()) {
      if (ocrAsk === 'off' && ocrCanManage()) return ask('Remove table OCR?', 'This deletes the OCR files (about 200 MB). Morph keeps working without it.', 'Remove', 'ocr:off', 'Keep it');
      return [{ kind: 'panel', tone: 'ok', icon: 'check_circle', title: 'Table OCR is on', text: 'A copied image is read only when you pick an app, on this device. Nothing is uploaded.' },
        ...(ocrCanManage() ? [{ kind: 'buttons', buttons: [{ label: 'Remove table OCR', action: 'ocr:askoff', kind: 'secondary' }] }] : [])];
    }
    if (ocrAsk === 'on' && ocrCanManage()) return ask('Download about 200 MB?', 'This installs RapidOCR once and needs internet. Images are read only on this computer, and only when you pick an app.' + (ocrLegacy() ? ' The older, larger table OCR (about 3 GB) is removed first.' : ''), 'Install', 'ocr:on', 'Not now');
    if (ocrLegacy()) {
      return [{ kind: 'panel', tone: 'warn', icon: 'download', title: 'Table OCR got much smaller', text: 'The new version is about 200 MB instead of 3 GB, and reads a screenshot in about a second. Update to keep reading tables from images.' },
        ...(ocrCanManage() ? [{ kind: 'buttons', buttons: [{ label: 'Update table OCR', action: 'ocr:ask', kind: 'primary' }] }] : [])];
    }
    return [{ kind: 'panel', tone: ocrFail ? 'warn' : 'plain', icon: ocrFail ? 'warning' : 'table', title: 'Table OCR (optional)',
        text: ocrFail ? ocrFail : 'Reads tables from copied screenshots, on this device. Off until you turn it on.' },
      ...(ocrCanManage() ? [{ kind: 'buttons', buttons: [{ label: ocrFail ? 'Try again' : 'Enable table OCR', action: 'ocr:ask', kind: 'primary' }] }] : [])];
  }
  function ocrAction(arg) {
    if (arg === 'ask' || arg === 'askstop' || arg === 'askoff') { ocrAsk = arg === 'ask' ? 'on' : arg.slice(3); sendPill(); return; }
    if (arg === 'no') { ocrAsk = ''; sendPill(); return; }
    ocrAsk = '';
    if (arg === 'on' && ocrCanManage() && !ocrJob && !ocrReady()) { // also replaces an older (PaddleOCR) install
      ocrFail = '';
      ocrJob = { line: 'Starting…', cancelled: false };
      const job = ocrJob;
      sendPill();
      io.ocr.install((line) => {
        if (ocrJob !== job || !line) return;
        const m = /Step (\d) of (\d)/.exec(line);
        if (m) { const at = [0, 0.05, 0.15, 0.8][Number(m[1]) - 1]; job.progress = typeof at === 'number' ? at : job.progress; job.step = m[1] + ' of ' + m[2]; }
        job.line = String(line).replace(/^Step \d of \d:\s*/, '').slice(0, 110);
        sendPill();
      },
        (ok) => {
          if (ocrJob === job) ocrJob = null;
          if (!ok) ocrFail = job.cancelled ? 'Cancelled. Nothing was kept.' : (job.line && job.line !== 'Starting…' ? job.line : 'The install did not finish.');
          sendPill();
        });
    } else if (arg === 'cancel' && ocrJob) {
      ocrJob.cancelled = true;
      io.ocr.cancel && io.ocr.cancel();
    } else if (arg === 'off' && ocrCanManage() && !ocrJob) {
      Promise.resolve(io.ocr.remove()).then(() => { ocrFail = ''; sendPill(); });
    }
  }
  function readLine(e) {
    const d = new Date(e.at);
    const t = (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? ' AM' : ' PM');
    const n = e.n || 1, many = n > 1 ? n + ' copies' : 'a copy';
    const from = e.app || 'an app';
    if (e.kind === 'ocr') return t + ' · Read ' + (n > 1 ? n + ' tables from images' : 'a table from an image') + ', on this device';
    if (e.kind === 'skipped') return t + ' · Skipped ' + many + ' from ' + from;
    return t + ' · Read ' + (n > 1 ? many : e.chars + ' characters') + ' from ' + from;
  }

  // ---------------------------------------------------------------- pill spec
  const pillShouldShow = () => {
    if (!settings.pillEnabled) return false;
    return true; // always there: a pill that comes and goes looks broken
    if (shellStatus === 'unavailable') return true;
    return !!currentRule;
  };
  function copySummary() {
    if (clipStatus === 'Nothing copied yet' || /^Nothing to convert/.test(clipStatus) || /^Not read/.test(clipStatus) || /^(Image copied|Reading the table)/.test(clipStatus)) return null;
    const t = clipStatus.replace(/^Last copy: /, '');
    const i = t.indexOf(', ');
    return i < 0 ? { from: t, what: '' } : { from: t.slice(0, i), what: t.slice(i + 2) };
  }
  function copyPlace() {
    if (!copyWin || !copyWin.win) return null;
    const ctx = describeSource(copyWin.win, copyWin.rule, '', { atlassian: settings.atlassianSite });
    if (!ctx || !ctx.tool || !ctx.label) return null;
    return { tool: ctx.tool, where: ctx.label.replace(/\s+\([^)]*\)$/, ''), dest: copyWin.rule && ALL_DESTS.includes(copyWin.rule.dest) ? copyWin.rule.dest : '' };
  }
  const visibleKeys = () => settings.shortcuts.filter((k) => KEY_IDS.includes(k.id));
  function shortcutsForSettings() {
    return visibleKeys().map((k) => ({ id: k.id, name: (SHORTCUTS.find((x) => x.id === k.id) || {}).name || k.id, accel: k.accel, label: accelLabel(k.accel, false), on: k.on, taken: keysFailed.includes(k.id) }));
  }

  function settingsSpec(base, page) {
    const offered = offeredDests();
    const nav = [
      { id: 'settings', label: 'General', icon: 'tune' },
      { id: 'edit', label: 'Apps', icon: 'grid_view' },
      { id: 'keys', label: 'Shortcuts', icon: 'keyboard' },
      { id: 'privacy', label: 'Privacy', icon: 'lock' },
      ...(shellVersion >= 15 ? [{ id: 'ocr', label: 'Images', icon: 'image' }] : []),
      { id: 'size', label: 'Size', icon: 'aspect_ratio' },
      ...(shellVersion >= 12 ? [{ id: 'updates', label: 'Updates', icon: 'refresh' }, { id: 'uninstall', label: 'Uninstall', icon: 'delete' }] : []),
      { id: 'about', label: 'About', icon: 'info' },
    ];
    const cur = nav.some((n) => n.id === page) ? page : 'settings';
    const spec = Object.assign(base, {
      view: 'settings', title: 'Settings', sub: '', subTone: '', back: 'view:main',
      primary: null, secondary: null, options: [], section: '', groups: [], recentTitle: '', recent: [], links: [], collapseAfterMs: 0, home: false, edit: null, note: '',
      nav: nav.map((n) => ({ label: n.label, icon: n.icon, action: 'view:' + n.id, on: n.id === cur })),
    });
    const sw = (on) => (on ? 'on' : 'off');
    if (cur === 'edit') {
      const on = allApps();
      spec.pane = { title: 'Apps', lede: 'Where ' + APP_NAME + ' works. Drag to reorder.',
        opts: [{ icon: 'grid_view', label: 'All apps', sub: 'Every app, except password managers', sw: sw(on), action: 'toggle:readfrom' }],
        apps: setupApps().map((r) => ({ label: r.name, dest: logoOf(r), sw: on ? 'none' : (r.enabled ? 'on' : 'off'), action: on ? '' : 'rule:' + r.id })),
        keepOrder: true };
    } else if (cur === 'keys') {
      const KEY_SHORT = { paste: 'Paste, fixed', plain: 'Paste as plain text', pill: 'Show or hide Morph', auto: 'Auto-format on/off', pdf: 'Save as PDF' };
      const KEY_ICON = { paste: 'content_paste', plain: 'notes', pill: 'grid_view', auto: 'bolt', pdf: 'description' };
      spec.pane = { title: 'Shortcuts', lede: 'Click a shortcut to turn it on or off.',
        keys: shortcutsForSettings().map((k, i) => ({ label: KEY_SHORT[k.id] || k.name, icon: KEY_ICON[k.id] || 'keyboard', keys: k.label.split(' ').filter(Boolean).slice(0, 5), sw: sw(k.on && !k.taken), note: k.taken ? 'Taken by another app' : '', action: 'key:' + i })) };
    } else if (cur === 'privacy') {
      // Repeats fold into one line ("Skipped 5 copies from Terminal"); only the last few show.
      const groups = [];
      readLog.slice().reverse().forEach((e) => {
        const g = groups[groups.length - 1];
        if (g && g.kind === e.kind && g.app === e.app) { g.n++; g.chars += e.chars || 0; } else groups.push({ at: e.at, kind: e.kind, app: e.app, chars: e.chars || 0, n: 1 });
      });
      const recent = groups.slice(0, 4).map(readLine);
      spec.pane = { title: 'Privacy', lede: APP_NAME + ' never stores or sends what you copy.',
        actions: [{ icon: 'grid_view', label: 'Which apps ' + APP_NAME + ' reads from', sub: allApps() ? 'All apps, except password managers. Change it in Apps' : setupApps().filter((r) => r.enabled).length + ' apps. Change them in Apps', action: 'view:edit' }] };
      if (shellVersion >= 13) spec.pane.blocks = [
        { kind: 'panel', tone: 'plain', title: 'What ' + APP_NAME + ' read', items: recent.length ? recent : ['Nothing yet. Copies show up here, without their content.'] },
        { kind: 'panel', tone: 'plain', title: 'Never read', items: ['Password managers', 'Copies an app marks as secret'] }];
    } else if (cur === 'ocr') {
      spec.pane = { title: 'Image tables', lede: 'Read a table from a copied screenshot, on this computer.', blocks: ocrBlocks() };
    } else if (cur === 'size') {
      const SUB = { s: 'Compact', m: 'Default', l: 'Roomy' };
      spec.pane = { title: 'Size', lede: 'Pick the size that fits how you work.',
        cards: ['s', 'm', 'l'].map((z) => ({ label: SIZE_NAMES[z], sub: SUB[z], size: z, on: settings.size === z, action: 'size:' + z })) };
    } else if (cur === 'updates' && shellVersion >= 13) {
      const when = (ms) => {
        if (!ms) return 'Not yet';
        const d = new Date(ms), n = new Date(io.now());
        const hh = d.getHours() % 12 || 12, mm = String(d.getMinutes()).padStart(2, '0'), ap = d.getHours() < 12 ? 'AM' : 'PM';
        const day = d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === new Date(n.getTime() - DAY_MS).toDateString() ? 'Yesterday' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return day + ' at ' + hh + ':' + mm + ' ' + ap;
      };
      const meta = ['Installed version: ' + io.version, 'Last checked: ' + when(settings.lastOk)];
      let st;
      if (checking) st = { tone: 'plain', icon: 'refresh', title: 'Checking for updates…', text: 'Looking at the Morph website.', button: { label: 'Checking…', action: 'checkupdate:', disabled: true, kind: 'secondary' } };
      else if (updating) st = { tone: 'warn', icon: 'download', title: 'Updating…', text: 'Morph restarts when it is done.', button: { label: 'Updating…', action: 'update:', disabled: true, kind: 'primary' } };
      else if (updateFailed) st = { tone: 'warn', icon: 'error', title: 'The update did not finish', text: 'Try again, or run morph --update in a terminal.', button: { label: 'Try again', action: 'update:', kind: 'primary' } };
      else if (checkFailed) st = { tone: 'warn', icon: 'error', title: 'Could not check for updates', text: 'Morph could not reach its website. Check your connection and try again.', button: { label: 'Retry', action: 'checkupdate:', kind: 'primary' } };
      else if (updateInfo) st = { tone: 'warn', icon: 'download', title: 'Version ' + updateInfo.version + ' is available', text: 'Updating installs it and restarts Morph.', button: { label: 'Update now', action: 'update:', kind: 'primary' } };
      else st = { tone: 'ok', icon: 'check_circle', title: 'You are up to date', text: 'This is the latest version of Morph.', button: { label: 'Check for updates', action: 'checkupdate:', kind: 'secondary' } };
      spec.pane = { title: 'Updates', lede: 'Morph keeps itself current.',
        blocks: [Object.assign({ kind: 'status', items: meta }, st)],
        opts: [{ icon: 'schedule', label: 'Check automatically', sub: 'Looks at the Morph website once a day', sw: sw(settings.updateCheck), action: 'toggle:updates' }] };
      if (updateInfo && !checking && !updating && !checkFailed) spec.pane.blocks[0].button.label = 'Update now';
    } else if (cur === 'uninstall' && shellVersion >= 13) {
      spec.pane = { title: 'Uninstall Morph', lede: 'Remove Morph from this account.',
        blocks: [
          ...(uninstallFailed ? [{ kind: 'panel', tone: 'warn', icon: 'error', title: 'Uninstall did not finish', text: 'Run morph --uninstall in a terminal instead.' }] : []),
          { kind: 'text', text: 'Uninstalling stops Morph and removes it from this computer. You can install it again at any time.' },
          { kind: 'panel', tone: 'plain', title: 'What will be removed', items: [
            'The Morph program and its folder',
            'Your Morph settings: chosen apps, order, size and shortcuts',
            'Morph log files',
            'Start at login',
            'The tab on the screen edge (its GNOME helper)',
            'The morph command',
            ...(ocrReady() || ocrLegacy() || ocrJob ? ['Table OCR: RapidOCR and its models in Morph\'s own folder'] : []) ] },
          { kind: 'panel', tone: 'warn', icon: 'warning', title: 'This deletes your Morph settings', text: 'Nothing you copy is ever stored by Morph, so there is no clipboard data to lose. Your documents and other files are not touched.' + (ocrReady() || ocrLegacy() || ocrJob ? ' An OCR package you installed yourself, outside Morph, is not touched either.' : '') },
          { kind: 'buttons', buttons: io.uninstall ? [
            { label: 'Keep Morph', action: 'view:settings', kind: 'secondary' },
            { label: 'Uninstall Morph', action: 'uninstall:', kind: 'danger', confirm: { title: 'Uninstall Morph?', body: 'This removes Morph and its settings from this account. You can install it again later.', ok: 'Uninstall' } } ] : [{ label: 'Keep Morph', action: 'view:settings', kind: 'secondary' }] },
        ] };
    } else if (cur === 'updates') {
      const status = checking ? 'Checking…' : updating ? 'Updating…' : updateInfo ? 'Version ' + updateInfo.version + ' is available' : checkNote === 'Could not reach the Morph website' ? 'Could not reach the website' : 'You are on the latest version';
      const actions = [{ icon: updateInfo ? 'download' : 'check_circle', label: status, sub: 'Version ' + io.version + ' · press refresh to check again', trail: 'refresh', action: 'checkupdate:' }];
      if (updateInfo) actions.push({ icon: 'download', label: updating ? 'Updating…' : 'Update to ' + updateInfo.version, sub: updating ? 'Morph restarts when it is done' : 'Installs it and restarts Morph', action: 'update:' });
      spec.pane = { title: 'Updates', lede: 'Morph keeps itself current.', actions,
        opts: [{ icon: 'schedule', label: 'Check every day', sub: 'Looks at the Morph website once a day', sw: sw(settings.updateCheck), action: 'toggle:updates' }] };
    } else if (cur === 'uninstall') {
      spec.pane = { title: 'Uninstall', lede: 'Remove Morph from this account.',
        actions: io.uninstall ? [{ icon: 'delete', label: 'Uninstall Morph', sub: 'Removes it, its settings and its files', action: 'uninstall:', confirm: { title: 'Uninstall Morph?', body: 'This removes Morph, its settings and its files from this account. You can install it again later.', ok: 'Uninstall' } }] : [] };
    } else if (cur === 'about') {
      spec.pane = { title: 'About', lede: APP_NAME + ' for Linux.',
        about: { name: APP_NAME, version: 'Version ' + io.version + ' · GNOME',
          text: 'Copy something formatted in one app, and ' + APP_NAME + ' re-shapes it for wherever you paste next. Nothing you copy leaves your computer.',
          legal: 'Slack, Jira, Confluence, Google Docs, Notion, Linear and other names and logos belong to their owners and only show which app a format is for. ' + APP_NAME + ' is not affiliated with or endorsed by them.' } };
    } else {
      spec.pane = { title: 'General', lede: 'How ' + APP_NAME + ' behaves when you copy.',
        opts: [
          { icon: 'bolt', label: 'Convert automatically', sub: 'Converts a copy when you switch apps', sw: sw(settings.autoFormat), action: 'toggle:auto' },
          { icon: 'grid_view', label: 'Quick buttons on the tab', sub: 'One-click app buttons on the closed tab', sw: sw(settings.tabIcons), action: 'toggle:tabicons' },
        ] };
      if (shellVersion < 12) {
        // An older helper only draws switches: keep the old two-click rows until it is updated.
        spec.pane.opts.push({ icon: 'download', label: 'Check for updates daily', sub: 'Looks at the Morph website once a day', sw: sw(settings.updateCheck), action: 'toggle:updates' });
        if (io.uninstall) spec.pane.opts.push(confirmUninstall
          ? { icon: 'delete', label: 'Click again to uninstall', sub: 'Removes Morph and its settings from this account', sw: 'on', action: 'uninstall:' }
          : { icon: 'delete', label: 'Uninstall Morph', sub: 'Removes it from this account. Asks again first', sw: 'off', action: 'uninstall:' });
        if (updateInfo) spec.pane.opts.push({ icon: 'download', label: updating ? 'Updating…' : 'Update to ' + updateInfo.version, sub: updating ? 'Morph restarts when it is done' : 'Click to install it and restart', sw: sw(updating), action: 'update:' });
      }
    }
    return spec;
  }

  function shellSpec() {
    const rule = currentRule;
    const place = copyPlace();
    const copy = copySummary();
    const now = io.now();
    const tickDest = tick && now < tick.until ? tick.dest : null;
    const offered = offeredDests();
    const others = offered.filter((d) => !rule || d !== rule.dest);
    const rows = [];
    const skipped = !copy && /^Not read/.test(clipStatus) && !!lastSkip;
    // A copied image with table OCR on: picking an app reads its table, so the apps stay available.
    const ocrBusy = /^Reading the table/.test(clipStatus);
    const ocrImage = !copy && (ocrBusy || /^Image copied/.test(clipStatus) || /holds an image$/.test(clipStatus)) && ocrReady(); // decided now, not when it was copied
    const idle = !copy && !skipped && !ocrImage; // a skipped copy still lets you pick an app: that click is you asking Morph to read it
    const imageOnly = idle && (/image$/.test(clipStatus) || /^Image copied/.test(clipStatus));
    for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2).map((d) => (tickDest === d
      ? { label: OPTION_LABEL[d], done: true }
      : idle ? { label: OPTION_LABEL[d], dest: d, off: true }
      : { label: OPTION_LABEL[d], dest: d, action: 'fix:' + d, color: DEST_COLOR[d], busy: OPTION_LABEL[d] + '…' })));
    const spec = {
      visible: pillShouldShow(),
      theme: settings.theme,
      size: settings.size,
      openNow: !!(flash && flash.open),
      chips: 'chips',
      settled: !!flash,
      dot: flash && flash.tone === 'ok' ? 'ok' : now < copyFlashUntil ? 'ok' : copy ? 'has' : 'none',
      handleColor: rule ? DEST_COLOR[rule.dest] : '',
      copyId: copy ? copySeq : 0,
      yFrac: settings.pillYFrac,
      side: settings.pillSide,
      monitor: settings.pillMonitor,
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
      source: copy ? { icon: /table/i.test(copy.what || '') ? 'table' : 'content_paste', dest: place ? place.dest : '', title: 'Copied from ' + (place ? place.tool : copy.from), sub: [place ? place.where : '', copy.what].filter(Boolean).join(' · ') }
        : skipped ? { icon: 'lock', title: 'Copied from ' + lastSkip.app, sub: lastSkip.pm ? 'Never read: a password manager' : 'Not read: ' + lastSkip.app + ' is off in Settings → Apps' }
        : ocrBusy ? { icon: 'image', title: 'Reading the table…', sub: 'A few seconds' }
        : ocrImage ? { icon: 'image', title: 'Image copied', sub: ocrNote || 'Pick an app to read its table' }
        : imageOnly ? { icon: 'image', title: 'Image copied', sub: 'Nothing to convert. Paste it as it is.' }
        : { icon: 'content_paste', title: 'Nothing copied yet', sub: 'Copy something to start' },
      links: [],
      tab: settings.tabIcons ? others.slice(0, 4).map((d) => (tickDest === d
        ? { label: OPTION_LABEL[d], dest: d, done: true }
        : idle ? { label: OPTION_LABEL[d], dest: d, off: true }
        : { label: OPTION_LABEL[d], dest: d, action: 'fix:' + d, color: DEST_COLOR[d] })) : [],
      original: null,
      collapseAfterMs: 0,
      // A standing note under the card: an update to install, or a helper to refresh.
      note: helperHint ? 'Run morph --install to update the GNOME helper' : updateInfo && !updating ? 'Version ' + updateInfo.version + ' is available · Settings → Updates' : '',
      edit: null,
    };
    if (pillView !== 'main') return settingsSpec(spec, pillView);
    if (copy && rule && settings.autoFormat && autoDoneDest === rule.dest) spec.sub = (copy.what ? copy.what + ' · ' : '') + 'already fixed, just press Ctrl V';
    spec.section = rule ? 'Copy for another app' : 'Copy it for';
    spec.options = rows;
    if (copy) {
      if (rule && settings.linkBack && place && copyWin && copyWin.rule && copyWin.rule.id !== rule.id && rule.dest !== 'text') {
        spec.note = 'Adds “Source: ' + place.tool + ' · ' + place.where + '”';
      }
      // Converted, and it did not come out right? One button on the card puts your original copy back.
      if (autoDoneDest && original && tickDest !== 'original') spec.secondary = { label: 'Undo', action: 'orig:', busy: 'Restoring…' };
    } else {
      spec.secondary = { label: 'Check again', action: 'refresh:', busy: 'Checking…' };
    }
    if (spec.options.length) {
      const pdfChip = tickDest === 'pdf' ? { label: 'PDF ↓', done: true } : idle ? { label: 'PDF ↓', action: 'pdf:', off: true } : { label: 'PDF ↓', action: 'pdf:', color: '#d93025', busy: 'Saving…' };
      const last = spec.options[spec.options.length - 1];
      if (last.length < 2) last.push(pdfChip); else spec.options.push([pdfChip]);
    }
    if (flash && flash.pdf && lastPdf) spec.links = [{ label: 'Open the PDF', action: 'openpdf:' }, { label: 'Show in folder', action: 'showpdf:' }];
    else if (copy && crossLinks.length) spec.links = crossLinks.map((l, i) => ({ label: (l.kind === 'jira' ? '🎫 ' : l.kind === 'email' ? '✉ ' : '🔗 ') + l.label, action: 'openlink:' + i }));
    if (flash) {
      if (flash.done && spec.primary) spec.primary = { label: flash.done, done: true };
      else { spec.sub = flash.sub; spec.subTone = flash.tone; }
      if (flash.collapse) spec.collapseAfterMs = flash.done ? 1200 : 1800;
    }
    return spec;
  }
  function sendPill() {
    const spec = shellSpec();
    if (!settings.setupDone && shellVersion >= 23) {
      // Once, after install: a short welcome card says what Morph does and where to change it. No questions.
      spec.visible = false;
      spec.setup = { welcome: true, title: APP_NAME + ' is ready',
        body: [allApps() ? APP_NAME + ' reads what you copy in any app, except password managers, and converts it for these tools:' : APP_NAME + ' reads what you copy in these apps and converts it for them:'],
        apps: (allApps() ? setupApps() : setupApps().filter((r) => r.enabled)).map((r) => ({ name: r.name, logo: logoOf(r) })),
        foot: 'What you copy never leaves this computer. To choose which apps ' + APP_NAME + ' reads from, open Settings → Apps. ' + APP_NAME + ' checks for updates once a day; you can turn that off in Settings → Updates.',
        ok: 'Got it', settings: 'Open Settings' };
    }
    flash = null;
    try { io.shell.setPill(spec); } catch (e) { log('setPill failed:', e && e.message); }
    return spec;
  }
  // The ✓ shows for exactly TICK_MS whatever else redraws, then goes.
  function startTick(dest) {
    tick = { dest, until: io.now() + TICK_MS };
    sendPill();
    io.clearTimeout(tickTimer);
    tickTimer = io.setTimeout(() => { tickTimer = null; tick = null; sendPill(); }, TICK_MS);
  }

  // ---------------------------------------------------------------- clipboard
  const imageIn = (formats) => (formats || []).some((f) => /^image\//.test(f));
  async function readNow() {
    let sh = null;
    try { sh = await io.shell.readClip(); } catch (e) { sh = null; }
    if (!sh) return null;
    if (sh.secret || (sh.formats || []).some((f) => SECRET_FORMATS.test(f))) return { secret: true };
    return sh;
  }
  // Learn what's on the clipboard now (a new copy): its summary for the pill, and the original to convert from.
  async function refreshClip() {
    const sh = await readNow();
    if (!sh || sh.secret) return null;
    if (!sh.text && !sh.html) {
      original = null;
      crossLinks = [];
      clipStatus = imageIn(sh.formats) ? (ocrReady() ? 'Image copied: pick an app to read its table' : 'Nothing to convert: the clipboard holds an image') : 'Nothing to convert';
      sendPill();
      return null;
    }
    note('read', currentRule ? currentRule.name : (winNow && winNow.app ? String(winNow.app).replace(/\.desktop$/, '') : ''), (sh.text || '').length || (sh.html || '').length);
    const site = siteOf(sh.html);
    if (site && site !== settings.atlassianSite) { settings.atlassianSite = site; save(); }
    const context = copyWin && (copyWin.text === null || copyWin.text === sh.text) ? describeSource(copyWin.win, copyWin.rule, sh.html, { atlassian: settings.atlassianSite }) : null;
    const clip = { html: sh.html || '', text: sh.text || '', context: context && context.label ? context : null };
    const r = FB.engine.run(clip, null);
    original = clip;
    crossLinks = settings.crossLinks ? extractLinks(sh.text, sh.html, settings.atlassianSite) : [];
    clipStatus = r.has ? 'Last copy: ' + (FB.SOURCES[r.source] || 'text') + ', ' + (FB.astStats(r.ast).summary || 'text') : 'Nothing to convert';
    sendPill();
    return clip;
  }
  // Optional table OCR: an image on the clipboard is read only when you pick an app, never in the background.
  const ocrReady = () => !!(io.ocr && io.ocr.ready() && shellVersion >= 15);
  const ocrLegacy = () => !!(io.ocr && io.ocr.legacy && io.ocr.legacy() && shellVersion >= 15); // the old PaddleOCR install
  let ocrNote = '';      // why the last image read gave nothing
  let ocrFromImage = false; // the clip being converted was read from an image
  let ocrSeq = -1, ocrSeqClip = null;   // the copy an image was last read for, and its table (null: it failed)
  let ocrRunning = null;                 // { seq, promise } while a read is in progress
  function readImageTable() {
    if (ocrSeq === copySeq) return Promise.resolve(ocrSeqClip);
    if (ocrRunning && ocrRunning.seq === copySeq) return ocrRunning.promise; // a second click joins the read in progress
    const seq = copySeq;
    const promise = readImageTableNow().finally(() => { if (ocrRunning && ocrRunning.promise === promise) ocrRunning = null; });
    ocrRunning = { seq, promise };
    return promise;
  }
  async function readImageTableNow() {
    ocrNote = '';
    if (!ocrReady()) return null;
    clipStatus = 'Reading the table…';
    sendPill();
    const r = await io.ocr.run();
    note('ocr', 'an image', 0);
    if (!r.ok || !/<table/i.test(r.html || '')) {
      ocrNote = r.error === 'no_table' ? 'No table found in that image.' : 'Couldn’t read that image.';
      clipStatus = 'Image copied: ' + ocrNote.toLowerCase();
      ocrSeq = copySeq; ocrSeqClip = null;
      sendPill();
      return null;
    }
    const clip = { html: r.html, text: '', context: null };
    const run = FB.engine.run(clip, null);
    if (!run.has) { ocrNote = 'No table found in that image.'; ocrSeq = copySeq; ocrSeqClip = null; sendPill(); return null; }
    original = clip;
    ocrFromImage = true;
    crossLinks = [];
    clipStatus = 'Table read from an image, ' + (FB.astStats(run.ast).summary || 'table');
    ocrSeq = copySeq; ocrSeqClip = clip;
    sendPill();
    return clip;
  }
  // What to convert from: the original, even when the clipboard already holds our own output.
  async function acquire() {
    const sh = await readNow();
    if (!sh || sh.secret) return null;
    if (!sh.text && !sh.html) return imageIn(sh.formats) ? readImageTable() : null;
    if (original && isOurs(sh)) return original;
    if (original && original.text === sh.text && original.html === (sh.html || '')) return original;
    return refreshClip();
  }
  // Is this what we last put there? Rich writes read back with no plain text, so the HTML counts too.
  function isOurs(sh) {
    if (!sh) return false;
    if (ownHtml && sh.html && sh.html === ownHtml) return true;
    return ownText !== null && !ownHtml && norm(sh.text) === norm(ownText);
  }
  async function writeClip(html, text) {
    ownText = text;
    ownHtml = html || null;
    ownWriteUntil = io.now() + 1500; // our own write is not "a new copy"
    // GNOME's clipboard takes one format at a time: the rich one when there is one.
    const ok = html ? await io.shell.writeClip('text/html', html) : await io.shell.writeClip('text/plain', text);
    if (!ok && html) return io.shell.writeClip('text/plain', text);
    return ok;
  }
  function finish(r) {
    const from = pending;
    pending = null;
    if (from === 'auto') {
      if (r.ok) autoDoneDest = pendingDest;
      log('auto-format', r.ok ? 'done for ' + r.name : 'skipped (nothing to convert)');
      sendPill();
      return;
    }
    if (from === 'paste') {
      if (r.ok) {
        const shift = !!(winNow && TERMINAL_RE.test(winNow.app || ''));
        log('pasting into', r.name, shift ? '(Ctrl Shift V)' : '(Ctrl V)');
        if (shellVersion >= 6) io.shell.paste(shift);
        autoDoneDest = pendingDest;
        flash = { done: '✓ Pasted into ' + r.name, sub: r.fromImage ? 'Read from an image: check the numbers.' : '', tone: 'ok', collapse: !r.fromImage };
      } else flash = { sub: r.note || (copySummary() ? 'Nothing to paste yet.' : ''), tone: 'warn', collapse: false };
      sendPill();
      return;
    }
    if (from === 'pill') {
      if (r.ok) autoDoneDest = r.restored ? null : pendingDest;
      flash = r.ok ? { sub: r.restored ? 'Original is back on the clipboard.' : r.fromImage ? 'Read from an image: check the numbers.' : '', tone: 'ok', collapse: false } : { sub: r.note || (copySummary() ? 'Couldn’t convert that.' : ''), tone: 'warn', collapse: false };
      if (r.ok) startTick(r.restored ? 'original' : pendingDest); else sendPill();
      return;
    }
    flash = r.ok ? { done: '✓ Ready to paste into ' + r.name, sub: r.summary || '', tone: 'ok', open: true, collapse: true } : { sub: 'Nothing to convert yet. Copy something first.', tone: 'warn', open: true, collapse: true };
    sendPill();
  }
  async function convertTo(dest) {
    try {
      ocrFromImage = false;
      const clip = await acquire();
      if (!clip) return { ok: false, note: ocrNote };
      const r = FB.engine.run(Object.assign({}, clip, { linkBack: settings.linkBack, people: settings.people }), dest);
      if (!r.has || !r.out) return { ok: false };
      const wrote = await writeClip(r.out.html || '', r.out.text || '');
      if (!wrote) return { ok: false };
      return { ok: true, name: DEST_NAME[dest], summary: r.summary, fromImage: ocrFromImage };
    } catch (e) { log('convert failed:', e && e.message); return { ok: false }; }
  }
  async function quick(dest, mode) {
    if (!ALL_DESTS.includes(dest)) return;
    pending = mode;
    pendingDest = dest;
    finish(await convertTo(dest));
  }
  async function restoreOriginal() {
    pending = 'pill';
    pendingDest = null;
    if (!original) { finish({ ok: false }); return; }
    const ok = await writeClip(original.html, original.text);
    finish(ok ? { ok: true, name: 'your clipboard', restored: true } : { ok: false });
  }

  // ---------------------------------------------------------------- copies and focus
  function onExternalCopy(text) {
    copySeq++;
    tick = null;
    autoDoneDest = null;
    copyRuleId = currentRule ? currentRule.id : '';
    copyWin = { text: typeof text === 'string' ? text : null, win: winNow ? { app: winNow.app, title: winNow.title } : null, rule: currentRule };
    copyFlashUntil = io.now() + 2000;
    io.clearTimeout(copyFlashTimer);
    copyFlashTimer = io.setTimeout(() => { copyFlashUntil = 0; sendPill(); }, 2000);
  }
  // pre: a clipboard reading the caller already made (so it is read once, not twice).
  async function clipboardChanged(pre) {
    const sh = pre !== undefined ? pre : await readNow();
    // Ours if the text matches (ignoring line-ending and trailing-space differences clipboards add),
    // or if it arrives right after our own write. Some conversions read back slightly different,
    // and counting those as a new copy would wipe the ✓ at once.
    const sameText = !!sh && !sh.secret && isOurs(sh);
    const justWrote = io.now() <= ownWriteUntil;
    const ours = sameText || justWrote;
    log('clipboard changed:', ours ? 'ours (' + (sameText ? 'same text' : 'just written') + ')' : 'a new copy');
    if (ours) return;
    if (sh && sh.secret) return;
    onExternalCopy(sh ? sh.text : null);
    await refreshClip();
    maybeAutoFormat();
  }
  function maybeAutoFormat() {
    const rule = currentRule;
    if (!settings.autoFormat || !rule || pending || !copySummary()) return;
    if (copyRuleId === rule.id || autoDoneDest === rule.dest) return;
    log('auto-format for', rule.name);
    quick(rule.dest, 'auto');
  }
  function focus(win, version) {
    if (typeof version === 'number') shellVersion = version;
    if (shellVersion > 0 && shellVersion < 13 && !loginHinted && settings.welcomed) {
      loginHinted = true;
      helperHint = true;
    }
    if (win === null) { if (shellStatus !== 'unavailable') { shellStatus = 'unavailable'; winNow = null; currentRule = null; sendPill(); } return; }
    shellStatus = 'ok';
    if (win && isSelf(win)) return;
    winNow = win && (win.app || win.title) ? { app: win.app || '', title: win.title || '' } : null;
    currentRule = winNow ? matchRule(activeRules(), winNow) : null;
    ensureShortcuts();
    sendPill();
    maybeAutoFormat();
  }

  // ---------------------------------------------------------------- shortcuts
  async function applyShortcuts() {
    if (!(shellVersion >= 10)) return;
    const on = visibleKeys().filter((k) => k.on).map((k) => ({ id: k.id, accel: k.accel }));
    keysSent = JSON.stringify(on) + ':' + shellVersion;
    let failed = null;
    try { failed = await io.shell.setShortcuts(on); } catch (e) { failed = null; }
    keysFailed = failed || [];
    log('shortcuts:', on.map((k) => k.id).join(', ') || 'none', keysFailed.length ? '| taken: ' + keysFailed.join(', ') : '');
  }
  function ensureShortcuts() {
    if (shellVersion >= 10 && keysSent.split(':').pop() !== String(shellVersion)) applyShortcuts().then(sendPill);
  }
  function onShortcut(id) {
    log('shortcut:', id);
    const rule = currentRule;
    const autoPaste = shellVersion >= 6;
    if (id === 'pill') {
      if (!settings.pillEnabled) { settings.pillEnabled = true; save(); sendPill(); }
      return;
    }
    if (id === 'pdf') { makePdf(); return; }
    if (id === 'auto') { setAutoFormat(!settings.autoFormat); flash = { sub: 'Auto-format is ' + (settings.autoFormat ? 'on' : 'off') + '.', tone: 'ok', collapse: true, open: true }; sendPill(); return; }
    if (id === 'paste' || id === 'plain') {
      const dest = id === 'plain' ? 'text' : rule && rule.dest;
      if (!dest) { flash = { sub: 'Not one of your apps. Pick a format below.', tone: 'warn', open: true }; sendPill(); return; }
      quick(dest, autoPaste ? 'paste' : null);
    }
  }

  // ---------------------------------------------------------------- pill clicks
  function setAutoFormat(on) {
    settings.autoFormat = !!on;
    save();
    if (on) maybeAutoFormat();
    sendPill();
  }
  function onSettingsAction(kind, arg) {
    const list0 = () => setupApps().map((r) => r.id);
    const commit = (list) => {
      const shown = list0();
      if (list.length !== shown.length || !list.every((id) => shown.includes(id))) { sendPill(); return; }
      let k = 0;
      settings.appOrder = appOrder().map((id) => (shown.includes(id) ? list[k++] : id));
      save(); sendPill();
    };
    if (kind === 'view') pillView = PILL_PAGES.includes(arg) ? arg : 'main';
    if (kind === 'dswap' && /^\d{1,2}t\d{1,2}$/.test(arg)) {
      const list = list0();
      const [a, b] = arg.split('t').map(Number);
      if (a !== b && a < list.length && b < list.length) { [list[a], list[b]] = [list[b], list[a]]; commit(list); } else sendPill();
      return;
    }
    if (kind === 'dmove' && /^\d{1,2}[ud]$/.test(arg)) {
      const list = list0();
      const i = parseInt(arg, 10);
      const j = arg.endsWith('u') ? i - 1 : i + 1;
      if (i < list.length && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; commit(list); } else sendPill();
      return;
    }
    if (kind === 'dput' && /^\d{1,2}t\d{1,2}$/.test(arg)) {
      const list = list0();
      const [a, b] = arg.split('t').map(Number);
      if (a !== b && a < list.length && b < list.length) { const [d] = list.splice(a, 1); list.splice(b, 0, d); commit(list); } else sendPill();
      return;
    }
    if (kind === 'dhide' && /^\d{1,2}$/.test(arg)) {
      const list = list0();
      if (list.length > 1 && Number(arg) < list.length) { list.splice(Number(arg), 1); commit(list); } else sendPill();
      return;
    }

    if (kind === 'size' && ['s', 'm', 'l'].includes(arg)) settings.size = arg;
    if (kind === 'key' && /^\d{1,2}$/.test(arg)) {
      const k = visibleKeys()[Number(arg)];
      if (k) {
        const real = settings.shortcuts.find((x) => x.id === k.id);
        real.on = !real.on;
        settings.shortcuts = normalizeShortcuts(settings.shortcuts);
        save();
        applyShortcuts().then(sendPill);
        return;
      }
    }
    if (kind === 'toggle' && arg === 'auto') { setAutoFormat(!settings.autoFormat); return; }
    if (kind === 'toggle' && arg === 'link') settings.linkBack = !settings.linkBack;
    if (kind === 'toggle' && arg === 'crosslinks') { settings.crossLinks = !settings.crossLinks; if (!settings.crossLinks) crossLinks = []; }
    if (kind === 'toggle' && arg === 'tabicons') settings.tabIcons = !settings.tabIcons;
    if (kind === 'toggle' && arg === 'updates') { settings.updateCheck = !settings.updateCheck; save(); sendPill(); if (settings.updateCheck) checkUpdates(true); return; }
    if (kind === 'toggle' && arg === 'readfrom') {
      settings.readFrom = allApps() ? 'listed' : 'any';
      if (!allApps() && !setupApps().some((r) => r.enabled)) setupApps().forEach((r) => { r.enabled = !['github', 'terminal'].includes(r.id); });
      save(); if (winNow) focus(winNow, shellVersion); else sendPill(); return;
    }
    if (kind === 'rule' && SETUP_APP_IDS.includes(arg)) {
      const r = setupApps().find((x) => x.id === arg);
      // At least one app stays on: with none, "Only these apps" would mean Morph does nothing.
      if (r && (!r.enabled || setupApps().filter((x) => x.enabled).length > 1)) { r.enabled = !r.enabled; save(); }
      if (winNow) focus(winNow, shellVersion); else sendPill();
      return;
    }
    if (kind === 'toggle' && arg === 'mode') { settings.pillMode = settings.pillMode === 'always' ? 'apps' : 'always'; save(); sendPill(); return; }
    if (kind === 'dest' && ALL_DESTS.includes(arg)) {
      const set = new Set(settings.pillDests || ALL_DESTS);
      if (set.has(arg) && set.size > 1) set.delete(arg); else set.add(arg);
      settings.pillDests = cleanDests([...set]);
    }
    save();
    sendPill();
  }
  // The apps the first-run page offers, in the order it shows them. Same rules as the Apps page, so one list
  // decides both where Morph reads copies and where the pill (and so pasting) works.
  // The welcome card was answered: "ok" (Got it, ✕ or Esc) or "settings" (open Settings → Apps).
  function finishWelcome(arg) {
    if (settings.setupDone) return;
    settings.setupDone = true;
    settings.welcomed = true;
    save();
    log('welcome card closed:', arg);
    if (arg === 'settings') { pillView = 'edit'; flash = { sub: '', tone: 'ok', open: true }; }
    if (winNow) focus(winNow, shellVersion);
    else sendPill();
  }
  function action(a) {
    if (typeof a !== 'string' || !/^[a-z]+:[a-z0-9]*$/.test(a)) return;
    log('pill click:', a);
    const [kind, arg] = a.split(':');
    if (kind === 'fix' && arg) quick(arg, 'pill');
    if (kind === 'paste' && arg) quick(arg, 'paste');
    if (kind === 'orig') restoreOriginal();
    if (kind === 'auto') setAutoFormat(!settings.autoFormat);
    if (kind === 'hide') hidePill();
    if (kind === 'pdf') makePdf();
    if (kind === 'openpdf' && lastPdf) io.openPath(lastPdf);
    if (kind === 'showpdf' && lastPdf) io.showInFolder(lastPdf);
    if (kind === 'openlink') { const idx = parseInt(arg, 10); if (crossLinks[idx] && crossLinks[idx].url) io.openUri(crossLinks[idx].url); }
    if (['view', 'theme', 'toggle', 'dest', 'size', 'dswap', 'dhide', 'dadd', 'dmove', 'dput', 'rule'].includes(kind)) onSettingsAction(kind, arg);
    if (kind === 'key' && /^[a-z]+$/.test(arg)) onShortcut(arg);
    if (kind === 'key' && /^\d{1,2}$/.test(arg)) onSettingsAction('key', arg);
    if (kind === 'refresh') refreshClip();
    if (kind === 'setup' && /^(ok|settings)$/.test(arg)) finishWelcome(arg);
    if (kind === 'ocr' && /^(on|off|cancel|ask|askstop|askoff|no)$/.test(arg)) ocrAction(arg);
    if (kind === 'update') runUpdate();
    if (kind === 'checkupdate') checkNow();
    if (kind === 'uninstall') askUninstall();
    const mv = kind === 'moved' && /^([lr])(\d)y(\d{1,4})$/.exec(arg);
    if (mv) {
      settings.pillSide = mv[1];
      settings.pillMonitor = Number(mv[2]);
      settings.pillYFrac = Math.min(0.95, Math.max(0.05, Number(mv[3]) / 1000));
      save();
    }
  }
  function hidePill() {
    const keys = settings.shortcuts.find((k) => k.id === 'pill');
    const how = keys && keys.on ? accelLabel(keys.accel, false) : 'morph --restart';
    flash = { sub: 'Hiding. Bring it back with ' + how + '.', tone: 'ok', open: true };
    sendPill();
    io.setTimeout(() => { settings.pillEnabled = false; save(); sendPill(); }, 2200);
  }

  // ---------------------------------------------------------------- PDF
  async function makePdf() {
    const clip = await acquire();
    if (!clip) { flash = { sub: copySummary() ? 'Nothing to save yet.' : '', tone: 'warn' }; sendPill(); return false; }
    if (String(clip.text || '').length > PDF_MAX_CHARS || String(clip.html || '').length > PDF_MAX_CHARS * 5) { flash = { sub: 'Too big for a PDF. Copy a smaller part.', tone: 'warn' }; sendPill(); return false; }
    const r = FB.engine.run(Object.assign({}, clip, { linkBack: settings.linkBack, people: settings.people }), 'email');
    if (!r.has) { flash = { sub: 'Nothing to save yet.', tone: 'warn' }; sendPill(); return false; }
    let res = null;
    // The page is drawn from the document tree, with the source link and saved people applied, like the email version.
    const doc = FB.engine.withSourceLink(FB.applyPeople(r.ast, settings.people || {}), 'email', r.opts);
    try { res = await io.savePdf({ ast: doc, title: FB.engine.pdfTitle(r.ast) }); } catch (e) { res = null; }
    if (res && res.ok) {
      lastPdf = res.path || '';
      flash = { sub: 'Saved to Downloads: ' + res.name, tone: 'ok' };
      startTick('pdf');
      return true;
    }
    flash = { sub: 'Couldn’t save the PDF.', tone: 'warn' };
    sendPill();
    return false;
  }

  // ---------------------------------------------------------------- updates
  // Once a day (and on start) ask the website which version is current. Never installs by itself.
  async function checkUpdates(force) {
    if (!io.update) return;
    if (!force && (!settings.updateCheck || io.now() - settings.lastCheck < DAY_MS)) return;
    settings.lastCheck = io.now();
    save();
    let info = null;
    try { info = await io.update.check(); } catch (e) { info = null; }
    let status = info ? 'same' : 'failed';
    if (info) { settings.lastOk = io.now(); save(); }
    if (info && newer(info.version, io.version)) {
      status = 'newer';
      updateInfo = { version: String(info.version) };
      if (settings.notifiedVersion !== updateInfo.version) {
        settings.notifiedVersion = updateInfo.version;
        save();
      }
    } else if (info) updateInfo = null;
    sendPill();
    return status;
  }
  // The Check for updates button: always asks, and says what it found.
  async function checkNow() {
    if (!io.update || checking) return;
    checking = true;
    checkNote = '';
    checkFailed = false;
    sendPill();
    const status = await checkUpdates(true);
    checking = false;
    checkFailed = status === 'failed';
    checkNote = status === 'newer' ? 'Version ' + (updateInfo && updateInfo.version) + ' is available' : status === 'same' ? 'You are up to date (' + io.version + ')' : 'Could not reach the Morph website';
    sendPill();
  }
  async function runUpdate() {
    if (!updateInfo || updating || !io.update) return;
    updating = true;
    updateFailed = false;
    sendPill();
    let ok = false;
    try { ok = await io.update.run(); } catch (e) { ok = false; }
    // If we are still here, the updater finished without restarting us (or failed): never stay on "Updating…".
    updating = false;
    updateFailed = !ok;
    if (ok) await checkUpdates(true);
    sendPill();
  }
  // Two clicks: the first only arms it (and disarms itself after eight seconds).
  async function askUninstall() {
    if (!io.uninstall) return;
    if (shellVersion < 12 && !confirmUninstall) {
      confirmUninstall = true;
      io.clearTimeout(confirmTimer);
      confirmTimer = io.setTimeout(() => { confirmUninstall = false; sendPill(); }, 8000);
      sendPill();
      return;
    }
    confirmUninstall = false;
    io.clearTimeout(confirmTimer);
    let ok = false;
    try { ok = await io.uninstall.run(); } catch (e) { ok = false; }
    uninstallFailed = !ok;
    sendPill();
  }
  function scheduleUpdateChecks() {
    // Every hour see whether a day has passed since the last look.
    io.setTimeout(() => { checkUpdates(false).then(scheduleUpdateChecks, scheduleUpdateChecks); }, 60 * 60 * 1000);
  }

  // ---------------------------------------------------------------- start
  async function start() {
    load();
    sendPill();
    if (readsEverything()) await refreshClip(); // whatever is on the clipboard already (only if you chose to read every app)
    io.setTimeout(() => { checkUpdates(false); }, 20000);
    scheduleUpdateChecks();
  }

  return {
    start, focus, action, clipboardChanged, mayRead, readsEverything, load, sendPill, shellSpec, quick, makePdf, checkUpdates,
    get settings() { return settings; },
    get state() { return { currentRule, clipStatus, original, lastPdf, pending, keysFailed }; },
    set shellVersion(v) { shellVersion = v; },
    applyShortcuts,
  };
}

module.exports = { createCore, newer, ALL_DESTS, KEY_IDS, TICK_MS };
