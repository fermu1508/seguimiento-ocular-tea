// Seguimiento ocular con cámara web: MediaPipe Face Landmarker (478 puntos,
// incluye iris) + modelo de regresión de cresta (ridge) entrenado en la
// calibración que convierte rasgos oculares/cefálicos en coordenadas de
// pantalla. El video NUNCA sale del navegador: sólo se guardan coordenadas.

import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

import { extractFeatures } from './features.js';
export { extractFeatures };

export { GazeModel, HEAD_LIMITS } from './gaze-model.js';

// ---------- Filtro One-Euro (sólo para la retroalimentación en pantalla) ----------
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.01, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; }
  alpha(c, dt) { const tau = 1 / (2 * Math.PI * c); return 1 / (1 + tau / dt); }
  filter(v, tMs) {
    if (this.x === null || tMs - this.t > 500) { this.x = v; this.dx = 0; this.t = tMs; return v; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3); this.t = tMs;
    const dx = (v - this.x) / dt; this.dx += this.alpha(this.dCutoff, dt) * (dx - this.dx);
    const c = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(c, dt) * (v - this.x); return this.x;
  }
}

// ---------- Fuente de mirada ----------
// Emite muestras { t, ok, f, reason } al ritmo de la cámara. En modo "ratón"
// la posición del cursor sustituye a la mirada (pruebas y demostraciones).
export class GazeSource {
  constructor() { this.listeners = new Set(); this.mode = null; this.model = null; this.fps = 0; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(s) { for (const fn of this.listeners) fn(s); }

  // El modelo corre en un proceso aparte (worker) para no competir con el
  // dibujo del juego; si el navegador no lo permite, en el hilo principal.
  _startWorker(wasmBase, modelUrl) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(new URL('./face-worker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { w.terminate(); reject(new Error('tiempo agotado')); }, 45000);
      w.onmessage = (ev) => {
        if (ev.data.type === 'ready') { clearTimeout(timer); this.delegate = ev.data.delegate; resolve(w); }
        else if (ev.data.type === 'error') { clearTimeout(timer); w.terminate(); reject(new Error(ev.data.message)); }
      };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(e); };
      w.postMessage({ type: 'init', wasmBase, modelUrl });
    });
  }

  async startCamera(video, onStatus = () => {}, res = [640, 480]) {
    this.res = res.join('x');
    this.mode = 'camara';
    onStatus('Cargando modelo de visión…');
    const wasmBase = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
    const modelUrl = new URL('../models/face_landmarker.task', import.meta.url).href;
    // ?sinworker en la dirección fuerza el método anterior (diagnóstico).
    const allowWorker = !new URLSearchParams(location.search).has('sinworker');
    this.worker = !allowWorker ? null : await this._startWorker(wasmBase, modelUrl).catch((e) => { console.warn('Worker no disponible, se usa el hilo principal:', e && e.message); return null; });
    if (!this.worker) {
      const fileset = await FilesetResolver.forVisionTasks(wasmBase);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true });
      // GPU es mucho más rápido; si el navegador no lo permite se usa CPU.
      try { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); this.delegate = 'GPU'; }
      catch { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); this.delegate = 'CPU'; }
    }
    this.hilo = this.worker ? 'paralelo' : 'principal';
    onStatus('Solicitando acceso a la cámara…');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: res[0] }, height: { ideal: res[1] }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
    video.srcObject = this.stream; await video.play();
    this.video = video;
    const settings = this.stream.getVideoTracks()[0].getSettings();
    this.cameraInfo = { width: settings.width, height: settings.height, frameRate: settings.frameRate, label: this.stream.getVideoTracks()[0].label, procesador: this.delegate, hilo: this.hilo };
    onStatus('');
    let lastTs = -1, frames = 0, fpsT = performance.now(), inFlight = 0;
    this.clock = { n: 0, usados: 0, offsets: [] };

    const handle = (t, fe, procMs) => {
      // Tiempo de procesamiento por imagen (promedio móvil) y frecuencia efectiva.
      this.procMs = this.procMs ? this.procMs * 0.95 + procMs * 0.05 : procMs;
      this.cameraInfo.procesamientoMs = +this.procMs.toFixed(1);
      const now = performance.now();
      frames++; if (now - fpsT > 1000) { this.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
      const s = { t, ok: fe.ok, reason: fe.reason, f: fe.f, open: fe.open, scale: fe.scale, landmarks: fe.landmarks };
      if (fe.ok && this.model) { [s.x, s.y] = this.model.predict(fe.f); s.head = this.model.headDeviation(fe.f); }
      this.emit(s);
    };
    if (this.worker) this.worker.onmessage = (ev) => { if (ev.data.type === 'result') { inFlight--; if (this.mode === 'camara') handle(ev.data.t, ev.data, ev.data.procMs); } };

    const step = (now, meta) => {
      if (this.mode !== 'camara') return;
      video.requestVideoFrameCallback(step);
      // Marca temporal: momento de captura del cuadro si el navegador lo informa.
      // Se descarta si viene de otro reloj (algunas cámaras/sistemas).
      const cap = meta && meta.captureTime;
      const useCap = cap && Math.abs(now - cap) < 300;
      const t = useCap ? cap : now;
      // Diagnóstico del reloj de la cámara (se guarda con cada sesión).
      if (this.clock.n < 60) {
        this.clock.n++; if (cap) this.clock.offsets.push(now - cap); if (useCap) this.clock.usados++;
        const o = [...this.clock.offsets].sort((a, b) => a - b);
        this.clockInfo = { captureTime: !!cap, desfaseMedianoMs: o.length ? +o[o.length >> 1].toFixed(1) : null, fraccionUsada: +(this.clock.usados / this.clock.n).toFixed(2) };
      }
      if (this.worker) {
        if (inFlight >= 2) return; // el proceso aparte va ocupado: se omite esta imagen
        const ts = Math.max(now, lastTs + 0.001); lastTs = ts;
        inFlight++;
        createImageBitmap(video).then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts, t }, [bitmap])).catch(() => { inFlight--; });
      } else {
        const ts = Math.max(now, lastTs + 0.001); lastTs = ts;
        const d0 = performance.now();
        const fe = extractFeatures(this.landmarker.detectForVideo(video, ts));
        handle(t, fe, performance.now() - d0);
      }
    };
    video.requestVideoFrameCallback(step);
  }

  startMouse() {
    this.mode = 'raton'; this.cameraInfo = { label: 'ratón (simulación)', frameRate: 60 };
    let mx = innerWidth / 2, my = innerHeight / 2;
    this._mm = (e) => { mx = e.clientX; my = e.clientY; };
    addEventListener('pointermove', this._mm);
    const tick = () => {
      if (this.mode !== 'raton') return;
      const t = performance.now();
      this.fps = 60;
      this.emit({ t, ok: true, f: [mx, my], x: mx, y: my, mouse: true });
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // Eye tracker externo a través del programa puente local (bridge/).
  // Mensajes JSON: { x, y, valid } con x, y normalizados 0–1 respecto a la
  // pantalla completa. La calibración la hace el software del fabricante.
  startEyeTracker(url, onStatus = () => {}) {
    this.mode = 'eyetracker';
    return new Promise((resolve, reject) => {
      onStatus('Conectando con el eye tracker en ' + url + '…');
      const ws = new WebSocket(url); this.ws = ws;
      let n = 0, fpsT = performance.now(), opened = false;
      ws.onopen = () => { opened = true; onStatus(''); setTimeout(resolve, 1500); };
      ws.onerror = () => { if (!opened) reject(new Error('No se encontró el programa puente del eye tracker en ' + url + '. ¿Está abierto?')); };
      ws.onclose = () => { if (opened && this.mode === 'eyetracker') onStatus('Se perdió la conexión con el eye tracker'); };
      ws.onmessage = (ev) => {
        const t = performance.now();
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.info) { this.cameraInfo = { label: m.info.modelo || 'eye tracker', frameRate: m.info.frecuencia, serie: m.info.serie }; if (!opened) return; resolve(); return; }
        n++; if (t - fpsT > 1000) { this.fps = n * 1000 / (t - fpsT); n = 0; fpsT = t; }
        const ok = !!m.valid && Number.isFinite(m.x) && Number.isFinite(m.y);
        // En pantalla completa, la ventana coincide con la pantalla.
        this.emit({ t, ok, reason: ok ? '' : 'sin-dato', x: ok ? m.x * innerWidth : undefined, y: ok ? m.y * innerHeight : undefined });
      };
    });
  }

  stop() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.mode = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this._mm) removeEventListener('pointermove', this._mm);
    cancelAnimationFrame(this._raf);
  }
}
