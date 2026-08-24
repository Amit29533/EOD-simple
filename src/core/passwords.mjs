import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Hash a password with scrypt + random salt. Format: s2:<salt>:<hash> (hex). */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [tag, salt, hash] = String(stored).split(':');
    if (tag !== 's2' || !salt || !hash) return false;
    const candidate = scryptSync(String(password), salt, 64);
    return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
