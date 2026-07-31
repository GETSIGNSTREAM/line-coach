import { verifyToken } from './jwt.js';
import { getDeviceForAuth } from './line-coach.js';

/**
 * Extract and verify JWT from Authorization header.
 * Returns decoded payload or null.
 */
export function authenticate(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}

/**
 * Require admin role. Returns decoded payload or a 401/403 Response.
 */
export function requireAdmin(request) {
  const payload = authenticate(request);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (payload.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return payload;
}

/**
 * Require phone role. Accepts the JWT either via Authorization header
 * (preferred) or via ?t=<jwt> query param. Phones bookmark URLs — they
 * don't send headers on the initial document fetch — so the query-
 * string fallback is necessary. Header form is used by the SPA's
 * subsequent API calls for slightly tidier auditing.
 */
export function requirePhone(request) {
  let payload = authenticate(request);
  if (!payload) {
    try {
      const url = new URL(request.url);
      const t = url.searchParams.get('t');
      if (t) payload = verifyToken(t);
    } catch { /* malformed URL — fall through to 401 */ }
  }
  if (!payload || payload.role !== 'phone') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return payload;
}

// ── Device auth ─────────────────────────────────────────
//
// Gates the endpoints that CHANGE something a kitchen can see: bump,
// unbump, device registration, checklist sign-off, bird log. Read
// endpoints (orders, config) stay open — they're no more exposed on an
// iPad than on the wall-mounted Pi that's been rendering them for
// months, and locking them would break the Hub with no security gain.
//
// NOTE ON SHAPE — this deliberately does NOT match requireAdmin /
// requirePhone above, which are synchronous and return `payload |
// Response` for an `instanceof Response` check. requireDevice has to
// hit the DB, so it's async. If it kept the old shape, a call site that
// copied the existing pattern and forgot `await` would get a Promise —
// which is never `instanceof Response` — and the route would sail
// through UNAUTHENTICATED. One missing keyword, silent auth bypass.
//
// Returning a destructured object makes that mistake loud instead:
// `const { error, device } = await requireDevice(req)` on a bare Promise
// yields undefined for both, and the route throws rather than opening
// the door.
export async function requireDevice(request) {
  const deny = (reason) => ({
    error: new Response(JSON.stringify({ error: 'Unauthorized', reason }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
    device: null,
  });

  // Header first (what the Display's own fetches use); ?dt= is the
  // fallback for a kiosk booting straight into a bookmarked URL, the
  // same reasoning as requirePhone's ?t=. Separate param name on
  // purpose: a leaked manager ?t= link must not be pasteable into a
  // display to become a bump credential.
  let payload = authenticate(request);
  if (!payload) {
    try {
      const dt = new URL(request.url).searchParams.get('dt');
      if (dt) payload = verifyToken(dt);
    } catch { /* malformed URL — fall through */ }
  }

  if (!payload || payload.role !== 'device') {
    // Grace period. The six Pi kiosks are live in stores right now,
    // pointed at untokenized URLs baked into their Chromium autostart.
    // Enforcing before they're re-paired would black out every kitchen,
    // so until LC_REQUIRE_DEVICE_AUTH=1 an untokenized write is allowed
    // through and logged. Watch these lines to find any writer that
    // still needs provisioning before flipping the flag.
    if (process.env.LC_REQUIRE_DEVICE_AUTH !== '1') {
      console.warn('[device-auth] unauthenticated write allowed (grace period):',
        new URL(request.url).pathname,
        'ip=', request.headers.get('x-forwarded-for') || 'unknown',
        'ua=', (request.headers.get('user-agent') || '').slice(0, 80));
      return { error: null, device: { legacy: true, device_id: null, store_id: null, station: null } };
    }
    return deny('no_device_token');
  }

  const row = await getDeviceForAuth(payload.did);
  if (!row) return deny('unknown_device');
  if (row.revoked_at) return deny('revoked');

  // Re-issuing a device's link bumps token_issued_at, which kills every
  // token minted before it — that's the "this iPad's URL got shared in
  // a group chat" fix, without deleting the device's heartbeat history.
  //
  // 5s of slack because jsonwebtoken's iat is whole seconds while
  // token_issued_at is microsecond-precision, so a freshly minted token
  // can legitimately look up to a second "older" than its own row.
  // Re-issue moves the watermark by far more than 5s in practice.
  if (row.token_issued_at) {
    const issuedMs = (payload.iat || 0) * 1000;
    if (issuedMs < new Date(row.token_issued_at).getTime() - 5000) {
      return deny('superseded');
    }
  }

  return {
    error: null,
    device: {
      legacy: false,
      device_id: row.device_id,
      store_id: row.store_id,
      station: row.station || payload.station || null,
      mode: payload.mode || null,
    },
  };
}
