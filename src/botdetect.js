// Bot / fake-SOS attack detection over a sliding 5-minute window.
// Adapted from the transit project's detector, with changes that matter for emergencies:
//  * "no coordinates" and "fresh device" are NOT culprit signals: in a real disaster many people
//    pick a district manually and almost every device is new. They can raise a "surge", never a quarantine.
//  * Culprits are identified only by IP concentration (many distinct devices behind one IP),
//    and verified/established devices are exempt (NAT / stadium Wi-Fi).
//  * An "attack" needs >= 2 independent signals AND at least one identifiable culprit.
import { isExempt } from './trust.js';
import { isPrivateIp } from './net.js';

export const BOT_WINDOW_MS = 5 * 60_000;

/**
 * @param reports   [{id, ts, ip, deviceId}]
 * @param devices   Map deviceId -> {firstSeen, verified, trust}
 * @param opts      {baselinePerMin, burstMin, ipDeviceLimit}
 */
export function detectBots(reports, now, devices, { baselinePerMin = 1, burstMin = 20, ipDeviceLimit = 6 } = {}) {
  const recent = reports.filter((r) => now - r.ts <= BOT_WINDOW_MS && r.ts <= now);
  const signals = [];
  const suspicious = new Set();
  const base = Math.max(1, baselinePerMin);
  const lastMin = recent.filter((r) => now - r.ts <= 60_000).length;

  // 1) rate burst
  if (lastMin >= Math.max(burstMin, base * 8)) signals.push({ code: 'burst', n: lastMin, base: Math.round(base * 10) / 10 });

  // 2) many distinct devices behind one IP -> identifies culprits (unless exempt)
  const byIp = new Map();
  for (const r of recent) {
    if (isPrivateIp(r.ip)) continue; // unattributable network (LAN / proxy / localhost)
    if (!byIp.has(r.ip)) byIp.set(r.ip, new Set());
    byIp.get(r.ip).add(r.deviceId);
  }
  const badIps = [...byIp.entries()].filter(([, d]) => d.size >= ipDeviceLimit).map(([ip]) => ip);
  if (badIps.length) {
    signals.push({ code: 'ip_concentration', ips: badIps.length, devices: Math.max(...badIps.map((ip) => byIp.get(ip).size)) });
    for (const r of recent) if (badIps.includes(r.ip) && !isExempt(devices.get(r.deviceId), now)) suspicious.add(r.id);
  }

  // 3) machine rhythm: near-constant gaps between reports
  const sorted = [...recent].sort((a, b) => a.ts - b.ts);
  if (sorted.length >= 8) {
    const gaps = sorted.slice(1).map((r, i) => r.ts - sorted[i].ts);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    if (mean > 0 && sd / mean < 0.15) signals.push({ code: 'rhythm' });
  }

  // 4) almost every sender is a brand-new device (signal only)
  if (recent.length >= 8) {
    const fresh = recent.filter((r) => now - (devices.get(r.deviceId)?.firstSeen ?? now) < 2 * 60_000);
    if (fresh.length / recent.length > 0.7) signals.push({ code: 'fresh_devices', pct: Math.round((fresh.length / recent.length) * 100) });
  }

  const multi = signals.length >= 2;
  return {
    attack: multi && suspicious.size > 0,
    surge: multi && suspicious.size === 0, // unusual volume but nobody to blame: treat as a real mass event
    signals,
    suspiciousIds: suspicious,
    ratePerMin: lastMin,
    baselinePerMin: base,
  };
}
