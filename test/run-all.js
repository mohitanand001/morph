// One command for every test: npm test
const { spawnSync } = require('child_process');
const path = require('path');
let bad = 0;
for (const [name, file] of [['core logic', 'core.test.js'], ['companion logic', 'companion.test.js'], ['static checks', 'static.test.js'], ['html parser (no browser)', 'minidom.test.js'], ['headless engine (no browser)', 'engine.test.js'], ['background program (fake desktop)', 'daemon.test.js'], ['PDF page items', 'pdf-doc.test.js'], ['Linux download (unpacked)', 'zip.test.js'], ['updates', 'update.test.js'], ['privacy', 'privacy.test.js'], ['ocr', 'ocr.test.js'], ['cross-links', 'links.test.js'], ['website demo', 'demo.test.js'], ['which samples need converting', 'needs.test.js'], ['GNOME helper install (no log out)', 'helper-install.test.js'], ['gnome extension (mocked)', 'gnome-mock.test.mjs'], ['app window', 'app.test.js']]) {
  console.log('\n== ' + name + ' ==');
  if (spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' }).status !== 0) bad++;
}
console.log('\n' + (bad ? bad + ' suite(s) FAILED' : 'All suites passed'));
process.exit(bad ? 1 : 0);
