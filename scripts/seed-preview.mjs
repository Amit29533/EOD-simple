import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/storage/index.mjs';
import { installCatalogue, PUBLISHED_CATALOGUES } from '../src/api/catalogue-service.mjs';

// This seed is for isolated review environments only. It never installs demo
// passwords or modifies an existing account. Only salted password hashes are
// committed; the generated credentials remain in the operator's local files.
export async function seedPreview(env = process.env, makeStore = createStore) {
  if (env.CONTEXT !== 'deploy-preview' || !/^\d+$/.test(env.REVIEW_ID || ''))
    throw new Error('Preview seed requires a numbered Netlify Deploy Preview.');
  const expected = `ecod-preview-${env.REVIEW_ID}`;
  if (env.STORAGE !== 'blobs' || (env.BLOBS_STORE_NAME && env.BLOBS_STORE_NAME !== expected))
    throw new Error('Preview seed refuses storage outside its isolated review store.');
  const accounts = JSON.parse(await fs.readFile(new URL('./preview-audit-accounts.json', import.meta.url), 'utf8'));
  if (accounts.some((u) => !/^s2:[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.password_hash)))
    throw new Error('Preview seed requires valid salted password hashes.');
  const store = await makeStore(env);
  for (const catalogue of Object.values(PUBLISHED_CATALOGUES)) {
    const installed = await installCatalogue(store, catalogue.role.key);
    if (installed.error) throw new Error(`Preview catalogue setup failed: ${installed.code}`);
  }
  for (const account of accounts) {
    if (!(await store.get('users', account.id))) await store.insert('users', { ...account, active: true });
  }
  console.log(`[preview] Isolated review ${env.REVIEW_ID} prepared; existing accounts preserved.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await seedPreview();
