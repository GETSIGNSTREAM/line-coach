'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { canonicalSideName, isCanonicalSide } from '@/lib/side-canonical';

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

// The banner already prints "ALLERGY:" as a label, so strip a leading
// "Allergy:" / "Allergens:" / "Allergy -" from the note text to avoid
// the duplicated word. Pure copy hygiene.
function trimAllergyPrefix(notes) {
  if (!notes) return notes;
  return String(notes).replace(/^\s*allerg(?:y|ens?|ic)\s*[:.\-—]\s*/i, '').trim();
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
  // Focus mode (1 order on board) rotates through every item on the
  // order so each dish gets its own coaching moment in turn.
  const [focusItemIndex, setFocusItemIndex] = useState(0);
  // Audio unlock is best-effort: kitchen monitors have no mouse, so we
  // never show a "tap to enable" prompt. If the browser blocks
  // AudioContext until a user gesture, the chime silently fails — staff
  // can mute the monitor at the OS/hardware level if needed. We still
  // try to resume on any incidental interaction.
  const supabaseRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lastOrderCountRef = useRef(null);
  // Track which order ids have already triggered a warning beep so we
  // don't re-trigger every render once they're in the yellow zone.
  const warnedOrderIdsRef = useRef(new Set());
  // Interval handle for the repeating danger tone.
  const dangerIntervalRef = useRef(null);

  // Touch-to-bump state. holdProgress is the in-flight hold (order id +
  // 0..1 fill); bumpedToast tracks the last bumped order so the undo
  // pill can restore it within the undo window.
  const [holdProgress, setHoldProgress] = useState(null);  // { orderId, pct }
  const [bumpedToast, setBumpedToast] = useState(null);    // { orderId, orderNum, expiresAt }
  // Persistent ref of bumped ids that should be hidden optimistically
  // until the realtime channel confirms. Re-checked in the visibleOrders
  // filter below so the card disappears the instant the hold completes.
  const optimisticallyBumpedRef = useRef(new Set());
  const holdTimersRef = useRef({});  // orderId → { rafId, startedAt }

  // Track order ids that just appeared so we can play the entry
  // animation once. Cleared after the animation duration so a card
  // doesn't re-animate on a normal re-render. Refs (not state)
  // because we don't want a render cycle for the cleanup tick.
  const freshOrderIdsRef = useRef(new Set());
  const seenOrderIdsRef = useRef(new Set());

  // Track per-side last-rendered counts so we can flash the new
  // count when it changes (move 5: side-batch count tick-up).
  const lastSideCountsRef = useRef(new Map());
  const flashSideRef = useRef(new Set()); // canonical name → flash this render

  // Hint pill: shows on the first card for ~7s after page load until
  // the cook bumps once in the session. sessionStorage so a refresh
  // mid-shift doesn't re-show it; new browser session brings it back.
  const [showHoldHint, setShowHoldHint] = useState(false);

  const HOLD_DURATION_MS = 800;
  const UNDO_WINDOW_MS = 5000;

  // Detect touch capability + URL override. ?touch=1 forces on, ?touch=0
  // forces off, anything else auto-detects. Set in an effect (post-mount)
  // so the SSR pass and first client render see the same value (false)
  // and React doesn't throw a hydration mismatch.
  const [touchEnabled, setTouchEnabled] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const override = params.get('touch');
    if (override === '1') { setTouchEnabled(true); return; }
    if (override === '0') { setTouchEnabled(false); return; }
    setTouchEnabled(
      'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0
    );
  }, []);

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

  // Focus mode rotation — advances the focused item every 8 seconds so
  // every dish on a single-order ticket gets its own coaching panel.
  // Configurable via settings.focus_rotation_seconds (default 8).
  useEffect(() => {
    const focusInterval = (config?.settings?.focus_rotation_seconds || 8) * 1000;
    const interval = setInterval(() => setFocusItemIndex((i) => i + 1), focusInterval);
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
    if (typeof window === 'undefined') return null;
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        audioCtxRef.current = new Ctx();
      } catch {
        return null;
      }
    }
    // Best-effort resume — if the browser still requires a gesture this
    // is a no-op until one happens. We never block the call site on it.
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }

  // Try to unlock audio on any incidental interaction with the page —
  // a tap, key press, or even a stray click. Most kitchens never touch
  // the monitor, but if they do, we capitalize on it. One-shot.
  useEffect(() => {
    let unlocked = false;
    const handler = () => {
      if (unlocked) return;
      unlocked = true;
      ensureAudioCtx();
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('touchstart', handler);
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    window.addEventListener('touchstart', handler);
    // Also attempt right now — some browsers (especially ones running
    // in PWA/kiosk mode) start AudioContext in 'running' state.
    ensureAudioCtx();
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('touchstart', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Detect new orders and play chime when count increases.
  useEffect(() => {
    const enabled = config?.settings?.alerts_enabled !== false;
    const prev = lastOrderCountRef.current;
    const curr = orders.length;
    // Skip first observation (initial load) and any non-increasing change.
    if (prev != null && curr > prev && enabled) {
      playChime();
    }
    lastOrderCountRef.current = curr;
    // playChime closes over config; reads it at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.length, config]);

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
  // config. The audio context resumes on its own once any interaction
  // has happened; before then, calls are silent no-ops.
  useEffect(() => {
    const enabled = config?.settings?.alerts_enabled !== false;
    if (!enabled) return undefined;

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
  }, [orders, now, config]);

  // Stop the danger interval when the component unmounts.
  useEffect(() => () => {
    if (dangerIntervalRef.current) {
      clearInterval(dangerIntervalRef.current);
      dangerIntervalRef.current = null;
    }
  }, []);

  // Track which orders are "fresh" (just appeared) so the entry
  // animation runs exactly once per order. seenOrderIdsRef holds the
  // last-known set of ids; any id present now but not before is fresh.
  // Cleared 320ms after the animation completes so a normal re-render
  // doesn't re-trigger.
  useEffect(() => {
    const liveIds = new Set();
    for (const o of orders) {
      if (o.id) liveIds.add(o.id);
    }
    const justAppeared = [];
    for (const id of liveIds) {
      if (!seenOrderIdsRef.current.has(id)) justAppeared.push(id);
    }
    if (justAppeared.length > 0) {
      for (const id of justAppeared) freshOrderIdsRef.current.add(id);
      const t = setTimeout(() => {
        for (const id of justAppeared) freshOrderIdsRef.current.delete(id);
      }, 320);
      seenOrderIdsRef.current = liveIds;
      return () => clearTimeout(t);
    }
    seenOrderIdsRef.current = liveIds;
    return () => {};
  }, [orders]);

  // Hint pill: initialize from sessionStorage. Only show if not seen.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.sessionStorage.getItem('lcHintSeen') !== '1') {
        setShowHoldHint(true);
      }
    } catch { /* sessionStorage may be blocked; default off */ }
  }, []);

  // Side-batch count tick-up: detect every increase in the per-side
  // total and set a transient flash flag the renderer reads. Runs in
  // an effect (not during render) so the setTimeout cleanup is safe
  // and React won't double-invoke under StrictMode. Watching
  // `orders` is a sufficient trigger because the side counts are
  // derived from order content.
  useEffect(() => {
    // Recompute the side counts from the current orders without
    // depending on getBatchedSides (avoids a circular state dep).
    const liveCounts = new Map();
    for (const o of orders) {
      for (const side of o.sides || []) {
        const sn = typeof side === 'string' ? side : side?.name;
        const sq = typeof side === 'object' ? (side.quantity || 1) : 1;
        if (!sn) continue;
        liveCounts.set(sn, (liveCounts.get(sn) || 0) + sq);
      }
    }
    const flashed = [];
    for (const [name, count] of liveCounts) {
      const prev = lastSideCountsRef.current.get(name);
      if (prev !== undefined && count > prev) {
        flashSideRef.current.add(name);
        flashed.push(name);
      }
      lastSideCountsRef.current.set(name, count);
    }
    // Drop entries that no longer appear so we don't leak memory.
    for (const name of [...lastSideCountsRef.current.keys()]) {
      if (!liveCounts.has(name)) lastSideCountsRef.current.delete(name);
    }
    if (flashed.length === 0) return undefined;
    const t = setTimeout(() => {
      for (const name of flashed) flashSideRef.current.delete(name);
    }, 420);
    return () => clearTimeout(t);
  }, [orders]);

  // ── Touch-to-bump ────────────────────────────────────

  function cancelHold(orderId) {
    const t = holdTimersRef.current[orderId];
    if (t?.rafId) cancelAnimationFrame(t.rafId);
    delete holdTimersRef.current[orderId];
    setHoldProgress((prev) => (prev?.orderId === orderId ? null : prev));
  }

  async function commitBump(orderId, orderSnapshot) {
    optimisticallyBumpedRef.current.add(orderId);
    setHoldProgress(null);
    delete holdTimersRef.current[orderId];
    // Hint has done its job — silence it for the rest of the session.
    if (typeof window !== 'undefined') {
      try { window.sessionStorage.setItem('lcHintSeen', '1'); } catch { /* ignore */ }
    }
    setShowHoldHint(false);
    setBumpedToast({
      orderId,
      orderNum: orderSnapshot?.order_number || '—',
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    });
    try {
      const res = await fetch('/api/line-coach/bump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) throw new Error(`bump ${res.status}`);
    } catch {
      // Restore: realtime won't help us here since the row never moved
      optimisticallyBumpedRef.current.delete(orderId);
      setBumpedToast(null);
    }
  }

  function startHold(orderId, orderSnapshot) {
    if (!touchEnabled) return;
    if (optimisticallyBumpedRef.current.has(orderId)) return;
    if (holdTimersRef.current[orderId]) return;
    const startedAt = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startedAt;
      const pct = Math.min(1, elapsed / HOLD_DURATION_MS);
      setHoldProgress({ orderId, pct });
      if (pct >= 1) {
        commitBump(orderId, orderSnapshot);
        return;
      }
      holdTimersRef.current[orderId].rafId = requestAnimationFrame(tick);
    };
    holdTimersRef.current[orderId] = { startedAt, rafId: requestAnimationFrame(tick) };
  }

  async function handleUndo() {
    const t = bumpedToast;
    if (!t) return;
    setBumpedToast(null);
    optimisticallyBumpedRef.current.delete(t.orderId);
    try {
      await fetch('/api/line-coach/unbump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: t.orderId }),
      });
    } catch { /* realtime will reconcile on next fetch */ }
  }

  // Auto-clear the undo toast after the window expires.
  useEffect(() => {
    if (!bumpedToast) return undefined;
    const ms = Math.max(0, bumpedToast.expiresAt - Date.now());
    const timer = setTimeout(() => setBumpedToast(null), ms);
    return () => clearTimeout(timer);
  }, [bumpedToast]);

  // ── Data Processing ─────────────────────────────────

  const menuItems = config?.menu_items || [];
  const configSides = config?.sides || [];
  // Bilingual tips: array of { en, es }. Filter out fully empty tips so
  // the rotation never lands on a blank screen, and so legacy string-only
  // configs continue to work via normalizeTip.
  const tips = (config?.quality_tips || [])
    .map(normalizeTip)
    .filter((t) => (t.en && t.en.trim()) || (t.es && t.es.trim()));

  // Stale-ticket filter: Toast doesn't reliably send completed/voided
  // events for many orders, so without this active orders pile up
  // forever. Drop anything older than max_ticket_minutes from the
  // display (rows stay in the DB for analytics).
  const maxTicketMin = config?.hold_times?.max_ticket_minutes || 60;
  const apiOrderCount = orders.length;
  // eslint-disable-next-line no-redeclare, no-shadow-restricted-names
  const visibleOrders = orders.filter((o) => {
    // Hide optimistically-bumped orders so the card disappears the
    // instant the touch-hold completes, even before the realtime
    // postgres_changes event lands.
    if (o.id && optimisticallyBumpedRef.current.has(o.id)) return false;
    const t = new Date(o.toast_created_at || o.fire_at || o.created_at).getTime();
    if (!t || Number.isNaN(t)) return true;
    return (now.getTime() - t) / 60_000 < maxTicketMin;
  });
  const staleCount = apiOrderCount - visibleOrders.length;
  const isSlowPeriod = visibleOrders.length === 0;

  // Side Batching: aggregate sides across all active orders.
  //
  // Two sources are merged:
  //   1. order.sides — what the webhook already extracted (parsed from
  //      Toast modifiers and standalone side line items)
  //   2. order.items where the item NAME resolves to a known side
  //      (rare, but covers cases where Toast inlines a side as an
  //      item rather than a modifier — without this the kitchen
  //      misses prep volume)
  //
  // Critical correctness rules:
  //   - All names are run through canonicalSideName() so production
  //     typos like "Charred Brocolli" / "Brussels Sprouts" / "BUFFALO
  //     CAULIFLOWER" merge into one bucket. Every count must reflect
  //     reality or cooks lose trust in the alert.
  //   - We track which (orderId, canonicalName) pairs were already
  //     credited from the sides array so the items pass cannot
  //     double-count. The webhook already pushes standalone-side
  //     items into order.sides, so a naive second pass would add
  //     them twice.
  //   - configSides lookup is case-insensitive and uses the canonical
  //     name so cook_time / batch_size hits even when the configured
  //     side has a slightly different label than what Toast sent.
  function getBatchedSides() {
    const sideCounts = {};            // canonicalName → total qty
    // Track per (order id, canonical name) what we've already credited,
    // and HOW MUCH. Using a count rather than a boolean lets us still
    // capture additional contributions from the items pass when the
    // sides-pass entry was less than what's actually on the order
    // (rare, but defensive).
    const credited = new Map();       // `${orderId}::${canonicalName}` → qty already added
    const findConfig = (canonicalName) => {
      if (!canonicalName) return null;
      const lower = canonicalName.toLowerCase();
      return configSides.find((s) => (s?.name || '').toLowerCase() === lower) || null;
    };
    // Coerce quantity to a positive integer. Previously this used
    // Number.isFinite(side.quantity) which returns false for a string
    // like "3" — and any falsy result fell back to 1 — silently
    // undercounting if Toast ever shipped a stringified quantity.
    // Now: parse, default to 1 only if truly missing/NaN, never 0.
    const parseQty = (raw) => {
      if (raw === null || raw === undefined) return 1;
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n <= 0) return 1;
      return n;
    };
    // Build a stable key for an order even when fields are sparse.
    // `id` (UUID from DB) is the strongest signal; falls back to
    // order_number + toast_order_id; finally to a synthetic per-call
    // index so two ID-less orders never collide into the same bucket.
    let synth = 0;
    const orderKey = (o) => o?.id || o?.toast_order_id || o?.order_number || `__synth_${++synth}__`;

    for (const order of visibleOrders) {
      const oid = orderKey(order);
      for (const side of order.sides || []) {
        const rawName = side?.name || (typeof side === 'string' ? side : null);
        if (!rawName) continue;
        const canonical = canonicalSideName(rawName) || rawName;
        const qty = parseQty(side?.quantity);
        sideCounts[canonical] = (sideCounts[canonical] || 0) + qty;
        const key = `${oid}::${canonical}`;
        credited.set(key, (credited.get(key) || 0) + qty);
      }
    }
    // Catch sides that were inlined as items rather than pushed to
    // order.sides (rare, but covers Toast inlining a side as an item).
    // We still skip when the sides-pass already credited this
    // (orderId, canonicalName) since the webhook normally extracts both.
    for (const order of visibleOrders) {
      const oid = orderKey(order);
      for (const item of order.items || []) {
        if (!item?.name) continue;
        if (!isCanonicalSide(item.name)) continue;
        const canonical = canonicalSideName(item.name);
        if (!canonical) continue;
        const key = `${oid}::${canonical}`;
        if (credited.has(key)) continue;
        const qty = parseQty(item?.quantity);
        sideCounts[canonical] = (sideCounts[canonical] || 0) + qty;
        credited.set(key, qty);
      }
    }
    // Sort by cook time (longest first), then by count
    return Object.entries(sideCounts)
      .sort((a, b) => {
        const aCook = findConfig(a[0])?.cook_time || 0;
        const bCook = findConfig(b[0])?.cook_time || 0;
        if (bCook !== aCook) return bCook - aCook;
        return b[1] - a[1];
      });
  }

  // Timer thresholds — prefer brand-wide hold_times (the 8-min coach
  // band and 10-min brand-promise breach), fall back to legacy per-store
  // settings so existing customizations keep working until they're
  // migrated. Reading from hold_times keeps the display in lockstep
  // with the cleanup cron's 12-min cutoff (max_ticket_minutes).
  const warningMin = config?.hold_times?.sla_target_minutes
    ?? config?.settings?.ticket_warning_minutes
    ?? 8;
  const dangerMin = config?.hold_times?.sla_breach_minutes
    ?? config?.settings?.ticket_danger_minutes
    ?? 10;

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

    const orderList = visibleOrders
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
          // Carry the row id through so touch-to-bump and the
          // holdProgress check have a real comparison value.
          // Without this, holdProgress?.orderId === order.id collapsed
          // into undefined === undefined and crashed on .pct.
          id: order.id,
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
        <Header now={now} orderCount={0} staleCount={staleCount} />
        <div style={s.qualityCoach}>
          <div style={s.qualityLabel}>QUALITY COACH</div>
          <div style={s.qualityTipBlock} key={qualityTipIndex}>
            {/* Language labels removed — Playfair English vs italic
                cream Spanish is enough visual signal on a kitchen
                monitor. Less to read, faster to absorb. */}
            {enText && (
              <div style={s.qualityLangSection}>
                <div style={s.qualityTipEn}>{enText}</div>
              </div>
            )}
            {enText && esText && <div style={s.qualityDivider} />}
            {esText && (
              <div style={s.qualityLangSection}>
                <div style={{ ...s.qualityTipEs, fontStyle: 'italic' }}>{esText}</div>
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

  // Density tier — adapts the layout to current order load.
  //   1 visible       → focus mode (giant photo + entree-specific coach tip)
  //   2-3 visible     → comfortable mode (existing layout, ~50% taller rows)
  //   4+ visible      → rush mode (today's dense layout, unchanged)
  // Future-only orders are excluded from focus mode by design — we don't
  // want to lock the screen onto a dish 4 hours before it fires.
  const visibleNow = orderSequence.filter((o) => !o.isFutureOrder);
  const density = visibleNow.length === 1 ? 'focus'
    : (visibleNow.length >= 2 && visibleNow.length <= 3) ? 'comfortable'
    : 'rush';

  // ── Focus mode ──────────────────────────────────────
  // Single order on the board: huge photo on the left, big readable
  // detail in the middle, entree-specific coaching on the right.
  // Hides side-batching panel and quick-tip sidebar since one order
  // doesn't need the chrome.
  if (density === 'focus') {
    const order = visibleNow[0];
    // Order items by longest-cook-time first so the rotation starts with
    // the most attention-demanding dish, then cycles through every item.
    const orderedItems = [...order.items].sort((a, b) => (b.cookTime || 0) - (a.cookTime || 0));
    // Rotate through items every focus_rotation_seconds (default 8s).
    // Single-item orders just sit on item 0 forever (no animation churn).
    const itemCount = Math.max(1, orderedItems.length);
    const primaryItem = orderedItems[focusItemIndex % itemCount] || orderedItems[0];
    const secondaryItems = orderedItems.filter((it) => it !== primaryItem);
    const primaryMenu = menuItems.find((m) => m.name === primaryItem?.name);
    const primaryCoachTip = primaryMenu?.coach_tip ? normalizeTip(primaryMenu.coach_tip) : null;
    // Fallback to a rotating store-level quality tip when the focused
    // item has no coach_tip configured yet.
    const fallbackTip = (!primaryCoachTip || (!primaryCoachTip.en && !primaryCoachTip.es))
      ? (tips.length > 0 ? tips[qualityTipIndex % tips.length] : null)
      : null;
    const tipToShow = primaryCoachTip && (primaryCoachTip.en || primaryCoachTip.es)
      ? primaryCoachTip
      : fallbackTip;
    const tipEn = tipToShow?.en && tipToShow.en.trim();
    const tipEs = tipToShow?.es && tipToShow.es.trim();

    const ticketBorderColor = order.priority === 'rush' ? BRAND.red : order.ticketColor;
    const diningColors = {
      'dine in': BRAND.gold,
      'takeout': BRAND.blue,
      'delivery': BRAND.cream,
    };
    const diningLabel = order.diningOption || '';
    const diningColor = diningColors[diningLabel.toLowerCase()] || BRAND.blue;
    const sidesText = order.sides.map((side) => {
      const sn = typeof side === 'string' ? side : side.name;
      const sq = side.quantity || 1;
      return sq > 1 ? `${sq}x ${sn}` : sn;
    }).join(', ');
    const allergyNote = isAllergyNote(order.notes) ? order.notes : null;
    const inlineNote = allergyNote ? null : order.notes;
    const sourceLabel = order.priority === 'rush' ? 'ASAP' : (diningLabel ? diningLabel.toUpperCase() : null);

    return (
      <div style={s.container}>
        <style>{`
          @keyframes lcAllergyPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.85); }
            50%      { box-shadow: 0 0 0 8px rgba(214, 69, 69, 0); }
          }
          /* Focus mode photo crossfade — was opacity-only; now adds a
             subtle scale-down (1.03 → 1.0) so the dish photo settles
             into place rather than fading flat. Premium feel for the
             single-order canvas. */
          @keyframes lcFocusFade {
            from { opacity: 0; transform: scale(1.03); }
            to   { opacity: 1; transform: scale(1);    }
          }
        `}</style>
        <Header now={now} orderCount={1} />

        {allergyNote && (
          <div style={{
            background: BRAND.red,
            color: BRAND.white,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 800,
            letterSpacing: '3px',
            textTransform: 'uppercase',
            fontSize: 'clamp(1.6rem, 2.5vw, 2.4rem)',
            padding: '14px 24px',
            margin: '12px 16px 0 16px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            animation: 'lcAllergyPulse 1.4s ease-in-out infinite',
          }}>
            <span style={{ fontSize: '2rem' }}>⚠</span>
            <span>ALLERGY</span>
            <span style={{ textTransform: 'none', letterSpacing: '0.5px', fontWeight: 700 }}>{trimAllergyPrefix(allergyNote)}</span>
          </div>
        )}

        {/* Top strip: order #, customer, dining, timer */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '24px',
          padding: '12px 24px 8px',
          borderBottom: `2px solid ${BRAND.gold}40`,
          margin: '0 16px',
        }}>
          <div style={{
            background: ticketBorderColor,
            color: BRAND.charcoal,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 800,
            fontSize: 'clamp(1.6rem, 2.4vw, 2.4rem)',
            padding: '8px 18px',
            borderRadius: '6px',
            letterSpacing: '2px',
          }}>#{order.orderNum}</div>
          {order.customerName && (
            <div style={{
              fontSize: 'clamp(1.4rem, 2.2vw, 2rem)',
              color: BRAND.bone,
              fontFamily: "'Open Sans', sans-serif",
              fontWeight: 600,
            }}>{order.customerName}</div>
          )}
          {sourceLabel && (
            <div style={{
              background: order.priority === 'rush' ? BRAND.red : diningColor,
              color: BRAND.charcoal,
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: 'clamp(1rem, 1.4vw, 1.4rem)',
              padding: '6px 14px',
              borderRadius: '4px',
              letterSpacing: '2px',
            }}>{sourceLabel}</div>
          )}
          <div style={{ flex: 1 }} />
          <div style={{
            fontSize: 'clamp(1.8rem, 3vw, 3rem)',
            color: ticketBorderColor,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}>{order.elapsedDisplay}</div>
        </div>

        {/* Two-column body: photo + coach tip ─────────── */}
        {/* `key` includes the rotating item index so each rotation
            re-mounts the block and triggers the fade-in animation. */}
        <div key={`focus-${focusItemIndex % itemCount}`} style={{
          display: 'flex',
          gap: '24px',
          padding: '16px',
          minHeight: 'calc(100vh - 200px)',
          animation: 'lcFocusFade 420ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}>
          {/* Left: photo + entree name + sides + modifiers */}
          <div style={{
            flex: '1 1 55%',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            minWidth: 0,
          }}>
            <img
              src={getSideImageUrl(primaryItem?.name || '', menuItems, configSides)}
              alt={primaryItem?.name || ''}
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                maxHeight: '46vh',
                objectFit: 'cover',
                borderRadius: '12px',
                background: BRAND.charcoalDark,
              }}
              onError={(e) => { e.target.style.display = 'none'; }}
            />
            <div style={{
              fontSize: 'clamp(2.4rem, 4vw, 4.5rem)',
              fontWeight: 800,
              color: BRAND.bone,
              fontFamily: "'Oswald', sans-serif",
              textTransform: 'uppercase',
              lineHeight: 1.1,
            }}>
              {primaryItem?.quantity > 1 && (
                <span style={{ color: BRAND.gold, marginRight: '14px' }}>{primaryItem.quantity}x</span>
              )}
              {primaryItem?.name}
            </div>
            {primaryItem?.modifiers?.length > 0 && (
              <div style={{
                fontSize: 'clamp(1.4rem, 2.2vw, 2.2rem)',
                fontWeight: 700,
                color: BRAND.white,
                fontFamily: "'Open Sans', sans-serif",
                lineHeight: 1.25,
              }}>{primaryItem.modifiers.join(' · ')}</div>
            )}
            {sidesText && (
              <div style={{
                fontSize: 'clamp(1.2rem, 1.9vw, 1.9rem)',
                color: BRAND.white,
                fontWeight: 700,
                fontFamily: "'Open Sans', sans-serif",
              }}>w/ {sidesText}</div>
            )}
            {inlineNote && (
              <div style={{
                fontSize: 'clamp(1.2rem, 1.9vw, 1.9rem)',
                color: BRAND.gold,
                fontWeight: 700,
                fontFamily: "'Open Sans', sans-serif",
              }}>⚠ {inlineNote}</div>
            )}
            {secondaryItems.length > 0 && (
              <div style={{
                marginTop: '10px',
                paddingTop: '12px',
                borderTop: `1px solid ${BRAND.gold}40`,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}>
                <div style={{
                  fontSize: '0.95rem',
                  color: BRAND.gold,
                  fontFamily: "'Oswald', sans-serif",
                  letterSpacing: '2px',
                  textTransform: 'uppercase',
                }}>Also on order</div>
                {secondaryItems.map((it, idx) => (
                  <div key={idx} style={{
                    fontSize: 'clamp(1.1rem, 1.5vw, 1.5rem)',
                    color: BRAND.bone,
                    fontFamily: "'Oswald', sans-serif",
                    textTransform: 'uppercase',
                    fontWeight: 700,
                  }}>
                    {it.quantity > 1 && (
                      <span style={{ color: BRAND.gold, marginRight: '8px' }}>{it.quantity}x</span>
                    )}
                    {it.name}
                    {it.modifiers?.length > 0 && (
                      <span style={{
                        color: BRAND.cream,
                        fontWeight: 500,
                        textTransform: 'none',
                        marginLeft: '10px',
                        fontFamily: "'Open Sans', sans-serif",
                      }}> · {it.modifiers.join(' · ')}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: entree-specific coaching (or fallback quality tip) */}
          <div style={{
            flex: '1 1 45%',
            display: 'flex',
            flexDirection: 'column',
            background: BRAND.charcoalDark,
            borderRadius: '12px',
            padding: '24px 28px',
            borderLeft: `4px solid ${BRAND.gold}`,
            minHeight: 0,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              marginBottom: '18px',
            }}>
              <div style={{
                fontSize: 'clamp(0.95rem, 1.2vw, 1.3rem)',
                color: BRAND.gold,
                fontFamily: "'Oswald', sans-serif",
                fontWeight: 700,
                letterSpacing: '4px',
              }}>
                {primaryCoachTip && (primaryCoachTip.en || primaryCoachTip.es) ? 'COACH' : 'QUALITY COACH'}
              </div>
              {/* Rotation dots — only show when there's more than one item
                  so the cook knows the panel cycles through every dish. */}
              {itemCount > 1 && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: 'auto' }}>
                  {orderedItems.map((_, di) => (
                    <div key={di} style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: di === (focusItemIndex % itemCount) ? BRAND.gold : `${BRAND.gold}40`,
                      transition: 'background 200ms',
                    }} />
                  ))}
                </div>
              )}
            </div>
            {/* EN and ES blocks — typography (color + size) already
                differentiates the languages, so explicit ENGLISH /
                ESPAÑOL labels are pure noise on a kitchen monitor. */}
            {tipEn && (
              <div style={{
                marginBottom: tipEs ? 'clamp(1.5vh, 2vh, 3vh)' : 0,
                fontSize: 'clamp(1.6rem, 2.6vw, 2.6rem)',
                color: BRAND.bone,
                fontFamily: "'Playfair Display', Georgia, serif",
                lineHeight: 1.3,
              }}>{tipEn}</div>
            )}
            {tipEn && tipEs && (
              <div style={{
                width: '40%',
                height: '1px',
                background: `${BRAND.gold}55`,
                margin: 'clamp(1vh, 1.5vh, 2vh) 0',
              }} />
            )}
            {tipEs && (
              <div style={{
                fontSize: 'clamp(1.4rem, 2.3vw, 2.3rem)',
                color: BRAND.cream,
                fontFamily: "'Playfair Display', Georgia, serif",
                lineHeight: 1.3,
                fontStyle: 'italic',
              }}>{tipEs}</div>
            )}
            {!tipEn && !tipEs && (
              <div style={{
                fontSize: 'clamp(1.2rem, 1.6vw, 1.6rem)',
                color: BRAND.cream,
                fontFamily: "'Playfair Display', Georgia, serif",
                fontStyle: 'italic',
                opacity: 0.5,
              }}>—</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <style>{`
        @keyframes lcAllergyPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.85); }
          50%      { box-shadow: 0 0 0 8px rgba(214, 69, 69, 0); }
        }
        /* Touch-era polish keyframes. Each is intentionally subtle —
           a kitchen monitor running 11 hours/day shouldn't strobe. */
        @keyframes lcOrderEnter {
          from { opacity: 0; transform: translateY(-12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
        /* Red-band SLA pulse: slower (2.4s) and dimmer than the
           allergy pulse (1.4s, 85% alpha) so they don't compete on
           a card that's both over-SLA and has an allergy note. */
        @keyframes lcSlaPulse {
          0%, 100% { box-shadow: inset 4px 0 0 ${BRAND.red}, 0 0 0 1px ${BRAND.red}55, 0 0 28px ${BRAND.red}40, 0 4px 12px rgba(0,0,0,0.25); }
          50%      { box-shadow: inset 4px 0 0 ${BRAND.red}, 0 0 0 1px ${BRAND.red}66, 0 0 36px ${BRAND.red}55, 0 4px 12px rgba(0,0,0,0.25); }
        }
        /* Hint pill: 1s delay, 600ms fade-in, 5.4s hold, 1s fade-out.
           "forwards" so it stays hidden after the animation. */
        @keyframes lcHintFade {
          0%   { opacity: 0; }
          10%  { opacity: 1; }
          80%  { opacity: 1; }
          100% { opacity: 0; }
        }
        /* Side-batch count tick-up — gentle overshoot draws attention
           to the digit changing without being distracting. */
        @keyframes lcCountBump {
          0%   { transform: scale(1);   color: ${BRAND.gold}; }
          40%  { transform: scale(1.18); color: ${BRAND.white}; }
          100% { transform: scale(1);   color: ${BRAND.gold}; }
        }
      `}</style>
      <Header now={now} orderCount={visibleOrders.length} staleCount={staleCount} />
      {bumpedToast && (
        <UndoToast orderNum={bumpedToast.orderNum} onUndo={handleUndo} />
      )}

      <div style={s.mainGrid}>
        {/* Left Column: Fire Order — grouped by order */}
        <div style={s.leftCol}>
          <div style={s.sidesContainer}>
            {orderSequence.length === 0 && (
              <div style={{ ...s.emptyState, fontSize: '1.5rem' }}>Clear</div>
            )}
            {(() => {
              const diningColors = {
                'dine in': BRAND.gold,
                'takeout': BRAND.blue,
                'delivery': BRAND.cream,
              };

              // Density tier from outer scope drives row sizing.
              //   comfortable (2-3 visible) → bigger photo / text, ~50% taller rows
              //   rush (4+ visible)         → today's compact dense layout
              const isComfortable = density === 'comfortable';
              // Touch-era cap: rush max went 8 → 6 because 22" wall-mount
              // taps need ≥60px targets (was 48px). Better to scroll past
              // 6 than to mis-tap the wrong card with greasy hands.
              const MAX_VISIBLE = isComfortable ? 3 : 6;
              const visibleOrders = orderSequence.slice(0, MAX_VISIBLE);
              const hiddenCount = orderSequence.length - MAX_VISIBLE;
              // Density-driven sizes (in px / rem). Rush values were
              // bumped for touch ergonomics (sidebar 80→96, photo
              // 48→60, padding 6→10) so every card is a confident tap
              // target on the 22" wall-mounted touchscreen.
              const rowPad = isComfortable ? '14px 0' : '10px 0';
              const sidebarW = isComfortable ? '110px' : '96px';
              const orderNumSize = isComfortable ? '1.4rem' : '1rem';
              const customerSize = isComfortable ? '0.95rem' : '0.7rem';
              const badgeSize = isComfortable ? '0.85rem' : '0.65rem';
              const timerSize = isComfortable ? '1.6rem' : '1.1rem';
              const photoSize = isComfortable ? '110px' : '60px';
              const entreeNameSize = isComfortable ? '2.2rem' : '1.5rem';
              // Modifier + sides line are now BIGGER than the entree
              // name in rush mode and matched-or-larger in comfortable.
              // Cooks identify the dish from the photo first; the
              // critical "no nuts / sub chicken / extra salsa /
              // w/ Spanish Rice + Kale Slaw" detail is what they
              // actually need to read from across the line. Quality
              // accuracy depends on these being legible at distance.
              const modifierSize = isComfortable ? '2.1rem' : '1.7rem';
              const sidesLineSize = isComfortable ? '2.1rem' : '1.7rem';
              const sidesIndent = isComfortable ? '124px' : '58px';

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

                    // Guard against undefined collision: if order.id is
                    // undefined (e.g. fresh from getOrderSequence before
                    // realtime confirms), holdProgress?.orderId === undefined
                    // would be `undefined === undefined` → true, then
                    // crash reading .pct on a null holdProgress.
                    const isHolding = !!holdProgress
                      && order.id != null
                      && holdProgress.orderId === order.id;
                    const holdPct = isHolding ? holdProgress.pct : 0;
                    const orderHandlers = touchEnabled && order.id ? {
                      onPointerDown: (e) => {
                        // Ignore right-clicks / multi-touch beyond first finger
                        if (e.button && e.button !== 0) return;
                        startHold(order.id, order);
                      },
                      onPointerUp: () => cancelHold(order.id),
                      onPointerLeave: () => cancelHold(order.id),
                      onPointerCancel: () => cancelHold(order.id),
                    } : {};

                    // SLA visual band moves from sidebar's hard
                    // border-left to a card-level box-shadow stack:
                    // soft inset rail (color-coded), thin outer ring,
                    // and outer glow so the band feels like presence
                    // rather than a stripe. Green steady-state has
                    // no shadow — only aging orders earn glow.
                    // Rush priority always renders red regardless of age.
                    const isAmber = !order.isFutureOrder
                      && order.priority !== 'rush'
                      && order.elapsedMinutes >= warningMin
                      && order.elapsedMinutes < dangerMin;
                    const isRed = !order.isFutureOrder
                      && (order.priority === 'rush' || order.elapsedMinutes >= dangerMin);
                    const cardShadow = isRed
                      ? `inset 4px 0 0 ${BRAND.red}, 0 0 0 1px ${BRAND.red}55, 0 0 28px ${BRAND.red}40, 0 4px 12px rgba(0,0,0,0.25)`
                      : isAmber
                        ? `inset 4px 0 0 ${BRAND.yellow}, 0 0 0 1px ${BRAND.yellow}40, 0 0 18px ${BRAND.yellow}25, 0 4px 12px rgba(0,0,0,0.25)`
                        : `inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 12px rgba(0,0,0,0.25)`;
                    return (
                      <div key={order.id || oi}
                        data-fresh={freshOrderIdsRef.current.has(order.id) ? '1' : undefined}
                        {...orderHandlers}
                        style={{
                          marginTop: oi > 0 ? '8px' : 0,
                          padding: rowPad,
                          position: 'relative',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                          touchAction: touchEnabled ? 'none' : 'auto',
                          background: isHolding
                            ? `linear-gradient(90deg, ${BRAND.green}40 ${holdPct * 100}%, ${BRAND.charcoal} ${holdPct * 100}%)`
                            : BRAND.charcoal,
                          borderRadius: '10px',
                          boxShadow: cardShadow,
                          transform: isHolding ? 'scale(0.985)' : 'scale(1)',
                          // Lane-change band cross-fade: 600ms on shadow
                          // so green→amber→red transitions glide rather
                          // than snap. Hold gesture keeps its instant
                          // response (no transition while holding).
                          transition: isHolding
                            ? 'none'
                            : 'box-shadow 600ms ease-out, transform 120ms ease-out, background 0.3s',
                          animation: freshOrderIdsRef.current.has(order.id)
                            ? 'lcOrderEnter 280ms cubic-bezier(0.2, 0.8, 0.2, 1)'
                            : undefined,
                          ...(isRed && order.priority !== 'rush' ? {
                            // Soft pulse on the red band only — slower
                            // (2.4s) and dimmer than allergy pulse so
                            // the two don't compete on the same card.
                            animationName: 'lcSlaPulse',
                            animationDuration: '2.4s',
                            animationIterationCount: 'infinite',
                            animationTimingFunction: 'ease-in-out',
                          } : {}),
                        }}>
                      {isHolding && (
                        <div style={{
                          position: 'absolute',
                          top: '8px',
                          right: '12px',
                          background: BRAND.green,
                          color: BRAND.charcoalDark,
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 700,
                          letterSpacing: '1.5px',
                          textTransform: 'uppercase',
                          fontSize: '0.85rem',
                          padding: '4px 12px',
                          borderRadius: '999px',
                          zIndex: 10,
                        }}>
                          Hold to bump · {Math.round(holdPct * 100)}%
                        </div>
                      )}
                      {/* One-time hint pill for the first card of a
                          fresh session — fades in at 1s, out at 8s,
                          and never returns once the cook bumps once
                          (sessionStorage 'lcHintSeen'). Only renders
                          on the FIRST visible order so we don't
                          clutter every card. */}
                      {oi === 0 && touchEnabled && order.id && showHoldHint && (
                        <div style={{
                          position: 'absolute',
                          bottom: '10px',
                          right: '14px',
                          background: 'rgba(212, 165, 116, 0.18)',
                          color: BRAND.gold,
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 700,
                          letterSpacing: '1.5px',
                          textTransform: 'uppercase',
                          fontSize: '0.85rem',
                          padding: '6px 12px',
                          borderRadius: '999px',
                          pointerEvents: 'none',
                          animation: 'lcHintFade 8s ease-in-out 1s forwards',
                          zIndex: 10,
                        }}>
                          Hold card to bump
                        </div>
                      )}
                      {allergyNote && (
                        <div style={{
                          background: BRAND.red,
                          color: BRAND.white,
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 700,
                          letterSpacing: '2px',
                          textTransform: 'uppercase',
                          fontSize: isComfortable ? '1.8rem' : '1.5rem',
                          padding: isComfortable ? '12px 20px' : '8px 16px',
                          marginBottom: '6px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          animation: 'lcAllergyPulse 1.4s ease-in-out infinite',
                        }}>
                          <span style={{ fontSize: '1.7rem' }}>⚠</span>
                          <span style={{ fontWeight: 800 }}>ALLERGY</span>
                          <span style={{ textTransform: 'none', letterSpacing: '0.5px', fontWeight: 600 }}>{trimAllergyPrefix(allergyNote)}</span>
                        </div>
                      )}
                      <div style={{
                        display: 'flex',
                      }}>
                        {/* Left sidebar: check info + timer.
                            SLA band moved from this sidebar's
                            border-left to a card-level box-shadow,
                            so this column is now a clean transparent
                            zone — the timer color and the card glow
                            carry the SLA signal together. */}
                        <div style={{
                          width: sidebarW,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '6px 4px',
                          flexShrink: 0,
                          gap: '3px',
                        }}>
                          <div style={{
                            fontSize: orderNumSize,
                            fontWeight: 700,
                            color: BRAND.bone,
                            fontFamily: "'Oswald', sans-serif",
                          }}>#{order.orderNum}</div>
                          {order.customerName && (
                            <div style={{
                              fontSize: customerSize,
                              color: BRAND.cream,
                              fontFamily: "'Open Sans', sans-serif",
                              textAlign: 'center',
                              lineHeight: 1.2,
                            }}>{order.customerName}</div>
                          )}
                          {order.priority === 'rush' && (
                            <div style={{
                              fontSize: badgeSize,
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
                              fontSize: badgeSize,
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
                              fontSize: badgeSize,
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
                              fontSize: timerSize,
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
                                  width: photoSize,
                                  height: photoSize,
                                  objectFit: 'cover',
                                  borderRadius: '50%',
                                  flexShrink: 0,
                                }}
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                              <div style={{
                                fontSize: entreeNameSize,
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
                                  fontSize: modifierSize,
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
                              fontSize: sidesLineSize,
                              lineHeight: 1.3,
                              paddingLeft: sidesIndent,
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
                      fontSize: '1.4rem',
                      fontWeight: 700,
                      letterSpacing: '2px',
                    }}>
                      + {hiddenCount}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Right Column: Side Batching */}
        <div style={s.rightCol}>
          <div style={s.sidesPanelHeader}>SIDES</div>
          <div style={s.sidesContainer}>
            {batchedSides.length === 0 && (
              <div style={s.emptyState}>—</div>
            )}
            {batchedSides.map(([name, count]) => {
              // Case-insensitive lookup so the configured side row is
              // found even if it's labeled slightly differently than
              // the canonical name we resolved to.
              const lower = (name || '').toLowerCase();
              const sideConfig = configSides.find((sc) => (sc?.name || '').toLowerCase() === lower);
              const batchSize = sideConfig?.batch_size || 4;
              const batchesNeeded = Math.ceil(count / batchSize);
              const cookTime = sideConfig?.cook_time || 0;
              const imageUrl = getSideImageUrl(name, menuItems, configSides);

              // Flash flag is computed in the side-count effect below
              // (stable ref read during render is safe; mutations live
              // outside of render to avoid setTimeout-during-render).
              const isFlashing = flashSideRef.current.has(name);

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
                    {batchesNeeded > 1 && (
                      <div style={{
                        // Line Coach is for quality + accuracy, NOT
                        // fire-timing (Toast KDS already handles that).
                        // Show the batch count as a quiet quality nudge:
                        // "you'll need 2 batches of this side, build to
                        // batch_size for consistency" — no verbs, no
                        // minutes. We only show it when batches > 1
                        // since a single batch is the default mental
                        // model and doesn't need reinforcement.
                        fontSize: `clamp(0.7rem, ${actionSize}, 1.1rem)`,
                        fontWeight: 700,
                        color: BRAND.gold,
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: '1px',
                        marginTop: '2px',
                        opacity: 0.85,
                      }}>
                        {batchesNeeded} BATCHES
                      </div>
                    )}
                  </div>
                  <div
                    key={isFlashing ? `${name}-${count}` : name}
                    style={{
                      fontSize: `clamp(2rem, ${countSize}, 6rem)`,
                      fontWeight: 700,
                      color: BRAND.gold,
                      fontFamily: "'Oswald', sans-serif",
                      lineHeight: 1,
                      flexShrink: 0,
                      textAlign: 'right',
                      // Inline-block so transform: scale() doesn't blow
                      // out the parent flex layout when the digit pops.
                      display: 'inline-block',
                      animation: isFlashing
                        ? 'lcCountBump 380ms cubic-bezier(0.34, 1.56, 0.64, 1)'
                        : undefined,
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
                  <div style={s.quickTipText}>{enText}</div>
                )}
                {esText && (
                  <div style={{ ...s.quickTipTextEs, fontStyle: 'italic', marginTop: enText ? '8px' : 0 }}>{esText}</div>
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

function UndoToast({ orderNum, onUndo }) {
  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: 1000,
      background: BRAND.charcoalDark,
      border: `2px solid ${BRAND.gold}`,
      borderRadius: '12px',
      padding: '12px 16px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      minWidth: '260px',
      animation: 'lcUndoIn 0.2s ease-out',
    }}>
      <style>{`
        @keyframes lcUndoIn {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{ flex: 1 }}>
        <div style={{
          color: BRAND.green,
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
          fontSize: '0.7rem',
          fontWeight: 700,
        }}>
          Bumped
        </div>
        <div style={{
          color: BRAND.bone,
          fontFamily: "'Oswald', sans-serif",
          fontSize: '1rem',
          fontWeight: 600,
        }}>
          Order #{orderNum}
        </div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        style={{
          background: BRAND.gold,
          color: BRAND.charcoal,
          border: 'none',
          padding: '8px 16px',
          borderRadius: '999px',
          cursor: 'pointer',
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
          fontSize: '0.85rem',
          touchAction: 'manipulation',
        }}
      >
        Undo
      </button>
    </div>
  );
}

function Header({ now, orderCount, staleCount = 0 }) {
  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        {/* Brand logo replaces the wordmark. Sized by height so the
            ~4.18:1 logo image scales cleanly. onError falls back to
            the WILDBIRD text wordmark in case the asset is missing. */}
        <img
          src="/WILDBIRD-LOGO-WHITE.png"
          alt="WILDBIRD"
          style={{ height: '36px', width: 'auto', display: 'block' }}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            const fallback = e.currentTarget.nextElementSibling;
            if (fallback) fallback.style.display = '';
          }}
        />
        <span style={{ ...s.title, display: 'none' }}>WILDBIRD</span>
      </div>
      <div style={s.headerCenter}>
        <span style={s.ticketCount}>
          {orderCount} {orderCount === 1 ? 'ORDER' : 'ORDERS'}
        </span>
        {staleCount > 0 && (
          <span style={{
            marginLeft: '12px',
            padding: '2px 8px',
            borderRadius: '999px',
            background: 'rgba(232, 220, 200, 0.12)',
            color: BRAND.cream,
            fontSize: '0.7rem',
            fontFamily: "'Oswald', sans-serif",
            letterSpacing: '1px',
            textTransform: 'uppercase',
            fontWeight: 700,
            verticalAlign: 'middle',
          }}>
            +{staleCount} hidden
          </span>
        )}
      </div>
      <span style={s.clock}>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
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
  headerLeft: { display: 'flex', alignItems: 'center', gap: '8px' },
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
