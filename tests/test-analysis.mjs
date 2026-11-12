// Prueba con datos sintéticos de parámetros conocidos: node tests/test-analysis.mjs
import { createStimulus, mulberry32 } from '../js/stimuli.js';
import { analyzeBlock } from '../js/analysis.js';
import { MODULES, EVALUATION_BATTERY, ANALYSIS_DEFAULTS as P } from '../js/config.js';

const geom = { W: 1920, H: 1080, pxPerDeg: 40 };
const rnd = mulberry32(7);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
let fails = 0;
const check = (name, v, lo, hi) => { const ok = v >= lo && v <= hi; if (!ok) fails++; console.log(`${ok ? 'OK ' : 'FALLA'} ${name}: ${typeof v === 'number' ? v.toFixed(3) : v} (esperado ${lo}–${hi})`); };

// Simula un observador a 30 Hz con ruido gaussiano (σ en grados).
function simulate(stim, gazeAt, { hz = 30, noiseDeg = 0.6, loss = 0.03 } = {}) {
  const samples = [];
  for (let t = 0; t <= stim.durationMs; t += 1000 / hz) {
    const tg = stim.at(t), g = gazeAt(t, tg);
    const ok = rnd() > loss;
    samples.push({ t, ok: ok ? 1 : 0, gx: ok ? g.x + gauss() * noiseDeg * geom.pxPerDeg : null, gy: ok ? g.y + gauss() * noiseDeg * geom.pxPerDeg : null, tx: tg.x, ty: tg.y, tvis: tg.visible ? 1 : 0 });
  }
  return { samples, events: stim.events, pxPerDeg: geom.pxPerDeg };
}

// 1) Persecución lineal con ganancia 0.85: el ojo se rezaga y hace sacadas de alcance.
{
  const stim = createStimulus(MODULES[2], geom, 3);
  let ex = null, ey = null, lastT = 0, prevTg = null;
  const gain = 0.7;
  const m = analyzeBlock(simulate(stim, (t, tg) => {
    if (ex === null) { ex = tg.x; ey = tg.y; prevTg = tg; lastT = t; return { x: ex, y: ey }; }
    ex += gain * (tg.x - prevTg.x); ey += gain * (tg.y - prevTg.y); prevTg = tg; lastT = t;
    if (Math.hypot(tg.x - ex, tg.y - ey) > 4 * geom.pxPerDeg) { ex = tg.x; ey = tg.y; } // sacada de alcance de 4° (a 30 Hz las de ~2° no se detectan)
    return { x: ex, y: ey };
  }), P);
  console.log('\nLineal 10°/s, ganancia simulada 0.70'); console.log(m);
  check('ganancia de persecución', m.gananciaPersecucion, 0.6, 0.8);
  check('tiempo sobre objeto', m.tiempoSobreObjeto, 0.5, 1);
  check('sacadas/min (alcance)', m.sacadasPorMin, 5, 80);
  check('frecuencia Hz', m.frecuenciaHz, 29, 31);
}

// 2) Saltos con latencia conocida de 250 ± 40 ms y ganancia sacádica 0.9.
{
  const stim = createStimulus(EVALUATION_BATTERY[4], geom, 11);
  const lat = new Map(stim.events.map((e) => [e.t, 250 + gauss() * 40]));
  const m = analyzeBlock(simulate(stim, (t, tg) => {
    // Mirada: permanece en la posición previa hasta t_evento + latencia; sacada de 40 ms al 90 % y corrección 150 ms después.
    let pos = { x: geom.W / 2, y: geom.H / 2 };
    for (const e of stim.events) {
      const L = lat.get(e.t);
      if (t >= e.t + L) {
        const u = Math.min(1, (t - e.t - L) / 40); const g = t >= e.t + L + 190 ? 1 : 0.9 * u;
        pos = { x: e.from.x + (e.to.x - e.from.x) * g, y: e.from.y + (e.to.y - e.from.y) * g };
      }
      // regreso al centro cuando el objeto vuelve
      if (t >= e.t + 1200 + 200) pos = { x: geom.W / 2, y: geom.H / 2 };
    }
    return pos;
  }, { noiseDeg: 0.5 }), P);
  console.log('\nSaltos, latencia simulada 250 ± 40 ms, ganancia 0.9'); console.log(m);
  check('latencia media (ms)', m.latenciaMediaMs, 230, 285);
  check('DE latencia (ms)', m.latenciaDEms, 20, 70);
  check('ganancia sacádica', m.gananciaSacadica, 0.8, 1.05);
  check('ensayos válidos', m.ensayosValidos, 16, 20);
}

// 3) Fijación: mirada estable sobre el objeto con ruido → fijaciones largas.
{
  const stim = createStimulus(MODULES[0], geom, 5);
  const m = analyzeBlock(simulate(stim, (t, tg) => tg, { noiseDeg: 0.3 }), P);
  console.log('\nFijación'); console.log(m);
  check('tiempo sobre objeto', m.tiempoSobreObjeto, 0.95, 1);
  check('fijación máxima sobre objeto (ms)', m.fijacionMaximaSobreObjetoMs, 1500, 4500);
  check('racha máxima (s)', m.rachaMaximaS, 2.5, 4.1);
}

// 4) Todos los módulos generan trayectorias dentro de la pantalla.
for (const mod of [...MODULES, ...EVALUATION_BATTERY]) {
  const s = createStimulus(mod, geom, 1); let out = 0;
  for (let t = 0; t < s.durationMs; t += 20) { const p = s.at(t); if (p.x < 0 || p.x > geom.W || p.y < 0 || p.y > geom.H || Number.isNaN(p.x + p.y)) out++; }
  check(`módulo ${mod.id} (${mod.type}) dentro de pantalla, ${(s.durationMs / 1000).toFixed(0)} s`, out, 0, 0);
}
console.log(fails ? `\n${fails} pruebas fallidas` : '\nTodas las pruebas pasaron');
process.exit(fails ? 1 : 0);
