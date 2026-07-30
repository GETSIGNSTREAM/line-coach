import { NextResponse } from 'next/server';
import { getBirdBatches, addBirdBatch, markBirdBatchPulled, resolveBirdBatch, undoBirdBatch, getConfig } from '@/lib/line-coach';
import { requireDevice } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Bird oven log — kiosk-facing (unauthenticated + device rate limit,
// same accepted risk class as bump / checklist-runs). GET returns the
// store's active batches plus the brand thresholds so the display can
// derive cooking / carve-window state locally and tick countdowns
// client-side. POST is an action switch:
//   { action: 'in',      store_id, qty, device_id }   → new batch
//   { action: 'pulled',  store_id, batch_id }         → oven → warmer
//   { action: 'resolve', store_id, batch_id,
//     resolution: 'used' | 'shredded' }               → terminal
//   { action: 'undo',    store_id, batch_id }         → delete mis-log
// Conflicting taps (two tablets, double-taps) come back as 409.

function limit(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  return rateLimitResponse(rl);
}

export async function GET(request) {
  const rlRes = limit(request);
  if (rlRes) return rlRes;

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get('store') || 'hollywood';
  // ?days_ago=N → audit view: every batch put in the oven that LA day
  // (admin Shift Summary). Without it: active + resolved-today.
  const daysAgoRaw = searchParams.get('days_ago');
  const daysAgo = daysAgoRaw != null && /^\d+$/.test(daysAgoRaw) ? parseInt(daysAgoRaw, 10) : null;

  const [{ data: batches, error }, cfgRes] = await Promise.all([
    getBirdBatches(storeId, { daysAgo }),
    getConfig(storeId),
  ]);
  if (error) {
    console.error('Failed to load bird batches:', error);
    return NextResponse.json({ error: 'Failed to load bird log' }, { status: 500 });
  }
  const ht = cfgRes?.data?.hold_times || {};
  return NextResponse.json({
    store_id: storeId,
    cook_minutes: ht.bird_cook_minutes ?? 32,
    carve_window_minutes: ht.bird_carve_window_minutes ?? 40,
    batches,
  });
}

export async function POST(request) {
  const rlRes = limit(request);
  if (rlRes) return rlRes;

  // Writes the bird log the whole line cooks against.
  const { error: authError } = await requireDevice(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action, store_id: storeId, batch_id: batchId, qty, resolution, device_id: deviceId } = body;
    if (!storeId || !action) {
      return NextResponse.json({ error: 'store_id and action are required' }, { status: 400 });
    }

    let result;
    if (action === 'in') {
      result = await addBirdBatch({ storeId, qty, deviceId });
    } else if (action === 'pulled') {
      if (!batchId) return NextResponse.json({ error: 'batch_id is required' }, { status: 400 });
      result = await markBirdBatchPulled({ storeId, batchId });
    } else if (action === 'resolve') {
      if (!batchId) return NextResponse.json({ error: 'batch_id is required' }, { status: 400 });
      result = await resolveBirdBatch({ storeId, batchId, resolution });
    } else if (action === 'undo') {
      if (!batchId) return NextResponse.json({ error: 'batch_id is required' }, { status: 400 });
      result = await undoBirdBatch({ storeId, batchId });
    } else {
      return NextResponse.json({ error: `Unknown action '${action}'` }, { status: 400 });
    }

    if (result.error) {
      if (result.error.code === 'conflict') return NextResponse.json({ error: result.error.message }, { status: 409 });
      if (result.error.code === 'bad_qty' || result.error.code === 'bad_resolution') {
        return NextResponse.json({ error: result.error.message }, { status: 400 });
      }
      console.error('Bird log action failed:', result.error);
      return NextResponse.json({ error: 'Bird log action failed' }, { status: 500 });
    }
    return NextResponse.json({ status: 'ok', batch: result.data });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
