// A stand-in for a real app in the Morph Lab: a GTK 4 window with any app id and title (Slack, Jira in a
// browser, Google Docs, a text editor…). It copies and pastes for real, through the Wayland clipboard, when the
// lab presses Ctrl+C / Ctrl+V on it, and tells the lab what it pasted.
//
//   gjs -m fakeapp.js --key slack --app com.slack.Slack --title "general - Slack" --color "#4a154b"
//
// D-Bus (session): dev.morph.Lab.App_<key>, object /dev/morph/Lab/App
//   SetSelection(text, html)  what Ctrl+C will copy (html may be empty: plain text only)
//   Pasted() -> json          what the last Ctrl+V received: { n, formats, text, html }
//   Info() -> json            { key, app, title, focused }
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
// (No top-level await in this file: the main loop below runs inside module evaluation, and promises only
// settle if that evaluation is not itself waiting on one.)

const args = {};
for (let i = 0; i < ARGV.length; i += 2) args[ARGV[i].replace(/^--/, '')] = ARGV[i + 1];
// The Wayland app id comes from the program name, so any id works (even "firefox"): set before GTK starts.
GLib.set_prgname(args.app || 'lab.fake');
Gtk.init();

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
let selection = { text: '', html: '' };
let pasted = { n: 0, formats: [], text: '', html: '' };
let copies = 0;

const win = new Gtk.Window({ title: args.title || 'Fake app', default_width: 760, default_height: 520 });
const css = new Gtk.CssProvider();
css.load_from_string(`window { background: #f6f6f4; } .bar { background: ${args.color || '#555'}; color: white; padding: 14px 18px; font-weight: 700; font-size: 18px; } .body { padding: 18px; font-size: 14px; color: #333; }`);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const bar = new Gtk.Label({ label: args.title || 'Fake app', xalign: 0 });
bar.add_css_class('bar');
const body = new Gtk.Label({ label: 'Morph Lab stand-in for ' + (args.key || 'an app') + '\n(app id ' + (args.app || '') + ')', xalign: 0, yalign: 0, vexpand: true });
body.add_css_class('body');
box.append(bar); box.append(body);
win.set_child(box);

function copy() {
  const parts = [];
  if (selection.html) parts.push(Gdk.ContentProvider.new_for_bytes('text/html', new GLib.Bytes(enc(selection.html))));
  parts.push(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', new GLib.Bytes(enc(selection.text))));
  parts.push(Gdk.ContentProvider.new_for_bytes('text/plain', new GLib.Bytes(enc(selection.text))));
  win.get_clipboard().set_content(Gdk.ContentProvider.new_union(parts));
  copies++;
  body.set_label('Copied ' + selection.text.length + ' characters');
}
function readMime(clip, mime) {
  return new Promise((resolve) => {
    clip.read_async([mime], GLib.PRIORITY_DEFAULT, null, (c, res) => {
      try {
        const [stream] = c.read_finish(res);
        const out = Gio.MemoryOutputStream.new_resizable();
        out.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT, null, (o, r) => {
          try { o.splice_finish(r); resolve(dec(o.steal_as_bytes().toArray())); } catch (e) { resolve(''); }
        });
      } catch (e) { resolve(''); }
    });
  });
}
async function paste() {
  body.set_label('Pasting…');
  const clip = win.get_clipboard();
  const formats = clip.get_formats().get_mime_types() || [];
  const html = formats.includes('text/html') ? await readMime(clip, 'text/html') : '';
  const textMime = formats.find((m) => /^text\/plain;charset=utf-8$/i.test(m)) || formats.find((m) => /^text\/plain/.test(m)) || formats.find((m) => /UTF8_STRING|STRING|TEXT/.test(m));
  const text = textMime ? await readMime(clip, textMime) : '';
  pasted = { n: pasted.n + 1, formats, text, html };
  body.set_label('Pasted ' + text.length + ' characters' + (html ? ' (with formatting)' : ''));
}
const keys = new Gtk.EventControllerKey();
keys.connect('key-pressed', (_c, keyval, _code, state) => {
  if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false;
  const k = Gdk.keyval_to_lower(keyval);
  if (k === Gdk.KEY_c) { copy(); return true; }
  if (k === Gdk.KEY_v) { paste().catch((e) => { body.set_label('Paste failed: ' + e); printerr('paste failed: ' + e + '\n' + e.stack); }); return true; }
  return false;
});
win.add_controller(keys);

const IFACE = `<node><interface name="dev.morph.Lab.App">
  <method name="SetSelection"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Pasted"><arg type="s" direction="out"/></method>
  <method name="Info"><arg type="s" direction="out"/></method>
  <method name="Quit"/>
</interface></node>`;
const loop = new GLib.MainLoop(null, false);
const impl = {
  SetSelection(text, html) { selection = { text, html }; },
  Pasted() { return JSON.stringify(pasted); },
  Info() { return JSON.stringify({ key: args.key, app: args.app, title: args.title, focused: win.is_active, copies }); },
  Quit() { GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { loop.quit(); return GLib.SOURCE_REMOVE; }); },
};
const obj = Gio.DBusExportedObject.wrapJSObject(IFACE, impl);
obj.export(Gio.DBus.session, '/dev/morph/Lab/App');
Gio.bus_own_name_on_connection(Gio.DBus.session, 'dev.morph.Lab.App_' + String(args.key || 'x').replace(/[^A-Za-z0-9_]/g, '_'), Gio.BusNameOwnerFlags.NONE, null, null);
win.connect('close-request', () => { loop.quit(); return false; });
win.present();
loop.run();
