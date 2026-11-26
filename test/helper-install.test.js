// The installer's GNOME helper handling, with stand-in gjs / gnome-extensions: no step ever asks for a log out,
// a changed helper afterwards is reloaded in place (off, on) with no log out.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, execFileSync } = require('child_process');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + n + (d ? '  ' + d : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hi-'));
const home = path.join(tmp, 'home'), stub = path.join(tmp, 'stub'), app = path.join(tmp, 'morph');
fs.mkdirSync(home); fs.mkdirSync(stub);
const log = path.join(tmp, 'gx.log');
fs.writeFileSync(path.join(stub, 'gjs'), '#!/bin/bash\nsleep 4\n', { mode: 0o755 });
fs.writeFileSync(path.join(stub, 'gnome-extensions'), `#!/bin/bash\necho "$@" >> "${log}"\n`, { mode: 0o755 });
execFileSync('bash', ['-c', `cd "${path.join(__dirname, '..')}" && mkdir -p "${app}" && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -xf - -C "${app}"`]);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '', PATH: stub + ':' + process.env.PATH };
delete env.XDG_CONFIG_HOME; delete env.XDG_CACHE_HOME;
const run = (...a) => spawnSync('bash', [path.join(app, 'bin', 'morph'), ...a], { env, encoding: 'utf8' });
const ext = path.join(home, '.local/share/gnome-shell/extensions/morph-focus@morph.dev');
const gx = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

// Settings left behind by an old uninstall must not hide the setup page on a first install.
const cfgDir = path.join(home, '.config', 'morph');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{"setupDone": true, "pillMode": "always"}');
let r = run('--install');
const out1 = r.stdout + r.stderr;
check('first install clears stale settings and says so', !fs.existsSync(path.join(cfgDir, 'settings.json')) && /cleared settings left over/.test(out1), out1);
check('first install writes the loader, the real code and a pointer', /FB-LOADER/.test(fs.readFileSync(path.join(ext, 'extension.js'), 'utf8')) && fs.readdirSync(ext).some((f) => /^impl-[0-9a-f]{8}\.js$/.test(f)) && /^impl-[0-9a-f]{8}\.js$/.test(fs.readFileSync(path.join(ext, 'impl.txt'), 'utf8')), out1);
check('first install never asks for a log out; it says how to switch the helper on if GNOME has not', !/log out/i.test(out1) && /gnome-extensions enable morph-focus@morph.dev/.test(out1), out1);
const impl1 = fs.readFileSync(path.join(ext, 'impl.txt'), 'utf8');
check('a new helper folder appears complete in one step (no half-written folder for GNOME to load)', fs.existsSync(path.join(ext, 'metadata.json')) && fs.existsSync(path.join(ext, 'impl.txt')) && !fs.readdirSync(path.join(home, '.local/share/gnome-shell')).some((n) => /^\.morph-stage/.test(n)));

fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{"setupDone": true, "pillMode": "always"}');
r = run('--install');
check('a re-install or update keeps your settings', fs.existsSync(path.join(cfgDir, 'settings.json')) && !/cleared settings/.test(r.stdout));
check('same helper again: nothing to do, nothing toggled', /already up to date/.test(r.stdout) && !/disable/.test(gx()));

// a new helper release
fs.appendFileSync(path.join(app, 'gnome-extension/morph-focus@morph.dev/extension.js'), '\n// changed\n');
fs.writeFileSync(log, '');
r = run('--install');
const out3 = r.stdout + r.stderr;
const impl2 = fs.readFileSync(path.join(ext, 'impl.txt'), 'utf8');
check('a changed helper gets a new file name and the old one goes', impl2 !== impl1 && fs.existsSync(path.join(ext, impl2)) && !fs.existsSync(path.join(ext, impl1)));
check('it is reloaded in place: disable then enable', /disable morph-focus@morph.dev\nenable morph-focus@morph.dev/.test(gx()), gx());
check('and no log out is asked for', !/log out and back in/.test(out3) && /no log out needed/.test(out3), out3);

// the earlier helper (one big extension.js, no loader) needs a log out one last time
fs.writeFileSync(path.join(ext, 'extension.js'), '// old monolith\n');
fs.rmSync(path.join(ext, 'impl.txt'));
r = run('--install');
check('from the old helper: no log out is asked for', !/log out/i.test(r.stdout + r.stderr) && /FB-LOADER/.test(fs.readFileSync(path.join(ext, 'extension.js'), 'utf8')));

run('--stop');
spawnSync('pkill', ['-f', 'stub/gjs']);
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.log('FAILED ' + passed + ' passed, ' + failed + ' failed (helper install)'); process.exit(1); }
console.log('ok ' + passed + ' passed, 0 failed (helper install)');
