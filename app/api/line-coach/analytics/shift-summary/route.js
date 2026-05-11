import { NextResponse } from 'next/server';
import { buildDailyRecap, listWebhookLogs, getConfig, resolveStoreId } from '@/lib/line-coach';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Shift Summary endpoint — powers the admin's "Shift Summary" tab.
// Picks an arbitrary date in the past and returns a single payload
// combining yesterday's-recap-style vitals + that day's webhook log
// for one store.
//
// Auth: requireAdmin (same gate as the rest of the analytics surface).
//
// Two-helper wrap:
//   buildDailyRecap({ storeId, daysAgo }) — ticket count, avg, p90,
//     top_sides, top_entrees, per_side_analysis, anomalies. Already
//     supports arbitrary daysAgo from the hub scoreboard work.
//   listWebhookLogs({ storeId, sinceHours }) — webhook event log,
//     filtered to one store + a time window. Note: sinceHours is
//     measured from NOW, so older days will return an empty log.
//     We pass through anyway and let the UI gate the section.

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const storeId = url.searchParams.get('store');
  if (!storeId) {
    return NextResponse.json({ error: 'store required' }, { status: 400 });
  }
  const rawDaysAgo = parseInt(url.searchParams.get('days_ago') || '1', 10);
  // Clamp to [0, 90]. 0 = today so far, 90 = oldest interesting; the
  // archive cron removes older rows so anything beyond would render
  // empty anyway.
  const daysAgo = Math.min(90, Math.max(0, Number.isFinite(rawDaysAgo) ? rawDaysAgo : 1));

  // Pull SLA + cleanup thresholds from brand config so the recap
  // computes against the same values the display + hub use.
  let slaBreachMin = 10;
  let cleanupCutoffMinutes = 12;
  try {
    const { data: cfg } = await getConfig(resolveStoreId('default'));
    slaBreachMin = cfg?.hold_times?.sla_breach_minutes ?? 10;
    cleanupCutoffMinutes = cfg?.hold_times?.max_ticket_minutes ?? 12;
  } catch { /* fall through to defaults */ }

  // Webhook log is bounded by sinceHours from now, NOT from the picked
  // day. For daysAgo=0 (today) → last 24h is exactly the picked day.
  // For daysAgo=1 (yesterday) → last 48h gives us the picked day plus
  // today (UI filters server-side... actually we just send the slice
  // and let the UI hide non-matching rows). For older days, the
  // bounded window returns nothing — UI gates the log section
  // accordingly.
  const logSinceHours = (daysAgo + 1) * 24;
  const logCapped = Math.min(logSinceHours, 30 * 24); // hard cap at 30 days

  const [recapRes, logRes] = await Promise.all([
    buildDailyRecap({ storeId, slaBreachMin, cleanupCutoffMinutes, daysAgo }),
    daysAgo <= 30
      ? listWebhookLogs({ storeId, sinceHours: logCapped, limit: 500 })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (recapRes.error) {
    console.error('shift-summary recap error:', recapRes.error);
    return NextResponse.json({ error: 'Failed to build recap' }, { status: 500 });
  }

  return NextResponse.json({
    store_id: storeId,
    days_ago: daysAgo,
    sla_breach_minutes: slaBreachMin,
    max_ticket_minutes: cleanupCutoffMinutes,
    recap: recapRes.data,
    webhook_log: logRes?.data || [],
    webhook_log_available: daysAgo <= 30,
    ran_at: new Date().toISOString(),
  });
}
