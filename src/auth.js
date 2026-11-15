import { timingSafeEqual } from 'node:crypto';

// Role -> permissions. Adding a role (Challenge Drop: "new role") = one line here + one token.
export const ROLE_PERMISSIONS = {
  citizen: [],
  dispatcher: ['dashboard', 'alert:approve', 'road:write', 'brigade:write', 'broadcast:send'],
  observer: ['dashboard'], // read-only example role
  admin: ['*'],
};

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

export class Auth {
  constructor(tokens = defaultTokens(), permissions = ROLE_PERMISSIONS) {
    this.tokens = Object.entries(tokens);
    this.permissions = permissions;
  }

  /** Returns role name or null. Accepts "Authorization: Bearer x" or ?token=x (for SSE). */
  roleFor(req, url) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') ?? '';
    if (!token) return null;
    for (const [known, role] of this.tokens) if (safeEqual(known, token)) return role;
    return null;
  }

  can(role, permission) {
    const perms = this.permissions[role] ?? [];
    return perms.includes('*') || perms.includes(permission);
  }
}
