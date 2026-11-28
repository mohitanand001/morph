#!/usr/bin/env node
// Builds what the Mac app loads, from the same files Linux runs:
//   <out>/morph.js       the converter (src/core), the logic (daemon/core.js and lib/) and the Mac host (mac/host.js)
//                        as one script for JavaScriptCore, with a tiny `require` for the CommonJS files
//   <out>/ui/            the panel: mac/ui/*, and icons.js made from the GNOME helper's own icon tables
// Usage: node tools/build-mac.js [out]   (default: mac/build/Resources)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function coreFiles() {
  // One list of converter files: the one the GNOME background program loads.
  const m = /const CORE = \[([^\]]+)\]/.exec(read('daemon/gjs-main.js'));
  if (!m) throw new Error('CORE list not found in daemon/gjs-main.js');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).map((f) => 'src/core/' + f + '.js');
}
const MODULES = ['lib/rules.js', 'lib/source.js', 'lib/slack.js', 'lib/links.js', 'lib/keys.js', 'daemon/core.js', 'mac/host.js'];

function bundle() {
  const parts = [];
  parts.push('// Built by tools/build-mac.js from Morph ' + JSON.parse(read('package.json')).version + '. Do not edit: edit the files it names.');
  parts.push('var window = globalThis;');
  for (const f of coreFiles()) parts.push('// ---- ' + f + '\n' + read(f));
  parts.push(`var __defs = {}, __cache = {};
function __norm(p) { var out = []; p.split('/').forEach(function (s) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }); var r = out.join('/'); return /\\.js$/.test(r) ? r : r + '.js'; }
function __req(from) {
  return function require(name) {
    var dir = from.split('/').slice(0, -1).join('/');
    var p = name.charAt(0) === '.' ? __norm(dir + '/' + name) : __norm(name);
    if (__cache[p]) return __cache[p].exports;
    if (!__defs[p]) throw new Error('Morph: no module ' + p + ' (wanted by ' + from + ')');
    var module = { exports: {} };
    __cache[p] = module;
    __defs[p](module, module.exports, __req(p));
    return module.exports;
  };
}
var require = __req('');`);
  for (const f of MODULES) parts.push('// ---- ' + f + '\n__defs[' + JSON.stringify(f) + '] = function (module, exports, require) {\n' + read(f) + '\n};');
  parts.push('var startMorphMac = require("mac/host.js").startMorphMac;');
  return parts.join('\n');
}

function icons() {
  const ext = read('gnome-extension/morph-focus@morph.dev/extension.js');
  const grab = (name) => {
    const m = new RegExp('^const ' + name + ' = (.*);$', 'm').exec(ext);
    if (!m) throw new Error(name + ' not found in extension.js');
    JSON.parse(m[1]); // must be plain data
    return m[1];
  };
  return '// Built by tools/build-mac.js from the GNOME helper\'s icon tables: Material Symbols (Apache-2.0) and\n' +
    '// Simple Icons (CC0) brand marks, used only to say which app a format is for.\n' +
    'window.MORPH_ICONS = { dest: ' + grab('DEST_ICON') + ', svg: ' + grab('ICON_SVG') + ', ui: ' + grab('UI_PATH') + ', tab: ' + grab('TAB_FRAMES') + ' };\n';
}

function build(out) {
  fs.mkdirSync(path.join(out, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(out, 'morph.js'), bundle());
  fs.writeFileSync(path.join(out, 'ui', 'icons.js'), icons());
  for (const f of fs.readdirSync(path.join(ROOT, 'mac', 'ui'))) {
    if (/^[a-z-]+\.(html|css|js)$/.test(f)) fs.copyFileSync(path.join(ROOT, 'mac', 'ui', f), path.join(out, 'ui', f));
  }
  return out;
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'mac', 'build', 'Resources'));
  build(out);
  console.log('built ' + out);
}
module.exports = { build, bundle, icons, coreFiles };
