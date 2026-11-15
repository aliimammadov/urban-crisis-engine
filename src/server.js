import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const num = (v) => (v === undefined ? undefined : Number(v));
const { server } = createApp({
  limits: {
    sosBurst: num(process.env.SOS_BURST), sosPerSec: num(process.env.SOS_PER_SEC),
    apiBurst: num(process.env.API_BURST), apiPerSec: num(process.env.API_PER_SEC),
  },
});

server.listen(port, () => {
  console.log(`Urban Crisis Engine  → http://localhost:${port}`);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) console.log(`Mobile (same Wi-Fi)  → http://${lan}:${port}/mobile  (GPS needs HTTPS, use a tunnel)`);
  console.log(`Dispatcher dashboard → http://localhost:${port}/dispatcher  (token: admin-demo / dispatcher-demo)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
