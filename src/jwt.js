// Minimal JWT (RFC 7519) with HS256, built on node:crypto. No dependencies.
// Deliberately strict: only HS256 is accepted ("alg: none" and algorithm-confusion tricks are rejected),
// the signature is compared in constant time, and exp is mandatory.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const HEADER = b64({ alg: 'HS256', typ: 'JWT' });
const MAX_LEN = 2048;

const sig = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

export function signJwt(claims, secret, { ttlSec = 3600, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const payload = b64({ ...claims, iat, exp: iat + ttlSec, jti: claims.jti ?? randomUUID() });
  return `${HEADER}.${payload}.${sig(`${HEADER}.${payload}`, secret)}`;
}

/** Returns the claims of a valid token, otherwise null (never throws). */
export function verifyJwt(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > MAX_LEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header; let claims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) return null;
  const expected = Buffer.from(sig(`${h}.${p}`, secret));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!claims || typeof claims !== 'object') return null;
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || t >= claims.exp) return null;
  if (typeof claims.nbf === 'number' && t < claims.nbf) return null;
  if (typeof claims.iat === 'number' && claims.iat > t + 60) return null; // issued "in the future"
  return claims;
}
