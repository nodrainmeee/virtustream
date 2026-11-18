const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pv', {
  onCommand: (cb) => ipcRenderer.on('pv-cmd', (_e, cmd, arg) => cb(cmd, arg)),
  size: (w, h) => ipcRenderer.send('preview-size', w, h),
  getPrefs: () => ipcRenderer.invoke('pv-get'),
  setPrefs: (p) => ipcRenderer.invoke('pv-set', p)
});
