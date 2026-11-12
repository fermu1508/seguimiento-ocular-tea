// Generación de trayectorias del objeto. Cada estímulo es una función pura del
// tiempo: at(tMs) devuelve la posición exacta en píxeles, de modo que la
// posición del objeto puede evaluarse en el instante exacto de cada muestra
// de mirada (no sólo en cada cuadro de pantalla).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

// Onda triangular: posición sobre un segmento [a, b] recorrido de ida y vuelta.
function pingPong(s, a, b) {
  const L = b - a;
  const u = ((s % (2 * L)) + 2 * L) % (2 * L);
  return u < L ? a + u : b - (u - L);
}

export function createStimulus(mod, geom, seed = 1) {
  const { W, H, pxPerDeg } = geom;
  const rng = mulberry32(seed);
  const size = mod.sizeDeg * pxPerDeg;            // diámetro en px
  const margin = Math.max(size, 0.06 * W);
  const xL = margin, xR = W - margin, cx = W / 2, cy = H / 2;
  const events = [];
  let at;
  let durationMs = (mod.durationS || 60) * 1000;

  switch (mod.type) {
    case 'lineal': {
      const v = mod.speedDegS * pxPerDeg / 1000; // px/ms
      at = (t) => ({ x: pingPong(t * v, xL, xR), y: cy, visible: true, size });
      break;
    }
    case 'sinusoidal': {
      const v = mod.speedDegS * pxPerDeg / 1000;
      const A = Math.min(mod.ampDeg * pxPerDeg, cy - margin);
      at = (t) => ({ x: pingPong(t * v, xL, xR), y: cy + A * Math.sin(TAU * mod.freqHz * t / 1000), visible: true, size });
      break;
    }
    case 'mixto': {
      const [vmin, vmax] = mod.speedDegS.map((s) => s * pxPerDeg / 1000);
      const P = 8000; // periodo del cambio de velocidad (ms)
      const A = Math.min(mod.ampDeg * pxPerDeg, cy - margin);
      // s(t) = ∫ v(t) dt con v(t) = vmin + (vmax − vmin)·(½ − ½cos(2πt/P))
      const s = (t) => vmin * t + (vmax - vmin) * (t / 2 - (P / (2 * TAU)) * Math.sin(TAU * t / P));
      at = (t) => ({ x: pingPong(s(t), xL, xR), y: cy + A * Math.sin(TAU * mod.freqHz * t / 1000), visible: true, size });
      break;
    }
    case 'barrido': {
      // Empieza en la línea media; baja renglón por renglón; al llegar abajo
      // continúa desde arriba hasta volver a la línea media.
      const v = mod.speedDegS * pxPerDeg / 1000;
      const sp = mod.rowSpacingDeg * pxPerDeg;
      const rows = [];
      for (let y = cy; y <= H - margin; y += sp) rows.push(y);
      for (let y = cy - sp * Math.floor((cy - margin) / sp); y < cy - 1; y += sp) rows.push(y);
      const travel = (xR - xL) / v, gap = mod.gapS * 1000, cycle = travel + gap;
      at = (t) => {
        const k = Math.floor(t / cycle), u = t - k * cycle;
        const y = rows[k % rows.length];
        if (u < travel) return { x: xL + u * v, y, visible: true, size };
        return { x: xR, y, visible: false, size };
      };
      for (let k = 1; k * cycle < durationMs; k++) {
        events.push({ type: 'step', kind: 'reaparicion', t: k * cycle,
          from: { x: xR, y: rows[(k - 1) % rows.length] }, to: { x: xL, y: rows[k % rows.length] } });
      }
      break;
    }
    case 'fijacion': {
      const off = Math.min(8 * pxPerDeg, cx - margin, cy - margin);
      const pts = [{ x: cx, y: cy }];
      const others = [{ x: cx - off, y: cy }, { x: cx + off, y: cy }, { x: cx, y: cy - off }, { x: cx, y: cy + off }];
      while (pts.length < mod.positions) {
        const pool = others.slice();
        while (pool.length && pts.length < mod.positions) pts.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      }
      const hold = mod.holdS * 1000, blank = 300, seg = hold + blank;
      durationMs = pts.length * seg;
      at = (t) => {
        const k = Math.min(Math.floor(t / seg), pts.length - 1), u = t - k * seg;
        const p = pts[k];
        return { x: p.x, y: p.y, visible: u >= blank, size: size * (1 + 0.08 * Math.sin(TAU * 1.2 * t / 1000)) };
      };
      for (let k = 1; k < pts.length; k++) events.push({ type: 'step', kind: 'fijacion', t: k * seg + blank, from: pts[k - 1], to: pts[k] });
      break;
    }
    case 'saltos': {
      // Ensayos de prosacada: fijación central 1.0–1.5 s, (gap opcional),
      // objeto periférico durante holdS, regreso al centro.
      const sched = []; let t = 0;
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let i = 0; i < mod.trials; i++) {
        const fix = 1000 + rng() * 500;
        sched.push({ t0: t, t1: t + fix, x: cx, y: cy, visible: true }); t += fix;
        if (mod.gapMs > 0) { sched.push({ t0: t, t1: t + mod.gapMs, x: cx, y: cy, visible: false }); t += mod.gapMs; }
        // Direcciones balanceadas: cada 4 ensayos se usan las 4 direcciones.
        const d = dirs[(i + Math.floor(i / 4)) % 4];
        let amp = (mod.ampDeg[0] + rng() * (mod.ampDeg[1] - mod.ampDeg[0])) * pxPerDeg;
        amp = Math.min(amp, d[0] ? cx - margin : cy - margin);
        const to = { x: cx + d[0] * amp, y: cy + d[1] * amp };
        events.push({ type: 'step', kind: 'salto', t, from: { x: cx, y: cy }, to, trial: i });
        sched.push({ t0: t, t1: t + mod.holdS * 1000, x: to.x, y: to.y, visible: true }); t += mod.holdS * 1000;
      }
      durationMs = t;
      at = (tt) => {
        let lo = 0, hi = sched.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (sched[m].t0 <= tt) lo = m; else hi = m - 1; }
        const s = sched[lo];
        return { x: s.x, y: s.y, visible: s.visible && tt < durationMs, size };
      };
      break;
    }
    default:
      throw new Error('Tipo de módulo desconocido: ' + mod.type);
  }

  // Distractores de bajo contraste (no compiten en color con el objeto).
  const ds = [];
  for (let i = 0; i < (mod.distractors || 0); i++) {
    ds.push({ x: margin + rng() * (W - 2 * margin), y: margin + rng() * (H - 2 * margin),
      r: (0.6 + rng() * 0.5) * pxPerDeg, shape: i % 3, phase: rng() * TAU, orbit: (1 + rng() * 2) * pxPerDeg });
  }
  const distractors = (t) => ds.map((d) => mod.movingDistractors
    ? { ...d, x: d.x + d.orbit * Math.cos(d.phase + t / 2500), y: d.y + d.orbit * Math.sin(d.phase + t / 2500) }
    : d);

  return { mod, durationMs, at, events, distractors, seed };
}
