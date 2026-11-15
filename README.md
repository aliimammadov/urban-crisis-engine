# Urban Crisis & Crowd Evacuation Engine

Zero-dependency prototype (Node ≥ 20, no `npm install`). Two modules in one service:

| Module | URL | What it does |
|---|---|---|
| Citizen (mobile-first PWA) | `/` (alias `/mobile`) | Home: 4 SOS types → 3 s cancellable countdown → "SOS sent" with progress (reached dispatcher → brigade assigned → help on the way) and 60 s "sent by mistake" cancel. Separate route screen: map, nearest safe point, ETA, navigation link, auto-reroute when a point is ≥90% full or a road is closed. "I'm safe" is press-and-hold (1.5 s) + slide-to-confirm so it can't be hit by accident. Offline SOS queue. |
| Dispatcher | `/dispatcher` | live (SSE) dashboard: RED alerts (most critical first) showing exactly what approval will do (brigade + ETA, reserve point), one-click approve with 10 s undo, latest signals, KPIs, map, point occupancy, brigades |

```bash
npm start            # http://localhost:3000   (PORT=… to change)
npm test             # 195 tests
docker compose up --build   # optional (Dockerfile written, image not built on the author's machine)
npm run demo         # fires a SOS cluster + overcrowding + API outage (server must be running)
npm run load         # load test (start server with SOS_BURST=100000 API_BURST=100000 to disable limits)
```

Staff sign-in (JWT, demo accounts): `admin / admin-demo`, `dispatcher / dispatcher-demo`, `observer / observer-demo`. Override with `ADMIN_PASSWORD`, `DISPATCHER_PASSWORD`, `OBSERVER_PASSWORD` (optionally `JWT_TTL_MIN`). Tokens are Ed25519-signed JWTs; the key pair is generated on first start and kept in `.data/keys.json` (git-ignored, mode 0600), so logins survive restarts and no secret has to be configured. Opaque static tokens are off unless `ALLOW_STATIC_TOKENS=1` (tests only).

## Critical Crisis Algorithm (`src/crisis.js`)
* **Rule A** – ≥ 4 *distinct* citizens send SOS within 5 min, inside one district **or** within 500 m → RED alert.
* **Rule B** – assembly point occupancy > 95 % → RED alert.
* Alert text: *"Qırmızı Həyəcan: Əlavə Xilasetmə Briqadası Göndər və Yeni Toplanış Nöqtəsi Aç"*.
* `POST /api/alerts/:id/approve` (one click): dispatches the nearest free brigade **and** opens the nearest reserve assembly point. Idempotent.
* Alerts are de-duplicated (a growing cluster updates the existing alert). Thresholds live in `rules` and can be changed at runtime (`POST /api/sim/rules`).

## Architecture
```
public/ (vanilla JS + Leaflet)  ──HTTP/SSE──▶  src/app.js  (router, auth, rate-limit, SSE)
                                                 ├─ store.js       state + events (swap for a DB later)
                                                 ├─ crisis.js      rules engine (config-driven)
                                                 ├─ evacuation.js  ranking + reroute reasons
                                                 ├─ routing.js     RoadGraph + RoutingService (3-tier fallback)
                                                 ├─ auth.js        role → permission map, tokens
                                                 ├─ i18n.js        az / en / ru dictionaries
                                                 └─ ratelimit.js   token bucket
```
Routing is a **simulated** external map/traffic API (`RoadGraph` with live closures and congestion). `RoutingService` degrades gracefully: external (timeout 700 ms) → local static graph (still honours closures) → "no route" flagged as unreachable. The UI tells the citizen when fallback routing is used.

## Challenge Drop playbook (where to change things)
| Likely change | Where |
|---|---|
| New role (e.g. `medic`, `observer`) | `src/auth.js` → `ROLE_PERMISSIONS` + token; `observer` already exists as read-only example |
| New language | `src/i18n.js` → add one object (UI picks it up from `/api/i18n/:lang`; add `<option>` in the select) |
| External API outage / slowness | already handled; toggle with `POST /api/sim/chaos {externalDown, externalLatencyMs}` |
| High load | rate limiting (`src/ratelimit.js`), focus-based rule evaluation, SSE coalescing; `npm run load` ≈ 6–7k req/s locally |
| Security requirement | token auth + `timingSafeEqual`, role permissions, 16 KB body cap, input validation, static path-traversal guard, HTML escaping in UI, `nosniff` header |
| New SOS type | `SOS_TYPES` in `src/store.js` + `sos.*` keys in `src/i18n.js` |
| New thresholds | `rules` in `src/crisis.js` (`DEFAULT_RULES`) or `POST /api/sim/rules` |

## API (short)
Public: `GET /api/evacuation?lat&lng` (or `?district=`), `GET /api/points`, `GET /api/roads`, `POST /api/sos`, `POST /api/safe`, `POST /api/points/:id/checkin`, `GET /api/i18n/:lang`
Citizen extras: `GET /api/sos/:id` (progress stage 0-3 + ETA), `POST /api/sos/:id/cancel` (owner only, 60 s window)
Dispatcher: `GET /api/dashboard` (alerts carry `plan`, `typeCounts`, `undoMsLeft`), `POST /api/alerts/:id/undo` (10 s window), `POST /api/auth/login` → JWT, `POST /api/auth/stream-ticket` → `GET /api/stream?ticket=` (SSE, one-time 30 s ticket), `POST /api/alerts/:id/approve`, `POST /api/roads/:id/close|open|congestion`, `POST /api/brigades/:id/status`
Admin: `POST /api/sim/{occupancy,chaos,rules,reset}`
Add `?lang=az|en|ru` for localized error messages.

## What was added after the first prototype
* **Fake-SOS resistance** (`abuse.js`, `trust.js`, `botdetect.js`, `session.js`): signed device sessions, device reputation, bot/flood detection (IP concentration + burst + rhythm), geo plausibility. Principle: a suspicious SOS is **never dropped**; it is quarantined (not counted for auto-escalation), shown to the dispatcher and can be released in one click. A genuine mass event (many different IPs) is reported as a *surge* and nobody is quarantined. Runtime "security mode" (`requireVerified`).
* **Proactive forecast**: inflow rate per assembly point -> amber warning before 95 %; citizens are steered away from points that will be full on arrival.
* **Rule stability**: hysteresis (clear below 90 %), cooldown after approval, no duplicate alert for already-handled SOS.
* **Demo scenarios panel** (admin): cluster, fake flood, genuine mass event, filling point, overcrowd, API outage, road block, reset. They run the real pipeline.
* **Time machine**: replay the last 2 hours of the situation on the dispatcher map.
* **API docs**: `/api/docs` (offline) and `/api/openapi.json`; a test keeps them in sync with the real routes.
* **Priority-SOS role (reduced mobility / special care)**: a signed device can declare needs (wheelchair, reduced mobility, medical transport). Every SOS from it is automatically **Critical Priority #1**: one SOS raises an immediate alert at the top of the dispatcher list, the citizen gets an **accessible-only route** (ramped/step-free points, step-free road segments) and the dispatcher dispatches **accessible transport** (fallback: nearest medical brigade, flagged). Demo scenario: `priority_sos`.
* **External map API outage** (HTTP 503 / network error / answer slower than the deadline): circuit breaker (closed -> open -> half-open trial, exponential back-off) + 3-tier local backup (last cached route -> static all-pairs coordinate matrix -> live local graph, all re-validated against current road closures). Citizens see "Oflayn / Ehtiyat marşrut rejimində işləyir" and keep getting routes; the app also opens fully offline from saved data. Dispatchers see the breaker state, cause and countdown. Fault injection: `POST /api/sim/chaos {mode: ok|http503|slow|error}`; scenarios `api_outage`, `api_slow`, `api_recover`.
* **Brigade choice**: the system proposes the nearest FREE brigade of the right kind (fire -> fire, medical -> medical, collapse/flood -> rescue, mixed clusters by dominant type); the dispatcher sees every free brigade with kind, ETA and match flag and can overrule the proposal with any free one (`POST /api/alerts/:id/approve` with `brigadeId`, validated, logged as manual).
* **Dispatch to a single SOS**: signals not covered by any alert appear under "Waiting SOS"; the dispatcher sends a brigade to one of them (`POST /api/sos/:id/dispatch`) and the citizen's phone updates live (assigning -> on the way with brigade name + ETA countdown -> arrived).
* **Brigade lifecycle**: dispatched -> on scene -> returning -> available with live position/ETA on the map and in the citizen's progress screen (`brigadeTimeScale` speeds demos up).
* **Decision log**: every dispatcher decision and every system alert event (no IPs/tokens/identities), `GET /api/decisions`, shown on the dashboard.
* **Mass notification** (dispatcher -> citizens): evacuate / shelter / avoid area / all clear / custom text, targeted by city, district or radius; pull model (server never stores citizen locations); accessible users get an accessible point automatically; reach and read counters.
* **SMS fallback**: simulated gateway webhook, commands `SOS [type] [needs] <district|lat,lng>`, `SAFE`, `POINT <district>`; phone numbers are never stored (salted hash only); the mobile app offers prefilled `sms:` links when offline.
* **Full az/en (and ru) i18n**: every UI string, ARIA label and error message comes from the dictionary and switches without reload; tests fail on any hardcoded text or missing key.
* **Technical write-up**: [docs/TEXNIKI_IZAH.md](docs/TEXNIKI_IZAH.md).

## Known limitations (honest list)
* State is in memory (restart = reset). `Store` is the single seam for a DB.
* The road network is synthetic (MST + nearest neighbours between districts/points), not real streets; routes are straight segments between nodes.
* Device identity is server-signed but not tied to a phone number/OTP; a patient attacker with many real IPs could still mint trusted devices.
* Map tiles / Leaflet load from CDN; without internet lists still work, map doesn't.

## Challenge Drop 3: SOS flood / spam attack

* **Rate limiting** (`src/shield.js`, `src/ratelimit.js`): signed device = own bucket (a crowd behind one Wi-Fi is not punished together); unsigned = bucket per IP + one global bucket (a botnet of many IPs still has a fixed budget). The limit runs before the body is read; refused requests get `429`.
* **Duplicate filter** (`store.js`): same signed device (or claimed id) + same type within 60 s = the original SOS with a `repeats` counter, not a new signal.
* **Flood mode**: more than 150 attempts in 10 s turns protection on. Unsigned SOS are still accepted (never silently dropped) but quarantined, so fakes cannot raise alerts. The dispatcher sees a red banner with live counters; signed devices are unaffected.
* **JWT + RBAC** (`src/jwt.js`, `src/auth.js`): EdDSA (Ed25519) only (`alg: none` and HS256 rejected), mandatory `exp`, logout revokes the token at once, scrypt password check with equal cost for unknown users, login brute-force limits. Roles: `admin` (everything), `dispatcher` (approve, dispatch, roads, brigades, broadcast), `observer` (read-only). Denied attempts go to the decision log (`auth.denied`).
* **Latency**: tested in `test/security.test.js` (600 SOS plus dashboard reads at the same time, average < 300 ms); `npm run load` prints the average (locally about 5 ms at 16 000 req/s).
* Demo: dispatcher panel as admin → Scenarios → "SOS flood (600 requests)".
