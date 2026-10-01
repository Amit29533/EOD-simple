import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let value = 0, bits = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret) {
  let value = 0, bits = 0; const bytes = [];
  for (const char of secret.toUpperCase()) {
    const n = alphabet.indexOf(char); if (n < 0) throw new Error('Invalid authenticator secret');
    value = (value << 5) | n; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}
export function totp(secret, now = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const mac = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
export function matchingCounter(secret, code, last = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const n of [current, current - 1, current + 1])
    if (n > last && timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, n * 30000)))) return n;
  return null;
}
export const newMfaSecret = () => base32(randomBytes(20));
export const recoveryCodeHash = (value) => createHash('sha256').update(value.toLowerCase().replace(/-/g, '')).digest('hex');
export const mfaConfigured = () => /^[a-f0-9]{64}$/i.test(process.env.SECURITY_ENCRYPTION_KEY || '');
function key() {
  if (!mfaConfigured()) throw Object.assign(new Error('Set SECURITY_ENCRYPTION_KEY to a private 32-byte hex key.'), { code: 'SECURITY_CONFIG' });
  return Buffer.from(process.env.SECURITY_ENCRYPTION_KEY, 'hex');
}
export function encryptMfa(secret, userId) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(userId));
  const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), value: bytes.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
export function decryptMfa(value, userId) {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(value.iv, 'hex'));
  decipher.setAAD(Buffer.from(userId)); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(value.value, 'hex')), decipher.final()]).toString('utf8');
}
