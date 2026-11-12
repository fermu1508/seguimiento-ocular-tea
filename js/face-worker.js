// Proceso aparte (Web Worker) que ejecuta MediaPipe Face Landmarker sin
// bloquear el dibujo del juego. Recibe imágenes de la cámara y devuelve los
// rasgos oculares de cada una.
import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';
import { extractFeatures } from './features.js';

const PREVIEW = [468, 473, 33, 133, 362, 263];
let landmarker = null;

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const fileset = await FilesetResolver.forVisionTasks(m.wasmBase, true); // variante "módulo" (necesaria en workers)
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: m.modelUrl, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true });
      let delegate = 'GPU';
      try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); delegate = 'CPU'; }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
    return;
  }
  if (m.type === 'frame') {
    const d0 = performance.now();
    let fe;
    try { fe = extractFeatures(landmarker.detectForVideo(m.bitmap, m.ts), PREVIEW); }
    catch (err) { fe = { ok: false, reason: 'error' }; }
    finally { m.bitmap.close(); }
    self.postMessage({ type: 'result', t: m.t, procMs: performance.now() - d0, ...fe });
  }
};
