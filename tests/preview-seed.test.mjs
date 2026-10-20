import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPreview } from '../scripts/seed-preview.mjs';
import { deploymentConfig } from '../scripts/configure-deploy.mjs';
import { deploymentStorage } from '../src/storage/deploy-config.mjs';

test('the bundled review context isolates a Lambda with no build environment variables', () => {
  const built = deploymentConfig({ CONTEXT: 'deploy-preview', REVIEW_ID: '49' });
  assert.deepEqual(deploymentStorage({}, built), { kind: 'blobs', storeName: 'ecod-preview-49', requireConsistency: true });
  assert.throws(() => deploymentStorage({ BLOBS_STORE_NAME: 'ecod' }, built), /isolated/);
  assert.throws(() => deploymentConfig({ CONTEXT: 'deploy-preview' }), /review ID/);
  assert.equal(deploymentStorage({ STORAGE: 'blobs' }, deploymentConfig({ CONTEXT: 'production' })).storeName, 'ecod');
});

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
