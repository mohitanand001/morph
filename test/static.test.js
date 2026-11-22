// Static checks: wiring, security settings and packaging, no browser needed.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

const html = read('src/index.html');
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => 'src/' + m[1]);
scripts.forEach((s) => check('script exists: ' + s, exists(s)));
const core = fs.readdirSync(path.join(root, 'src/core')).filter((f) => f.endsWith('.js')).map((f) => 'src/core/' + f);
core.forEach((c) => check('core file loaded once: ' + c, scripts.filter((s) => s === c).length === 1));
core.forEach((c) => { const s = read(c).trim(); check('core file wrapped (no leaked globals): ' + c, /^\(function\s*\(\)\s*\{/.test(s) && /\}\)\(\);?$/.test(s)); });
check('app.js loads last', scripts[scripts.length - 1] === 'src/app.js');
check('no inline scripts', !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html));
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
check('CSP present', !!csp);
check('CSP: scripts only from the app', /script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe/.test(csp));
check('CSP: no network from the window', /connect-src 'none'/.test(csp));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
check('no duplicate ids', new Set(ids).size === ids.length);
[...read('src/app.js').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).forEach((id) => check('element exists: #' + id, ids.includes(id)));

const main = read('main.js');
check('window: contextIsolation on', /contextIsolation:\s*true/.test(main));
check('window: sandbox on', /sandbox:\s*true/.test(main));
check('window: nodeIntegration off', /nodeIntegration:\s*false/.test(main));
check('window: never navigates away', /will-navigate/.test(main) && /setWindowOpenHandler/.test(main));
check('tray app: no taskbar entry', /skipTaskbar:\s*true/.test(main));
check('tray app: keeps running with no window', /window-all-closed[\s\S]{0,80}preventDefault/.test(main));
check('tray app: single instance', /requestSingleInstanceLock/.test(main));
check('clipboard: password-manager secrets are skipped', /passwordmanagerhint/i.test(main) && /concealed/i.test(main));
check('clipboard: macOS is not watched in the background', /if \(IS_MAC\) return;/.test(main));
check('external links limited to http(s)/mailto', /\^\(https\?:\|mailto:\)/.test(main));
const pre = read('preload.js');
check('preload exposes only window.bridge', (pre.match(/exposeInMainWorld/g) || []).length === 1 && /exposeInMainWorld\('bridge'/.test(pre));
check('preload does not expose ipcRenderer itself', !/ipcRenderer\s*[,}]/.test(pre.split('exposeInMainWorld')[1]));

const pkg = JSON.parse(read('package.json'));
check('package main exists', exists(pkg.main));
check('package files exist', pkg.build.files.every((f) => f.includes('*') || exists(f)));
const png = fs.readFileSync(path.join(root, 'build/icon.png'));
check('icon is at least 512px (needed for macOS)', png.readUInt32BE(16) >= 512 && png.readUInt32BE(20) >= 512);
check('linux and mac targets configured', !!pkg.build.linux && !!pkg.build.mac);

// pill
const pillHtml = read('src/pill.html');
check('pill page scripts exist', [...pillHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].every((m) => exists('src/' + m[1])));
check('pill page CSP: scripts only from the app, nothing else loads', /script-src 'self'/.test(pillHtml) && /default-src 'none'/.test(pillHtml));
check('window pill sets text only with textContent and checks colours', !/innerHTML/.test(read('src/pill.js')) && /COLOR_RE\.test\(o\.color\)/.test(read('src/pill.js')) && /ACTION_RE = \/\^\[a-z\]\+:\[a-z0-9\]\*\$\//.test(read('preload-pill.js')));
check('Mac paste needs Accessibility, is off by default, and falls back to ⌘V', /macAutoPaste: false/.test(main) && /keystroke "v" using \{command down/.test(main) && /Press ⌘V to paste/.test(main));
check('Mac pill is a non-activating panel', /IS_MAC \? \{ type: 'panel' \}/.test(main) && /focusable: false/.test(main));
check('pill never takes focus', /focusable:\s*false/.test(main));
check('pill window is sandboxed with its own preload', /preload-pill\.js/.test(main) && (main.match(/sandbox:\s*true/g) || []).length >= 2);
const pp = read('preload-pill.js');
check('pill preload exposes only window.pill', (pp.match(/exposeInMainWorld/g) || []).length === 1 && /exposeInMainWorld\('pill'/.test(pp));
check('Linux pill is a solid window (see-through ones fail to draw there)', /transparent: !PILL_OPAQUE/.test(main) && /const PILL_OPAQUE = IS_LINUX/.test(main));
check('Wayland runs through XWayland for the pill', /ozone-platform', 'x11'/.test(main));
check('settings are validated before saving', /normalizeRules\(next\.rules\)/.test(main));
const ext = 'gnome-extension/morph-focus@morph.dev';
let meta = null;
try { meta = JSON.parse(read(ext + '/metadata.json')); } catch (e) { /* reported below */ }
check('GNOME helper metadata is valid', !!meta && meta.uuid === 'morph-focus@morph.dev' && meta['shell-version'].includes('46'));
const extJs = read(ext + '/extension.js');
check('GNOME helper exports the D-Bus path the app reads', extJs.includes("'/dev/morph/Focus'") && read('lib/focus.js').includes("'/dev/morph/Focus'"));
check('GNOME helper draws the pill and reports clicks', /SetPill/.test(extJs) && /name="Action"/.test(extJs) && /addChrome/.test(extJs));
check('GNOME helper only emits well-formed actions', /ACTION_RE = \/\^\[a-z\]\+:\[a-z0-9\]\*\$\//.test(extJs) && /if \(!ACTION_RE\.test\(a\)\) return;/.test(extJs));
check('GNOME helper ships its stylesheet and the installer copies it', exists(ext + '/stylesheet.css') && read('gnome-extension/install.sh').includes('stylesheet.css'));
check('app reads the clipboard at startup', /did-finish-load', \(\) => win\.webContents\.send\('clip:changed'\)/.test(main));
// The pill itself never takes keyboard focus. The first-run setup card is its own window and does (Tab, Space, Esc),
// so only that one function is exempt.
const setupStart = extJs.indexOf('  _syncSetup() {');
const setupEnd = extJs.indexOf("  // GNOME's own confirmation dialog:");
const extNoSetup = extJs.slice(0, setupStart) + extJs.slice(setupEnd);
check('GNOME helper pill never takes keyboard focus', setupStart > 0 && setupEnd > setupStart && !/can_focus:\s*true/.test(extNoSetup) && (extNoSetup.match(/can_focus:\s*false/g) || []).length >= 2 && !/grab_key_focus/.test(extNoSetup));
check('only the setup card may take keyboard focus, and it is keyboard-operable', /key-press-event/.test(extJs.slice(setupStart, setupEnd)) && /Escape/.test(extJs.slice(setupStart, setupEnd)));
check('the setup card moves only while the mouse button is held, and a missed release cannot leave it following the pointer', /BUTTON1_MASK/.test(extJs.slice(setupStart, setupEnd)) && /_setupDragEnd/.test(extJs.slice(extJs.indexOf('  _closeSetup() {'), setupStart)));
check('the first-run card is a welcome with no questions: Got it or Open Settings, nothing else to answer', /finish\('ok'\)/.test(extJs.slice(setupStart, setupEnd)) && /finish\('settings'\)/.test(extJs.slice(setupStart, setupEnd)) && !/Step ' \+/.test(extJs.slice(setupStart, setupEnd)) && !/optSel/.test(extJs.slice(setupStart, setupEnd)));
check('no desktop notifications: everything is said inside Morph', !/io\.notify\(/.test(read('daemon/core.js').replace(/^\s*\/\/.*$/gm, '')));
check('GNOME helper reads the clipboard and announces new copies', /ReadClipboardAsync/.test(extJs) && /owner-changed/.test(extJs) && /SECRET_MIME/.test(extJs) && /ClipboardChanged/.test(read('lib/focus.js')));
check('app falls back to GNOME for the clipboard and verifies writes', /shellReadClipboard\(\)/.test(main) && /verifyWrite\(/.test(main) && /onClipboard:/.test(main));
check('GNOME pill tucks away on outside clicks and window switches', /captured-event/.test(extJs) && /_outsideClick/.test(extJs) && /_focusChanged\(\) \{[\s\S]*?_setOpen\(false\)/.test(extJs));
check('GNOME pill can be dragged and its height is remembered', /'moved:'/.test(extJs) && /pillYFrac/.test(main) && /kind === 'moved'/.test(main));
check('GNOME pill colours come from the app and are validated', /COLOR_RE = \/\^#\[0-9a-fA-F\]\{6\}\$\//.test(extJs) && /COLOR_RE\.test\(o\.color\)/.test(extJs) && ['slack','jira','confluence','email','gdocs','markdown','text'].every((k) => new RegExp(k + ": '#[0-9a-f]{6}'").test(main)));
check('GNOME pill buttons press in and show progress right away', /notify::pressed/.test(extJs) && /fb-busy/.test(extJs) && /busy: 'Saving…'/.test(main));
check('GNOME pill draws no shadow (no halo, no trails)', !/box-shadow/.test(read(ext + '/stylesheet.css')));
check('GNOME pill tucks away when you click an app window', /global\.get_pointer\(\)/.test(extJs) && /_startPoll\(\)/.test(extJs) && /_stopPoll\(\)[\s\S]*_clearTimers/.test(extJs));
check('one-click paste goes through the helper and only after a successful fix', /Paste\(shift\)/.test(extJs) && /from === 'paste'[\s\S]*?if \(r\.ok\)[\s\S]*?pasteNow\(/.test(main) && /function pasteNow[\s\S]*?shellPaste\(shift\)/.test(main));
check('own clipboard writes are told apart by content (loosely) with a short just-written grace', /const ours = sameText \|\| justWrote/.test(main) && /ownText = text;/.test(main) && /ownWriteUntil = Date\.now\(\) \+ 1500/.test(main));
check('clipboard on GNOME Wayland is read from GNOME first', /if \(usingShellClip\(\)\) \{\s*const sh = await shellReadClipboard\(\)/.test(main));
check('write check compares the text, not leftover HTML', /const ok = sh && sh\.text === text;/.test(main));
check('GNOME pill skips identical updates and keeps the busy state across rebuilds', /state === this\._lastState/.test(extJs) && /this\._busy && this\._busy\.action === action/.test(extJs) && /BUSY_MAX_MS/.test(extJs));
check('the pill is drawn in Solarized Light in both renderers', /\.fb-panel \{[^}]*background-color: #fdf6e3/.test(read(ext + '/stylesheet.css')) && /--win: #fdf6e3/.test(read('src/pill.css')));
check('link back is off by default, never for plain text or the same app', /linkBack: false/.test(main) && /dest !== 'text' && c\.dest !== dest && !E\.passthrough\(dest, opts\)/.test(read('src/core/engine.js')));
check('auto-format is off by default, skips copies made in the same app, and never runs twice', /autoFormat: false/.test(main) && /copyRuleId === rule\.id \|\| autoDoneDest === rule\.dest/.test(main) && /settings\.autoFormat = settings\.autoFormat === true/.test(main));
check('pill docks to either edge of any monitor', /fb-left/.test(extJs) && /_side === 'l'/.test(extJs) && /\^\(\[lr\]\)\(\\d\)y\(\\d\{1,4\}\)\$/.test(main));
check('recent copies stay in memory and their labels are cleaned', /history:set/.test(main) && /\\u0000-\\u001f/.test(main) && !/history[^\n]*writeFileSync/.test(main));
check('the pill has its own settings page: sidebar + panes (General, Apps, Shortcuts, Size, About)', /function settingsSpec/.test(main) && /cur === 'edit'/.test(main) && /cur === 'about'/.test(main) && /_fillSettings\(s\)/.test(extJs) && /function renderSettings/.test(read('src/pill.js')));
check('Edit apps: the order you set is kept, hiding never removes the last app, every action fits the pill\'s action format', /list\.forEach\(\(d\) => \{ if \(ALL_DESTS\.includes\(d\) && !out\.includes\(d\)\) out\.push\(d\)/.test(main) && /kind === 'dswap'/.test(main) && /list\.length > 1 && Number\(arg\) < list\.length/.test(main) && ['dswap:1t3', 'dhide:2', 'dadd:gdocs', 'view:edit'].every((a) => /^[a-z]+:[a-z0-9]*$/.test(a)));
check('link back shows what it will add before you paste', /spec\.note = 'Adds “Source: '/.test(main) && /s\.note/.test(read('src/pill.js')) && /s\.note/.test(extJs));
check('shortcuts are grabbed by GNOME, validated, and released on disable', /grab_accelerator\(k\.accel/.test(extJs) && /ACCEL_RE\.test\(k\.accel\)/.test(extJs) && /disable\(\)[\s\S]*_ungrabKeys\(\)/.test(extJs));
check('paste waits until you let go of the shortcut keys', /mods & HELD\) !== 0 && waited < 1500/.test(extJs));
check('pill sizes are defined', /\.fb-size-s \.fb-panel/.test(read(ext + '/stylesheet.css')) && /\.fb-size-l \.fb-panel/.test(read(ext + '/stylesheet.css')));
check('PDFs are printed with scripts off, nothing loaded but images, temp file removed', /javascript: false, sandbox: true/.test(main) && /default-src \\'none\\'; img-src https: data:/.test(main) && /fs\.unlinkSync\(tmp\)/.test(main));
check('Slack channel comes from the window title only (no Slack API, no token)', /slackTarget/.test(read('lib/source.js')) && !/slack\.com\/api/.test(main + read('lib/slack.js')) && /copyPlace\(\)/.test(main));
check('✕ closes the pill completely and a shortcut or the menu brings it back', /kind === 'hide'\) hidePillCompletely\(\)/.test(main) && /if \(!settings\.pillEnabled\) \{ settings\.pillEnabled = true/.test(main) && /this\._action\('hide:'\)/.test(extJs));
check('app uses the GNOME pill when available', /usingShellPill\(\)/.test(main) && /setShellPill/.test(main));
check('GNOME pill sizes itself from what is showing (tab or panel)', /const shown = this\._open \? this\._panel : this\._handle;/.test(extJs) && !/this\._root\.get_preferred_width/.test(extJs));
check('GNOME helper cleans up on disable', /disable\(\)[\s\S]*removeChrome[\s\S]*unexport/.test(extJs) && /disconnect/.test(extJs) && /_clearTimers\(\)/.test(extJs));
check('package ships lib, pill preload and nothing else new', pkg.build.files.includes('lib/**/*') && pkg.build.files.includes('preload-pill.js'));

// A helper method must not share a name with an instance field (this._dot is the handle's dot): calling it would throw and blank the panel.
{
  const fields = new Set([...extJs.matchAll(/this\.(_\w+)\s*=[^=]/g)].map((m) => m[1]));
  const methods = [...extJs.matchAll(/^  (_\w+)\(.*\) \{$/gm)].map((m) => m[1]);
  const clash = methods.filter((m) => fields.has(m));
  check('GNOME helper: no method shares a name with a field', clash.length === 0, clash.join(', '));
}

{
  const css = read(ext + '/stylesheet.css');
  const fixed = [...css.matchAll(/([^{}\n]*\.fb-(?:option|echip))\s*\{([^}]*)\}/g)].filter((m) => /\bwidth:\s*\d+px/.test(m[2])).map((m) => m[1].trim());
  check('GNOME chips share the row equally (no fixed widths that overflow at other screen scales)', fixed.length === 0 && /homogeneous = true/.test(extJs), fixed.join(' | '));
  check('every page keeps one panel height', /_fitHeight\(\)/.test(extJs) && /function fitHeight/.test(read('src/pill.js')));
  check('the apps are shown even when nothing is copied', /spec\.options = rows;\s*if \(copy\) \{/.test(main));
}

// ---- edit-apps chips must be the same chips as the main page
{
  const css = read(ext + '/stylesheet.css');
  const pcss = read('src/pill.css');
  const pjs = read('src/pill.js');
  const own = [...css.matchAll(/(^|\n)([^{}\n]*\.fb-echip)\s*\{([^}]*)\}/g)].filter((m) => /\b(padding|border-radius|font-size)\s*:/.test(m[3])).map((m) => m[2].trim());
  check('GNOME edit chips are option chips (class + inner row), no size rules of their own', /style_class: 'fb-option fb-echip'/.test(extJs) && /style_class: 'fb-btn-row'/.test(extJs.slice(extJs.indexOf('_editChip(it, ci)'), extJs.indexOf('_fillEdit('))) && own.length === 0, own.join(' | '));
  check('apps can be switched on and off from the pill (a fixed list when the core asks for one)', /kind === 'dput'/.test(main) && /'dput:'/.test(pjs) && /'dput:'/.test(extJs) && /_appRow\(x, i, !p\.appsFixed && x\.sw !== 'none'\)/.test(extJs));
  check('title bar like the design: logo, Morph, gear, minimize, close (both pills)', /'fb-gear', 'settings'/.test(extJs) && /'fb-logo', 'content_paste'/.test(extJs) && /iconBtn\('gear', 'settings'/.test(pjs) && /glyph\('content_paste', 'logo'\)/.test(pjs));
  check('the middle of the pill scrolls and the footer stays (both pills)', /St\.ScrollView/.test(extJs.slice(extJs.indexOf('this._body = vbox'))) && /el\('div', 'body'\)/.test(pjs) && /\.body \{[^}]*overflow-y: auto/.test(pcss));
}

// ---- design tuner (FB_TUNE=1)
{
  const T = require('../lib/tune');
  const ACTION = /^[a-z]+:[a-z0-9]*$/;
  check('tuner: knob ids are unique', new Set(T.K.map((k) => k.id)).size === T.K.length);
  check('tuner: untouched means no rules', T.css({}, 'm', 'g') === '' && T.css({}, 'm', 'w') === '');
  const g = T.css({ chR: 20, chBg: '#2a3a55', pw: 340 }, 'm', 'g');
  check('tuner: GNOME rules for what changed', /\.fb-option \{[^}]*border-radius: 20px/.test(g) && /background-color: #2a3a55/.test(g) && /width: 340px/.test(g));
  check('tuner: Small scales from Medium', /width: 278\.8px/.test(T.css({ pw: 340 }, 'm', 'w').replace('340', '340') ? T.css({ pw: 340 }, 's', 'g') : ''));
  check('tuner: actions fit the shared action format', ['tn:12v3800', 'tc:3h210s55l40', 'tr:4', 'tr:all', 'tcopy:'].every((a) => ACTION.test(a)));
  const set = T.parseAction('tn:' + T.BY_ID.chR.idx + 'v200');
  check('tuner: number action', set && set.op === 'set' && set.id === 'chR' && set.v === 20);
  const col = T.parseAction('tc:' + T.BY_ID.chBg.idx + 'h0s0l100');
  check('tuner: colour action', col && col.v === '#ffffff');
  check('tuner: junk is refused', !T.parseAction('tn:999v1') && !T.parseAction('tc:0h1s1l1') && !T.parseAction('rm:'));
  check('tuner: values are clamped and defaults dropped', JSON.stringify(T.cleanVals({ chR: 999, chBg: 'red', pw: 312 })) === JSON.stringify({ chR: 30 }));
  const mainSrc = read('main.js');
  check('tuner: only with FB_TUNE=1', /process\.env\.FB_TUNE === '1'/.test(mainSrc));
  check('clipboard history is behind a flag', /FEATURES\.clipboardHistory && historyItems\.length/.test(mainSrc));
}

// ---- Solarized redesign
check('only Light and Dark are offered; older looks are behind a flag', /legacyThemes: process\.env\.FB_LEGACY_THEMES/.test(read('main.js')) && /pickThemes\(\)\.map/.test(read('main.js')) && /theme: 'sol-light'/.test(read('main.js')));
check('Light only for now (Dark ready behind a flag)', /FEATURES\.darkTheme \? \['sol-light', 'sol-dark'\] : \['sol-light'\]/.test(read('main.js')));
check('the tucked tab is a cream card with a blank clipboard that gets scribbled on after a copy (both renderers)', /\.handle \{[^}]*background: #f3ecd7/.test(read('src/pill.css')) && /\.copied \.scribble path \{ animation: scribble/.test(read('src/pill.css')) && /TAB_SCRIBBLE/.test(read('src/pill.js')) && /\.fb-handle \{[^}]*background-color: #f3ecd7/.test(read(ext + '/stylesheet.css')) && /const TAB_FRAMES = /.test(extJs) && /_tabScribble\(true\)/.test(extJs));
check('app marks and glyphs come from icons.js (no hand-drawn paths in the pill)', /icons\.js/.test(pillHtml) && !/ICON_PATH/.test(read('src/pill.js')) && /FBI\.ui|FBI\.dest|window\.FBI/.test(read('src/pill.js')));
check('GNOME extension carries its icons inside extension.js (the installer copies only 3 files)', /const ICON_SVG = /.test(extJs) && !exists(ext + '/brandicons.json'));
check('icons file carries the attribution and non-affiliation note', /not\s*\n?\/\/ affiliated|not affiliated/.test(read('src/icons.js')));
check('settings: fixed-size panes, hidden scrollbar, reorderable apps', /scrollbar-width: none/.test(read('src/app.css')) && /draggable = true/.test(read('src/app.js')) && /pillDestsOrder/.test(read('main.js')));

check('quick mode: a setting, four icons on the tab in both renderers', /tabIcons: false/.test(read('main.js')) && /toggle:tabicons/.test(read('main.js')) && /others\.slice\(0, 4\)/.test(read('main.js')) && /renderStrip/.test(read('src/pill.js')) && /_fillStrip/.test(extJs) && /\.fb-sbtn/.test(read(ext + '/stylesheet.css')));
check('Original: puts the first copy back, from the pill (both renderers)', /kind === 'orig'/.test(read('main.js')) && /history\[0\]/.test(read('src/app.js')) && /s\.original/.test(read('src/pill.js')) && /s\.original/.test(extJs));
check('a click on the pill never auto-tucks it and adds no "Copied for…" line (the row turns into a tick)', !/Copied for/.test(read('main.js')) && /dest: r\.restored \? 'original' : pendingDest, until/.test(read('main.js')) && /sub: '', tone: 'ok', collapse: false/.test(read('main.js')));
check('dropping the pill keeps where the pill landed (its centre), not the pointer (GNOME and window)', /this\._root\.y \+ this\._root\.height \/ 2/.test(extJs) && /pb\.y \+ pb\.height \/ 2/.test(read('main.js')));
check('the closed tab sits hard against the screen edge (no gap)', /this\._handle\.x_align = this\._side === 'l'/.test(extJs) && !/natW = Math\.max\(natW,/.test(extJs) && !/fb-handle:hover \{[^}]*width/.test(read(ext + '/stylesheet.css')));
check('the source card shows the copied-from app\'s own logo (both renderers)', /_destGicon/.test(extJs) && /stile logo/.test(read('src/pill.js')) && /dest: place \? place\.dest/.test(read('main.js')));
{
  const ui = JSON.parse(/const UI_PATH = (\{.*?\});\n/s.exec(extJs)[1]);
  const used = new Set([...read('daemon/core.js').matchAll(/(?:icon|trail): '([a-z_]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !ui[n]);
  check('every icon the settings ask for has a drawing in the helper', missing.length === 0, missing.join());
}
check('the helper ships a loader so updates need no log out', /FB-LOADER/.test(read(ext + '/loader.js')) && /import\('file:\/\//.test(read(ext + '/loader.js')) && /loader\.js/.test(read('bin/morph')));
check('PDF file names never come from the copied text', !/doc\.title/.test(read('daemon/gjs-main.js')) && /Morph ' \+ GLib\.DateTime/.test(read('daemon/gjs-main.js')));
{
  const main = read('daemon/gjs-main.js'), core = read('daemon/core.js');
  const logs = [...(main + core).matchAll(/\b(?:log|warn)\(([^;\n]*)/g)].map((m) => m[1]);
  const leaks = logs.filter((l) => /\.(text|html)\b(?!\.length)|win\.title(?!\.length)|JSON\.stringify\(info\.win/.test(l));
  check('logs never contain what was copied or a window title', leaks.length === 0, leaks.join(' | '));
}
check('release candidate version', /"version": "0\.15\.0-rc\.\d+"/.test(read('package.json')));
check('nothing copied: apps are inert in the spec and both renderers', /idle \? \{ label: OPTION_LABEL\[d\], dest: d, off: true \}/.test(read('main.js')) && /o\.off/.test(read('src/pill.js')) && /o\.off/.test(extJs));
check('the closed tab height follows its icons (last icon never hangs out)', /_fitHandle\(\)/.test(extJs) && /n \* 20/.test(extJs));
check('settings keep their scroll when a switch or an app is toggled (both renderers)', /_keepScroll/.test(extJs) && /paneY\[paneKey\]/.test(read('src/pill.js')));
check('the ✓ takes itself off again shortly after a convert', /tickTimer = setTimeout\(\(\) => \{ tickTimer = null; tick = null; sendPillState\(\); \}, TICK_MS\)/.test(read('main.js')));
check('hover label for the tab icons: opens away from the edge, after a pause, times out, clamped on screen', /_tipArm/.test(extJs) && /GLib\.timeout_add\(GLib\.PRIORITY_DEFAULT, 450/.test(extJs) && /this\._side === 'r' \? ax - tw - GAP/.test(extJs) && /2600/.test(extJs) && /\.fb-tip/.test(read(ext + '/stylesheet.css')));
check('the tab is sized from pinned icon sizes (never measured)', /icon-size: 14px/.test(extJs) && !/_tabBox\.get_preferred_height/.test(extJs));
check('Small caps the list and scrolls (both renderers)', /'fb-size-s': 250/.test(extJs) && /s: 250, m: 330, l: 420/.test(read('src/pill.js')));
check('every copy gets its scribble (a counter, not just a changed description) in both renderers', /copySeq\+\+/.test(read('main.js')) && /copyId: copy \? copySeq : 0/.test(read('main.js')) && /s\.copyId/.test(extJs) && /s\.copyId/.test(read('src/pill.js')));
check('the clipboard on the tab has a hover label ("All apps")', /_tipWire\(this\._tabHit, 'All apps'\)/.test(extJs));
check('the main list keeps its scroll too (both renderers, restored before first paint)', /_scrollPane = 'main'/.test(extJs) && /_restoreScroll\(/.test(extJs) && /notify::upper/.test(extJs) && /mainY/.test(read('src/pill.js')));
check('an open panel keeps its top edge (no re-centring jump) and opening does no second rebuild', /_openTop/.test(extJs) && !/kind === 'opened'/.test(read('main.js')) );
check('quick rebuilds in a row keep the scroll; clipboard write check no longer blocks the click', /_restoreUntil/.test(extJs) && /verifyWrite\(html, text\)\.catch/.test(read('main.js')));
check('every ✓ lasts exactly the same time (a stored deadline, not a one-shot flash)', /const TICK_MS = 1500/.test(read('main.js')) && /tickDest = tick && Date\.now\(\) < tick\.until/.test(read('main.js')) && !/flash && flash\.doneDest/.test(read('main.js')));
check('our own conversion is never mistaken for a new copy (text compared loosely, or just written)', /const ours = sameText \|\| justWrote/.test(read('main.js')));
check('saving a PDF adds no line to the pill: the row ticks like the others and a notification says where it went', /tick = \{ dest: 'pdf'/.test(read('main.js')) && !/pdf: true \}; sendPillState/.test(read('main.js')));
check('an image-only clipboard clears the pill (rows go idle) instead of leaving the last copy offered', /Nothing to convert: the clipboard holds an image/.test(read('src/app.js')));
check('an image-only clipboard shows an Image copied card (and PDF is off too)', /title: 'Image copied'/.test(read('main.js')) && /label: 'PDF ↓', action: 'pdf:', off: true/.test(read('main.js')) && /"image":/.test(read('src/icons.js')) && /"image":/.test(extJs));
check('the installer needs no Node or Electron: it uses GNOME\'s own gjs, and removes the old Electron app', !/npm|node_modules\/\.bin|electron@/.test(read('bin/morph').replace(/node_modules\/electron/g, '')) && /gjs -m/.test(read('bin/morph')) && /retire_old/.test(read('bin/morph')));
check('--start reports a crash instead of claiming success, --uninstall removes everything it added', /It stopped right away/.test(read('bin/morph')) && /do_uninstall/.test(read('bin/morph')) && /autostart/.test(read('bin/morph')));
check('the GNOME program has no top-level await (one that never finishes would stop it starting)', !/^\s{0,0}(const \w+ = )?await /m.test(read('daemon/gjs-main.js')) && !/^\}?\)?;?\s*(try \{ )?.*= \(await import/m.test(read('daemon/gjs-main.js')));
// The background program loads the same converter files the tests do, in the same order.
{
  const idx = [...read('src/index.html').matchAll(/<script src="core\/([^"]+)\.js"><\/script>/g)].map((m) => m[1]);
  const loaded = (read('daemon/gjs-main.js').match(/const CORE = \[([^\]]*)\]/) || ['', ''])[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  check('the background program loads the converter files in the page order', JSON.stringify(idx) === JSON.stringify(loaded), idx.join() + ' vs ' + loaded.join());
}
check('the top-bar tray icon is optional (off by default on Linux) with a toggle in General', /trayIcon: process\.platform === 'darwin'/.test(read('main.js')) && /toggle:tray/.test(read('main.js')) && /if \(tray \|\| !settings\.trayIcon\) return/.test(read('main.js')));
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (static)');
process.exit(failed ? 1 : 0);
