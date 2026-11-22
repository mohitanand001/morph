// FB-LOADER: Morph's GNOME helper, loaded in two parts so an update needs no log out.
//
// GNOME Shell keeps an extension's code in memory until you log out. This tiny file never
// changes. It loads the real helper from impl-<fingerprint>.js (named by impl.txt); an update
// writes a new file name, and turning the extension off and on again loads that fresh code.
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MorphLoader extends Extension {
  enable() {
    this._on = true;
    this._impl = null;
    let name = '';
    try {
      const [, bytes] = GLib.file_get_contents(this.path + '/impl.txt');
      name = new TextDecoder().decode(bytes).trim();
    } catch (e) { log('morph: no impl.txt: ' + e); }
    if (!/^impl-[0-9a-f]{8}\.js$/.test(name)) { log('morph: helper file name looks wrong'); return; }
    import('file://' + this.path + '/' + name).then((m) => {
      if (!this._on) return; // switched off again while loading
      this._impl = new m.default(this.metadata);
      this._impl.enable();
    }).catch((e) => log('morph: could not load the helper: ' + e + '\n' + (e && e.stack)));
  }

  disable() {
    this._on = false;
    try { if (this._impl) this._impl.disable(); } catch (e) { log('morph: helper disable failed: ' + e); }
    this._impl = null;
  }
}
