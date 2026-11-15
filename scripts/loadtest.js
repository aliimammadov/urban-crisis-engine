// Load test: node scripts/loadtest.js [baseUrl] [total] [concurrency]
// Server must run with relaxed limits for a pure throughput test:  SOS_BURST=100000 npm start
const base = process.argv[2] || 'http://localhost:3000';
const total = Number(process.argv[3]) || 2000;
const conc = Number(process.argv[4]) || 50;

const lat = () => 40.35 + Math.random() * 0.12;
const lng = () => 49.80 + Math.random() * 0.2;
const lat95 = [];
const codes = {};
let sent = 0;

async function worker() {
  while (sent < total) {
    const i = sent++;
    const t0 = performance.now();
    const isSos = i % 2 === 0;
    const res = await fetch(isSos ? `${base}/api/sos` : `${base}/api/evacuation?lat=${lat()}&lng=${lng()}`, isSos
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ citizenId: `load-${i}`, type: 'FIRE', lat: lat(), lng: lng() }) }
      : undefined).catch(() => ({ status: 0 }));
    lat95.push(performance.now() - t0);
    codes[res.status] = (codes[res.status] || 0) + 1;
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, worker));
const secs = (performance.now() - t0) / 1000;
lat95.sort((a, b) => a - b);
console.log({ total, conc, secs: secs.toFixed(2), rps: Math.round(total / secs), p50: lat95[Math.floor(total * 0.5)].toFixed(1), p95: lat95[Math.floor(total * 0.95)].toFixed(1), codes });
