// SMS fallback: a citizen without internet texts the short number. A gateway (simulated here) forwards the message
// to POST /api/sms/inbound and sends our reply text back. Commands (case/diacritics-insensitive, az or en):
//   SOS [type] [needs] <district | lat,lng>     e.g.  "SOS YANGIN NESIMI"   "HELP FIRE 40.4093,49.833"   "SOS ELIL ARABASI YASAMAL"
//   SAFE | TEHLUKESIZEM                          closes this number's open SOS
//   YER <district> | POINT <district>            nearest assembly point + occupancy
import { createHash } from 'node:crypto';
import { isValidCoord, nearest } from './geo.js';
import { AppError } from './errors.js';
import { t } from './i18n.js';

const fold = (s) => String(s ?? '')
  .replace(/ə/g, 'e').replace(/Ə/g, 'E').replace(/ı/g, 'i').replace(/İ/g, 'I')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();

const TYPE_WORDS = {
  FIRE: ['YANGIN', 'FIRE'], COLLAPSE: ['DAGINTI', 'DAGILMA', 'COLLAPSE', 'ZELZELE'], FLOOD: ['SEL', 'SU', 'BASMA', 'FLOOD'],
  MEDICAL: ['TIBBI', 'HEKIM', 'MEDICAL', 'AMBULANS', 'AMBULANCE'],
};
const NEED_WORDS = {
  wheelchair: ['ELIL', 'ARABA', 'ARABASI', 'WHEELCHAIR'],
  medical_transport: ['YATAQ', 'NEQLIYYAT', 'TRANSPORT'],
  reduced_mobility: ['YERIMIR', 'YERIYIREM', 'HEREKET', 'WALK'],
};
const SOS_WORDS = ['SOS', 'KOMEK', 'HELP', 'IMDAD'];
const SAFE_WORDS = ['SAFE', 'TEHLUKESIZEM', 'TEHLUKESIZ'];
const POINT_WORDS = ['YER', 'POINT', 'STATUS', 'MEKAN'];
const EN_HINT = ['HELP', 'FIRE', 'SAFE', 'FLOOD', 'COLLAPSE', 'MEDICAL', 'WHEELCHAIR', 'POINT', 'STATUS'];

export function parseSms(text, districts) {
  const norm = fold(text);
  const tokens = norm.split(/[^A-Z0-9.,\-]+/).filter(Boolean);
  const first = tokens[0] ?? '';
  const intent = SAFE_WORDS.includes(first) ? 'safe' : POINT_WORDS.includes(first) ? 'point' : SOS_WORDS.includes(first) || tokens.some((x) => SOS_WORDS.includes(x)) ? 'sos' : 'unknown';
  const lang = tokens.some((x) => EN_HINT.includes(x)) ? 'en' : 'az';

  let type = 'MEDICAL'; // an unlabeled call for help is treated as a medical one
  for (const [k, words] of Object.entries(TYPE_WORDS)) if (tokens.some((x) => words.includes(x))) { type = k; break; }
  const needs = Object.entries(NEED_WORDS).filter(([, words]) => tokens.some((x) => words.includes(x))).map(([k]) => k);

  let pos = null;
  const m = norm.match(/(-?\d{1,3}[.,]\d+)\s*[;,\s]\s*(-?\d{1,3}[.,]\d+)/);
  if (m) {
    const lat = Number(m[1].replace(',', '.'));
    const lng = Number(m[2].replace(',', '.'));
    if (isValidCoord(lat, lng)) pos = { lat, lng };
  }
  let districtId = null;
  if (!pos) {
    for (const d of districts) {
      const names = [d.id, d.name.az, d.name.en, d.name.ru].map(fold);
      if (tokens.some((x) => x.length >= 4 && names.some((n) => n === x || n.startsWith(x)))) { districtId = d.id; pos = { lat: d.lat, lng: d.lng }; break; }
    }
  }
  return { intent, type, needs, pos, districtId, fromCoords: !!m && !!pos, lang };
}

export class SmsService {
  constructor(store, { secret = 'sms-salt', limiter = null } = {}) {
    this.store = store;
    this.secret = secret;
    this.limiter = limiter;
  }

  /** Phone numbers are never stored: only a salted hash identifies the sender. */
  deviceFor(from) {
    return `sms-${createHash('sha256').update(`${this.secret}|${String(from).replace(/\D/g, '')}`).digest('hex').slice(0, 14)}`;
  }

  handle({ from, text }) {
    if (typeof from !== 'string' || !from.trim() || typeof text !== 'string' || !text.trim() || text.length > 320) throw new AppError(400, 'INVALID_SMS');
    const deviceId = this.deviceFor(from);
    const p = parseSms(text, this.store.districts);
    const lang = p.lang;
    if (this.limiter && !this.limiter.take(deviceId)) return { intent: p.intent, reply: t(lang, 'sms.rateLimited'), limited: true };

    if (p.intent === 'safe') {
      const r = this.store.markSafe(deviceId);
      return { intent: 'safe', resolved: r.resolvedSos, reply: t(lang, r.resolvedSos ? 'sms.safeOk' : 'sms.safeNone') };
    }
    if (p.intent === 'unknown') return { intent: 'unknown', reply: t(lang, 'sms.help') };
    if (!p.pos) return { intent: p.intent, reply: t(lang, 'sms.needLocation') };

    const needs = p.needs.length ? p.needs : [];
    if (p.intent === 'point') {
      const accessible = needs.length > 0 || this.store.getProfile(deviceId)?.role === 'priority';
      const pool = this.store.listPoints({ activeOnly: true }).filter((x) => !accessible || x.accessible);
      const best = nearest(p.pos, pool);
      if (!best) return { intent: 'point', reply: t(lang, 'sms.noPoint') };
      const name = best.item.name[lang] ?? best.item.name.az;
      return { intent: 'point', pointId: best.item.id, reply: t(lang, 'sms.point').replace('{name}', name).replace('{pct}', String(best.item.occupancyPct)).replace('{m}', String(Math.round(best.distance))) };
    }

    // intent === 'sos'
    if (needs.length) this.store.setProfile(deviceId, { role: 'priority', needs });
    const sos = this.store.addSos(
      { citizenId: deviceId, type: p.type, lat: p.pos.lat, lng: p.pos.lng, accuracy: p.fromCoords ? 50 : null, note: 'SMS' },
      // 'local' = unattributable network: the gateway IP must not be treated as a bot "IP concentration"
      { ip: 'local', deviceId, verified: true, source: 'sms', profile: this.store.getProfile(deviceId) },
    );
    const where = this.store.districts.find((d) => d.id === sos.districtId)?.name[lang] ?? '';
    const reply = t(lang, 'sms.sosOk').replace('{id}', sos.id).replace('{where}', where) + (sos.priority === 1 ? ` ${t(lang, 'sms.priority')}` : '');
    return { intent: 'sos', sosId: sos.id, priority: sos.priority, reply };
  }
}
