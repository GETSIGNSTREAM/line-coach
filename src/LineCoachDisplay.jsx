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
};

// Time thresholds (minutes)
const TIME_GREEN = 4;   // 0–4 min: on track
const TIME_YELLOW = 7;  // 4–7 min: warning
const TIME_RED = 10;    // 7+ min: overdue

function getTicketColor(ageMinutes) {
  if (ageMinutes < TIME_GREEN) return { bg: '#2D4A3E', border: BRAND.green, label: BRAND.green };
  if (ageMinutes < TIME_YELLOW) return { bg: '#4A4428', border: BRAND.yellow, label: BRAND.yellow };
  return { bg: '#4A2828', border: BRAND.red, label: BRAND.red };
}

function formatElapsed(ageMinutes) {
  const mins = Math.floor(ageMinutes);
  const secs = Math.floor((ageMinutes - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ── Component ───────────────────────────────────────────

export default function LineCoachDisplay({ storeId }) {
  const [orders, setOrders] = useState([]);
  const [config, setConfig] = useState(null);
  const [now, setNow] = useState(new Date());
  const [qualityTipIndex, setQualityTipIndex] = useState(0);
  const [selectedTicket, setSelectedTicket] = useState(null);
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

  // ── Bump handler ────────────────────────────────────

  async function handleBump(orderId) {
    await fetch('/api/line-coach/bump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
    setSelectedTicket(null);
  }

  // ── Quality Coach mode ──────────────────────────────

  const tips = config?.quality_tips || [];
  const isSlowPeriod = orders.length === 0;

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    return (
      <div style={s.container}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.title}>WILDBIRD</span>
            <span style={s.titleSub}>LINE COACH</span>
          </div>
          <div style={s.headerCenter}>
            <span style={s.ticketCount}>0 TICKETS</span>
          </div>
          <span style={s.clock}>{now.toLocaleTimeString()}</span>
        </div>
        <div style={s.qualityCoach}>
          <div style={s.qualityLabel}>QUALITY COACH</div>
          <div style={s.qualityTip}>{tip}</div>
        </div>
      </div>
    );
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

  // ── Render ──────────────────────────────────────────

  const sortedOrders = [...orders].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const batchedSides = getBatchedSides();

  return (
    <div style={s.container}>
      {/* Header Bar */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.title}>WILDBIRD</span>
          <span style={s.titleSub}>LINE COACH</span>
        </div>
        <div style={s.headerCenter}>
          <span style={s.ticketCount}>{orders.length} TICKET{orders.length !== 1 ? 'S' : ''}</span>
          {batchedSides.length > 0 && (
            <div style={s.batchBar}>
              {batchedSides.map(([name, count]) => (
                <span key={name} style={s.batchPill}>{count}x {name}</span>
              ))}
            </div>
          )}
        </div>
        <div style={s.headerRight}>
          <div style={s.legend}>
            <span style={{ ...s.legendDot, background: BRAND.green }} />
            <span style={s.legendText}>&lt;{TIME_GREEN}m</span>
            <span style={{ ...s.legendDot, background: BRAND.yellow }} />
            <span style={s.legendText}>&lt;{TIME_YELLOW}m</span>
            <span style={{ ...s.legendDot, background: BRAND.red }} />
            <span style={s.legendText}>{TIME_YELLOW}m+</span>
          </div>
          <span style={s.clock}>{now.toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Ticket Grid */}
      <div style={s.grid}>
        {sortedOrders.map((order, index) => {
          const ageMinutes = (now - new Date(order.created_at)) / 60_000;
          const colors = getTicketColor(ageMinutes);
          const isSelected = selectedTicket === order.id;

          return (
            <div
              key={order.id}
              style={{
                ...s.ticket,
                borderTop: `4px solid ${colors.border}`,
                background: isSelected ? colors.bg : BRAND.charcoalDark,
                outline: isSelected ? `2px solid ${BRAND.gold}` : 'none',
              }}
              onClick={() => setSelectedTicket(isSelected ? null : order.id)}
            >
              {/* Ticket Header */}
              <div style={{ ...s.ticketHeader, background: colors.bg }}>
                <div style={s.ticketNum}>
                  <span style={s.ticketIndex}>{index + 1}</span>
                  <span style={s.orderNum}>#{order.order_number || '—'}</span>
                  {order.priority === 'rush' && <span style={s.rushBadge}>RUSH</span>}
                </div>
                <span style={{ ...s.timer, color: colors.label }}>{formatElapsed(ageMinutes)}</span>
              </div>

              {/* Ticket Items */}
              <div style={s.ticketBody}>
                {(order.items || []).map((item, i) => (
                  <div key={i} style={s.ticketItem}>
                    <span style={s.itemQty}>{item.quantity > 1 ? `${item.quantity}x` : '1x'}</span>
                    <span style={s.itemName}>{item.name}</span>
                    {item.modifiers?.length > 0 && (
                      <div style={s.itemMods}>{item.modifiers.join(', ')}</div>
                    )}
                  </div>
                ))}
                {(order.sides || []).map((side, i) => (
                  <div key={`s-${i}`} style={s.ticketSide}>
                    <span style={s.itemQty}>+</span>
                    <span style={s.sideName}>{typeof side === 'string' ? side : side.name}</span>
                  </div>
                ))}
              </div>

              {/* Notes */}
              {order.notes && (
                <div style={s.ticketNotes}>
                  {order.notes}
                </div>
              )}

              {/* Bump Button */}
              <button
                style={s.bumpBtn}
                onClick={(e) => { e.stopPropagation(); handleBump(order.id); }}
              >
                FULFILL
              </button>
            </div>
          );
        })}
      </div>
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
    padding: '8px 16px',
    background: BRAND.charcoalDark,
    borderBottom: `2px solid ${BRAND.gold}`,
  },
  headerLeft: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  headerCenter: { display: 'flex', alignItems: 'center', gap: '16px', flex: 1, justifyContent: 'center' },
  headerRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' },
  title: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
  },
  titleSub: {
    fontSize: '0.9rem',
    fontWeight: 400,
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
    fontSize: '1rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: "'Open Sans', sans-serif",
  },
  legend: { display: 'flex', alignItems: 'center', gap: '6px' },
  legendDot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
  legendText: { fontSize: '0.7rem', color: BRAND.cream, fontFamily: "'Open Sans', sans-serif" },
  // Batch bar
  batchBar: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  batchPill: {
    fontSize: '0.75rem',
    padding: '2px 10px',
    borderRadius: '12px',
    background: `${BRAND.gold}20`,
    color: BRAND.gold,
    border: `1px solid ${BRAND.gold}40`,
    fontWeight: 600,
    fontFamily: "'Open Sans', sans-serif",
  },
  // Ticket Grid
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '8px',
    padding: '12px',
  },
  // Ticket Card
  ticket: {
    background: BRAND.charcoalDark,
    borderRadius: '6px',
    overflow: 'hidden',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    transition: 'outline 0.1s',
  },
  ticketHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
  },
  ticketNum: { display: 'flex', alignItems: 'center', gap: '8px' },
  ticketIndex: {
    fontSize: '0.75rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
    background: `${BRAND.white}15`,
    padding: '1px 6px',
    borderRadius: '3px',
  },
  orderNum: {
    fontSize: '1.1rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    color: BRAND.bone,
    letterSpacing: '1px',
  },
  timer: {
    fontSize: '1.1rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '1px',
  },
  rushBadge: {
    background: BRAND.red,
    color: BRAND.white,
    padding: '1px 8px',
    borderRadius: '3px',
    fontSize: '0.7rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
  },
  // Ticket Body
  ticketBody: {
    padding: '8px 12px',
    flex: 1,
  },
  ticketItem: {
    padding: '3px 0',
    borderBottom: `1px solid ${BRAND.charcoal}`,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '6px',
  },
  itemQty: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
    minWidth: '24px',
  },
  itemName: {
    fontSize: '0.95rem',
    color: BRAND.bone,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  itemMods: {
    fontSize: '0.8rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
    width: '100%',
    paddingLeft: '30px',
    fontStyle: 'italic',
  },
  ticketSide: {
    padding: '2px 0',
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
  },
  sideName: {
    fontSize: '0.85rem',
    color: BRAND.cream,
    fontFamily: "'Open Sans', sans-serif",
  },
  ticketNotes: {
    padding: '6px 12px',
    fontSize: '0.8rem',
    color: BRAND.gold,
    background: `${BRAND.gold}10`,
    borderTop: `1px solid ${BRAND.gold}30`,
    fontFamily: "'Open Sans', sans-serif",
  },
  // Bump Button
  bumpBtn: {
    background: BRAND.gold,
    color: BRAND.charcoal,
    border: 'none',
    padding: '8px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
    textTransform: 'uppercase',
    width: '100%',
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
