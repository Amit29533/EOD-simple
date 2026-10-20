import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPreview } from '../scripts/seed-preview.mjs';

test('preview seeding cannot reach production, shared storage, or an unnumbered review', async () => {
  let opened = false;
  const store = () => { opened = true; throw new Error('must not open'); };
  for (const env of [
    { CONTEXT: 'production', STORAGE: 'blobs', REVIEW_ID: '1' },
    { CONTEXT: 'deploy-preview', STORAGE: 'blobs' },
    { CONTEXT: 'deploy-preview', STORAGE: 'airtable', REVIEW_ID: '1' },
    { CONTEXT: 'deploy-preview', STORAGE: 'blobs', REVIEW_ID: '1', BLOBS_STORE_NAME: 'ecod' },
  ]) await assert.rejects(seedPreview(env, store), /Preview seed/);
  assert.equal(opened, false);
});
