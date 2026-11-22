// The only bridge between the popover and the system. The page gets exactly
// these functions and nothing else from Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  readClipboard: () => ipcRenderer.invoke('clip:read'),
  writeClipboard: (payload) => ipcRenderer.invoke('clip:write', payload),
  onShown: (cb) => ipcRenderer.on('popover:shown', () => cb()),
  onClipboardChange: (cb) => ipcRenderer.on('clip:changed', () => cb()),
  onQuickConvert: (cb) => ipcRenderer.on('quick:convert', (_e, dest) => cb(String(dest))),
  hide: () => ipcRenderer.send('popover:hide'),
  setTrayStatus: (text) => ipcRenderer.send('tray:status', String(text)),
  quickDone: (result) => ipcRenderer.send('quick:done', result),
  onSelect: (cb) => ipcRenderer.on('popover:select', (_e, dest) => cb(String(dest))),
  onApps: (cb) => ipcRenderer.on('popover:apps', () => cb()),
  setHistory: (items) => ipcRenderer.send('history:set', Array.isArray(items) ? items.slice(0, 8) : []),
  onUseHistory: (cb) => ipcRenderer.on('history:use', (_e, id, dest) => cb(Number(id), String(dest || ''))),
  onClearHistory: (cb) => ipcRenderer.on('history:clear', () => cb()),
  savePdf: (doc) => ipcRenderer.invoke('pdf:save', { html: String((doc && doc.html) || ''), title: String((doc && doc.title) || '') }),
  pdfDone: (r) => ipcRenderer.send('pdf:done', r),
  onMakePdf: (cb) => ipcRenderer.on('pdf:make', () => cb()),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
});
