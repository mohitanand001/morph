// Keyboard shortcuts: what they do, their default keys, and turning GNOME's
// key names ("<Control><Alt>v") into Electron's ("CommandOrControl+Alt+V")
// and into labels people read ("Ctrl Alt V").
'use strict';

const SHORTCUTS = [
  { id: 'paste', name: 'Paste converted for this app', accel: '<Control><Alt>v', on: true },
  { id: 'plain', name: 'Paste as plain text', accel: '<Shift><Control><Alt>v', on: true },
  { id: 'pill', name: 'Show or hide Morph', accel: '<Control><Alt>f', on: true },
  { id: 'prev', name: 'Paste the copy before this one', accel: '<Control><Alt>h', on: false },
  { id: 'auto', name: 'Turn Convert automatically on or off', accel: '<Control><Alt>a', on: false },
  { id: 'full', name: 'Open the full view', accel: '<Control><Alt>b', on: false },
  { id: 'pdf', name: 'Save what I copied as a PDF', accel: '<Control><Alt>p', on: false },
];
const IDS = SHORTCUTS.map((s) => s.id);

// One to four modifiers, then one key: a letter, a digit or F1–F12. Plain
// letters without a modifier would steal typing, so they're refused.
const ACCEL_RE = /^(?:<(?:Control|Alt|Shift|Super)>){1,4}(?:[a-z0-9]|F(?:[1-9]|1[0-2]))$/;
const needsMainModifier = (a) => /<(Control|Alt|Super)>/.test(a);
function validAccel(a) {
  return typeof a === 'string' && ACCEL_RE.test(a) && needsMainModifier(a);
}

// Saved settings -> a full, clean list in the defaults' order.
function normalizeShortcuts(saved) {
  const byId = {};
  if (Array.isArray(saved)) saved.forEach((s) => { if (s && IDS.includes(s.id)) byId[s.id] = s; });
  const out = SHORTCUTS.map((d) => {
    const s = byId[d.id] || {};
    return { id: d.id, accel: validAccel(s.accel) ? s.accel : d.accel, on: typeof s.on === 'boolean' ? s.on : d.on };
  });
  // Two shortcuts on the same keys: the later one is switched off.
  const seen = new Set();
  out.forEach((s) => { if (!s.on) return; if (seen.has(s.accel)) s.on = false; else seen.add(s.accel); });
  return out;
}

function parts(accel) {
  const mods = (accel.match(/<(\w+)>/g) || []).map((m) => m.slice(1, -1));
  const key = accel.replace(/<\w+>/g, '');
  return { mods, key };
}
const ORDER = ['Control', 'Alt', 'Shift', 'Super'];
function accelLabel(accel, mac) {
  if (!validAccel(accel)) return '';
  const { mods, key } = parts(accel);
  const names = mac ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' } : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Super' };
  const m = ORDER.filter((x) => mods.includes(x)).map((x) => names[x]);
  return m.concat([key.toUpperCase()]).join(mac ? '' : ' ');
}
function accelToElectron(accel) {
  if (!validAccel(accel)) return '';
  const { mods, key } = parts(accel);
  const names = { Control: 'Control', Alt: 'Alt', Shift: 'Shift', Super: 'Super' };
  return ORDER.filter((x) => mods.includes(x)).map((x) => names[x]).concat([key.toUpperCase()]).join('+');
}

module.exports = { SHORTCUTS, IDS, validAccel, normalizeShortcuts, accelLabel, accelToElectron };
