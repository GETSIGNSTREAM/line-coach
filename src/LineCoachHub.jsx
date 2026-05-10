'use client';

import { useState, useEffect } from 'react';

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  cream: '#E8DCC8',
  green: '#6FCF97',
  red: '#D64545',
};

const STORES = [
  { slug: 'culver-city', name: 'Culver City' },
  { slug: '3rd-la-brea', name: '3rd & La Brea' },
  { slug: 'hollywood', name: 'Hollywood' },
  { slug: 'westwood', name: 'Westwood (UCLA)' },
  { slug: 'dtla', name: 'DTLA' },
  { slug: 'el-segundo', name: 'El Segundo' },
];

// ── TodayPerformance panel ───────────────────────────────
//
// Brand-wide live SLA scoreboard. One row per store, sorted by the
// today endpoint (worst-first). Each row shows tickets-so-far, avg,
// p90, over-SLA pct, and a horizontal bar that maps today's p90
// against the brand-promise bands (8-min target / 10-min breach /
// 12-min cleanup wall). The bar is the at-a-glance signal — a
// regional manager can scan from across the room and spot which
// kitchen is drifting without reading any number.

const SEVERITY_COLOR = {
  2: BRAND.red,
  1: '#F2C94C', // amber
  0: BRAND.green,
};

function fmtSec(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function TodayPerformance({ today, stores }) {
  const slaTargetMin = today.sla_target_minutes ?? 8;
  const slaBreachMin = today.sla_breach_minutes ?? 10;
  const cleanupMin = today.max_ticket_minutes ?? 12;
  // Bar scale — we only need the 0..cleanup range to render legibly.
  // Anything past cleanup (cron-swept territory) just pegs the bar.
  const barMaxSec = cleanupMin * 60;
  const slugToName = Object.fromEntries(stores.map((s) => [s.slug, s.name]));

  return (
    <div style={hubStyles.todayPanel}>
      <div style={hubStyles.todayHeader}>
        <div style={hubStyles.todayLabel}>Today · Brand-Promise Scoreboard</div>
        <div style={hubStyles.todayLegend}>
          <span style={{ color: BRAND.green }}>● ≤ {slaTargetMin}m target</span>
          <span style={{ color: '#F2C94C' }}>● amber</span>
          <span style={{ color: BRAND.red }}>● ≥ {slaBreachMin}m breach</span>
        </div>
      </div>
      <div style={hubStyles.todayRows}>
        {today.stores.map((row) => {
          const sev = row.breach_severity ?? -1;
          const color = SEVERITY_COLOR[sev] ?? BRAND.cream;
          const isBreaching = sev === 2;
          const fillPct = row.p90_seconds != null
            ? Math.min(100, (row.p90_seconds / barMaxSec) * 100)
            : 0;
          const targetPct = (slaTargetMin / cleanupMin) * 100;
          const breachPct = (slaBreachMin / cleanupMin) * 100;
          const overSlaWarn = row.over_sla_pct > 5;
          const deltaSec = row.p90_delta_seconds;
          const trendArrow = deltaSec == null
            ? null
            : deltaSec >= 30 ? '↑' : deltaSec <= -30 ? '↓' : '·';
          const trendColor = deltaSec == null
            ? `${BRAND.cream}60`
            : deltaSec >= 30 ? BRAND.red
            : deltaSec <= -30 ? BRAND.green
            : `${BRAND.cream}80`;
          return (
            <a
              key={row.store_id}
              href={`/?store=${row.store_id}`}
              target="_blank"
              rel="noopener"
              style={{
                ...hubStyles.todayRow,
                ...(isBreaching ? hubStyles.todayRowBreaching : {}),
              }}
            >
              <div style={hubStyles.todayRowName}>
                {slugToName[row.store_id] || row.store_id}
              </div>
              <div style={hubStyles.todayRowStats}>
                <div style={hubStyles.todayStat}>
                  <span style={hubStyles.todayStatLabel}>Tickets</span>
                  <span style={hubStyles.todayStatValue}>{row.tickets ?? 0}</span>
                </div>
                <div style={hubStyles.todayStat}>
                  <span style={hubStyles.todayStatLabel}>Avg</span>
                  <span style={{ ...hubStyles.todayStatValue, color }}>{fmtSec(row.avg_seconds)}</span>
                </div>
                <div style={hubStyles.todayStat}>
                  <span style={hubStyles.todayStatLabel}>p90</span>
                  <span style={{ ...hubStyles.todayStatValue, color }}>{fmtSec(row.p90_seconds)}</span>
                  {trendArrow && (
                    <span style={{ marginLeft: '4px', color: trendColor, fontSize: '0.85rem' }}>
                      {trendArrow}
                    </span>
                  )}
                </div>
                <div style={hubStyles.todayStat}>
                  <span style={hubStyles.todayStatLabel}>Over-SLA</span>
                  <span style={{
                    ...hubStyles.todayStatValue,
                    color: overSlaWarn ? BRAND.red : BRAND.cream,
                  }}>
                    {row.over_sla ?? 0} ({(row.over_sla_pct ?? 0).toFixed(1)}%)
                    {overSlaWarn ? ' ⚠️' : ''}
                  </span>
                </div>
              </div>
              <div style={hubStyles.todayBarTrack}>
                {/* SLA reference markers */}
                <div style={{ ...hubStyles.todayBarMarker, left: `${targetPct}%`, background: '#F2C94C' }} />
                <div style={{ ...hubStyles.todayBarMarker, left: `${breachPct}%`, background: BRAND.red }} />
                {/* Fill */}
                <div style={{
                  ...hubStyles.todayBarFill,
                  width: `${fillPct}%`,
                  background: color,
                  opacity: row.tickets > 0 ? 0.85 : 0.25,
                }} />
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default function LineCoachHub() {
  const [storeCounts, setStoreCounts] = useState({});
  const [now, setNow] = useState(new Date());
  // The hub must filter the same way the display does, otherwise the
  // numbers shown here will not match what cooks see in the kitchen
  // (Toast leaves orders in 'active' status indefinitely for many flows;
  // the display hides anything older than max_ticket_minutes). Pull the
  // brand-wide threshold from any store's config — it's brand-scoped.
  const [maxTicketMin, setMaxTicketMin] = useState(60);
  // Today's brand-wide performance — sorted worst-first so the kitchen
  // needing attention is at the top of the panel. Refreshed every 60s
  // (slower than the order-count poll above; SLA stats don't move that
  // fast and an unnecessary recompute taxes the analytics path).
  const [today, setToday] = useState(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    async function fetchThreshold() {
      try {
        const res = await fetch(`/api/line-coach/config?store=${STORES[0].slug}`);
        const data = await res.json();
        const m = data?.hold_times?.max_ticket_minutes;
        if (Number.isFinite(m) && m > 0) setMaxTicketMin(m);
      } catch { /* keep default */ }
    }
    fetchThreshold();
  }, []);

  useEffect(() => {
    async function fetchCounts() {
      const cutoff = Date.now() - maxTicketMin * 60_000;
      const counts = {};
      for (const store of STORES) {
        try {
          const res = await fetch(`/api/line-coach/orders?store=${store.slug}`);
          const data = await res.json();
          // Mirror the display's stale-ticket filter so the number on
          // the hub card matches the number the cook sees on the
          // kitchen monitor. Anything older than maxTicketMin is
          // considered abandoned by Toast (no completed/voided event
          // ever arrived) and is hidden from cook-facing views.
          const fresh = (data.orders || []).filter((o) => {
            const t = new Date(o.toast_created_at || o.fire_at || o.created_at).getTime();
            if (!t || Number.isNaN(t)) return true;
            return t >= cutoff;
          });
          counts[store.slug] = fresh.length;
        } catch {
          counts[store.slug] = null;
        }
      }
      setStoreCounts(counts);
    }
    fetchCounts();
    const interval = setInterval(fetchCounts, 30_000);
    return () => clearInterval(interval);
  }, [maxTicketMin]);

  useEffect(() => {
    async function fetchToday() {
      try {
        const res = await fetch('/api/line-coach/analytics/today');
        if (!res.ok) return;
        const data = await res.json();
        setToday(data);
      } catch { /* keep last good value */ }
    }
    fetchToday();
    const interval = setInterval(fetchToday, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Brand logo + product subtitle. onError falls back to text. */}
          <img
            src="/WILDBIRD-LOGO-WHITE.png"
            alt="WILDBIRD"
            style={{ height: '44px', width: 'auto', display: 'block' }}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              const fallback = e.currentTarget.nextElementSibling;
              if (fallback) fallback.style.display = '';
            }}
          />
          <div style={{ display: 'none' }}>
            <div style={s.title}>WILDBIRD LINE COACH</div>
          </div>
          <div style={s.subtitle}>All Locations</div>
        </div>
        <div style={s.headerRight}>
          <a href="/?simulator" style={s.linkBtn}>Simulator</a>
          <span style={s.clock}>{now.toLocaleTimeString()}</span>
        </div>
      </div>

      {today && today.stores && today.stores.length > 0 && (
        <TodayPerformance today={today} stores={STORES} />
      )}

      <div style={s.grid}>
        {STORES.map((store) => {
          const count = storeCounts[store.slug];
          const isActive = count !== null && count > 0;

          return (
            <a
              key={store.slug}
              href={`/?store=${store.slug}`}
              style={s.card}
              target="_blank"
              rel="noopener"
            >
              <div style={s.cardTop}>
                <div style={s.storeName}>{store.name}</div>
                <div style={{
                  ...s.statusDot,
                  background: count === null ? BRAND.charcoalLight : isActive ? BRAND.green : BRAND.cream + '40',
                }} />
              </div>

              <div style={{
                ...s.orderCount,
                color: isActive ? BRAND.gold : BRAND.cream + '60',
              }}>
                {count === null ? '—' : count}
              </div>
              <div style={s.orderLabel}>
                {count === 1 ? 'active order' : 'active orders'}
              </div>

              <div style={s.cardFooter}>
                <span style={s.viewLink}>View Display →</span>
              </div>
            </a>
          );
        })}
      </div>

      <div style={s.quickLinks}>
        {/* Single brand-wide admin link — Line Coach configuration is
            brand-scoped (menu, sides, tips, hold times) so a single
            entry point covers most editing. The admin's in-app store
            picker handles per-store data (Settings, Devices,
            Analytics) once the user is in. */}
        <a href="/?admin" style={s.adminLink}>Admin</a>
        <a href="/?simulator" style={s.adminLink}>Simulator</a>
      </div>
    </div>
  );
}

const s = {
  container: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    padding: '24px',
    fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: `2px solid ${BRAND.gold}`,
    paddingBottom: '16px',
    marginBottom: '32px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  title: {
    fontSize: '1.8rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
  },
  subtitle: {
    fontSize: '1rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
    marginTop: '2px',
  },
  clock: {
    fontSize: '1.1rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
  },
  linkBtn: {
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    border: `1px solid ${BRAND.cream}30`,
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    textDecoration: 'none',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '20px',
    marginBottom: '40px',
  },
  card: {
    background: BRAND.charcoalDark,
    borderRadius: '12px',
    padding: '24px',
    textDecoration: 'none',
    color: BRAND.bone,
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 0.15s, border-color 0.15s',
    border: `1px solid ${BRAND.charcoalLight}`,
    cursor: 'pointer',
  },
  cardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  storeName: {
    fontSize: '1.3rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  statusDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
  },
  orderCount: {
    fontSize: '4rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    lineHeight: 1,
  },
  orderLabel: {
    fontSize: '0.9rem',
    color: `${BRAND.cream}88`,
    marginTop: '4px',
  },
  cardFooter: {
    marginTop: 'auto',
    paddingTop: '16px',
    borderTop: `1px solid ${BRAND.charcoalLight}`,
  },
  viewLink: {
    fontSize: '0.9rem',
    color: BRAND.gold,
    fontWeight: 600,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
  },
  quickLinks: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    alignItems: 'center',
    padding: '16px 0',
    borderTop: `1px solid ${BRAND.charcoalLight}`,
  },
  quickLinksLabel: {
    fontSize: '0.85rem',
    color: BRAND.cream,
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
    marginRight: '8px',
  },
  adminLink: {
    fontSize: '0.85rem',
    color: BRAND.gold,
    textDecoration: 'none',
    padding: '4px 12px',
    borderRadius: '4px',
    background: `${BRAND.gold}10`,
    border: `1px solid ${BRAND.gold}30`,
  },
};

const hubStyles = {
  todayPanel: {
    background: BRAND.charcoalDark,
    borderRadius: '12px',
    padding: '20px 24px',
    marginBottom: '32px',
    border: `1px solid ${BRAND.charcoalLight}`,
  },
  todayHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '16px',
    flexWrap: 'wrap',
    gap: '12px',
  },
  todayLabel: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: '0.9rem',
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: BRAND.gold,
  },
  todayLegend: {
    display: 'flex',
    gap: '16px',
    fontSize: '0.75rem',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
  },
  todayRows: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  todayRow: {
    display: 'grid',
    gridTemplateColumns: '180px 1fr',
    gap: '16px',
    padding: '12px 14px',
    background: BRAND.charcoal,
    borderRadius: '8px',
    border: `1px solid ${BRAND.charcoalLight}`,
    textDecoration: 'none',
    color: BRAND.bone,
    transition: 'border-color 0.15s, background 0.15s',
    alignItems: 'center',
  },
  todayRowBreaching: {
    boxShadow: `inset 4px 0 0 ${BRAND.red}, 0 0 0 1px ${BRAND.red}55, 0 0 18px ${BRAND.red}30`,
  },
  todayRowName: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    fontSize: '1.1rem',
    letterSpacing: '1px',
    textTransform: 'uppercase',
    color: BRAND.bone,
  },
  todayRowStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '12px',
    alignItems: 'baseline',
    marginBottom: '6px',
    gridColumn: 2,
  },
  todayStat: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  todayStatLabel: {
    fontSize: '0.7rem',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: `${BRAND.cream}80`,
  },
  todayStatValue: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    fontSize: '1.05rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
  },
  todayBarTrack: {
    gridColumn: 2,
    position: 'relative',
    height: '6px',
    background: `${BRAND.cream}15`,
    borderRadius: '3px',
    overflow: 'hidden',
  },
  todayBarFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    borderRadius: '3px',
    transition: 'width 600ms ease-out, background 600ms ease-out',
  },
  todayBarMarker: {
    position: 'absolute',
    top: 0,
    height: '100%',
    width: '2px',
    opacity: 0.6,
  },
};
