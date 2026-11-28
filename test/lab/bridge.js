// The lab's line to the desktop: a gjs process that makes D-Bus calls for the Node test runner.
// Node writes one JSON request per line on stdin; this answers one JSON line per request on stdout.
//   { id, op: 'eval', code }                          GNOME Shell's Eval (the lab shell runs with --unsafe-mode)
//   { id, op: 'call', dest, path, iface, method, sig, args, out }   any method call
// It is also, on purpose, a "stranger": not Morph's program, so Morph's helper must refuse it.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const bus = Gio.DBus.session;
let GioUnix = null;
try { GioUnix = (await import('gi://GioUnix')).default; } catch (e) { /* older GLib: the classes are on Gio */ }
const InputStream = GioUnix && GioUnix.InputStream ? GioUnix.InputStream : Gio.UnixInputStream;
const stdin = new Gio.DataInputStream({ base_stream: new InputStream({ fd: 0, close_fd: false }) });
const reply = (o) => { print(JSON.stringify(o)); };

function call(req) {
  const params = req.sig ? new GLib.Variant('(' + req.sig + ')', req.args || []) : null;
  bus.call(req.dest, req.path, req.iface, req.method, params, req.out ? new GLib.VariantType('(' + req.out + ')') : null,
    Gio.DBusCallFlags.NONE, req.timeout || 20000, null, (c, res) => {
      try {
        const v = c.call_finish(res);
        reply({ id: req.id, ok: true, result: v ? v.deepUnpack() : null });
      } catch (e) {
        reply({ id: req.id, ok: false, error: String(e.message || e), dbusError: Gio.DBusError.get_remote_error(e) || '' });
      }
    });
}
function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  if (req.op === 'eval') {
    call({ id: req.id, dest: 'org.gnome.Shell', path: '/org/gnome/Shell', iface: 'org.gnome.Shell', method: 'Eval', sig: 's', args: [req.code], out: 'bs', timeout: req.timeout });
  } else if (req.op === 'call') {
    call(req);
  }
}
function next() {
  stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
    let line;
    try { [line] = s.read_line_finish_utf8(res); } catch (e) { loop.quit(); return; }
    if (line === null) { loop.quit(); return; }
    handle(line);
    next();
  });
}
const loop = new GLib.MainLoop(null, false);
next();
loop.run();
