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

// The worker, without RapidOCR.
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
    {
      const sp = d.last();
      check('an image copy with OCR on: the apps can be picked, and the card says so', sp.source.title === 'Image copied' && /Pick an app to read its table/.test(sp.source.sub) && JSON.stringify(sp.options).includes('"action":"fix:jira"'), JSON.stringify(sp.source));
    }
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
    const d = desk({ result: { ok: false, error: 'failed' } }); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('fix:jira');
    await new Promise((r) => setTimeout(r, 30));
    const src = d.last().source || {};
    check('a failed read: the card says "Image copied" and why, not "Copied from Image copied"', src.title === 'Image copied' && /Couldn’t read that image/.test(JSON.stringify(d.last())) && !/Copied from Image/.test(JSON.stringify(d.last())), JSON.stringify(src));
    c.action('fix:slack');
    await new Promise((r) => setTimeout(r, 30));
    check('picking another app does not read the same image again', d.ocrRuns === 1);
  }
  {
    const d = desk({}); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('fix:jira');
    await new Promise((r) => setTimeout(r, 30));
    c.action('fix:confluence');
    await new Promise((r) => setTimeout(r, 30));
    check('a table read once is reused for the next app', d.ocrRuns === 1 && d.writes.length === 2);
  }
  {
    const d = desk({}); const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('fix:jira'); c.action('fix:confluence'); // the second click arrives while the first read runs
    await new Promise((r) => setTimeout(r, 30));
    check('two quick clicks share one read (no second read of the same image)', d.ocrRuns === 1);
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
    check('asking happens inside Morph: about 400 MB, Install or Not now', /Download about 400 MB/.test(blocks()) && /RapidOCR/.test(blocks()) && /"Install"/.test(blocks()) && /Not now/.test(blocks()) && /ocr:on/.test(blocks()));
    c.action('ocr:no');
    check('Not now goes back, nothing installed', /Enable table OCR/.test(blocks()) && !state.starts);
    c.action('ocr:ask'); c.action('ocr:on');
    check('installing: progress is shown, with Stop installing', /Installing table OCR/.test(blocks()) && /Stop installing/.test(blocks()) && /ocr:askstop/.test(blocks()) && !/Enable table OCR/.test(blocks()));
    c.action('ocr:askstop');
    check('Stop installing asks first, in the pill', /Stop installing\?/.test(blocks()) && /Keep installing/.test(blocks()));
    c.action('ocr:no');
    check('Keep installing goes back to the progress', /Installing table OCR/.test(blocks()) && !state.cancelled);
    state.installing.onLine('Step 3 of 4: Installing RapidOCR...');
    check('the progress bar follows the installer steps', /"progress":0\.15/.test(blocks()) && /step 3 of 4/.test(blocks()) && /Installing RapidOCR/.test(blocks()) && !/Step 3 of 4:/.test(blocks()));
    {
      const fs2 = require('fs'), path2 = require('path');
      const sh = fs2.readFileSync(path2.join(__dirname, '..', 'bin', 'morph'), 'utf8');
      const gj = fs2.readFileSync(path2.join(__dirname, '..', 'daemon', 'gjs-main.js'), 'utf8');
      check('OCR is installed into its own Python environment, never the system or user one', /python3 -m venv "\$OCR_DIR\/venv"/.test(sh) && !/--system-site-packages/.test(sh) && !/pip install --user/.test(sh) && /--no-cache-dir/.test(sh));
      check('OCR runs (warm-up and reads) keep any caches inside the OCR folder', /HOME="\$OCR_DIR\/home" PYTHONNOUSERSITE=1/.test(sh) && /ocr_run "\$OCR_DIR\/venv\/bin\/python"/.test(sh) && /setenv\('HOME', ocrHome/.test(gj) && /setenv\('PYTHONNOUSERSITE'/.test(gj));
      check('the installer uses RapidOCR (small), replaces an older PaddleOCR install, and marks the engine', /rapidocr>=2,<4/.test(sh) && /rapidocr_onnxruntime/.test(sh) && !/paddlepaddle/.test(sh) && /Removed the older, larger table OCR/.test(sh) && /printf 'rapidocr' > "\$OCR_DIR\/engine"/.test(sh));
      check('uninstall and Remove delete only Morph\'s OCR folder and log', /rm -rf "\$CACHE\/formatter-icons" "\$OCR_DIR"/.test(sh) && /morph-ocr\.log/.test(sh) && /\*\/morph-ocr\) rm -rf "\$OCR_DIR"/.test(sh) && !/paddlex/.test(sh.replace(/~\/\.paddlex/g, '')));
    }
    check('the installer prints the four steps', (require('fs').readFileSync(require('path').join(__dirname, '..', 'bin', 'morph'), 'utf8').match(/say "Step \d of 4:/g) || []).length === 4);
    state.installing.onLine('Step 4 of 4: Getting the text models ready (one time)...');
    check('the latest progress line is shown', /Getting the text models ready/.test(blocks()));
    c.action('ocr:on');
    check('a second click does not start a second install', state.starts === 1);
    state.ready = true; state.installing.onDone(true);
    c.action('view:uninstall');
    {
      const u = JSON.stringify(d.last().pane.blocks);
      check('Uninstall lists the table OCR files with the rest, and says your own OCR package stays', /Table OCR: RapidOCR and its models in Morph's own folder/.test(u) && /OCR package you installed yourself, outside Morph, is not touched/.test(u), u.slice(0, 300));
    }
    c.action('view:ocr');
    check('done: Table OCR is on, with Remove', /Table OCR is on/.test(blocks()) && /Remove table OCR/.test(blocks()));
    c.action('ocr:off');
    await new Promise((r) => setTimeout(r, 10));
    check('remove: back to off', /Enable table OCR/.test(blocks()) && state.ready === false);
    c.action('ocr:on'); state.installing.onLine('Needs python3-venv. On Ubuntu:  sudo apt install python3-venv'); state.installing.onDone(false);
    check('failure: the reason is shown with Try again', /python3-venv/.test(blocks()) && /Try again/.test(blocks()));
    c.action('ocr:on'); c.action('ocr:cancel');
    check('cancel: stops the install and says nothing was kept', state.cancelled === true && /Cancelled/.test(blocks()));
  }
  {
    // An older PaddleOCR install: Settings offers to replace it with the small one.
    const d = desk({});
    d.io.ocr = { ready: () => false, legacy: () => true, run: async () => ({ ok: false }), install: () => {}, remove: async () => true, cancel: () => {} };
    const c = createCore(d.io);
    await c.start();
    c.focus({ app: 'slack', title: 'x - Slack' }, 15);
    c.action('view:ocr');
    const b = () => JSON.stringify(d.last().pane.blocks);
    check('an older, larger install is offered an update to the small one', /Table OCR got much smaller/.test(b()) && /Update table OCR/.test(b()));
    c.action('ocr:ask');
    check('…and the question says the old one is removed first', /about 3 GB\) is removed first/.test(b()));
  }
  {
    // Real RapidOCR output for a salary-sheet screenshot (title, logo, a 5-column grid): the table comes out exactly.
    const words = require('./ocr/salary-sheet-words.json');
    const py = 'import json,sys\nsys.path.insert(0, sys.argv[1])\nimport morph_ocr as m\nw=json.load(open(sys.argv[2]))\nprint(json.dumps(m.grid_from_words([x[0] for x in w],[x[1:] for x in w])))';
    const r = require('child_process').spawnSync('python3', ['-I', '-c', py, require('path').join(__dirname, '..', 'ocr'), require('path').join(__dirname, 'ocr', 'salary-sheet-words.json')], { encoding: 'utf8' });
    const grid = JSON.parse(r.stdout || 'null');
    check('a real screenshot: five clean columns, title and logo left out', !!grid && grid.length === 8 && grid[0].join('|') === 'Employee Name|Basic|Allowances|Deductions|Net Salary' && grid[6].join('|') === 'Sarah Davis|4.200|900|100|5.000' && words.length > 40, r.stderr || JSON.stringify(grid));
  }
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (ocr)');
  process.exit(failed ? 1 : 0);
})();
