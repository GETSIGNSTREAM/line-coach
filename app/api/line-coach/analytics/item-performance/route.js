import { NextResponse } from 'next/server';
import { getItemTimePercentiles, getConfig, resolveStoreId } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Menu-item performance endpoint — powers the admin's "Item
// Performance" tab. Returns per-canonical-item p50/p90/p99 of
// ticket-time-when-this-item-is-present over a configurable window.
// Filters optionally to one store; empty = brand-wide.
//
// Auth: requireAdmin.
//
// Times shown are whole-ticket times, attributed to every item on
// the ticket. The UI surfaces this caveat ("ticket time when this
// item is present") so a 7-min p90 on Quarter Bird doesn't get
// misread as "the bird took 7 min to plate."

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const storeId = url.searchParams.get('store') || null;
  const rawDays = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(rawDays) ? rawDays : 30));

  // Pull cleanup cutoff from brand config so exclusion stays in
  // lockstep with the rest of the analytics surface.
  let cleanupCutoffMinutes = 12;
  try {
    const { data: cfg } = await getConfig(resolveStoreId('default'));
    cleanupCutoffMinutes = cfg?.hold_times?.max_ticket_minutes ?? 12;
  } catch { /* fall through */ }

  const { data, error } = await getItemTimePercentiles({ storeId, days, cleanupCutoffMinutes });
  if (error) {
    console.error('item-performance error:', error);
    return NextResponse.json({ error: 'Failed to compute item performance' }, { status: 500 });
  }

  return NextResponse.json({
    store_id: storeId,
    days,
    items: data || [],
    ran_at: new Date().toISOString(),
  });
}
