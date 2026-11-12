// Prueba del modelo de mirada con rasgos simulados: node tests/test-modelo.mjs
// Comprueba que un pequeño movimiento de cabeza DESPUÉS de calibrar no
// dispara el error (problema observado en la primera prueba con cámara).
import { GazeModel } from '../js/gaze-model.js';
import { mulberry32 } from '../js/stimuli.js';

const rnd = mulberry32(3), gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const W = 1920, H = 1080, ppd = 40;
// Rasgos simulados: el iris se mueve con la mirada relativa a la cabeza.
function features(gx, gy, head) {
  const dx = (gx - W / 2) / ppd - head.yawDeg, dy = (gy - H / 2) / ppd - head.pitchDeg;
  const ix = 0.006 * dx + gauss() * 0.002, iy = 0.003 * dy + gauss() * 0.002;
  return [ix, iy, ix + gauss() * 0.002, iy + gauss() * 0.002, 0.28 + 0.004 * dy + gauss() * 0.01,
    head.yawDeg * Math.PI / 180 + gauss() * 0.003, head.pitchDeg * Math.PI / 180 + gauss() * 0.003, gauss() * 0.003,
    0.5 + head.nx + gauss() * 0.0008, 0.5 + head.ny + gauss() * 0.0008, 0.15 * (1 + head.ds) + gauss() * 0.0005];
}
const still = () => ({ yawDeg: gauss() * 0.2, pitchDeg: gauss() * 0.2, nx: gauss() * 0.001, ny: gauss() * 0.001, ds: gauss() * 0.003 });
const X = [], Y = [];
for (const fx of [.1, .5, .9]) for (const fy of [.1, .5, .9]) { const h = still(); for (let k = 0; k < 25; k++) { X.push(features(fx * W, fy * H, h)); Y.push([fx * W, fy * H]); } }

function errorDeg(model, headFn, n = 300) {
  let s = 0;
  for (let i = 0; i < n; i++) { const gx = (0.2 + 0.6 * rnd()) * W, gy = (0.2 + 0.6 * rnd()) * H; const [px, py] = model.predict(features(gx, gy, headFn())); s += Math.hypot(px - gx, py - gy) / ppd; }
  return s / n;
}
// Modelo anterior (versión 0.2.0): estandarización sin mínimo y lambda = 1.
function oldModel() {
  const m = new GazeModel(); const k = X[0].length;
  m.mu = Array.from({ length: k }, (_, i) => X.reduce((s, f) => s + f[i], 0) / X.length);
  m.sd = Array.from({ length: k }, (_, i) => Math.sqrt(X.reduce((s, f) => s + (f[i] - m.mu[i]) ** 2, 0) / X.length) || 1);
  const D = X.map((f) => m.design(f)), p = D[0].length, A = Array.from({ length: p }, () => new Array(p).fill(0)), bx = new Array(p).fill(0), by = new Array(p).fill(0);
  D.forEach((r, n) => { for (let i = 0; i < p; i++) { bx[i] += r[i] * Y[n][0]; by[i] += r[i] * Y[n][1]; for (let j = 0; j < p; j++) A[i][j] += r[i] * r[j]; } });
  for (let i = 1; i < p; i++) A[i][i] += 1;
  const nw = new GazeModel().fit(X, Y); // reutiliza el solucionador vía un ajuste temporal
  const solve = (AA, b) => { const N = b.length, M = AA.map((r, i) => [...r, b[i]]); for (let c = 0; c < N; c++) { let q = c; for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[q][c])) q = r; [M[c], M[q]] = [M[q], M[c]]; for (let r = c + 1; r < N; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j <= N; j++) M[r][j] -= f * M[c][j]; } } const x = new Array(N).fill(0); for (let r = N - 1; r >= 0; r--) { let s = M[r][N]; for (let j = r + 1; j < N; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; } return x; };
  m.wx = solve(A, bx); m.wy = solve(A, by); m.offset = [0, 0]; void nw; return m;
}
const moved = () => ({ yawDeg: 1.5 + gauss() * 0.2, pitchDeg: -1 + gauss() * 0.2, nx: 0.015, ny: 0.01, ds: 0.05 });
const nuevo = new GazeModel().fit(X, Y), viejo = oldModel();
const r = { viejoQuieto: errorDeg(viejo, still), viejoMovido: errorDeg(viejo, moved), nuevoQuieto: errorDeg(nuevo, still), nuevoMovido: errorDeg(nuevo, moved) };
console.log(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toFixed(2) + '°'])));
const ok = r.nuevoQuieto < 1.5 && r.nuevoMovido < 4 && r.nuevoMovido < r.viejoMovido;
console.log(ok ? 'Prueba del modelo: OK' : 'Prueba del modelo: FALLA'); process.exit(ok ? 0 : 1);
