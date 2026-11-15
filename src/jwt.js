// Minimal JWT (RFC 7519/8037) signed with Ed25519 ("alg": "EdDSA"), built on node:crypto. No dependencies.
// Asymmetric: only the private key can issue tokens; the public key is enough to verify them, so there is no
// shared secret that has to be configured. Deliberately strict: only EdDSA is accepted ("alg: none" and HS256
// algorithm-confusion tricks are rejected), exp is mandatory.
import { randomUUID, sign, verify } from 'node:crypto';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const HEADER = b64({ alg: 'EdDSA', typ: 'JWT' });
const MAX_LEN = 2048;

export function signJwt(claims, privateKey, { ttlSec = 3600, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const payload = b64({ ...claims, iat, exp: iat + ttlSec, jti: claims.jti ?? randomUUID() });
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(null, Buffer.from(data), privateKey).toString('base64url')}`;
}

/** Returns the claims of a valid token, otherwise null (never throws). */
export function verifyJwt(token, publicKey, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > MAX_LEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header; let claims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'EdDSA' || (header.typ && header.typ !== 'JWT')) return null;
  let good = false;
  try { good = verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')); } catch { return null; }
  if (!good) return null;
  if (!claims || typeof claims !== 'object') return null;
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || t >= claims.exp) return null;
  if (typeof claims.nbf === 'number' && t < claims.nbf) return null;
  if (typeof claims.iat === 'number' && claims.iat > t + 60) return null; // issued "in the future"
  return claims;
}
