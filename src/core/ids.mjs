import { randomBytes } from 'node:crypto';

/** Opaque record id, Airtable-style. */
export const newId = (prefix = 'rec') => `${prefix}_${randomBytes(9).toString('hex')}`;
/** Session token. */
export const newToken = () => randomBytes(32).toString('hex');
