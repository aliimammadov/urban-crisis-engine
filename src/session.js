import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Server-issued, HMAC-signed device identity. A token proves the id was minted by us (and rate-limited at issuance). */
export class Sessions {
  constructor(secret = process.env.TOKEN_SECRET || randomBytes(24).toString('hex')) {
    this.secret = secret;
  }

  #sig(deviceId) {
    return createHmac('sha256', this.secret).update(deviceId).digest('base64url');
  }

  /** Returns {deviceId, token}. A previously issued id is kept so the device keeps its reputation. */
  issue(previousId) {
    const deviceId = typeof previousId === 'string' && ID_RE.test(previousId) ? previousId : `d-${randomUUID()}`;
    return { deviceId, token: `${deviceId}.${this.#sig(deviceId)}` };
  }

  /** Returns the deviceId for a valid token, else null. Never throws. */
  verify(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i < 1) return null;
    const id = token.slice(0, i);
    if (!ID_RE.test(id)) return null;
    const a = Buffer.from(token.slice(i + 1));
    const b = Buffer.from(this.#sig(id));
    return a.length === b.length && timingSafeEqual(a, b) ? id : null;
  }
}
