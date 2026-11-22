'use strict';
// Design tuner (FB_TUNE=1). One list of every number, colour and font the pill
// is made of. The app turns the values you set into style rules for both
// pills (GNOME and the window), so what you drag is the real pill.
// Only values you changed produce rules; the rest stays as the stylesheets say.
// Sizes are tuned on Medium; Small and Large scale from it.

const FONTS = ['System', 'Ubuntu', 'Inter', 'Cantarell', 'DejaVu Sans', 'Noto Sans', 'monospace', 'serif'];
const FONT_CSS = ['', 'Ubuntu', 'Inter', 'Cantarell', 'DejaVu Sans', 'Noto Sans', 'monospace', 'serif'];
const SIZE_K = { s: 0.82, m: 1, l: 1.19 };

// selectors: [GNOME, window]
const SEL = {
  panel: ['.fb-panel', '.pill[data-open="true"] .panel'],
  handle: ['.fb-handle', '.pill .handle'],
  title: ['.fb-panel .fb-title', '.pill .title'],
  sub: ['.fb-panel .fb-sub', '.pill .sub'],
  note: ['.fb-panel .fb-note', '.pill .note'],
  section: ['.fb-panel .fb-section', '.pill .section'],
  row: ['.fb-panel .fb-row', '.pill .grid'],
  option: ['.fb-panel .fb-option', '.pill .option'],
  optionHover: ['.fb-panel .fb-option:hover', '.pill .option:hover'],
  optionRow: ['.fb-panel .fb-option .fb-btn-row', '.pill .option .row'],
  optionDot: ['.fb-panel .fb-option .fb-kdot', '.pill .option .kdot'],
  optionDone: ['.fb-panel .fb-option.fb-done', '.pill .option.done'],
  primary: ['.fb-panel .fb-primary', '.pill .primary'],
  primaryLabel: ['.fb-panel .fb-primary .fb-btn-label', '.pill .primary .label'],
  primaryDone: ['.fb-panel .fb-primary.fb-done', '.pill .primary.done'],
  link: ['.fb-panel .fb-link', '.pill .link'],
  foot: ['.fb-panel .fb-foot', '.pill .foot'],
  sw: ['.fb-panel .fb-sw', '.pill .sw'],
  swOn: ['.fb-panel .fb-sw.fb-sw-on', '.pill .sw.on'],
  swKnob: ['.fb-panel .fb-sw-knob', '.pill .sw::after'],
  doneLink: ['.fb-panel .fb-done-link', '.pill .done-link'],
  ctrlBtn: ['.fb-panel .fb-controls StButton', '.pill .controls button'],
  ctrlBox: ['.fb-panel .fb-controls', '.pill .controls'],
};

// A knob: id, group, label, type ('px' | 'num' | 'col' | 'font' | 'code'),
// min, max, step, def. Rules are in RULES below.
const K = [];
const add = (group, id, label, type, def, min, max, step) => K.push({ id, group, label, type, def, min, max, step: step || 1 });

add('Panel', 'pw', 'Width', 'px', 312, 200, 460);
add('Panel', 'padT', 'Padding top', 'px', 14, 0, 40);
add('Panel', 'padR', 'Padding right', 'px', 12, 0, 40);
add('Panel', 'padB', 'Padding bottom', 'px', 12, 0, 40);
add('Panel', 'padL', 'Padding left', 'px', 16, 0, 40);
add('Panel', 'gap', 'Space between parts', 'px', 8, 0, 24);
add('Panel', 'rad', 'Corner radius', 'px', 20, 0, 44);
add('Panel', 'bw', 'Border width', 'num', 1, 0, 4, 0.5);
add('Panel', 'minh', 'Height', 'code', 380, 200, 700);
add('Panel', 'pop', 'Opacity %', 'code', 100, 30, 100);
add('Panel', 'pbg', 'Background', 'col', '#111214');
add('Panel', 'pbd', 'Border colour', 'col', '#2a2c30');
add('Panel', 'font', 'Font', 'font', 0, 0, FONTS.length - 1);

add('Text', 'ttl', 'Title size', 'px', 14, 10, 26);
add('Text', 'ttw', 'Title weight', 'num', 600, 300, 900, 100);
add('Text', 'ttc', 'Title colour', 'col', '#eef0f2');
add('Text', 'sbs', 'Subtitle size', 'px', 12, 9, 18, 0.5);
add('Text', 'sbc', 'Subtitle colour', 'col', '#8c939c');
add('Text', 'nts', 'Note size', 'px', 11.5, 9, 16, 0.5);
add('Text', 'ntc', 'Note colour', 'col', '#8c939c');
add('Text', 'scs', 'Section label size', 'px', 10.5, 8, 16, 0.5);
add('Text', 'scc', 'Section label colour', 'col', '#6b7280');
add('Text', 'scl', 'Section letter spacing', 'num', 1, 0, 3, 0.1);

add('Chips', 'chV', 'Padding up/down', 'px', 6, 0, 20);
add('Chips', 'chH', 'Padding sides', 'px', 12, 0, 30);
add('Chips', 'chR', 'Corner radius', 'px', 12, 0, 30);
add('Chips', 'chFs', 'Text size', 'px', 12.5, 9, 20, 0.5);
add('Chips', 'chFw', 'Text weight', 'num', 400, 300, 800, 100);
add('Chips', 'chTc', 'Text colour', 'col', '#eef0f2');
add('Chips', 'chBg', 'Background', 'col', '#1c1d20');
add('Chips', 'chBd', 'Border colour', 'col', '#2a2c30');
add('Chips', 'chBw', 'Border width', 'num', 1, 0, 3, 0.5);
add('Chips', 'chHb', 'Hover background', 'col', '#26282c');
add('Chips', 'chHd', 'Hover border', 'col', '#3a3d42');
add('Chips', 'chGap', 'Gap between chips (sideways)', 'px', 6, 0, 20);
add('Chips', 'kdot', 'Colour dot size', 'px', 8, 0, 16);
add('Chips', 'kgap', 'Dot to label gap', 'px', 6, 0, 16);
add('Chips', 'shY', 'Shadow offset', 'px', 0, 0, 12);
add('Chips', 'shB', 'Shadow blur', 'px', 0, 0, 24);
add('Chips', 'shO', 'Shadow strength %', 'num', 35, 0, 80);
add('Chips', 'dnBg', 'Clicked: background', 'col', '#12261b');
add('Chips', 'dnBd', 'Clicked: border', 'col', '#2f6b44');
add('Chips', 'dnTc', 'Clicked: text', 'col', '#86e0a6');

add('Main button', 'prV', 'Padding up/down', 'px', 10, 0, 24);
add('Main button', 'prH', 'Padding sides', 'px', 12, 0, 30);
add('Main button', 'prR', 'Corner radius', 'px', 14, 0, 30);
add('Main button', 'prMt', 'Space above', 'px', 4, 0, 16);
add('Main button', 'prFs', 'Text size', 'px', 14, 10, 22, 0.5);
add('Main button', 'prFw', 'Text weight', 'num', 600, 400, 900, 100);
add('Main button', 'prTc', 'Text colour', 'col', '#ffffff');
add('Main button', 'prG1', 'Gradient start', 'col', '#4f7cff');
add('Main button', 'prG2', 'Gradient end', 'col', '#7a5cff');
add('Main button', 'prDn', 'Done colour', 'col', '#2ea043');

add('Footer', 'lkFs', 'Link text size', 'px', 11.5, 9, 16, 0.5);
add('Footer', 'lkC', 'Link colour', 'col', '#6b7280');
add('Footer', 'ftGap', 'Gap between links', 'px', 14, 0, 30);
add('Footer', 'swW', 'Switch width', 'px', 26, 18, 44);
add('Footer', 'swH', 'Switch height', 'px', 15, 10, 26);
add('Footer', 'swOff', 'Switch off colour', 'col', '#3a3d42');
add('Footer', 'acc', 'Accent (switch on, Done)', 'col', '#6ea2ff');


add('Closed tab', 'hdW', 'Width', 'px', 20, 8, 36);
add('Closed tab', 'hdH', 'Height', 'px', 92, 30, 140);
add('Closed tab', 'hdR', 'Corner radius', 'px', 9, 0, 20);
add('Closed tab', 'hdBg', 'Background', 'col', '#111214');

add('Controls', 'cbW', 'Button width', 'px', 28, 16, 48);
add('Controls', 'cbH', 'Button height', 'px', 28, 16, 48);
add('Controls', 'cbFs', 'Icon size', 'px', 16, 10, 28);
add('Controls', 'cbR', 'Corner radius', 'px', 8, 0, 20);
add('Controls', 'cbBg', 'Background', 'col', '#1c1d20');
add('Controls', 'cbBd', 'Border colour', 'col', '#2a2c30');
add('Controls', 'cbGap', 'Gap between buttons', 'px', 4, 0, 16);

add('Timing', 'clMs', 'Auto-collapse after click (ms)', 'code', 1800, 400, 6000, 100);

const BY_ID = {};
K.forEach((k, i) => { k.idx = i; BY_ID[k.id] = k; });

// ---- values
const clampNum = (k, v) => {
  const n = Number(v);
  if (!isFinite(n)) return k.def;
  return Math.min(k.max, Math.max(k.min, Math.round(n / k.step) * k.step));
};
const HEX = /^#[0-9a-f]{6}$/;
function cleanVals(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  K.forEach((k) => {
    if (!(k.id in raw)) return;
    const v = raw[k.id];
    if (k.type === 'col') { if (typeof v === 'string' && HEX.test(v.toLowerCase()) && v.toLowerCase() !== k.def) out[k.id] = v.toLowerCase(); }
    else { const n = clampNum(k, v); if (n !== k.def) out[k.id] = n; }
  });
  return out;
}
const val = (vals, id) => (id in vals ? vals[id] : BY_ID[id].def);

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.min(100, Math.max(0, s)) / 100; l = Math.min(100, Math.max(0, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

// "tn:12v3800" number (x10), "tc:12h210s55l40" colour, "tr:12" / "tr:all" reset.
function parseAction(a) {
  let m = /^tn:(\d{1,3})v(\d{1,6})$/.exec(a);
  if (m && K[+m[1]] && K[+m[1]].type !== 'col') return { op: 'set', id: K[+m[1]].id, v: +m[2] / 10 };
  m = /^tc:(\d{1,3})h(\d{1,3})s(\d{1,3})l(\d{1,3})$/.exec(a);
  if (m && K[+m[1]] && K[+m[1]].type === 'col') return { op: 'set', id: K[+m[1]].id, v: hslToHex(+m[2], +m[3], +m[4]) };
  m = /^tr:(\d{1,3})$/.exec(a);
  if (m && K[+m[1]]) return { op: 'reset', id: K[+m[1]].id };
  if (a === 'tr:all') return { op: 'resetall' };
  if (a === 'tcopy:') return { op: 'copy' };
  return null;
}

// ---- style rules
const px = (n) => (Math.round(n * 100) / 100) + 'px';
function css(vals, sizeKey, target) {
  const t = target === 'g' ? 0 : 1;
  const k = SIZE_K[sizeKey] || 1;
  const changed = (...ids) => ids.some((i) => i in vals);
  const S = (id) => val(vals, id) * k; // scaled px
  const rules = [];
  const rule = (sel, decls) => { const d = decls.filter(Boolean); if (d.length) rules.push(sel[t] + ' { ' + d.join(' ') + ' }'); };
  const when = (ids, make) => (changed(...ids) ? make() : '');
  const gap = t === 0 ? 'spacing' : 'gap';
  const color = (prop, id) => when([id], () => prop + ': ' + vals[id] + ';');
  const num = (prop, id, scale) => when([id], () => prop + ': ' + px(scale ? S(id) : val(vals, id)) + ';');

  rule(SEL.panel, [
    num('width', 'pw', true),
    when(['padT', 'padR', 'padB', 'padL'], () => 'padding: ' + [S('padT'), S('padR'), S('padB'), S('padL')].map(px).join(' ') + ';'),
    num(gap, 'gap', true),
    when(['rad'], () => 'border-radius: ' + px(S('rad')) + ' 0 0 ' + px(S('rad')) + ';'),
    when(['bw'], () => 'border-width: ' + px(val(vals, 'bw')) + '; border-right-width: 0;'),
    color('background-color', 'pbg'), color('border-color', 'pbd'),
    when(['font'], () => (FONT_CSS[val(vals, 'font')] ? 'font-family: "' + FONT_CSS[val(vals, 'font')] + '", sans-serif;' : '')),
    t === 1 ? when(['pop'], () => 'opacity: ' + (val(vals, 'pop') / 100) + ';') : '',
  ]);
  rule(SEL.title, [num('font-size', 'ttl', true), when(['ttw'], () => 'font-weight: ' + val(vals, 'ttw') + ';'), color('color', 'ttc')]);
  rule(SEL.sub, [num('font-size', 'sbs', true), color('color', 'sbc')]);
  rule(SEL.note, [num('font-size', 'nts', true), color('color', 'ntc')]);
  rule(SEL.section, [num('font-size', 'scs', true), color('color', 'scc'), when(['scl'], () => 'letter-spacing: ' + px(val(vals, 'scl')) + ';')]);

  rule(SEL.option, [
    when(['chV', 'chH'], () => 'padding: ' + px(S('chV')) + ' ' + px(S('chH')) + ';'),
    num('border-radius', 'chR', true), num('font-size', 'chFs', true),
    when(['chFw'], () => 'font-weight: ' + val(vals, 'chFw') + ';'),
    color('color', 'chTc'), color('background-color', 'chBg'), color('border-color', 'chBd'),
    num('border-width', 'chBw'),
    when(['shY', 'shB', 'shO'], () => 'box-shadow: 0 ' + px(S('shY')) + ' ' + px(S('shB')) + ' rgba(0, 0, 0, ' + (val(vals, 'shO') / 100) + ');'),
  ]);
  rule(SEL.optionHover, [color('background-color', 'chHb'), color('border-color', 'chHd')]);
  rule(SEL.row, [num(gap, 'chGap', true)]);
  rule(SEL.optionRow, [num(gap, 'kgap', true)]);
  rule(SEL.optionDot, [when(['kdot'], () => 'width: ' + px(S('kdot')) + '; height: ' + px(S('kdot')) + '; border-radius: ' + px(S('kdot') / 2) + ';')]);
  rule(SEL.optionDone, [color('background-color', 'dnBg'), color('border-color', 'dnBd'), color('color', 'dnTc')]);

  rule(SEL.primary, [
    when(['prV', 'prH'], () => 'padding: ' + px(S('prV')) + ' ' + px(S('prH')) + ';'),
    num('border-radius', 'prR', true), num('margin-top', 'prMt', true),
    color('color', 'prTc'),
    when(['prG1', 'prG2'], () => (t === 0
      ? 'background-gradient-direction: horizontal; background-gradient-start: ' + val(vals, 'prG1') + '; background-gradient-end: ' + val(vals, 'prG2') + ';'
      : 'background: linear-gradient(135deg, ' + val(vals, 'prG1') + ', ' + val(vals, 'prG2') + ');')),
  ]);
  rule(SEL.primaryLabel, [num('font-size', 'prFs', true), when(['prFw'], () => 'font-weight: ' + val(vals, 'prFw') + ';')]);
  rule(SEL.primaryDone, [when(['prDn'], () => (t === 0 ? 'background-color: ' + vals.prDn + '; border-color: ' + vals.prDn + ';' : 'background: ' + vals.prDn + '; border-color: ' + vals.prDn + ';'))]);

  rule(SEL.link, [num('font-size', 'lkFs', true), color('color', 'lkC')]);
  rule(SEL.foot, [num(gap, 'ftGap', true)]);
  rule(SEL.sw, [
    when(['swW', 'swH'], () => 'width: ' + px(S('swW')) + '; height: ' + px(S('swH')) + '; border-radius: ' + px(S('swH') / 2) + ';'),
    color('background-color', 'swOff'),
  ]);
  rule(SEL.swOn, [color('background-color', 'acc')]);
  if (t === 0) rule(SEL.swKnob, [when(['swH'], () => 'width: ' + px(S('swH') - 4) + '; height: ' + px(S('swH') - 4) + '; border-radius: ' + px((S('swH') - 4) / 2) + ';')]);
  rule(SEL.doneLink, [color('color', 'acc')]);

  rule(SEL.handle, [
    num('width', 'hdW', true), num('height', 'hdH', true),
    when(['hdR'], () => 'border-radius: ' + px(S('hdR')) + ' 0 0 ' + px(S('hdR')) + ';'),
    color('background-color', 'hdBg'),
  ]);

  rule(SEL.ctrlBtn, [
    num('width', 'cbW', true), num('height', 'cbH', true),
    num('font-size', 'cbFs', true), num('border-radius', 'cbR', true),
    color('background-color', 'cbBg'), color('border-color', 'cbBd'),
  ]);
  rule(SEL.ctrlBox, [num(gap, 'cbGap', true)]);
  return rules.join('\n');
}

// What the pills get to draw the tuner: the knobs and where they stand.
function describe() {
  return K.map((k) => ({ id: k.id, i: k.idx, g: k.group, l: k.label, t: k.type === 'code' ? 'num' : k.type, d: k.def, a: k.min, b: k.max, s: k.step, o: k.type === 'font' ? FONTS : undefined }));
}

module.exports = { K, BY_ID, FONTS, SIZE_K, cleanVals, val, parseAction, css, describe, hslToHex };
