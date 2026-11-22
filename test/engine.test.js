// The headless converter (src/core/engine.js) end to end, in plain Node with no browser and no DOM:
// every fixture goes through detect, read and convert for every destination, with the same
// expectations the app-window tests use. This is what the background program on GNOME will run.
const fs = require('fs');
const path = require('path');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].map((m) => m[1]);
files.forEach((f) => require(path.join(__dirname, '..', 'src', f)));

let passed = 0;
let failed = 0;
function check(name, cond, detail) { if (cond) passed++; else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } }

check('no DOM globals are present', typeof DOMParser === 'undefined' && typeof document === 'undefined');
check('the engine is loaded with every core file', files.includes('core/engine.js') && files.includes('core/minidom.js') && !!FB.engine);

const DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
const destKey = (d) => (d === 'github' ? 'markdown' : d);
const FIX = path.join(__dirname, 'fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort()
  .map((f) => Object.assign({ file: f.replace('.json', '') }, JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))));

for (const fx of fixtures) {
  const ex = fx.expect;
  const label = fx.file;
  const out = {};
  let run;
  for (const d of DESTS) {
    run = FB.engine.run({ html: fx.html, text: fx.text }, d);
    out[d] = { plain: (run.out && run.out.text) || '', html: (run.out && run.out.html) || '' };
    check(label + ' -> ' + d + ': produced output', (out[d].plain + out[d].html).trim().length > 0);
    check(label + ' -> ' + d + ': no undefined/[object', !/undefined|\[object/.test(out[d].plain + out[d].html));
  }
  check(label + ': source ' + ex.source, run.source === ex.source, run.source);
  const tables = (out.jira.html.match(/<table/g) || []).length;
  check(label + ': ' + ex.tables + ' table(s)', tables === ex.tables, 'got ' + tables);
  Object.entries(ex.contains || {}).forEach(([d, needles]) => {
    const k = destKey(d);
    const hay = out[k].plain + '\n' + out[k].html;
    needles.forEach((n) => check(label + ' -> ' + k + ' contains ' + JSON.stringify(n), hay.includes(n), hay.slice(0, 200)));
  });
  (ex.excludes || []).forEach((n) => DESTS.forEach((d) => check(label + ' -> ' + d + ' excludes ' + JSON.stringify(n), !(out[d].plain + out[d].html).includes(n))));
  Object.entries(ex.excludesIn || {}).forEach(([d, needles]) => {
    const k = destKey(d);
    needles.forEach((n) => check(label + ' -> ' + k + ' excludes ' + JSON.stringify(n), !(out[k].html || out[k].plain).includes(n)));
  });
  if (!ex.skipWords) {
    const words = Array.from(new Set(fx.text.toLowerCase().match(/[a-z0-9]{4,}/g) || []));
    const plain = out.text.plain.toLowerCase();
    const lost = words.filter((w) => !plain.includes(w) && !(ex.ignoreWords || []).includes(w));
    check(label + ': no words lost', lost.length === 0, lost.join(', '));
  }
  check(label + ' -> email: inline styles only', !/class=|<style/i.test(out.email.html));
}

// Slack to Slack, and Atlassian to Atlassian, come back untouched.
{
  const fx = fixtures.find((f) => f.file === 'slack-message-table-mention');
  const r = FB.engine.run({ html: fx.html, text: fx.text }, 'slack');
  check('Slack to Slack is passed through untouched', r.passthrough && r.out.html === fx.html && r.out.text === fx.text);
}
// Empty and image-only content produce nothing to convert.
check('empty clipboard has no content', !FB.engine.run({ html: '', text: '' }, 'slack').has);
// Source link, when asked for, goes into other apps only.
{
  const ctx = { label: '#design', tool: 'Slack', dest: 'slack', url: 'https://example.slack.com/archives/C1' };
  const into = FB.engine.run({ html: '', text: '# Title\n\nbody', context: ctx, linkBack: true }, 'jira');
  check('link back is added into another app', /Source: Slack/.test(into.out.html) && /example\.slack\.com/.test(into.out.html));
  const same = FB.engine.run({ html: '', text: '# Title\n\nbody', context: ctx, linkBack: true }, 'slack');
  check('link back is not added into the same app', !/Source:/.test(same.out.html + same.out.text));
  const off = FB.engine.run({ html: '', text: '# Title\n\nbody', context: ctx, linkBack: false }, 'jira');
  check('link back is off by default', !/Source:/.test(off.out.html + off.out.text));
}
// A list written directly inside a list (not inside an <li>) belongs to the item before it, and loses nothing.
{
  const r = FB.engine.run({ html: '<ul><li>Pricing</li><ul><li>Annual plan</li><li>Free tier</li></ul><li>Support</li></ul>', text: 'x' }, 'markdown');
  check('a list inside a list keeps its text and nesting', /- Pricing\n  - Annual plan\n  - Free tier\n- Support/.test(r.out.text), r.out.text);
  const d = FB.engine.run({ html: '<ul><li aria-level="1"><p>A</p></li><li aria-level="2"><p>B</p></li><li aria-level="1"><p>C</p></li></ul>', text: 'x' }, 'markdown');
  check('Google Docs flat levels keep their nesting', /- A\n  - B\n- C/.test(d.out.text), d.out.text);
}
check('PDF title comes from the first heading', FB.engine.pdfTitle(FB.markdownToAst('# My Report\n\nbody')) === 'My Report');

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (engine)');
process.exit(failed ? 1 : 0);
