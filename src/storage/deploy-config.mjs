import built from './deploy-config.json' with { type: 'json' };

// Netlify build variables (CONTEXT/REVIEW_ID and netlify.toml environment
// values) are not guaranteed to exist in the Lambda runtime. Bundle only this
// non-secret routing metadata so every instance selects the build's store.
export function deploymentStorage(env = process.env, config = built) {
  const context = config.context || env.CONTEXT;
  const preview = ['deploy-preview', 'branch-deploy'].includes(context);
  const storeName = config.storeName || env.BLOBS_STORE_NAME || (preview
    ? `ecod-preview-${String(env.REVIEW_ID || env.BRANCH || 'default').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}` : 'ecod');
  if (preview && (!storeName.startsWith('ecod-preview-') || (env.BLOBS_STORE_NAME && env.BLOBS_STORE_NAME !== storeName)))
    throw new Error('Netlify Blobs preview storage must be isolated from production.');
  return { kind: preview ? 'blobs' : (env.STORAGE || 'json').toLowerCase(), storeName,
    requireConsistency: preview || context === 'production' || env.BLOBS_REQUIRE_CONSISTENCY === 'true' };
}
