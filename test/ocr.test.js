// Optional table OCR: the worker's result parsing, the install commands, and how Morph uses it (only on a click).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const { createCore } = require('../daemon/core');
let passed = 0; let failed = 0;
function check(n, c, d) { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')); } }
const root = path.join(__dirname, '..');

// The worker, without PaddleOCR.
const py = spawnSync('python3', ['-I', path.join(root, 'ocr', 'morph_ocr.py'), '--selftest'], { encoding: 'utf8' });
check('OCR worker result parsing works', py.status === 0 && /"ok": true/.test(py.stdout), py.stdout + py.stderr);
const usage = spawnSync('python3', ['-I', path.join(root, 'ocr', 'morph_ocr.py'), '/no/such/file.png'], { encoding: 'utf8' });
check('OCR worker answers with one JSON line even when it cannot read', usage.status === 0 && usage.stdout.trim().split('\n').length === 1 && JSON.parse(usage.stdout).ok === false);

// The install commands.
const bin = fs.readFileSync(path.join(root, 'bin', 'morph'), 'utf8');
check('morph has --enable-ocr and --disable-ocr', /--enable-ocr\)\s+do_enable_ocr/.test(bin) && /--disable-ocr\)\s+do_disable_ocr/.test(bin));
check('OCR lives outside the app folder so updates keep it', /OCR_DIR="\$\{XDG_DATA_HOME:-\$HOME\/\.local\/share\}\/morph-ocr"/.test(bin));
check('a failed OCR install leaves nothing behind', /install failed[\s\S]*rm -rf "\$OCR_DIR"/.test(bin));
check('the zip ships the worker', /ocr\/morph_ocr\.py/.test(fs.readFileSync(path.join(root, 'tools', 'build-linux-zip.sh'), 'utf8')));

// How Morph uses it.
const TABLE = '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Bolt</td><td>12</td></tr></table>';
function desk(opts) {
  const d = { ocrRuns: 0, writes: [], pills: [], saved: JSON.stringify({ setupDone: true }) };
  d.io = {
    version: '0.15.0', home: '/h', log() {}, store: { read: () => d.saved, write: (s) => { d.saved = s; } },
    shell: {
      setPill: (s) => d.pills.push(JSON.parse(JSON.stringify(s))),
      readClip: async () => (d.clipIsOurs ? { formats: ['text/html'], text: '', html: d.writes[d.writes.length - 1].data } : { formats: ['image/png'], text: '', html: '' }),
      writeClip: async (mime, data) => { d.writes.push({ mime, data }); return true; }, paste() {}, setShortcuts: async () => [],
    },
    notify() {}, savePdf: async () => ({ ok: false }), openPath() {}, openUri() {}, showInFolder() {},
    now: () => 1e12, setTimeout: () => ({}), clearTimeout() {}, update: { check: async () => null, run: async () => false },
    ocr: opts.ocr === false ? undefined : { ready: () => opts.ready !== false, run: async () => { d.ocrRuns++; return opts.result || { ok: true, html: TABLE }; } },
  };
  d.last = () => d.pills[d.pills.length - 1];
  return d;
}
(async () => {
  {
    const d = desk({}); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    check('an image copy does not run OCR by itself', d.ocrRuns === 0);
    c.action('paste:jira');
    await new Promise((r) => setTimeout(r, 30));
    check('picking an app reads the table (once)', d.ocrRuns === 1 && d.writes.length >= 1 && /Bolt/.test(d.writes[d.writes.length - 1].data));
    check('the result says to check the numbers', /check the numbers/i.test(JSON.stringify(d.last())));
  }
  {
    const d = desk({ result: { ok: false, error: 'no_table' } }); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('paste:jira');
    await new Promise((r) => setTimeout(r, 30));
    check('no table found: nothing is written and the user is told', d.writes.length === 0 && /No table found/.test(JSON.stringify(d.last())));
  }
  {
    const d = desk({ ready: false }); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('paste:jira');
    await new Promise((r) => setTimeout(r, 30));
    check('OCR not installed: no OCR run, nothing written', d.ocrRuns === 0 && d.writes.length === 0);
  }
  {
    const d = desk({}); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 14);
    c.action('paste:jira');
    await new Promise((r) => setTimeout(r, 30));
    check('an older helper (no image access): OCR is not attempted', d.ocrRuns === 0);
  }
  {
    // Settings button: enable with progress, remove, cancel, failure.
    let state = { ready: false, installing: null };
    const d = desk({});
    d.io.ocr = {
      ready: () => state.ready,
      install: (onLine, onDone) => { state.starts = (state.starts || 0) + 1; state.installing = { onLine, onDone }; },
      cancel: () => { state.cancelled = true; state.installing.onDone(false); },
      remove: async () => { state.ready = false; return true; },
    };
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('view:settings'); c.action('view:ocr');
    const blocks = () => JSON.stringify(d.last().pane.blocks);
    check('off: the pane offers an Enable table OCR button', /Enable table OCR/.test(blocks()) && /ocr:ask/.test(blocks()) && !/confirm/.test(blocks()));
    c.action('ocr:ask');
    check('asking happens inside the pill: 1 GB, Install or Not now', /Download about 1 GB/.test(blocks()) && /"Install"/.test(blocks()) && /Not now/.test(blocks()) && /ocr:on/.test(blocks()));
    c.action('ocr:no');
    check('Not now goes back, nothing installed', /Enable table OCR/.test(blocks()) && !state.starts);
    c.action('ocr:ask'); c.action('ocr:on');
    check('installing: progress is shown, with Stop installing', /Installing table OCR/.test(blocks()) && /Stop installing/.test(blocks()) && /ocr:askstop/.test(blocks()) && !/Enable table OCR/.test(blocks()));
    c.action('ocr:askstop');
    check('Stop installing asks first, in the pill', /Stop installing\?/.test(blocks()) && /Keep installing/.test(blocks()));
    c.action('ocr:no');
    check('Keep installing goes back to the progress', /Installing table OCR/.test(blocks()) && !state.cancelled);
    state.installing.onLine('Step 3 of 5: Installing PaddlePaddle, the biggest part (a few minutes)...');
    check('the progress bar follows the installer steps', /"progress":0\.12/.test(blocks()) && /step 3 of 5/.test(blocks()) && /Installing PaddlePaddle/.test(blocks()) && !/Step 3 of 5:/.test(blocks()));
    check('the installer prints the five steps', (require('fs').readFileSync(require('path').join(__dirname, '..', 'bin', 'morph'), 'utf8').match(/say "Step \d of 5:/g) || []).length === 5);
    state.installing.onLine('Installing PaddleOCR (this takes a few minutes)...');
    check('the latest progress line is shown', /Installing PaddleOCR/.test(blocks()));
    c.action('ocr:on');
    check('a second click does not start a second install', state.starts === 1);
    state.ready = true; state.installing.onDone(true);
    check('done: Table OCR is on, with Remove', /Table OCR is on/.test(blocks()) && /Remove table OCR/.test(blocks()));
    c.action('ocr:off');
    await new Promise((r) => setTimeout(r, 10));
    check('remove: back to off', /Enable table OCR/.test(blocks()) && state.ready === false);
    c.action('ocr:on'); state.installing.onLine('Needs python3-venv. On Ubuntu:  sudo apt install python3-venv'); state.installing.onDone(false);
    check('failure: the reason is shown with Try again', /python3-venv/.test(blocks()) && /Try again/.test(blocks()));
    c.action('ocr:on'); c.action('ocr:cancel');
    check('cancel: stops the install and says nothing was kept', state.cancelled === true && /Cancelled/.test(blocks()));
  }
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (ocr)');
  process.exit(failed ? 1 : 0);
})();
