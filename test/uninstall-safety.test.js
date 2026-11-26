// Uninstall and install must never touch files that belong to other programs, even ones with the same names.
// Runs the real bin/morph in a throwaway home folder filled with look-alikes.
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, ok, why) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + name + (why ? '  (' + why + ')' : '')); } };
const SRC = path.join(__dirname, '..');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'morph-safety-'));
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return false; } };

function freshHome() {
  const home = fs.mkdtempSync(path.join(W, 'home-'));
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home + '/.config', XDG_CACHE_HOME: home + '/.cache', XDG_DATA_HOME: home + '/.local/share', XDG_RUNTIME_DIR: home + '/run' };
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  return { home, env };
}
// A Morph folder as the download unpacks it.
function unpackMorph(dest) {
  execFileSync('bash', [path.join(SRC, 'tools/build-linux-zip.sh'), path.join(W, 'zip')], { stdio: 'ignore' });
  const zip = fs.readdirSync(path.join(W, 'zip')).find((f) => /\.zip$/.test(f));
  const x = fs.mkdtempSync(path.join(W, 'x-'));
  execFileSync('unzip', ['-q', path.join(W, 'zip', zip), '-d', x]);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('cp', ['-r', path.join(x, 'morph') + '/.', dest]);
  return fs.readdirSync(path.join(x, 'morph'));
}

// 1) Uninstall in a home full of other programs' files
{
  const { home, env } = freshHome();
  const app = home + '/.local/share/morph';
  const entries = unpackMorph(app);
  // Morph's own files
  put(home + '/.config/morph/settings.json', '{"pillMode":"always"}');
  fs.mkdirSync(home + '/.local/bin', { recursive: true });
  fs.symlinkSync(app + '/bin/morph', home + '/.local/bin/morph');
  put(home + '/.config/autostart/morph.desktop', '[Desktop Entry]\nExec=gjs -m "' + app + '/daemon/gjs-main.js"\n');
  put(home + '/.cache/morph.log', 'log');
  put(home + '/.local/share/morph-ocr/ready', ''); put(home + '/.local/share/morph-ocr/engine', 'rapidocr'); put(home + '/.local/share/morph-ocr/venv/lib/x.py', 'x');
  put(home + '/.local/share/morph-ocr/venv/lib/__pycache__/x.cpython-313.pyc', 'x');
  put(home + '/.local/share/morph-ocr/MANIFEST', 'ready\nengine\nvenv/lib/x.py\nMANIFEST\n');
  put(home + '/run/morph/clip-image-1-2.png', 'x');
  put(home + '/.bashrc', 'alias ll="ls -l"\n# my morph PATH notes\nexport KEEP_ME=1\n\n# morph PATH\nexport PATH="$HOME/.local/bin:$PATH"\nexport AFTER=1\n');
  // Other programs' look-alikes
  put(home + '/.config/morph/other-app.conf', 'not ours');
  put(home + '/.config/formatter/init.lua', 'someone else\'s formatter');
  put(home + '/.config/formatter/settings.json', '{"indent":2}');
  put(home + '/.config/autostart/formatter.desktop', '[Desktop Entry]\nExec=/usr/bin/some-formatter\n');
  put(home + '/.cache/formatter.log', 'theirs');
  put(home + '/.cache/formatter-icons/a.png', 'theirs');
  put(home + '/run/morph/notes.txt', 'theirs');
  put(app + '/my-notes.txt', 'a file you put in the folder');
  const r = spawnSync('bash', [app + '/bin/morph', '--uninstall'], { env, encoding: 'utf8' });
  check('uninstall runs', r.status === 0, r.stderr + r.stdout);
  check('Morph\'s program files are gone', !exists(app + '/daemon') && !exists(app + '/bin') && !exists(app + '/src'));
  check('a file you put in Morph\'s folder is kept, and so is the folder', exists(app + '/my-notes.txt'));
  check('Morph\'s settings, log, command, autostart, image-tables folder and copied images are gone',
    !exists(home + '/.config/morph/settings.json') && !exists(home + '/.cache/morph.log') && !exists(home + '/.local/bin/morph') &&
    !exists(home + '/.config/autostart/morph.desktop') && !exists(home + '/.local/share/morph-ocr') && !exists(home + '/run/morph/clip-image-1-2.png'));
  check('another program\'s file in ~/.config/morph is kept', exists(home + '/.config/morph/other-app.conf'));
  check('another program\'s "formatter" settings, autostart, log and icons are kept',
    exists(home + '/.config/formatter/init.lua') && exists(home + '/.config/formatter/settings.json') && exists(home + '/.config/autostart/formatter.desktop') &&
    exists(home + '/.cache/formatter.log') && exists(home + '/.cache/formatter-icons/a.png'));
  check('another program\'s file in the private folder is kept', exists(home + '/run/morph/notes.txt'));
  const rc = fs.readFileSync(home + '/.bashrc', 'utf8');
  check('~/.bashrc loses exactly Morph\'s two lines', !/^# morph PATH$/m.test(rc) && /# my morph PATH notes\nexport KEEP_ME=1/.test(rc) && /export AFTER=1/.test(rc) && /alias ll/.test(rc), JSON.stringify(rc));
  check('the download lists every file it holds, so each can be removed by name', entries.includes('MANIFEST'));
  // A file in the image-tables folder that Morph never listed stays, and so does the folder.
  {
    const { home: h2, env: e2 } = freshHome();
    const a2 = h2 + '/.local/share/morph'; unpackMorph(a2);
    put(h2 + '/.local/share/morph-ocr/engine', 'rapidocr'); put(h2 + '/.local/share/morph-ocr/MANIFEST', 'engine\nMANIFEST\n'); put(h2 + '/.local/share/morph-ocr/yours.txt', 'not listed');
    spawnSync('bash', [a2 + '/bin/morph', '--uninstall'], { env: e2, encoding: 'utf8' });
    check('an unlisted file in the image-tables folder is kept', exists(h2 + '/.local/share/morph-ocr/yours.txt') && !exists(h2 + '/.local/share/morph-ocr/engine'));
  }
}

// 2) A folder that only looks like Morph is never deleted wholesale
{
  const { home, env } = freshHome();
  const docs = home + '/Documents';
  unpackMorph(docs); // Morph's files copied straight into Documents
  put(docs + '/thesis.docx', 'precious');
  const r = spawnSync('bash', [docs + '/bin/morph', '--uninstall'], { env, encoding: 'utf8' });
  check('uninstall from a crowded folder keeps everything that is not Morph\'s', r.status === 0 && exists(docs + '/thesis.docx') && !exists(docs + '/daemon'), r.stdout);
}

// 3) Another program's "morph" command and autostart entry are not replaced or removed
{
  const { home, env } = freshHome();
  const app = home + '/.local/share/morph';
  unpackMorph(app);
  put(home + '/.local/bin/morph', '#!/bin/sh\necho "the other morph"\n');
  put(home + '/.config/autostart/morph.desktop', '[Desktop Entry]\nExec=/usr/bin/other-morph\n');
  spawnSync('bash', [app + '/bin/morph', '--uninstall'], { env, encoding: 'utf8' });
  check('another program\'s ~/.local/bin/morph survives uninstall', exists(home + '/.local/bin/morph') && /the other morph/.test(fs.readFileSync(home + '/.local/bin/morph', 'utf8')));
  check('another program\'s morph.desktop survives uninstall', exists(home + '/.config/autostart/morph.desktop'));
}

// 4) No broad process kills, no deleting outside Morph's names
{
  const sh = fs.readFileSync(path.join(SRC, 'bin/morph'), 'utf8');
  const kills = sh.split('\n').filter((l) => /\b(pkill|killall|kill)\b/.test(l) && !/^\s*#/.test(l));
  check('the only processes stopped are Morph\'s own', kills.length > 0 && kills.every((l) => /pkill -f "gjs\.\*\$MAIN"/.test(l)), kills.join(' | '));
  const rms = sh.split('\n').filter((l) => /\brm -r?f\b/.test(l) && !/^\s*#/.test(l));
  check('nothing deletes a folder with what is inside it: no rm -r anywhere that runs on your computer', ['bin/morph', 'site/install.sh', 'daemon/gjs-main.js', 'gnome-extension/morph-focus@morph.dev/extension.js'].every((f) => !/\brm\s+-[a-zA-Z]*r/.test(fs.readFileSync(path.join(SRC, f), 'utf8'))) && !/rm -r/.test(fs.readFileSync(path.join(SRC, 'tools/build-deb.sh'), 'utf8').split('DEBIAN/prerm')[1].split('chmod')[0]));
  check('the update only accepts a Morph zip from the same website', /\^morph-\[0-9A-Za-z\.\+-\]\+-linux\\\\?\.zip\$/.test(sh) && !/case "\$zip" in http/.test(sh));
}

try { execFileSync('rm', ['-rf', W]); } catch (e) { /* tmp */ }
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (uninstall safety)');
process.exit(failed ? 1 : 0);
