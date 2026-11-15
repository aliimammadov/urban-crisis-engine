// Demo driver: node scripts/demo.js [baseUrl]
// Fires a SOS cluster in Nasimi (-> RED alert) and overfills a point (-> overcrowd alert).
const base = process.argv[2] || 'http://localhost:3000';
// staff sign-in (JWT). Passwords: ADMIN_PASSWORD env var, default is the demo one.
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin-demo' }) }).then((r) => r.json());
if (!login.token) { console.error('login failed', login); process.exit(1); }
const admin = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
const post = (path, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

await post('/api/sim/reset', {}, admin);
console.log('1) 4 different citizens send SOS within 500m...');
for (let i = 1; i <= 4; i++) {
  await post('/api/sos', { citizenId: `demo-${i}`, type: ['FIRE', 'COLLAPSE', 'MEDICAL', 'FIRE'][i - 1], lat: 40.4093 + i * 0.0006, lng: 49.833 });
  await new Promise((r) => setTimeout(r, 400));
}
console.log('   -> dispatcher panel shows a RED alert');
await new Promise((r) => setTimeout(r, 2500));
console.log('2) Overfilling Bulvar-side park to 96%...');
await post('/api/sim/occupancy', { pointId: 'p1', occupied: Math.round(8000 * 0.96) }, admin);
console.log('3) Simulating external map API outage...');
await post('/api/sim/chaos', { externalDown: true }, admin);
console.log('Done. Open /dispatcher and press Approve. Reset with POST /api/sim/reset.');
