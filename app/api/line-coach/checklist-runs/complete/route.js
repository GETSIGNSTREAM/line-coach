import { NextResponse } from 'next/server';
import { completeChecklistRun } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Sign-off endpoint. Every template item must already be checked
// (409 with the missing ids otherwise), and a run can only be signed
// once (conditional update — the loser of a two-tablet race gets a
// clean 409, never an overwrite). Initials are asserted, not
// authenticated — kiosks have no user accounts.

const INITIALS_RE = /^[A-Za-z]{2,3}$/;

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  try {
    const body = await request.json();
    const { store_id: storeId, checklist_id: checklistId, initials } = body;
    if (!storeId || !checklistId) {
      return NextResponse.json({ error: 'store_id and checklist_id are required' }, { status: 400 });
    }
    if (typeof initials !== 'string' || !INITIALS_RE.test(initials.trim())) {
      return NextResponse.json({ error: 'initials must be 2-3 letters' }, { status: 400 });
    }

    const { data, error } = await completeChecklistRun({
      storeId,
      checklistId,
      initials: initials.trim().toUpperCase(),
    });
    if (error) {
      if (error.code === 'not_found') return NextResponse.json({ error: error.message }, { status: 404 });
      if (error.code === 'completed') return NextResponse.json({ error: error.message }, { status: 409 });
      if (error.code === 'incomplete') {
        return NextResponse.json({ error: error.message, missing: error.missing }, { status: 409 });
      }
      console.error('Failed to complete checklist run:', error);
      return NextResponse.json({ error: 'Failed to complete checklist' }, { status: 500 });
    }

    return NextResponse.json({
      status: 'completed',
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
