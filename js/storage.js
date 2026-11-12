// Almacenamiento local (IndexedDB) y exportación. Los datos se guardan en el
// navegador del equipo donde se aplicó la sesión. El NOMBRE de cada
// participante sólo vive aquí: nunca se exporta ni se sube a Drive.

const DB = 'seguimiento-ocular-tea', VER = 2;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('sesiones')) d.createObjectStore('sesiones', { keyPath: 'id' }).createIndex('participante', 'participante');
      if (!d.objectStoreNames.contains('participantes')) d.createObjectStore('participantes', { keyPath: 'codigo' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  });
}

export const saveSession = (s) => tx('sesiones', 'readwrite', (st) => st.put(s));
export const deleteSession = (id) => tx('sesiones', 'readwrite', (st) => st.delete(id));
export async function allSessions() { return (await tx('sesiones', 'readonly', (st) => st.getAll())).sort((a, b) => a.inicio.localeCompare(b.inicio)); }
export async function sessionsOf(p) { return (await allSessions()).filter((s) => s.participante === p); }

export const saveParticipant = (p) => tx('participantes', 'readwrite', (st) => st.put(p));
export async function allParticipants() { return (await tx('participantes', 'readonly', (st) => st.getAll())).sort((a, b) => a.codigo.localeCompare(b.codigo)); }

// Pide al navegador que no borre estos datos automáticamente y reporta el espacio.
export async function storageInfo() {
  const out = {};
  try { out.persistente = navigator.storage && (await navigator.storage.persisted() || await navigator.storage.persist()); } catch { /* no soportado */ }
  try { const e = await navigator.storage.estimate(); out.usado = e.usage; out.disponible = e.quota; } catch { /* no soportado */ }
  return out;
}

// Edad en años (con decimales) a una fecha dada.
export function ageYears(fechaNacimiento, fecha = new Date()) {
  if (!fechaNacimiento) return null;
  const b = new Date(fechaNacimiento + 'T12:00:00');
  return +(((fecha - b) / (365.2425 * 864e5))).toFixed(2);
}

// Fecha y hora locales legibles y aptas para nombres de archivo.
export const fechaLocal = (iso) => new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const horaLocal = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
export function stamp(iso) {
  const d = new Date(iso), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}h${z(d.getMinutes())}`;
}
export const fileBase = (s) => `${s.participante}_${stamp(s.inicio)}_${s.tipoSesion}_S${s.numeroSesion}`;

export function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const csvCell = (v) => { if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return ''; const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (rows, cols) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

// Una fila por bloque: formato "largo" listo para modelos lineales mixtos.
export function summaryRows(sessions) {
  const rows = [];
  for (const s of sessions) for (const b of s.bloques) {
    rows.push({ participante: s.participante, grupo: s.grupo, condicion: s.condicion, edadAnios: s.edadAnios, tipoSesion: s.tipoSesion,
      numeroSesion: s.numeroSesion, fecha: fechaLocal(s.inicio), hora: horaLocal(s.inicio), inicioISO: s.inicio, entrada: s.entrada,
      figura: b.figura, retroalimentacion: s.retroalimentacion && Object.values(s.retroalimentacion).some(Boolean) ? 'si' : 'no',
      exactitudCalibDeg: s.calidad && s.calidad.exactitudDeg, precisionCalibDeg: s.calidad && s.calidad.precisionRmsDeg,
      bloque: b.indice, modulo: b.modulo.id, nombreModulo: b.modulo.name, trayectoria: b.modulo.type,
      velocidadDegS: Array.isArray(b.modulo.speedDegS) ? b.modulo.speedDegS.join('-') : b.modulo.speedDegS,
      semilla: b.semilla, versionPrograma: s.version, ...b.metricas });
  }
  return rows;
}
export const summaryCSV = (sessions) => { const r = summaryRows(sessions); return toCSV(r, [...new Set(r.flatMap((x) => Object.keys(x)))]); };
export const RAW_COLS = ['bloque', 'modulo', 't', 'ok', 'gx', 'gy', 'tx', 'ty', 'tvis', 'motivo'];
export function rawCSV(s) {
  const rows = [];
  for (const b of s.bloques) for (const m of b.samples) rows.push({ bloque: b.indice, modulo: b.modulo.id, ...m });
  return toCSV(rows, RAW_COLS);
}
