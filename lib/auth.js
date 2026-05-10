import { verifyToken } from './jwt.js';

/**
 * Extract and verify JWT from Authorization header.
 * Returns decoded payload or null.
 */
export function authenticate(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}

/**
 * Require admin role. Returns decoded payload or a 401/403 Response.
 */
export function requireAdmin(request) {
  const payload = authenticate(request);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (payload.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return payload;
}

/**
 * Require phone role. Accepts the JWT either via Authorization header
 * (preferred) or via ?t=<jwt> query param. Phones bookmark URLs — they
 * don't send headers on the initial document fetch — so the query-
 * string fallback is necessary. Header form is used by the SPA's
 * subsequent API calls for slightly tidier auditing.
 */
export function requirePhone(request) {
  let payload = authenticate(request);
  if (!payload) {
    try {
      const url = new URL(request.url);
      const t = url.searchParams.get('t');
      if (t) payload = verifyToken(t);
    } catch { /* malformed URL — fall through to 401 */ }
  }
  if (!payload || payload.role !== 'phone') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return payload;
}
