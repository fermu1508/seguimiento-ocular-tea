import { VERSION, MODULES, EVALUATION_BATTERY, ANALYSIS_DEFAULTS, PROGRESSION, TRAINING_BLOCKS_PER_SESSION, FIGURES, COLORS, EVAL_TARGET, FEEDBACK, EYETRACKER_URL } from './config.js';
import { GazeSource, GazeModel, OneEuro, HEAD_LIMITS } from './tracker.js';
import { createStimulus } from './stimuli.js';
import { analyzeBlock, validationQuality, METRIC_LABELS, fmt } from './analysis.js';
import * as db from './storage.js';
import * as drive from './drive.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), ctx = stage.getContext('2d'), msg = $('#stage-msg');
const gaze = new GazeSource();
window.seguimientoOcular = { gaze }; // acceso para diagnóstico desde la consola
const state = { cfg: null, model: null, calidad: null, plan: [], lastSession: null, showGaze: false, participantes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------- Navegación ----------------
function show(name) {
  document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== name));
  if (name === 'historial') renderHistory();
  if (name === 'inicio') $('#form-inicio').fechaSesion.value = new Date().toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'short' });
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

// ---------------- Inicio y participantes ----------------
const form = $('#form-inicio');
[...MODULES, ...EVALUATION_BATTERY].forEach((m) => form.modulo.add(new Option(`${m.id}. ${m.name}`, m.id)));
Object.entries(FIGURES).forEach(([k, v]) => form.figura.add(new Option(v, k)));
Object.keys(COLORS).forEach((k) => form.color.add(new Option(k[0].toUpperCase() + k.slice(1), k)));
form.tipoSesion.onchange = () => ($('#campo-modulo').hidden = form.tipoSesion.value !== 'libre');
const saved = LS.get('equipo', {});
if (saved.anchoCm) form.anchoCm.value = saved.anchoCm;
if (saved.distanciaCm) form.distanciaCm.value = saved.distanciaCm;
if (saved.entrada) form.entrada.value = saved.entrada;
if (saved.resolucion) form.resolucion.value = saved.resolucion;
renderParams();

async function loadParticipants(select) {
  state.participantes = await db.allParticipants();
  const sel = form.participanteSel; sel.length = 1;
  for (const p of state.participantes) sel.add(new Option(`${p.codigo}${p.nombre ? ' — ' + p.nombre : ''}`, p.codigo));
  sel.value = select && state.participantes.some((p) => p.codigo === select) ? select : (state.participantes.length ? state.participantes[state.participantes.length - 1].codigo : '__nuevo');
  fillParticipant();
}
async function fillParticipant() {
  const p = state.participantes.find((x) => x.codigo === form.participanteSel.value);
  form.codigo.readOnly = !!p;
  form.codigo.value = p ? p.codigo : ''; form.nombre.value = p ? p.nombre || '' : '';
  form.nacimiento.value = p ? p.nacimiento || '' : '';
  form.grupo.value = p ? p.grupo : 'TEA'; form.condicion.value = p ? p.condicion : 'entrenamiento';
  form.figura.value = p ? p.figura || 'circulo' : 'circulo'; form.color.value = p ? p.color || 'amarillo' : 'amarillo';
  const info = $('#info-participante');
  if (!p) { info.textContent = 'Nuevo participante: se guardará al comenzar la sesión.'; return; }
  const ses = await db.sessionsOf(p.codigo), last = ses[ses.length - 1];
  const edad = db.ageYears(p.nacimiento);
  info.textContent = `${ses.length} sesiones registradas${last ? ` · última: ${db.fechaLocal(last.inicio)} (${labelTipo(last.tipoSesion)})` : ''}${edad ? ` · edad: ${edad.toFixed(1)} años` : ''}${last && last.moduloSiguiente ? ` · siguiente módulo: ${last.moduloSiguiente}` : ''}`;
}
form.participanteSel.onchange = fillParticipant;
loadParticipants();

form.onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(form), codigo = String(f.get('codigo')).trim().toUpperCase();
  const nuevo = form.participanteSel.value === '__nuevo';
  if (nuevo && state.participantes.some((p) => p.codigo === codigo)) { alert(`El código ${codigo} ya existe. Selecciónelo en la lista.`); return; }
  const prev = state.participantes.find((p) => p.codigo === codigo);
  const part = { codigo, nombre: String(f.get('nombre')).trim(), nacimiento: f.get('nacimiento') || '', grupo: f.get('grupo'), condicion: f.get('condicion'),
    figura: f.get('figura'), color: f.get('color'), registrado: prev ? prev.registrado : new Date().toISOString() };
  await db.saveParticipant(part);
  state.cfg = {
    participante: codigo, grupo: part.grupo, condicion: part.condicion, edadAnios: db.ageYears(part.nacimiento), figura: part.figura, color: part.color,
    tipoSesion: f.get('tipoSesion'), modulo: f.get('modulo'), anchoCm: Number(f.get('anchoCm')), distanciaCm: Number(f.get('distanciaCm')),
    entrada: f.get('entrada'), resolucion: f.get('resolucion'), deriva: !!f.get('deriva'),
  };
  LS.set('equipo', { anchoCm: state.cfg.anchoCm, distanciaCm: state.cfg.distanciaCm, entrada: state.cfg.entrada, resolucion: state.cfg.resolucion });
  await loadParticipants(codigo);
  await buildPlan();
  if (state.cfg.entrada === 'raton') {
    gaze.stop(); gaze.startMouse(); state.model = null; state.calidad = null; showPlan();
  } else {
    show('camara'); startPreparation();
  }
};

// px por grado de ángulo visual: tamaño físico de la pantalla + distancia.
function pxPerDeg() {
  const pxPerCm = screen.width / state.cfg.anchoCm;
  return pxPerCm * 2 * state.cfg.distanciaCm * Math.tan(Math.PI / 360);
}

// ---------------- Preparación: cámara o eye tracker ----------------
let previewOff = null;
async function startPreparation() {
  const st = $('#cam-status'), btn = $('#btn-calibrar'), et = state.cfg.entrada === 'eyetracker';
  $('#cam-wrap').hidden = et; $('#tips-camara').hidden = et; $('#tips-et').hidden = !et;
  btn.textContent = et ? 'Validar (pantalla completa)' : 'Calibrar (pantalla completa)';
  btn.disabled = true; st.className = 'status';
  if (previewOff) { previewOff(); previewOff = null; }
  if (gaze.mode !== state.cfg.entrada || (!et && gaze.res !== state.cfg.resolucion)) {
    gaze.stop(); state.model = null; gaze.model = null;
    try {
      if (et) await gaze.startEyeTracker(EYETRACKER_URL, (m) => (st.textContent = m));
      else await gaze.startCamera($('#video'), (m) => (st.textContent = m), state.cfg.resolucion.split('x').map(Number));
    } catch (err) { gaze.stop(); st.textContent = (et ? '' : 'No fue posible iniciar la cámara: ') + err.message; st.className = 'status bad'; return; }
  }
  const ov = $('#cam-overlay'), octx = ov.getContext('2d');
  let okCount = 0;
  previewOff = gaze.on((s) => {
    okCount = s.ok ? okCount + 1 : 0;
    if (et) {
      if (okCount > 15) { st.textContent = `Eye tracker conectado (${gaze.cameraInfo ? esc(gaze.cameraInfo.label) : ''}) · ${gaze.fps.toFixed(0)} Hz · mirada detectada`; st.className = 'status ok'; btn.disabled = false; }
      else if (!s.ok) { st.textContent = 'Eye tracker conectado, pero no detecta los ojos'; st.className = 'status bad'; }
      return;
    }
    ov.width = ov.clientWidth; ov.height = ov.clientHeight; octx.clearRect(0, 0, ov.width, ov.height);
    if (s.landmarks) {
      octx.fillStyle = '#4ade80';
      for (const i of [468, 473, 33, 133, 362, 263]) { const p = s.landmarks[i]; octx.beginPath(); octx.arc(p.x * ov.width, p.y * ov.height, 3, 0, 7); octx.fill(); }
    }
    const dist = s.scale ? `Tamaño del rostro: ${(s.scale * 100).toFixed(0)} %` : '';
    if (s.ok && okCount > 15) {
      const lento = gaze.fps < 20, camLenta = gaze.camFps && gaze.camFps < 20;
      st.innerHTML = `Rostro y ojos detectados · cámara entrega ${gaze.camFps ? gaze.camFps.toFixed(0) : '?'} cuadros/s · se procesan ${gaze.fps.toFixed(0)}/s · procesamiento ${gaze.delegate || ''} ${gaze.procMs ? gaze.procMs.toFixed(0) + ' ms' : ''} (${gaze.hilo === 'paralelo' ? 'en paralelo' : 'hilo principal'}) · ${dist}` +
        (camLenta ? `<br><small>⚠ La cámara entrega pocas imágenes por segundo. Suele deberse a poca luz: encienda una lámpara frente al rostro (no detrás) y aleje la cámara de ventanas a contraluz. En Windows, abra la app Cámara → Configuración y desactive «Compensación de poca luz» si existe.</small>` : '') +
        (lento && !camLenta ? `<br><small>⚠ Frecuencia baja (ideal ≥ 25). Cierre otros programas y pestañas; en Chrome active Configuración → Sistema → «Usar aceleración de gráficos cuando esté disponible» y reinicie el navegador.</small>` : '');
      st.className = lento ? 'status' : 'status ok'; btn.disabled = false;
    }
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
const STAGE_BG = '#10172a';
function clear() { ctx.fillStyle = STAGE_BG; ctx.fillRect(0, 0, innerWidth, innerHeight); }
function stageMessage(html) { msg.innerHTML = html; msg.hidden = !html; }

// ---------------- Figuras (estímulos no sociales) ----------------
// Diana con cruz y punto central (Thaler et al., 2013): disco exterior de
// diámetro d, cruz del color del fondo y punto central de d/3.
function drawABC(x, y, d, color = EVAL_TARGET.color) {
  const r = d / 2;
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.strokeStyle = STAGE_BG; ctx.lineWidth = Math.max(1.5, d * 0.12);
  ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, d / 6, 0, 7); ctx.fill();
}
function drawShape(fig, x, y, d, color) {
  const r = d / 2; ctx.fillStyle = color; ctx.beginPath();
  if (fig === 'estrella') {
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.05; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
    ctx.closePath();
  } else if (fig === 'rombo') { ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r * 0.8, y); ctx.lineTo(x, y + r * 1.1); ctx.lineTo(x - r * 0.8, y); ctx.closePath(); }
  else if (fig === 'cuadrado') ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
  else ctx.arc(x, y, r, 0, 7);
  ctx.fill();
}
// Figura de un bloque: diana en evaluación; figura del participante en entrenamiento.
const blockFigure = (mod) => (String(mod.id).startsWith('E') || state.cfg.tipoSesion.startsWith('T')
  ? { figura: 'diana', color: EVAL_TARGET.color }
  : { figura: state.cfg.figura, color: COLORS[state.cfg.color] || COLORS.amarillo });
function drawTarget(fig, x, y, d, on, t) {
  if (on && FEEDBACK.visual) {
    const r = d / 2, g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2);
    g.addColorStop(0, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
    for (let i = 0; i < 6; i++) { const a = t / 600 + i * Math.PI / 3; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 1.6, y + Math.sin(a) * r * 1.6, r * 0.09, 0, 7); ctx.fill(); }
  }
  if (fig.figura === 'diana') drawABC(x, y, d, fig.color); else drawShape(fig.figura, x, y, d, fig.color);
}
function drawDistractor(d) {
  ctx.fillStyle = 'rgba(120,140,190,.45)'; ctx.beginPath();
  if (d.shape === 0) ctx.arc(d.x, d.y, d.r, 0, 7);
  else if (d.shape === 1) ctx.rect(d.x - d.r, d.y - d.r, 2 * d.r, 2 * d.r);
  else { ctx.moveTo(d.x, d.y - d.r); ctx.lineTo(d.x + d.r, d.y + d.r); ctx.lineTo(d.x - d.r, d.y + d.r); ctx.closePath(); }
  ctx.fill();
}
function drawGazeDot(x, y) { ctx.strokeStyle = 'rgba(80,220,255,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, 7); ctx.stroke(); }

let audio;
function chime() {
  if (!FEEDBACK.sonido) return;
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.4);
  } catch { /* sin audio */ }
}

// Presenta la diana (se desplaza, se encoge y se detiene) y recoge muestras.
async function presentPoint(from, to, { collect, moveMs = 700, settleMs = 500, collectMs = 1000, minSamples = 12, maxMs = 4000 }) {
  const samples = []; let collecting = false;
  const off = gaze.on((s) => { if (collecting && s.ok) samples.push(collect(s)); });
  const t0 = performance.now();
  return new Promise((resolve) => {
    const frame = () => {
      const t = performance.now() - t0; clear();
      const u = moveMs ? Math.min(1, t / moveMs) : 1, e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
      const base = 1.2 * pxPerDeg();
      const d = t > moveMs ? base * (1 + 0.8 * Math.max(0, 1 - (t - moveMs) / 600)) : base * 1.8;
      drawABC(x, y, d);
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
  const et = state.cfg.entrada === 'eyetracker';
  await enterStage();
  stageMessage('Mira el punto blanco'); clear(); await sleep(1800); stageMessage('');
  let prev = { x: innerWidth / 2, y: innerHeight / 2 }, nCal = 0;
  if (!et) {
    const cal = shuffle(gridPoints([[.1, .1], [.5, .1], [.9, .1], [.1, .5], [.5, .5], [.9, .5], [.1, .9], [.5, .9], [.9, .9]]));
    const X = [], Y = [];
    for (const p of cal) {
      const ss = await presentPoint(prev, p, { collect: (s) => s.f });
      ss.forEach((f) => { X.push(f); Y.push([p.x, p.y]); }); prev = p;
    }
    if (X.length < 60) { leaveStage(); alert('No se obtuvieron suficientes datos de la mirada. Revise la iluminación y la posición, y vuelva a calibrar.'); show('camara'); startPreparation(); return; }
    state.model = new GazeModel().fit(X, Y, 1.0);
    gaze.model = state.model; nCal = X.length;
  }
  state.calidad = { ...(await validationPass(prev)), muestrasCalibracion: nCal };
  leaveStage();
  if (!state.calidad.points.length) { alert('No se recibieron datos de mirada durante la validación.'); show('camara'); startPreparation(); return; }
  renderQuality(); show('calidad');
}

// Validación con 5 puntos distintos a los de calibración.
async function validationPass(prev = { x: innerWidth / 2, y: innerHeight / 2 }) {
  const val = shuffle(gridPoints([[.3, .3], [.7, .3], [.5, .5], [.3, .7], [.7, .7]])); const pts = [];
  for (const p of val) {
    const ss = await presentPoint(prev, p, { collect: (s) => ({ x: s.x, y: s.y }) });
    pts.push({ ...p, samples: ss }); prev = p;
  }
  return { ...validationQuality(pts, pxPerDeg()), W: innerWidth, H: innerHeight };
}

function renderQuality() {
  const q = state.calidad, cls = (v) => (v < 2 ? 'ok' : v < 4 ? 'warn' : 'bad');
  const lbl = (v) => (v < 2 ? 'Buena' : v < 4 ? 'Aceptable' : 'Recalibrar');
  $('#calidad-resumen').innerHTML = `
    <div class="q ${cls(q.exactitudDeg)}">Exactitud<b>${q.exactitudDeg.toFixed(2)}°</b>${lbl(q.exactitudDeg)}</div>
    <div class="q ${cls(q.precisionRmsDeg * 2)}">Precisión (RMS)<b>${q.precisionRmsDeg.toFixed(2)}°</b></div>
    <div class="q ${gaze.fps >= 25 ? 'ok' : gaze.fps >= 15 ? 'warn' : 'bad'}">Frecuencia<b>${gaze.fps.toFixed(0)} Hz</b>${gaze.cameraInfo ? esc(gaze.cameraInfo.label || '') : ''}${gaze.delegate ? ' · ' + gaze.delegate : ''}</div>`;
  const c = $('#calidad-mapa'), g = c.getContext('2d'), sx = c.width / q.W, sy = c.height / q.H;
  g.fillStyle = STAGE_BG; g.fillRect(0, 0, c.width, c.height);
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
    state.plan = [[...MODULES, ...EVALUATION_BATTERY].find((x) => String(x.id) === String(c.modulo))];
  } else state.plan = EVALUATION_BATTERY.slice();
}
const fuente = (e) => ({ raton: 'ratón (prueba)', camara: 'cámara web', eyetracker: 'eye tracker' })[e] || e;
function showPlan() {
  const c = state.cfg, total = state.plan.reduce((s, m) => s + estDuration(m), 0);
  const fig = blockFigure(state.plan[0]);
  $('#plan-info').innerHTML = `<p><b>${esc(c.participante)}</b> · ${c.grupo} · ${c.condicion} · sesión ${c.numeroSesion} · ${labelTipo(c.tipoSesion)} · ${new Date().toLocaleDateString('es-MX', { dateStyle: 'long' })}<br>
    Actividad estimada: ${(total / 60).toFixed(1)} min · Fuente: ${fuente(c.entrada)} · Objeto: ${fig.figura === 'diana' ? 'diana (evaluación)' : FIGURES[fig.figura] + ' ' + c.color}${state.calidad ? ` · exactitud ${state.calidad.exactitudDeg.toFixed(2)}°` : ''}</p>`;
  $('#plan-lista').innerHTML = state.plan.map((m) => `<li>Módulo ${m.id} · ${m.name} — ${m.type}${m.speedDegS ? `, ${[].concat(m.speedDegS).join('–')}°/s` : ''} (${Math.round(estDuration(m))} s)</li>`).join('');
  $('#btn-plan-recal').hidden = c.entrada === 'raton';
  show('plan');
}
const estDuration = (m) => createStimulus(m, { W: 1600, H: 900, pxPerDeg: 40 }).durationMs / 1000;
const labelTipo = (t) => ({ entrenamiento: 'Entrenamiento', T0: 'Evaluación T0', T1: 'Evaluación T1', T2: 'Evaluación T2', libre: 'Práctica libre' })[t] || t;
$('#btn-iniciar').onclick = () => runSession();

// ---------------- Ejecución de la sesión ----------------
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
    id: `${c.participante}-${Date.now()}`, version: VERSION, participante: c.participante, grupo: c.grupo, condicion: c.condicion, edadAnios: c.edadAnios,
    tipoSesion: c.tipoSesion, numeroSesion: c.numeroSesion, inicio: new Date().toISOString(), entrada: c.entrada, retroalimentacion: { ...FEEDBACK },
    equipo: { anchoCm: c.anchoCm, distanciaCm: c.distanciaCm, pantallaPx: [screen.width, screen.height], dispositivo: gaze.cameraInfo, reloj: gaze.clockInfo || null, navegador: navigator.userAgent },
    calidad: state.calidad && { exactitudDeg: state.calidad.exactitudDeg, precisionRmsDeg: state.calidad.precisionRmsDeg, puntos: state.calidad.points },
    parametros: P, bloques: [],
  };
  await enterStage();
  const ctl = { abort: false, skip: false, pause: false };
  const keyHandler = (e) => {
    if (e.code === 'Escape') ctl.abort = true;
    else if (e.code === 'KeyS') ctl.skip = true;
    else if (e.code === 'Space') { ctl.pause = !ctl.pause; e.preventDefault(); }
    else if (e.code === 'KeyG') state.showGaze = !state.showGaze;
  };
  addEventListener('keydown', keyHandler);
  let estrellas = 0;
  for (let i = 0; i < state.plan.length && !ctl.abort; i++) {
    const m = state.plan[i];
    stageMessage(i === 0 ? 'Sigue la figura con tus ojos' : (FEEDBACK.estrellas ? `⭐ × ${estrellas}` : 'Descanso'));
    clear(); await sleep(2200); stageMessage('');
    const deriva = c.deriva && c.entrada === 'camara' ? await driftCheck() : null;
    const b = await runBlock(m, i, ctl);
    b.deriva = deriva; estrellas += b.estrellas;
    session.bloques.push(b);
  }
  removeEventListener('keydown', keyHandler);
  // Validación final: mide cuánto se degradó la calibración durante la sesión.
  if (!ctl.abort && c.entrada !== 'raton' && session.bloques.length) {
    stageMessage('Últimos puntos: mira el punto blanco'); clear(); await sleep(1500); stageMessage('');
    const q = await validationPass();
    if (q.points.length) session.calidadFinal = { exactitudDeg: q.exactitudDeg, precisionRmsDeg: q.precisionRmsDeg, puntos: q.points };
  }
  stageMessage('Terminamos'); clear(); await sleep(1500);
  leaveStage();
  if (!session.bloques.length) { show('plan'); return; }
  session.fin = new Date().toISOString();
  for (const b of session.bloques) b.metricas = blockMetrics(b, P);
  if (session.tipoSesion === 'entrenamiento') session.moduloSiguiente = await decideProgression(session);
  await db.saveSession(session);
  state.lastSession = session;
  renderResults(session); show('resultados');
  if (drive.connected()) uploadToDrive(session);
}

function runBlock(mod, index, ctl) {
  const geom = { W: innerWidth, H: innerHeight, pxPerDeg: pxPerDeg() };
  const seed = (Date.now() ^ (index * 2654435761)) >>> 0;
  const stim = createStimulus(mod, geom, seed);
  const fig = blockFigure(mod);
  const samples = []; const fx = new OneEuro(1.2, 0.02), fy = new OneEuro(1.2, 0.02);
  const t0 = performance.now(); let pausedAcc = 0, pauseStart = null, lastOk = performance.now(), lastGood = performance.now();
  let fgx = null, fgy = null, onTime = 0, lastOnT = null, estrellas = 0, pausas = 0;
  const stimTime = (tAbs) => tAbs - t0 - pausedAcc;
  const off = gaze.on((s) => {
    if (pauseStart !== null) return;
    const t = stimTime(s.t); if (t < 0 || t > stim.durationMs) return;
    const tg = stim.at(t);
    // Con cámara web, si la cabeza se alejó de la posición de calibración la
    // estimación deja de ser confiable: la muestra se marca como inválida.
    const fuera = s.ok && s.head && (s.head.shift > HEAD_LIMITS.shift || Math.abs(s.head.dist) > HEAD_LIMITS.dist);
    const ok = s.ok && !fuera;
    if (s.ok) lastOk = performance.now();
    if (ok) { lastGood = performance.now(); fgx = fx.filter(s.x, s.t); fgy = fy.filter(s.y, s.t); }
    samples.push({ t: +t.toFixed(1), ok: ok ? 1 : 0, gx: ok ? +s.x.toFixed(1) : null, gy: ok ? +s.y.toFixed(1) : null,
      tx: +tg.x.toFixed(1), ty: +tg.y.toFixed(1), tvis: tg.visible ? 1 : 0, motivo: ok ? '' : (fuera ? 'posicion' : s.reason || '') });
  });
  return new Promise((resolve) => {
    const frame = () => {
      const now = performance.now();
      // Pausa manual, o automática si se pierden los ojos o la posición > 1.2 s.
      const lost = gaze.mode !== 'raton' && now - lastGood > 1200;
      if ((ctl.pause || lost) && pauseStart === null) {
        pauseStart = now; pausas++;
        stageMessage(ctl.pause ? 'Pausa<br><small>Espacio para continuar</small>' : now - lastOk > 1200 ? 'Mira de nuevo a la pantalla' : 'Regresa a tu lugar<br><small>como al principio</small>');
      }
      if (pauseStart !== null && !ctl.pause && !lost) { pausedAcc += now - pauseStart; pauseStart = null; stageMessage(''); }
      const t = pauseStart !== null ? pauseStart - t0 - pausedAcc : stimTime(now);
      if (t >= stim.durationMs || ctl.skip || ctl.abort) {
        off(); ctl.skip = false;
        resolve({ indice: index + 1, modulo: mod, figura: fig.figura === 'diana' ? 'diana' : `${fig.figura}-${state.cfg.color}`, semilla: seed, geom,
          durationMs: stim.durationMs, terminado: t >= stim.durationMs, pausas, estrellas, samples, events: stim.events });
        return;
      }
      clear();
      for (const d of stim.distractors(t)) drawDistractor(d);
      const tg = stim.at(t);
      const on = fgx !== null && tg.visible && Math.hypot(fgx - tg.x, fgy - tg.y) < Math.max(params().aoiDeg * geom.pxPerDeg, tg.size * 0.75);
      if (on && pauseStart === null) { if (lastOnT !== null) onTime += now - lastOnT; lastOnT = now; if (onTime > 1000) { onTime -= 1000; if (FEEDBACK.estrellas) estrellas++; chime(); } } else lastOnT = null;
      if (tg.visible) drawTarget(fig, tg.x, tg.y, tg.size, on, t);
      if (state.showGaze && fgx !== null) drawGazeDot(fgx, fgy);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const blockMetrics = (b, P) => ({ ...analyzeBlock({ samples: b.samples, events: b.events, pxPerDeg: b.geom.pxPerDeg }, P), derivaInicialDeg: b.deriva ? b.deriva.deg : NaN });

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

// ---------------- Google Drive ----------------
async function uploadToDrive(s) {
  const out = $('#res-drive');
  if (state.lastSession === s) out.textContent = 'Subiendo a Google Drive…';
  try {
    const ruta = await drive.uploadSession(s);
    s.driveSubido = new Date().toISOString(); await db.saveSession(s);
    if (state.lastSession === s) { out.textContent = `✓ Guardado en Google Drive: ${ruta}`; $('#btn-res-drive').hidden = true; }
    return true;
  } catch (err) {
    if (state.lastSession === s) { out.textContent = 'No se pudo subir a Drive: ' + err.message; $('#btn-res-drive').hidden = !drive.configured(); }
    return false;
  }
}
$('#btn-res-drive').onclick = async () => { try { if (!drive.connected()) await drive.connect(); await uploadToDrive(state.lastSession); } catch (err) { $('#res-drive').textContent = err.message; } };
function renderDriveBox(all) {
  const st = $('#drive-estado'), pend = all.filter((s) => !s.driveSubido).length;
  if (!drive.configured()) { st.textContent = '— no configurado (falta el ID de cliente de Google; ver README).'; $('#btn-drive-conectar').disabled = true; $('#btn-drive-pendientes').disabled = true; return; }
  st.textContent = drive.connected() ? `— conectado · ${pend} sesiones sin subir` : `— desconectado · ${pend} sesiones sin subir`;
  $('#btn-drive-conectar').hidden = drive.connected();
  $('#btn-drive-pendientes').disabled = !drive.connected() || !pend;
}
$('#btn-drive-conectar').onclick = async () => { try { await drive.connect(); renderHistory(); } catch (err) { alert(err.message); } };
$('#btn-drive-pendientes').onclick = async () => {
  const pend = (await db.allSessions()).filter((s) => !s.driveSubido); let ok = 0;
  $('#drive-estado').textContent = `— subiendo ${pend.length} sesiones…`;
  for (const s of pend) if (await uploadToDrive(s)) ok++;
  alert(`Subidas ${ok} de ${pend.length} sesiones.`); renderHistory();
};

// ---------------- Resultados ----------------
const KEY_METRICS = ['derivaInicialDeg', 'tiempoSobreObjeto', 'rachaMaximaS', 'errorMedioDeg', 'gananciaPersecucion', 'sacadasPorMin', 'fijacionMaximaSobreObjetoMs', 'latenciaMediaMs', 'latenciaDEms', 'gananciaSacadica', 'ensayosValidos', 'perdidaDatos', 'frecuenciaHz'];
function renderResults(s) {
  const dur = s.fin ? Math.round((new Date(s.fin) - new Date(s.inicio)) / 60000) : null;
  $('#res-info').innerHTML = `<p><b>${esc(s.participante)}</b> · ${s.grupo} · ${labelTipo(s.tipoSesion)} · sesión ${s.numeroSesion}<br>
    Fecha: <b>${db.fechaLocal(s.inicio)}</b> · inicio ${db.horaLocal(s.inicio)}${s.fin ? ` · fin ${db.horaLocal(s.fin)} (${dur} min)` : ''} · fuente: ${fuente(s.entrada)}${s.edadAnios ? ` · edad ${s.edadAnios.toFixed(1)} años` : ''}<br>
    Exactitud de la calibración: al inicio <b>${s.calidad ? s.calidad.exactitudDeg.toFixed(2) + '°' : '—'}</b> · al final <b>${s.calidadFinal ? s.calidadFinal.exactitudDeg.toFixed(2) + '°' : '—'}</b>${s.equipo.reloj && s.equipo.reloj.captureTime ? ` · reloj de la cámara: ${s.equipo.reloj.fraccionUsada === 1 ? 'sincronizado' : `corregido (desfase ${s.equipo.reloj.desfaseMedianoMs} ms)`}` : ''}</p>`;
  const head = `<tr><th>Métrica</th>${s.bloques.map((b) => `<th>Bloque ${b.indice}<br><small>${esc(b.modulo.name)}</small></th>`).join('')}</tr>`;
  const rows = KEY_METRICS.filter((k) => s.bloques.some((b) => b.metricas[k] !== undefined && !Number.isNaN(b.metricas[k])))
    .map((k) => `<tr><td>${METRIC_LABELS[k][0]}</td>${s.bloques.map((b) => `<td>${fmt(k, b.metricas[k])}</td>`).join('')}</tr>`).join('');
  $('#res-tabla').innerHTML = head + rows;
  const pr = $('#res-progresion');
  if (s.moduloSiguiente) {
    const nm = MODULES.find((m) => m.id === s.moduloSiguiente), cur = s.progresion.modulo;
    pr.innerHTML = `Tiempo medio sobre el objeto: <b>${(s.progresion.tiempoSobreObjeto * 100).toFixed(0)} %</b>. Próxima sesión: <b>módulo ${nm.id} · ${esc(nm.name)}</b> ${s.moduloSiguiente > cur ? '(avanza)' : s.moduloSiguiente < cur ? '(retrocede)' : '(se mantiene)'}.`;
    pr.hidden = false;
  } else pr.hidden = true;
  $('#res-drive').textContent = drive.configured() ? (drive.connected() ? '' : 'Google Drive no está conectado en esta sesión del navegador.') : '';
  $('#btn-res-drive').hidden = !drive.configured() || drive.connected();
}
$('#btn-crudo').onclick = () => { const s = state.lastSession; db.download(`${db.fileBase(s)}_crudo.csv`, db.rawCSV(s)); };
$('#btn-resumen-sesion').onclick = () => { const s = state.lastSession; db.download(`${db.fileBase(s)}_resumen.csv`, db.summaryCSV([s])); };

// ---------------- Historial ----------------
async function renderHistory() {
  const all = await db.allSessions(), sel = $('#hist-participante');
  renderDriveBox(all);
  db.storageInfo().then((i) => {
    const mb = (b) => (b / 1048576).toFixed(1) + ' MB', gb = (b) => (b / 1073741824).toFixed(1) + ' GB';
    $('#almacenamiento').textContent = `Almacenamiento en este equipo: ${i.usado !== undefined ? mb(i.usado) : '?'} usados de ${i.disponible ? gb(i.disponible) : '?'} disponibles · ${i.persistente ? 'protegido contra borrado automático' : 'el navegador podría borrarlo si falta espacio: use respaldos o Drive'}.`;
  });
  const ps = [...new Set([...all.map((s) => s.participante), ...state.participantes.map((p) => p.codigo)])].sort();
  const cur = sel.value || (state.cfg && state.cfg.participante) || ps[0];
  const nombre = (c) => { const p = state.participantes.find((x) => x.codigo === c); return p && p.nombre ? ' — ' + p.nombre : ''; };
  sel.innerHTML = ps.map((p) => `<option value="${esc(p)}" ${p === cur ? 'selected' : ''}>${esc(p + nombre(p))}</option>`).join('');
  const list = all.filter((s) => s.participante === sel.value);
  const avg = (s, k) => { const v = s.bloques.map((b) => b.metricas[k]).filter((x) => x !== undefined && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  $('#hist-tabla').innerHTML = `<tr><th>Sesión</th><th>Fecha</th><th>Hora</th><th>Tipo</th><th>Módulo</th><th>Fuente</th><th>Exactitud calib.</th><th>Tiempo sobre objeto</th><th>Mantenimiento máx.</th><th>Ganancia persec.</th><th>Latencia</th><th>Drive</th><th></th></tr>` +
    list.map((s) => `<tr><td>${s.numeroSesion}</td><td>${db.fechaLocal(s.inicio)}</td><td>${db.horaLocal(s.inicio)}</td><td>${labelTipo(s.tipoSesion)}</td><td>${[...new Set(s.bloques.map((b) => b.modulo.id))].join(', ')}</td><td>${fuente(s.entrada)}</td>
      <td>${s.calidad ? s.calidad.exactitudDeg.toFixed(2) + '°' : '—'}</td><td>${fmt('tiempoSobreObjeto', avg(s, 'tiempoSobreObjeto'))}</td><td>${fmt('rachaMaximaS', avg(s, 'rachaMaximaS'))}</td>
      <td>${fmt('gananciaPersecucion', avg(s, 'gananciaPersecucion'))}</td><td>${fmt('latenciaMediaMs', avg(s, 'latenciaMediaMs'))}</td><td>${s.driveSubido ? '✓' : '—'}</td>
      <td><button data-del="${esc(s.id)}">Eliminar</button> <button data-raw="${esc(s.id)}">CSV crudo</button></td></tr>`).join('');
  const charts = [['tiempoSobreObjeto', 'Tiempo sobre el objeto (%)', 100], ['rachaMaximaS', 'Mantenimiento máximo (s)', 1], ['gananciaPersecucion', 'Ganancia de persecución', 1], ['latenciaMediaMs', 'Latencia media (ms)', 1]];
  $('#hist-graficas').innerHTML = list.length ? charts.map(([k, t, f]) => chart(t, list.map((s) => ({ x: s.numeroSesion, y: avg(s, k) * f, tipo: s.tipoSesion, fecha: db.fechaLocal(s.inicio) })))).join('') : '<p class="hint">Aún no hay sesiones guardadas en este equipo.</p>';
}
function chart(title, pts) {
  pts = pts.filter((p) => !Number.isNaN(p.y));
  const W = 300, H = 140, pad = 28;
  if (!pts.length) return `<div class="chart"><h4>${title}</h4><p class="hint">Sin datos</p></div>`;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), y0 = Math.min(0, ...ys), y1 = Math.max(...ys) * 1.1 || 1;
  const X = (x) => pad + (x - x0) / (x1 - x0) * (W - pad - 8), Y = (y) => H - pad + 6 - (y - y0) / (y1 - y0) * (H - pad - 6);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const dots = pts.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.tipo === 'entrenamiento' ? 3 : 5}" fill="${p.tipo === 'entrenamiento' ? 'var(--accent)' : 'var(--warn)'}"><title>Sesión ${p.x} (${p.fecha}): ${p.y.toFixed(1)}</title></circle>`).join('');
  return `<div class="chart"><h4>${title}</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    <line x1="${pad}" x2="${W - 8}" y1="${H - pad + 6}" y2="${H - pad + 6}" stroke="var(--line)"/>
    <text x="${pad - 4}" y="${Y(y1) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${y1.toFixed(0)}</text>
    <text x="${pad - 4}" y="${Y(y0) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${y0.toFixed(0)}</text>
    <text x="${W - 8}" y="${H - 4}" text-anchor="end" font-size="10" fill="var(--muted)">sesión</text>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>${dots}</svg>
    <small class="hint"><span style="color:var(--accent)">●</span> entrenamiento · <span style="color:var(--warn)">●</span> evaluación (T0/T1/T2)</small></div>`;
}
$('#hist-participante').onchange = renderHistory;
$('#hist-tabla').onclick = async (e) => {
  const del = e.target.dataset.del, raw = e.target.dataset.raw;
  if (del && confirm('¿Eliminar definitivamente esta sesión de este equipo? (no se borra de Google Drive)')) { await db.deleteSession(del); renderHistory(); }
  if (raw) { const s = (await db.allSessions()).find((x) => x.id === raw); db.download(`${db.fileBase(s)}_crudo.csv`, db.rawCSV(s)); }
};
$('#btn-export-todo').onclick = async () => { const all = await db.allSessions(); if (!all.length) return alert('No hay sesiones.'); db.download(`resumen-seguimiento-ocular-${db.stamp(new Date().toISOString())}.csv`, db.summaryCSV(all)); };
// El respaldo incluye el registro de participantes SIN nombres.
$('#btn-respaldo').onclick = async () => {
  const participantes = (await db.allParticipants()).map(({ nombre, ...p }) => p); // eslint-disable-line no-unused-vars
  db.download(`respaldo-seguimiento-ocular-${db.stamp(new Date().toISOString())}.json`, JSON.stringify({ app: 'seguimiento-ocular-tea', version: VERSION, participantes, sesiones: await db.allSessions() }), 'application/json');
};
$('#in-respaldo').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const existentes = new Map((await db.allParticipants()).map((p) => [p.codigo, p]));
    for (const p of data.participantes || []) await db.saveParticipant({ ...p, nombre: existentes.get(p.codigo)?.nombre || '' });
    for (const s of data.sesiones || []) await db.saveSession(s);
    alert(`Importadas ${(data.sesiones || []).length} sesiones y ${(data.participantes || []).length} participantes.`);
    await loadParticipants(); renderHistory();
  } catch (err) { alert('Archivo no válido: ' + err.message); }
  e.target.value = '';
};
$('#btn-recalcular').onclick = async () => {
  if (!confirm('Se recalcularán las métricas de TODAS las sesiones con los parámetros actuales. ¿Continuar?')) return;
  const P = params();
  for (const s of await db.allSessions()) { for (const b of s.bloques) b.metricas = blockMetrics(b, P); s.parametros = P; await db.saveSession(s); }
  renderHistory();
};

addEventListener('resize', () => { if (!stage.hidden) resizeStage(); });
db.storageInfo();
show('inicio');
