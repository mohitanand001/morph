// Runs inside GNOME Shell (sent once through org.gnome.Shell.Eval, which only answers in --unsafe-mode, so only
// in the lab's own throwaway shell). It gives the lab eyes and hands: Morph's actors with their text and exact
// positions, windows and focus, and a virtual mouse and keyboard whose events go through GNOME like real ones.
(function () {
  const { Clutter, GLib, Meta, St } = imports.gi;
  const UUID = 'morph-focus@morph.dev';
  const seat = Clutter.get_default_backend().get_default_seat();
  const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
  const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
  const now = () => GLib.get_monotonic_time();
  const KEYS = { ctrl: Clutter.KEY_Control_L, shift: Clutter.KEY_Shift_L, alt: Clutter.KEY_Alt_L, tab: Clutter.KEY_Tab, esc: Clutter.KEY_Escape, escape: Clutter.KEY_Escape, enter: Clutter.KEY_Return, space: Clutter.KEY_space, up: Clutter.KEY_Up, down: Clutter.KEY_Down, left: Clutter.KEY_Left, right: Clutter.KEY_Right };
  const keyval = (k) => KEYS[k] || Clutter.unicode_to_keysym(k.charCodeAt(0));

  const lab = {
    pill() { const e = Main.extensionManager.lookup(UUID); return e && e.stateObj && e.stateObj._impl; },
    extState() { const e = Main.extensionManager.lookup(UUID); return e ? { state: e.state, error: e.error || '' } : { state: -1, error: 'not found' }; },
    // Every visible Morph actor, depth first: what it says, what it is, where it is on screen.
    tree() {
      const p = this.pill();
      if (!p || !p._root) return [];
      const out = [];
      const focus = global.stage.get_key_focus();
      // Hidden actors take no room and are skipped. Fully transparent ones still take their room (Morph fades
      // things instead of removing them), so they are listed with shown: false.
      const walk = (a, path, parentShown) => {
        if (!a.visible) return;
        const shown = parentShown && a.opacity > 0;
        const [x, y] = a.get_transformed_position();
        const [w, h] = a.get_transformed_size();
        const cls = a.get_style_class_name ? (a.get_style_class_name() || '') : '';
        // St.Label holds its text; a button made with a label draws it with a bare Clutter.Text.
        const par = a.get_parent();
        const text = a instanceof St.Label ? a.text : (a instanceof Clutter.Text && !(par instanceof St.Label) ? a.text : '');
        out.push({ path, cls, text, name: a.accessible_name || '', box: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)], reactive: a.reactive, button: a instanceof St.Button, focus: a === focus, shown, opacity: a.opacity, style: a.get_style ? (a.get_style() || '') : '' });
        a.get_children().forEach((c, i) => walk(c, path + '/' + i, shown));
      };
      walk(p._root, 'root', true);
      if (p._tip && p._tip.visible && p._tip.opacity > 0) walk(p._tip, 'tip', true);
      if (p._setupDlg && p._setupDlg.visible) walk(p._setupDlg, 'setup', true);
      return out;
    },
    state() {
      const p = this.pill();
      if (!p) return { loaded: false, ext: this.extState() };
      const s = p._spec || {};
      return { loaded: true, open: !!p._open, view: s.view || 'main', visible: !!(p._root && p._root.visible), sub: s.sub || '', source: s.source || null, section: s.section || '', primary: s.primary || null, footer: s.footer || null, hasGrab: !!p._grab, setup: !!s.setup, peer: !!p._peer };
    },
    windows() {
      return global.display.list_all_windows().filter((w) => w.get_window_type() === Meta.WindowType.NORMAL)
        .map((w) => ({ app: w.get_wm_class() || '', title: w.get_title() || '', focused: w.has_focus() }));
    },
    activate(match) {
      Main.overview.hide();
      const w = global.display.list_all_windows().find((x) => x.get_window_type() === Meta.WindowType.NORMAL && ((x.get_title() || '') === match || (x.get_wm_class() || '') === match));
      if (!w) return false;
      w.activate(global.get_current_time());
      return true;
    },
    // Finds the clickable actor that shows this text (or whose accessible name is this), as a person would.
    find(text, nth) {
      const p = this.pill();
      if (!p || !p._root) return null;
      const hits = [];
      const roots = [p._root, p._setupDlg].filter(Boolean);
      const walk = (a) => {
        if (!a.visible || a.opacity === 0) return;
        if ((a instanceof St.Label && a.text === text) || (a instanceof St.Button && a.label === text) || (a.accessible_name === text && a.reactive)) {
          let b = a;
          while (b && !(b instanceof St.Button) && !b.reactive) b = b.get_parent();
          if (b) hits.push(b);
        }
        a.get_children().forEach(walk);
      };
      roots.forEach(walk);
      return hits[nth || 0] || null;
    },
    center(a) { const [x, y] = a.get_transformed_position(); const [w, h] = a.get_transformed_size(); return [x + w / 2, y + h / 2]; },
    move(x, y) { ptr.notify_absolute_motion(now(), x, y); return true; },
    click(x, y) {
      ptr.notify_absolute_motion(now(), x, y);
      ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      ptr.notify_button(now() + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      return true;
    },
    clickText(text, nth) {
      const a = this.find(text, nth);
      if (!a) return { ok: false, error: 'nothing on screen says "' + text + '"' };
      if (!a.reactive) return { ok: false, error: '"' + text + '" is shown but cannot be clicked' };
      const [x, y] = this.center(a);
      this.click(x, y);
      return { ok: true, at: [Math.round(x), Math.round(y)] };
    },
    hoverText(text) { const a = this.find(text); if (!a) return false; const [x, y] = this.center(a); this.move(x, y); return true; },
    openPanel() {
      const p = this.pill();
      if (!p || !p._handle || !p._handle.visible) return { ok: false, error: 'the tab is not on screen' };
      const [x, y] = this.center(p._tabHit || p._handle);
      this.click(x, y);
      return { ok: true };
    },
    // "ctrl+v", "tab", "shift+tab", "esc", "ctrl+alt+f"
    keys(combo) {
      const parts = combo.toLowerCase().split('+');
      const vals = parts.map(keyval);
      vals.forEach((v) => kbd.notify_keyval(now(), v, Clutter.KeyState.PRESSED));
      vals.slice().reverse().forEach((v) => kbd.notify_keyval(now() + 1000, v, Clutter.KeyState.RELEASED));
      return true;
    },
    monitor() { const m = Main.layoutManager.primaryMonitor; return [m.x, m.y, m.width, m.height]; },
  };
  globalThis.__morphLab = lab;
  return 'ready';
})();
