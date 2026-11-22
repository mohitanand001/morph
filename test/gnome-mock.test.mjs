// Loads the GNOME extension with GNOME's own libraries replaced by stand-ins and feeds it every kind of
// spec. It can't tell whether things LOOK right (only a real GNOME can), but it catches the code
// errors that would leave the pill half-built: a typo, an undefined variable, a missing field.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extFile = path.join(here, '..', 'gnome-extension', 'morph-focus@morph.dev', 'extension.js');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra || ''); } };

const mk = (name) => {
  const store = new Map();
  return new Proxy(function () {}, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 100;
      if (p === Symbol.iterator) return function* () { yield 100; yield 100; yield 100; yield 100; };
      if (p === 'then' || typeof p === 'symbol') return undefined;
      if (store.has(p)) return store.get(p);
      const c = mk(name + '.' + String(p)); store.set(p, c); return c;
    },
    set(t, p, v) { store.set(p, v); return true; },
    apply() { return mk(name + '()'); },
    construct() { return mk('new ' + name); },
  });
};
globalThis.mk = mk;
globalThis.global = mk('global');
globalThis.log = () => {};
globalThis.logError = () => {};
const GLib = mk('GLib');
const timers = [];
GLib.timeout_add = (_p, ms, fn) => { timers.push(fn); return timers.length; };
GLib.timeout_add_seconds = (_p, s, fn) => { timers.push(fn); return timers.length; };
GLib.idle_add = (_p, fn) => { timers.push(fn); return timers.length; };
GLib.source_remove = () => true;
GLib.base64_decode = (s) => Buffer.from(s, 'base64');
GLib.build_filenamev = (a) => a.join('/');
GLib.get_user_cache_dir = () => path.join(os.tmpdir(), 'fb-mock-cache');
GLib.mkdir_with_parents = (d) => fs.mkdirSync(d, { recursive: true });
GLib.file_set_contents = (p, c) => fs.writeFileSync(p, c);
globalThis.GLib = GLib;

const tmp = path.join(os.tmpdir(), 'fb-ext-' + process.pid + '.mjs');
fs.writeFileSync(tmp, fs.readFileSync(extFile, 'utf8')
  .replace(/^import (\w+) from 'gi:\/\/(\w+)';/mg, (m, a, b) => `const ${a} = ${b === 'GLib' ? 'globalThis.GLib' : "globalThis.mk('" + b + "')"};`)
  .replace(/^import \* as Main from .*$/m, "const Main = globalThis.mk('Main');")
  .replace(/^import \* as ModalDialog from .*$/m, "const ModalDialog = globalThis.mk('ModalDialog');")
  .replace(/^import \{ Slider \} from .*$/m, "const Slider = globalThis.mk('Slider');")
  .replace(/^import \{ Extension \} from .*$/m, 'class Extension { constructor(){} }'));
const E = (await import(tmp)).default;
fs.unlinkSync(tmp);

const e = new E({});
Object.assign(e, { _spec: { visible: false }, _open: false, _yFrac: 0.42, _side: 'r', _mon: -1, _press: null, _buttons: [], _busy: null, _theme: '', _size: '', _lastState: '', _keys: new Map() });
e._buildPill();
const send = (o, label) => {
  try { e.SetPill(Buffer.from(JSON.stringify(o)).toString('base64')); check(label, true); }
  catch (x) { check(label, false, String(x && x.stack || x).split('\n').slice(0, 3).join(' | ')); }
};

const base = { visible: true, theme: 'sol-light', size: 'm', side: 'r', dot: 'none', title: 'Morph', section: 'Copy it for', view: 'main', gear: 'view:settings',
  source: { icon: 'content_paste', title: 'Nothing copied yet', sub: '' }, options: [[{ label: 'Jira', dest: 'jira', action: 'fix:jira' }, { label: 'Email', dest: 'email', action: 'fix:email' }]], links: [], tab: [], original: null };
const copied = { dot: 'has', source: { icon: 'table', dest: 'slack', title: 'Copied from Slack', sub: '#x · Table' }, original: { label: 'Original', hint: 'as copied', action: 'orig:', busy: 'Restoring…' } };
const tab = [{ label: 'Slack', dest: 'slack', action: 'fix:slack' }, { label: 'Jira', dest: 'jira', action: 'fix:jira' }, { label: 'MD', dest: 'markdown', action: 'fix:markdown' }, { label: 'Email', dest: 'email', action: 'fix:email' }];
const off = tab.map((t) => ({ label: t.label, dest: t.dest, off: true }));
const run = () => { for (const f of timers.splice(0)) { try { f(); } catch (x) { check('timer', false, String(x)); } } };

for (const size of ['s', 'm', 'l']) {
  send({ ...base, size }, 'main, nothing copied (' + size + ')'); run();
  send({ ...base, size, ...copied }, 'main, copied (' + size + ')'); run();
  send({ ...base, size, ...copied, tab }, 'closed tab with four icons (' + size + ')'); run();
  send({ ...base, size, tab: off, options: [[{ label: 'Slack', dest: 'slack', off: true }]] }, 'nothing copied: dimmed apps (' + size + ')'); run();
}
send({ ...base, ...copied, tab, options: [[{ label: 'Slack', dest: 'slack', done: true }, { label: 'Jira', dest: 'jira', action: 'fix:jira' }]], original: { label: 'Original', done: true } }, 'done ticks'); run();
// hover label: arm, show, hide, with timers run, on both sides, and no exception
for (const side of ['r', 'l']) {
  e._side = side;
  const a = mk('actor'); a.hover = true;
  try { e._tipArm(a, 'Copy for Slack'); run(); e._tipShowNow(a, 'Copy for Slack'); run(); e._tipHide(); check('tooltip (' + side + ')', true); }
  catch (x) { check('tooltip (' + side + ')', false, String(x && x.stack || x).split('\n').slice(0, 2).join(' | ')); }
}
e._side = 'r';
e._open = true;
send({ ...base, ...copied, sub: 'x', subTone: 'warn' }, 'open panel with a message'); run();
const nav = [{ icon: 'settings', label: 'General', action: 'settings:', on: true }, { icon: 'edit', label: 'Apps', action: 'settings:edit' }];
for (const pane of [
  { title: 'General', opts: [{ icon: 'bolt', label: 'Auto', sub: 's', sw: 'on', action: 'toggle:auto' }] },
  { title: 'General', opts: [{ icon: 'bolt', label: 'Auto', sw: 'on', action: 'toggle:auto' }], actions: [{ icon: 'refresh', label: 'Check for updates', sub: 'x', action: 'checkupdate:' }, { icon: 'delete', label: 'Uninstall Morph', sub: 'x', action: 'uninstall:', confirm: { title: 'Uninstall?', body: 'b', ok: 'Uninstall' } }] },
  { title: 'Updates', blocks: [{ kind: 'status', tone: 'ok', icon: 'check_circle', title: 'You are up to date', text: 't', items: ['Installed version: 1', 'Last checked: Today'], button: { label: 'Check for updates', action: 'checkupdate:', kind: 'secondary' } }, { kind: 'status', tone: 'warn', icon: 'error', title: 'x', button: { label: 'Retry', action: 'checkupdate:', kind: 'primary', disabled: true } }], opts: [{ icon: 'schedule', label: 'Auto', sw: 'on', action: 'toggle:updates' }] },
  { title: 'Uninstall Morph', blocks: [{ kind: 'text', text: 'hi' }, { kind: 'panel', tone: 'plain', title: 'What', items: ['a', 'b'] }, { kind: 'panel', tone: 'warn', icon: 'warning', title: 'w', text: 't' }, { kind: 'buttons', buttons: [{ label: 'Keep', action: 'view:settings', kind: 'secondary' }, { label: 'Uninstall Morph', action: 'uninstall:', kind: 'danger', confirm: { title: 'U?', body: 'b', ok: 'Uninstall' } }] }] },
  { title: 'Apps', lede: 'Drag', apps: [{ label: 'Slack', dest: 'slack', sw: 'on', action: 'dest:slack' }, { label: 'Jira', dest: 'jira', sw: 'off', action: 'dest:jira' }] },
  { title: 'Shortcuts', keys: [{ icon: 'keyboard', label: 'Paste', keys: ['Ctrl', 'Alt', 'V'], sw: 'off', action: 'key:0' }] },
  { title: 'Size', cards: [{ label: 'Small', action: 'size:s', on: false }, { label: 'Medium', action: 'size:m', on: true }] },
  { title: 'About', about: { name: 'Morph', version: 'Version 0.15.0-rc.1', text: 't', legal: 'l' } },
]) { send({ ...base, view: 'settings', nav, pane }, 'settings: ' + pane.title); run(); }
// the confirm dialog builds without throwing
try { e._confirm({ action: 'uninstall:', confirm: { title: 'Uninstall?', body: 'b', ok: 'Uninstall' } }); check('confirm dialog builds', true); } catch (x) { check('confirm dialog builds', false, String(x)); }
// the same Apps pane again (a switch was flipped): rebuilt, scroll remembered
send({ ...base, view: 'settings', nav, pane: { title: 'Apps', lede: 'Drag', apps: [{ label: 'Slack', dest: 'slack', sw: 'off', action: 'dest:slack' }] } }, 'settings: Apps rebuilt'); run();
send({ ...base, view: 'main' }, 'back to main'); run();

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed (gnome-mock)');
process.exit(fail ? 1 : 0);
