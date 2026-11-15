// Shared helpers: i18n, API client, escaping, map bootstrap.
export const state = { lang: localStorage.getItem('lang') || 'az', messages: {} };

export async function loadLang(lang) {
  const r = await fetch(`/api/i18n/${lang}`);
  if (!r.ok) throw new Error(r.statusText);
  const messages = (await r.json()).messages;
  state.lang = lang;
  localStorage.setItem('lang', lang);
  state.messages = messages;
  document.documentElement.lang = lang;
  document.title = tr('app.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', tr(el.dataset.i18nAria)); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
}

export const tr = (key) => state.messages[key] ?? key;
export const name = (obj) => (obj && typeof obj === 'object' ? obj[state.lang] ?? obj.az ?? obj.en : obj);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

export async function api(method, path, { body, token } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const deviceToken = lsGet('deviceToken');
  const res = await fetch(`${path}${sep}lang=${state.lang}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(deviceToken ? { 'X-Device-Token': deviceToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || res.statusText); e.code = json.error; e.status = res.status; throw e; }
  return json;
}

export function langSwitcher(select, onChange) {
  select.value = state.lang;
  select.addEventListener('change', async () => { await loadLang(select.value); onChange?.(); });
}

export function initMap(el, center = [40.41, 49.87], zoom = 12) {
  if (typeof L === 'undefined') { el.textContent = tr('ui.mapUnavailable'); return null; }
  const map = L.map(el).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  return map;
}

export const pctColor = (p) => (p >= 95 ? '#b91c1c' : p >= 90 ? '#dc2626' : p >= 75 ? '#d97706' : '#16a34a');

export function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.className = `toast show ${kind}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

export function citizenId() {
  let id = lsGet('citizenId');
  if (!id) { id = `c-${crypto.randomUUID()}`; lsSet('citizenId', id); }
  return id;
}

/** Gets a server-signed device identity (keeps the same id so the device keeps its reputation). */
export async function ensureSession(force = false) {
  if (!force && lsGet('deviceToken')) return;
  const s = await api('POST', '/api/session', { body: { deviceId: citizenId() } });
  lsSet('citizenId', s.deviceId);
  lsSet('deviceToken', s.token);
}
