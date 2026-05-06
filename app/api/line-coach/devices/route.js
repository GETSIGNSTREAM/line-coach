import { NextResponse } from 'next/server';
import { registerDevice, getDevices, deleteDevice } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  try {
    const body = await request.json();
    const { device_id, store_id, device_name, device_type, meta } = body;

    if (!device_id || !store_id) {
      return NextResponse.json(
        { error: 'device_id and store_id are required' },
        { status: 400 }
      );
    }

    const { data, error } = await registerDevice({
      device_id,
      store_id,
      device_name: device_name || device_id,
      device_type: device_type || 'kds',
      meta: meta || {},
    });

    if (error) {
      console.error('Failed to register device:', error);
      return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get('store') || 'hollywood';

  const { data, error } = await getDevices(storeId);
  if (error) {
    console.error('Failed to fetch devices:', error);
    return NextResponse.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }

  return NextResponse.json({ devices: data });
}

export async function DELETE(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get('device_id');
  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required' }, { status: 400 });
  }

  const { error } = await deleteDevice(deviceId);
  if (error) {
    console.error('Failed to delete device:', error);
    return NextResponse.json({ error: 'Failed to delete device' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
