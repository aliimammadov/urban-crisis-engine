# Urban Crisis & Crowd Evacuation Engine

Zero-dependency prototype (Node ≥ 20, no `npm install`). Two modules in one service:

| Module | URL | What it does |
|---|---|---|
| Citizen (mobile-first PWA) | `/` (alias `/mobile`) | Home: 4 SOS types → 3 s cancellable countdown → "SOS sent" with progress (reached dispatcher → brigade assigned → help on the way) and 60 s "sent by mistake" cancel. Separate route screen: map, nearest safe point, ETA, navigation link, auto-reroute when a point is ≥90% full or a road is closed. "I'm safe" is press-and-hold (1.5 s) + slide-to-confirm so it can't be hit by accident. Offline SOS queue. |
| Dispatcher | `/dispatcher` | live (SSE) dashboard: RED alerts (most critical first) showing exactly what approval will do (brigade + ETA, reserve point), one-click approve with 10 s undo, latest signals, KPIs, map, point occupancy, brigades |

```bash
npm start            # http://localhost:3000   (PORT=… to change)
npm test             # 42 tests, ~0.5s
npm run demo         # fires a SOS cluster + overcrowding + API outage (server must be running)
npm run load         # load test (start server with SOS_BURST=100000 API_BURST=100000 to disable limits)
```

Tokens (demo): `admin-demo`, `dispatcher-demo`, `observer-demo` (override with `ADMIN_TOKEN`, `DISPATCHER_TOKEN`, `OBSERVER_TOKEN`).

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
Dispatcher: `GET /api/dashboard` (alerts carry `plan`, `typeCounts`, `undoMsLeft`), `POST /api/alerts/:id/undo` (10 s window), `GET /api/stream?token=` (SSE), `POST /api/alerts/:id/approve`, `POST /api/roads/:id/close|open|congestion`, `POST /api/brigades/:id/status`
Admin: `POST /api/sim/{occupancy,chaos,rules,reset}`
Add `?lang=az|en|ru` for localized error messages.

## Known limitations (honest list)
* State is in memory (restart = reset). `Store` is the single seam for a DB.
* The road network is synthetic (MST + nearest neighbours between districts/points), not real streets; routes are straight segments between nodes.
* Citizen identity is a client-generated id (no phone/OTP). SOS from one device can't be verified.
* Map tiles / Leaflet load from CDN; without internet lists still work, map doesn't.
