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

export default function LineCoachHub() {
  const [storeCounts, setStoreCounts] = useState({});
  const [now, setNow] = useState(new Date());
  // The hub must filter the same way the display does, otherwise the
  // numbers shown here will not match what cooks see in the kitchen
  // (Toast leaves orders in 'active' status indefinitely for many flows;
  // the display hides anything older than max_ticket_minutes). Pull the
  // brand-wide threshold from any store's config — it's brand-scoped.
  const [maxTicketMin, setMaxTicketMin] = useState(60);

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

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>WILDBIRD LINE COACH</div>
          <div style={s.subtitle}>All Locations</div>
        </div>
        <div style={s.headerRight}>
          <a href="/?simulator" style={s.linkBtn}>Simulator</a>
          <span style={s.clock}>{now.toLocaleTimeString()}</span>
        </div>
      </div>

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
        <span style={s.quickLinksLabel}>Quick Links</span>
        {STORES.map((store) => (
          <a key={store.slug} href={`/?admin&store=${store.slug}`} style={s.adminLink}>
            {store.name} Admin
          </a>
        ))}
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
