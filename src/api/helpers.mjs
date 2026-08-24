export const ok = (body, status = 200) => ({ status, body });
export const created = (body) => ({ status: 201, body });
export const bad = (error) => ({ status: 400, body: { error } });
export const unauthorized = (error = 'Sign in required') => ({ status: 401, body: { error } });
export const forbidden = (error = 'You do not have access to this resource') => ({ status: 403, body: { error } });
export const notFound = (error = 'Not found') => ({ status: 404, body: { error } });
export const conflict = (error) => ({ status: 409, body: { error } });
export const unprocessable = (error, extra = {}) => ({ status: 422, body: { error, ...extra } });
export const tooMany = (error) => ({ status: 429, body: { error } });

export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
export const bool = (v) => v === true || v === 'true' || v === 1 || v === 'on';
/** Requires fields present and non-empty; returns list of missing names. */
export const missing = (body, fields) => fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');

export async function audit(store, actor, action, entity, entity_id, message = '', meta = {}) {
  try {
    await store.insert('audit_log', {
      actor_id: actor?.id || null,
      actor_name: actor?.name || 'system',
      action, entity, entity_id, message, meta,
    });
  } catch { /* audit must never break the request */ }
}
