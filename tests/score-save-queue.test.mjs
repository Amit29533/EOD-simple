import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSaveQueue } from '../public/js/score-save-queue.js';

test('score saves serialize snapshots and wait for edits queued during flush', async () => {
  const calls = [];
  let release;
  const queue = scoreSaveQueue(async (value) => {
    calls.push(value);
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
  });
  queue.enqueue({ question_id: 'q', score: 1, comment: 'old' });
  await Promise.resolve();
  const flushing = queue.flush();
  queue.enqueue({ question_id: 'q', score: 4, comment: 'new' });
  assert.equal(calls.length, 1);
  release();
  assert.equal(await flushing, true);
  assert.deepEqual(calls.map((c) => c.score), [1, 4]);
  assert.deepEqual(queue.status(), { pending: 0, failed: 0 });
});

test('failed score remains unsaved until explicit retry succeeds', async () => {
  let fail = true;
  const queue = scoreSaveQueue(async () => { if (fail) throw new Error('offline'); });
  queue.enqueue({ question_id: 'q', score: 0, comment: '' });
  assert.equal(await queue.flush(), false);
  assert.equal(queue.status().failed, 1);
  fail = false;
  assert.equal(await queue.retry(), true);
  assert.equal(queue.status().failed, 0);
});

test('superseded failed write cannot mark a successfully saved newer score as failed', async () => {
  const queue = scoreSaveQueue(async (v) => { if (v.score === 1) throw new Error('offline'); });
  queue.enqueue({ question_id: 'q', score: 1 });
  queue.enqueue({ question_id: 'q', score: 2 });
  assert.equal(await queue.flush(), true);
});
