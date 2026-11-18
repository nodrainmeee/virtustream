const {
  app, BrowserWindow, WebContentsView, ipcMain, dialog, protocol, net,
  session, Menu, shell, clipboard, nativeTheme, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// Schéma interne qui sert la vidéo choisie aux pages (CORS requis pour captureStream())
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fakecam',
    privileges: {
      standard: true, secure: true, supportFetchAPI: true,
      corsEnabled: true, stream: true, bypassCSP: true
    }
  }
]);

// ---------- Constantes d'interface ----------
const NAV_H = 48;          // barre d'adresse
const BM_H = 34;           // barre de favoris
const SIDE_C = 52;         // panneau d'onglets réduit
const SIDE_E = 236;        // panneau d'onglets développé
const SIDE_MIN_WINDOW = 820; // en dessous, le panneau reste réduit
const PARTITION = 'persist:virtustream';
const APP_NAME = 'VirtuStream Browser';
const NEWTAB = pathToFileURL(path.join(__dirname, 'newtab.html')).toString();
const TEST_PAGE = pathToFileURL(path.join(__dirname, 'test.html')).toString();

const PALETTE = {
  dark: { frame: '#2b2733', symbol: '#e8e3ee' },
  light: { frame: '#ebe7f1', symbol: '#1f1b24' }
};
const palette = () => (nativeTheme.shouldUseDarkColors ? PALETTE.dark : PALETTE.light);

let win = null;
let ses = null;
const tabs = [];
let activeId = null;
let nextTabId = 1;
let htmlFullscreen = false;
let videoVersion = 1;
let videoPaused = false;
let lastDownload = null;
let config = {
  videoPath: null,
  loop: true,
  bookmarks: [],
  theme: 'system',      // system | light | dark
  outRes: 'native',     // native | 720 | 480 (jamais d'agrandissement)
  fps: 30,              // 15 | 24 | 30
  eco: null,            // null = auto (selon la RAM)
  showBookmarks: true,
  sidebarExpanded: false,
  permissions: {},      // origine -> true/false (caméra / micro)
  audio: { enabled: false, outLabel: '', monitor: true, volume: 0.6 }, // son de l'aperçu → VB-Cable
  autoPreview: true     // ouvre l'aperçu flottant quand une page démarre la caméra
};
let previewWin = null;

// ---------- Configuration ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch (_) { /* première exécution */ }
  if (!Array.isArray(config.bookmarks)) config.bookmarks = [];
  if (!config.permissions || typeof config.permissions !== 'object') config.permissions = {};
  if (!['system', 'light', 'dark'].includes(config.theme)) config.theme = 'system';
  if (!['native', '720', '480'].includes(String(config.outRes))) config.outRes = 'native';
  config.outRes = String(config.outRes);
  if (![15, 24, 30].includes(Number(config.fps))) config.fps = 30;
  config.fps = Number(config.fps);
  if (typeof config.autoPreview !== 'boolean') config.autoPreview = true;
  const a = config.audio && typeof config.audio === 'object' ? config.audio : {};
  config.audio = {
    enabled: !!a.enabled,
    outLabel: typeof a.outLabel === 'string' ? a.outLabel.slice(0, 200) : '',
    monitor: a.monitor !== false,
    volume: Math.min(1, Math.max(0, Number(a.volume) || 0.6))
  };
  if (typeof config.eco !== 'boolean') config.eco = os.totalmem() < 6 * 1024 ** 3; // auto : PC ≤ 4-6 Go
  if (config.videoPath && !fs.existsSync(config.videoPath)) config.videoPath = null;
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(configFile(), JSON.stringify(config)); } catch (_) {}
  }, 200);
}

// ---------- Utilitaires ----------
function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return NEWTAB;
  if (/^(javascript|data|vbscript|fakecam):/i.test(s)) return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(file|about):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^[^\s]+\.[^\s]{2,}$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

function errorPage(url, desc) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>Page inaccessible</title>` +
    `<style>body{font-family:system-ui,"Segoe UI",sans-serif;padding:12vh 10vw;background:#37323f;color:#e8e3ee}` +
    `@media(prefers-color-scheme:light){body{background:#faf8fc;color:#1f1b24}}p{opacity:.8}</style>` +
    `<body><h1>Impossible d’accéder à ce site</h1><p>${esc(url)}</p>` +
    `<p>${esc(desc)}</p><p>Vérifiez votre connexion internet puis actualisez la page.</p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${name} (${i})${ext}`))) i++;
  return path.join(dir, `${name} (${i})${ext}`);
}

const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ''; } };
const activeTab = () => tabs.find((t) => t.id === activeId);
const alive = () => win && !win.isDestroyed();
const wcOf = (t) => (t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null);

function toast(msg) {
  if (alive()) win.webContents.send('toast', msg);
}

function currentUrl(tab) {
  const wc = wcOf(tab);
  if (!wc) return tab.url || '';
  const raw = wc.getURL();
  if (raw.startsWith('data:') && tab.failedUrl) return tab.failedUrl;
  return raw || tab.url || '';
}

// ---------- Mise en page ----------
const sideWidth = () => {
  if (htmlFullscreen || !alive()) return 0;
  const [w] = win.getContentSize();
  return config.sidebarExpanded && w >= SIDE_MIN_WINDOW ? SIDE_E : SIDE_C;
};
const topHeight = () => (htmlFullscreen ? 0 : NAV_H + (config.showBookmarks ? BM_H : 0));

function layout() {
  if (!alive()) return;
  const tab = activeTab();
  if (!tab || !tab.view) return;
  const [w, h] = win.getContentSize();
  const x = sideWidth();
  const y = topHeight();
  tab.view.setBounds({ x, y, width: Math.max(0, w - x), height: Math.max(0, h - y) });
}

// ---------- État envoyé à l'interface ----------
let stateTimer = null;
function sendState() {
  if (!alive()) return;
  if (stateTimer) return;               // regroupe les rafales d'événements
  stateTimer = setTimeout(() => { stateTimer = null; sendStateNow(); }, 30);
}

function sendStateNow() {
  if (!alive()) return;
  const tab = activeTab();
  let url = '';
  let canGoBack = false;
  let canGoForward = false;
  let loading = false;
  const wc = wcOf(tab);
  if (wc) {
    url = currentUrl(tab);
    if (url.startsWith('file:')) url = '';
    canGoBack = wc.navigationHistory.canGoBack();
    canGoForward = wc.navigationHistory.canGoForward();
    loading = wc.isLoading();
  }
  win.webContents.send('state', {
    tabs: tabs.map((t) => {
      const w = wcOf(t);
      return {
        id: t.id, title: t.title, favicon: t.favicon,
        loading: !!w && w.isLoading(),
        cam: t.cams.size > 0,
        hibernated: !t.view
      };
    }),
    activeId, url, canGoBack, canGoForward, loading,
    bookmarks: config.bookmarks,
    isBookmarked: !!url && config.bookmarks.some((b) => b.url === url),
    videoName: config.videoPath ? path.basename(config.videoPath) : null,
    videoPaused,
    loop: config.loop,
    sideW: sideWidth(),
    sideExpanded: sideWidth() === SIDE_E,
    showBookmarks: config.showBookmarks,
    fullscreen: htmlFullscreen,
    eco: config.eco,
    camActive: tabs.some((t) => t.cams.size > 0),
    previewOpen: !!previewWin && !previewWin.isDestroyed()
  });
}

// ---------- Onglets ----------
function buildView(tab, url) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegrationInSubFrames: true,
      partition: PARTITION,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false
    }
  });
  tab.view = view;
  tab.hibernated = false;
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) createTab(u);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (_e, title) => { tab.title = title || tab.title; sendState(); });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; sendState(); });
  wc.on('did-navigate', (_e, navUrl) => {
    if (!navUrl.startsWith('data:')) tab.failedUrl = null;
    tab.favicon = null;
    tab.cams.clear();
    sendState();
  });
  ['did-navigate-in-page', 'did-start-loading', 'did-stop-loading']
    .forEach((ev) => wc.on(ev, sendState));
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    tab.failedUrl = validatedURL;
    tab.title = 'Page inaccessible';
    wc.loadURL(errorPage(validatedURL, desc)).catch(() => {});
  });
  wc.on('enter-html-full-screen', () => { htmlFullscreen = true; if (alive()) win.setFullScreen(true); layout(); sendState(); });
  wc.on('leave-html-full-screen', () => { htmlFullscreen = false; if (alive()) win.setFullScreen(false); layout(); sendState(); });

  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Ouvrir le lien dans un nouvel onglet', click: () => createTab(p.linkURL) },
        { label: 'Copier l’adresse du lien', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' });
    }
    if (!p.isEditable && !p.selectionText && !p.linkURL) {
      items.push(
        { label: 'Précédent', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Suivant', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Actualiser', click: () => actions.reload() }
      );
    }
    items.push({ type: 'separator' }, { label: 'Inspecter', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  wc.loadURL(url || NEWTAB).catch(() => {});
}

function createTab(url, activate = true) {
  const tab = {
    id: nextTabId++, view: null, title: 'Nouvel onglet', favicon: null,
    failedUrl: null, url: url || NEWTAB, hibernated: false,
    lastActive: Date.now(), cams: new Set()
  };
  tabs.push(tab);
  buildView(tab, tab.url);
  if (activate) switchTo(tab.id);
  else sendState();
  return tab;
}

function switchTo(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || !alive()) return;
  const old = activeTab();
  if (old && old !== tab) {
    old.lastActive = Date.now();
    if (old.view) { try { win.contentView.removeChildView(old.view); } catch (_) {} }
  }
  if (!tab.view) buildView(tab, tab.url);   // réveil d'un onglet en veille
  activeId = id;
  tab.lastActive = Date.now();
  win.contentView.addChildView(tab.view);
  layout();
  tab.view.webContents.focus();
  sendStateNow();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  if (tabs.length === 1) { if (alive()) win.close(); return; }
  const tab = tabs[i];
  tabs.splice(i, 1);
  if (tab.view) {
    if (alive()) { try { win.contentView.removeChildView(tab.view); } catch (_) {} }
    try { tab.view.webContents.close(); } catch (_) {}
    tab.view = null;
  }
  if (activeId === id) switchTo(tabs[Math.min(i, tabs.length - 1)].id);
  else sendState();
}

function closeOthers(id) {
  tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id));
  switchTo(id);
}

function cycleTab(delta) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  switchTo(tabs[(i + delta + tabs.length) % tabs.length].id);
}

// Veille des onglets inactifs : libère la RAM (un onglet = un processus Chromium)
function hibernate(tab) {
  const wc = wcOf(tab);
  if (!wc) return;
  tab.url = currentUrl(tab);
  tab.hibernated = true;
  tab.cams.clear();
  try { win.contentView.removeChildView(tab.view); } catch (_) {}
  try { wc.close(); } catch (_) {}
  tab.view = null;
}

function startHibernationSweep() {
  setInterval(() => {
    if (!alive()) return;
    const limit = (config.eco ? 3 : 10) * 60 * 1000;
    const now = Date.now();
    let changed = false;
    tabs.forEach((t) => {
      if (t.id === activeId || !t.view) return;
      const wc = wcOf(t);
      if (!wc || t.cams.size || wc.isCurrentlyAudible() || wc.isLoading()) return;
      const url = currentUrl(t);
      if (!/^https?:/i.test(url)) return;
      // On ne met jamais en veille un site auquel la caméra / le micro a été accordé (appels, messageries)
      if (config.permissions[originOf(url)] === true) return;
      if (now - t.lastActive > limit) { hibernate(t); changed = true; }
    });
    if (changed) sendState();
  }, 60 * 1000);
}

// ---------- Caméra (vidéo) ----------
const currentVideoUrl = () => (config.videoPath ? `fakecam://video/current?v=${videoVersion}` : null);

function reloadAll() {
  tabs.forEach((t) => { const wc = wcOf(t); if (wc) wc.reload(); });
  sendState();
}

async function pickVideo() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir une vidéo',
    properties: ['openFile'],
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'] }]
  });
  if (r.canceled || !r.filePaths[0]) return;
  const file = r.filePaths[0];
  try {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error('vide');
  } catch (_) { toast('Fichier vidéo illisible'); return; }
  const had = !!config.videoPath;
  config.videoPath = file;
  videoPaused = false;
  videoVersion++;
  saveConfig();
  if (had) {
    // Remplacement à chaud : les pages gardent leur flux, sans rechargement
    sendVideoCommand('source', currentVideoUrl());
    sendState();
    toast('Vidéo remplacée : ' + path.basename(file));
  } else {
    reloadAll(); // première sélection : les pages doivent recharger pour recevoir la caméra virtuelle
    toast('Caméra virtuelle prête : ' + path.basename(file));
  }
}

function clearVideo() {
  config.videoPath = null;
  videoPaused = false;
  videoVersion++;
  saveConfig();
  closePreview();
  sendState();
  toast('Vidéo retirée. Rechargez la page pour retrouver la caméra réelle.');
}

function setLoop(v) {
  config.loop = !!v;
  saveConfig();
  sendVideoCommand('loop', config.loop);
  sendState();
}

function sendVideoCommand(cmd, arg) {
  tabs.forEach((t) => {
    const wc = wcOf(t);
    if (!wc) return;
    wc.mainFrame.framesInSubtree.forEach((f) => {
      try { f.send('fakecam-control', cmd, arg); } catch (_) {}
    });
  });
  previewSend(cmd, arg);
}

function setPaused(p) {
  if (!config.videoPath) return;
  videoPaused = !!p;
  sendVideoCommand(videoPaused ? 'pause' : 'play');
  sendState();
}
const togglePause = () => setPaused(!videoPaused);

function restartVideo() {
  if (config.videoPath) sendVideoCommand('restart');
}

function setOutRes(v) {
  config.outRes = String(v);
  saveConfig();
  toast('Résolution de sortie appliquée au prochain démarrage de la caméra');
}

function setFps(v) {
  config.fps = Number(v);
  saveConfig();
  toast('Fréquence appliquée au prochain démarrage de la caméra');
}

async function showStats() {
  const wc = wcOf(activeTab());
  let s = null;
  if (wc) {
    for (const f of wc.mainFrame.framesInSubtree) {
      try {
        const r = await f.executeJavaScript('window.__fakecamStats ? window.__fakecamStats() : null');
        if (r && r.active) { s = r; break; }
        if (r && !s) s = r;
      } catch (_) {}
    }
  }
  const metrics = app.getAppMetrics();
  const memMb = Math.round(metrics.reduce((a, m) => a + (m.memory.workingSetSize || 0), 0) / 1024);
  const cpu = metrics.reduce((a, m) => a + (m.cpu.percentCPUUsage || 0), 0).toFixed(1);
  let decode = 'inconnu';
  try { decode = app.getGPUFeatureStatus().video_decode; } catch (_) {}
  const lines = [];
  if (s && s.active) {
    lines.push(
      `Résolution source : ${s.srcW} × ${s.srcH}`,
      `Résolution de sortie : ${s.outW} × ${s.outH}${s.canvas ? ' (réduction de qualité supérieure)' : ' (flux direct, sans retraitement)'}`,
      `FPS demandés : ${s.fpsReq}`,
      `FPS mesurés : ${s.fpsMeasured}`,
      `Images perdues (décodeur) : ${s.dropped} sur ${s.total}`,
      `État : ${s.paused ? 'en pause' : 'diffusion en cours'}`
    );
  } else {
    lines.push('Aucune page de cet onglet n’utilise la caméra virtuelle pour le moment.');
  }
  lines.push(
    '',
    `Décodage vidéo GPU (Chromium) : ${decode}`,
    `Mémoire de l’application : ${memMb} Mo`,
    `Utilisation CPU instantanée : ${cpu} %`,
    `Onglets actifs / en veille : ${tabs.filter((t) => t.view).length} / ${tabs.filter((t) => !t.view).length}`
  );
  dialog.showMessageBox(win, { type: 'info', title: 'Statistiques de la caméra', message: 'Statistiques en direct', detail: lines.join('\n') });
}

// ---------- Aperçu flottant (voir la vidéo sans être sur l'onglet qui utilise la caméra) ----------
const previewAlive = () => previewWin && !previewWin.isDestroyed();

function previewSend(cmd, arg) {
  if (previewAlive()) { try { previewWin.webContents.send('pv-cmd', cmd, arg === undefined ? null : arg); } catch (_) {} }
}

function openPreview() {
  if (!config.videoPath || !alive()) return;
  if (previewAlive()) { previewWin.showInactive(); return; }
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const w = 440;
  const h = 300;
  previewWin = new BrowserWindow({
    width: w, height: h,
    x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16,
    minWidth: 260, minHeight: 190,
    title: 'Aperçu de la caméra',
    alwaysOnTop: true, show: false, autoHideMenuBar: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-preview.js'),
      contextIsolation: true, sandbox: true, partition: PARTITION,
      autoplayPolicy: 'no-user-gesture-required', spellcheck: false
    }
  });
  previewWin.setMenu(null);
  previewWin.setAlwaysOnTop(true, 'floating');
  previewWin.loadFile(path.join(__dirname, 'preview.html'), {
    query: { src: currentVideoUrl(), loop: config.loop ? '1' : '0', paused: videoPaused ? '1' : '0' }
  });
  previewWin.once('ready-to-show', () => { if (previewAlive()) previewWin.showInactive(); });
  previewWin.on('closed', () => { previewWin = null; sendState(); });
  sendState();
}

function closePreview() {
  if (previewAlive()) previewWin.close();
}

function togglePreview() {
  if (previewAlive()) closePreview(); else openPreview();
}

function cameraMenuItems() {
  return [
    {
      label: config.videoPath ? `Vidéo : ${path.basename(config.videoPath)}` : 'Aucune vidéo (caméra réelle)',
      enabled: false
    },
    { label: 'Choisir une vidéo…', accelerator: 'CmdOrCtrl+Shift+V', click: pickVideo },
    {
      label: videoPaused ? 'Reprendre la lecture' : 'Mettre en pause',
      accelerator: 'CmdOrCtrl+Shift+P',
      enabled: !!config.videoPath,
      click: togglePause
    },
    { label: 'Redémarrer la vidéo', enabled: !!config.videoPath, click: restartVideo },
    { label: 'Retirer la vidéo', enabled: !!config.videoPath, click: clearVideo },
    { label: 'Lire en boucle', type: 'checkbox', checked: config.loop, click: (mi) => setLoop(mi.checked) },
    { type: 'separator' },
    { label: 'Aperçu flottant de la vidéo', type: 'checkbox', checked: previewAlive(), enabled: !!config.videoPath, click: togglePreview },
    {
      label: 'Ouvrir l’aperçu quand une page démarre la caméra',
      type: 'checkbox', checked: !!config.autoPreview,
      click: (mi) => { config.autoPreview = mi.checked; saveConfig(); }
    },
    { type: 'separator' },
    {
      label: 'Résolution de sortie',
      submenu: [
        { label: 'Native (recommandé, aucune perte)', type: 'radio', checked: config.outRes === 'native', click: () => setOutRes('native') },
        { label: '720p maximum', type: 'radio', checked: config.outRes === '720', click: () => setOutRes('720') },
        { label: '480p maximum (économie)', type: 'radio', checked: config.outRes === '480', click: () => setOutRes('480') }
      ]
    },
    {
      label: 'Fréquence d’images',
      submenu: [15, 24, 30].map((f) => ({
        label: `${f} images/s`, type: 'radio', checked: config.fps === f, click: () => setFps(f)
      }))
    },
    { label: 'Statistiques en direct…', click: showStats }
  ];
}

// ---------- Actions (menu, raccourcis, boutons) ----------
const actions = {
  newTab() {
    createTab(NEWTAB);
    if (alive()) { win.webContents.focus(); win.webContents.send('focus-url'); }
  },
  closeTab() { const t = activeTab(); if (t) closeTab(t.id); },
  reload() {
    const t = activeTab();
    const wc = wcOf(t);
    if (!wc) return;
    if (t.failedUrl && wc.getURL().startsWith('data:')) wc.loadURL(t.failedUrl).catch(() => {});
    else if (wc.isLoading()) wc.stop();
    else wc.reload();
  },
  hardReload() { const wc = wcOf(activeTab()); if (wc) wc.reloadIgnoringCache(); },
  back() { const wc = wcOf(activeTab()); if (wc) wc.navigationHistory.goBack(); },
  forward() { const wc = wcOf(activeTab()); if (wc) wc.navigationHistory.goForward(); },
  home() { const wc = wcOf(activeTab()); if (wc) wc.loadURL(NEWTAB).catch(() => {}); },
  zoom(delta) { const wc = wcOf(activeTab()); if (wc) wc.setZoomLevel(wc.getZoomLevel() + delta); },
  zoomReset() { const wc = wcOf(activeTab()); if (wc) wc.setZoomLevel(0); },
  devtools() { const wc = wcOf(activeTab()); if (wc) wc.toggleDevTools(); },
  print() { const wc = wcOf(activeTab()); if (wc) wc.print(); },
  focusUrl() {
    if (!alive()) return;
    win.webContents.focus();
    win.webContents.send('focus-url');
  },
  toggleBookmarkBar() {
    config.showBookmarks = !config.showBookmarks;
    saveConfig(); layout(); sendStateNow();
  },
  toggleSidebar() {
    config.sidebarExpanded = !config.sidebarExpanded;
    saveConfig(); layout(); sendStateNow();
  },
  toggleBookmark() {
    const t = activeTab();
    if (!t) return;
    const url = currentUrl(t);
    if (!/^https?:/i.test(url)) return;
    const i = config.bookmarks.findIndex((b) => b.url === url);
    if (i >= 0) config.bookmarks.splice(i, 1);
    else config.bookmarks.push({ title: t.title || url, url });
    saveConfig();
    sendState();
  },
  async clearData() {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Effacer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: 'Effacer les données de navigation ?',
      detail: 'Cookies, cache et données des sites seront supprimés (vous serez déconnecté des sites).'
    });
    if (r.response !== 0) return;
    await ses.clearStorageData();
    await ses.clearCache();
    reloadAll();
    toast('Données de navigation effacées');
  },
  resetPermissions() {
    config.permissions = {};
    saveConfig();
    toast('Autorisations caméra / micro réinitialisées');
  }
};

function setTheme(t) {
  config.theme = t;
  nativeTheme.themeSource = t;
  saveConfig();
  applyTitleOverlay();
}

function applyTitleOverlay() {
  if (!alive()) return;
  const p = palette();
  win.setBackgroundColor(p.frame);
  if (process.platform === 'win32') {
    try { win.setTitleBarOverlay({ color: p.frame, symbolColor: p.symbol, height: NAV_H }); } catch (_) {}
  }
}

function mainMenuTemplate() {
  return [
    { label: 'Nouvel onglet', accelerator: 'CmdOrCtrl+T', click: actions.newTab },
    { label: 'Imprimer…', accelerator: 'CmdOrCtrl+P', click: actions.print },
    { type: 'separator' },
    { label: 'Caméra virtuelle', submenu: cameraMenuItems() },
    {
      label: 'Zoom',
      submenu: [
        { label: 'Agrandir', click: () => actions.zoom(0.5) },
        { label: 'Réduire', click: () => actions.zoom(-0.5) },
        { label: 'Réinitialiser (100 %)', click: actions.zoomReset }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Afficher la barre de favoris', type: 'checkbox', checked: config.showBookmarks, click: actions.toggleBookmarkBar },
        {
          label: 'Thème',
          submenu: [
            { label: 'Automatique (Windows)', type: 'radio', checked: config.theme === 'system', click: () => setTheme('system') },
            { label: 'Clair', type: 'radio', checked: config.theme === 'light', click: () => setTheme('light') },
            { label: 'Sombre', type: 'radio', checked: config.theme === 'dark', click: () => setTheme('dark') }
          ]
        }
      ]
    },
    {
      label: 'Mode économique (PC avec peu de RAM)',
      type: 'checkbox',
      checked: !!config.eco,
      click: (mi) => { config.eco = mi.checked; saveConfig(); sendState(); }
    },
    { label: 'Aperçu flottant de la vidéo', enabled: !!config.videoPath, click: togglePreview },
    { label: 'Page de test de la caméra', click: () => createTab(TEST_PAGE) },
    { label: 'Outils de développement', accelerator: 'F12', click: actions.devtools },
    { type: 'separator' },
    { label: 'Effacer les données de navigation…', click: actions.clearData },
    { label: 'Réinitialiser les autorisations caméra / micro', click: actions.resetPermissions },
    { label: 'Dossier des téléchargements', click: () => shell.openPath(app.getPath('downloads')) },
    { type: 'separator' },
    {
      label: 'À propos',
      click: () => dialog.showMessageBox(win, {
        type: 'info',
        message: APP_NAME,
        detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\n\n` +
          'La caméra virtuelle fonctionne dans les pages ouvertes dans ce navigateur. ' +
          'Elle n’installe aucun pilote caméra Windows.'
      })
    },
    { role: 'quit', label: 'Quitter' }
  ];
}

function buildAppMenu() {
  const template = [
    {
      label: 'Fichier',
      submenu: [
        { label: 'Nouvel onglet', accelerator: 'CmdOrCtrl+T', click: actions.newTab },
        { label: 'Fermer l’onglet', accelerator: 'CmdOrCtrl+W', click: actions.closeTab },
        { label: 'Imprimer…', accelerator: 'CmdOrCtrl+P', click: actions.print },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Actualiser', accelerator: 'CmdOrCtrl+R', click: actions.reload },
        { label: 'Actualiser (F5)', accelerator: 'F5', click: actions.reload },
        { label: 'Actualiser sans cache', accelerator: 'CmdOrCtrl+Shift+R', click: actions.hardReload },
        { type: 'separator' },
        { label: 'Zoom +', accelerator: 'CmdOrCtrl+Plus', click: () => actions.zoom(0.5) },
        { label: 'Zoom + (=)', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom(0.5) },
        { label: 'Zoom -', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom(-0.5) },
        { label: 'Zoom 100 %', accelerator: 'CmdOrCtrl+0', click: actions.zoomReset },
        { type: 'separator' },
        { label: 'Panneau d’onglets réduit / développé', accelerator: 'CmdOrCtrl+Shift+E', click: actions.toggleSidebar },
        { label: 'Barre de favoris', accelerator: 'CmdOrCtrl+Shift+B', click: actions.toggleBookmarkBar },
        { label: 'Outils de développement', accelerator: 'F12', click: actions.devtools },
        { label: 'Outils de développement (Ctrl+Maj+I)', accelerator: 'CmdOrCtrl+Shift+I', click: actions.devtools },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Précédent', accelerator: 'Alt+Left', click: actions.back },
        { label: 'Suivant', accelerator: 'Alt+Right', click: actions.forward },
        { label: 'Onglet suivant', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: 'Onglet précédent', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
        { label: 'Barre d’adresse', accelerator: 'CmdOrCtrl+L', click: actions.focusUrl },
        { label: 'Barre d’adresse (F6)', accelerator: 'F6', click: actions.focusUrl },
        { label: 'Ajouter / retirer le favori', accelerator: 'CmdOrCtrl+D', click: actions.toggleBookmark }
      ]
    },
    {
      label: 'Caméra',
      submenu: [
        { label: 'Choisir une vidéo…', accelerator: 'CmdOrCtrl+Shift+V', click: pickVideo },
        { label: 'Lecture / pause', accelerator: 'CmdOrCtrl+Shift+P', click: togglePause },
        { label: 'Redémarrer la vidéo', click: restartVideo },
        { label: 'Retirer la vidéo', click: clearVideo },
        { label: 'Statistiques en direct…', click: showStats }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Session (permissions, vidéo, téléchargements) ----------
function isTrustedLocal(url) {
  return url.startsWith(TEST_PAGE.split('test.html')[0]) && (url.includes('test.html') || url.includes('preview.html'));
}

async function askMedia(url) {
  if (isTrustedLocal(url)) return true;
  const origin = originOf(url);
  if (!/^https:\/\//i.test(origin) && !/^http:\/\/localhost(:\d+)?$/i.test(origin)) return false;
  if (typeof config.permissions[origin] === 'boolean') return config.permissions[origin];
  if (!alive()) return false;
  const host = new URL(origin).host;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Autoriser', 'Refuser'],
    defaultId: 1,
    cancelId: 1,
    message: `${host} souhaite utiliser la caméra et le micro`,
    detail: config.videoPath
      ? 'La vidéo que vous avez choisie sera envoyée à ce site comme flux de la caméra virtuelle. Le micro reste votre micro réel.'
      : 'Aucune vidéo n’est choisie : le site utilisera votre caméra réelle.',
    checkboxLabel: 'Mémoriser ce choix pour ce site',
    checkboxChecked: true
  });
  const ok = r.response === 0;
  if (r.checkboxChecked) { config.permissions[origin] = ok; saveConfig(); }
  return ok;
}

function setupSession() {
  ses = session.fromPartition(PARTITION);
  // Les sites (WhatsApp, Meet…) refusent les navigateurs « Electron » : on se présente comme Chrome
  const major = String(process.versions.chrome).split('.')[0];
  ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
  const chBrands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      const l = k.toLowerCase();
      if (l === 'sec-ch-ua') h[k] = chBrands;
    }
    cb({ requestHeaders: h });
  });
  const simple = ['fullscreen', 'clipboard-sanitized-write', 'notifications'];
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') {
      askMedia((details && details.requestingUrl) || wc.getURL()).then(cb).catch(() => cb(false));
    } else cb(simple.includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'media') {
      // Les sites (WhatsApp…) interrogent l'état avant d'appeler la caméra : on répond « autorisé »
      // tant que vous n'avez pas refusé ce site. La vraie demande s'affiche à l'utilisation.
      if (/^file:/i.test(String(requestingOrigin))) return true; // pages internes (aperçu : noms des sorties audio)
      if (!/^https:\/\//i.test(requestingOrigin) && !/^http:\/\/localhost(:\d+)?$/i.test(requestingOrigin)) return false;
      return config.permissions[requestingOrigin] !== false;
    }
    return simple.includes(permission);
  });

  ses.protocol.handle('fakecam', async (request) => {
    if (!config.videoPath) return new Response('Aucune video', { status: 404 });
    try {
      const upstream = await net.fetch(pathToFileURL(config.videoPath).toString(), {
        headers: request.headers
      });
      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (_) {
      return new Response('Erreur de lecture', { status: 500 });
    }
  });

  ses.on('will-download', (_e, item) => {
    const target = uniquePath(path.join(app.getPath('downloads'), path.basename(item.getFilename())));
    item.setSavePath(target);
    toast(`Téléchargement : ${path.basename(target)}`);
    item.once('done', (_ev, state) => {
      if (state === 'completed') {
        lastDownload = target;
        toast(`Téléchargé : ${path.basename(target)} (cliquer pour afficher)`);
      } else {
        toast('Téléchargement échoué');
      }
    });
  });
}

// ---------- Fenêtre ----------
function createWindow(firstUrl) {
  tabs.length = 0;
  activeId = null;
  htmlFullscreen = false;

  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const p = palette();
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 320,
    title: APP_NAME,
    backgroundColor: p.frame,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: p.frame, symbolColor: p.symbol, height: NAV_H },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-toolbar.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'toolbar.html'));

  let resizeTimer = null;
  win.on('resize', () => {
    layout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendStateNow, 60);
  });
  win.webContents.on('did-finish-load', sendStateNow);
  win.on('closed', () => {
    closePreview();
    tabs.forEach((t) => { try { if (t.view) t.view.webContents.close(); } catch (_) {} });
    tabs.length = 0;
    win = null;
  });

  createTab(firstUrl || NEWTAB);
}

function setupIpc() {
  // Appelé de façon synchrone par preload-page.js au chargement de chaque page
  ipcMain.on('get-config', (e) => {
    e.returnValue = {
      videoUrl: currentVideoUrl(),
      loop: config.loop,
      paused: videoPaused,
      outH: config.outRes === 'native' ? 0 : Number(config.outRes),
      fps: config.fps
    };
  });

  // Une page signale qu'elle utilise (ou n'utilise plus) la caméra virtuelle
  ipcMain.on('cam-state', (e, active) => {
    const tab = tabs.find((t) => t.view && !t.view.webContents.isDestroyed() && t.view.webContents.id === e.sender.id);
    if (!tab) return;
    const key = `${e.processId}:${e.frameId}`;
    const before = tabs.some((t) => t.cams.size > 0);
    if (active) tab.cams.add(key); else tab.cams.delete(key);
    if (!before && active && config.autoPreview) openPreview();
    sendState();
  });

  // Position de lecture réelle de la vidéo envoyée : l'aperçu se recale dessus
  ipcMain.on('cam-time', (_e, t) => { if (typeof t === 'number') previewSend('time', t); });
  ipcMain.on('preview-size', (e, w, h) => {
    if (!previewAlive() || e.sender !== previewWin.webContents) return;
    if (w > 0 && h > 0) previewWin.setAspectRatio(w / h);
  });
  ipcMain.handle('toggle-preview', togglePreview);
  ipcMain.handle('pv-get', (e) => (previewAlive() && e.sender === previewWin.webContents ? config.audio : null));
  ipcMain.handle('pv-set', (e, p) => {
    if (!previewAlive() || e.sender !== previewWin.webContents || !p) return;
    config.audio = {
      enabled: !!p.enabled,
      outLabel: typeof p.outLabel === 'string' ? p.outLabel.slice(0, 200) : '',
      monitor: p.monitor !== false,
      volume: Math.min(1, Math.max(0, Number(p.volume) || 0))
    };
    saveConfig();
  });

  ipcMain.handle('nav', (_e, url) => {
    const wc = wcOf(activeTab());
    if (wc) { wc.loadURL(normalizeUrl(url)).catch(() => {}); wc.focus(); }
  });
  ipcMain.handle('home', actions.home);
  ipcMain.handle('back', actions.back);
  ipcMain.handle('forward', actions.forward);
  ipcMain.handle('reload', actions.reload);
  ipcMain.handle('new-tab', actions.newTab);
  ipcMain.handle('close-tab', (_e, id) => closeTab(id));
  ipcMain.handle('switch-tab', (_e, id) => switchTo(id));
  ipcMain.handle('toggle-sidebar', actions.toggleSidebar);
  ipcMain.handle('toggle-bookmark', actions.toggleBookmark);
  ipcMain.handle('open-bookmark', (_e, url) => {
    if (!/^https?:/i.test(String(url))) return;
    const wc = wcOf(activeTab());
    if (wc) wc.loadURL(url).catch(() => {});
  });
  ipcMain.handle('remove-bookmark', (_e, url) => {
    config.bookmarks = config.bookmarks.filter((b) => b.url !== url);
    saveConfig();
    sendState();
  });

  ipcMain.handle('tab-menu', (_e, id, x, y) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    Menu.buildFromTemplate([
      { label: 'Nouvel onglet', click: actions.newTab },
      { label: 'Actualiser', click: () => { const wc = wcOf(tab); if (wc) wc.reload(); } },
      { label: 'Dupliquer', click: () => createTab(currentUrl(tab)) },
      { type: 'separator' },
      { label: 'Fermer l’onglet', click: () => closeTab(id) },
      { label: 'Fermer les autres onglets', enabled: tabs.length > 1, click: () => closeOthers(id) }
    ]).popup({ window: win, x, y });
  });

  ipcMain.handle('toggle-pause', togglePause);
  ipcMain.handle('camera-menu', (_e, x, y) => {
    Menu.buildFromTemplate(cameraMenuItems()).popup({ window: win, x, y });
  });
  ipcMain.handle('main-menu', (_e, x, y) => {
    Menu.buildFromTemplate(mainMenuTemplate()).popup({ window: win, x, y });
  });
  ipcMain.handle('show-download', () => {
    if (lastDownload) shell.showItemInFolder(lastDownload);
    else shell.openPath(app.getPath('downloads'));
  });
}

// ---------- Démarrage ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!alive()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const u = argv.find((a) => /^https?:\/\//i.test(a));
    if (u) createTab(u);
  });

  app.whenReady().then(() => {
    loadConfig();
    nativeTheme.themeSource = config.theme;
    nativeTheme.on('updated', applyTitleOverlay);
    setupSession();
    setupIpc();
    buildAppMenu();
    const startUrl = process.argv.find((a) => /^https?:\/\//i.test(a));
    createWindow(startUrl);
    startHibernationSweep();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
