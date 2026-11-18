const { ipcRenderer, webFrame } = require('electron');

// Ce code est exécuté dans le contexte de la page (monde principal).
// Il fournit à la page, via getUserMedia, un flux vidéo issu du fichier choisi.
// Rien n'est décodé tant qu'une page ne demande pas la caméra, et tout est libéré à l'arrêt.
function inject(cfg) {
  if (window.__fakecamInstalled) return;
  const md = navigator.mediaDevices;
  if (!md) return;
  window.__fakecamInstalled = true;

  const origGUM = md.getUserMedia.bind(md);
  const origEnum = md.enumerateDevices.bind(md);
  const S = {
    url: cfg.videoUrl, loop: !!cfg.loop, paused: !!cfg.paused,
    outH: Number(cfg.outH) || 0, fps: Number(cfg.fps) || 30
  };

  let v = null;            // élément <video> source
  let loading = null;      // promesse de chargement en cours
  let baseTrack = null;    // piste commune (clonée pour chaque appel)
  let canvas = null;       // utilisé seulement pour RÉDUIRE la résolution
  let users = 0;           // nombre de pistes actives
  let releaseTimer = 0;
  let timeTimer = 0;
  let frameCount = 0;
  let fpsMeasured = 0;
  let fpsTimer = 0;
  let lastDraw = 0;
  let running = false;
  const notify = (a) => { try { window.postMessage({ __fakecamNotify: a }, '*'); } catch (_) {} };

  function startFpsMeter() {
    if (fpsTimer) return;
    let last = frameCount;
    fpsTimer = setInterval(() => { fpsMeasured = frameCount - last; last = frameCount; }, 1000);
  }

  function loop() {
    if (!v || running) return;
    running = true;
    const step = (_now, meta) => {
      if (!v) { running = false; return; }
      frameCount++;
      if (canvas) {
        const t = performance.now();
        if (t - lastDraw >= 1000 / S.fps - 3) {
          lastDraw = t;
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        }
      }
      v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
  }

  function getVideo() {
    if (v && v.readyState >= 2) return Promise.resolve(v);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.muted = true;
      el.loop = S.loop;
      el.playsInline = true;
      el.preload = 'auto';
      el.src = S.url;
      el.addEventListener('error', () => {
        loading = null;
        reject(new DOMException('Vidéo illisible', 'NotReadableError'));
      }, { once: true });
      el.addEventListener('loadeddata', () => {
        v = el;
        loading = null;
        if (S.paused) resolve(el);
        else el.play().then(() => resolve(el), reject);
      }, { once: true });
      el.load();
    });
    return loading;
  }

  async function ensureTrack() {
    if (baseTrack && baseTrack.readyState === 'live') return baseTrack;
    const el = await getVideo();
    const srcH = el.videoHeight;
    // On ne fait JAMAIS d'agrandissement : réduction seulement, et seulement si demandée
    if (S.outH && srcH > S.outH) {
      const h = S.outH;
      const w = Math.round((el.videoWidth * h) / srcH / 2) * 2;
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(el, 0, 0, w, h);
      baseTrack = canvas.captureStream().getVideoTracks()[0];
    } else {
      canvas = null;
      const cs = el.captureStream ? el.captureStream() : el.mozCaptureStream();
      baseTrack = cs.getVideoTracks()[0];
    }
    startFpsMeter();
    loop();
    return baseTrack;
  }

  function release() {
    if (users > 0) return;
    clearInterval(fpsTimer); fpsTimer = 0;
    running = false;
    try { if (baseTrack) baseTrack.stop(); } catch (_) {}
    baseTrack = null;
    canvas = null;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
      v = null;
    }
  }

  function scheduleRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(release, 4000);
  }

  function track(clone) {
    users++;
    clearTimeout(releaseTimer);
    notify(true);
    if (!timeTimer) {
      // Envoie la position de lecture réelle pour que l'aperçu flottant reste synchronisé
      timeTimer = setInterval(() => {
        if (v) { try { window.postMessage({ __fakecamTime: v.currentTime }, '*'); } catch (_) {} }
      }, 2000);
    }
    const origStop = clone.stop.bind(clone);
    let stopped = false;
    const done = () => {
      if (stopped) return;
      stopped = true;
      users = Math.max(0, users - 1);
      if (users === 0) { notify(false); clearInterval(timeTimer); timeTimer = 0; scheduleRelease(); }
    };
    clone.stop = () => { done(); origStop(); };
    clone.addEventListener('ended', done, { once: true });
  }

  // Commandes envoyées par le navigateur : play, pause, toggle, restart, loop, source
  const control = (cmd, arg) => {
    if (cmd === 'pause') S.paused = true;
    else if (cmd === 'play') S.paused = false;
    else if (cmd === 'toggle') S.paused = !S.paused;
    else if (cmd === 'loop') { S.loop = !!arg; if (v) v.loop = S.loop; return; }
    else if (cmd === 'restart') { if (v) v.currentTime = 0; return; }
    else if (cmd === 'source') {
      S.url = arg;
      if (v) {
        v.src = arg;
        if (!S.paused) v.play().catch(() => {});
        else v.load();
      }
      return;
    }
    if (!v) return;
    if (S.paused) v.pause();
    else v.play().catch(() => {});
  };
  Object.defineProperty(window, '__fakecamControl', { value: control, enumerable: false });

  Object.defineProperty(window, '__fakecamStats', {
    enumerable: false,
    value: () => {
      const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const st = baseTrack ? baseTrack.getSettings() : {};
      return {
        active: users > 0,
        paused: S.paused,
        canvas: !!canvas,
        srcW: v ? v.videoWidth : 0,
        srcH: v ? v.videoHeight : 0,
        outW: canvas ? canvas.width : (v ? v.videoWidth : 0),
        outH: canvas ? canvas.height : (v ? v.videoHeight : 0),
        fpsReq: S.fps,
        fpsMeasured,
        dropped: q ? q.droppedVideoFrames : 0,
        total: q ? q.totalVideoFrames : 0,
        trackFps: st.frameRate || null
      };
    }
  });

  md.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.video) return origGUM(constraints);
    const base = await ensureTrack();
    const clone = base.clone();   // chaque appel a sa propre piste : un stop() n'affecte pas les autres
    track(clone);
    const out = new MediaStream([clone]);
    if (S.paused && v) {
      // En pause : on lit un instant pour que la nouvelle piste reçoive une image figée
      try { await v.play(); } catch (_) {}
      setTimeout(() => { if (S.paused && v) v.pause(); }, 150);
    } else if (v && v.paused) {
      try { await v.play(); } catch (_) {}
    }
    if (constraints.audio) {
      try {
        const a = await origGUM({ audio: constraints.audio });
        a.getAudioTracks().forEach((t) => out.addTrack(t));
      } catch (_) { /* pas de micro : on continue sans audio */ }
    }
    return out;
  };

  md.enumerateDevices = async function () {
    let list = [];
    try { list = await origEnum(); } catch (_) {}
    if (!list.some((d) => d.deviceId === 'virtustream-cam')) {
      list.push({
        deviceId: 'virtustream-cam', kind: 'videoinput',
        label: 'VirtuStream Virtual Camera (vidéo)', groupId: 'virtustream',
        toJSON() { return this; }
      });
    }
    return list;
  };

  window.addEventListener('pagehide', () => { users = 0; release(); });
}

// Identité « Google Chrome » complète : userAgentData (brands, versions complètes, plate-forme)
// et objet window.chrome, que les sites (WhatsApp Web appels, Meet…) testent pour reconnaître Chrome.
function spoofBrands(fullVersion) {
  try {
    const major = String(fullVersion).split('.')[0];
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not?A_Brand', version: '99' }
    ];
    const full = [
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
      { brand: 'Not?A_Brand', version: '99.0.0.0' }
    ];
    const ua = navigator.userAgentData;
    if (ua) {
      const proto = Object.getPrototypeOf(ua);
      Object.defineProperty(proto, 'brands', { get: () => brands, configurable: true });
      const origHigh = proto.getHighEntropyValues;
      proto.getHighEntropyValues = async function (hints) {
        let r = {};
        try { r = await origHigh.call(this, hints); } catch (_) {}
        r.brands = brands;
        r.fullVersionList = full;
        r.uaFullVersion = fullVersion;
        return r;
      };
      proto.toJSON = function () {
        return { brands, mobile: this.mobile, platform: this.platform };
      };
    }
  } catch (_) {}
  try {
    if (!window.chrome) window.chrome = {};
    const c = window.chrome;
    if (!c.app) c.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
    if (!c.runtime) c.runtime = {};
    if (!c.loadTimes) c.loadTimes = function () { return {}; };
    if (!c.csi) c.csi = function () { return {}; };
  } catch (_) {}
}
try {
  webFrame.executeJavaScript(`(${spoofBrands.toString()})(${JSON.stringify(process.versions.chrome)})`);
} catch (_) {}

try {
  const cfg = ipcRenderer.sendSync('get-config');
  if (cfg && cfg.videoUrl) {
    webFrame.executeJavaScript(`(${inject.toString()})(${JSON.stringify(cfg)})`);
    // Pont page → processus principal pour savoir si la caméra est utilisée (hibernation, indicateur)
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data) return;
      if (typeof e.data.__fakecamNotify === 'boolean') ipcRenderer.send('cam-state', e.data.__fakecamNotify);
      else if (typeof e.data.__fakecamTime === 'number') ipcRenderer.send('cam-time', e.data.__fakecamTime);
    });
  }
} catch (_) {}

// Commandes lecture / pause / source envoyées par le processus principal
ipcRenderer.on('fakecam-control', (_e, cmd, arg) => {
  try {
    webFrame.executeJavaScript(
      `window.__fakecamControl && window.__fakecamControl(${JSON.stringify(String(cmd))}, ${JSON.stringify(arg === undefined ? null : arg)})`
    );
  } catch (_) {}
});
