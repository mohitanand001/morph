// The PDF page items (daemon/pdf-doc.js), checked on every fixture: well-formed Pango markup,
// every word kept, nothing that would stop the PDF drawer.
const fs = require('fs');
const path = require('path');
global.window = global;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const { pdfItems } = require('../daemon/pdf-doc');
let passed = 0; let failed = 0;
function check(n, c, d) { if (c) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')); } }

// A small XML-ish check for Pango markup: tags balance, entities are known.
function wellFormed(m) {
  const stack = [];
  const re = /<(\/?)([a-z]+)([^>]*)>|&([a-z#0-9]+);|[<>&]/g;
  let x;
  while ((x = re.exec(m))) {
    if (x[2]) { if (x[1]) { if (stack.pop() !== x[2]) return false; } else stack.push(x[2]); } else if (x[4]) { if (!/^(amp|lt|gt|quot)$/.test(x[4])) return false; } else return false;
  }
  return stack.length === 0;
}
const words = (s) => (String(s).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
const FIX = path.join(__dirname, 'fixtures');
for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.json'))) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  const r = FB.engine.run({ html: fx.html, text: fx.text }, 'email');
  const items = pdfItems(r.ast);
  const label = f.replace('.json', '');
  const marks = [];
  items.forEach((it) => {
    if (it.markup !== undefined) marks.push(it.markup);
    if (it.kind === 'table') { it.head.forEach((c) => marks.push(c)); it.rows.forEach((row) => row.forEach((c) => marks.push(c))); }
  });
  check(label + ': has items', items.length > 0);
  check(label + ': markup is well formed', marks.every(wellFormed), marks.find((m) => !wellFormed(m)));
  check(label + ': items are known kinds', items.every((i) => ['text', 'code', 'table', 'rule', 'gap'].includes(i.kind)));
  const have = new Set(words(marks.join(' ')));
  // Addresses printed in brackets after a link or a mention are not shown in the PDF (the text is the link).
  const want = Array.from(new Set(words(FB.astToPlainText(r.ast).replace(/\([^)\s]*[@:/][^)\s]*\)/g, ' '))));
  const lost = want.filter((w) => !have.has(w));
  check(label + ': no words lost', lost.length === 0, lost.slice(0, 8).join(', '));
}
// Awkward text is made safe.
{
  const ast = FB.markdownToAst('a < b & c > d\n\n`x<y`\n\n```\nif (a && b) { <tag> }\n```\n\n\u0001bell');
  const marks = pdfItems(ast).map((i) => i.markup).filter(Boolean);
  check('angle brackets, ampersands and control characters are escaped', marks.every(wellFormed) && !/\u0001/.test(marks.join('')));
}
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (pdf items)');
process.exit(failed ? 1 : 0);
