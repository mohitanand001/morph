// Bridge for the window pill (Mac, and Linux desktops without the GNOME
// helper). It can receive what to draw, report a click ("fix:jira"), its
// size and drags. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const ACTION_RE = /^[a-z]+:[a-z0-9]*$/;

contextBridge.exposeInMainWorld('pill', {
  platform: process.platform,
  action: (a) => { if (ACTION_RE.test(String(a))) ipcRenderer.send('pill:action', String(a)); },
  size: (w, h, open) => ipcRenderer.send('pill:size', { width: Number(w), height: Number(h), open: !!open }),
  drag: (phase) => { if (['start', 'move', 'end'].includes(phase)) ipcRenderer.send('pill:drag', { phase }); },
  onSpec: (cb) => ipcRenderer.on('pill:spec', (_e, s) => cb(s)),
  onCollapse: (cb) => ipcRenderer.on('pill:collapse', () => cb()),
  onToggle: (cb) => ipcRenderer.on('pill:toggle', () => cb()),
});
