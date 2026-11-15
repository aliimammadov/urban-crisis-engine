/** Loopback / private / link-local / unknown addresses cannot be attributed to one household or attacker
 *  (LAN demo, docker network, reverse proxy), so they are excluded from per-IP abuse analysis. */
export function isPrivateIp(ip) {
  if (!ip || ip === 'local' || ip === 'unknown') return true;
  const v = ip.replace(/^::ffff:/i, '');
  if (v === '::1' || v === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v) || /^fe80:/i.test(v)) return true; // IPv6 ULA / link-local
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false; // not an IP literal (e.g. test labels): treated as a normal, attributable id
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Client address. X-Forwarded-For is honoured ONLY when the operator says a trusted proxy sets it. */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}
