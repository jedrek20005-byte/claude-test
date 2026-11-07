const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sbNative', {
  setHotkeys: (list) => ipcRenderer.send('hotkeys', list),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action))
});
