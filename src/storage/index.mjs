import { createJsonStore } from './json-file.mjs';

/**
 * Storage factory. Selected by env STORAGE: json (default) | airtable | blobs.
 * Everything above this layer is storage-agnostic, so swapping the backend
 * later (e.g. Postgres) requires only one additional adapter file.
 */
const VALID_STORAGE = new Set(['json', 'airtable', 'blobs']);

export async function createStore(env = process.env) {
  const raw = (env.STORAGE || 'json').toLowerCase();
  const kind = VALID_STORAGE.has(raw) ? raw : 'json';
  if (raw && !VALID_STORAGE.has(raw)) {
    console.warn(`[storage] unknown STORAGE="${raw}", falling back to json`);
  }
  // Validate required env early for production
  if (kind === 'airtable') {
    if (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) {
      throw new Error('STORAGE=airtable requires AIRTABLE_API_KEY and AIRTABLE_BASE_ID');
    }
  }
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
    default: {
      const file = env.DATA_FILE || 'data/ecod.json';
      // Prevent path traversal via DATA_FILE (should be relative or absolute within project)
      if (file.includes('..') && !file.startsWith('/') && !file.startsWith('./')) {
        console.warn(`[storage] suspicious DATA_FILE path "${file}", using default`);
        return (await import('./json-file.mjs')).createJsonStore('data/ecod.json');
      }
      return (await import('./json-file.mjs')).createJsonStore(file);
    }
  }
}
