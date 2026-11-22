// The small HTML parser (src/core/minidom.js) must give the same result as a browser's parser.
//  1. No browser needed: the converter's HTML reader runs in plain Node (no DOMParser) and is
//     compared with answers recorded from Chromium (test/html-corpus.expected.json).
//  2. If Playwright is installed, the same snippets are also compared with Chromium live, and the
//     recorded answers are refreshed with:  node test/minidom.test.js --record
const fs = require('fs');
const path = require('path');
const corpus = require('./html-corpus.js');
const EXPECTED = path.join(__dirname, 'html-corpus.expected.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) { if (cond) passed++; else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } }

global.window = global;
['ast-utils', 'minidom', 'normalize-html'].forEach((f) => require('../src/core/' + f + '.js'));
const mini = corpus.map((h) => JSON.stringify(FB.htmlToAst(h)));

async function main() {
  if (process.argv.includes('--record') || !fs.existsSync(EXPECTED)) {
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (e) { console.log('Cannot record without Playwright.'); process.exit(1); }
    const b = await chromium.launch();
    const pg = await b.newPage();
    await pg.goto('file://' + path.join(__dirname, '..', 'src', 'index.html'));
    const real = await pg.evaluate((c) => c.map((h) => JSON.stringify(FB.htmlToAst(h))), corpus);
    await b.close();
    fs.writeFileSync(EXPECTED, JSON.stringify(real, null, 0));
    console.log('Recorded ' + real.length + ' browser answers.');
  }
  const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  check('the recorded answers match the snippet list (re-record after editing the corpus)', expected.length === corpus.length);
  corpus.forEach((h, i) => check('minidom matches the browser: ' + h.slice(0, 60).replace(/\n/g, ' '), mini[i] === expected[i], 'mini:    ' + mini[i].slice(0, 300) + '\n      browser: ' + String(expected[i]).slice(0, 300)));
  check('runs without any DOM globals', typeof DOMParser === 'undefined' && typeof document === 'undefined');
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (minidom)');
  process.exit(failed ? 1 : 0);
}
main();
