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

// ---------- Regresión de cresta ----------
function solve(A, b) { // eliminación gaussiana con pivoteo parcial
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / piv; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

export class GazeModel {
  constructor(json) { if (json) Object.assign(this, json); }
  design(f) {
    const z = f.map((v, i) => (v - this.mu[i]) / this.sd[i]);
    const mx = (z[0] + z[2]) / 2, my = (z[1] + z[3]) / 2;
    return [1, ...z, mx * mx, my * my, mx * my];
  }
  fit(X, Y, lambda = 1.0) { // X: vectores de rasgos, Y: [x, y] en px
    const k = X[0].length;
    this.mu = Array.from({ length: k }, (_, i) => X.reduce((s, f) => s + f[i], 0) / X.length);
    this.sd = Array.from({ length: k }, (_, i) => Math.sqrt(X.reduce((s, f) => s + (f[i] - this.mu[i]) ** 2, 0) / X.length) || 1);
    const D = X.map((f) => this.design(f)), p = D[0].length;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const bx = new Array(p).fill(0), by = new Array(p).fill(0);
    D.forEach((row, n) => { for (let i = 0; i < p; i++) { bx[i] += row[i] * Y[n][0]; by[i] += row[i] * Y[n][1]; for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j]; } });
    for (let i = 1; i < p; i++) A[i][i] += lambda; // no se penaliza el intercepto
    this.wx = solve(A, bx); this.wy = solve(A, by);
    this.offset = [0, 0];
    return this;
  }
  predict(f) {
    const d = this.design(f);
    let x = 0, y = 0; for (let i = 0; i < d.length; i++) { x += d[i] * this.wx[i]; y += d[i] * this.wy[i]; }
    return [x + this.offset[0], y + this.offset[1]];
  }
  toJSON() { return { mu: this.mu, sd: this.sd, wx: this.wx, wy: this.wy, offset: this.offset }; }
}

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
    const step = (now, meta) => {
      if (this.mode !== 'camara') return;
      // Marca temporal: momento de captura del cuadro si el navegador lo informa.
      const t = (meta && (meta.captureTime || meta.expectedDisplayTime)) || now;
      const ts = Math.max(now, lastTs + 0.001); lastTs = ts;
      const res = this.landmarker.detectForVideo(video, ts);
      const fe = extractFeatures(res);
      frames++; if (now - fpsT > 1000) { this.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
      const s = { t, ok: fe.ok, reason: fe.reason, f: fe.f, open: fe.open, scale: fe.scale, landmarks: fe.landmarks };
      if (fe.ok && this.model) [s.x, s.y] = this.model.predict(fe.f);
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

  stop() {
    this.mode = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this._mm) removeEventListener('pointermove', this._mm);
    cancelAnimationFrame(this._raf);
  }
}
