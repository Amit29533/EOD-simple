import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learningUrl } from '../src/api/handlers/meta.mjs';
test('the LMS navigation link accepts HTTPS and loopback, without credential or script URLs', () => {
  assert.equal(learningUrl('https://learn.anthroprime.com/'), 'https://learn.anthroprime.com');
  assert.equal(learningUrl('http://127.0.0.1:3140'), 'http://127.0.0.1:3140');
  for (const url of ['', 'javascript:alert(1)', 'http://untrusted.example', 'https://user:secret@example.com', 'https://example.com?token=secret']) assert.equal(learningUrl(url), '');
});
