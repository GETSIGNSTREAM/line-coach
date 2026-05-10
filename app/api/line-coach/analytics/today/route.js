import { NextResponse } from 'next/server';
import { buildDailyRecap, getTicketTimePercentiles, getConfig, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Brand-wide "today so far" stats used by the hub's TodayPerformance
// panel + the phone companion's brand overview. Loops the 6 stores
// in parallel, returns one row per store with today's tickets, avg,
// p90, over-SLA %, plus a trailing-7-day p90 baseline so the hub can
// render trend arrows.
//
// Auth: rate-limited but otherwise open, mirroring /api/line-coach/orders.
// The hub and phone companion both surface the same numbers; gating
// would just be busywork since the data is already on the hub today.

const STORES = [
  'culver-city',
  '3rd-la-brea',
  'hollywood',
  'westwood',
  'dtla',
  'el-segundo',
];

// Average a list of percentile points, ignoring null entries.
function avgPoints(points, key) {
  const vals = (points || []).map((p) => p?.[key]).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

// Severity score drives the "worst-first" sort in the hub. 2 if today's
// p90 has crossed the brand-promise red line, 1 if it's into the amber
// band, 0 otherwise. Stores with zero tickets sort to the bottom.
function severityFor(p90Sec, slaTargetSec, slaBreachSec) {
  if (!Number.isFinite(p90Sec)) return -1;
  if (p90Sec >= slaBreachSec) return 2;
  if (p90Sec >= slaTargetSec) return 1;
  return 0;
}

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'device');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  // Brand-wide config for SLA thresholds — same source the display uses.
  let slaTargetMin = 8;
  let slaBreachMin = 10;
  let cleanupCutoffMinutes = 12;
  try {
    const { data: cfg } = await getConfig(resolveStoreId('default'));
    slaTargetMin = cfg?.hold_times?.sla_target_minutes ?? 8;
    slaBreachMin = cfg?.hold_times?.sla_breach_minutes ?? 10;
    cleanupCutoffMinutes = cfg?.hold_times?.max_ticket_minutes ?? 12;
  } catch { /* fall back to defaults */ }

  const slaTargetSec = slaTargetMin * 60;
  const slaBreachSec = slaBreachMin * 60;

  const results = await Promise.all(STORES.map(async (storeId) => {
    try {
      const [todayRes, trail] = await Promise.all([
        buildDailyRecap({ storeId, slaBreachMin, cleanupCutoffMinutes, daysAgo: 0 }),
        getTicketTimePercentiles({ storeId, days: 7, cleanupCutoffMinutes }),
      ]);
      const today = todayRes.data;
      const trailing_7d_p90 = avgPoints(trail.data, 'p90');
      return {
        store_id: storeId,
        tickets: today?.tickets ?? 0,
        avg_seconds: today?.avg_seconds ?? null,
        p90_seconds: today?.p90_seconds ?? null,
        over_sla: today?.over_sla ?? 0,
        over_sla_pct: today?.over_sla_pct ?? 0,
        cleanup_bumped: today?.cleanup_bumped ?? 0,
        trailing_7d_p90,
        // delta vs trailing avg in seconds; positive = slower today
        p90_delta_seconds: (today?.p90_seconds != null && trailing_7d_p90 != null)
          ? today.p90_seconds - trailing_7d_p90
          : null,
        breach_severity: severityFor(today?.p90_seconds, slaTargetSec, slaBreachSec),
      };
    } catch (err) {
      return { store_id: storeId, error: err.message };
    }
  }));

  // Sort worst-first: highest severity first, then highest p90 within
  // the same band. Stores with no data (severity = -1) drift to bottom.
  results.sort((a, b) => {
    const sa = a.breach_severity ?? -1;
    const sb = b.breach_severity ?? -1;
    if (sa !== sb) return sb - sa;
    return (b.p90_seconds ?? 0) - (a.p90_seconds ?? 0);
  });

  return NextResponse.json({
    sla_target_minutes: slaTargetMin,
    sla_breach_minutes: slaBreachMin,
    max_ticket_minutes: cleanupCutoffMinutes,
    stores: results,
    ran_at: new Date().toISOString(),
  });
}
