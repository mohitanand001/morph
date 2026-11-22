// The Linux download on its own: build it, unpack it into an empty folder, and run the converter and
// the background program's logic from there, so nothing depends on files that aren't in the zip.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
let passed = 0; let failed = 0;
function check(n, c, d) { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')); } }
try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (e) { console.log('ok skipped (zip tools missing)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-zip-'));
const out = execFileSync('bash', [path.join(__dirname, '..', 'tools', 'build-linux-zip.sh'), tmp], { encoding: 'utf8' }).trim();
const dest = path.join(tmp, 'x');
fs.mkdirSync(dest);
execFileSync('unzip', ['-q', out, '-d', dest]);
const app = path.join(dest, 'morph');
check('zip is small', fs.statSync(out).size < 400 * 1024, fs.statSync(out).size + ' bytes');
check('zip has the installer, program, converter and GNOME helper', ['bin/morph', 'daemon/gjs-main.js', 'daemon/core.js', 'daemon/pdf.js', 'src/core/engine.js', 'gnome-extension/morph-focus@morph.dev/extension.js', 'README.txt'].every((f) => fs.existsSync(path.join(app, f))));
check('installer is executable', (fs.statSync(path.join(app, 'bin/morph')).mode & 0o111) !== 0);
check('no Electron, no node_modules, no app window files', !fs.existsSync(path.join(app, 'node_modules')) && !fs.existsSync(path.join(app, 'main.js')) && !fs.existsSync(path.join(app, 'src/app.js')));

// Run it the way gjs-main does: the converter list, then core.js, from the unpacked folder only.
const list = (fs.readFileSync(path.join(app, 'daemon/gjs-main.js'), 'utf8').match(/const CORE = \[([^\]]*)\]/)[1]).split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
global.window = global;
list.forEach((f) => { const p = path.join(app, 'src/core', f + '.js'); check('file present: ' + f, fs.existsSync(p)); require(p); });
const { createCore } = require(path.join(app, 'daemon/core.js'));
const { pdfItems } = require(path.join(app, 'daemon/pdf-doc.js'));
const writes = []; const pills = [];
const core = createCore({
  version: '0', home: '/h', store: { read: () => '{"autoFormat":false}', write() {} },
  shell: { setPill: (s) => pills.push(s), readClip: async () => ({ formats: ['text/plain'], secret: false, text: '# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |', html: '' }), writeClip: async (m, d) => { writes.push([m, d]); return true; }, paste() {}, setShortcuts: async () => [] },
  notify() {}, savePdf: async () => ({ ok: true, name: 'a.pdf', path: '/h/a.pdf' }), openPath() {}, openUri() {}, showInFolder() {},
  now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout,
});
(async () => {
  await core.start();
  core.focus({ app: 'slack', title: 'x - Slack' }, 11);
  core.action('fix:jira');
  await new Promise((r) => setTimeout(r, 50));
  check('a conversion works from the unpacked zip', writes.length === 1 && /<table/.test(writes[0][1]), JSON.stringify(writes));
  check('PDF page items work from the unpacked zip', pdfItems(core.state.original ? FB.engine.run(core.state.original, 'email').ast : { children: [] }).some((i) => i.kind === 'table'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (zip)');
  process.exit(failed ? 1 : 0);
})();
