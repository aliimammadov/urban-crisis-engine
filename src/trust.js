// Device reputation + geo plausibility for SOS signals.
// Idea adapted from "truth discovery": a source earns trust when its reports are corroborated
// and loses it when flagged. Trust never DROPS a signal; it only decides whether a signal may
// count towards automatic escalation (see AbuseGuard).
export const TRUST = Object.freeze({ start: 0.5, min: 0.1, max: 1.0, newDeviceMs: 5 * 60_000, exemptAgeMs: 2 * 60_000 });
export const OUT_OF_AREA_M = 25_000; // farther than this from every district centre = not in the covered city

const clamp = (t) => Math.max(TRUST.min, Math.min(TRUST.max, t));
export const rewardTrust = (t, by = 0.05) => clamp(t + by);
export const penalizeTrust = (t, by = 0.1) => clamp(t - by);

/** New or unsigned devices weigh little for the first minutes. */
export function effectiveTrust(trust, deviceAgeMs, verified) {
  let t = trust;
  if (!verified) t = Math.min(t, 0.2);
  if (deviceAgeMs < TRUST.newDeviceMs) t = Math.min(t, 0.3);
  return t;
}

/** A verified, established, reputable device is not treated as suspicious just for sharing an IP (NAT, stadium Wi-Fi). */
export function isExempt(device, now) {
  return !!device && device.verified && now - device.firstSeen >= TRUST.exemptAgeMs && device.trust >= 0.5;
}

/**
 * Geo plausibility of an SOS position.
 *  - far outside the covered area  -> weight 0, flag 'out_of_area'
 *  - missing / very poor accuracy  -> weak (0.4), no flag (manual district pick is legitimate)
 */
export function geoAssess(distanceToNearestDistrictM, accuracyM) {
  if (distanceToNearestDistrictM > OUT_OF_AREA_M) return { weight: 0, flag: 'out_of_area' };
  if (accuracyM == null || accuracyM > 500) return { weight: 0.4, flag: null };
  return { weight: 1, flag: null };
}
