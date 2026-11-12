// Cálculo de métricas oculomotoras a partir de las muestras crudas.
// Entrada por bloque: samples = [{ t, ok, gx, gy, tx, ty, tvis }] (px, ms),
// events = [{ type:'step', t, from, to }], pxPerDeg y parámetros de análisis.
// Todas las salidas espaciales se expresan en grados de ángulo visual.

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

export function analyzeBlock(block, P) {
  const k = 1 / block.pxPerDeg;
  const S = block.samples.map((s) => ({ ...s, gx: s.gx * k, gy: s.gy * k, tx: s.tx * k, ty: s.ty * k }));
  const all = S.length;
  const dur = all > 1 ? (S[all - 1].t - S[0].t) : 0;
  const vis = S.filter((s) => s.tvis);
  const valid = vis.filter((s) => s.ok);
  const out = {
    muestras: all,
    frecuenciaHz: dur > 0 ? (all - 1) / (dur / 1000) : NaN,
    perdidaDatos: vis.length ? 1 - valid.length / vis.length : NaN,
  };

  // --- Error de posición y tiempo sobre el objeto ---
  const err = valid.map((s) => Math.hypot(s.gx - s.tx, s.gy - s.ty));
  out.errorMedioDeg = mean(err);
  out.errorRmsDeg = Math.sqrt(mean(err.map((e) => e * e)));
  out.tiempoSobreObjeto = valid.length ? err.filter((e) => e < P.aoiDeg).length / valid.length : NaN;

  // Racha continua más larga mirando el objeto (tiempo de mantenimiento).
  let best = 0, start = null, lastOn = null;
  for (const s of vis) {
    const on = s.ok && Math.hypot(s.gx - s.tx, s.gy - s.ty) < P.aoiDeg;
    if (on) {
      if (start === null || s.t - lastOn > P.maxGapMs) start = s.t;
      lastOn = s.t; best = Math.max(best, lastOn - start);
    } else if (s.ok) { start = null; }
  }
  out.rachaMaximaS = best / 1000;

  // --- Velocidades (diferencia central sobre mirada con mediana de 3) ---
  const ok = S.filter((s) => s.ok);
  const sm = ok.map((s, i) => {
    if (i === 0 || i === ok.length - 1) return { ...s };
    const a = ok[i - 1], b = ok[i + 1];
    return { ...s, gx: median([a.gx, s.gx, b.gx]), gy: median([a.gy, s.gy, b.gy]) };
  });
  for (let i = 1; i < sm.length - 1; i++) {
    const a = sm[i - 1], b = sm[i + 1], dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 0.12) continue;
    sm[i].vx = (b.gx - a.gx) / dt; sm[i].vy = (b.gy - a.gy) / dt;
    sm[i].tvx = (b.tx - a.tx) / dt; sm[i].tvy = (b.ty - a.ty) / dt;
    sm[i].speed = Math.hypot(sm[i].vx, sm[i].vy);
  }

  // --- Sacadas (I-VT) ---
  const sacc = []; let cur = null;
  for (const s of sm) {
    if (s.speed === undefined) { cur = null; continue; }
    if (s.speed > P.ivtThresholdDegS) { if (!cur) { cur = { t0: s.t, t1: s.t, peak: 0 }; sacc.push(cur); } cur.t1 = s.t; cur.peak = Math.max(cur.peak, s.speed); }
    else cur = null;
  }
  out.sacadas = sacc.length;
  out.sacadasPorMin = dur > 0 ? sacc.length / (dur / 60000) : NaN;

  // --- Ganancia de persecución (sólo con objeto en movimiento) ---
  const g = [];
  for (const s of sm) {
    if (s.speed === undefined || !s.tvis || s.speed > P.ivtThresholdDegS) continue;
    const tv2 = s.tvx * s.tvx + s.tvy * s.tvy;
    if (tv2 < 4) continue; // objeto a < 2°/s
    if (Math.hypot(s.gx - s.tx, s.gy - s.ty) > 2 * P.aoiDeg) continue;
    g.push((s.vx * s.tvx + s.vy * s.tvy) / tv2);
  }
  out.gananciaPersecucion = g.length >= 10 ? median(g) : NaN;

  // --- Fijaciones (I-DT) ---
  const fix = idt(ok, P.idtDispersionDeg, P.idtMinDurMs, P.maxGapMs, P.aoiDeg);
  const fixOn = fix.filter((f) => f.fraccionSobreObjeto >= 0.8);
  out.fijaciones = fix.length;
  out.fijacionDuracionMediaMs = mean(fix.map((f) => f.dur));
  out.fijacionesSobreObjeto = fixOn.length;
  out.fijacionMaximaSobreObjetoMs = fixOn.length ? Math.max(...fixOn.map((f) => f.dur)) : 0;

  // --- Latencia y precisión de respuestas a saltos del objeto ---
  const lat = [], gain = [];
  let anticip = 0, sinResp = 0, invalidos = 0;
  for (const e of block.events || []) {
    if (e.type !== 'step') continue;
    const fx = e.from.x * k, fy = e.from.y * k, sx = e.to.x * k - fx, sy = e.to.y * k - fy;
    const amp = Math.hypot(sx, sy); if (amp < 2) continue;
    const proj = (s) => ((s.gx - fx) * sx + (s.gy - fy) * sy) / (amp * amp);
    const pre = ok.filter((s) => s.t <= e.t && s.t > e.t - 200);
    if (!pre.length || Math.hypot(mean(pre.map((s) => s.gx)) - fx, mean(pre.map((s) => s.gy)) - fy) > Math.max(5, amp * 0.4)) { invalidos++; continue; }
    const post = ok.filter((s) => s.t > e.t && s.t <= e.t + P.latencyMaxMs + 300);
    let onset = null;
    for (let i = 0; i < post.length; i++) {
      const p = proj(post[i]);
      if (p >= P.latencyCrossFrac) {
        const prev = i > 0 ? post[i - 1] : pre[pre.length - 1];
        const pp = proj(prev);
        onset = prev.t + (post[i].t - prev.t) * ((P.latencyCrossFrac - pp) / ((p - pp) || 1e-9));
        break;
      }
    }
    if (onset === null || onset - e.t > P.latencyMaxMs) { sinResp++; continue; }
    const L = onset - e.t;
    if (L < P.latencyMinMs) { anticip++; continue; }
    lat.push(L);
    const land = post.filter((s) => s.t >= onset + 80 && s.t <= onset + 250).map(proj);
    if (land.length) gain.push(median(land));
  }
  if ((block.events || []).some((e) => e.type === 'step')) {
    out.latenciaMediaMs = mean(lat);
    out.latenciaDEms = sd(lat);
    out.gananciaSacadica = median(gain);
    out.ensayosValidos = lat.length;
    out.anticipaciones = anticip;
    out.sinRespuesta = sinResp;
    out.ensayosDescartados = invalidos;
  }
  return out;
}

// Identificación de fijaciones por dispersión (Salvucci & Goldberg, 2000).
// Adaptación para datos ruidosos de webcam: la mirada se suaviza con media
// móvil de 3 muestras y la dispersión se mide como el DIÁMETRO del círculo
// centrado en el centroide de la ventana (2 × distancia máxima al centroide).
// La suma de rangos clásica crece con la duración bajo ruido y fragmenta las
// fijaciones largas.
export function idt(raw, dispDeg, minDurMs, maxGapMs = 200, aoiDeg = 3) {
  const samples = raw.map((s, i) => {
    const a = raw[i - 1], b = raw[i + 1];
    if (!a || !b || s.t - a.t > maxGapMs || b.t - s.t > maxGapMs) return s;
    return { ...s, gx: (a.gx + s.gx + b.gx) / 3, gy: (a.gy + s.gy + b.gy) / 3 };
  });
  const out = []; let i = 0;
  const disp = (w) => {
    let cx = 0, cy = 0; for (const s of w) { cx += s.gx; cy += s.gy; } cx /= w.length; cy /= w.length;
    let m = 0; for (const s of w) m = Math.max(m, Math.hypot(s.gx - cx, s.gy - cy)); return 2 * m;
  };
  while (i < samples.length) {
    let j = i;
    while (j + 1 < samples.length && samples[j].t - samples[i].t < minDurMs && samples[j + 1].t - samples[j].t <= maxGapMs) j++;
    if (samples[j].t - samples[i].t < minDurMs) { i = j + 1; continue; }
    if (disp(samples.slice(i, j + 1)) > dispDeg) { i++; continue; }
    while (j + 1 < samples.length && samples[j + 1].t - samples[j].t <= maxGapMs && disp(samples.slice(i, j + 2)) <= dispDeg) j++;
    const w = samples.slice(i, j + 1);
    out.push({ t0: w[0].t, t1: w[w.length - 1].t, dur: w[w.length - 1].t - w[0].t,
      cx: mean(w.map((s) => s.gx)), cy: mean(w.map((s) => s.gy)),
      // Una fijación cuenta como "sobre el objeto" si ≥ 80 % de sus muestras caen en el área de interés.
      fraccionSobreObjeto: w.filter((s) => Math.hypot(s.gx - s.tx, s.gy - s.ty) < aoiDeg).length / w.length });
    i = j + 1;
  }
  return out;
}

// Exactitud y precisión de la validación (Kasneci et al., 2024).
export function validationQuality(points, pxPerDeg) {
  const res = points.map((p) => {
    const g = p.samples; if (!g.length) return null;
    const mx = mean(g.map((s) => s.x)), my = mean(g.map((s) => s.y));
    const acc = Math.hypot(mx - p.x, my - p.y) / pxPerDeg;
    const d = []; for (let i = 1; i < g.length; i++) d.push(Math.hypot(g[i].x - g[i - 1].x, g[i].y - g[i - 1].y) / pxPerDeg);
    return { x: p.x, y: p.y, mx, my, acc, prec: Math.sqrt(mean(d.map((v) => v * v))) };
  }).filter(Boolean);
  return { points: res, exactitudDeg: mean(res.map((r) => r.acc)), precisionRmsDeg: mean(res.map((r) => r.prec)) };
}

export const METRIC_LABELS = {
  tiempoSobreObjeto: ['Tiempo sobre el objeto', '%'],
  rachaMaximaS: ['Mantenimiento máximo de la mirada', 's'],
  errorMedioDeg: ['Error medio de posición', '°'],
  gananciaPersecucion: ['Ganancia de persecución', ''],
  sacadasPorMin: ['Sacadas de corrección', '/min'],
  fijacionDuracionMediaMs: ['Duración media de fijación', 'ms'],
  fijacionMaximaSobreObjetoMs: ['Fijación más larga sobre el objeto', 'ms'],
  latenciaMediaMs: ['Latencia media', 'ms'],
  latenciaDEms: ['Variabilidad de la latencia (DE)', 'ms'],
  gananciaSacadica: ['Precisión sacádica (ganancia)', ''],
  ensayosValidos: ['Ensayos válidos', ''],
  perdidaDatos: ['Pérdida de datos', '%'],
  frecuenciaHz: ['Frecuencia de muestreo efectiva', 'Hz'],
};

export function fmt(key, v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  const unit = METRIC_LABELS[key] ? METRIC_LABELS[key][1] : '';
  if (unit === '%') return (v * 100).toFixed(0) + ' %';
  if (unit === 'ms' || unit === '/min' || unit === 'Hz') return v.toFixed(0) + (unit ? ' ' + unit : '');
  if (unit === '°') return v.toFixed(2) + '°';
  if (unit === 's') return v.toFixed(1) + ' s';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
