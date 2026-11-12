import { VERSION, MODULES, EVALUATION_BATTERY, ANALYSIS_DEFAULTS, PROGRESSION, TRAINING_BLOCKS_PER_SESSION } from './config.js';
import { GazeSource, GazeModel, OneEuro } from './tracker.js';
import { createStimulus } from './stimuli.js';
import { analyzeBlock, validationQuality, METRIC_LABELS, fmt } from './analysis.js';
import * as db from './storage.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), ctx = stage.getContext('2d'), msg = $('#stage-msg');
const gaze = new GazeSource();
const state = { cfg: null, model: null, calidad: null, plan: [], lastSession: null, showGaze: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Navegación ----------------
function show(name) {
  document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== name));
  if (name === 'historial') renderHistory();
}
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) show(g.dataset.go); });

// ---------------- Parámetros persistentes ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const params = () => ({ ...ANALYSIS_DEFAULTS, ...LS.get('parametros', {}) });
function renderParams() {
  const p = params(), box = $('#parametros'); box.innerHTML = '';
  const names = { aoiDeg: 'Radio del área de interés (°)', ivtThresholdDegS: 'Umbral I-VT de sacada (°/s)', idtDispersionDeg: 'Dispersión I-DT (°)', idtMinDurMs: 'Duración mínima de fijación (ms)', maxGapMs: 'Hueco máximo tolerado (ms)', latencyMinMs: 'Latencia mínima válida (ms)', latencyMaxMs: 'Latencia máxima (ms)', latencyCrossFrac: 'Fracción de cruce para latencia' };
  for (const k of Object.keys(ANALYSIS_DEFAULTS)) {
    const l = document.createElement('label'); l.textContent = names[k] || k;
    const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.value = p[k];
    i.onchange = () => { const cur = LS.get('parametros', {}); cur[k] = Number(i.value); LS.set('parametros', cur); };
    l.appendChild(i); box.appendChild(l);
  }
  const r = document.createElement('button'); r.type = 'button'; r.textContent = 'Restablecer valores por defecto';
  r.onclick = () => { LS.set('parametros', {}); renderParams(); }; box.appendChild(r);
}

// ---------------- Inicio ----------------
const form = $('#form-inicio');
const modSel = form.modulo;
[...MODULES, ...EVALUATION_BATTERY].forEach((m) => modSel.add(new Option(`${m.id}. ${m.name}`, m.id)));
form.tipoSesion.onchange = () => ($('#campo-modulo').hidden = form.tipoSesion.value !== 'libre');
const saved = LS.get('equipo', {});
if (saved.anchoCm) form.anchoCm.value = saved.anchoCm;
if (saved.distanciaCm) form.distanciaCm.value = saved.distanciaCm;
renderParams();

form.onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  state.cfg = {
    participante: f.get('participante').trim().toUpperCase(), grupo: f.get('grupo'), condicion: f.get('condicion'),
    tipoSesion: f.get('tipoSesion'), modulo: f.get('modulo'), anchoCm: Number(f.get('anchoCm')), distanciaCm: Number(f.get('distanciaCm')),
    entrada: f.get('entrada'), sonido: !!f.get('sonido'), deriva: !!f.get('deriva'),
  };
  LS.set('equipo', { anchoCm: state.cfg.anchoCm, distanciaCm: state.cfg.distanciaCm });
  await buildPlan();
  if (state.cfg.entrada === 'raton') {
    gaze.stop(); gaze.startMouse(); state.model = null; state.calidad = null; showPlan();
  } else {
    show('camara'); startCameraPreview();
  }
};

// px por grado de ángulo visual: tamaño físico de la pantalla + distancia.
function pxPerDeg() {
  const pxPerCm = screen.width / state.cfg.anchoCm;
  return pxPerCm * 2 * state.cfg.distanciaCm * Math.tan(Math.PI / 360);
}

// ---------------- Cámara ----------------
let previewOff = null;
async function startCameraPreview() {
  const st = $('#cam-status'), btn = $('#btn-calibrar'), ov = $('#cam-overlay'), octx = ov.getContext('2d');
  btn.disabled = true;
  if (gaze.mode !== 'camara') {
    gaze.stop();
    try { await gaze.startCamera($('#video'), (m) => (st.textContent = m)); }
    catch (err) { st.textContent = 'No fue posible iniciar la cámara: ' + err.message; st.className = 'status bad'; return; }
  }
  if (previewOff) previewOff();
  let okCount = 0;
  previewOff = gaze.on((s) => {
    ov.width = ov.clientWidth; ov.height = ov.clientHeight; octx.clearRect(0, 0, ov.width, ov.height);
    if (s.landmarks) {
      octx.fillStyle = '#4ade80';
      for (const i of [468, 473, 33, 133, 362, 263]) { const p = s.landmarks[i]; octx.beginPath(); octx.arc(p.x * ov.width, p.y * ov.height, 3, 0, 7); octx.fill(); }
    }
    okCount = s.ok ? okCount + 1 : 0;
    const dist = s.scale ? `Tamaño del rostro: ${(s.scale * 100).toFixed(0)} %` : '';
    if (s.ok && okCount > 15) { st.textContent = `Rostro y ojos detectados · ${gaze.fps.toFixed(0)} cuadros/s · ${dist}`; st.className = 'status ok'; btn.disabled = false; }
    else if (!s.ok) { st.textContent = s.reason === 'parpadeo' ? 'Ojos cerrados o no visibles' : 'Buscando el rostro…'; st.className = 'status bad'; }
  });
}
$('#btn-calibrar').onclick = () => runCalibration();
$('#btn-recalibrar').onclick = () => runCalibration();
$('#btn-plan-recal').onclick = () => (state.cfg.entrada === 'raton' ? null : runCalibration());
$('#btn-continuar').onclick = () => showPlan();

// ---------------- Escenario (pantalla completa) ----------------
async function enterStage() {
  if (previewOff) { previewOff(); previewOff = null; }
  stage.hidden = false;
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch { /* el navegador puede negarlo */ }
  await sleep(400);
  resizeStage();
}
function resizeStage() {
  const dpr = devicePixelRatio || 1;
  stage.width = innerWidth * dpr; stage.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function leaveStage() { stage.hidden = true; msg.hidden = true; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
function clear() { ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--stage') || '#10172a'; ctx.fillRect(0, 0, innerWidth, innerHeight); }
function stageMessage(html) { msg.innerHTML = html; msg.hidden = !html; }

// Personaje: círculo amarillo con cara; brilla cuando el niño lo mira.
function drawTarget(x, y, d, on, t) {
  const r = d / 2;
  if (on) {
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2);
    g.addColorStop(0, 'rgba(255,230,120,.55)'); g.addColorStop(1, 'rgba(255,230,120,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
    for (let i = 0; i < 6; i++) { const a = t / 600 + i * Math.PI / 3; ctx.fillStyle = '#fff6c4'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 1.6, y + Math.sin(a) * r * 1.6, r * 0.09, 0, 7); ctx.fill(); }
  }
  ctx.fillStyle = on ? '#ffd43b' : '#f2c230'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.fillStyle = '#3b2a05';
  ctx.beginPath(); ctx.arc(x - r * 0.33, y - r * 0.2, r * 0.11, 0, 7); ctx.arc(x + r * 0.33, y - r * 0.2, r * 0.11, 0, 7); ctx.fill();
  ctx.strokeStyle = '#3b2a05'; ctx.lineWidth = Math.max(2, r * 0.09); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y + r * 0.05, r * 0.42, on ? 0.15 * Math.PI : 0.3 * Math.PI, on ? 0.85 * Math.PI : 0.7 * Math.PI); ctx.stroke();
}
function drawDistractor(d) {
  ctx.fillStyle = 'rgba(120,140,190,.45)'; ctx.beginPath();
  if (d.shape === 0) ctx.arc(d.x, d.y, d.r, 0, 7);
  else if (d.shape === 1) ctx.rect(d.x - d.r, d.y - d.r, 2 * d.r, 2 * d.r);
  else { ctx.moveTo(d.x, d.y - d.r); ctx.lineTo(d.x + d.r, d.y + d.r); ctx.lineTo(d.x - d.r, d.y + d.r); ctx.closePath(); }
  ctx.fill();
}
function drawGazeDot(x, y) { ctx.strokeStyle = 'rgba(80,220,255,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, 7); ctx.stroke(); }

// Sonido de recompensa breve (WebAudio).
let audio;
function chime() {
  if (!state.cfg.sonido) return;
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.4);
  } catch { /* sin audio */ }
}

// Muestra un punto animado y recoge muestras durante [desde, hasta] ms.
async function presentPoint(from, to, { collect, moveMs = 700, settleMs = 500, collectMs = 1000, minSamples = 12, maxMs = 4000 }) {
  const samples = []; const off = gaze.on((s) => { if (collecting && s.ok) samples.push(collect(s)); });
  let collecting = false; const t0 = performance.now();
  return new Promise((resolve) => {
    const frame = () => {
      const t = performance.now() - t0; clear();
      const u = Math.min(1, t / moveMs), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
      const ppd = pxPerDeg(), base = 1.4 * ppd;
      const pulse = t > moveMs ? base * (1 + 0.6 * Math.max(0, 1 - (t - moveMs) / 600)) : base * 1.6;
      drawTarget(x, y, pulse, t > moveMs + settleMs, t);
      ctx.fillStyle = '#10172a'; ctx.beginPath(); ctx.arc(x, y, ppd * 0.12, 0, 7); ctx.fill();
      collecting = t > moveMs + settleMs;
      const enough = t > moveMs + settleMs + collectMs && samples.length >= minSamples;
      if (enough || t > moveMs + settleMs + maxMs) { off(); resolve(samples); } else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// ---------------- Calibración y validación ----------------
function gridPoints(fracs) { return fracs.map(([fx, fy]) => ({ x: fx * innerWidth, y: fy * innerHeight })); }
function shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

async function runCalibration() {
  await enterStage();
  stageMessage('Mira la carita amarilla 😊'); clear(); await sleep(1800); stageMessage('');
  const cal = shuffle(gridPoints([[.1, .1], [.5, .1], [.9, .1], [.1, .5], [.5, .5], [.9, .5], [.1, .9], [.5, .9], [.9, .9]]));
  const X = [], Y = []; let prev = { x: innerWidth / 2, y: innerHeight / 2 };
  for (const p of cal) {
    const ss = await presentPoint(prev, p, { collect: (s) => s.f });
    ss.forEach((f) => { X.push(f); Y.push([p.x, p.y]); }); prev = p;
  }
  if (X.length < 60) { leaveStage(); alert('No se obtuvieron suficientes datos de la mirada. Revise la iluminación y la posición, y vuelva a calibrar.'); show('camara'); startCameraPreview(); return; }
  state.model = new GazeModel().fit(X, Y, 1.0);
  gaze.model = state.model;
  // Validación con puntos distintos a los de calibración.
  const val = shuffle(gridPoints([[.3, .3], [.7, .3], [.5, .5], [.3, .7], [.7, .7]])); const pts = [];
  for (const p of val) {
    const ss = await presentPoint(prev, p, { collect: (s) => ({ x: s.x, y: s.y }) });
    pts.push({ ...p, samples: ss }); prev = p;
  }
  state.calidad = { ...validationQuality(pts, pxPerDeg()), W: innerWidth, H: innerHeight, muestrasCalibracion: X.length };
  state.calidad.modelo = state.model.toJSON();
  leaveStage(); renderQuality(); show('calidad');
}

function renderQuality() {
  const q = state.calidad, cls = (v) => (v < 2 ? 'ok' : v < 4 ? 'warn' : 'bad');
  const lbl = (v) => (v < 2 ? 'Buena' : v < 4 ? 'Aceptable' : 'Recalibrar');
  $('#calidad-resumen').innerHTML = `
    <div class="q ${cls(q.exactitudDeg)}">Exactitud<b>${q.exactitudDeg.toFixed(2)}°</b>${lbl(q.exactitudDeg)}</div>
    <div class="q ${cls(q.precisionRmsDeg * 2)}">Precisión (RMS)<b>${q.precisionRmsDeg.toFixed(2)}°</b></div>
    <div class="q">Frecuencia de cámara<b>${gaze.fps.toFixed(0)} Hz</b>${gaze.cameraInfo ? gaze.cameraInfo.width + '×' + gaze.cameraInfo.height : ''}</div>`;
  const c = $('#calidad-mapa'), g = c.getContext('2d'), sx = c.width / q.W, sy = c.height / q.H;
  g.fillStyle = '#10172a'; g.fillRect(0, 0, c.width, c.height);
  for (const p of q.points) {
    g.strokeStyle = '#ffd43b'; g.lineWidth = 2; g.beginPath(); g.arc(p.x * sx, p.y * sy, pxPerDeg() * 2 * sx, 0, 7); g.stroke();
    g.strokeStyle = '#4fd1ff'; g.beginPath(); g.moveTo(p.mx * sx - 6, p.my * sy - 6); g.lineTo(p.mx * sx + 6, p.my * sy + 6); g.moveTo(p.mx * sx + 6, p.my * sy - 6); g.lineTo(p.mx * sx - 6, p.my * sy + 6); g.stroke();
  }
}

// ---------------- Plan de sesión ----------------
async function buildPlan() {
  const c = state.cfg, prev = await db.sessionsOf(c.participante);
  c.numeroSesion = prev.length + 1;
  if (c.tipoSesion === 'entrenamiento') {
    const lastT = prev.filter((s) => s.tipoSesion === 'entrenamiento').pop();
    const id = lastT ? lastT.moduloSiguiente : 1;
    const m = MODULES.find((x) => x.id === id) || MODULES[0];
    state.plan = Array.from({ length: TRAINING_BLOCKS_PER_SESSION }, () => m);
  } else if (c.tipoSesion === 'libre') {
    const m = [...MODULES, ...EVALUATION_BATTERY].find((x) => String(x.id) === String(c.modulo));
    state.plan = [m];
  } else state.plan = EVALUATION_BATTERY.slice();
}
function showPlan() {
  const c = state.cfg, total = state.plan.reduce((s, m) => s + estDuration(m), 0);
  $('#plan-info').innerHTML = `<p><b>${c.participante}</b> · ${c.grupo} · ${c.condicion} · sesión ${c.numeroSesion} · ${labelTipo(c.tipoSesion)}<br>
    Actividad estimada: ${(total / 60).toFixed(1)} min · Fuente: ${c.entrada === 'raton' ? 'ratón (prueba)' : 'cámara'}${state.calidad ? ` · exactitud ${state.calidad.exactitudDeg.toFixed(2)}°` : ''}</p>`;
  $('#plan-lista').innerHTML = state.plan.map((m) => `<li>Módulo ${m.id} · ${m.name} — ${m.type}${m.speedDegS ? `, ${[].concat(m.speedDegS).join('–')}°/s` : ''} (${Math.round(estDuration(m))} s)</li>`).join('');
  $('#btn-plan-recal').hidden = c.entrada === 'raton';
  show('plan');
}
const estDuration = (m) => createStimulus(m, { W: 1600, H: 900, pxPerDeg: 40 }).durationMs / 1000;
const labelTipo = (t) => ({ entrenamiento: 'Entrenamiento', T0: 'Evaluación T0', T1: 'Evaluación T1', T2: 'Evaluación T2', libre: 'Práctica libre' })[t];
$('#btn-iniciar').onclick = () => runSession();

// ---------------- Ejecución de la sesión ----------------
let keyHandler = null;
async function driftCheck() {
  const c = { x: innerWidth / 2, y: innerHeight / 2 };
  const ss = await presentPoint(c, c, { moveMs: 0, settleMs: 500, collectMs: 700, minSamples: 8, maxMs: 3000, collect: (s) => ({ x: s.x, y: s.y }) });
  if (!state.model || ss.length < 8) return null;
  const mx = ss.reduce((a, s) => a + s.x, 0) / ss.length, my = ss.reduce((a, s) => a + s.y, 0) / ss.length;
  const dx = c.x - mx, dy = c.y - my, deg = Math.hypot(dx, dy) / pxPerDeg();
  if (deg < 5) { state.model.offset = [state.model.offset[0] + dx, state.model.offset[1] + dy]; return { dxPx: dx, dyPx: dy, deg, aplicada: true }; }
  return { dxPx: dx, dyPx: dy, deg, aplicada: false };
}

async function runSession() {
  const c = state.cfg, P = params();
  const session = {
    id: `${c.participante}-${Date.now()}`, version: VERSION, participante: c.participante, grupo: c.grupo, condicion: c.condicion,
    tipoSesion: c.tipoSesion, numeroSesion: c.numeroSesion, inicio: new Date().toISOString(), entrada: c.entrada,
    equipo: { anchoCm: c.anchoCm, distanciaCm: c.distanciaCm, pantallaPx: [screen.width, screen.height], camara: gaze.cameraInfo, navegador: navigator.userAgent },
    calidad: state.calidad && { exactitudDeg: state.calidad.exactitudDeg, precisionRmsDeg: state.calidad.precisionRmsDeg, puntos: state.calidad.points },
    parametros: P, bloques: [],
  };
  await enterStage();
  const ctl = { abort: false, skip: false, pause: false };
  keyHandler = (e) => {
    if (e.code === 'Escape') ctl.abort = true;
    else if (e.code === 'KeyS') ctl.skip = true;
    else if (e.code === 'Space') { ctl.pause = !ctl.pause; e.preventDefault(); }
    else if (e.code === 'KeyG') state.showGaze = !state.showGaze;
  };
  addEventListener('keydown', keyHandler);
  let estrellas = 0;
  for (let i = 0; i < state.plan.length && !ctl.abort; i++) {
    const m = state.plan[i];
    stageMessage(i === 0 ? '¡Vamos a jugar! Sigue a la carita con tus ojos 👀' : `¡Muy bien! ⭐ × ${estrellas}`);
    clear(); await sleep(2200); stageMessage('');
    const deriva = c.deriva && c.entrada !== 'raton' ? await driftCheck() : null;
    const b = await runBlock(m, i, ctl);
    b.deriva = deriva; estrellas += b.estrellas;
    session.bloques.push(b);
  }
  removeEventListener('keydown', keyHandler);
  stageMessage(`¡Terminamos! ⭐ × ${estrellas}`); clear(); await sleep(1800);
  leaveStage();
  if (!session.bloques.length) { show('plan'); return; }
  session.fin = new Date().toISOString();
  for (const b of session.bloques) b.metricas = analyzeBlock({ samples: b.samples, events: b.events, pxPerDeg: b.geom.pxPerDeg }, P);
  if (session.tipoSesion === 'entrenamiento') session.moduloSiguiente = await decideProgression(session);
  await db.saveSession(session);
  state.lastSession = session;
  renderResults(session); show('resultados');
}

function runBlock(mod, index, ctl) {
  const geom = { W: innerWidth, H: innerHeight, pxPerDeg: pxPerDeg() };
  const seed = (Date.now() ^ (index * 2654435761)) >>> 0;
  const stim = createStimulus(mod, geom, seed);
  const samples = []; const fx = new OneEuro(1.2, 0.02), fy = new OneEuro(1.2, 0.02);
  let t0 = performance.now(), pausedAcc = 0, pauseStart = null, lastOk = performance.now(), autoPaused = false;
  let fgx = null, fgy = null, onTime = 0, lastOnT = null, estrellas = 0, pausas = 0;
  const stimTime = (tAbs) => tAbs - t0 - pausedAcc;
  const off = gaze.on((s) => {
    if (pauseStart !== null) return;
    const t = stimTime(s.t); if (t < 0 || t > stim.durationMs) return;
    const tg = stim.at(t);
    if (s.ok) { lastOk = performance.now(); fgx = fx.filter(s.x, s.t); fgy = fy.filter(s.y, s.t); }
    samples.push({ t: +t.toFixed(1), ok: s.ok ? 1 : 0, gx: s.ok ? +s.x.toFixed(1) : null, gy: s.ok ? +s.y.toFixed(1) : null,
      tx: +tg.x.toFixed(1), ty: +tg.y.toFixed(1), tvis: tg.visible ? 1 : 0, motivo: s.ok ? '' : s.reason || '' });
  });
  return new Promise((resolve) => {
    const frame = () => {
      const now = performance.now();
      // Pausa manual o automática si se pierde el rostro > 1.5 s.
      const lost = gaze.mode === 'camara' && now - lastOk > 1500;
      if ((ctl.pause || lost) && pauseStart === null) { pauseStart = now; pausas++; autoPaused = lost && !ctl.pause; stageMessage(autoPaused ? '¿Dónde estás? 🙈<br><small>Mira de nuevo a la pantalla</small>' : 'Pausa<br><small>Espacio para continuar</small>'); }
      if (pauseStart !== null && !ctl.pause && !lost) { pausedAcc += now - pauseStart; pauseStart = null; stageMessage(''); }
      const t = pauseStart !== null ? pauseStart - t0 - pausedAcc : stimTime(now);
      if (t >= stim.durationMs || ctl.skip || ctl.abort) {
        off(); ctl.skip = false;
        resolve({ indice: index + 1, modulo: mod, semilla: seed, geom, durationMs: stim.durationMs, terminado: t >= stim.durationMs, pausas, estrellas, samples, events: stim.events });
        return;
      }
      clear();
      for (const d of stim.distractors(t)) drawDistractor(d);
      const tg = stim.at(t);
      const on = fgx !== null && tg.visible && Math.hypot(fgx - tg.x, fgy - tg.y) < Math.max(params().aoiDeg * geom.pxPerDeg, tg.size * 0.75);
      if (on && pauseStart === null) { if (lastOnT !== null) onTime += now - lastOnT; lastOnT = now; if (onTime > 1000) { onTime -= 1000; estrellas++; chime(); } } else lastOnT = null;
      if (tg.visible) drawTarget(tg.x, tg.y, tg.size, on, t);
      if (state.showGaze && fgx !== null) drawGazeDot(fgx, fgy);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// Regla adaptativa entre sesiones de entrenamiento.
async function decideProgression(session) {
  const cur = session.bloques[0].modulo.id;
  const tos = (s) => { const v = s.bloques.map((b) => b.metricas.tiempoSobreObjeto).filter((x) => !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  const now = tos(session);
  const prev = (await db.sessionsOf(session.participante)).filter((s) => s.tipoSesion === 'entrenamiento' && s.bloques[0].modulo.id === cur);
  const recent = [...prev.slice(-(PROGRESSION.sessionsToAdvance - 1)).map(tos), now];
  session.progresion = { modulo: cur, tiempoSobreObjeto: now };
  if (recent.length >= PROGRESSION.sessionsToAdvance && recent.every((v) => v >= PROGRESSION.advanceOnTarget)) return Math.min(MODULES.length, cur + 1);
  if (now < PROGRESSION.retreatOnTarget) return Math.max(1, cur - 1);
  return cur;
}

// ---------------- Resultados ----------------
const KEY_METRICS = ['tiempoSobreObjeto', 'rachaMaximaS', 'errorMedioDeg', 'gananciaPersecucion', 'sacadasPorMin', 'fijacionMaximaSobreObjetoMs', 'latenciaMediaMs', 'latenciaDEms', 'gananciaSacadica', 'ensayosValidos', 'perdidaDatos', 'frecuenciaHz'];
function renderResults(s) {
  $('#res-info').innerHTML = `<p><b>${s.participante}</b> · ${s.grupo} · ${labelTipo(s.tipoSesion)} · sesión ${s.numeroSesion} · ${new Date(s.inicio).toLocaleString('es-MX')}</p>`;
  const head = `<tr><th>Métrica</th>${s.bloques.map((b) => `<th>Bloque ${b.indice}<br><small>${b.modulo.name}</small></th>`).join('')}</tr>`;
  const rows = KEY_METRICS.filter((k) => s.bloques.some((b) => b.metricas[k] !== undefined && !Number.isNaN(b.metricas[k])))
    .map((k) => `<tr><td>${METRIC_LABELS[k][0]}</td>${s.bloques.map((b) => `<td>${fmt(k, b.metricas[k])}</td>`).join('')}</tr>`).join('');
  $('#res-tabla').innerHTML = head + rows;
  const pr = $('#res-progresion');
  if (s.moduloSiguiente) {
    const nm = MODULES.find((m) => m.id === s.moduloSiguiente);
    const cur = s.progresion.modulo;
    pr.innerHTML = `Tiempo medio sobre el objeto: <b>${(s.progresion.tiempoSobreObjeto * 100).toFixed(0)} %</b>. Próxima sesión: <b>módulo ${nm.id} · ${nm.name}</b> ${s.moduloSiguiente > cur ? '(avanza)' : s.moduloSiguiente < cur ? '(retrocede)' : '(se mantiene)'}.`;
    pr.hidden = false;
  } else pr.hidden = true;
}
$('#btn-crudo').onclick = () => { const s = state.lastSession; db.download(`${s.id}-crudo.csv`, db.toCSV(db.rawRows(s), ['bloque', 'modulo', 't', 'ok', 'gx', 'gy', 'tx', 'ty', 'tvis', 'motivo'])); };
$('#btn-resumen-sesion').onclick = () => { const r = db.summaryRows([state.lastSession]); db.download(`${state.lastSession.id}-resumen.csv`, db.toCSV(r, Object.keys(r[0]))); };

// ---------------- Historial ----------------
async function renderHistory() {
  const all = await db.allSessions(), sel = $('#hist-participante');
  const ps = [...new Set(all.map((s) => s.participante))];
  const cur = sel.value || (state.cfg && state.cfg.participante) || ps[0];
  sel.innerHTML = ps.map((p) => `<option ${p === cur ? 'selected' : ''}>${p}</option>`).join('');
  const list = all.filter((s) => s.participante === sel.value);
  const avg = (s, k) => { const v = s.bloques.map((b) => b.metricas[k]).filter((x) => x !== undefined && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  $('#hist-tabla').innerHTML = `<tr><th>Sesión</th><th>Fecha</th><th>Tipo</th><th>Módulo</th><th>Exactitud calib.</th><th>Tiempo sobre objeto</th><th>Mantenimiento máx.</th><th>Ganancia persec.</th><th>Latencia</th><th></th></tr>` +
    list.map((s) => `<tr><td>${s.numeroSesion}</td><td>${new Date(s.inicio).toLocaleDateString('es-MX')}</td><td>${labelTipo(s.tipoSesion)}</td><td>${[...new Set(s.bloques.map((b) => b.modulo.id))].join(', ')}</td>
      <td>${s.calidad ? s.calidad.exactitudDeg.toFixed(2) + '°' : '—'}</td><td>${fmt('tiempoSobreObjeto', avg(s, 'tiempoSobreObjeto'))}</td><td>${fmt('rachaMaximaS', avg(s, 'rachaMaximaS'))}</td>
      <td>${fmt('gananciaPersecucion', avg(s, 'gananciaPersecucion'))}</td><td>${fmt('latenciaMediaMs', avg(s, 'latenciaMediaMs'))}</td>
      <td><button data-del="${s.id}">Eliminar</button> <button data-raw="${s.id}">CSV crudo</button></td></tr>`).join('');
  const charts = [['tiempoSobreObjeto', 'Tiempo sobre el objeto (%)', 100], ['rachaMaximaS', 'Mantenimiento máximo (s)', 1], ['gananciaPersecucion', 'Ganancia de persecución', 1], ['latenciaMediaMs', 'Latencia media (ms)', 1]];
  $('#hist-graficas').innerHTML = list.length ? charts.map(([k, t, f]) => chart(t, list.map((s) => ({ x: s.numeroSesion, y: avg(s, k) * f, tipo: s.tipoSesion })))).join('') : '<p class="hint">Aún no hay sesiones guardadas en este equipo.</p>';
}
function chart(title, pts) {
  pts = pts.filter((p) => !Number.isNaN(p.y));
  const W = 300, H = 140, pad = 28;
  if (!pts.length) return `<div class="chart"><h4>${title}</h4><p class="hint">Sin datos</p></div>`;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), y0 = Math.min(0, ...ys), y1 = Math.max(...ys) * 1.1 || 1;
  const X = (x) => pad + (x - x0) / (x1 - x0) * (W - pad - 8), Y = (y) => H - pad + 6 - (y - y0) / (y1 - y0) * (H - pad - 6);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const dots = pts.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.tipo === 'entrenamiento' ? 3 : 5}" fill="${p.tipo === 'entrenamiento' ? 'var(--accent)' : 'var(--warn)'}"><title>Sesión ${p.x}: ${p.y.toFixed(1)}</title></circle>`).join('');
  return `<div class="chart"><h4>${title}</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    <line x1="${pad}" x2="${W - 8}" y1="${H - pad + 6}" y2="${H - pad + 6}" stroke="var(--line)"/>
    <text x="${pad - 4}" y="${Y(y1) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${y1.toFixed(0)}</text>
    <text x="${pad - 4}" y="${Y(y0) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${y0.toFixed(0)}</text>
    <text x="${W - 8}" y="${H - 4}" text-anchor="end" font-size="10" fill="var(--muted)">sesión</text>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${dots}</svg>
    <small class="hint">● grande = evaluación (T0/T1/T2)</small></div>`;
}
$('#hist-participante').onchange = renderHistory;
$('#hist-tabla').onclick = async (e) => {
  const del = e.target.dataset.del, raw = e.target.dataset.raw;
  if (del && confirm('¿Eliminar definitivamente esta sesión de este equipo?')) { await db.deleteSession(del); renderHistory(); }
  if (raw) { const s = (await db.allSessions()).find((x) => x.id === raw); db.download(`${s.id}-crudo.csv`, db.toCSV(db.rawRows(s), ['bloque', 'modulo', 't', 'ok', 'gx', 'gy', 'tx', 'ty', 'tvis', 'motivo'])); }
};
$('#btn-export-todo').onclick = async () => { const r = db.summaryRows(await db.allSessions()); if (!r.length) return alert('No hay sesiones.'); const cols = [...new Set(r.flatMap((x) => Object.keys(x)))]; db.download(`resumen-seguimiento-ocular-${new Date().toISOString().slice(0, 10)}.csv`, db.toCSV(r, cols)); };
$('#btn-respaldo').onclick = async () => db.download(`respaldo-seguimiento-ocular-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'seguimiento-ocular-tea', version: VERSION, sesiones: await db.allSessions() }), 'application/json');
$('#in-respaldo').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try { const data = JSON.parse(await file.text()); for (const s of data.sesiones || []) await db.saveSession(s); alert(`Importadas ${data.sesiones.length} sesiones.`); renderHistory(); }
  catch (err) { alert('Archivo no válido: ' + err.message); }
  e.target.value = '';
};
$('#btn-recalcular').onclick = async () => {
  if (!confirm('Se recalcularán las métricas de TODAS las sesiones con los parámetros actuales. ¿Continuar?')) return;
  const P = params();
  for (const s of await db.allSessions()) { for (const b of s.bloques) b.metricas = analyzeBlock({ samples: b.samples, events: b.events, pxPerDeg: b.geom.pxPerDeg }, P); s.parametros = P; await db.saveSession(s); }
  renderHistory();
};

addEventListener('resize', () => { if (!stage.hidden) resizeStage(); });
show('inicio');
