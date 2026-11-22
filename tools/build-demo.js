#!/usr/bin/env node
// Builds the website demo: ONE self-contained page (converter, samples and page code inlined) so it
// can be dropped on GitHub Pages as try.html and can never drift from the app's converter.
// Usage: node tools/build-demo.js [outfile]   (default dist/try.html)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'dist', 'try.html');
const idx = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const files = ['icons.js'].concat([...idx.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].map((m) => m[1]));
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const engine = files.map((f) => '// ---- ' + f + '\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
const verdictJs = fs.readFileSync(path.join(root, 'demo', 'verdict.js'), 'utf8');
const samples = require('../demo/samples.js')();
const app = fs.readFileSync(path.join(root, 'demo', 'app.js'), 'utf8');
let page = fs.readFileSync(path.join(root, 'demo', 'template.html'), 'utf8');
page = page.replace('/*__ENGINE__*/', () => safe(engine + '\n// ---- demo/verdict.js\n' + verdictJs))
  .replace('/*__SAMPLES__*/', () => safe(JSON.stringify(samples.map(({ id, app, group, title, blurb, look, html, text, best }) => ({ id, app, group, title, blurb, look, html, text, best })))))
  .replace('/*__APP__*/', () => safe(app));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(out + ' (' + Math.round(page.length / 1024) + ' KB)');
