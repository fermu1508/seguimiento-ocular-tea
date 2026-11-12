// Rasgos oculares y cefálicos a partir de la malla facial de MediaPipe.
// Módulo sin dependencias: lo usan el hilo principal y el proceso aparte (worker).

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
export function extractFeatures(result, keep = null) {
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
  // keep: índices de la malla a conservar (para la vista previa); null = todos.
  const landmarks = keep ? Object.fromEntries(keep.map((i) => [i, { x: lm[i].x, y: lm[i].y }])) : lm;
  return { ok: open > 0.12, reason: open > 0.12 ? '' : 'parpadeo', f, open, scale, landmarks };
}

