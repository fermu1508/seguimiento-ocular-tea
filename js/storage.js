// Almacenamiento local (IndexedDB) y exportación. Los datos se guardan en el
// navegador del equipo donde se aplicó la sesión; use "Exportar respaldo"
// para trasladarlos o archivarlos.

const DB = 'seguimiento-ocular-tea', STORE = 'sesiones', VER = 1;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('participante', 'participante'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
    const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
  });
}
export const saveSession = (s) => tx('readwrite', (st) => st.put(s));
export const deleteSession = (id) => tx('readwrite', (st) => st.delete(id));
export async function allSessions() {
  const r = await tx('readonly', (st) => st.getAll());
  return r.sort((a, b) => a.inicio.localeCompare(b.inicio));
}
export async function sessionsOf(p) { return (await allSessions()).filter((s) => s.participante === p); }

export function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const csvCell = (v) => { if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return ''; const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

// Una fila por bloque: formato "largo" listo para modelos lineales mixtos.
export function summaryRows(sessions) {
  const rows = [];
  for (const s of sessions) for (const b of s.bloques) {
    rows.push({ participante: s.participante, grupo: s.grupo, condicion: s.condicion, tipoSesion: s.tipoSesion,
      numeroSesion: s.numeroSesion, fecha: s.inicio, entrada: s.entrada, exactitudCalibDeg: s.calidad && s.calidad.exactitudDeg,
      precisionCalibDeg: s.calidad && s.calidad.precisionRmsDeg, bloque: b.indice, modulo: b.modulo.id, nombreModulo: b.modulo.name,
      trayectoria: b.modulo.type, velocidadDegS: Array.isArray(b.modulo.speedDegS) ? b.modulo.speedDegS.join('-') : b.modulo.speedDegS,
      semilla: b.semilla, ...b.metricas });
  }
  return rows;
}
export function rawRows(s) {
  const rows = [];
  for (const b of s.bloques) for (const m of b.samples) rows.push({ bloque: b.indice, modulo: b.modulo.id, ...m });
  return rows;
}
