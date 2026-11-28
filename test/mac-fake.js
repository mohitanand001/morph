// A pretend Mac for the Mac app's JavaScript: a pasteboard with a change counter, the app in front, a clock, files.
// The bundle runs in a bare context, like JavaScriptCore: only what the language itself has.
'use strict';
const vm = require('vm');
const { bundle } = require('../tools/build-mac');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const SRC = bundle();
const WORDS = require('./ocr/salary-sheet-words.json');

// A pretend Mac: a pasteboard with a change counter, the app in front, a clock, files.
function mac(opts = {}) {
  const m = {
    t: Date.parse('2026-11-28T10:20:30'), timers: new Map(), files: Object.assign({}, opts.files || {}), panels: [], writes: [], pastes: 0, reads: 0, typeReads: 0,
    pdfs: [], opened: [], hotkeys: null, logs: [], updates: [],
    pb: { count: 1, types: ['public.utf8-plain-text'], text: 'before Morph started', html: '' },
    front: { app: 'com.apple.TextEdit', name: 'TextEdit', title: 'notes.txt' },
    http: opts.http || ((url, cb) => cb(200, JSON.stringify({ version: '0.15.0-rc.18' }))),
  };
  m.copy = (app, content, extraTypes) => {
    if (app) m.front = app;
    m.pb.count++;
    m.pb.text = content.text || '';
    m.pb.html = content.html || '';
    m.pb.types = [].concat(content.html ? ['public.html'] : [], content.text ? ['public.utf8-plain-text'] : [], content.image ? ['public.png'] : [], extraTypes || []);
  };
  m.focus = (app) => { m.front = app; };
  m.advance = async (ms) => {
    const end = m.t + ms;
    await flush();
    for (;;) {
      let due = null;
      for (const [id, x] of m.timers) if (x <= end && (!due || x < due[1])) due = [id, x];
      if (!due) break;
      m.timers.delete(due[0]);
      m.t = due[1];
      m.ctx.__morphTimer(due[0]);
      await flush();
    }
    m.t = end;
    await flush();
  };
  m.native = {
    version: '0.15.0-rc.19', home: '/Users/t', supportDir: '/Users/t/Library/Application Support/Morph', downloadsDir: '/Users/t/Downloads',
    debug: true, canOcr: true,
    now: () => m.t,
    log: (s) => m.logs.push(String(s)),
    setTimer: (id, ms) => { m.timers.set(id, m.t + ms); },
    clearTimer: (id) => { m.timers.delete(id); },
    readFile: (p) => (Object.prototype.hasOwnProperty.call(m.files, p) ? m.files[p] : null),
    writeFile: (p, s) => { m.files[p] = String(s); return true; },
    exists: (p) => Object.prototype.hasOwnProperty.call(m.files, p),
    changeCount: () => m.pb.count,
    clipTypes: () => { m.typeReads++; return JSON.stringify(m.pb.types); },
    readClip: () => { m.reads++; return JSON.stringify({ types: m.pb.types, text: m.pb.text, html: m.pb.html }); },
    writeClip: (html, text) => { m.writes.push({ html, text }); m.pb.count++; m.pb.html = html; m.pb.text = text; m.pb.types = [].concat(html ? ['public.html'] : [], text ? ['public.utf8-plain-text'] : [], ['dev.morph.own']); return true; },
    paste: () => { m.pastes++; return true; },
    axTrusted: () => m.ax !== false,
    pasteAccess: () => m.access || 'allow',
    openSettings: (w) => m.opened.push('settings ' + w),
    setHotkeys: (j) => { m.hotkeys = JSON.parse(j); return '[]'; },
    frontApp: () => JSON.stringify(m.front),
    setPanel: (j) => { m.panels.push(JSON.parse(j)); },
    savePdf: (html, p, cb) => { m.pdfs.push({ html, path: p }); m.files[p] = '%PDF'; cb(true); },
    openUrl: (u) => m.opened.push(u), openPath: (p) => m.opened.push(p), reveal: (p) => m.opened.push('reveal ' + p),
    httpGet: (url, cb) => m.http(url, cb),
    update: (v, cb) => { m.updates.push(v); cb(false); },
    ocr: (cb) => cb(JSON.stringify({ texts: WORDS.map((w) => w[0]), boxes: WORDS.map((w) => w.slice(1)) })),
    uninstall: () => true,
  };
  // A bare context, like JavaScriptCore: only what the language itself has.
  m.ctx = vm.createContext({ native: m.native });
  vm.runInContext(SRC, m.ctx, { filename: 'morph.js' });
  m.panel = () => m.panels[m.panels.length - 1];
  m.start = async () => { m.core = await vm.runInContext('startMorphMac(native, { pollMs: 300, frontMs: 700 })', m.ctx); await flush(); };
  return m;
}
const SLACK = { app: 'com.tinyspeck.slackmacgap', name: 'Slack', title: 'general - Acme - Slack' };
const CHROME_GPT = { app: 'com.google.Chrome', name: 'Google Chrome', title: 'ChatGPT' };
const ONEPW = { app: 'com.1password.1password', name: '1Password', title: '1Password' };
const JIRA = { app: 'com.google.Chrome', name: 'Google Chrome', title: '[ABC-12] Login fails - Jira' };
const MD = { text: '## Results\n\n| Name | Score |\n|---|---|\n| Ana | 9 |\n| Bo | 7 |\n\n- **bold** point\n- second' };


module.exports = { mac, flush, SRC, SLACK, CHROME_GPT, ONEPW, JIRA, MD };
