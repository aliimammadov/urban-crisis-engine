// Vercel entry point: the same request handler as `npm start`, wrapped as a serverless function.
// State is kept in memory per warm instance (this prototype has no database), see README "Deployment".
import { createApp } from '../src/app.js';
import { loadKeys } from '../src/keystore.js';

const app = createApp({
  keys: loadKeys('/tmp/urban-crisis-keys.json'), // SIGNING_KEY_PEM (platform env) wins when set; /tmp is the only writable place
  trustProxy: true, // the platform proxy sets X-Forwarded-For
});

export default (req, res) => app.handler(req, res);
