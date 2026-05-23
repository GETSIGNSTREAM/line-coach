import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { signToken } from '@/lib/jwt';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Exchange the shared admin password for a freshly-signed admin JWT.
// Replaces the old flow where the admin pasted a hand-minted token that
// silently expired after 24h (jwt.js default) with no way to refresh —
// every admin mutation then 401'd while the panel still loaded (config
// reads are public). Now the login box posts a password here and gets a
// 30-day token back, so a lapse is a re-login, not a dead deploy.
//
// Password lives in ADMIN_PASSWORD (Vercel env). Compared in constant
// time against a SHA-256 digest so length/early-exit timing can't leak
// it. If JWT_SECRET rotates, old tokens invalidate — admin just logs in
// again to mint a fresh one.

const TOKEN_TTL = '30d';

function safeEqual(a, b) {
  // Hash both sides to a fixed 32-byte length first: timingSafeEqual
  // throws on length mismatch, and hashing avoids leaking the password
  // length through that exception path.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'login');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    // Loud, specific failure — never silently accept. This is the one
    // case where a vague message would send the admin chasing the wrong
    // thing (as the missing-service-key fallback once did for uploads).
    console.error('admin-login: ADMIN_PASSWORD is not set');
    return NextResponse.json(
      { error: 'Admin login is not configured (ADMIN_PASSWORD missing).' },
      { status: 500 },
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch { /* fall through — empty password fails the check below */ }

  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password || !safeEqual(password, expected)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const token = signToken({ role: 'admin' }, TOKEN_TTL);
  return NextResponse.json({ token, expires_in: TOKEN_TTL });
}
