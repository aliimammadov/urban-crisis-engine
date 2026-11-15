// Signing keys for staff JWTs (Ed25519) and for signed device sessions (HMAC key).
// Nothing has to be configured: the first start generates fresh random keys and stores them in a private
// file (mode 0600, git-ignored), so logins survive restarts. Delete the file to log everybody out.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, deviceSecret: randomBytes(32).toString('hex') };
}

/** @param {string|null} file  null = keep keys in memory only (tests, throw-away runs) */
export function loadKeys(file) {
  if (!file) return generateKeys();
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const privateKey = createPrivateKey(saved.privateKeyPem);
      if (privateKey.asymmetricKeyType === 'ed25519' && typeof saved.deviceSecret === 'string' && saved.deviceSecret.length >= 32) {
        return { privateKey, publicKey: createPublicKey(privateKey), deviceSecret: saved.deviceSecret };
      }
    }
  } catch { /* unreadable or damaged file: make a new one below */ }
  const keys = generateKeys();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), deviceSecret: keys.deviceSecret }), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch { console.warn('  ! could not store signing keys; logins will end on restart'); }
  return keys;
}
