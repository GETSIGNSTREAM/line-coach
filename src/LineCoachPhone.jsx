'use client';

import { useCallback, useEffect, useState } from 'react';

// Phone companion. Mobile-first dashboard for store managers.
// Reuses the kitchen display's WILDBIRD palette so a manager glancing
// from their phone to the wall display sees consistent colors.
//
// Two views in one component, toggled by URL hash:
//   /?phone&t=...           → brand overview (6 stores, sorted worst-first)
//   /?phone&t=...#hollywood → per-store drill-in (today + 7-day trend +
//                              demand anomalies + active queue size)
//
// Auth: token comes from the URL (?t=<jwt>) and rides along on every
// fetch. Tokens are minted by the admin (see /api/line-coach/phone-token)
// and last 180 days. If a token is missing or invalid the API returns
// 401; the page renders an "Ask your admin for a fresh link" message.
//
// Refresh: polls every 30s while visible, every 5 min while hidden
// (Page Visibility API). Pull-to-refresh is the browser default and
// works fine — no need to reimplement.

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  cream: '#E8DCC8',
  green: '#6FCF97',
  red: '#D64545',
  yellow: '#F2C94C',
};

const SEVERITY_COLOR = {
  2: BRAND.red,
  1: BRAND.yellow,
  0: BRAND.green,
};

function fmtSec(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export default function LineCoachPhone({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Hash-based routing: '' = brand view, '#hollywood' = drill into hollywood.
  const [storeSlug, setStoreSlug] = useState(() => {
    if (typeof window === 'undefined') return null;
    return window.location.hash.replace(/^#/, '') || null;
  });

  // Track hash changes (back button, copy/paste link with hash, etc).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => {
      setStoreSlug(window.location.hash.replace(/^#/, '') || null);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const fetchData = useCallback(async () => {
    if (!token) {
      setError('No token');
      setLoading(false);
      return;
    }
    try {
      const url = storeSlug
        ? `/api/line-coach/phone/data?store=${encodeURIComponent(storeSlug)}&t=${encodeURIComponent(token)}`
        : `/api/line-coach/phone/data?t=${encodeURIComponent(token)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setError('Link expired or invalid. Ask your admin for a fresh share link.');
        setData(null);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`Server error (${res.status})`);
        setLoading(false);
        return;
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(`Network error: ${e.message}`);
    }
    setLoading(false);
  }, [token, storeSlug]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Polling: 30s when visible, 5 min when hidden. Avoids beating up
  // the API when a manager pockets their phone for an hour.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let timer = null;
    const tick = () => fetchData();
    const start = () => {
      const ms = document.hidden ? 5 * 60_000 : 30_000;
      timer = setInterval(tick, ms);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { stop(); start(); };
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => { document.removeEventListener('visibilitychange', onVis); stop(); };
  }, [fetchData]);

  if (!token) {
    return <ErrorView message="No share token in URL. Ask your admin for a fresh link." />;
  }
  if (error) {
    return <ErrorView message={error} />;
  }
  if (loading || !data) {
    return <LoadingView />;
  }

  if (data.mode === 'store') {
    return <StoreView data={data} onBack={() => { window.location.hash = ''; }} />;
  }
  return <BrandView data={data} onPickStore={(slug) => { window.location.hash = slug; }} />;
}

// ── Brand overview ──────────────────────────────────────────

function BrandView({ data, onPickStore }) {
  const slaTargetMin = data.sla_target_minutes ?? 8;
  const slaBreachMin = data.sla_breach_minutes ?? 10;
  return (
    <div style={s.page}>
      <Header title="Today" subtitle={`${data.stores.length} stores · sorted worst-first`} />
      <div style={s.legend}>
        <span style={{ color: BRAND.green }}>● ≤ {slaTargetMin}m</span>
        <span style={{ color: BRAND.yellow }}>● amber</span>
        <span style={{ color: BRAND.red }}>● ≥ {slaBreachMin}m breach</span>
      </div>
      <div style={s.storeList}>
        {data.stores.map((row) => (
          <StoreRow key={row.store_id} row={row} onPick={() => onPickStore(row.store_id)} />
        ))}
      </div>
      <Footer ranAt={data.ran_at} />
    </div>
  );
}

function StoreRow({ row, onPick }) {
  const sev = row.breach_severity ?? -1;
  const color = SEVERITY_COLOR[sev] ?? BRAND.cream;
  const isBreaching = sev === 2;
  const overSlaWarn = (row.over_sla_pct ?? 0) > 5;
  const anomalyCount = row.anomaly_count ?? 0;
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        ...s.storeRow,
        ...(isBreaching ? s.storeRowBreaching : {}),
      }}
    >
      <div style={s.storeRowHeader}>
        <div style={s.storeRowName}>{row.store_name}</div>
        <div style={{ ...s.statusDot, background: color }} />
      </div>
      <div style={s.storeRowStats}>
        <div style={s.stat}>
          <span style={s.statLabel}>Tickets</span>
          <span style={s.statValue}>{row.tickets ?? 0}</span>
        </div>
        <div style={s.stat}>
          <span style={s.statLabel}>Active</span>
          <span style={s.statValue}>{row.active_now ?? 0}</span>
        </div>
        <div style={s.stat}>
          <span style={s.statLabel}>Avg</span>
          <span style={{ ...s.statValue, color }}>{fmtSec(row.avg_seconds)}</span>
        </div>
        <div style={s.stat}>
          <span style={s.statLabel}>p90</span>
          <span style={{ ...s.statValue, color }}>{fmtSec(row.p90_seconds)}</span>
        </div>
      </div>
      {(overSlaWarn || anomalyCount > 0) && (
        <div style={s.storeRowFlags}>
          {overSlaWarn && (
            <span style={s.flagPill}>⚠️ {row.over_sla_pct.toFixed(1)}% over SLA</span>
          )}
          {anomalyCount > 0 && (
            <span style={s.flagPill}>⚠️ {anomalyCount} demand anomal{anomalyCount === 1 ? 'y' : 'ies'}</span>
          )}
        </div>
      )}
      <div style={s.tapHint}>Tap for details →</div>
    </button>
  );
}

// ── Per-store drill-in ──────────────────────────────────────

function StoreView({ data, onBack }) {
  const today = data.today || {};
  const sev = data.breach_severity ?? -1;
  const color = SEVERITY_COLOR[sev] ?? BRAND.cream;
  const trail = data.trailing_7d || [];
  const slaTargetMin = data.sla_target_minutes ?? 8;
  const slaBreachMin = data.sla_breach_minutes ?? 10;
  const cleanupMin = data.max_ticket_minutes ?? 12;
  return (
    <div style={s.page}>
      <Header
        title={data.store_name}
        subtitle={`Active right now: ${data.active_now ?? 0}`}
        onBack={onBack}
        accentColor={color}
      />
      <div style={s.section}>
        <div style={s.sectionLabel}>Today</div>
        <div style={s.todayGrid}>
          <Stat label="Tickets" value={today.tickets ?? 0} />
          <Stat label="Avg" value={fmtSec(today.avg_seconds)} color={color} />
          <Stat label="p90" value={fmtSec(today.p90_seconds)} color={color} />
          <Stat
            label="Over-SLA"
            value={`${today.over_sla ?? 0} (${(today.over_sla_pct ?? 0).toFixed(1)}%)`}
            color={(today.over_sla_pct ?? 0) > 5 ? BRAND.red : BRAND.cream}
          />
          {(today.cleanup_bumped ?? 0) > 0 && (
            <Stat
              label="Cleanup-bumped"
              value={today.cleanup_bumped}
              color={`${BRAND.cream}80`}
            />
          )}
        </div>
      </div>

      {trail.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>7-day trend (p90)</div>
          <TrendChart points={trail} slaTargetMin={slaTargetMin} slaBreachMin={slaBreachMin} cleanupMin={cleanupMin} />
        </div>
      )}

      {Array.isArray(today.anomalies) && today.anomalies.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>⚠️ Demand anomalies (vs 14-day avg)</div>
          <div style={s.anomalyList}>
            {today.anomalies.map((a) => (
              <div key={a.name} style={s.anomalyItem}>
                <div style={s.anomalyName}>{a.name}</div>
                <div style={s.anomalyDelta}>
                  {a.count} ordered · {a.pct_vs_avg != null ? `${a.pct_vs_avg}% of ${a.avg_14d} avg` : 'no baseline'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(today.top_sides) && today.top_sides.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>Top batches today</div>
          <div style={s.topList}>
            {today.top_sides.map((it) => (
              <div key={it.name} style={s.topRow}>
                <span>{it.name}</span>
                <span style={s.topCount}>× {it.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(today.top_entrees) && today.top_entrees.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>Top entrees today</div>
          <div style={s.topList}>
            {today.top_entrees.map((it) => (
              <div key={it.name} style={s.topRow}>
                <span>{it.name}</span>
                <span style={s.topCount}>× {it.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Footer ranAt={data.ran_at} />
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={s.stat}>
      <span style={s.statLabel}>{label}</span>
      <span style={{ ...s.statValue, ...(color ? { color } : {}) }}>{value}</span>
    </div>
  );
}

function TrendChart({ points, slaTargetMin, slaBreachMin, cleanupMin }) {
  const W = 600;
  const H = 140;
  const padL = 32, padR = 8, padT = 12, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const yMaxMin = Math.max(cleanupMin, ...points.map((p) => Math.ceil((p.p90 || 0) / 60)));
  const yScale = (sec) => padT + innerH - (sec / 60 / yMaxMin) * innerH;
  const xScale = (i) => points.length <= 1
    ? padL + innerW / 2
    : padL + (i / (points.length - 1)) * innerW;
  const path = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.p90 || 0).toFixed(1)}`
  ).join(' ');
  return (
    <div style={s.chartWrap}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* SLA reference lines */}
        <line
          x1={padL} y1={yScale(slaTargetMin * 60)}
          x2={W - padR} y2={yScale(slaTargetMin * 60)}
          stroke={BRAND.yellow} strokeWidth="1.5" strokeDasharray="4,4" opacity="0.6"
        />
        <line
          x1={padL} y1={yScale(slaBreachMin * 60)}
          x2={W - padR} y2={yScale(slaBreachMin * 60)}
          stroke={BRAND.red} strokeWidth="1.5" strokeDasharray="4,4" opacity="0.7"
        />
        {/* p90 line */}
        <path d={path} fill="none" stroke={BRAND.gold} strokeWidth="2" />
        {points.map((p, i) => (
          <g key={p.day}>
            <circle cx={xScale(i)} cy={yScale(p.p90 || 0)} r="3" fill={BRAND.gold} />
            <text x={xScale(i)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill={`${BRAND.cream}80`} fontFamily="monospace">
              {p.day.slice(5)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Chrome ──────────────────────────────────────────────────

function Header({ title, subtitle, onBack, accentColor }) {
  return (
    <div style={{
      ...s.header,
      ...(accentColor ? { borderBottomColor: accentColor } : {}),
    }}>
      {onBack && (
        <button type="button" onClick={onBack} style={s.backBtn} aria-label="Back">
          ←
        </button>
      )}
      <div style={s.headerText}>
        <div style={s.headerTitle}>{title}</div>
        {subtitle && <div style={s.headerSubtitle}>{subtitle}</div>}
      </div>
    </div>
  );
}

function Footer({ ranAt }) {
  const t = ranAt ? new Date(ranAt) : null;
  const txt = t ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <div style={s.footer}>
      Last updated {txt} · WILDBIRD Line Coach
    </div>
  );
}

function LoadingView() {
  return (
    <div style={{ ...s.page, justifyContent: 'center', alignItems: 'center', display: 'flex', minHeight: '100vh' }}>
      <div style={{ color: BRAND.cream, fontFamily: "'Oswald', sans-serif", letterSpacing: '2px' }}>
        LOADING…
      </div>
    </div>
  );
}

function ErrorView({ message }) {
  return (
    <div style={{ ...s.page, padding: '40px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: '2rem', marginBottom: '12px' }}>🔒</div>
      <div style={{ color: BRAND.bone, fontFamily: "'Oswald', sans-serif", letterSpacing: '1px', fontSize: '1.1rem', marginBottom: '8px' }}>
        Can&apos;t load
      </div>
      <div style={{ color: `${BRAND.cream}cc`, fontSize: '0.95rem', maxWidth: '320px', margin: '0 auto' }}>
        {message}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0) + 24px)',
  },
  header: {
    position: 'sticky',
    top: 0,
    background: BRAND.charcoalDark,
    borderBottom: `2px solid ${BRAND.gold}`,
    padding: 'calc(env(safe-area-inset-top, 0) + 12px) 16px 12px',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  backBtn: {
    background: 'transparent',
    border: 'none',
    color: BRAND.gold,
    fontSize: '1.6rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    cursor: 'pointer',
    padding: '0 4px',
    minWidth: '40px',
    minHeight: '40px',
  },
  headerText: { display: 'flex', flexDirection: 'column' },
  headerTitle: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: '1.3rem',
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: BRAND.bone,
  },
  headerSubtitle: {
    fontSize: '0.8rem',
    color: `${BRAND.cream}aa`,
    marginTop: '2px',
  },
  legend: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '12px 16px',
    fontSize: '0.7rem',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
  },
  storeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '0 16px',
  },
  storeRow: {
    width: '100%',
    background: BRAND.charcoalDark,
    border: `1px solid ${BRAND.charcoalLight}`,
    borderRadius: '12px',
    padding: '14px 16px',
    color: BRAND.bone,
    textAlign: 'left',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    fontFamily: 'inherit',
    minHeight: '88px',
  },
  storeRowBreaching: {
    boxShadow: `inset 4px 0 0 ${BRAND.red}, 0 0 0 1px ${BRAND.red}55, 0 0 18px ${BRAND.red}30`,
  },
  storeRowHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  storeRowName: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    fontSize: '1.1rem',
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  statusDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
  },
  storeRowStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '8px',
  },
  storeRowFlags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  flagPill: {
    background: `${BRAND.red}20`,
    color: BRAND.red,
    fontSize: '0.7rem',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '0.5px',
    padding: '4px 8px',
    borderRadius: '999px',
  },
  tapHint: {
    fontSize: '0.7rem',
    color: `${BRAND.cream}80`,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
    textAlign: 'right',
  },
  stat: { display: 'flex', flexDirection: 'column', gap: '2px' },
  statLabel: {
    fontSize: '0.65rem',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: `${BRAND.cream}80`,
  },
  statValue: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    fontSize: '1.05rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
  },
  section: {
    padding: '20px 16px 0',
  },
  sectionLabel: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: '0.8rem',
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: BRAND.gold,
    marginBottom: '10px',
  },
  todayGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
    background: BRAND.charcoalDark,
    border: `1px solid ${BRAND.charcoalLight}`,
    borderRadius: '12px',
    padding: '14px 16px',
  },
  chartWrap: {
    background: BRAND.charcoalDark,
    border: `1px solid ${BRAND.charcoalLight}`,
    borderRadius: '12px',
    padding: '12px',
  },
  anomalyList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  anomalyItem: {
    background: BRAND.charcoalDark,
    border: `1px solid ${BRAND.red}55`,
    borderLeft: `4px solid ${BRAND.red}`,
    borderRadius: '8px',
    padding: '10px 12px',
  },
  anomalyName: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    fontSize: '1rem',
    letterSpacing: '0.5px',
    color: BRAND.bone,
    marginBottom: '2px',
  },
  anomalyDelta: {
    fontSize: '0.85rem',
    color: `${BRAND.cream}cc`,
  },
  topList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    background: BRAND.charcoalDark,
    border: `1px solid ${BRAND.charcoalLight}`,
    borderRadius: '12px',
    padding: '12px 14px',
  },
  topRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.95rem',
    color: BRAND.cream,
  },
  topCount: {
    color: BRAND.gold,
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
  },
  footer: {
    padding: '24px 16px',
    textAlign: 'center',
    fontSize: '0.75rem',
    color: `${BRAND.cream}88`,
  },
};
