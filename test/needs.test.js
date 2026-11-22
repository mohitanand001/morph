// Which demo samples really need a conversion, and for which apps? Measures what Morph changes for every
// sample and destination, checks a few things that must hold, and prints the whole picture with --report.
const fs = require('fs'), path = require('path');
global.window = global;
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '  ' + d : '')); } };
const root = path.join(__dirname, '..');
require('../src/icons.js');
[...fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8').matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(root, 'src', m[1])));
const { verdict } = require('../demo/verdict.js');
const S = require('../demo/samples.js')();
const D = Object.keys(FB.engine.NAMES);
const M = {}; const count = {};
S.forEach((s) => { M[s.id] = {}; D.forEach((d) => { const r = FB.engine.run({ html: s.html, text: s.text }, d); const v = verdict(s, r, FB.engine.notes(d, r.ast, r.opts)); M[s.id][d] = v.level; count[v.level] = (count[v.level] || 0) + 1; check(s.id + ' -> ' + d + ' has a reason', v.why.length > 0); }); });
const lv = (id, d) => M[id][d];
check('a Slack message pasted into Slack is left untouched', lv('slack', 'slack') === 'untouched');
check('Jira and Confluence pages are left untouched in each other', ['jira', 'confluence'].every((i) => ['jira', 'confluence'].every((d) => lv(i, d) === 'untouched')));
check('a log or JSON pasted as plain text needs nothing', lv('logs', 'text') === 'same' && lv('json', 'text') === 'same');
check('AI markdown pasted into a markdown app is not converted', ['markdown'].every((d) => lv('ai', d) === 'same' || lv('ai', d) === 'cleanup'));
check('AI markdown pasted into Slack, Jira or Email is converted', ['slack', 'jira', 'email', 'gdocs'].every((d) => lv('ai', d) === 'converted'));
check('raw Slack text becomes real formatting in every app', D.every((d) => lv('mrkdwn', d) === 'converted'));
check('spreadsheet cells need turning into a table', lv('sheet', 'jira') === 'converted' && lv('sheet', 'email') === 'converted');
check('a web page into Email or Docs is at most tidied, with the same words', ['email', 'gdocs'].every((d) => ['cleanup', 'converted'].includes(lv('web', d))));
check('nothing in the matrix is unclassified', Object.keys(count).every((k) => ['untouched', 'same', 'cleanup', 'converted'].includes(k)));
if (process.argv.includes('--report')) {
  const L = { untouched: 'U', same: '=', cleanup: '~', converted: 'C' };
  console.log('\nU left alone   = identical   ~ tidied only   C converted\n' + 'sample'.padEnd(12) + D.map((d) => d.slice(0, 5).padEnd(6)).join('') + ' converted');
  S.forEach((s) => console.log(s.id.padEnd(12) + D.map((d) => L[M[s.id][d]].padEnd(6)).join('') + ' ' + D.filter((d) => M[s.id][d] === 'converted').length + '/' + D.length));
  const tot = D.length * S.length;
  console.log('\n' + Object.keys(count).map((k) => k + ' ' + count[k] + ' (' + Math.round(100 * count[k] / tot) + '%)').join('   '));
}
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (needs)');
process.exit(failed ? 1 : 0);
