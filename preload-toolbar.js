const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('api', {
  nav: call('nav'),
  home: call('home'),
  back: call('back'),
  forward: call('forward'),
  reload: call('reload'),
  newTab: call('new-tab'),
  closeTab: call('close-tab'),
  switchTab: call('switch-tab'),
  tabMenu: call('tab-menu'),
  toggleSidebar: call('toggle-sidebar'),
  toggleBookmark: call('toggle-bookmark'),
  togglePause: call('toggle-pause'),
  openBookmark: call('open-bookmark'),
  removeBookmark: call('remove-bookmark'),
  cameraMenu: call('camera-menu'),
  mainMenu: call('main-menu'),
  showDownload: call('show-download'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusUrl: (cb) => ipcRenderer.on('focus-url', () => cb()),
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m))
});
