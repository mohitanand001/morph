// The website demo: every sample is detected as the app it claims to come from, converts for every
// destination, the page builds into one self-contained file, and nothing personal ships in it.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
global.window = global;
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '  ' + d : '')); } };
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
require('../src/icons.js');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(root, 'src', m[1])));
const samples = require('../demo/samples.js')();
const DESTS = Object.keys(FB.engine.NAMES);

check('there are samples, with unique ids', samples.length >= 15 && new Set(samples.map((s) => s.id)).size === samples.length);
check('each sample has a group and a "look for" line', samples.every((s) => s.group && s.look && s.look.length > 20));
check('samples are kept together by group', samples.every((s, i) => i === 0 || s.group === samples[i - 1].group || !samples.slice(0, i - 1).some((x) => x.group === s.group)));
samples.forEach((s) => {
  const r = FB.engine.run({ html: s.html, text: s.text }, null);
  check(s.id + ': detected as ' + s.source, r.source === s.source && r.has, r.source);
  check(s.id + ': suggested destinations exist', s.best.length >= 1 && s.best.every((d) => DESTS.includes(d)));
  DESTS.forEach((d) => {
    const o = FB.engine.run({ html: s.html, text: s.text }, d).out;
    check(s.id + ' -> ' + d + ' is not empty', !!o && !!(o.text || o.html));
  });
});
// The page is public: no real names, hosts, files or workspaces from a developer's machine.
const everything = JSON.stringify(samples);
['/home/', 'gmail.com'].forEach((w) => check('samples carry no "' + w + '"', !everything.toLowerCase().includes(w)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-demo-'));
const out = path.join(tmp, 'try.html');
execFileSync('node', [path.join(root, 'tools', 'build-demo.js'), out], { stdio: 'ignore' });
const page = fs.readFileSync(out, 'utf8');
check('the demo builds into one file under 400 KB', page.length > 100000 && page.length < 400 * 1024, String(page.length));
check('it needs no other script or file (only fonts)', !/<script[^>]+src=/.test(page) && !/<link[^>]+href="(?!https:\/\/fonts\.googleapis\.com)/.test(page));
check('no placeholder was left in it', !/__ENGINE__|__SAMPLES__|__APP__/.test(page));
check('pasted pages are shown in a locked frame', /sandbox', 'allow-same-origin'/.test(page) && /default-src \\'none\\'/.test(page) && !/allow-scripts/.test(page));
fs.rmSync(tmp, { recursive: true, force: true });
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (demo)');
process.exit(failed ? 1 : 0);
