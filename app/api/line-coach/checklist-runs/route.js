import { NextResponse } from 'next/server';
import { getChecklistRuns, toggleChecklistItem } from '@/lib/line-coach';
import { requireDevice } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Kiosk-facing checklist endpoint — unauthenticated + device rate
// limit, same accepted risk class as bump/unbump (wall displays have
// no JWT). GET returns brand templates merged with today's per-store
// runs so displays never depend on the hourly config poll for
// checklist content. POST toggles a single item atomically via the
// lc_toggle_checklist_item RPC; business_date is always recomputed
// server-side so kiosk clocks are never trusted.

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

  const { data, error } = await getChecklistRuns(storeId);
  if (error) {
    console.error('Failed to load checklist runs:', error);
    return NextResponse.json({ error: 'Failed to load checklists' }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(request) {
  const rlRes = limit(request);
  if (rlRes) return rlRes;

  const { error: authError } = await requireDevice(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { store_id: storeId, checklist_id: checklistId, item_id: itemId, checked, device_id: deviceId } = body;
    if (!storeId || !checklistId || !itemId || typeof checked !== 'boolean') {
      return NextResponse.json({ error: 'store_id, checklist_id, item_id, and checked (boolean) are required' }, { status: 400 });
    }

    const { data, error } = await toggleChecklistItem({ storeId, checklistId, itemId, checked, deviceId });
    if (error) {
      if (error.code === 'not_found') return NextResponse.json({ error: error.message }, { status: 404 });
      if (error.code === 'completed') return NextResponse.json({ error: error.message }, { status: 409 });
      console.error('Failed to toggle checklist item:', error);
      return NextResponse.json({ error: 'Failed to update checklist' }, { status: 500 });
    }

    return NextResponse.json({
      status: 'ok',
      business_date: data.business_date,
      run: {
        checked_items: data.checked_items || {},
        completed_at: data.completed_at,
        completed_by: data.completed_by,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
