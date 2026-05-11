import { NextResponse } from 'next/server';
import { getDistinctDiningGuids } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Dining-options endpoint — powers the admin's Dining Options tab.
// Returns every distinct Toast dining-option GUID we've seen across
// the last `days` days, per store, with a count + the current
// admin-assigned label (or '' if not yet labeled).
//
// Auth: requireAdmin. Labels are persisted via the existing config
// update path through BRAND_FIELDS, so this endpoint is read-only.

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(rawDays) ? rawDays : 30));

  const { data, error } = await getDistinctDiningGuids({ days });
  if (error) {
    console.error('dining-options error:', error);
    return NextResponse.json({ error: 'Failed to list dining options' }, { status: 500 });
  }
  return NextResponse.json({ days, guids: data || [], ran_at: new Date().toISOString() });
}
