// Staff authentication (JWT) + role-based access control (RBAC).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateKeys } from './keystore.js';
import { signJwt, verifyJwt } from './jwt.js';

// Role -> permissions. A new staff role = one line here (+ a user).
export const ROLE_PERMISSIONS = {
  citizen: [],
  dispatcher: ['dashboard', 'alert:approve', 'road:write', 'brigade:write', 'broadcast:send'],
  observer: ['dashboard'], // read-only
  admin: ['*'],
};
/** Permission that only requires "any signed-in staff member". */
export const ANY_STAFF = '@staff';

/** Demo accounts; override the passwords with ADMIN_PASSWORD / DISPATCHER_PASSWORD / OBSERVER_PASSWORD. */
export function defaultUsers(env = process.env) {
  return {
    admin: { role: 'admin', password: env.ADMIN_PASSWORD || env.ADMIN_TOKEN || 'admin-demo' },
    dispatcher: { role: 'dispatcher', password: env.DISPATCHER_PASSWORD || env.DISPATCHER_TOKEN || 'dispatcher-demo' },
    observer: { role: 'observer', password: env.OBSERVER_PASSWORD || env.OBSERVER_TOKEN || 'observer-demo' },
  };
}

/** Legacy opaque API tokens. OFF unless explicitly enabled (automated tests / scripts): see createApp({staticTokens}). */
export function defaultTokens(env = process.env) {
  return {
    [env.DISPATCHER_TOKEN || 'dispatcher-demo']: 'dispatcher',
    [env.ADMIN_TOKEN || 'admin-demo']: 'admin',
    [env.OBSERVER_TOKEN || 'observer-demo']: 'observer',
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const hash = (password, salt) => scryptSync(String(password), salt, 32, { N: 1 << 14 });

export class Auth {
  constructor({
    users = defaultUsers(), permissions = ROLE_PERMISSIONS, keys = generateKeys(),
    ttlSec = (Number(process.env.JWT_TTL_MIN) || 60) * 60, now = () => Date.now(), staticTokens = null,
  } = {}) {
    this.permissions = permissions;
    this.keys = keys; // {privateKey, publicKey}: tokens are signed with the private key and checked with the public one
    this.ttlSec = ttlSec;
    this.now = now;
    this.salt = randomBytes(16);
    this.users = new Map(Object.entries(users).map(([name, u]) => [name, { role: u.role, password: u.password, hash: null }]));
    this.dummy = null; // hash used to spend the same time on unknown user names (made on first login)
    this.revoked = new Map(); // jti -> exp (seconds)
    this.staticTokens = staticTokens ? Object.entries(staticTokens) : null;
  }

  /** Password check. Returns a signed token or null. Unknown users cost the same time as wrong passwords. */
  login(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || password.length > 200) return null;
    const u = this.users.get(username);
    if (u && !u.hash) { u.hash = hash(u.password, this.salt); delete u.password; } // plain text is not kept after first use
    this.dummy ??= hash('x', this.salt);
    const given = hash(password, this.salt);
    const ok = timingSafeEqual(given, u ? u.hash : this.dummy) && !!u;
    return ok ? this.issue(username, u.role) : null;
  }

  issue(sub, role) {
    const token = signJwt({ sub, role }, this.keys.privateKey, { ttlSec: this.ttlSec, now: this.now() });
    return { token, tokenType: 'Bearer', expiresInSec: this.ttlSec, user: sub, role, permissions: this.permissions[role] ?? [] };
  }

  /** @returns {{sub, role, jti, exp, via}|null} */
  identify(req, url) {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer.split('.').length === 3) {
      const c = verifyJwt(bearer, this.keys.publicKey, { now: this.now() });
      if (!c || typeof c.sub !== 'string' || !(c.role in this.permissions) || this.revoked.has(c.jti)) return null;
      const u = this.users.get(c.sub);
      if (!u || u.role !== c.role) return null; // account removed or role changed since the token was issued
      return { sub: c.sub, role: c.role, jti: c.jti, exp: c.exp, via: 'jwt' };
    }
    if (this.staticTokens) {
      const token = bearer || url?.searchParams.get('token') || '';
      if (token) for (const [known, role] of this.staticTokens) if (safeEqual(known, token)) return { sub: role, role, jti: null, exp: null, via: 'static' };
    }
    return null;
  }

  /** Role name or null (kept for callers that only need the role). */
  roleFor(req, url) {
    return this.identify(req, url)?.role ?? null;
  }

  can(role, permission) {
    const perms = this.permissions[role] ?? [];
    if (permission === ANY_STAFF) return role !== 'citizen' && role in this.permissions;
    return perms.includes('*') || perms.includes(permission);
  }

  /** Logout: the token stops working immediately (kept in a deny-list until it would have expired anyway). */
  revoke(identity) {
    if (!identity?.jti) return false;
    const t = Math.floor(this.now() / 1000);
    for (const [jti, exp] of this.revoked) if (exp <= t) this.revoked.delete(jti);
    this.revoked.set(identity.jti, identity.exp ?? t + this.ttlSec);
    return true;
  }
}
