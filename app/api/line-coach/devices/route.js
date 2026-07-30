import { NextResponse } from 'next/server';
import { registerDevice, getDevices, deleteDevice, setDeviceRevoked } from '@/lib/line-coach';
import { requireAdmin, requireDevice } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Registration. A paired device re-asserts itself here on boot; the
// device_id comes off its token, never off the request body, so a
// caller can no longer overwrite someone else's row by guessing an id.
//
// During the grace period (LC_REQUIRE_DEVICE_AUTH unset) the six live
// Pi kiosks still register the old way — self-minted id in the body —
// so they keep heartbeating until they're re-paired. That legacy branch
// goes away when the flag flips.
export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const { error: authError, device } = await requireDevice(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    if (!device.legacy) {
      // Paired: the row already exists (device-token created it). This
      // is just a liveness ping, so only refresh the heartbeat and any
      // display-name change — never let the body move store_id or
      // station, which are admin-controlled pairing decisions.
      const { data, error } = await registerDevice({
        device_id: device.device_id,
        store_id: device.store_id,
        station: device.station,
        device_name: typeof body?.device_name === 'string' && body.device_name.trim()
          ? body.device_name.trim()
          : undefined,
        meta: body?.meta && typeof body.meta === 'object' ? body.meta : undefined,
      });
      if (error) {
        console.error('Failed to register device:', error);
        return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
      }
      return NextResponse.json(data);
    }

    // ── Legacy grace-period path ──────────────────────────
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

// Admin-only: this hands back every device id for a store, which is
// exactly the list you'd want in order to impersonate one. The only
// caller is the admin Devices tab, which already holds an admin token.
export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get('store') || 'hollywood';

  const { data, error } = await getDevices(storeId);
  if (error) {
    console.error('Failed to fetch devices:', error);
    return NextResponse.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }

  return NextResponse.json({ devices: data });
}

// The kill switch. Revoking leaves the row (and its heartbeat history)
// in place but kills every token for it — use this for a lost iPad or
// a departing manager. DELETE below is the harder version that also
// drops the row.
export async function PATCH(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  let body = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : '';
  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required' }, { status: 400 });
  }
  if (typeof body?.revoked !== 'boolean') {
    return NextResponse.json({ error: 'revoked (boolean) is required' }, { status: 400 });
  }

  const { data, error } = await setDeviceRevoked({
    deviceId,
    revoked: body.revoked,
    reason: typeof body?.reason === 'string' ? body.reason.trim() || null : null,
  });
  if (error) {
    console.error('Failed to update device revocation:', error);
    return NextResponse.json({ error: 'Failed to update device' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Unknown device' }, { status: 404 });
  }
  return NextResponse.json(data);
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
