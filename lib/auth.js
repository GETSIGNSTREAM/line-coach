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
