// Modelo de regresión que convierte rasgos oculares/cefálicos en coordenadas
// de pantalla. Separado de tracker.js para poder probarlo sin navegador.

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

// Escala mínima de cada rasgo (en sus propias unidades) y penalización.
// Orden: iris D (x,y), iris I (x,y), apertura, guiñada, cabeceo, alabeo,
// nariz x, nariz y, tamaño del rostro.
// Si un rasgo casi no varía durante la calibración (la cabeza quieta), NO se
// estandariza por su desviación diminuta: eso amplificaba cualquier movimiento
// posterior de la cabeza y producía errores de 10° o más fuera de la
// calibración. Los rasgos de cabeza reciben además una penalización alta.
const SD_FLOOR = [0.02, 0.02, 0.02, 0.02, 0.05, 0.08, 0.08, 0.08, 0.05, 0.05, 0.03];
const PENALTY = [1, 1, 1, 1, 10, 50, 50, 50, 50, 50, 50];

export class GazeModel {
  constructor(json) { if (json) Object.assign(this, json); }
  design(f) {
    const z = f.map((v, i) => (v - this.mu[i]) / this.sd[i]);
    const mx = (z[0] + z[2]) / 2, my = (z[1] + z[3]) / 2;
    return [1, ...z, mx * mx, my * my, mx * my];
  }
  fit(X, Y) { // X: vectores de rasgos, Y: [x, y] en px
    const k = X[0].length;
    this.mu = Array.from({ length: k }, (_, i) => X.reduce((s, f) => s + f[i], 0) / X.length);
    this.sd = Array.from({ length: k }, (_, i) => Math.max(Math.sqrt(X.reduce((s, f) => s + (f[i] - this.mu[i]) ** 2, 0) / X.length), SD_FLOOR[i] ?? 1e-3));
    const D = X.map((f) => this.design(f)), p = D[0].length;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const bx = new Array(p).fill(0), by = new Array(p).fill(0);
    D.forEach((row, n) => { for (let i = 0; i < p; i++) { bx[i] += row[i] * Y[n][0]; by[i] += row[i] * Y[n][1]; for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j]; } });
    // Penalización proporcional al número de muestras (no se penaliza el intercepto).
    const lam = (i) => (i >= 1 && i <= k ? PENALTY[i - 1] ?? 1 : 1) * X.length * 0.002;
    for (let i = 1; i < p; i++) A[i][i] += lam(i);
    // Posición de referencia de la cabeza (para avisar si el niño se mueve).
    this.ref = { noseX: this.mu[8], noseY: this.mu[9], scale: this.mu[10] };
    this.wx = solve(A, bx); this.wy = solve(A, by);
    this.offset = [0, 0];
    return this;
  }
  predict(f) {
    const d = this.design(f);
    let x = 0, y = 0; for (let i = 0; i < d.length; i++) { x += d[i] * this.wx[i]; y += d[i] * this.wy[i]; }
    return [x + this.offset[0], y + this.offset[1]];
  }
  // Desplazamiento de la cabeza respecto a la calibración: traslación en
  // anchos de rostro y cambio relativo de distancia (tamaño del rostro).
  headDeviation(f) {
    if (!this.ref) return { shift: 0, dist: 0 };
    return { shift: Math.hypot(f[8] - this.ref.noseX, f[9] - this.ref.noseY) / this.ref.scale, dist: f[10] / this.ref.scale - 1 };
  }
  toJSON() { return { mu: this.mu, sd: this.sd, wx: this.wx, wy: this.wy, offset: this.offset, ref: this.ref }; }
}

// Límites de movimiento tolerado antes de pausar (cámara web).
export const HEAD_LIMITS = { shift: 0.35, dist: 0.15 };

