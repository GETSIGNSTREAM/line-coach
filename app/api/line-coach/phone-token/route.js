import { NextResponse } from 'next/server';
import { signToken } from '@/lib/jwt';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Mint a long-lived JWT for the phone companion. Admin-only — the
// admin generates a link, copies it, and shares it with a manager.
// Returns the full URL so the admin UI can write directly to clipboard.
//
// Token claims:
//   role: 'phone' (gates requirePhone)
//   scope: 'all' or store slug (room to scope per-manager later;
//          for v1 every link is full-brand)
//   iat: issued-at (jsonwebtoken adds this automatically)
//   exp: now + 180 days
//
// If JWT_SECRET ever rotates (admin migration, leak response), every
// outstanding phone link invalidates. Mitigation: admin re-mints from
// this endpoint in seconds.

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  let body = {};
  try {
    body = await request.json();
  } catch { /* empty body is fine — defaults below cover it */ }

  const scope = typeof body?.scope === 'string' && body.scope.length > 0
    ? body.scope
    : 'all';
  const expiresIn = typeof body?.expiresIn === 'string' && body.expiresIn.length > 0
    ? body.expiresIn
    : '180d';

  const token = signToken({ role: 'phone', scope }, expiresIn);

  // Build the share URL. The host comes from the request so this
  // works under both wildbird.coach and the per-deploy preview URLs.
  const reqUrl = new URL(request.url);
  const origin = `${reqUrl.protocol}//${reqUrl.host}`;
  const shareUrl = `${origin}/?phone&t=${encodeURIComponent(token)}`;

  return NextResponse.json({
    token,
    url: shareUrl,
    scope,
    expires_in: expiresIn,
  });
}
