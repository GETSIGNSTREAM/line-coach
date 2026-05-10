import { NextResponse } from 'next/server';
import { getTicketTimePercentiles } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Daily p50/p90/p99 ticket time (bumped_at - toast_created_at) for one
// store over the last `days` days. Powers the admin Analytics tab's
// SLA chart with horizontal reference lines at 8/10/12 min so a
// manager sees "we're at p90=14 min — the brand-promise red line is
// at 10."

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get('store');
  if (!storeId) return NextResponse.json({ error: 'store required' }, { status: 400 });
  const days = Math.min(Math.max(parseInt(searchParams.get('days') || '7', 10), 1), 90);

  const { data, error } = await getTicketTimePercentiles({ storeId, days });
  if (error) {
    console.error('Failed to compute ticket-time percentiles:', error);
    return NextResponse.json({ error: 'Failed to compute' }, { status: 500 });
  }
  return NextResponse.json({ store_id: storeId, days, points: data });
}
