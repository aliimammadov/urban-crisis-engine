import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { installProcessGuards } from './guards.js';
import { loadKeys } from './keystore.js';

installProcessGuards();

const port = Number(process.env.PORT) || 3000;
const num = (v) => (v === undefined ? undefined : Number(v));
const { server } = createApp({
  keys: loadKeys(process.env.KEY_FILE ?? '.data/keys.json'), // generated on first start, kept in a private file
  limits: {
    sosBurst: num(process.env.SOS_BURST), sosPerSec: num(process.env.SOS_PER_SEC),
    apiBurst: num(process.env.API_BURST), apiPerSec: num(process.env.API_PER_SEC),
  },
});

const usingDemoTokens = !process.env.ADMIN_TOKEN || !process.env.DISPATCHER_TOKEN;
if (process.env.NODE_ENV === 'production' && usingDemoTokens) {
  console.warn('WARNING: demo staff tokens are active. Set ADMIN_TOKEN and DISPATCHER_TOKEN before exposing this service.');
}

server.listen(port, () => {
  console.log(`Urban Crisis Engine  → http://localhost:${port}`);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) console.log(`Mobile (same Wi-Fi)  → http://${lan}:${port}/mobile  (GPS needs HTTPS, use a tunnel)`);
  console.log(`Dispatcher dashboard → http://localhost:${port}/dispatcher  (sign in: dispatcher / dispatcher-demo, admin / admin-demo, observer / observer-demo)`);
  const weak = [!(process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN) && 'default demo passwords in use (set ADMIN_PASSWORD, DISPATCHER_PASSWORD, OBSERVER_PASSWORD)'].filter(Boolean);
  for (const w of weak) console.warn(`  ! ${w}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
