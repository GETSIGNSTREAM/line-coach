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

// Pick the chosen-language string from a normalized tip, falling back
// silently to the other language when the chosen one is empty. Used by
// every bilingual render site so the language toggle behaves
// identically across Quality Coach mode, focus-mode coach panel, side
// quick tip, and the order detail sheet.
//
// Returns null only when BOTH sides are empty — caller should suppress.
function pickTipText(tip, lang) {
  if (!tip) return null;
  const en = tip.en && tip.en.trim();
  const es = tip.es && tip.es.trim();
  if (lang === 'en') return en || es || null;
  return es || en || null;
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

// Per-station color palette for the routing badges on each item.
// Lets a cook on a specific station scan a column of cards and find
// what's theirs without parsing item names. Stations come from
// brand_config.menu_items[].station — only items configured there
// get a badge. Toast variants we haven't mapped silently render no
// badge (better than confidently labeling them wrong).
const STATION_STYLES = {
  oven:     { background: `${BRAND.cream}30`,      color: BRAND.cream,      border: `1px solid ${BRAND.cream}55` },
  grill:    { background: `${BRAND.terracotta}30`, color: BRAND.terracotta, border: `1px solid ${BRAND.terracotta}55` },
  fryer:    { background: `${BRAND.gold}30`,       color: BRAND.gold,       border: `1px solid ${BRAND.gold}55` },
  line:     { background: `${BRAND.blue}30`,       color: '#9CC4D2',        border: `1px solid ${BRAND.blue}55` },
  cold:     { background: 'transparent',           color: BRAND.bone,       border: `1px solid ${BRAND.bone}55` },
  hot_hold: { background: `${BRAND.cream}20`,      color: BRAND.cream,      border: `1px solid ${BRAND.cream}40` },
  grab:     { background: 'transparent',           color: `${BRAND.cream}80`, border: `1px solid ${BRAND.cream}40` },
};

const STATION_LABELS = {
  oven: 'OVEN',
  grill: 'GRILL',
  fryer: 'FRYER',
  line: 'LINE',
  cold: 'COLD',
  hot_hold: 'HOT HOLD',
  grab: 'GRAB',
};

// Pull the station for an item by exact-name lookup. Returns null when
// the item isn't in brand config so the renderer can skip the badge.
function stationFor(itemName, menuItems) {
  if (!itemName) return null;
  const m = (menuItems || []).find((mi) => mi?.name === itemName);
  return m?.station || null;
}

// Per-channel color palette — each courier renders in ITS OWN brand
// color so cooks recognize the badge from muscle memory (the same
// red they see in the DoorDash app is the same red on the card).
// 22% alpha fill + full-saturation border/text keeps the badge
// visible on the dark charcoal card background without blowing out.
// Postmates is the exception (black bg + yellow text) since black-
// on-yellow IS its brand identity.
//
// Hex sources (Nov 2024 brand kits):
//   DoorDash:  #FF3008 — the iconic delivery red
//   UberEats:  #06C167 — "Eats green" (distinct from WILDBIRD green)
//   Grubhub:   #F26B30 — long-running orange identity
//   Postmates: #FFD000 on #000 — yellow-on-black is the wordmark
//
// Text colors are slightly lightened from the pure brand hex so they
// read cleanly on charcoal — the eye still locks onto the right
// brand, but with WCAG-passing contrast.
const CHANNEL_STYLES = {
  doordash:  { background: 'rgba(255, 48, 8, 0.22)',   color: '#FF6B4A', border: '1px solid rgba(255, 48, 8, 0.55)' },
  ubereats:  { background: 'rgba(6, 193, 103, 0.22)',  color: '#3FD98E', border: '1px solid rgba(6, 193, 103, 0.55)' },
  grubhub:   { background: 'rgba(242, 107, 48, 0.22)', color: '#F58A5C', border: '1px solid rgba(242, 107, 48, 0.55)' },
  postmates: { background: '#000000',                  color: '#FFD000', border: '1px solid rgba(255, 208, 0, 0.55)' },
};

const CHANNEL_LABELS = {
  doordash: 'DOORDASH',
  ubereats: 'UBER',
  grubhub: 'GRUBHUB',
  postmates: 'POSTMATES',
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

// Classify a single Toast modifier string. Drives the modifier list's
// visual hierarchy on every order surface:
//   critical — deviations the customer asked for ("No Onions", "Sub
//     Chicken", "Extra Salsa", "Light Sauce", "Without Garlic", "On the
//     Side"). Missing one of these is what turns into a remade dish,
//     so they render in gold so cooks lock on first.
//   cosmetic — text that restates the menu default and adds noise
//     without information ("Regular X", "Standard X", "Default", "No
//     Modifications", "None"). Hidden entirely — they were the main
//     reason long modifier strings dominated cards in Hollywood feedback.
//   normal — a genuine selection that isn't a deviation (e.g. "Brown
//     Rice", "Chipotle Aioli"). Still important to the cook, just not
//     elevated above other modifiers.
//
// Regexes are intentionally verb-first / first-word matches so a
// modifier like "Chipotle Sauce" doesn't get flagged critical just
// because it contains the word "sauce". Order matters — cosmetic
// patterns run first so "Regular No-Cheese" (unlikely but possible)
// stays cosmetic rather than promoting to critical.
function classifyModifier(text) {
  if (!text || typeof text !== 'string') return 'cosmetic';
  const t = text.trim();
  if (!t) return 'cosmetic';
  if (/^(?:no\s+modifications?|none|n\/a|default|standard)$/i.test(t)) return 'cosmetic';
  if (/^(?:regular|standard|default)\s+\w/i.test(t)) return 'cosmetic';
  if (/^(?:no|sub|substitute|swap|add|extra|light|heavy|without|hold|w\/o|w\/?out)\b/i.test(t)) return 'critical';
  if (/^(?:on\s+the\s+side|side\s+of|side\s*[-–])\b/i.test(t)) return 'critical';
  return 'normal';
}

// Filter + classify a raw modifier array. Returns an array of
// { raw, kind } entries with cosmetic restate-default entries removed.
// Shared by ModifierLines (cards / detail sheet / focus primary) and
// the focus-mode secondary-items list (which still renders inline).
function visibleModifiers(modifiers) {
  return (modifiers || [])
    .map((m) => ({ raw: typeof m === 'string' ? m : String(m ?? ''), kind: classifyModifier(m) }))
    .filter((m) => m.kind !== 'cosmetic' && m.raw);
}

// Render a modifier list as one line per modifier with critical
// deviations colored gold. Used by the rush + comfortable card, the
// focus-mode hero, and the order detail sheet so every surface
// presents modifiers with the same visual hierarchy.
function ModifierLines({ modifiers, size, fontWeight = 700, fontFamily = "'Open Sans', sans-serif", normalColor = BRAND.white, criticalColor = BRAND.gold, gap = '2px', style = {} }) {
  const list = visibleModifiers(modifiers);
  if (list.length === 0) return null;
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap,
      minWidth: 0,
      ...style,
    }}>
      {list.map((m, i) => {
        // Critical deviations (no/sub/add/on-the-side) are accuracy
        // risks — a remake if missed. Render them as a filled chip with
        // a caution glyph so they're impossible to blow past in a rush,
        // not just gold text. Normal modifiers stay plain.
        const isCritical = m.kind === 'critical';
        return (
          <div key={i} style={{
            fontSize: size,
            fontWeight,
            color: isCritical ? BRAND.charcoalDark : normalColor,
            fontFamily,
            lineHeight: 1.2,
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            ...(isCritical ? {
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '0.35em',
              alignSelf: 'flex-start',
              background: criticalColor,
              padding: '1px 0.5em',
              borderRadius: '4px',
            } : {}),
          }}>
            {isCritical && <span aria-hidden="true" style={{ fontSize: '0.82em', lineHeight: 1 }}>▲</span>}
            <span>{m.raw}</span>
          </div>
        );
      })}
    </div>
  );
}

// Per-item accuracy guardrail ("common miss"). Pulls the optional
// bilingual menu_items[].accuracy_note and renders a compact caution
// line so the line catches the dish's #1 mistake before it's plated.
// Renders nothing when no note is configured (graceful, like coach_tip).
// Distinct from coach_tip's quality coaching: gold ⚠ heads-up styling.
function AccuracyNote({ note, language, size = '1rem', style = {} }) {
  const text = note ? pickTipText(normalizeTip(note), language) : null;
  if (!text) return null;
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '0.4em',
      alignSelf: 'flex-start',
      color: BRAND.gold,
      fontFamily: "'Open Sans', sans-serif",
      fontWeight: 700,
      fontSize: size,
      lineHeight: 1.25,
      ...style,
    }}>
      <span aria-hidden="true" style={{ flexShrink: 0 }}>⚠</span>
      <span>{text}</span>
    </div>
  );
}

// Food image with a graceful fallback. New menu items often ship before
// a photo is uploaded, and the previous strategy (`display: none` on
// error) collapsed the layout — with the larger photo sizes that now
// drive entree + sides cards, the empty space looked broken. This
// component keeps the slot's exact dimensions whether the image loads
// or not, and renders a subtle plate glyph on failure so the card
// still reads as "there's a dish here, photo just isn't on file yet."
//
// Pass through the same `style` you'd give an <img>: width/height (or
// width + aspectRatio), borderRadius, etc. The wrapper carries that
// styling; the img / fallback fill it.
function FoodPhoto({ src, alt, style = {} }) {
  const [failed, setFailed] = useState(false);
  return (
    <div style={{
      background: BRAND.charcoalDark,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      flexShrink: 0,
      ...style,
    }}>
      {!failed && src && (
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      )}
      {failed && (
        // Two concentric circles read as "plate" at any size and don't
        // need translation. Gold at low opacity stays on-brand without
        // shouting; cooks see it and read "no photo on file."
        <svg viewBox="0 0 24 24" width="55%" height="55%" fill="none"
          stroke={BRAND.gold} strokeOpacity="0.4" strokeWidth="1.4"
          aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
        </svg>
      )}
    </div>
  );
}

// ── Component ───────────────────────────────────────────

export default function LineCoachDisplay({ storeId }) {
  const [orders, setOrders] = useState([]);
  const [config, setConfig] = useState(null);
  const [now, setNow] = useState(new Date());
  // Slow-period swap is debounced: the board only flips to Quality Coach
  // after it has been empty for a few seconds (see effect below), so a
  // transient gap between orders doesn't blank the whole screen.
  const [slowConfirmed, setSlowConfirmed] = useState(false);
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
  // Monotonic fetch counter. Realtime events, the 20s poll, and reconnect
  // catch-ups can fire overlapping order fetches; this lets us drop any
  // response that arrives after a newer one so a late/stale (possibly
  // empty) snapshot never clobbers fresh data and blanks the board.
  const fetchSeqRef = useRef(0);
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

  // Language toggle (EN | ES). Resolution priority — first hit wins:
  //   1. ?lang=en|es URL param (session override)
  //   2. localStorage 'lc-language' (device sticky — survives reload)
  //   3. config.default_languages[storeId] (admin per-store default)
  //   4. 'es' (kitchen-first hardcoded fallback — most cook crews are
  //      primarily Spanish-speaking)
  // SSR-safe: starts at 'es', resolved post-mount so the server pass
  // and first client render agree (no hydration mismatch).
  const [language, setLanguage] = useState('es');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let lang = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const url = params.get('lang');
      if (url === 'en' || url === 'es') lang = url;
    } catch { /* malformed URL — fall through */ }
    if (!lang) {
      try {
        const stored = window.localStorage.getItem('lc-language');
        if (stored === 'en' || stored === 'es') lang = stored;
      } catch { /* localStorage blocked — fall through */ }
    }
    if (!lang) {
      const adminDefault = config?.default_languages?.[storeId];
      if (adminDefault === 'en' || adminDefault === 'es') lang = adminDefault;
    }
    setLanguage(lang || 'es');
  }, [config, storeId]);

  function toggleLanguage() {
    setLanguage((prev) => {
      const next = prev === 'en' ? 'es' : 'en';
      try { window.localStorage.setItem('lc-language', next); } catch { /* ignore */ }
      return next;
    });
  }

  // Shift counter for Quality Coach mode (slow period only). Fetches
  // today's stats once when the kitchen goes quiet, then every 5 min
  // while it stays quiet. Pauses during active service so we don't
  // hammer the analytics path during rush. Honest about cost: this
  // is one HTTP call per 5 min per kiosk, only when there are zero
  // orders — negligible.
  const [shiftStats, setShiftStats] = useState(null);
  useEffect(() => {
    // Only fetch when the kitchen is empty. orders.length is the raw
    // count from realtime, which matches what the slow-period gate
    // uses downstream.
    if (orders.length > 0) return undefined;
    let cancelled = false;
    async function fetchStats() {
      try {
        const res = await fetch('/api/line-coach/analytics/today');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const row = (data.stores || []).find((s) => s.store_id === storeId);
        if (row) setShiftStats(row);
      } catch { /* keep last good value */ }
    }
    fetchStats();
    const interval = setInterval(fetchStats, 5 * 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [orders.length, storeId]);

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
    const seq = ++fetchSeqRef.current;
    fetch(`/api/line-coach/orders?store=${storeId}`)
      .then((r) => r.json())
      .then((data) => {
        // Drop out-of-order responses so a slow/stale fetch can't
        // overwrite a newer one (which would blank then re-fill the
        // board — a visible flicker).
        if (seq !== fetchSeqRef.current) return;
        setOrders(data.orders || []);
      })
      .catch(console.error);
  }, [storeId]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // Live order updates via Supabase Realtime. Kitchen screens run
  // unattended for hours, so the socket WILL drop (wifi blips, tablet
  // sleep, Supabase recycling connections, shared-instance limits). A
  // bare .subscribe() with no status handling freezes the board on its
  // last fetch until someone reloads. So we re-subscribe with backoff on
  // error/close and refetch on every (re)connect to catch up on anything
  // missed while the socket was down.
  useEffect(() => {
    const client = supabaseRef.current;
    if (!client) return;

    let channel = null;
    let reconnectTimer = null;
    let attempt = 0;
    let cancelled = false;

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      // Exponential backoff capped at 30s so a flapping network doesn't
      // hammer the shared Supabase instance.
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        const old = channel;
        channel = null;
        // Removing the old channel fires its CLOSED status; the
        // `ch !== channel` guard below ignores it so we don't loop.
        if (old) client.removeChannel(old);
        subscribe();
      }, delay);
    }

    function subscribe() {
      const ch = client
        .channel(`lc-orders-${storeId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lc_orders', filter: `store_id=eq.${storeId}` }, () => fetchOrders());
      channel = ch;
      ch.subscribe((status) => {
        if (ch !== channel) return; // stale channel, ignore late callbacks
        if (status === 'SUBSCRIBED') {
          // (Re)connected — pull a fresh snapshot in case rows changed
          // while we were disconnected.
          attempt = 0;
          fetchOrders();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleReconnect();
        }
      });
    }

    subscribe();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (channel) client.removeChannel(channel);
    };
  }, [storeId, fetchOrders]);

  // Safety net: realtime is best-effort, so poll the orders endpoint on a
  // slow interval and whenever the screen regains focus (e.g. a tablet
  // waking from sleep). Cheap insurance that the board self-heals and
  // never sits stale even if realtime never reconnects.
  useEffect(() => {
    const interval = setInterval(fetchOrders, 20_000);
    const onWake = () => { if (document.visibilityState === 'visible') fetchOrders(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [fetchOrders]);

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
        const isObj = typeof side === 'object' && side !== null;
        const sn = isObj ? side.name : (typeof side === 'string' ? side : null);
        if (!sn) continue;
        const size = (isObj && side.size) ? side.size : 'regular';
        const sq = isObj ? (side.quantity || 1) : 1;
        // Key matches the panel's bucket (canonical name + size) so the
        // flash lands on the right row when Large/Regular split out.
        const key = `${canonicalSideName(sn) || sn}|${size}`;
        liveCounts.set(key, (liveCounts.get(key) || 0) + sq);
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

  // ── Touch-to-bump + tap-to-expand ────────────────────
  //
  // Gesture state machine (touch mode only):
  //   pointerdown                  → start rAF hold timer (existing)
  //   pointerup, elapsed < 200ms   → fire openDetailSheet, no bump
  //   pointerup, elapsed 200-800ms → cancelHold, no action (cooks who
  //                                  release mid-press are clearly
  //                                  signaling "not committed")
  //   pointerup, elapsed >= 800ms  → unreachable; commitBump already
  //                                  fired in the rAF tick
  //   pointerleave / pointercancel → cancelHold, no action (slide-off
  //                                  should NOT fire a tap; user
  //                                  changed their mind)
  //
  // 200ms tap threshold — short enough that intentional taps feel
  // snappy, long enough that drag-from-card-edge doesn't false-fire.
  const TAP_MAX_MS = 200;
  // Detail sheet state. null when closed; the rendered order object
  // (from getOrderSequence, so it has the carried `id`) when open.
  const [detailOrder, setDetailOrder] = useState(null);

  function cancelHold(orderId, opts = {}) {
    const t = holdTimersRef.current[orderId];
    if (t?.rafId) cancelAnimationFrame(t.rafId);
    // Capture elapsed BEFORE we clear the timer ref so the tap
    // detection below sees the same moment-in-time the hold started.
    const startedAt = t?.startedAt ?? null;
    delete holdTimersRef.current[orderId];
    setHoldProgress((prev) => (prev?.orderId === orderId ? null : prev));

    if (opts.fromPointerUp && opts.order && startedAt != null) {
      const elapsed = performance.now() - startedAt;
      if (elapsed < TAP_MAX_MS) {
        // Open the detail sheet for a short tap. Bump didn't fire
        // (we'd have hit pct >= 1 in the rAF tick first).
        setDetailOrder(opts.order);
      }
    }
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
  // Swap to Quality Coach only once the board has been empty for a beat.
  // An order appearing flips back instantly (cooks must see tickets the
  // moment they land); only the empty→Quality-Coach direction waits.
  const boardEmpty = visibleOrders.length === 0;
  const isSlowPeriod = boardEmpty && slowConfirmed;

  useEffect(() => {
    if (!boardEmpty) {
      // Orders on the board → show it immediately, cancel any pending swap.
      setSlowConfirmed(false);
      return undefined;
    }
    // Board just emptied. Hold on the (calm) empty board for a few
    // seconds before switching to Quality Coach so a momentary gap
    // between tickets doesn't blank the whole screen and snap back.
    const t = setTimeout(() => setSlowConfirmed(true), 8000);
    return () => clearTimeout(t);
  }, [boardEmpty]);

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
    // bucketKey (`canonicalName|size`) → { name, size, total, alaCarteQty }.
    // Size splits the bucket (Large is a separate prep row from Regular);
    // à la carte portions still count toward the same prep bucket but are
    // tallied separately so the panel can tag how many go out solo.
    const buckets = new Map();
    // Track per (order id, canonical name, size) how much we've credited
    // from the sides array, plus a per (order, canonical) set so the
    // items pass never double-counts a side the order already has.
    const credited = new Map();
    const creditedCanonical = new Set();
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

    const bump = (canonical, size, qty, alaCarte) => {
      const key = `${canonical}|${size}`;
      let b = buckets.get(key);
      if (!b) { b = { name: canonical, size, total: 0, alaCarteQty: 0 }; buckets.set(key, b); }
      b.total += qty;
      if (alaCarte) b.alaCarteQty += qty;
    };

    for (const order of visibleOrders) {
      const oid = orderKey(order);
      for (const side of order.sides || []) {
        const isObj = typeof side === 'object' && side !== null;
        const rawName = isObj ? side.name : (typeof side === 'string' ? side : null);
        if (!rawName) continue;
        const canonical = canonicalSideName(rawName) || rawName;
        // Backwards compatible: rows written before size tracking have
        // no size/alaCarte fields → treat as a regular add-on.
        const size = (isObj && side.size) ? side.size : 'regular';
        const alaCarte = isObj && !!side.alaCarte;
        const qty = parseQty(isObj ? side.quantity : 1);
        bump(canonical, size, qty, alaCarte);
        credited.set(`${oid}::${canonical}::${size}`, (credited.get(`${oid}::${canonical}::${size}`) || 0) + qty);
        creditedCanonical.add(`${oid}::${canonical}`);
      }
    }
    // Catch sides that were inlined as items rather than pushed to
    // order.sides (rare, but covers Toast inlining a side as an item).
    // Skip when the sides pass already credited this (orderId, side) in
    // any size, since the webhook normally extracts both. Inlined sides
    // carry no size/à-la-carte signal, so they land in the regular bucket.
    for (const order of visibleOrders) {
      const oid = orderKey(order);
      for (const item of order.items || []) {
        if (!item?.name) continue;
        if (!isCanonicalSide(item.name)) continue;
        const canonical = canonicalSideName(item.name);
        if (!canonical) continue;
        if (creditedCanonical.has(`${oid}::${canonical}`)) continue;
        const qty = parseQty(item?.quantity);
        bump(canonical, 'regular', qty, false);
        creditedCanonical.add(`${oid}::${canonical}`);
      }
    }
    // Sort: longest cook time first (prep priority), then keep a side's
    // sizes adjacent (by name), Large before Regular, then larger count.
    const sizeRank = { large: 0, small: 1, regular: 2 };
    return [...buckets.values()].sort((a, b) => {
      const aCook = findConfig(a.name)?.cook_time || 0;
      const bCook = findConfig(b.name)?.cook_time || 0;
      if (bCook !== aCook) return bCook - aCook;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      const ar = sizeRank[a.size] ?? 3;
      const br = sizeRank[b.size] ?? 3;
      if (ar !== br) return ar - br;
      return b.total - a.total;
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
          // Guard: older rows + Toast variants we haven't mapped store
          // dining_option as a raw JSON object string like
          // {"guid":"...","entityType":"DiningOption"}. Never render
          // that to a cook — drop to null so the badge is suppressed.
          // The admin's Dining Options tab surfaces these GUIDs so
          // they can be labeled going forward (webhook then resolves
          // the GUID to "DINE IN" / "TAKEOUT" / etc. at write time).
          diningOption: (typeof order.dining_option === 'string'
                          && order.dining_option.length > 0
                          && !order.dining_option.startsWith('{'))
                        ? order.dining_option
                        : null,
          orderChannel: order.order_channel || null,
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
    // Single-language mode: pickTipText falls back to the other
    // language silently if the chosen one is empty, so a partially-
    // translated tip still renders something useful.
    const text = pickTipText(tip, language);
    // Render in the chosen language's native styling — bone Playfair
    // for English, cream italic Playfair for Spanish — so cooks see
    // consistent typography per language across all 4 surfaces.
    const tipStyle = language === 'es'
      ? { ...s.qualityTipEs, fontStyle: 'italic' }
      : s.qualityTipEn;
    // Shift counter — only renders when we have non-trivial today
    // data. Empty / failed fetch → skip the pill entirely so the
    // slow-period view doesn't grow chrome that's empty. Numbers
    // read across languages; the only translated string is the
    // "Today · " / "Hoy · " prefix.
    const stats = shiftStats;
    const showShiftPill = stats && stats.tickets > 0;
    const onTimePct = stats && stats.tickets > 0
      ? Math.round(100 - (stats.over_sla_pct || 0))
      : null;
    const prefix = language === 'es' ? 'Hoy' : 'Today';
    const avgLabel = language === 'es' ? 'prom' : 'avg';
    const onTimeLabel = language === 'es' ? 'a tiempo' : 'on time';
    return (
      <div style={s.container}>
        <style>{`@keyframes lcQualityFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        <Header now={now} orderCount={0} staleCount={staleCount} language={language} onLanguageToggle={toggleLanguage} />
        <div style={s.qualityCoach}>
          <div style={s.qualityLabel}>QUALITY COACH</div>
          <div style={s.qualityTipBlock} key={`${qualityTipIndex}-${language}`}>
            {text && (
              <div style={s.qualityLangSection}>
                <div style={tipStyle}>{text}</div>
              </div>
            )}
          </div>
          {showShiftPill && (
            <div style={{
              marginTop: 'clamp(2vh, 3vh, 5vh)',
              padding: '12px 24px',
              borderRadius: '999px',
              background: `${BRAND.gold}12`,
              border: `1px solid ${BRAND.gold}30`,
              color: BRAND.cream,
              fontFamily: "'Oswald', sans-serif",
              fontSize: 'clamp(0.9rem, 1.3vw, 1.3rem)',
              fontWeight: 600,
              letterSpacing: '2.5px',
              textTransform: 'uppercase',
              display: 'flex',
              gap: '16px',
              alignItems: 'center',
            }}>
              <span style={{ color: BRAND.gold }}>{prefix}</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>{stats.tickets} {stats.tickets === 1 ? 'order' : 'orders'}</span>
              {stats.avg_seconds != null && (
                <>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{avgLabel} {Math.floor(stats.avg_seconds / 60)}m {String(stats.avg_seconds % 60).padStart(2, '0')}s</span>
                </>
              )}
              {onTimePct != null && (
                <>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span style={{ color: onTimePct >= 95 ? BRAND.green : onTimePct >= 85 ? BRAND.gold : BRAND.red }}>
                    {onTimePct}% {onTimeLabel}
                  </span>
                </>
              )}
            </div>
          )}
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
    // Single-language with silent fallback. Returns null when both
    // halves of the tip are empty — caller renders the "—" empty
    // state instead.
    const tipText = pickTipText(tipToShow, language);

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
      const size = (typeof side === 'object' && side.size && side.size !== 'regular')
        ? ` (${side.size === 'large' ? 'LG' : 'SM'})`
        : '';
      const label = `${sn}${size}`;
      return sq > 1 ? `${sq}x ${label}` : label;
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
        <Header now={now} orderCount={1} language={language} onLanguageToggle={toggleLanguage} />

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
        <div key={`focus-${focusItemIndex % itemCount}-${language}`} style={{
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
            <FoodPhoto
              src={getSideImageUrl(primaryItem?.name || '', menuItems, configSides)}
              alt={primaryItem?.name || ''}
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                maxHeight: '46vh',
                borderRadius: '12px',
              }}
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
            <ModifierLines
              modifiers={primaryItem?.modifiers}
              size="clamp(1.4rem, 2.2vw, 2.2rem)"
              gap="4px"
            />
            <AccuracyNote note={primaryMenu?.accuracy_note} language={language} size="clamp(1.1rem, 1.7vw, 1.7rem)" style={{ marginTop: '6px' }} />
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
                    {/* Secondary items keep an inline modifier list (vertical
                        space is already at a premium below the hero). We still
                        drop cosmetic restate-default mods and color critical
                        deviations gold so the hierarchy matches the hero. */}
                    {visibleModifiers(it.modifiers).map((m, mi) => (
                      <span key={mi} style={{
                        color: m.kind === 'critical' ? BRAND.gold : BRAND.cream,
                        fontWeight: m.kind === 'critical' ? 700 : 500,
                        textTransform: 'none',
                        marginLeft: '10px',
                        fontFamily: "'Open Sans', sans-serif",
                      }}> · {m.raw}</span>
                    ))}
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
            {/* Single-language render. Native styling per language:
                English in Playfair bone, Spanish in Playfair italic
                cream — same visual language as the Quality Coach
                + side quick-tip surfaces. */}
            {tipText && (
              <div style={{
                fontSize: language === 'en' ? 'clamp(1.6rem, 2.6vw, 2.6rem)' : 'clamp(1.4rem, 2.3vw, 2.3rem)',
                color: language === 'en' ? BRAND.bone : BRAND.cream,
                fontFamily: "'Playfair Display', Georgia, serif",
                lineHeight: 1.3,
                fontStyle: language === 'es' ? 'italic' : 'normal',
              }}>{tipText}</div>
            )}
            {!tipText && (
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
        /* Detail sheet entry — slide up + fade. Matches the tempo of
           lcOrderEnter (280ms) so the kitchen's animation language
           feels coherent. */
        @keyframes lcSheetIn {
          from { opacity: 0; transform: translateY(40px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
        @keyframes lcScrimIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
      <Header now={now} orderCount={visibleOrders.length} staleCount={staleCount} language={language} onLanguageToggle={toggleLanguage} />
      {bumpedToast && (
        <UndoToast orderNum={bumpedToast.orderNum} onUndo={handleUndo} />
      )}
      {detailOrder && (
        <OrderDetailSheet
          order={detailOrder}
          menuItems={menuItems}
          configSides={configSides}
          warningMin={warningMin}
          dangerMin={dangerMin}
          language={language}
          onClose={() => setDetailOrder(null)}
        />
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
              const MAX_VISIBLE = isComfortable ? 3 : 5;
              const visibleOrders = orderSequence.slice(0, MAX_VISIBLE);
              const hiddenCount = orderSequence.length - MAX_VISIBLE;
              // Density-driven sizes (in px / rem). Hollywood post-deploy
              // bump (May 2026): every primary size raised so the
              // wall-mounted TV reads cleanly from the prep / pass
              // sides of the line, not just from the cook's station.
              // Rush mode gets the biggest jump because that's when
              // the display matters most and cooks are furthest from
              // it. Comfortable mode lifted proportionally so the two
              // tiers still feel related.
              const rowPad = isComfortable ? '14px 0' : '10px 0';
              const sidebarW = isComfortable ? '130px' : '116px';
              const orderNumSize = isComfortable ? '1.7rem' : '1.5rem';
              const customerSize = isComfortable ? '1.1rem' : '0.95rem';
              const badgeSize = isComfortable ? '1rem' : '0.85rem';
              const timerSize = isComfortable ? '2rem' : '1.7rem';
              const photoSize = isComfortable ? '200px' : '140px';
              const entreeNameSize = isComfortable ? '2.55rem' : '1.95rem';
              // Modifier + sides line are now BIGGER than the entree
              // name in rush mode and matched-or-larger in comfortable.
              // Cooks identify the dish from the photo first; the
              // critical "no nuts / sub chicken / extra salsa /
              // w/ Spanish Rice + Kale Slaw" detail is what they
              // actually need to read from across the line. Quality
              // accuracy depends on these being legible at distance.
              const modifierSize = isComfortable ? '2.5rem' : '2.2rem';
              const sidesLineSize = isComfortable ? '2.5rem' : '2.2rem';
              const sidesIndent = isComfortable ? '216px' : '156px';

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
                      // Pointerup is the only path that can fire a tap
                      // (open detail sheet). Slide-off + cancel paths
                      // intentionally don't trigger so a cook who
                      // changes their mind mid-press isn't surprised
                      // by a sheet popping up.
                      onPointerUp: () => cancelHold(order.id, { fromPointerUp: true, order }),
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
                          fontSize: isComfortable ? '2.1rem' : '1.8rem',
                          padding: isComfortable ? '14px 22px' : '10px 18px',
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
                        }}>
                          {/* Identity group: order # + customer name kept
                              tight together so they read as one unit. */}
                          <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '1px',
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
                          </div>
                          {/* Badge group: ASAP / dining / scheduled-time /
                              courier badges live in one coherent cluster,
                              set off from identity + timer by a larger gap.
                              Wrapper only renders when a badge applies so
                              plain dine-in tickets don't get an empty gap. */}
                          {(order.priority === 'rush'
                            || (!order.isFutureOrder && diningLabel && order.priority !== 'rush')
                            || order.isFutureOrder
                            || (order.orderChannel && CHANNEL_STYLES[order.orderChannel])) && (
                            <div style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              gap: '4px',
                              marginTop: '10px',
                            }}>
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
                              {/* Order channel badge — only for delivery
                                  couriers. In-store / null renders no
                                  badge (most volume, no signal needed).
                                  Cooks treat delivery orders differently
                                  from walk-ins, so this is the highest-
                                  value signal on the sidebar. */}
                              {order.orderChannel && CHANNEL_STYLES[order.orderChannel] && (
                                <div style={{
                                  ...CHANNEL_STYLES[order.orderChannel],
                                  fontSize: badgeSize,
                                  padding: '2px 6px',
                                  borderRadius: '3px',
                                  fontFamily: "'Oswald', sans-serif",
                                  fontWeight: 700,
                                  letterSpacing: '1px',
                                }}>{CHANNEL_LABELS[order.orderChannel]}</div>
                              )}
                            </div>
                          )}
                          {!order.isFutureOrder && (
                            <div style={{
                              marginTop: '10px',
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
                          {order.items.map((item, ii) => {
                            // Station routing badge — color-coded pill from
                            // STATION_STYLES, only rendered when the item is
                            // in brand config (Toast variants we haven't
                            // mapped silently render nothing).
                            const station = stationFor(item.name, menuItems);
                            const stationStyle = station ? STATION_STYLES[station] : null;
                            const stationLabel = station ? STATION_LABELS[station] : null;
                            const menuMatch = menuItems.find((m) => m.name === item.name);
                            return (
                            <div key={ii} style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '2px',
                              minWidth: 0,
                            }}>
                            <div style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '12px',
                              minWidth: 0,
                            }}>
                              <FoodPhoto
                                src={getSideImageUrl(item.name, menuItems, configSides)}
                                alt={item.name}
                                style={{
                                  width: photoSize,
                                  height: photoSize,
                                  borderRadius: '8px',
                                }}
                              />
                              {stationStyle && stationLabel && (
                                <div style={{
                                  ...stationStyle,
                                  fontFamily: "'Oswald', sans-serif",
                                  fontWeight: 700,
                                  fontSize: isComfortable ? '1rem' : '0.85rem',
                                  letterSpacing: '1.5px',
                                  padding: isComfortable ? '5px 10px' : '3px 8px',
                                  borderRadius: '4px',
                                  flexShrink: 0,
                                  whiteSpace: 'nowrap',
                                }}>{stationLabel}</div>
                              )}
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
                              {/* Modifiers fill the leftover space to the right
                                  of the entree name. One modifier per line so
                                  cooks scan top-to-bottom; deviations ("Sub",
                                  "No", "Extra"...) render gold to draw the eye
                                  first. Cosmetic restate-default modifiers
                                  ("Regular X", "Standard X") are filtered out
                                  entirely by classifyModifier. */}
                              <ModifierLines modifiers={item.modifiers} size={modifierSize} style={{ flex: 1 }} />
                            </div>
                            <AccuracyNote note={menuMatch?.accuracy_note} language={language} size={modifierSize} style={{ paddingLeft: sidesIndent }} />
                            </div>
                            );
                          })}
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
            {batchedSides.map(({ name, size, total: count, alaCarteQty }) => {
              // Bucket key splits a side by portion size, so Large and
              // Regular render as their own rows with their own flash.
              const bucketKey = `${name}|${size}`;
              const isLarge = size === 'large';
              const isSmall = size === 'small';
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
              const isFlashing = flashSideRef.current.has(bucketKey);

              // Dynamic sizing based on number of sides — compact for narrow column.
              // Lead-with-visuals bump: side photos go as large as the column
              // height allows for the row count (each row is flex:1, so the
              // image can't exceed its share of the column without clipping).
              // Finer tiers keep them as big as possible at every load.
              const n = batchedSides.length;
              const imgSize = n <= 4 ? '11vh' : n <= 6 ? '9.5vh' : n <= 9 ? '8vh' : '6.8vh';
              const nameSize = n <= 4 ? '2.1vh' : n <= 6 ? '1.8vh' : n <= 9 ? '1.6vh' : '1.4vh';
              const countSize = n <= 4 ? '6vh' : n <= 6 ? '5.2vh' : n <= 9 ? '4.6vh' : '3.9vh';
              const actionSize = n <= 4 ? '1.5vh' : n <= 6 ? '1.3vh' : n <= 9 ? '1.2vh' : '1.05vh';

              return (
                <div key={bucketKey} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3%',
                  flex: 1,
                  padding: '0 2%',
                }}>
                  <FoodPhoto
                    src={imageUrl}
                    alt={name}
                    style={{
                      width: imgSize,
                      height: imgSize,
                      borderRadius: '8px',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <div style={{
                        fontSize: `clamp(1.2rem, ${nameSize}, 2.4rem)`,
                        fontWeight: 700,
                        color: BRAND.bone,
                        fontFamily: "'Oswald', sans-serif",
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        lineHeight: 1.2,
                      }}>{name}</div>
                      {(isLarge || isSmall) && (
                        // Portion-size chip — only on non-regular rows, so
                        // Regular stays clean and Large/Small pop as the
                        // "different prep" signal.
                        <span style={{
                          fontSize: `clamp(0.7rem, ${actionSize}, 1.1rem)`,
                          fontWeight: 700,
                          fontFamily: "'Oswald', sans-serif",
                          letterSpacing: '0.5px',
                          color: BRAND.charcoalDark,
                          background: BRAND.gold,
                          borderRadius: '4px',
                          padding: '1px 6px',
                          lineHeight: 1.3,
                        }}>{isLarge ? 'LG' : 'SM'}</span>
                      )}
                    </div>
                    {alaCarteQty > 0 && (
                      // À la carte tag, in place: this bucket includes
                      // portions the guest ordered solo (not as an entree
                      // add-on). Count shown since the bucket may mix both.
                      <div style={{
                        fontSize: `clamp(0.78rem, ${actionSize}, 1.2rem)`,
                        fontWeight: 700,
                        color: BRAND.cream,
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: '1px',
                        marginTop: '2px',
                        opacity: 0.75,
                      }}>
                        {alaCarteQty} À LA CARTE
                      </div>
                    )}
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
                        fontSize: `clamp(0.85rem, ${actionSize}, 1.3rem)`,
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
                    key={isFlashing ? `${bucketKey}-${count}` : bucketKey}
                    style={{
                      fontSize: `clamp(2.4rem, ${countSize}, 7rem)`,
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

          {/* Quick Tip — single language with silent fallback. */}
          {tips.length > 0 && (() => {
            const tip = tips[qualityTipIndex % tips.length];
            const text = pickTipText(tip, language);
            if (!text) return null;
            const tipStyle = language === 'es'
              ? { ...s.quickTipTextEs, fontStyle: 'italic' }
              : s.quickTipText;
            return (
              <div style={s.quickTip}>
                <div style={s.quickTipLabel}>TIP</div>
                <div style={tipStyle}>{text}</div>
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

// Tap-to-expand detail sheet. Opens on a quick tap (release < 200ms)
// from the gesture state machine in cancelHold. Holds longer go to
// hold-to-bump as before. Auto-dismisses after 30s of no interaction
// because the wall display is unattended much of the time and a
// stuck sheet would defeat the brand-promise visibility.
function OrderDetailSheet({ order, menuItems, configSides, warningMin, dangerMin, language = 'es', onClose }) {
  // Auto-dismiss timer. Reset on any interaction inside the sheet
  // (a manager tapping through items shouldn't trip the timeout).
  useEffect(() => {
    const t = setTimeout(onClose, 30_000);
    return () => clearTimeout(t);
  }, [onClose]);

  // Esc closes for keyboard / desktop testing.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const elapsedMin = order.elapsedMinutes ?? 0;
  const sevColor = elapsedMin >= dangerMin
    ? BRAND.red
    : elapsedMin >= warningMin
      ? BRAND.yellow
      : BRAND.green;
  const allergyNote = isAllergyNote(order.notes) ? order.notes : null;
  const inlineNote = allergyNote ? null : order.notes;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        animation: 'lcScrimIn 180ms ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BRAND.charcoal,
          borderRadius: '14px',
          maxWidth: '900px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '28px 32px',
          boxShadow: `0 24px 48px rgba(0,0,0,0.45), inset 4px 0 0 ${sevColor}`,
          animation: 'lcSheetIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          color: BRAND.bone,
          fontFamily: "'Open Sans', sans-serif",
        }}
      >
        {/* Header strip */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '20px', marginBottom: '20px' }}>
          <div>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: 'clamp(2rem, 3.5vw, 3.5rem)',
              fontWeight: 800,
              letterSpacing: '2px',
              color: BRAND.bone,
              lineHeight: 1,
            }}>
              #{order.orderNum}
            </div>
            {order.customerName && (
              <div style={{ fontSize: '1.4rem', color: BRAND.cream, marginTop: '6px' }}>
                {order.customerName}
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: 'clamp(1.6rem, 2.5vw, 2.5rem)',
              fontWeight: 700,
              color: sevColor,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}>
              {order.elapsedDisplay}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px', flexWrap: 'wrap' }}>
              {order.priority === 'rush' && (
                <span style={{ background: BRAND.red, color: BRAND.white, fontFamily: "'Oswald', sans-serif", fontWeight: 700, letterSpacing: '2px', padding: '4px 10px', borderRadius: '4px', fontSize: '0.85rem' }}>ASAP</span>
              )}
              {order.diningOption && (
                <span style={{ background: BRAND.charcoalLight, color: BRAND.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, letterSpacing: '2px', padding: '4px 10px', borderRadius: '4px', fontSize: '0.85rem' }}>
                  {String(order.diningOption).toUpperCase()}
                </span>
              )}
              {order.orderChannel && CHANNEL_STYLES[order.orderChannel] && (
                <span style={{
                  ...CHANNEL_STYLES[order.orderChannel],
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  letterSpacing: '2px',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '0.85rem',
                }}>{CHANNEL_LABELS[order.orderChannel]}</span>
              )}
              {order.isFutureOrder && order.fireAt && (
                <span style={{ background: BRAND.blue, color: BRAND.charcoal, fontFamily: "'Oswald', sans-serif", fontWeight: 700, letterSpacing: '2px', padding: '4px 10px', borderRadius: '4px', fontSize: '0.85rem' }}>
                  {order.fireAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: BRAND.cream,
              fontSize: '2rem',
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              cursor: 'pointer',
              padding: '0 8px',
              lineHeight: 1,
              minWidth: '48px',
              minHeight: '48px',
            }}
          >
            ×
          </button>
        </div>

        {allergyNote && (
          <div style={{
            background: BRAND.red,
            color: BRAND.white,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            fontSize: '1.4rem',
            padding: '12px 18px',
            borderRadius: '6px',
            marginBottom: '20px',
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: '1.6rem' }}>⚠</span>
            <span style={{ fontWeight: 800 }}>ALLERGY</span>
            <span style={{ textTransform: 'none', letterSpacing: '0.5px', fontWeight: 600 }}>
              {trimAllergyPrefix(allergyNote)}
            </span>
          </div>
        )}

        {/* Items list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '20px' }}>
          {(order.items || []).map((item, ii) => {
            const menuMatch = menuItems.find((m) => m.name === item.name);
            const coachTip = menuMatch?.coach_tip
              ? normalizeTip(menuMatch.coach_tip)
              : null;
            const station = menuMatch?.station || null;
            const stationStyle = station ? STATION_STYLES[station] : null;
            const stationLabel = station ? STATION_LABELS[station] : null;
            return (
              <div key={ii} style={{
                display: 'flex',
                gap: '16px',
                background: BRAND.charcoalDark,
                borderRadius: '10px',
                padding: '14px 16px',
              }}>
                <FoodPhoto
                  src={getSideImageUrl(item.name, menuItems, configSides)}
                  alt={item.name}
                  style={{
                    width: '120px',
                    height: '120px',
                    borderRadius: '10px',
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    {stationStyle && stationLabel && (
                      <div style={{
                        ...stationStyle,
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        letterSpacing: '1.5px',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        flexShrink: 0,
                      }}>{stationLabel}</div>
                    )}
                    <div style={{
                      fontFamily: "'Oswald', sans-serif",
                      fontWeight: 700,
                      fontSize: '1.6rem',
                      textTransform: 'uppercase',
                      color: BRAND.bone,
                      lineHeight: 1.1,
                    }}>
                      {item.quantity > 1 && <span style={{ color: BRAND.gold, marginRight: '8px' }}>{item.quantity}x</span>}
                      {item.name}
                    </div>
                  </div>
                  <div style={{ marginTop: '6px' }}>
                    <ModifierLines
                      modifiers={item.modifiers}
                      size="1.1rem"
                      fontWeight={600}
                      gap="3px"
                    />
                  </div>
                  <AccuracyNote note={menuMatch?.accuracy_note} language={language} size="1.05rem" style={{ marginTop: '8px' }} />
                  {(() => {
                    const coachText = pickTipText(coachTip, language);
                    if (!coachText) return null;
                    return (
                      <div style={{ marginTop: '10px', borderLeft: `3px solid ${BRAND.gold}`, paddingLeft: '12px' }}>
                        <div style={{
                          fontFamily: "'Playfair Display', Georgia, serif",
                          color: language === 'en' ? BRAND.cream : `${BRAND.cream}cc`,
                          fontSize: language === 'en' ? '1rem' : '0.95rem',
                          fontStyle: language === 'es' ? 'italic' : 'normal',
                          lineHeight: 1.4,
                        }}>
                          {coachText}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>

        {/* Sides */}
        {(order.sides || []).length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: '0.85rem',
              fontWeight: 700,
              letterSpacing: '2px',
              textTransform: 'uppercase',
              color: BRAND.gold,
              marginBottom: '10px',
            }}>
              Sides
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {order.sides.map((side, si) => {
                const isObj = typeof side === 'object' && side !== null;
                const sn = isObj ? side?.name : side;
                const sq = isObj ? (side.quantity || 1) : 1;
                const size = (isObj && side.size && side.size !== 'regular') ? side.size : null;
                const alaCarte = isObj && !!side.alaCarte;
                return (
                  <div key={si} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', fontSize: '1.1rem', color: BRAND.cream, padding: '6px 0', borderBottom: `1px solid ${BRAND.charcoalLight}` }}>
                    <span>
                      {sn}
                      {size && <span style={{ color: BRAND.gold, fontWeight: 700, marginLeft: '6px' }}>{size === 'large' ? 'LG' : 'SM'}</span>}
                      {alaCarte && <span style={{ color: BRAND.cream, opacity: 0.7, fontSize: '0.85rem', letterSpacing: '0.5px', marginLeft: '8px' }}>À LA CARTE</span>}
                    </span>
                    <span style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>× {sq}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {inlineNote && (
          <div style={{
            background: `${BRAND.gold}15`,
            borderLeft: `3px solid ${BRAND.gold}`,
            padding: '12px 16px',
            borderRadius: '4px',
            color: BRAND.bone,
            fontSize: '1.05rem',
            marginBottom: '12px',
          }}>
            <span style={{ color: BRAND.gold, marginRight: '8px' }}>⚠</span>
            {inlineNote}
          </div>
        )}

        <div style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: `1px solid ${BRAND.charcoalLight}`,
          fontSize: '0.8rem',
          color: `${BRAND.cream}80`,
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: '1px',
          textAlign: 'center',
          textTransform: 'uppercase',
        }}>
          Tap outside to close · Hold a card to bump
        </div>
      </div>
    </div>
  );
}

function Header({ now, orderCount, staleCount = 0, language, onLanguageToggle }) {
  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        {/* Brand logo replaces the wordmark. Sized by height so the
            ~4.18:1 logo image scales cleanly. onError falls back to
            the WILDBIRD text wordmark in case the asset is missing. */}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {language && onLanguageToggle && (
          // Language toggle chip. Uppercase = active language.
          // Touch target ≥44px height via padding so a greasy-handed
          // tap is reliable on the wall display.
          <button
            type="button"
            onClick={onLanguageToggle}
            aria-label={`Toggle language (current: ${language === 'en' ? 'English' : 'Spanish'})`}
            title={language === 'en' ? 'Showing English · tap for Spanish' : 'Showing Spanish · tap for English'}
            style={{
              padding: '8px 14px',
              borderRadius: '999px',
              background: 'rgba(212, 165, 116, 0.18)',
              color: BRAND.gold,
              border: 'none',
              fontSize: '0.8rem',
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              letterSpacing: '2px',
              cursor: 'pointer',
              minHeight: '44px',
              minWidth: '64px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {language === 'en' ? 'EN · es' : 'ES · en'}
          </button>
        )}
        <span style={s.clock}>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
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
    fontSize: '1.3rem',
    fontWeight: 700,
    color: BRAND.bone,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
  },
  clock: {
    fontSize: '1.4rem',
    color: BRAND.cream,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: "'Open Sans', sans-serif",
  },
  // Main Layout
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: '8px',
    padding: '8px',
    height: 'calc(100vh - 56px)',
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
    fontSize: '1.05rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '2px',
    padding: '6px 2%',
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
