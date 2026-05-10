import { NextResponse } from 'next/server';
import { unbumpOrder } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  try {
    const body = await request.json();
    const { orderId } = body;
    if (!orderId) {
      return NextResponse.json({ error: 'orderId is required' }, { status: 400 });
    }

    const { data, error } = await unbumpOrder(orderId);
    if (error) {
      console.error('Failed to unbump order:', error);
      return NextResponse.json({ error: 'Failed to unbump order' }, { status: 500 });
    }
    return NextResponse.json({ status: 'restored', order: data });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
