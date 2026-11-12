// Copia de las sesiones en Google Drive del investigador.
// Estructura: Seguimiento Ocular TEA / <Grupo> / <Código> / archivos
// Permiso "drive.file": la página sólo puede ver y crear los archivos que ella
// misma creó; no tiene acceso al resto del Drive.
import { GOOGLE_CLIENT_ID } from './drive-config.js';
import { fileBase, summaryCSV, rawCSV } from './storage.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ROOT = 'Seguimiento Ocular TEA';
const GROUP_FOLDER = { TEA: 'TEA', DT: 'Desarrollo tipico' };
let token = null, expiresAt = 0, client = null;
const folderCache = new Map();

export const configured = () => !!GOOGLE_CLIENT_ID;
export const connected = () => !!token && Date.now() < expiresAt - 60000;

function loadGis() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar el servicio de Google'));
    document.head.appendChild(s);
  });
}

// Debe llamarse desde un clic (abre la ventana de Google).
export async function connect() {
  if (!configured()) throw new Error('Falta configurar el ID de cliente de Google (js/drive-config.js).');
  await loadGis();
  return new Promise((res, rej) => {
    client = client || google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
    client.callback = (r) => {
      if (r.error) return rej(new Error(r.error_description || r.error));
      token = r.access_token; expiresAt = Date.now() + r.expires_in * 1000; res();
    };
    client.error_callback = (e) => rej(new Error(e.message || e.type || 'Conexión cancelada'));
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Google Drive respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function folder(name, parent) {
  const key = parent + '/' + name;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`;
  const found = await api('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q));
  const id = found.files.length ? found.files[0].id
    : (await api('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) })).id;
  folderCache.set(key, id); return id;
}

async function upload(name, content, mime, parent) {
  const b = 'frontera' + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n` +
    `--${b}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
  return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
}

// Sube resumen, datos crudos y respaldo JSON de una sesión.
export async function uploadSession(s) {
  if (!connected()) throw new Error('Drive no está conectado.');
  const root = await folder(ROOT, 'root');
  const g = await folder(GROUP_FOLDER[s.grupo] || s.grupo, root);
  const p = await folder(s.participante, g);
  const base = fileBase(s);
  await upload(base + '_resumen.csv', summaryCSV([s]), 'text/csv', p);
  await upload(base + '_crudo.csv', rawCSV(s), 'text/csv', p);
  const { driveSubido, ...clean } = s; // eslint-disable-line no-unused-vars
  await upload(base + '.json', JSON.stringify(clean), 'application/json', p);
  return `${ROOT}/${GROUP_FOLDER[s.grupo] || s.grupo}/${s.participante}`;
}
