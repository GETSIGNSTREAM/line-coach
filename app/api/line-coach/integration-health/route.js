import { NextResponse } from 'next/server';
import { getIntegrationHealth } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const sinceHours = Math.min(Math.max(parseInt(searchParams.get('hours') || '24', 10), 1), 24 * 7);

  const { data, error } = await getIntegrationHealth({ sinceHours });
  if (error) {
    console.error('Failed to compute integration health:', error);
    return NextResponse.json({ error: 'Failed to compute health' }, { status: 500 });
  }
  return NextResponse.json(data);
}
