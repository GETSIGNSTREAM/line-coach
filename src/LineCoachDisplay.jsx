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

// Detect allergy / dietary callouts in order notes. Returns the cleaned
// text to highlight (or null when the note isn't allergy-related).
// Trigger words are intentionally broad — a false positive (e.g. "no
// onions" highlighted as allergy) is far less costly than missing a
// real allergen warning.
const ALLERGY_RE = /\b(allerg|gluten|celiac|nut|peanut|tree[- ]?nut|cashew|almond|walnut|pecan|shellfish|shrimp|prawn|crab|lobster|dairy|lactose|milk|cheese|egg|soy|sesame|fish|kosher|halal|vegan|vegetarian)\b/i;
function isAllergyNote(notes) {
  if (!notes || typeof notes !== 'string') return false;
  return ALLERGY_RE.test(notes);
}

// Side / item name → image URL. If the brand config has an explicit
// image_url for this name, use that (Supabase Storage). Otherwise fall
// back to the legacy /sides/<slug>.jpg path so existing photos still work.
function getSideImageUrl(name, configItems, configSides) {
  const lower = (name || '').toLowerCase();
  const findIn = (arr) => (arr || []).find((row) => (row?.name || '').toLowerCase() === lower);
  const match = findIn(configItems) || findIn(configSides);
  if (match?.image_url) return match.image_url;
  const slug = lower.replace(/[&]/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  return `/sides/${slug}.jpg`;
}

// ── Component ───────────────────────────────────────────

export default function LineCoachDisplay({ storeId }) {
  const [orders, setOrders] = useState([]);
  const [config, setConfig] = useState(null);
  const [now, setNow] = useState(new Date());
  const [qualityTipIndex, setQualityTipIndex] = useState(0);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const supabaseRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lastOrderCountRef = useRef(null);
  // Track which order ids have already triggered a warning beep so we
  // don't re-trigger every render once they're in the yellow zone.
  const warnedOrderIdsRef = useRef(new Set());
  // Interval handle for the repeating danger tone.
  const dangerIntervalRef = useRef(null);

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
    const storageKey = `lc-device-id-${storeId}`;
    let deviceId = null;
    try {
      deviceId = localStorage.getItem(storageKey);
    } catch { /* private mode / SSR */ }
    if (!deviceId) {
      deviceId = `display-${storeId}-${Math.random().toString(36).slice(2, 10)}`;
      try { localStorage.setItem(storageKey, deviceId); } catch { /* ignore */ }
    }

    let cancelled = false;
    const register = () =>
      fetch('/api/line-coach/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, store_id: storeId, device_type: 'kds' }),
      }).catch(() => {});

    const heartbeat = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/line-coach/devices/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId }),
        });
        if (res.status === 404) await register();
      } catch { /* network blip — next tick will retry */ }
    };

    register().then(heartbeat);
    const interval = setInterval(heartbeat, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [storeId]);

  // ── Audio alerts ────────────────────────────────────

  function ensureAudioCtx() {
    if (audioCtxRef.current) return audioCtxRef.current;
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtxRef.current = new Ctx();
    } catch {
      return null;
    }
    return audioCtxRef.current;
  }

  function playChime() {
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const volume = config?.settings?.alerts_volume ?? 0.5;
    // Two-note chime: C6 then E6
    const notes = [
      { freq: 1046.5, start: 0, dur: 0.18 },
      { freq: 1318.5, start: 0.16, dur: 0.28 },
    ];
    const t0 = ctx.currentTime;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0, t0 + n.start);
      gain.gain.linearRampToValueAtTime(volume * 0.5, t0 + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.05);
    }
  }

  // Single soft mid-tone beep — fires once when an order crosses into
  // the warning (yellow) zone. Quieter and lower than the new-order
  // chime so cooks distinguish it.
  function playWarning() {
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const volume = config?.settings?.alerts_volume ?? 0.5;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660; // E5 — neutral attention tone
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume * 0.35, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }

  // Two-tone urgent beep — fires every 30s while any order is in the
  // danger (red) zone. Sharper and louder than the warning so it cuts
  // through kitchen noise and signals "act now".
  function playDanger() {
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const volume = config?.settings?.alerts_volume ?? 0.5;
    const notes = [
      { freq: 880, start: 0,    dur: 0.16 },  // A5
      { freq: 880, start: 0.22, dur: 0.16 },  // A5 again — pulse pattern
    ];
    const t0 = ctx.currentTime;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0, t0 + n.start);
      gain.gain.linearRampToValueAtTime(volume * 0.55, t0 + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.05);
    }
  }

  function unlockAudio() {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => setAudioUnlocked(true)).catch(() => {});
    } else {
      setAudioUnlocked(true);
    }
  }

  // Detect new orders and play chime when count increases.
  useEffect(() => {
    const enabled = config?.settings?.alerts_enabled !== false;
    const prev = lastOrderCountRef.current;
    const curr = orders.length;
    // Skip first observation (initial load) and any non-increasing change.
    if (prev != null && curr > prev && enabled && audioUnlocked) {
      playChime();
    }
    lastOrderCountRef.current = curr;
    // playChime closes over config; reads it at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.length, config, audioUnlocked]);

  // Forget warned-order tracking for orders that are no longer active so
  // a re-fired ticket can warn again next time it ages into yellow.
  useEffect(() => {
    const liveIds = new Set(orders.map((o) => o.id).filter(Boolean));
    for (const id of warnedOrderIdsRef.current) {
      if (!liveIds.has(id)) warnedOrderIdsRef.current.delete(id);
    }
  }, [orders]);

  // Escalating audio: single warning beep when an order first crosses
  // the yellow threshold; repeating danger tone every 30s while any
  // order is in red. Both respect the alerts_enabled / alerts_volume
  // config and require the user to have unlocked audio first.
  useEffect(() => {
    const enabled = config?.settings?.alerts_enabled !== false;
    if (!enabled || !audioUnlocked) return undefined;

    const warningMin = config?.settings?.ticket_warning_minutes || 5;
    const dangerMin = config?.settings?.ticket_danger_minutes || 8;

    let anyInDanger = false;
    for (const order of orders) {
      const orderTime = new Date(order.toast_created_at || order.fire_at || order.created_at);
      const elapsedMin = (now.getTime() - orderTime.getTime()) / 60_000;
      if (elapsedMin >= dangerMin) {
        anyInDanger = true;
      } else if (elapsedMin >= warningMin && order.id && !warnedOrderIdsRef.current.has(order.id)) {
        // First time crossing yellow → fire the warning beep once.
        warnedOrderIdsRef.current.add(order.id);
        playWarning();
      }
    }

    if (anyInDanger && !dangerIntervalRef.current) {
      // Beep immediately so the cook hears it now, then every 30s.
      playDanger();
      dangerIntervalRef.current = setInterval(playDanger, 30_000);
    } else if (!anyInDanger && dangerIntervalRef.current) {
      clearInterval(dangerIntervalRef.current);
      dangerIntervalRef.current = null;
    }

    return () => {};
    // playWarning / playDanger close over config; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, now, config, audioUnlocked]);

  // Stop the danger interval when the component unmounts.
  useEffect(() => () => {
    if (dangerIntervalRef.current) {
      clearInterval(dangerIntervalRef.current);
      dangerIntervalRef.current = null;
    }
  }, []);

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

  const showAudioUnlock = (config?.settings?.alerts_enabled !== false) && !audioUnlocked;

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    const enText = tip.en && tip.en.trim();
    const esText = tip.es && tip.es.trim();
    return (
      <div style={s.container}>
        <style>{`@keyframes lcQualityFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        <Header now={now} orderCount={0} />
        {showAudioUnlock && <AudioUnlockBanner onUnlock={unlockAudio} />}
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
      <style>{`
        @keyframes lcAllergyPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.85); }
          50%      { box-shadow: 0 0 0 8px rgba(214, 69, 69, 0); }
        }
      `}</style>
      <Header now={now} orderCount={orders.length} />
      {showAudioUnlock && <AudioUnlockBanner onUnlock={unlockAudio} />}

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
                    // Allergy / dietary callout: rendered as a full-width
                    // red banner ABOVE the order row so cooks can't miss
                    // it. Other notes still render inline below the items.
                    const allergyNote = isAllergyNote(order.notes) ? order.notes : null;
                    const inlineNote = allergyNote ? null : order.notes;

                    return (
                      <div key={oi} style={{
                        borderTop: oi > 0 ? `2px solid ${BRAND.gold}40` : 'none',
                        padding: '6px 0',
                      }}>
                      {allergyNote && (
                        <div style={{
                          background: BRAND.red,
                          color: BRAND.white,
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 700,
                          letterSpacing: '2px',
                          textTransform: 'uppercase',
                          fontSize: '1.5rem',
                          padding: '8px 16px',
                          marginBottom: '6px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          animation: 'lcAllergyPulse 1.4s ease-in-out infinite',
                        }}>
                          <span style={{ fontSize: '1.7rem' }}>⚠</span>
                          <span style={{ fontWeight: 800 }}>ALLERGY:</span>
                          <span style={{ textTransform: 'none', letterSpacing: '0.5px', fontWeight: 600 }}>{allergyNote}</span>
                        </div>
                      )}
                      <div style={{
                        display: 'flex',
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
                              gap: '12px',
                              minWidth: 0,
                            }}>
                              <img
                                src={getSideImageUrl(item.name, menuItems, configSides)}
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
                                flexShrink: 0,
                              }}>
                                {item.quantity > 1 && (
                                  <span style={{ color: BRAND.gold, marginRight: '6px' }}>{item.quantity}x</span>
                                )}
                                {item.name}
                              </div>
                              {item.modifiers?.length > 0 && (
                                <div style={{
                                  // Modifiers fill the leftover space to the right
                                  // of the entree name. Allowed to wrap so long
                                  // modifier strings remain fully readable instead
                                  // of being truncated by ellipsis.
                                  flex: 1,
                                  minWidth: 0,
                                  fontSize: '1.5rem',
                                  fontWeight: 700,
                                  color: BRAND.white,
                                  fontFamily: "'Open Sans', sans-serif",
                                  lineHeight: 1.2,
                                  whiteSpace: 'normal',
                                  wordBreak: 'break-word',
                                }}>{item.modifiers.join(' · ')}</div>
                              )}
                            </div>
                          ))}
                          {(sidesText || inlineNote) && (
                            <div style={{
                              fontSize: '1.4rem',
                              lineHeight: 1.3,
                              paddingLeft: '58px',
                              display: 'flex',
                              gap: '12px',
                              flexWrap: 'wrap',
                            }}>
                              {sidesText && (
                                <span style={{ color: BRAND.white, fontWeight: 700 }}>w/ {sidesText}</span>
                              )}
                              {inlineNote && (
                                <span style={{
                                  color: BRAND.gold,
                                  fontWeight: 700,
                                  marginLeft: sidesText ? '10px' : 0,
                                }}>⚠ {inlineNote}</span>
                              )}
                            </div>
                          )}
                        </div>
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
              const imageUrl = getSideImageUrl(name, menuItems, configSides);

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

function AudioUnlockBanner({ onUnlock }) {
  return (
    <button
      onClick={onUnlock}
      style={{
        position: 'fixed',
        top: '12px',
        right: '12px',
        zIndex: 1000,
        background: BRAND.gold,
        color: BRAND.charcoal,
        border: 'none',
        padding: '8px 14px',
        borderRadius: '999px',
        cursor: 'pointer',
        fontFamily: "'Oswald', sans-serif",
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        fontSize: '0.75rem',
        fontWeight: 700,
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}
    >
      🔔 Tap to enable sound
    </button>
  );
}

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
