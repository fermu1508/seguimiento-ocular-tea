// Seguimiento ocular con cámara web: MediaPipe Face Landmarker (478 puntos,
// incluye iris) + modelo de regresión de cresta (ridge) entrenado en la
// calibración que convierte rasgos oculares/cefálicos en coordenadas de
// pantalla. El video NUNCA sale del navegador: sólo se guardan coordenadas.

import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

// Índices de la malla facial de MediaPipe.
const EYE = {
  R: { a: 33, b: 133, top: 159, bot: 145, iris: 468 },   // ojo derecho del niño
  L: { a: 362, b: 263, top: 386, bot: 374, iris: 473 },  // ojo izquierdo del niño
};
const NOSE = 1;

function eyeFeatures(lm, e) {
  const A = lm[e.a], B = lm[e.b], I = lm[e.iris];
  const ox = (A.x + B.x) / 2, oy = (A.y + B.y) / 2;
  let ux = B.x - A.x, uy = B.y - A.y;
  const w = Math.hypot(ux, uy) || 1e-6; ux /= w; uy /= w;
  const dx = I.x - ox, dy = I.y - oy;
  const open = Math.hypot(lm[e.top].x - lm[e.bot].x, lm[e.top].y - lm[e.bot].y) / w;
  return { ix: (dx * ux + dy * uy) / w, iy: (-dx * uy + dy * ux) / w, open, w };
}

// Vector de rasgos de una muestra. null si no hay rostro o hay parpadeo.
export function extractFeatures(result) {
  const lm = result.faceLandmarks && result.faceLandmarks[0];
  if (!lm) return { ok: false, reason: 'sin-rostro' };
  const r = eyeFeatures(lm, EYE.R), l = eyeFeatures(lm, EYE.L);
  const open = (r.open + l.open) / 2;
  let yaw = 0, pitch = 0, roll = 0;
  const M = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  if (M) {
    const d = M.data; // 4×4 por columnas
    const r20 = d[2], r21 = d[6], r22 = d[10], r10 = d[1], r00 = d[0];
    pitch = Math.atan2(r21, r22); yaw = Math.atan2(-r20, Math.hypot(r21, r22)); roll = Math.atan2(r10, r00);
  }
  const scale = Math.hypot(lm[EYE.R.a].x - lm[EYE.L.b].x, lm[EYE.R.a].y - lm[EYE.L.b].y);
  const f = [r.ix, r.iy, l.ix, l.iy, open, yaw, pitch, roll, lm[NOSE].x, lm[NOSE].y, scale];
  return { ok: open > 0.12, reason: open > 0.12 ? '' : 'parpadeo', f, open, scale, landmarks: lm };
}

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

  async startCamera(video, onStatus = () => {}) {
    this.mode = 'camara';
    onStatus('Cargando modelo de visión…');
    const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: new URL('../models/face_landmarker.task', import.meta.url).href, delegate },
      runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true,
    });
    try { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); }
    onStatus('Solicitando acceso a la cámara…');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' }, audio: false });
    video.srcObject = this.stream; await video.play();
    this.video = video;
    const settings = this.stream.getVideoTracks()[0].getSettings();
    this.cameraInfo = { width: settings.width, height: settings.height, frameRate: settings.frameRate, label: this.stream.getVideoTracks()[0].label };
    onStatus('');
    let lastTs = -1, frames = 0, fpsT = performance.now();
    this.clock = { n: 0, usados: 0, offsets: [] };
    const step = (now, meta) => {
      if (this.mode !== 'camara') return;
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
      const ts = Math.max(now, lastTs + 0.001); lastTs = ts;
      const res = this.landmarker.detectForVideo(video, ts);
      const fe = extractFeatures(res);
      frames++; if (now - fpsT > 1000) { this.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
      const s = { t, ok: fe.ok, reason: fe.reason, f: fe.f, open: fe.open, scale: fe.scale, landmarks: fe.landmarks };
      if (fe.ok && this.model) { [s.x, s.y] = this.model.predict(fe.f); s.head = this.model.headDeviation(fe.f); }
      this.emit(s);
      video.requestVideoFrameCallback(step);
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
    this.mode = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this._mm) removeEventListener('pointermove', this._mm);
    cancelAnimationFrame(this._raf);
  }
}
