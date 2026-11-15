// API description (single source of truth for /api/openapi.json and /api/docs).
// A test asserts that this list and the real route table never drift apart.
const T = {
  citizen: 'Vətəndaş', dispatcher: 'Dispetçer', admin: 'Admin / simulyasiya', system: 'Sistem',
};

// Documentation routes serve this spec itself, so they are not listed in it.
export const SELF_ROUTES = ['GET /api/openapi.json', 'GET /api/docs'];

export const ENDPOINTS = [
  { method: 'GET', path: '/api/health', tag: T.system, auth: 'public', summary: 'Sağlamlıq yoxlaması + asılılıqların vəziyyəti: xarici xəritə/marşrut API-sinin dövrə kəsicisi (closed / open / half_open), xətanın növü, keş ölçüsü, mənbələr üzrə xidmət sayı. mode = online | offline-fallback', response: '{ ok, time, mode, dependencies: { routing: { mode, breaker: { state, retryInMs, lastError }, cacheSize, served } } }' },
  { method: 'GET', path: '/api/config', tag: T.system, auth: 'public', summary: 'SOS növləri, dillər, qayda həddləri', response: '{ sosTypes, languages, rules }' },
  { method: 'GET', path: '/api/i18n/:lang', tag: T.system, auth: 'public', summary: 'Tərcümə lüğəti (az, en, ru)', response: '{ lang, messages }' },
  { method: 'GET', path: '/api/districts', tag: T.citizen, auth: 'public', summary: 'Rayonlar siyahısı', response: '[ { id, name, lat, lng } ]' },
  { method: 'GET', path: '/api/points', tag: T.citizen, auth: 'public', summary: 'Aktiv toplanış məntəqələri və doluluq', response: '[ { id, name, type, capacity, occupied, occupancyPct } ]' },
  { method: 'GET', path: '/api/roads', tag: T.citizen, auth: 'public', summary: 'Yol şəbəkəsi (bağlı yollar daxil)', response: '[ { id, from, to, closed, congestion } ]' },
  {
    method: 'GET', path: '/api/evacuation', tag: T.citizen, auth: 'public',
    summary: 'Ən yaxın təhlükəsiz məntəqələr + tövsiyə olunan təxliyyə marşrutu. Məntəqə ≥90% dolu, yol bağlı və ya dolma sürəti səbəbindən çatanda dolacaqsa alternativ təklif olunur.',
    query: { lat: 'number', lng: 'number', district: 'string (lat/lng əvəzinə)', accessible: '1 = yalnız əlçatan (panduslu/maneəsiz) məntəqə və marşrut. Prioritet rollu imzalı cihaz üçün avtomatik' },
    response: '{ origin, recommendedPointId, rerouted:{reasons[]}, noSafePoint, routing:{ mode: online | offline-fallback, degraded, sources: [external | cache | matrix | local], reason, cacheAgeSec }, accessible, noAccessibleRoute, needsTransport, points[ {status, projectedPct, fillingFast, accessible, access[], route:{geometry, distanceM, etaMin, source}} ] }',
  },
  { method: 'POST', path: '/api/session', tag: T.citizen, auth: 'public', summary: 'İmzalı cihaz kimliyi alır (IP üzrə sürət limiti var)', body: { deviceId: 'string (ixtiyari, əvvəlki kimliyi saxlamaq üçün)' }, response: '{ deviceId, token }' },
  {
    method: 'POST', path: '/api/sos', tag: T.citizen, auth: 'device',
    summary: 'SOS göndərir. X-Device-Token olmadan da qəbul olunur (təsdiqsiz sayılır). Sürət limiti: imzalı cihaz üçün cihaz üzrə, imzasız sorğu üçün IP üzrə + ümumi büdcə (429 + Retry-After). Dublikat filtri: eyni göndərənin eyni növ SOS-u 60 san. ərzində yeni siqnal yaratmır (200, duplicate: true, repeats). Axın (flood) zamanı imzasız SOS qəbul olunur, amma karantinə düşür.',
    body: { citizenId: 'string (imzalı token varsa nəzərə alınmır)', type: 'FIRE | COLLAPSE | FLOOD | MEDICAL', lat: 'number', lng: 'number', accuracy: 'number (metr, ixtiyari)', note: 'string ≤280', needs: 'string[] (ixtiyari, yalnız imzalı cihaz: wheelchair | reduced_mobility | medical_transport. Pis dəyərlər səssiz atılır)' },
    response: '201 yeni | 200 dublikat: { id, duplicate, repeats, status, createdAt, districtId, verified, priority (1 = Kritik Prioritet), needs[] }',
  },
  { method: 'GET', path: '/api/broadcasts', tag: T.citizen, auth: 'public', summary: 'Dispetçerin göndərdiyi aktiv bildirişlər (yalnız vətəndaşın yerinə aid olanlar). Server vətəndaşın yerini saxlamır, tətbiq öz koordinatı ilə sorğu edir. Əlçatan istifadəçi üçün pandussuz məntəqə əlçatanla əvəzlənir', query: { lat: 'number', lng: 'number', accessible: '1 = əlçatan məntəqə əvəzləməsi (prioritet rol üçün avtomatik)' }, response: '{ broadcasts: [ { id, type, severity, text, point, substituted, expiresAt } ] }' },
  { method: 'POST', path: '/api/broadcasts/:id/ack', tag: T.citizen, auth: 'public', summary: 'Vətəndaş bildirişi oxuduğunu təsdiqləyir (dispetçerdə "oxudu" sayğacı)', response: '{ id, acks }' },
  { method: 'POST', path: '/api/sms/inbound', tag: T.citizen, auth: 'public', summary: 'SMS gateway webhook-u (internetsiz SOS). X-Gateway-Key tələb olunur. Komandalar: SOS [növ] [ehtiyac] <rayon | lat,lng>, TEHLUKESIZEM, YER <rayon>. Cavab mətni qayıdır', body: { from: 'string (nömrə, saxlanılmır, yalnız duzlu hash)', text: 'string ≤320' }, response: '{ intent, reply, sosId?, priority? }' },
  { method: 'GET', path: '/api/profile', tag: T.citizen, auth: 'device', summary: 'Cihazın rolü: citizen | priority (hərəkət məhdudiyyətli / xüsusi qayğı). X-Device-Token tələb olunur', response: '{ role, needs[], updatedAt }' },
  { method: 'POST', path: '/api/profile', tag: T.citizen, auth: 'device', summary: 'Prioritet SOS rolunu verir/ləğv edir. Rol imzalı cihaza bağlıdır; priority üçün ən azı bir ehtiyac lazımdır. Bundan sonra cihazın hər SOS-u Kritik Prioritet #1 alır', body: { role: 'citizen | priority', needs: 'string[]: wheelchair | reduced_mobility | medical_transport' }, response: '{ role, needs[], updatedAt }' },
  { method: 'GET', path: '/api/sos/:id', tag: T.citizen, auth: 'public', summary: 'SOS-un gedişi: stage 0 ləğv, 2 briqada təyin olunur, 3 yardım yoldadır (+ETA)', response: '{ id, status, stage, brigade: { name, kind }, etaSec, etaMin, cancelMsLeft }' },
  { method: 'POST', path: '/api/sos/:id/cancel', tag: T.citizen, auth: 'public', summary: 'Öz SOS-unu 60 san. ərzində ləğv edir ("səhv göndərdim")', body: { citizenId: 'string (SOS sahibi)' }, response: '{ id, status }' },
  { method: 'POST', path: '/api/safe', tag: T.citizen, auth: 'public', summary: '"Təhlükəsizəm": açıq SOS-ları bağlayır', body: { citizenId: 'string', lat: 'number?', lng: 'number?' }, response: '{ citizenId, resolvedSos }' },
  { method: 'POST', path: '/api/points/:id/checkin', tag: T.citizen, auth: 'public', summary: 'Məntəqəyə gəliş qeydi (doluluğu artırır)', body: { citizenId: 'string' }, response: 'məntəqə' },

  { method: 'POST', path: '/api/auth/login', tag: T.dispatcher, auth: 'public', summary: 'Personal girişi. Uğurlu olarsa HS256 imzalı JWT qaytarır (rol tokenin içindədir). Ünvan və istifadəçi adı üzrə sürət limiti (brute-force qoruması)', body: { username: 'string', password: 'string' }, response: '{ token, tokenType: Bearer, expiresInSec, user, role, permissions[] }' },
  { method: 'GET', path: '/api/auth/me', tag: T.dispatcher, auth: '@staff', summary: 'Cari istifadəçi, rol və icazələr', response: '{ user, role, permissions[], expiresAt }' },
  { method: 'POST', path: '/api/auth/refresh', tag: T.dispatcher, auth: '@staff', summary: 'Etibarlı tokeni yenisi ilə əvəz edir (növbə ərzində yenidən giriş lazım olmasın)', response: '{ token, expiresInSec, … }' },
  { method: 'POST', path: '/api/auth/logout', tag: T.dispatcher, auth: '@staff', summary: 'Çıxış: token dərhal ləğv olunur (deny-list)', response: '{ ok, revoked }' },
  { method: 'POST', path: '/api/auth/stream-ticket', tag: T.dispatcher, auth: 'dashboard', summary: 'Canlı axın (SSE) üçün 30 saniyəlik birdəfəlik bilet. EventSource başlıq göndərə bilmir, JWT isə URL-ə yazılmır', response: '{ ticket, expiresInSec }' },
  { method: 'GET', path: '/api/dashboard', tag: T.dispatcher, auth: 'dashboard', summary: 'Canlı panel snapshot-ı: SOS, məntəqələr, briqadalar, həyəcanlar (plan, typeCounts, undoMsLeft), karantin, hücum nəticəsi', response: 'snapshot' },
  { method: 'GET', path: '/api/stream', tag: T.dispatcher, auth: 'dashboard', summary: 'Server-Sent Events: hər dəyişiklikdə "snapshot" hadisəsi. ?ticket= (birdəfəlik bilet) və ya Authorization başlığı', response: 'text/event-stream', sse: true },
  { method: 'GET', path: '/api/dashboard/history', tag: T.dispatcher, auth: 'dashboard', summary: 'Zaman maşını: son N dəqiqənin kompakt kadrları', query: { minutes: 'number ≤240 (default 120)' }, response: '{ frames[], t0, t1, everyMs }' },
  { method: 'GET', path: '/api/decisions', tag: T.dispatcher, auth: 'dashboard', summary: 'Qərar jurnalı: kim, nə vaxt, hansı qərarı verdi (təsdiq, geri qaytarma, buraxma, yol, briqada, bildiriş) + sistem həyəcan hadisələri. IP/token/kimlik yoxdur', query: { limit: 'number ≤200 (default 30)' }, response: '{ decisions: [ { id, t, actor, action, target, details } ] }' },
  { method: 'POST', path: '/api/broadcasts', tag: T.dispatcher, auth: 'broadcast:send', summary: 'Kütləvi bildiriş: növ evacuate (məntəqəyə köçün) | shelter | avoid_area | all_clear (əhatə etdiyi xəbərdarlıqları ləğv edir) | custom. Hədəf: bütün şəhər, rayonlar və ya radius', body: { type: 'evacuate | shelter | avoid_area | all_clear | custom', severity: 'info | warning | critical (yalnız custom)', target: '{ kind: all } | { kind: districts, districts: [id] } | { kind: radius, lat, lng, radiusM }', pointId: 'string (evacuate üçün)', text: '{ az, en, ru } ≤280 (custom üçün məcburi)', expiresInMin: 'number 1..720 (default 30)' }, response: '{ id, type, severity, target, reach, acks, status }' },
  { method: 'POST', path: '/api/broadcasts/:id/cancel', tag: T.dispatcher, auth: 'broadcast:send', summary: 'Aktiv bildirişi geri çəkir', response: 'bildiriş' },
  { method: 'GET', path: '/api/rules', tag: T.dispatcher, auth: 'dashboard', summary: 'Cari qayda həddləri', response: 'rules' },
  { method: 'POST', path: '/api/alerts/:id/approve', tag: T.dispatcher, auth: 'alert:approve', summary: 'Bir kliklə: SOS növünə uyğun ən yaxın azad briqadanı göndər (yanğın → yanğınsöndürən, tibbi → təcili tibbi, dağıntı/sel → xilasetmə) + ehtiyat məntəqəni aç (amber xəbərdarlıqda yalnız məntəqə). Dispetçer istənilən AZAD briqadanı brigadeId ilə seçib avtomatik seçimi üstələyə bilər. İdempotentdir.', body: { brigadeId: 'string (ixtiyari; azad olmalıdır)' }, response: 'alert (result: { brigadeId, etaMin, manual, match })' },
  { method: 'POST', path: '/api/alerts/:id/undo', tag: T.dispatcher, auth: 'alert:approve', summary: 'Təsdiqi 10 saniyə ərzində geri qaytarır', response: 'alert' },
  { method: 'POST', path: '/api/sos/:id/dispatch', tag: T.dispatcher, auth: 'alert:approve', summary: 'Tək SOS-a briqada göndər (4 nəfərlik həyəcan gözləmədən). Briqada SOS növünə görə avtomatik seçilir, dispetçer brigadeId ilə üstələyə bilər. Vətəndaşın telefonunda addımlar dərhal yenilənir. 10 san. ərzində geri qaytarıla bilər', body: { brigadeId: 'string (ixtiyari; azad olmalıdır)' }, response: 'alert (type SOS_SINGLE, result: { brigadeId, etaMin, manual, match })' },
  { method: 'POST', path: '/api/sos/:id/release', tag: T.dispatcher, auth: 'alert:approve', summary: 'Karantindəki SOS-u "doğrudur" kimi buraxır', response: 'sos' },
  { method: 'POST', path: '/api/roads/:id/close', tag: T.dispatcher, auth: 'road:write', summary: 'Yolu bağlayır', response: '{ id, closed }' },
  { method: 'POST', path: '/api/roads/:id/open', tag: T.dispatcher, auth: 'road:write', summary: 'Yolu açır', response: '{ id, closed }' },
  { method: 'POST', path: '/api/roads/:id/accessibility', tag: T.dispatcher, auth: 'road:write', summary: 'Yol seqmentinin maneəsiz (pilləsiz/pandus) olub-olmadığı: əlçatan marşrut buna görə hesablanır', body: { stepFree: 'boolean' }, response: '{ id, stepFree }' },
  { method: 'POST', path: '/api/roads/:id/congestion', tag: T.dispatcher, auth: 'road:write', summary: 'Yol tıxacı əmsalı', body: { factor: 'number ≥1' }, response: 'yol' },
  { method: 'POST', path: '/api/brigades/:id/status', tag: T.dispatcher, auth: 'brigade:write', summary: 'Briqada statusu', body: { status: 'available | dispatched | on_scene | offline' }, response: 'briqada' },

  { method: 'POST', path: '/api/sim/occupancy', tag: T.admin, auth: '*', summary: 'Məntəqənin doluluğunu təyin edir', body: { pointId: 'string', occupied: 'number' }, response: 'məntəqə' },
  { method: 'POST', path: '/api/sim/chaos', tag: T.admin, auth: '*', summary: 'Xarici xəritə API-sinin nasazlığını simulyasiya edir: mode = ok | http503 | slow (cavab 5 san.-dən gec) | error (şəbəkə xətası). ok seçiləndə dövrə kəsici dərhal sınaq sorğusu göndərir. Köhnə externalDown / externalLatencyMs də işləyir', body: { mode: 'ok | http503 | slow | error', externalDown: 'boolean (köhnə)', externalLatencyMs: 'number (köhnə)' }, response: 'chaos' },
  { method: 'POST', path: '/api/sim/rules', tag: T.admin, auth: '*', summary: 'Qayda həddlərini işləyərkən dəyişir (yoxlanılır). "Təhlükəsizlik rejimi": requireVerified', body: { minDistinctReporters: 'number', overcrowdPct: 'number', requireVerified: 'boolean', '…': 'bax /api/config' }, response: 'rules' },
  { method: 'GET', path: '/api/sim/scenarios', tag: T.admin, auth: '*', summary: 'Demo ssenari adları', response: '[ name ]' },
  { method: 'POST', path: '/api/sim/sms', tag: T.admin, auth: '*', summary: 'SMS simulyatoru: gateway açarı olmadan eyni emal xəttini işlədir', body: { from: 'string', text: 'string' }, response: '{ intent, reply }' },
  { method: 'POST', path: '/api/sim/scenario', tag: T.admin, auth: '*', summary: 'Ssenarini real boru kəmərində işlədir', body: { name: 'cluster | fake_flood | mass_event | filling | overcrowd | api_outage | road_block | reset' }, response: '{ name, … }' },
  { method: 'POST', path: '/api/sim/reset', tag: T.admin, auth: '*', summary: 'Bütün vəziyyəti sıfırlayır', response: '{ ok }' },
];

const AUTH_TEXT = {
  public: 'açıq', device: 'ixtiyari X-Device-Token', dashboard: 'Bearer (dispetçer/müşahidəçi/admin)', 'alert:approve': 'Bearer (dispetçer/admin)',
  '@staff': 'Bearer JWT (istənilən personal rolu)', 'road:write': 'Bearer (dispetçer/admin)', 'brigade:write': 'Bearer (dispetçer/admin)', '*': 'Bearer (yalnız admin)',
};

const toOpenApiPath = (p) => p.replace(/:(\w+)/g, '{$1}');
const fields = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, { description: String(v) }]));

export function buildOpenApi() {
  const paths = {};
  for (const e of ENDPOINTS) {
    const path = toOpenApiPath(e.path);
    paths[path] ??= {};
    const params = [
      ...[...e.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...Object.entries(e.query ?? {}).map(([name, d]) => ({ name, in: 'query', schema: { type: 'string' }, description: d })),
    ];
    paths[path][e.method.toLowerCase()] = {
      tags: [e.tag],
      summary: e.summary,
      parameters: params,
      ...(e.body ? { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: fields(e.body) } } } } } : {}),
      responses: { 200: { description: e.response ?? '' }, 400: { description: 'Yanlış sorğu' }, 401: { description: 'Token yoxdur' }, 403: { description: 'İcazə yoxdur' }, 429: { description: 'Sürət limiti' } },
      'x-auth': AUTH_TEXT[e.auth] ?? e.auth,
      ...(e.auth !== 'public' && e.auth !== 'device' ? { security: [{ bearer: [] }], 'x-permission': e.auth } : {}),
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Urban Crisis & Crowd Evacuation Engine API', version: '0.2.0', description: 'Vətəndaş təhlükəsizliyi və dispetçer analitikası. Səhv mesajları ?lang=az|en|ru ilə lokallaşır.' },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, deviceToken: { type: 'apiKey', in: 'header', name: 'X-Device-Token' } } },
    paths,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Self-contained docs page (no CDN, works offline). */
export function renderDocs() {
  const tags = [...new Set(ENDPOINTS.map((e) => e.tag))];
  const color = { GET: '#0a5cc2', POST: '#0b7a42' };
  const sections = tags.map((tag) => `<h2>${esc(tag)}</h2>` + ENDPOINTS.filter((e) => e.tag === tag).map((e) => `
    <article>
      <header><b style="background:${color[e.method]}">${e.method}</b><code>${esc(e.path)}</code><span class="auth">${esc(AUTH_TEXT[e.auth] ?? e.auth)}</span></header>
      <p>${esc(e.summary)}</p>
      ${e.query ? `<table><caption>Query</caption>${Object.entries(e.query).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      ${e.body ? `<table><caption>JSON body</caption>${Object.entries(e.body).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      ${e.response ? `<div class="resp">→ <code>${esc(e.response)}</code></div>` : ''}
    </article>`).join('')).join('');
  return `<!doctype html><html lang="az"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API</title>
<style>body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:900px;margin:0 auto;padding:24px 16px;color:#0b0b0f;background:#f4f5f7}
h1{margin:0 0 4px}h2{margin:32px 0 10px}article{background:#fff;border:1px solid #e4e5ea;border-radius:12px;padding:12px 14px;margin-bottom:10px}
header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}header b{color:#fff;border-radius:6px;padding:2px 8px;font-size:12px}code{font:13px ui-monospace,Menlo,monospace}
.auth{margin-left:auto;font-size:12px;color:#5f6470;background:#f4f5f7;border-radius:999px;padding:2px 10px}p{margin:6px 0}
table{border-collapse:collapse;font-size:13px;margin:6px 0}caption{text-align:left;font-weight:600;color:#5f6470}td{border-top:1px solid #eef0f3;padding:3px 12px 3px 0;vertical-align:top}.resp{font-size:13px;color:#3d4350}</style></head>
<body><h1>Urban Crisis Engine API</h1><div style="color:#5f6470">OpenAPI: <a href="/api/openapi.json">/api/openapi.json</a> · Səhv mesajları <code>?lang=az|en|ru</code> · Personal: <code>POST /api/auth/login</code> → <code>Authorization: Bearer &lt;JWT&gt;</code></div>${sections}</body></html>`;
}
