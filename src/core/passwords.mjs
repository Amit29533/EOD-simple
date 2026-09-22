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

/**
 * How many scrypt jobs a bulk hash keeps in flight at once. Node runs scrypt
 * on the libuv threadpool (4 threads by default) and the queue is FIFO, so
 * `Promise.all(rows.map(hashPasswordAsync))` over a 2000-row import parks
 * two thousand jobs ahead of every other user's login for the ~40 s the
 * import takes (a login also needs a scrypt to verify). Two in flight leaves
 * room on the pool for everyone else at a small cost in wall time.
 */
export const BULK_HASH_CONCURRENCY = 2;

/**
 * Hash many passwords, in order, with at most `concurrency` scrypt jobs in
 * flight. Results line up with `passwords` by index.
 */
export async function hashPasswordsAsync(passwords, concurrency = BULK_HASH_CONCURRENCY) {
  const list = Array.from(passwords);
  const out = new Array(list.length);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await hashPasswordAsync(list[i]);
    }
  }));
  return out;
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
