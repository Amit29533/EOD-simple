import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function deploymentConfig(env) {
  const context = env.CONTEXT || '';
  if (context === 'deploy-preview' && !/^\d+$/.test(env.REVIEW_ID || '')) throw new Error('A preview must have a review ID.');
  const preview = ['deploy-preview', 'branch-deploy'].includes(context);
  const identity = String(env.REVIEW_ID || env.BRANCH || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  if (preview && !identity) throw new Error('A preview must have an isolated store identity.');
  const storeName = preview ? `ecod-preview-${identity}` : env.BLOBS_STORE_NAME || 'ecod';
  if (preview && env.BLOBS_STORE_NAME && env.BLOBS_STORE_NAME !== storeName) throw new Error('Preview store override does not match this review.');
  return { context, storeName };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fs.writeFile(new URL('../src/storage/deploy-config.json', import.meta.url), JSON.stringify(deploymentConfig(process.env)) + '\n');
  console.log('[deploy] Non-secret storage context prepared.');
}
