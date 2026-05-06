import { NextResponse } from 'next/server';
import { getMaintenanceStats, purgeOldLogs, archiveOldOrders } from '@/lib/line-coach';
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

  const { data, error } = await getMaintenanceStats();
  if (error) {
    console.error('Failed to fetch maintenance stats:', error);
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const action = body?.action;
  const days = Math.min(Math.max(parseInt(body?.days, 10) || 0, 1), 365);

  if (action === 'purge_logs') {
    const { data, error } = await purgeOldLogs(days || 30);
    if (error) return NextResponse.json({ error: 'Purge failed' }, { status: 500 });
    return NextResponse.json({ deleted: data });
  }
  if (action === 'archive_orders') {
    const { data, error } = await archiveOldOrders(days || 7);
    if (error) return NextResponse.json({ error: 'Archive failed' }, { status: 500 });
    return NextResponse.json({ archived: data });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
