import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Build identity, so a kiosk can tell when it is running stale code.
//
// The Pis launch Chromium once at boot against a fixed URL and never
// reload — the watchdog only relaunches if the process dies. A kiosk
// that booted three weeks ago is still executing the bundle it
// downloaded then, and until now the only remedy was SSHing into six
// machines to press F5 (DEPLOYMENT.md). The display polls this and
// reloads itself once the board is idle.
//
// MUST be deterministic. If this ever returned a timestamp or anything
// per-request, every kiosk in the brand would reload-loop. It is a build
// constant or nothing.
//
// Unauthenticated on purpose, like orders/config: it leaks only a build
// sha, and gating it would mean a screen that has lost its pairing could
// never self-heal onto fixed code — exactly when you most want it to.

export const dynamic = 'force-dynamic';

// Resolved once per lambda cold start rather than per request, which
// also makes the "deterministic" property obvious at a glance.
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.VERCEL_DEPLOYMENT_ID
  || 'dev';

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  return NextResponse.json({ version: VERSION }, {
    // If this response is ever cached — by Vercel's edge, by a proxy, or
    // by Chromium itself — the kiosk can never learn about a new build
    // and the whole mechanism silently does nothing. That is the one
    // failure mode with no visible symptom, so it is pinned hard here.
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    },
  });
}
