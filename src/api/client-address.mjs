/**
 * The client address the self-hosted server buckets login throttling and
 * request budgets on.
 *
 * `X-Forwarded-For` is written by whoever sends the request, so it is only
 * meaningful for the hops added by proxies the operator actually runs. With
 * `trustedProxies` = 0 (the default) the header is ignored and the socket
 * address is used: honouring it unconditionally let any caller claim a fresh
 * address on every attempt and step around the per-address limits.
 *
 * Behind N trusted proxies each one appends the address it received the
 * connection from, so the real client is the Nth entry from the RIGHT; the
 * leftmost entries are whatever the client chose to send. When the header is
 * shorter than N (a request that skipped a proxy), the leftmost entry present
 * is the best available and the socket address is the fallback.
 */
export function clientAddress({ forwardedFor = '', socketAddress = '', trustedProxies = 0 } = {}) {
  const socket = String(socketAddress || '').trim() || 'unknown';
  const hops = Number.isInteger(trustedProxies) && trustedProxies > 0 ? trustedProxies : 0;
  if (!hops) return socket;
  const chain = String(forwardedFor || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!chain.length) return socket;
  return chain[Math.max(0, chain.length - hops)];
}

/** `TRUST_PROXY`: how many reverse proxies sit in front of the server (0 = none). */
export function trustedProxiesFromEnv(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`Invalid TRUST_PROXY: ${env.TRUST_PROXY} (use the number of proxies in front of the server, 0-10)`);
  return n;
}
