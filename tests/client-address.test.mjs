import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress, trustedProxiesFromEnv } from '../src/api/client-address.mjs';

test('client address: X-Forwarded-For is ignored unless proxies are trusted', () => {
  // A caller rotating a forged header used to get a fresh throttle bucket per attempt.
  for (const forged of ['198.51.100.1', '198.51.100.2, 10.0.0.1']) {
    assert.equal(clientAddress({ forwardedFor: forged, socketAddress: '203.0.113.5' }), '203.0.113.5');
  }
  assert.equal(clientAddress({ socketAddress: '' }), 'unknown');
});

test('client address: behind N trusted proxies the Nth hop from the right is the client', () => {
  // The client sent "1.1.1.1"; the trusted proxy appended the real peer.
  assert.equal(clientAddress({ forwardedFor: '1.1.1.1, 203.0.113.7', socketAddress: '10.0.0.2', trustedProxies: 1 }), '203.0.113.7');
  assert.equal(clientAddress({ forwardedFor: '1.1.1.1, 203.0.113.7, 10.0.0.9', socketAddress: '10.0.0.2', trustedProxies: 2 }), '203.0.113.7');
  assert.equal(clientAddress({ forwardedFor: '203.0.113.7', socketAddress: '10.0.0.2', trustedProxies: 3 }), '203.0.113.7', 'a short chain uses its leftmost entry');
  assert.equal(clientAddress({ forwardedFor: '', socketAddress: '10.0.0.2', trustedProxies: 1 }), '10.0.0.2', 'no header falls back to the socket');
});

test('client address: TRUST_PROXY parsing is strict', () => {
  assert.equal(trustedProxiesFromEnv({}), 0);
  assert.equal(trustedProxiesFromEnv({ TRUST_PROXY: 'false' }), 0);
  assert.equal(trustedProxiesFromEnv({ TRUST_PROXY: 'true' }), 1);
  assert.equal(trustedProxiesFromEnv({ TRUST_PROXY: '2' }), 2);
  assert.throws(() => trustedProxiesFromEnv({ TRUST_PROXY: 'yes' }), /Invalid TRUST_PROXY/);
  assert.throws(() => trustedProxiesFromEnv({ TRUST_PROXY: '-1' }), /Invalid TRUST_PROXY/);
});
