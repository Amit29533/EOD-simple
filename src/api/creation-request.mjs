import { createHash } from 'node:crypto';
import { stableJson } from './helpers.mjs';

/** Persist non-secret request identity; passwords remain scrypt hashes. */
export function creationRequest(body, actorId) {
  if (body.request_id === undefined) return null;
  if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(body.request_id))
    return { error: 'Request id must contain 16 to 100 letters, numbers or hyphens.' };
  const { password, request_id, ...values } = body;
  return { key: request_id, actor_id: actorId, signature: createHash('sha256').update(stableJson({ actorId, values })).digest('hex') };
}
export const sameCreation = (existing, request) => request && existing?.creation_request?.key === request.key
  && existing.creation_request.signature === request.signature;
export const creationId = (request, scope) => request
  ? `rec_${createHash('sha256').update(`${scope}:${request.actor_id}:${request.key}`).digest('hex').slice(0, 18)}` : undefined;
