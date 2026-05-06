import { NextResponse } from 'next/server';
import { listWebhookLogs } from '@/lib/line-coach';
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
  const storeId = searchParams.get('store') || undefined;
  const status = searchParams.get('status') || undefined;
  const limit = searchParams.get('limit') || 50;
  const sinceHours = parseInt(searchParams.get('hours') || '24', 10);

  const { data, error } = await listWebhookLogs({ storeId, status, limit, sinceHours });
  if (error) {
    console.error('Failed to list webhook logs:', error);
    return NextResponse.json({ error: 'Failed to list webhook logs' }, { status: 500 });
  }
  return NextResponse.json({ logs: data || [] });
}
