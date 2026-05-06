import { NextResponse } from 'next/server';
import { heartbeatDevice } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required' }, { status: 400 });
  }

  const { data, error } = await heartbeatDevice(deviceId);
  if (error && error.code === 'PGRST116') {
    return NextResponse.json({ error: 'Device not registered' }, { status: 404 });
  }
  if (error) {
    console.error('Failed to update heartbeat:', error);
    return NextResponse.json({ error: 'Failed to update heartbeat' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, last_heartbeat: data.last_heartbeat });
}
