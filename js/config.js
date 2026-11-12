// Configuración del protocolo: módulos de intervención, batería de evaluación
// y parámetros de análisis. Todo valor espacial está en grados de ángulo visual
// (°) y todo valor temporal en segundos, salvo que se indique otra cosa.

export const VERSION = '0.2.5';

// Parámetros de análisis. Deben mantenerse IDÉNTICOS en todas las sesiones del
// estudio longitudinal (Kasneci et al., 2024); se guardan junto con cada sesión.
export const ANALYSIS_DEFAULTS = {
  aoiDeg: 3.0,            // radio del área de interés alrededor del objeto
  ivtThresholdDegS: 60,   // umbral I-VT para sacadas (alto por el ruido de webcam a ~30 Hz)
  idtDispersionDeg: 2.5,  // diámetro máximo I-DT (webcam: 2–3°; equipo de investigación: 0.5–1°). Ajustar en el piloto
  idtMinDurMs: 100,       // duración mínima de una fijación
  maxGapMs: 200,          // hueco máximo sin datos que no rompe una racha de mirada
  latencyMinMs: 80,       // respuestas más rápidas se consideran anticipaciones
  latencyMaxMs: 800,      // ventana máxima de respuesta tras el salto del objeto
  latencyCrossFrac: 0.25, // fracción de la amplitud del salto que define el inicio de la respuesta
};

// Tipos de trayectoria (ver stimuli.js):
//  fijacion   – objeto quieto en varias posiciones (fijación y tiempo sostenido)
//  lineal     – izquierda → derecha → regreso por el mismo camino
//  barrido    – horizontal y vertical: recorre una línea, desaparece y reaparece
//               en la línea inferior
//  sinusoidal – avanza horizontalmente siguiendo una función seno
//  saltos     – aparece de golpe en otra posición (latencia y precisión sacádica)
//  mixto      – sinusoidal con cambios de velocidad

// 10 módulos de dificultad progresiva (objetivo específico 2). Varían
// trayectoria, velocidad, tamaño, distractores y complejidad.
export const MODULES = [
  { id: 1,  name: 'Mira la estrella',        type: 'fijacion',   sizeDeg: 3.0, holdS: 4,  positions: 5, durationS: 30, distractors: 0 },
  { id: 2,  name: 'Paseo lento',             type: 'lineal',     sizeDeg: 3.0, speedDegS: 5,  durationS: 60, distractors: 0 },
  { id: 3,  name: 'Paseo',                   type: 'lineal',     sizeDeg: 2.5, speedDegS: 10, durationS: 60, distractors: 0 },
  { id: 4,  name: 'Renglones',               type: 'barrido',    sizeDeg: 2.5, speedDegS: 8,  rowSpacingDeg: 4, gapS: 0.4, durationS: 60, distractors: 0 },
  { id: 5,  name: 'Olas suaves',             type: 'sinusoidal', sizeDeg: 2.5, speedDegS: 6,  ampDeg: 4, freqHz: 0.2, durationS: 60, distractors: 0 },
  { id: 6,  name: 'Aparece y desaparece',    type: 'saltos',     sizeDeg: 2.0, trials: 16, ampDeg: [8, 12], gapMs: 0, holdS: 1.2, durationS: 60, distractors: 0 },
  { id: 7,  name: 'Paseo rápido',            type: 'lineal',     sizeDeg: 1.8, speedDegS: 15, durationS: 60, distractors: 2 },
  { id: 8,  name: 'Olas grandes',            type: 'sinusoidal', sizeDeg: 1.8, speedDegS: 10, ampDeg: 6, freqHz: 0.35, durationS: 60, distractors: 2 },
  { id: 9,  name: 'Renglones con amigos',    type: 'barrido',    sizeDeg: 1.8, speedDegS: 14, rowSpacingDeg: 4, gapS: 0.3, durationS: 60, distractors: 4 },
  { id: 10, name: 'Gran aventura',           type: 'mixto',      sizeDeg: 1.5, speedDegS: [6, 18], ampDeg: 6, freqHz: 0.3, durationS: 75, distractors: 4, movingDistractors: true },
];

// Batería FIJA de evaluación (T0, T1, T2). No cambia entre sesiones ni entre
// grupos, para que las medidas pre–post sean comparables.
export const EVALUATION_BATTERY = [
  { id: 'E1', name: 'Evaluación · fijación',       type: 'fijacion',   sizeDeg: 2.0, holdS: 4, positions: 5, durationS: 20, distractors: 0 },
  { id: 'E2', name: 'Evaluación · lineal',         type: 'lineal',     sizeDeg: 2.0, speedDegS: 10, durationS: 40, distractors: 0 },
  { id: 'E3', name: 'Evaluación · sinusoidal',     type: 'sinusoidal', sizeDeg: 2.0, speedDegS: 8, ampDeg: 5, freqHz: 0.25, durationS: 40, distractors: 0 },
  { id: 'E4', name: 'Evaluación · horizontal y vertical', type: 'barrido', sizeDeg: 2.0, speedDegS: 10, rowSpacingDeg: 4, gapS: 0.4, durationS: 40, distractors: 0 },
  { id: 'E5', name: 'Evaluación · saltos',         type: 'saltos',     sizeDeg: 2.0, trials: 20, ampDeg: [8, 12], gapMs: 0, holdS: 1.2, durationS: 70, distractors: 0 },
];

// Regla de progresión adaptativa (52 semanas): se avanza de módulo cuando el
// tiempo sobre el objeto supera ADVANCE en dos sesiones seguidas, y se
// retrocede cuando queda por debajo de RETREAT.
export const PROGRESSION = { advanceOnTarget: 0.70, retreatOnTarget: 0.35, sessionsToAdvance: 2 };

// Una sesión de entrenamiento: bloques del módulo actual, total ≤ 10 min de
// actividad ocular (metodología de la tesis).
export const TRAINING_BLOCKS_PER_SESSION = 3;

// Apariencia del objeto. Estímulos NO sociales (sin rostro), según la
// metodología: figuras geométricas de colores sólidos sobre fondo uniforme.
//  - Evaluación, calibración y deriva: diana con cruz y punto central, la forma
//    que produce la fijación más estable (Thaler et al., 2013).
//  - Entrenamiento: figura geométrica elegida para cada participante y
//    mantenida durante todo el estudio.
export const FIGURES = { circulo: 'Círculo', estrella: 'Estrella', rombo: 'Rombo', cuadrado: 'Cuadrado' };
export const COLORS = { amarillo: '#ffd43b', naranja: '#ff922b', verde: '#51cf66', cian: '#22b8cf', rosa: '#f783ac' };
export const EVAL_TARGET = { figura: 'diana', color: '#ffffff' };

// Retroalimentación durante la actividad: DESACTIVADA en el protocolo actual.
// Si más adelante se decide usarla, basta con cambiar estos valores a true
// (quedará registrado en cada sesión).
export const FEEDBACK = { visual: false, sonido: false, estrellas: false };

// Eye tracker externo: dirección del programa puente local (bridge/).
export const EYETRACKER_URL = 'ws://localhost:8770';
