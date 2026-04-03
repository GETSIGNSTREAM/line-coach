'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ── WILDBIRD Brand Colors ───────────────────────────────

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  white: '#FFFFFF',
  sage: '#A8B5A0',
  terracotta: '#C8654A',
  blue: '#4A7C8C',
  cream: '#E8DCC8',
  red: '#D64545',
  yellow: '#F2C94C',
  green: '#6FCF97',
};

// ── Styles ──────────────────────────────────────────────

const styles = {
  container: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    padding: '16px',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 20px',
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    marginBottom: '16px',
    borderBottom: `2px solid ${BRAND.gold}`,
  },
  title: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
    textTransform: 'uppercase',
  },
  clock: {
    fontSize: '1.2rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: "'Open Sans', sans-serif",
  },
  lanesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '16px',
    flex: 1,
  },
  lane: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '12px',
    minHeight: '300px',
  },
  laneHeader: {
    fontSize: '1.1rem',
    fontWeight: 700,
    padding: '10px 14px',
    borderRadius: '6px',
    marginBottom: '12px',
    textAlign: 'center',
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '2px',
    textTransform: 'uppercase',
  },
  orderCard: {
    background: BRAND.charcoalLight,
    borderRadius: '6px',
    padding: '10px 12px',
    marginBottom: '8px',
    cursor: 'pointer',
    transition: 'transform 0.1s',
  },
  orderNumber: {
    fontWeight: 700,
    fontSize: '1.1rem',
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    color: BRAND.bone,
  },
  orderAge: { fontSize: '0.8rem', color: BRAND.cream, marginLeft: '8px' },
  itemList: {
    margin: '6px 0 0 0',
    padding: 0,
    listStyle: 'none',
    fontSize: '0.9rem',
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  rushBadge: {
    background: BRAND.red,
    color: BRAND.white,
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 700,
    marginLeft: '8px',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
  },
  sideBatch: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '12px',
    marginTop: '16px',
    borderLeft: `3px solid ${BRAND.gold}`,
  },
  sideBatchTitle: {
    fontWeight: 700,
    marginBottom: '8px',
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '2px',
    textTransform: 'uppercase',
  },
  sidePill: {
    display: 'inline-block',
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    padding: '4px 14px',
    borderRadius: '16px',
    margin: '4px',
    fontSize: '0.85rem',
    border: `1px solid ${BRAND.gold}40`,
  },
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
    textTransform: 'uppercase',
    letterSpacing: '3px',
    marginBottom: '20px',
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
  },
  qualityTip: {
    fontSize: '1.5rem',
    lineHeight: 1.6,
    color: BRAND.bone,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  bumpBtn: {
    background: BRAND.gold,
    color: BRAND.charcoal,
    border: 'none',
    padding: '6px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 700,
    marginTop: '6px',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  stats: {
    display: 'flex',
    gap: '24px',
    fontSize: '0.85rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
  },
};

const LANE_COLORS = {
  'Fire Now': BRAND.terracotta,
  'Staging': BRAND.yellow,
  'On Deck': BRAND.blue,
};

const LANE_TEXT_COLORS = {
  'Fire Now': BRAND.white,
  'Staging': BRAND.charcoal,
  'On Deck': BRAND.white,
};

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

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    const client = supabaseRef.current;
    if (!client) return;

    const channel = client
      .channel('lc-orders-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lc_orders', filter: `store_id=eq.${storeId}` },
        () => fetchOrders()
      )
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, [storeId, fetchOrders]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const tipInterval = (config?.settings?.quality_coach_interval || 30) * 1000;
    const interval = setInterval(() => {
      setQualityTipIndex((i) => i + 1);
    }, tipInterval);
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

  // ── Lane classification ─────────────────────────────

  const holdTimes = config?.hold_times || { fire_now: 5, staging: 15, on_deck: 30 };

  function classifyOrder(order) {
    const ageMinutes = (now - new Date(order.fire_at)) / 60_000;
    if (order.priority === 'rush' || ageMinutes >= 0) {
      if (ageMinutes >= -holdTimes.fire_now) return 'Fire Now';
    }
    if (ageMinutes >= -holdTimes.staging) return 'Staging';
    return 'On Deck';
  }

  const lanes = { 'Fire Now': [], 'Staging': [], 'On Deck': [] };
  for (const order of orders) {
    const lane = classifyOrder(order);
    lanes[lane].push(order);
  }

  // ── Side batching ───────────────────────────────────

  function getBatchedSides() {
    const sideCounts = {};
    for (const order of orders) {
      for (const side of order.sides || []) {
        const name = side.name || side;
        sideCounts[name] = (sideCounts[name] || 0) + (side.quantity || 1);
      }
    }
    const threshold = config?.settings?.side_batch_threshold || 3;
    return Object.entries(sideCounts)
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1]);
  }

  // ── Bump handler ────────────────────────────────────

  async function handleBump(orderId) {
    await fetch('/api/line-coach/bump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
  }

  // ── Quality Coach mode ──────────────────────────────

  const tips = config?.quality_tips || [];
  const isSlowPeriod = orders.length === 0;

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.title}>WILDBIRD LINE COACH</span>
          <span style={styles.clock}>{now.toLocaleTimeString()}</span>
        </div>
        <div style={styles.qualityCoach}>
          <div style={styles.qualityLabel}>Quality Coach</div>
          <div style={styles.qualityTip}>{tip}</div>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────

  const batchedSides = getBatchedSides();

  function formatAge(fireAt) {
    const mins = Math.round((now - new Date(fireAt)) / 60_000);
    if (mins <= 0) return 'just now';
    return `${mins}m ago`;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>WILDBIRD LINE COACH</span>
        <div style={styles.stats}>
          <span>Active: {orders.length}</span>
          <span>Fire Now: {lanes['Fire Now'].length}</span>
        </div>
        <span style={styles.clock}>{now.toLocaleTimeString()}</span>
      </div>

      <div style={styles.lanesGrid}>
        {Object.entries(lanes).map(([laneName, laneOrders]) => (
          <div key={laneName} style={styles.lane}>
            <div style={{
              ...styles.laneHeader,
              background: LANE_COLORS[laneName],
              color: LANE_TEXT_COLORS[laneName],
            }}>
              {laneName} ({laneOrders.length})
            </div>
            {laneOrders.map((order) => (
              <div key={order.id} style={{
                ...styles.orderCard,
                borderLeft: order.priority === 'rush'
                  ? `4px solid ${BRAND.red}`
                  : `4px solid ${BRAND.gold}40`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <span style={styles.orderNumber}>#{order.order_number || '—'}</span>
                    <span style={styles.orderAge}>{formatAge(order.fire_at)}</span>
                    {order.priority === 'rush' && <span style={styles.rushBadge}>RUSH</span>}
                  </div>
                  <button style={styles.bumpBtn} onClick={() => handleBump(order.id)}>
                    BUMP
                  </button>
                </div>
                <ul style={styles.itemList}>
                  {(order.items || []).map((item, i) => (
                    <li key={i} style={{ padding: '2px 0', color: BRAND.bone }}>
                      {item.quantity > 1 ? `${item.quantity}x ` : ''}{item.name}
                      {item.modifiers?.length > 0 && (
                        <span style={{ color: BRAND.cream, fontSize: '0.8rem' }}>
                          {' '}({item.modifiers.join(', ')})
                        </span>
                      )}
                    </li>
                  ))}
                  {(order.sides || []).map((side, i) => (
                    <li key={`s-${i}`} style={{ padding: '2px 0', color: BRAND.cream }}>
                      + {typeof side === 'string' ? side : side.name}
                    </li>
                  ))}
                </ul>
                {order.notes && (
                  <div style={{ fontSize: '0.8rem', color: BRAND.gold, marginTop: '4px' }}>
                    Note: {order.notes}
                  </div>
                )}
              </div>
            ))}
            {laneOrders.length === 0 && (
              <div style={{
                textAlign: 'center',
                color: `${BRAND.cream}80`,
                padding: '20px',
                fontSize: '0.9rem',
              }}>
                No orders
              </div>
            )}
          </div>
        ))}
      </div>

      {batchedSides.length > 0 && (
        <div style={styles.sideBatch}>
          <div style={styles.sideBatchTitle}>Batch Sides</div>
          {batchedSides.map(([name, count]) => (
            <span key={name} style={styles.sidePill}>
              {name}: {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
