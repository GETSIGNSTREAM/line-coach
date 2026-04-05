'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// ── WILDBIRD Brand Colors ───────────────────────────────

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  white: '#FFFFFF',
  cream: '#E8DCC8',
  terracotta: '#C8654A',
  blue: '#4A7C8C',
  red: '#D64545',
  yellow: '#F2C94C',
  green: '#6FCF97',
  sage: '#A8B5A0',
};

// Side name → image filename mapping
function getSideImageUrl(name) {
  const slug = name.toLowerCase().replace(/[&]/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  return `/sides/${slug}.jpg`;
}

// ── Component ───────────────────────────────────────────

export default function LineCoachDisplay({ storeId }) {
  const [orders, setOrders] = useState([]);
  const [config, setConfig] = useState(null);
  const [now, setNow] = useState(new Date());
  const [qualityTipIndex, setQualityTipIndex] = useState(0);
  const supabaseRef = useRef(null);

  useEffect(() => {
    if (supabaseUrl && supabaseAnonKey) {
      supabaseRef.current = createClient(supabaseUrl, supabaseAnonKey);
    }
  }, []);

  useEffect(() => {
    fetch(`/api/line-coach/config?store=${storeId}`)
      .then((r) => r.json())
      .then(setConfig)
      .catch(console.error);
  }, [storeId]);

  const fetchOrders = useCallback(() => {
    fetch(`/api/line-coach/orders?store=${storeId}`)
      .then((r) => r.json())
      .then((data) => setOrders(data.orders || []))
      .catch(console.error);
  }, [storeId]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  useEffect(() => {
    const client = supabaseRef.current;
    if (!client) return;
    const channel = client
      .channel('lc-orders-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lc_orders', filter: `store_id=eq.${storeId}` }, () => fetchOrders())
      .subscribe();
    return () => { client.removeChannel(channel); };
  }, [storeId, fetchOrders]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const tipInterval = (config?.settings?.quality_coach_interval || 30) * 1000;
    const interval = setInterval(() => setQualityTipIndex((i) => i + 1), tipInterval);
    return () => clearInterval(interval);
  }, [config]);

  useEffect(() => {
    const deviceId = `display-${storeId}-${Math.random().toString(36).slice(2, 8)}`;
    const heartbeat = () => {
      fetch('/api/line-coach/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, store_id: storeId, device_type: 'kds' }),
      }).catch(() => {});
    };
    heartbeat();
    const interval = setInterval(heartbeat, 60_000);
    return () => clearInterval(interval);
  }, [storeId]);

  // ── Data Processing ─────────────────────────────────

  const menuItems = config?.menu_items || [];
  const configSides = config?.sides || [];
  const tips = config?.quality_tips || [];
  const isSlowPeriod = orders.length === 0;

  // Side Batching: aggregate sides across all active orders
  function getBatchedSides() {
    const sideCounts = {};
    for (const order of orders) {
      for (const side of order.sides || []) {
        const name = side.name || side;
        sideCounts[name] = (sideCounts[name] || 0) + (side.quantity || 1);
      }
    }
    // Also count sides that appear as items
    for (const order of orders) {
      for (const item of order.items || []) {
        const sideMatch = configSides.find((s) => s.name === item.name);
        if (sideMatch) {
          sideCounts[item.name] = (sideCounts[item.name] || 0) + (item.quantity || 1);
        }
      }
    }
    // Sort by cook time (longest first), then by count
    return Object.entries(sideCounts)
      .sort((a, b) => {
        const aCook = configSides.find((sc) => sc.name === a[0])?.cook_time || 0;
        const bCook = configSides.find((sc) => sc.name === b[0])?.cook_time || 0;
        if (bCook !== aCook) return bCook - aCook;
        return b[1] - a[1];
      });
  }

  // Fire Sequencing: group items by cook time, longest first
  function getFireSequence() {
    const itemTimes = [];
    for (const order of orders) {
      for (const item of order.items || []) {
        const menuMatch = menuItems.find((m) => m.name === item.name);
        const cookTime = menuMatch?.cook_time || 0;
        if (cookTime > 0) {
          itemTimes.push({
            name: item.name,
            cookTime,
            orderNum: order.order_number || '—',
            quantity: item.quantity || 1,
            station: menuMatch?.station || 'line',
          });
        }
      }
      for (const side of order.sides || []) {
        const sideName = side.name || side;
        const sideMatch = configSides.find((s) => s.name === sideName);
        const cookTime = sideMatch?.cook_time || 0;
        if (cookTime > 0) {
          itemTimes.push({
            name: sideName,
            cookTime,
            orderNum: order.order_number || '—',
            quantity: side.quantity || 1,
            station: sideMatch?.station || 'line',
          });
        }
      }
    }
    // Sort longest cook time first
    itemTimes.sort((a, b) => b.cookTime - a.cookTime);
    return itemTimes;
  }

  // Prep Volume: count items by category/station
  function getPrepVolume() {
    const stationCounts = {};
    const categoryCounts = {};
    for (const order of orders) {
      for (const item of order.items || []) {
        const menuMatch = menuItems.find((m) => m.name === item.name);
        const station = menuMatch?.station || 'line';
        const category = menuMatch?.category || 'Other';
        const qty = item.quantity || 1;
        stationCounts[station] = (stationCounts[station] || 0) + qty;
        categoryCounts[category] = (categoryCounts[category] || 0) + qty;
      }
    }
    return { stationCounts, categoryCounts };
  }

  // ── Quality Coach mode ──────────────────────────────

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    return (
      <div style={s.container}>
        <Header now={now} orderCount={0} />
        <div style={s.qualityCoach}>
          <div style={s.qualityLabel}>QUALITY COACH</div>
          <div style={s.qualityTip}>{tip}</div>
        </div>
      </div>
    );
  }

  // ── Active Orders View ──────────────────────────────

  const batchedSides = getBatchedSides();
  const fireSequence = getFireSequence();
  const { stationCounts, categoryCounts } = getPrepVolume();

  return (
    <div style={s.container}>
      <Header now={now} orderCount={orders.length} />

      <div style={s.mainGrid}>
        {/* Left Column: Fire Sequence + Prep Volume */}
        <div style={s.leftCol}>
          {/* Fire Sequence */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <span style={s.panelIcon}>&#9650;</span>
              FIRE ORDER
            </div>
            <div style={s.panelSubtext}>Start longest cook times first</div>
            {fireSequence.length === 0 && (
              <div style={s.emptyState}>No timed items</div>
            )}
            {fireSequence.slice(0, 8).map((item, i) => (
              <div key={i} style={s.fireRow}>
                <div style={s.fireIndex}>{i + 1}</div>
                <div style={s.fireInfo}>
                  <div style={s.fireName}>
                    {item.quantity > 1 ? `${item.quantity}x ` : ''}{item.name}
                  </div>
                  <div style={s.fireMeta}>
                    #{item.orderNum} &middot; {item.station}
                  </div>
                </div>
                <div style={{
                  ...s.fireCookTime,
                  color: item.cookTime >= 6 ? BRAND.terracotta : item.cookTime >= 4 ? BRAND.yellow : BRAND.green,
                }}>
                  {item.cookTime}m
                </div>
              </div>
            ))}
          </div>

          {/* Prep Volume */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <span style={s.panelIcon}>&#9632;</span>
              PREP VOLUME
            </div>
            <div style={s.panelSubtext}>Current demand by station</div>
            {Object.entries(stationCounts).length === 0 && (
              <div style={s.emptyState}>No active orders</div>
            )}
            {Object.entries(stationCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([station, count]) => (
                <div key={station} style={s.prepRow}>
                  <span style={s.prepStation}>{station.replace(/_/g, ' ')}</span>
                  <div style={s.prepBarOuter}>
                    <div style={{
                      ...s.prepBarInner,
                      width: `${Math.min(count / Math.max(...Object.values(stationCounts)) * 100, 100)}%`,
                      background: count >= 8 ? BRAND.terracotta : count >= 4 ? BRAND.yellow : BRAND.gold,
                    }} />
                  </div>
                  <span style={s.prepCount}>{count}</span>
                </div>
              ))}

            {/* Category breakdown */}
            <div style={{ ...s.panelSubtext, marginTop: '12px' }}>By category</div>
            {Object.entries(categoryCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, count]) => (
                <div key={cat} style={s.categoryRow}>
                  <span style={s.categoryName}>{cat}</span>
                  <span style={s.categoryCount}>{count}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Right Column: Side Batching */}
        <div style={s.rightCol}>
          <div style={s.sidesPanelHeader}>BATCH SIDES</div>
          <div style={s.sidesContainer}>
            {batchedSides.length === 0 && (
              <div style={s.emptyState}>No sides to batch</div>
            )}
            {batchedSides.map(([name, count]) => {
              const sideConfig = configSides.find((sc) => sc.name === name);
              const batchSize = sideConfig?.batch_size || 4;
              const batchesNeeded = Math.ceil(count / batchSize);
              const cookTime = sideConfig?.cook_time || 0;
              const imageUrl = getSideImageUrl(name);

              // Dynamic sizing based on number of sides
              const n = batchedSides.length;
              const imgSize = n <= 3 ? '12vh' : n <= 6 ? '9vh' : '7vh';
              const nameSize = n <= 3 ? '2.2vh' : n <= 6 ? '1.8vh' : '1.5vh';
              const countSize = n <= 3 ? '8vh' : n <= 6 ? '6vh' : '4.5vh';
              const actionSize = n <= 3 ? '1.5vh' : n <= 6 ? '1.3vh' : '1.1vh';

              return (
                <div key={name} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3%',
                  flex: 1,
                  padding: '0 2%',
                }}>
                  <img
                    src={imageUrl}
                    alt={name}
                    style={{
                      width: imgSize,
                      height: imgSize,
                      objectFit: 'cover',
                      borderRadius: '50%',
                      flexShrink: 0,
                    }}
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: `clamp(1rem, ${nameSize}, 2rem)`,
                      fontWeight: 700,
                      color: BRAND.bone,
                      fontFamily: "'Oswald', sans-serif",
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      lineHeight: 1.2,
                    }}>{name}</div>
                    {(cookTime > 0 || batchesNeeded > 0) && (
                      <div style={{
                        fontSize: `clamp(0.7rem, ${actionSize}, 1.2rem)`,
                        fontWeight: 700,
                        color: BRAND.terracotta,
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: '1px',
                        marginTop: '2px',
                      }}>
                        {cookTime > 0 && <span>{cookTime}m</span>}
                        {cookTime > 0 && batchesNeeded > 0 && <span> · </span>}
                        {batchesNeeded > 0 && <span>DROP {batchesNeeded}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{
                    fontSize: `clamp(2rem, ${countSize}, 6rem)`,
                    fontWeight: 700,
                    color: BRAND.gold,
                    fontFamily: "'Oswald', sans-serif",
                    lineHeight: 1,
                    flexShrink: 0,
                    textAlign: 'right',
                  }}>{count}</div>
                </div>
              );
            })}
          </div>

          {/* Quick Tip */}
          {tips.length > 0 && (
            <div style={s.quickTip}>
              <div style={s.quickTipLabel}>TIP</div>
              <div style={s.quickTipText}>{tips[qualityTipIndex % tips.length]}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Header Component ────────────────────────────────────

function Header({ now, orderCount }) {
  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        <span style={s.title}>WILDBIRD</span>
        <span style={s.titleSub}>LINE COACH</span>
      </div>
      <div style={s.headerCenter}>
        <span style={s.ticketCount}>
          {orderCount} ACTIVE ORDER{orderCount !== 1 ? 'S' : ''}
        </span>
      </div>
      <span style={s.clock}>{now.toLocaleTimeString()}</span>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────

const s = {
  container: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
  },
  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 20px',
    background: BRAND.charcoalDark,
    borderBottom: `2px solid ${BRAND.gold}`,
  },
  headerLeft: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  headerCenter: { flex: 1, textAlign: 'center' },
  title: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
  },
  titleSub: {
    fontSize: '0.9rem',
    color: BRAND.cream,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
  },
  ticketCount: {
    fontSize: '1rem',
    fontWeight: 700,
    color: BRAND.bone,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
  },
  clock: {
    fontSize: '1.1rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: "'Open Sans', sans-serif",
  },
  // Main Layout
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    padding: '12px',
    minHeight: 'calc(100vh - 60px)',
  },
  leftCol: { display: 'flex', flexDirection: 'column', gap: '12px' },
  rightCol: { display: 'flex', flexDirection: 'column', gap: '12px' },
  // Panels
  panel: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '16px',
    flex: 1,
  },
  panelHeader: {
    fontSize: '1rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
    marginBottom: '4px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  panelIcon: { fontSize: '0.7rem', color: BRAND.gold },
  panelSubtext: {
    fontSize: '0.8rem',
    color: `${BRAND.cream}99`,
    marginBottom: '12px',
  },
  emptyState: {
    textAlign: 'center',
    color: `${BRAND.cream}60`,
    padding: '20px',
    fontSize: '0.9rem',
  },
  // Fire Sequence
  fireRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 0',
    borderBottom: `1px solid ${BRAND.charcoal}`,
  },
  fireIndex: {
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    background: `${BRAND.gold}20`,
    color: BRAND.gold,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.8rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    flexShrink: 0,
  },
  fireInfo: { flex: 1 },
  fireName: {
    fontSize: '0.95rem',
    color: BRAND.bone,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  fireMeta: {
    fontSize: '0.75rem',
    color: `${BRAND.cream}88`,
    fontFamily: "'Open Sans', sans-serif",
  },
  fireCookTime: {
    fontSize: '1.1rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    flexShrink: 0,
  },
  // Prep Volume
  prepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 0',
  },
  prepStation: {
    width: '80px',
    fontSize: '0.8rem',
    color: BRAND.cream,
    fontFamily: "'Oswald', sans-serif",
    textTransform: 'uppercase',
    letterSpacing: '1px',
    flexShrink: 0,
  },
  prepBarOuter: {
    flex: 1,
    height: '12px',
    background: BRAND.charcoal,
    borderRadius: '6px',
    overflow: 'hidden',
  },
  prepBarInner: {
    height: '100%',
    borderRadius: '6px',
    transition: 'width 0.3s',
  },
  prepCount: {
    width: '28px',
    textAlign: 'right',
    fontSize: '0.9rem',
    fontWeight: 700,
    color: BRAND.bone,
    fontFamily: "'Oswald', sans-serif",
  },
  categoryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    borderBottom: `1px solid ${BRAND.charcoal}`,
  },
  categoryName: {
    fontSize: '0.85rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
  },
  categoryCount: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: BRAND.bone,
    fontFamily: "'Oswald', sans-serif",
  },
  // Side Batching
  sidesPanelHeader: {
    fontSize: '1rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
    padding: '8px 2%',
  },
  sidesContainer: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  // Quick Tip
  quickTip: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '16px',
    borderLeft: `3px solid ${BRAND.sage}`,
  },
  quickTipLabel: {
    fontSize: '0.75rem',
    color: BRAND.sage,
    fontWeight: 700,
    letterSpacing: '2px',
    marginBottom: '8px',
    fontFamily: "'Oswald', sans-serif",
  },
  quickTipText: {
    fontSize: '0.95rem',
    color: BRAND.cream,
    lineHeight: 1.5,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  // Quality Coach
  qualityCoach: {
    background: BRAND.charcoalDark,
    border: `2px solid ${BRAND.gold}`,
    borderRadius: '12px',
    padding: '40px',
    textAlign: 'center',
    maxWidth: '700px',
    margin: '80px auto',
  },
  qualityLabel: {
    fontSize: '0.9rem',
    color: BRAND.gold,
    fontWeight: 700,
    letterSpacing: '3px',
    marginBottom: '20px',
    fontFamily: "'Oswald', sans-serif",
  },
  qualityTip: {
    fontSize: '1.5rem',
    lineHeight: 1.6,
    color: BRAND.bone,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
};
