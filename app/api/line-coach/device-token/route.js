import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { signToken } from '@/lib/jwt';
import { requireAdmin } from '@/lib/auth';
import { registerDevice, invalidateDeviceCache } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Pair a screen. Admin-only: the admin fills in a store (+ optional
// station), gets a URL back, and opens it once on the target device.
// Modeled on phone-token/route.js — same admin gate, same "return the
// whole URL so the admin UI can put it straight on the clipboard" shape.
// That flow already works end to end for manager links; no reason to
// invent a second pairing mechanism for screens.
//
// Token claims:
//   role: 'device'  (gates requireDevice)
//   did:  the lc_devices primary key
//   store, station, mode
//
// Why the SERVER mints device_id: today the browser makes one up
// (`display-${storeId}-${Math.random()...}` in LineCoachDisplay) and
// POSTs it to an open endpoint, so anyone could register phantom
// devices or overwrite a real one by guessing its id. A server-side
// randomUUID tied to an admin-authenticated mint removes that whole
// class of problem, and the client stops needing to care about ids at
// all — requireDevice reads `did` off the token.
//
// Expiry is 365d but is NOT the security control: revocation is.
// Deleting or revoking the lc_devices row kills the token immediately
// (see requireDevice), and re-issuing bumps token_issued_at, which
// supersedes every token minted before it.

const TOKEN_TTL = '365d';
const ALLOWED_STATIONS = ['oven', 'grill', 'fryer', 'line', 'cold', 'hot_hold', 'grab'];
const ALLOWED_MODES = ['kds', 'manager'];

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  let body = {};
  try {
    body = await request.json();
  } catch { /* validated below */ }

  const storeId = typeof body?.store_id === 'string' ? body.store_id.trim() : '';
  if (!storeId) {
    return NextResponse.json({ error: 'store_id is required' }, { status: 400 });
  }

  // Station is optional and may be comma-separated so one expo screen
  // can cover 'grill,fryer'. Reject unknown slugs outright rather than
  // silently ignoring them — a typo'd station on a paired screen would
  // otherwise render a permanently empty board with no explanation.
  let station = null;
  if (typeof body?.station === 'string' && body.station.trim()) {
    const parts = body.station.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((s) => !ALLOWED_STATIONS.includes(s));
    if (bad.length) {
      return NextResponse.json(
        { error: `unknown station(s): ${bad.join(', ')}. Allowed: ${ALLOWED_STATIONS.join(', ')}` },
        { status: 400 }
      );
    }
    station = parts.join(',');
  }

  const mode = ALLOWED_MODES.includes(body?.mode) ? body.mode : 'kds';

  // Passing an existing device_id is the re-issue path: same row, same
  // heartbeat history, new token_issued_at — which instantly supersedes
  // whatever link was floating around before.
  const deviceId = typeof body?.device_id === 'string' && body.device_id.trim()
    ? body.device_id.trim()
    : randomUUID();
  const isReissue = Boolean(body?.device_id);

  const deviceName = typeof body?.device_name === 'string' && body.device_name.trim()
    ? body.device_name.trim()
    : `${storeId}${station ? ` · ${station}` : ''} ${mode === 'manager' ? 'manager' : 'display'}`;

  // Write the row BEFORE signing. requireDevice rejects a token whose
  // device row is missing, so a failed write must not hand back a token
  // that looks valid but can never authenticate.
  const issuedAt = new Date();
  const { error } = await registerDevice({
    device_id: deviceId,
    store_id: storeId,
    device_name: deviceName,
    device_type: mode === 'manager' ? 'manager' : 'kds',
    station,
    token_issued_at: issuedAt.toISOString(),
    revoked_at: null,
    revoked_reason: null,
    meta: {},
  });
  if (error) {
    console.error('device-token: failed to upsert device:', error);
    return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
  }
  // The re-issue path must not keep serving the pre-revoke row from the
  // 30s auth cache on this instance.
  invalidateDeviceCache(deviceId);

  const token = signToken({ role: 'device', did: deviceId, store: storeId, station, mode }, TOKEN_TTL);

  // Host comes off the request so this works on wildbird.coach and on
  // per-deploy preview URLs alike.
  const reqUrl = new URL(request.url);
  const origin = `${reqUrl.protocol}//${reqUrl.host}`;
  const params = new URLSearchParams({ store: storeId, touch: '1', dt: token });
  if (station) params.set('station', station);
  const shareUrl = `${origin}/?${params.toString()}`;

  return NextResponse.json({
    device_id: deviceId,
    device_name: deviceName,
    store_id: storeId,
    station,
    mode,
    reissued: isReissue,
    url: shareUrl,
    expires_in: TOKEN_TTL,
  });
}
