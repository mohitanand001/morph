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
const PILL_PAGES = ['settings', 'size', 'keys', 'privacy', 'edit', 'updates', 'uninstall', 'about'];
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
  const SETTINGS_DEFAULT = { rules: DEFAULT_RULES, pillEnabled: true, pillMode: 'always', pillYFrac: 0.42, pillSide: 'r', pillMonitor: -1, autoFormat: false, linkBack: false, crossLinks: true, tabIcons: false, theme: 'sol-light', size: 'm', shortcuts: null, pillDests: null, atlassianSite: '', seenDefaults: null, people: {}, updateCheck: true, readFrom: 'listed', setupDone: false, lastCheck: 0, lastOk: 0, notifiedVersion: '' };
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
    settings.readFrom = settings.readFrom === 'any' ? 'any' : 'listed';
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
  // Morph reads the clipboard only for a copy made in an app you listed (or in any app, if you chose that),
  // and only once setup has been answered. Reads you ask for with a click are always fine.
  const readsEverything = () => settings.setupDone && settings.readFrom === 'any';
  const appLabel = (w) => (currentRule && currentRule.name) || (w && w.app ? String(w.app).replace(/\.desktop$/, '').slice(0, 30) : 'another app');
  function note(kind, app, chars) {
    readLog.push({ at: io.now(), kind, app: String(app || '').slice(0, 30), chars: chars || 0 });
    if (readLog.length > 30) readLog.shift();
  }
  // Called for every "something was copied" signal, before anything is read. true: go ahead and read.
  function mayRead() {
    if (!settings.setupDone) { return false; }
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
  function ocrBlocks() {
    if (shellVersion < 15) return [];
    if (ocrJob) {
      return [{ kind: 'status', tone: 'plain', icon: 'download', title: 'Installing table OCR…', items: [ocrJob.line || 'Starting…', 'About 1 GB, a few minutes. You can keep using your computer.'] },
        { kind: 'buttons', buttons: [{ label: 'Cancel', action: 'ocr:cancel', kind: 'secondary' }] }];
    }
    if (ocrReady()) {
      return [{ kind: 'panel', tone: 'ok', icon: 'check_circle', title: 'Table OCR is on', text: 'A copied image is read only when you pick an app, on this device. Nothing is uploaded.' },
        ...(ocrCanManage() ? [{ kind: 'buttons', buttons: [{ label: 'Remove table OCR', action: 'ocr:off', kind: 'secondary', confirm: { title: 'Remove table OCR?', body: 'This deletes the OCR files (about 1 GB). Morph keeps working without it.', ok: 'Remove' } }] }] : [])];
    }
    return [{ kind: 'panel', tone: ocrFail ? 'warn' : 'plain', icon: ocrFail ? 'warning' : 'grid_view', title: 'Table OCR (optional)',
        text: ocrFail ? ocrFail : 'Reads tables from copied screenshots, on this device. Off until you turn it on.' },
      ...(ocrCanManage() ? [{ kind: 'buttons', buttons: [{ label: ocrFail ? 'Try again' : 'Enable table OCR', action: 'ocr:on', kind: 'primary', confirm: { title: 'Enable table OCR?', body: 'This downloads and installs PaddleOCR (about 1 GB, one time) and needs internet. Images are read only on this device, and only when you pick an app.', ok: 'Install' } }] }] : [{ kind: 'panel', tone: 'plain', title: 'To turn it on', text: 'Run  morph --enable-ocr  in a terminal.' }])];
  }
  function ocrAction(arg) {
    if (arg === 'on' && ocrCanManage() && !ocrJob && !ocrReady()) {
      ocrFail = '';
      ocrJob = { line: 'Starting…', cancelled: false };
      const job = ocrJob;
      sendPill();
      io.ocr.install((line) => { if (ocrJob === job && line) { job.line = String(line).slice(0, 110); sendPill(); } },
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
    return t + ' · ' + (e.kind === 'ocr' ? 'Read a table from an image, on this device' : e.kind === 'skipped' ? 'Skipped a copy from ' + e.app : 'Read ' + e.chars + ' characters from ' + (e.app || 'an app'));
  }

  // ---------------------------------------------------------------- pill spec
  const pillShouldShow = () => {
    if (!settings.pillEnabled) return false;
    if (settings.pillMode === 'always') return true;
    if (shellStatus === 'unavailable') return true;
    return !!currentRule;
  };
  function copySummary() {
    if (clipStatus === 'Nothing copied yet' || /^Nothing to convert/.test(clipStatus) || /^Not read/.test(clipStatus)) return null;
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
    const offered = settings.pillDests || ALL_DESTS;
    const nav = [
      { id: 'settings', label: 'General', icon: 'tune' },
      { id: 'edit', label: 'Apps', icon: 'grid_view' },
      { id: 'keys', label: 'Shortcuts', icon: 'keyboard' },
      { id: 'privacy', label: 'Privacy', icon: 'lock' },
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
      const hidden = ALL_DESTS.filter((d) => !offered.includes(d));
      spec.pane = { title: 'Apps', lede: 'Drag to reorder. Switch apps on or off.',
        apps: offered.map((d, i) => ({ label: OPTION_LABEL[d], dest: d, sw: 'on', action: 'dest:' + d,
          up: i > 0 ? 'dmove:' + i + 'u' : '', down: i < offered.length - 1 ? 'dmove:' + i + 'd' : '' }))
          .concat(hidden.map((d) => ({ label: OPTION_LABEL[d], dest: d, sw: 'off', action: 'dest:' + d, up: '', down: '' }))) };
    } else if (cur === 'keys') {
      const KEY_SHORT = { paste: 'Paste, fixed', plain: 'Paste as plain text', pill: 'Open the pill', auto: 'Auto-format on/off', pdf: 'Save as PDF' };
      const KEY_ICON = { paste: 'content_paste', plain: 'notes', pill: 'grid_view', auto: 'bolt', pdf: 'description' };
      spec.pane = { title: 'Shortcuts', lede: 'Click a shortcut to turn it on or off.',
        keys: shortcutsForSettings().map((k, i) => ({ label: KEY_SHORT[k.id] || k.name, icon: KEY_ICON[k.id] || 'keyboard', keys: k.label.split(' ').filter(Boolean).slice(0, 5), sw: sw(k.on && !k.taken), note: k.taken ? 'Taken by another app' : '', action: 'key:' + i })) };
    } else if (cur === 'privacy') {
      const recent = readLog.slice(-8).reverse().map(readLine);
      spec.pane = { title: 'Privacy', lede: 'Morph never stores or sends what you copy.',
        opts: [{ icon: 'lock', label: 'Read copies from all apps', sub: settings.readFrom === 'any' ? 'On: any app except password managers. Nothing is stored or sent' : 'Off: only copies from your apps are read. Others wait for a click', sw: sw(settings.readFrom === 'any'), action: 'toggle:readfrom' }] };
      if (shellVersion >= 13) spec.pane.blocks = [{ kind: 'panel', tone: 'plain', title: 'What Morph read', items: recent.length ? recent : ['Nothing yet. Copies show up here, without their content.'] },
        ...ocrBlocks()];
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
          { kind: 'text', text: 'Uninstalling stops Morph and removes it from this computer. You can install it again at any time.' },
          { kind: 'panel', tone: 'plain', title: 'What will be removed', items: [
            'The Morph program and its folder',
            'Your Morph settings: chosen apps, order, size and shortcuts',
            'Morph log files',
            'Start at login',
            'The pill (its GNOME helper)',
            'The morph command' ] },
          { kind: 'panel', tone: 'warn', icon: 'warning', title: 'This deletes your Morph settings', text: 'Nothing you copy is ever stored by Morph, so there is no clipboard data to lose. Your documents and other files are not touched.' },
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
          { icon: 'bolt', label: 'Convert automatically', sub: 'Fix copies when you switch apps', sw: sw(settings.autoFormat), action: 'toggle:auto' },
          { icon: 'link', label: 'Keep the source link', sub: 'Add a link back to where it came from', sw: sw(settings.linkBack), action: 'toggle:link' },
          { icon: 'public', label: 'Show links in copies', sub: 'URLs, tickets and emails you can click to open', sw: sw(settings.crossLinks), action: 'toggle:crosslinks' },
          { icon: 'grid_view', label: 'App icons on the tab', sub: 'Convert with one click, without opening it', sw: sw(settings.tabIcons), action: 'toggle:tabicons' },
          { icon: 'public', label: 'Show the pill in every app', sub: 'Off: only in the apps you chose', sw: sw(settings.pillMode === 'always'), action: 'toggle:mode' },
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
    const offered = settings.pillDests || ALL_DESTS;
    const others = offered.filter((d) => !rule || d !== rule.dest);
    const rows = [];
    const skipped = !copy && /^Not read/.test(clipStatus) && !!lastSkip;
    const idle = !copy && !skipped; // a skipped copy still lets you pick an app: that click is you asking Morph to read it
    const imageOnly = idle && /image$/.test(clipStatus);
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
        : skipped ? { icon: 'lock', title: lastSkip.pm ? 'Password manager: skipped' : 'Skipped on purpose', sub: lastSkip.pm ? 'Morph never reads copies from password managers.' : 'Copied from ' + lastSkip.app + ', which is not one of your apps, so Morph did not read it. Pick an app below to convert it, or turn on "Read copies from all apps" in Settings, Privacy.' }
        : imageOnly ? { icon: 'image', title: 'Image copied', sub: 'Nothing to convert. Paste it as it is.' }
        : { icon: 'content_paste', title: 'Nothing copied yet', sub: 'Copy something to start' },
      links: [],
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
    if (copy && rule && settings.autoFormat && autoDoneDest === rule.dest) spec.sub = (copy.what ? copy.what + ' · ' : '') + 'already fixed, just press Ctrl V';
    spec.section = rule ? 'Copy for another app' : 'Copy it for';
    spec.options = rows;
    if (copy) {
      spec.original = tickDest === 'original' ? { label: 'Original', done: true } : { label: 'Original', hint: 'as copied', action: 'orig:', busy: 'Restoring…' };
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
    if (!settings.setupDone && shellVersion >= 14) {
      // First run: one centered page, before the pill shows. Nothing is read until it is answered.
      spec.visible = false;
      spec.setup = { title: 'Set up ' + APP_NAME, lede: APP_NAME + ' re-shapes what you copy for the app you paste into. Your clipboard stays on your device. ' + APP_NAME + ' never uploads or stores copied content.',
        appsLabel: 'Choose your apps', apps: setupApps().map((r) => ({ name: r.name, on: r.enabled, dest: r.dest, logo: r.id === 'github' || r.id === 'terminal' ? r.id : r.dest })),
        appsNote: APP_NAME + ' reads and formats only in these apps.',
        fmtNote: shellVersion >= 22 ? 'Formats are supported for ' + setupApps().map((r) => r.name).join(', ') + ' for now. In other apps you can still pick a format from the pill.' : '',
        opts: shellVersion >= 22 ? [
          { id: 'all', title: 'Where should ' + APP_NAME + ' work?', sel: 0, choices: [
            { label: 'All apps', sub: 'Reads your copies from any app, except password managers, and formats them for the tools below. Nothing is stored or sent.', bit: '1' },
            { label: 'Only the apps I choose', sub: 'Reads and formats only in the apps you tick.', bit: '0' }] },
          { id: 'auto', title: 'Convert', sel: 0, choices: [
            { label: 'When I pick an app in the pill', sub: '', bit: '0' },
            { label: 'Automatically when I switch to one of these apps', sub: 'This rewrites your clipboard.', bit: '1' }] }] : [],
        updLabel: 'Check for updates daily', updSub: 'Automatically checks whether a newer version is available.', updOn: settings.updateCheck,
        none: 'Select at least one app to continue.', start: 'Start ' + APP_NAME };
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
  let ocrNote = '';      // why the last image read gave nothing
  let ocrFromImage = false; // the clip being converted was read from an image
  async function readImageTable() {
    ocrNote = '';
    if (!ocrReady()) return null;
    clipStatus = 'Reading the table…';
    sendPill();
    const r = await io.ocr.run();
    note('ocr', 'an image', 0);
    if (!r.ok || !/<table/i.test(r.html || '')) {
      ocrNote = r.error === 'no_table' ? 'No table found in that image.' : 'Couldn’t read that image.';
      clipStatus = 'Image copied: ' + ocrNote.toLowerCase();
      sendPill();
      return null;
    }
    const clip = { html: r.html, text: '', context: null };
    const run = FB.engine.run(clip, null);
    if (!run.has) { ocrNote = 'No table found in that image.'; sendPill(); return null; }
    original = clip;
    ocrFromImage = true;
    crossLinks = [];
    clipStatus = 'Table read from an image, ' + (FB.astStats(run.ast).summary || 'table');
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
      flash = r.ok ? { sub: r.restored ? 'Your original is back on the clipboard. Paste it as you copied it.' : r.fromImage ? 'Read from an image: check the numbers.' : '', tone: 'ok', collapse: false } : { sub: r.note || (copySummary() ? 'Couldn’t convert that.' : ''), tone: 'warn', collapse: false };
      if (r.ok) startTick(r.restored ? 'original' : pendingDest); else sendPill();
      return;
    }
    io.notify(r.ok ? 'Ready to paste into ' + r.name : 'Nothing to convert', r.ok ? r.summary || '' : 'Copy something first.');
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
      io.notify('Update the helper', 'Morph updated. Run "morph --install" in a terminal to load the new helper, then the new Settings appear.');
    }
    if (win === null) { if (shellStatus !== 'unavailable') { shellStatus = 'unavailable'; winNow = null; currentRule = null; sendPill(); } return; }
    shellStatus = 'ok';
    if (win && isSelf(win)) return;
    winNow = win && (win.app || win.title) ? { app: win.app || '', title: win.title || '' } : null;
    currentRule = winNow ? matchRule(settings.rules, winNow) : null;
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
    const list0 = () => (settings.pillDests || ALL_DESTS).slice();
    const commit = (list) => { settings.pillDests = cleanDests(list); save(); sendPill(); };
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
    if (kind === 'dadd' && ALL_DESTS.includes(arg)) { const list = list0(); if (!list.includes(arg)) list.push(arg); commit(list); return; }
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
    if (kind === 'toggle' && arg === 'readfrom') { settings.readFrom = settings.readFrom === 'any' ? 'listed' : 'any'; save(); sendPill(); return; }
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
  const SETUP_APP_IDS = ['slack', 'jira', 'confluence', 'outlook', 'gdocs', 'notion', 'linear', 'teams', 'github', 'terminal'];
  const setupApps = () => SETUP_APP_IDS.map((id) => settings.rules.find((r) => r.id === id)).filter(Boolean);
  // arg: one char for "check for updates" (0/1), then one char per app in setupApps() order (0/1).
  function welcome() {
    if (settings.welcomed || !settings.setupDone) return;
    settings.welcomed = true;
    save();
    io.notify(APP_NAME + ' is running', 'Look for the small tab on the edge of the screen. Copy something, then click it.');
  }
  function finishSetup(arg) {
    if (settings.setupDone) return;
    const apps = setupApps();
    // update bit, one bit per app, then (from helper 17) "read from all apps" and "auto format".
    const n = apps.length + 1;
    if ((arg.length !== n && arg.length !== n + 2) || !/^[01]+$/.test(arg)) return;
    const picks = arg.slice(1, n);
    if (!picks.includes('1')) { sendPill(); return; } // at least one app, always
    apps.forEach((r, i) => { r.enabled = picks[i] === '1'; });
    settings.readFrom = arg.length === n + 2 && arg[n] === '1' ? 'any' : 'listed';
    settings.autoFormat = arg.length === n + 2 && arg[n + 1] === '1';
    settings.updateCheck = arg[0] === '1';
    settings.setupDone = true;
    save();
    log('setup done:', apps.filter((r) => r.enabled).length + ' apps', settings.readFrom === 'any' ? 'all apps' : 'listed apps only', settings.autoFormat ? 'auto format on' : 'auto format off', settings.updateCheck ? 'updates on' : 'updates off');
    welcome();
    if (winNow) focus(winNow, shellVersion); // the app in front may have just been ticked
    else sendPill();
    if (readsEverything()) refreshClip();
    io.setTimeout(() => { checkUpdates(false); }, 20000);
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
    if (['view', 'theme', 'toggle', 'dest', 'size', 'dswap', 'dhide', 'dadd', 'dmove', 'dput'].includes(kind)) onSettingsAction(kind, arg);
    if (kind === 'key' && /^[a-z]+$/.test(arg)) onShortcut(arg);
    if (kind === 'key' && /^\d{1,2}$/.test(arg)) onSettingsAction('key', arg);
    if (kind === 'refresh') refreshClip();
    if (kind === 'setup' && /^[01]{2,16}$/.test(arg)) finishSetup(arg);
    if (kind === 'ocr' && /^(on|off|cancel)$/.test(arg)) ocrAction(arg);
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
    settings.pillEnabled = false;
    sendPill();
    const keys = settings.shortcuts.find((k) => k.id === 'pill');
    const how = keys && keys.on ? accelLabel(keys.accel, false) : 'logging out and in again';
    io.notify(APP_NAME + ' pill hidden', 'Bring it back with ' + how + '.');
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
      startTick('pdf');
      io.notify('Saved ' + res.name, 'In your Downloads folder.');
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
        io.notify(APP_NAME + ' ' + updateInfo.version + ' is available', 'Open the pill, then Settings, Updates, and choose Update now.');
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
    sendPill();
    let ok = false;
    try { ok = await io.update.run(); } catch (e) { ok = false; }
    // If we are still here, the updater finished without restarting us (or failed): never stay on "Updating…".
    updating = false;
    if (!ok) io.notify('Update did not finish', 'Try again, or run morph --update in a terminal.');
    else await checkUpdates(true);
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
    io.notify('Removing ' + APP_NAME, 'The pill will disappear.');
    let ok = false;
    try { ok = await io.uninstall.run(); } catch (e) { ok = false; }
    if (!ok) io.notify('Could not uninstall', 'Run morph --purge in a terminal instead.');
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
    welcome(); // only once the first-run page has been answered, so it never sits on top of it
    if (readsEverything()) await refreshClip(); // whatever is on the clipboard already (only if you chose to read every app)
    io.setTimeout(() => { if (settings.setupDone) checkUpdates(false); }, 20000);
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
