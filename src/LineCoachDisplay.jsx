'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

// Normalize a quality tip into { en, es }. Mirrors lib/line-coach.js so
// the client doesn't pull in server-only deps. Accepts legacy string tips.
function normalizeTip(tip) {
  if (typeof tip === 'string') return { en: tip, es: '' };
  if (tip && typeof tip === 'object') {
    return {
      en: typeof tip.en === 'string' ? tip.en : '',
      es: typeof tip.es === 'string' ? tip.es : '',
    };
  }
  return { en: '', es: '' };
}

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
  // Bilingual tips: array of { en, es }. Filter out fully empty tips so
  // the rotation never lands on a blank screen, and so legacy string-only
  // configs continue to work via normalizeTip.
  const tips = (config?.quality_tips || [])
    .map(normalizeTip)
    .filter((t) => (t.en && t.en.trim()) || (t.es && t.es.trim()));
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

  // Timer thresholds from config
  const warningMin = config?.settings?.ticket_warning_minutes || 5;
  const dangerMin = config?.settings?.ticket_danger_minutes || 8;

  function getTicketColor(elapsedMinutes) {
    if (elapsedMinutes >= dangerMin) return BRAND.red;
    if (elapsedMinutes >= warningMin) return BRAND.yellow;
    return BRAND.green;
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // Fire Sequencing: group by order, sorted by priority_rank, with elapsed time
  function getOrderSequence() {
    const tenMinFromNow = now.getTime() + 10 * 60_000;

    const orderList = orders
      .filter((order) => {
        // Hide future orders until 10 min before fire_at
        const fireAt = new Date(order.fire_at || order.created_at).getTime();
        return fireAt <= tenMinFromNow;
      })
      .map((order) => {
        let maxCookTime = 0;
        const items = (order.items || []).map((item) => {
          const menuMatch = menuItems.find((m) => m.name === item.name);
          const cookTime = menuMatch?.cook_time || 0;
          if (cookTime > maxCookTime) maxCookTime = cookTime;
          return { ...item, cookTime, station: menuMatch?.station || 'line' };
        });

        const orderTime = new Date(order.toast_created_at || order.fire_at || order.created_at);
        const elapsedMs = now.getTime() - orderTime.getTime();
        const elapsedMinutes = elapsedMs / 60_000;
        const fireAt = new Date(order.fire_at || order.created_at);
        const isFutureOrder = fireAt.getTime() > now.getTime();

        return {
          orderNum: order.order_number || '—',
          customerName: order.customer_name || null,
          items,
          sides: order.sides || [],
          notes: order.notes || null,
          diningOption: order.dining_option || null,
          priority: order.priority || 'normal',
          priorityRank: order.priority_rank || 30,
          maxCookTime,
          elapsedMs,
          elapsedMinutes,
          elapsedDisplay: formatElapsed(elapsedMs),
          ticketColor: getTicketColor(elapsedMinutes),
          isFutureOrder,
          fireAt,
        };
      });

    // Sort by priority_rank (ASAP 10 → Dine In 20 → Takeout 30 → Delivery 40), then oldest first
    orderList.sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      return a.fireAt - b.fireAt;
    });
    return orderList;
  }


  // ── Quality Coach mode ──────────────────────────────

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    const enText = tip.en && tip.en.trim();
    const esText = tip.es && tip.es.trim();
    return (
      <div style={s.container}>
        <style>{`@keyframes lcQualityFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        <Header now={now} orderCount={0} />
        <div style={s.qualityCoach}>
          <div style={s.qualityLabel}>QUALITY COACH</div>
          <div style={s.qualityTipBlock} key={qualityTipIndex}>
            {enText && (
              <div style={s.qualityLangSection}>
                <div style={s.qualityLangLabel}>ENGLISH</div>
                <div style={s.qualityTipEn}>{enText}</div>
              </div>
            )}
            {enText && esText && <div style={s.qualityDivider} />}
            {esText && (
              <div style={s.qualityLangSection}>
                <div style={{ ...s.qualityLangLabel, color: BRAND.sage }}>ESPAÑOL</div>
                <div style={s.qualityTipEs}>{esText}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Active Orders View ──────────────────────────────

  const batchedSides = getBatchedSides();
  const orderSequence = getOrderSequence();

  return (
    <div style={s.container}>
      <Header now={now} orderCount={orders.length} />

      <div style={s.mainGrid}>
        {/* Left Column: Fire Order — grouped by order */}
        <div style={s.leftCol}>
          <div style={s.sidesContainer}>
            {orderSequence.length === 0 && (
              <div style={{ ...s.emptyState, fontSize: '1.5rem' }}>All orders plated</div>
            )}
            {(() => {
              const diningColors = {
                'dine in': BRAND.gold,
                'takeout': BRAND.blue,
                'delivery': BRAND.cream,
              };

              // Max 8 orders visible — enforce minimum readable size
              const MAX_VISIBLE = 8;
              const visibleOrders = orderSequence.slice(0, MAX_VISIBLE);
              const hiddenCount = orderSequence.length - MAX_VISIBLE;

              return (
                <>
                  {visibleOrders.map((order, oi) => {
                    const diningLabel = order.diningOption || '';
                    const diningColor = diningColors[diningLabel.toLowerCase()] || BRAND.blue;
                    const ticketBorderColor = order.priority === 'rush' ? BRAND.red : order.ticketColor;
                    const sidesText = order.sides.map((side) => {
                      const sn = typeof side === 'string' ? side : side.name;
                      const sq = side.quantity || 1;
                      return sq > 1 ? `${sq}x ${sn}` : sn;
                    }).join(', ');

                    return (
                      <div key={oi} style={{
                        display: 'flex',
                        borderTop: oi > 0 ? `2px solid ${BRAND.gold}40` : 'none',
                        padding: '6px 0',
                      }}>
                        {/* Left sidebar: check info + timer */}
                        <div style={{
                          width: '80px',
                          background: `${ticketBorderColor}15`,
                          borderLeft: `5px solid ${ticketBorderColor}`,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '6px 4px',
                          flexShrink: 0,
                          gap: '3px',
                        }}>
                          <div style={{
                            fontSize: '1rem',
                            fontWeight: 700,
                            color: BRAND.bone,
                            fontFamily: "'Oswald', sans-serif",
                          }}>#{order.orderNum}</div>
                          {order.customerName && (
                            <div style={{
                              fontSize: '0.7rem',
                              color: BRAND.cream,
                              fontFamily: "'Open Sans', sans-serif",
                              textAlign: 'center',
                              lineHeight: 1.2,
                            }}>{order.customerName}</div>
                          )}
                          {order.priority === 'rush' && (
                            <div style={{
                              fontSize: '0.65rem',
                              background: BRAND.white,
                              color: BRAND.charcoal,
                              padding: '2px 6px',
                              borderRadius: '3px',
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700,
                            }}>ASAP</div>
                          )}
                          {!order.isFutureOrder && diningLabel && order.priority !== 'rush' && (
                            <div style={{
                              fontSize: '0.65rem',
                              background: diningColor,
                              color: BRAND.charcoal,
                              padding: '2px 6px',
                              borderRadius: '3px',
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700,
                            }}>{diningLabel.toUpperCase()}</div>
                          )}
                          {order.isFutureOrder && (
                            <div style={{
                              fontSize: '0.65rem',
                              background: BRAND.blue,
                              color: BRAND.charcoal,
                              padding: '2px 6px',
                              borderRadius: '3px',
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700,
                            }}>{order.fireAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                          )}
                          {!order.isFutureOrder && (
                            <div style={{
                              fontSize: '1.1rem',
                              color: ticketBorderColor,
                              fontWeight: 700,
                              fontFamily: "'Oswald', sans-serif",
                              fontVariantNumeric: 'tabular-nums',
                            }}>{order.elapsedDisplay}</div>
                          )}
                        </div>

                        {/* Right: entrees + sides — one line per item */}
                        <div style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          padding: '0 12px',
                          gap: '2px',
                        }}>
                          {order.items.map((item, ii) => (
                            <div key={ii} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                            }}>
                              <img
                                src={getSideImageUrl(item.name)}
                                alt={item.name}
                                style={{
                                  width: '48px',
                                  height: '48px',
                                  objectFit: 'cover',
                                  borderRadius: '50%',
                                  flexShrink: 0,
                                }}
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                              <div style={{
                                fontSize: '1.5rem',
                                fontWeight: 700,
                                color: BRAND.bone,
                                fontFamily: "'Oswald', sans-serif",
                                textTransform: 'uppercase',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}>
                                {item.quantity > 1 && (
                                  <span style={{ color: BRAND.gold, marginRight: '6px' }}>{item.quantity}x</span>
                                )}
                                {item.name}
                              </div>
                              {item.modifiers?.length > 0 && (
                                <div style={{
                                  fontSize: '1rem',
                                  color: BRAND.cream,
                                  fontFamily: "'Open Sans', sans-serif",
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}>{item.modifiers.join(' · ')}</div>
                              )}
                            </div>
                          ))}
                          {(sidesText || order.notes) && (
                            <div style={{
                              fontSize: '1.1rem',
                              lineHeight: 1.3,
                              paddingLeft: '58px',
                              display: 'flex',
                              gap: '12px',
                              flexWrap: 'wrap',
                            }}>
                              {sidesText && (
                                <span style={{ color: BRAND.cream, fontWeight: 600 }}>w/ {sidesText}</span>
                              )}
                              {order.notes && (
                                <span style={{
                                  color: BRAND.gold,
                                  fontWeight: 600,
                                  marginLeft: sidesText ? '10px' : 0,
                                }}>⚠ {order.notes}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {hiddenCount > 0 && (
                    <div style={{
                      padding: '8px',
                      textAlign: 'center',
                      color: BRAND.gold,
                      fontFamily: "'Oswald', sans-serif",
                      fontSize: '1rem',
                      letterSpacing: '1px',
                    }}>
                      +{hiddenCount} MORE ORDER{hiddenCount > 1 ? 'S' : ''}
                    </div>
                  )}
                </>
              );
            })()}
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

              // Dynamic sizing based on number of sides — compact for narrow column
              const n = batchedSides.length;
              const imgSize = n <= 4 ? '7vh' : n <= 8 ? '5.5vh' : '4.5vh';
              const nameSize = n <= 4 ? '1.5vh' : n <= 8 ? '1.3vh' : '1.1vh';
              const countSize = n <= 4 ? '5vh' : n <= 8 ? '4vh' : '3vh';
              const actionSize = n <= 4 ? '1.2vh' : n <= 8 ? '1vh' : '0.9vh';

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
          {tips.length > 0 && (() => {
            const tip = tips[qualityTipIndex % tips.length];
            const enText = tip.en && tip.en.trim();
            const esText = tip.es && tip.es.trim();
            return (
              <div style={s.quickTip}>
                <div style={s.quickTipLabel}>TIP</div>
                {enText && (
                  <>
                    <div style={s.quickTipLangLabel}>EN</div>
                    <div style={s.quickTipText}>{enText}</div>
                  </>
                )}
                {esText && (
                  <>
                    <div style={{ ...s.quickTipLangLabel, color: BRAND.gold, marginTop: enText ? '10px' : 0 }}>ES</div>
                    <div style={s.quickTipTextEs}>{esText}</div>
                  </>
                )}
              </div>
            );
          })()}
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
    padding: '6px 16px',
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
    gridTemplateColumns: '1fr 280px',
    gap: '8px',
    padding: '8px',
    height: 'calc(100vh - 50px)',
    overflow: 'hidden',
  },
  leftCol: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  rightCol: { display: 'flex', flexDirection: 'column', overflow: 'hidden', background: BRAND.charcoalDark, borderRadius: '8px', padding: '0 4px' },
  emptyState: {
    textAlign: 'center',
    color: `${BRAND.cream}60`,
    padding: '20px',
    fontSize: '0.9rem',
  },
  // Side Batching
  sidesPanelHeader: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
    padding: '4px 2%',
    flexShrink: 0,
  },
  sidesContainer: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
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
  quickTipLangLabel: {
    fontSize: '0.65rem',
    color: BRAND.sage,
    fontWeight: 700,
    letterSpacing: '2px',
    marginBottom: '3px',
    fontFamily: "'Oswald', sans-serif",
    opacity: 0.8,
  },
  quickTipText: {
    fontSize: '0.95rem',
    color: BRAND.cream,
    lineHeight: 1.5,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  quickTipTextEs: {
    fontSize: '0.85rem',
    color: BRAND.bone,
    lineHeight: 1.5,
    fontFamily: "'Playfair Display', Georgia, serif",
    opacity: 0.92,
  },
  // Quality Coach — fills the screen below the header so tips are
  // readable from anywhere on the line. EN stacked on top of ES.
  qualityCoach: {
    minHeight: 'calc(100vh - 60px)',
    padding: '4vh 6vw',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  qualityLabel: {
    fontSize: 'clamp(1rem, 1.6vw, 1.6rem)',
    color: BRAND.gold,
    fontWeight: 700,
    letterSpacing: '4px',
    fontFamily: "'Oswald', sans-serif",
    marginBottom: 'clamp(2vh, 4vh, 6vh)',
  },
  qualityTipBlock: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    gap: 'clamp(2vh, 3vh, 5vh)',
    animation: 'lcQualityFade 350ms ease-out',
  },
  qualityLangSection: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'clamp(0.8vh, 1.2vh, 2vh)',
  },
  qualityLangLabel: {
    fontSize: 'clamp(0.9rem, 1.2vw, 1.4rem)',
    color: BRAND.gold,
    fontWeight: 700,
    letterSpacing: '3px',
    fontFamily: "'Oswald', sans-serif",
    opacity: 0.85,
  },
  qualityTipEn: {
    fontSize: 'clamp(2.4rem, 5.5vw, 5.5rem)',
    lineHeight: 1.2,
    color: BRAND.bone,
    fontFamily: "'Playfair Display', Georgia, serif",
    maxWidth: '90vw',
  },
  qualityTipEs: {
    fontSize: 'clamp(2rem, 4.8vw, 4.8rem)',
    lineHeight: 1.2,
    color: BRAND.cream,
    fontFamily: "'Playfair Display', Georgia, serif",
    maxWidth: '90vw',
  },
  qualityDivider: {
    width: '30%',
    height: '1px',
    background: `${BRAND.gold}55`,
  },
};
