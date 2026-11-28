// The table-from-words step exists twice: in Python (Linux, ocr/morph_ocr.py) and in JavaScript (the Mac,
// src/core/ocr-grid.js). Both must turn the same words into the same table.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
globalThis.window = globalThis;
require('../src/core/ocr-grid.js');
const FB = globalThis.FB;

let passed = 0, failed = 0;
const check = (name, ok, why) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + name + (why ? '  (' + why + ')' : '')); } };

// Layouts: the real fixture, and random grids with titles, stray words, ragged rows and spreadsheet labels.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const cases = [];
const real = require('./ocr/salary-sheet-words.json');
cases.push({ texts: real.map((w) => w[0]), boxes: real.map((w) => w.slice(1)) });
for (let n = 0; n < 300; n++) {
  const cols = 2 + Math.floor(rnd() * 5), rows = 2 + Math.floor(rnd() * 7), h = 20 + Math.floor(rnd() * 20);
  const texts = [], boxes = [];
  if (rnd() < 0.4) { texts.push('Report Title'); boxes.push([40, 10, 400, 10 + h * 1.6]); }
  const sheet = rnd() < 0.2;
  for (let r = 0; r < rows; r++) {
    const y = 80 + r * (h + 12 + Math.floor(rnd() * 6));
    if (sheet && r === 0) { for (let c = 0; c < cols; c++) { texts.push(String.fromCharCode(65 + c)); boxes.push([100 + c * 160, y, 112 + c * 160, y + h]); } continue; }
    if (sheet) { texts.push(String(r)); boxes.push([20, y, 34, y + h]); }
    for (let c = 0; c < cols; c++) {
      if (rnd() < 0.08) continue;
      const w = 30 + Math.floor(rnd() * 90), x = 100 + c * 160 + Math.floor(rnd() * 20);
      texts.push((r === 0 ? 'Head' : 'v') + r + '-' + c + (rnd() < 0.1 ? ' & <x>' : ''));
      boxes.push([x, y + Math.floor(rnd() * 4), x + w, y + h + Math.floor(rnd() * 4)]);
    }
  }
  if (rnd() < 0.3) { texts.push('stray'); boxes.push([1000, 900, 1060, 920]); }
  if (rnd() < 0.1) { texts.push(''); boxes.push([1, 1, 2, 2]); texts.push('bad'); boxes.push(['x', 1, 2, 3]); }
  cases.push({ texts, boxes });
}

const js = cases.map((c) => { const g = FB.ocrGrid(c.texts, c.boxes); return g ? { grid: g, html: FB.ocrGridHtml(g) } : null; });
const py = `
import json, sys
sys.path.insert(0, sys.argv[1])
import morph_ocr as m
out = []
for c in json.load(open(sys.argv[2])):
    g = m.grid_from_words(c["texts"], c["boxes"])
    out.append({"grid": g, "html": m.grid_html(g)} if g else None)
print(json.dumps(out))
`;
const tmp = path.join(require('os').tmpdir(), 'morph-ocr-grid-cases-' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify(cases));
const r = spawnSync('python3', ['-I', '-c', py, path.join(__dirname, '..', 'ocr'), tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
if (r.status !== 0) {
  console.log('SKIP  python3 not usable here: ' + String(r.stderr).slice(0, 200));
} else {
  const pyOut = JSON.parse(r.stdout);
  let same = 0;
  cases.forEach((c, i) => {
    const a = JSON.stringify(js[i]), b = JSON.stringify(pyOut[i]);
    if (a === b) same++; else if (failed < 5) check('case ' + i + ': JavaScript and Python agree', false, a.slice(0, 160) + ' vs ' + b.slice(0, 160));
  });
  check('all ' + cases.length + ' layouts give the same table in JavaScript and Python', same === cases.length, same + ' same');
  check('some layouts are tables and some are not (the comparison means something)', js.filter(Boolean).length > 50 && js.filter((x) => !x).length > 5, js.filter(Boolean).length + ' tables');
}
check('the real screenshot gives the five-column salary table', js[0] && js[0].grid[0].join('|') === 'Employee Name|Basic|Allowances|Deductions|Net Salary' && js[0].grid.length === 8 && js[0].grid[7][0] === 'James Miller', JSON.stringify(js[0] && js[0].grid));
check('cell text is escaped in the table', /&amp; &lt;x&gt;/.test(js.filter(Boolean).map((x) => x.html).join('')));
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (ocr grid)');
process.exit(failed ? 1 : 0);
