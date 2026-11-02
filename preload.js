const { contextBridge, ipcRenderer, webUtils } = require('electron');

ipcRenderer.on('ndi-port', (e) => window.postMessage('ndi-port', '*', e.ports));
ipcRenderer.on('ndi-exit', () => window.postMessage('ndi-exit', '*'));
ipcRenderer.on('displays-changed', () => window.postMessage('displays-changed', '*'));

contextBridge.exposeInMainWorld('native', {
  displays: () => ipcRenderer.invoke('displays'),
  openFiles: (kind, multi = false) => ipcRenderer.invoke('open-files', kind, multi),
  saveFile: (text, name) => ipcRenderer.invoke('save-file', text, name),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  savePng: (dataUrl, name) => ipcRenderer.invoke('save-png', dataUrl, name),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  autosaveWrite: (text) => ipcRenderer.invoke('autosave-write', text),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  selftestShot: (name) => ipcRenderer.invoke('selftest-shot', name),
  selftestWrite: (name, bytes) => ipcRenderer.invoke('selftest-write', name, bytes),
});
