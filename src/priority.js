// Priority-SOS role: citizens with reduced mobility / special-care needs.
// A device with role "priority" gets every SOS marked Critical Priority #1 and an accessible-only evacuation route.
import { AppError } from './errors.js';

export const ROLES = ['citizen', 'priority'];
// wheelchair / medical_transport need accessible TRANSPORT; reduced_mobility needs a step-free route + assistance
export const NEEDS = ['wheelchair', 'reduced_mobility', 'medical_transport'];

export const sanitizeNeeds = (x) => (Array.isArray(x) ? [...new Set(x.filter((n) => NEEDS.includes(n)))] : []);

/** Strict validation for the profile endpoint (an SOS never goes through this: see app.js). */
export function normalizeProfile(input) {
  if (!input || typeof input !== 'object') throw new AppError(400, 'INVALID_PROFILE');
  const role = input.role;
  if (!ROLES.includes(role)) throw new AppError(400, 'INVALID_PROFILE');
  if (role === 'citizen') return { role, needs: [] };
  const needs = sanitizeNeeds(input.needs);
  if (!needs.length) throw new AppError(400, 'INVALID_PROFILE'); // priority role needs at least one declared need
  return { role, needs };
}
