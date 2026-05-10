import { NextResponse } from 'next/server';
import { buildDailyRecap, getTicketTimePercentiles, getActiveOrders, getConfig, resolveStoreId } from '@/lib/line-coach';
import { requirePhone } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Phone companion data endpoint. Two modes:
//   GET /api/line-coach/phone/data         → brand overview (6 stores)
//   GET /api/line-coach/phone/data?store=X → per-store drill-in
//
// Auth: requirePhone (JWT in Authorization: Bearer OR ?t=<jwt>).
// Tokens are minted by the admin via /api/line-coach/phone-token.
//
// Reuses the same buildDailyRecap + getTicketTimePercentiles helpers
// the recap cron and admin Analytics tab use, so numbers always
// match across surfaces.

const STORES = [
  'culver-city',
  '3rd-la-brea',
  'hollywood',
  'westwood',
  'dtla',
  'el-segundo',
];

const STORE_DISPLAY = {
  hollywood: 'Hollywood',
  dtla: 'DTLA',
  westwood: 'Westwood',
  'culver-city': 'Culver City',
  '3rd-la-brea': '3rd & La Brea',
  'el-segundo': 'El Segundo',
};

function avgPoints(points, key) {
  const vals = (points || []).map((p) => p?.[key]).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

function severityFor(p90Sec, slaTargetSec, slaBreachSec) {
  if (!Number.isFinite(p90Sec)) return -1;
  if (p90Sec >= slaBreachSec) return 2;
  if (p90Sec >= slaTargetSec) return 1;
  return 0;
}

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requirePhone(request);
  if (authResult instanceof Response) return authResult;

  // Brand-wide thresholds — same source the display + hub use, so all
  // three surfaces show the same numbers.
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

  const url = new URL(request.url);
  const storeParam = url.searchParams.get('store');

  // ── Drill-in mode ────────────────────────────────────────
  if (storeParam) {
    if (!STORES.includes(storeParam)) {
      return NextResponse.json({ error: 'unknown store' }, { status: 400 });
    }
    const [todayRes, trail, activeRes] = await Promise.all([
      buildDailyRecap({ storeId: storeParam, slaBreachMin, cleanupCutoffMinutes, daysAgo: 0 }),
      getTicketTimePercentiles({ storeId: storeParam, days: 7, cleanupCutoffMinutes }),
      getActiveOrders(storeParam),
    ]);

    const today = todayRes.data || null;
    const activeRows = (activeRes.data || []);
    // "Active right now" — only orders within the cleanup cutoff,
    // matching what the kitchen display actually shows.
    const cutoffTs = Date.now() - cleanupCutoffMinutes * 60_000;
    const activeFresh = activeRows.filter((o) => {
      const t = new Date(o.toast_created_at || o.fire_at || o.created_at).getTime();
      return Number.isFinite(t) && t >= cutoffTs;
    });
    // Last 5 min: orders bumped recently. activeRows excludes bumped
    // by definition (lc_active_orders view filters status='active'),
    // so we'd need a separate query — for v1 we just summarize the
    // active queue. Recent-bumped feed can be a follow-up.

    return NextResponse.json({
      mode: 'store',
      store_id: storeParam,
      store_name: STORE_DISPLAY[storeParam] || storeParam,
      sla_target_minutes: slaTargetMin,
      sla_breach_minutes: slaBreachMin,
      max_ticket_minutes: cleanupCutoffMinutes,
      today,
      trailing_7d: trail.data || [],
      active_now: activeFresh.length,
      // Severity for the badge / glow on the drill-in header.
      breach_severity: severityFor(today?.p90_seconds, slaTargetSec, slaBreachSec),
      ran_at: new Date().toISOString(),
    });
  }

  // ── Brand overview mode ──────────────────────────────────
  const stores = await Promise.all(STORES.map(async (storeId) => {
    try {
      const [todayRes, trail, activeRes] = await Promise.all([
        buildDailyRecap({ storeId, slaBreachMin, cleanupCutoffMinutes, daysAgo: 0 }),
        getTicketTimePercentiles({ storeId, days: 7, cleanupCutoffMinutes }),
        getActiveOrders(storeId),
      ]);
      const today = todayRes.data;
      const trailing_7d_p90 = avgPoints(trail.data, 'p90');
      const cutoffTs = Date.now() - cleanupCutoffMinutes * 60_000;
      const activeFresh = (activeRes.data || []).filter((o) => {
        const t = new Date(o.toast_created_at || o.fire_at || o.created_at).getTime();
        return Number.isFinite(t) && t >= cutoffTs;
      });
      return {
        store_id: storeId,
        store_name: STORE_DISPLAY[storeId] || storeId,
        tickets: today?.tickets ?? 0,
        avg_seconds: today?.avg_seconds ?? null,
        p90_seconds: today?.p90_seconds ?? null,
        over_sla: today?.over_sla ?? 0,
        over_sla_pct: today?.over_sla_pct ?? 0,
        cleanup_bumped: today?.cleanup_bumped ?? 0,
        trailing_7d_p90,
        active_now: activeFresh.length,
        anomaly_count: (today?.anomalies?.length) ?? 0,
        breach_severity: severityFor(today?.p90_seconds, slaTargetSec, slaBreachSec),
      };
    } catch (err) {
      return { store_id: storeId, store_name: STORE_DISPLAY[storeId] || storeId, error: err.message };
    }
  }));

  // Worst-first sort, same as the hub's TodayPerformance panel.
  stores.sort((a, b) => {
    const sa = a.breach_severity ?? -1;
    const sb = b.breach_severity ?? -1;
    if (sa !== sb) return sb - sa;
    return (b.p90_seconds ?? 0) - (a.p90_seconds ?? 0);
  });

  return NextResponse.json({
    mode: 'brand',
    sla_target_minutes: slaTargetMin,
    sla_breach_minutes: slaBreachMin,
    max_ticket_minutes: cleanupCutoffMinutes,
    stores,
    ran_at: new Date().toISOString(),
  });
}
