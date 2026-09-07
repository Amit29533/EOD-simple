import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** Hash a password with scrypt + random salt. Format: s2:<salt>:<hash> (hex). */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `s2:${salt}:${hash}`;
}

/** Async variant — does not block the event loop, use in request handlers. */
export async function hashPasswordAsync(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, 64);
  return `s2:${salt}:${derived.toString('hex')}`;
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

export async function verifyPasswordAsync(password, stored) {
  try {
    const [tag, salt, hash] = String(stored).split(':');
    if (tag !== 's2' || !salt || !hash) return false;
    const candidate = await scryptAsync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
