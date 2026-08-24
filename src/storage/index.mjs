import { createJsonStore } from './json-file.mjs';

/**
 * Storage factory. Selected by env STORAGE: json (default) | airtable | blobs.
 * Everything above this layer is storage-agnostic, so swapping the backend
 * later (e.g. Postgres) requires only one additional adapter file.
 */
export async function createStore(env = process.env) {
  const kind = (env.STORAGE || 'json').toLowerCase();
  switch (kind) {
    case 'airtable': {
      const { createAirtableStore } = await import('./airtable.mjs');
      return createAirtableStore({ apiKey: env.AIRTABLE_API_KEY, baseId: env.AIRTABLE_BASE_ID, apiUrl: env.AIRTABLE_API_URL });
    }
    case 'blobs': {
      const { createBlobsStore } = await import('./netlify-blobs.mjs');
      return createBlobsStore();
    }
    case 'json':
    default:
      return createJsonStore(env.DATA_FILE || 'data/ecod.json');
  }
}
