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

// Normalize a menu item's build_steps (Learn mode) into { en, es }
// steps in assembly order. Mirrors lib/line-coach.js so the client
// doesn't pull in server-only deps.
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map(normalizeTip)
    .filter((s) => (s.en && s.en.trim()) || (s.es && s.es.trim()));
}

// Round-robin spread feedback tips through the curated rotation so
// customer-feedback cards surface regularly instead of clumping at the
// end (e.g. 16 curated + 4 feedback → one feedback card every 4 curated).
function interleaveTips(curated, feedback) {
  if (feedback.length === 0) return curated;
  if (curated.length === 0) return feedback;
  const stride = Math.max(1, Math.ceil(curated.length / feedback.length));
  const out = [];
  let f = 0;
  for (let i = 0; i < curated.length; i++) {
    out.push(curated[i]);
    if ((i + 1) % stride === 0 && f < feedback.length) out.push(feedback[f++]);
  }
  while (f < feedback.length) out.push(feedback[f++]);
  return out;
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

// Packaging pseudo-items ("YES, INCLUDE UTENSILS!", "No Utensils",
// "Napkins & Cutlery") come through Toast as $0 menu items. They're
// packing instructions, not food — getOrderSequence pulls them out of
// the item list and the card renders them as a gold callout banner so
// they never occupy an entree row (photo, station badge) or push real
// food down the card.
const PACKAGING_ITEM_RE = /\b(utensils?|napkins?|cutlery|silverware|plasticware|chopsticks?)\b/i;
function isPackagingItem(name) {
  return PACKAGING_ITEM_RE.test(name || '');
}

// One "w/ ..." text fragment from a side list — qty prefix and LG/SM
// size tag. Card + focus surfaces now lead with SideThumbRow visuals;
// this stays for the loose-sides presence check and any text-only
// surface that needs the compact form.
function formatSideList(sides) {
  return (sides || []).map((side) => {
    const sn = typeof side === 'string' ? side : side.name;
    const sq = (typeof side === 'object' && side.quantity) || 1;
    const size = (typeof side === 'object' && side.size && side.size !== 'regular')
      ? ` (${side.size === 'large' ? 'LG' : 'SM'})`
      : '';
    const label = `${sn}${size}`;
    return sq > 1 ? `${sq}x ${label}` : label;
  }).join(', ');
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

// In-service coaching line — the entree's coach_tip rendered as one
// compact "cook it well" prompt. Shown inline only when the board is
// calm (comfortable density); during a rush the board stays clean and
// coaching lives in the tap-to-expand detail sheet instead. Styled
// lighter than AccuracyNote (cream/italic ▸ vs gold ⚠) so the accuracy
// guardrail still wins the eye. Renders nothing when no tip is set.
function CoachLine({ tip, language, size = '1rem', style = {} }) {
  const text = tip ? pickTipText(normalizeTip(tip), language) : null;
  if (!text) return null;
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '0.4em',
      alignSelf: 'flex-start',
      color: BRAND.cream,
      opacity: 0.9,
      fontFamily: "'Open Sans', sans-serif",
      fontStyle: 'italic',
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1.25,
      ...style,
    }}>
      <span aria-hidden="true" style={{ fontStyle: 'normal', color: BRAND.gold, flexShrink: 0 }}>▸</span>
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
          // iPadOS starts a native image drag on long-press, which fires
          // pointercancel and kills an in-flight hold-to-bump. Suppressing
          // the drag is what makes the 800ms hold survive on a tablet.
          draggable={false}
          // iOS also pops a "Save Image / Copy" callout on long-press over
          // an <img>; userSelect:none does not suppress it. The rule lives
          // in app/layout.js because React drops the inline form.
          className="lc-no-callout"
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

// Visual side row — replaces the "w/ Broccoli, Brussel Sprouts" text
// line on order cards and focus mode. Each side renders as a photo
// thumb (FoodPhoto, so missing photos fall back to the plate glyph)
// with the name as a small caption beneath — visuals lead, copy stays.
// Qty and portion size overlay the photo as pills so the thumb alone
// carries the full instruction. The 'w/' / '+' prefix survives as a
// small gold glyph so the attached-vs-à-la-carte grammar cooks already
// learned is preserved. Distinct from the TOTAL SIDES batching panel,
// which stays aggregate — this row is per-plate, that panel is what to
// drop in batches.
function SideThumbRow({ sides, thumbPx, menuItems, configSides, prefix, style = {} }) {
  const list = (sides || []).filter((sd) => sd && (typeof sd === 'string' ? sd : sd.name));
  if (list.length === 0) return null;
  const captionPx = Math.max(11, Math.min(18, Math.round(thumbPx / 5.5)));
  const pillPx = Math.max(10, Math.round(thumbPx / 6));
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px', ...style }}>
      {prefix && (
        <div style={{
          alignSelf: 'center',
          color: BRAND.gold,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          fontSize: `${Math.round(thumbPx / 3)}px`,
          lineHeight: 1,
          flexShrink: 0,
        }}>{prefix}</div>
      )}
      {list.map((side, i) => {
        const name = typeof side === 'string' ? side : side.name;
        const qty = (typeof side === 'object' && side.quantity) || 1;
        const sizeTag = (typeof side === 'object' && side.size && side.size !== 'regular')
          ? (side.size === 'large' ? 'LG' : 'SM')
          : null;
        return (
          // Fixed cell wider than the thumb so long names ("UPTOWN MAC
          // & CHEESE") wrap to ≤2 lines and wrapped rows stay aligned.
          <div key={`${name}-${i}`} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
            width: `${Math.round(thumbPx * 1.5)}px`,
          }}>
            {/* Badges live on this wrapper, not FoodPhoto — its
                overflow:hidden would clip the overhanging qty pill. */}
            <div style={{ position: 'relative', width: `${thumbPx}px`, height: `${thumbPx}px` }}>
              <FoodPhoto
                src={getSideImageUrl(name, menuItems, configSides)}
                alt={name}
                style={{ width: '100%', height: '100%', borderRadius: '8px' }}
              />
              {qty > 1 && (
                <div style={{
                  position: 'absolute',
                  top: '-5px',
                  right: '-5px',
                  background: BRAND.gold,
                  color: BRAND.charcoalDark,
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  fontSize: `${pillPx}px`,
                  lineHeight: 1.3,
                  padding: '1px 6px',
                  borderRadius: '10px',
                }}>{qty}x</div>
              )}
              {sizeTag && (
                <div style={{
                  position: 'absolute',
                  bottom: '3px',
                  right: '3px',
                  background: BRAND.gold,
                  color: BRAND.charcoalDark,
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  fontSize: `${pillPx}px`,
                  lineHeight: 1.3,
                  padding: '1px 5px',
                  borderRadius: '4px',
                  letterSpacing: '0.5px',
                }}>{sizeTag}</div>
              )}
            </div>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
              color: BRAND.cream,
              fontSize: `${captionPx}px`,
              lineHeight: 1.1,
              textAlign: 'center',
              letterSpacing: '0.5px',
            }}>{name}</div>
          </div>
        );
      })}
    </div>
  );
}

// Compact side chips for the order-card rail: a VERTICAL stack beside
// the entree photo (or a horizontal wrap row for order-level sides).
// Each chip = small thumb + name to its right, so sides sit in the
// same eye line as the entree — photo → sides → copy — instead of a
// heavy row below. SideThumbRow (caption-under-photo cells) remains
// for focus mode.
function SideStack({ sides, dense = false, horizontal = false, menuItems, configSides, prefix }) {
  const list = (sides || []).filter((sd) => sd && (typeof sd === 'string' ? sd : sd.name));
  if (list.length === 0) return null;
  const thumb = dense ? 40 : 52;
  const captionPx = dense ? 11 : 13;
  const pillPx = dense ? 10 : 11;
  return (
    <div style={{
      display: 'flex',
      flexDirection: horizontal ? 'row' : 'column',
      flexWrap: horizontal ? 'wrap' : 'nowrap',
      gap: '6px',
      alignItems: horizontal ? 'center' : 'stretch',
    }}>
      {prefix && (
        <div style={{
          alignSelf: 'center',
          color: BRAND.gold,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          fontSize: `${Math.round(thumb / 2.4)}px`,
          lineHeight: 1,
          flexShrink: 0,
        }}>{prefix}</div>
      )}
      {list.map((side, i) => {
        const name = typeof side === 'string' ? side : side.name;
        const qty = (typeof side === 'object' && side.quantity) || 1;
        const sizeTag = (typeof side === 'object' && side.size && side.size !== 'regular')
          ? (side.size === 'large' ? 'LG' : 'SM')
          : null;
        return (
          <div key={`${name}-${i}`} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: BRAND.charcoalLight,
            borderRadius: '6px',
            padding: '4px',
            minWidth: 0,
            ...(horizontal ? { paddingRight: '10px' } : {}),
          }}>
            {/* Badges on a relative wrapper — FoodPhoto's
                overflow:hidden would clip the overhanging qty pill. */}
            <div style={{ position: 'relative', width: `${thumb}px`, height: `${thumb}px`, flexShrink: 0 }}>
              <FoodPhoto
                src={getSideImageUrl(name, menuItems, configSides)}
                alt={name}
                style={{ width: '100%', height: '100%', borderRadius: '5px' }}
              />
              {qty > 1 && (
                <div style={{
                  position: 'absolute',
                  top: '-4px',
                  right: '-4px',
                  background: BRAND.gold,
                  color: BRAND.charcoalDark,
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  fontSize: `${pillPx}px`,
                  lineHeight: 1.3,
                  padding: '0 5px',
                  borderRadius: '8px',
                }}>{qty}x</div>
              )}
              {sizeTag && (
                <div style={{
                  position: 'absolute',
                  bottom: '2px',
                  right: '2px',
                  background: BRAND.gold,
                  color: BRAND.charcoalDark,
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  fontSize: `${pillPx}px`,
                  lineHeight: 1.3,
                  padding: '0 4px',
                  borderRadius: '3px',
                }}>{sizeTag}</div>
              )}
            </div>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
              color: BRAND.cream,
              fontSize: `${captionPx}px`,
              lineHeight: 1.15,
              letterSpacing: '0.5px',
              minWidth: 0,
            }}>{name}</div>
          </div>
        );
      })}
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

  // ── Device pairing token ──────────────────────────────
  // Minted by an admin (POST /api/line-coach/device-token) and handed
  // to a screen as ?dt=<jwt>. Persisted to localStorage on first load
  // so a launch WITHOUT the query string stays paired — that's the case
  // when a manager adds the page to their iPad home screen, since iOS
  // resolves the manifest's start_url and drops the query string. The
  // Pi kiosks relaunch from a fixed URL that still carries ?dt=, so
  // they never depend on the fallback.
  //
  // Same post-mount pattern as touch/language above: SSR and first
  // client render both see null, so no hydration mismatch.
  const [deviceToken, setDeviceToken] = useState(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let tok = null;
    try {
      tok = new URLSearchParams(window.location.search).get('dt');
    } catch { /* malformed query — fall through to storage */ }
    if (tok) {
      try { window.localStorage.setItem('lc-device-token', tok); } catch { /* private mode */ }
    } else {
      try { tok = window.localStorage.getItem('lc-device-token'); } catch { /* private mode */ }
    }
    setDeviceToken(tok || null);
  }, []);

  // Set when a write comes back 401 — the screen is unpaired, revoked,
  // or superseded by a re-issued link. Surfaced as a persistent banner:
  // a KDS that silently stops bumping is worse than one that says why.
  const [pairingError, setPairingError] = useState(null);

  // Every mutating call goes through this so the token is attached in
  // exactly one place. Reads (orders, config) stay unauthenticated.
  const authFetch = useCallback(async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
      let reason = null;
      try { reason = (await res.clone().json())?.reason || null; } catch { /* non-JSON body */ }
      setPairingError(reason || 'unauthorized');
    } else if (res.ok) {
      setPairingError(null);
    }
    return res;
  }, [deviceToken]);

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

  // Learn mode (new-hire build-step walkthroughs). Per-device toggle
  // persisted like lc-language; the admin's per-store master switch
  // (settings.learn_mode_enabled) gates it entirely — when off, the
  // header button disappears and stale localStorage is harmless.
  // SSR-safe: starts false, resolved post-mount.
  const [learnMode, setLearnMode] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setLearnMode(window.localStorage.getItem('lc-learn-mode') === '1');
    } catch { /* localStorage blocked — stays off */ }
  }, []);

  function toggleLearnMode() {
    setLearnMode((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('lc-learn-mode', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }

  const learnModeAllowed = config?.settings?.learn_mode_enabled === true;
  const learnModeOn = learnModeAllowed && learnMode;

  // Checklists (opening / closing / prep). Templates + today's runs
  // come from the checklist-runs endpoint, NOT the hourly config poll,
  // so admin edits land within a minute. One request per minute per
  // kiosk normally; 10s while the overlay is open so two tablets
  // working the same list agree quickly. Item toggles are optimistic
  // and reconciled by the next poll (or an immediate refetch when the
  // server refuses — e.g. the run was signed on another tablet).
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklistData, setChecklistData] = useState(null);

  const fetchChecklists = useCallback(() => {
    fetch(`/api/line-coach/checklist-runs?store=${storeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.checklists)) setChecklistData(data);
      })
      .catch(() => { /* keep last good value */ });
  }, [storeId]);

  useEffect(() => {
    fetchChecklists();
    const interval = setInterval(fetchChecklists, checklistOpen ? 10_000 : 60_000);
    return () => clearInterval(interval);
  }, [fetchChecklists, checklistOpen]);

  // Stable identities: ChecklistOverlay keys its idle timer on these,
  // and the parent re-renders every second (setNow) — inline arrows
  // would reset the 3-min idle clock every render.
  const openChecklists = useCallback(() => setChecklistOpen(true), []);
  const closeChecklists = useCallback(() => setChecklistOpen(false), []);

  const toggleChecklist = useCallback((checklistId, itemId, checked) => {
    setChecklistData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        checklists: prev.checklists.map((c) => {
          if (c.id !== checklistId || c.run?.completed_at) return c;
          const checkedItems = { ...(c.run?.checked_items || {}) };
          if (checked) checkedItems[itemId] = { at: new Date().toISOString(), device_id: null };
          else delete checkedItems[itemId];
          return { ...c, run: { completed_at: null, completed_by: null, ...(c.run || {}), checked_items: checkedItems } };
        }),
      };
    });
    let deviceId = null;
    try { deviceId = window.localStorage.getItem(`lc-device-id-${storeId}`); } catch { /* ignore */ }
    authFetch('/api/line-coach/checklist-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, checklist_id: checklistId, item_id: itemId, checked, device_id: deviceId }),
    })
      .then((r) => { if (!r.ok) fetchChecklists(); })
      .catch(() => { /* next poll reconciles */ });
  }, [storeId, fetchChecklists]);

  const completeChecklist = useCallback(async (checklistId, initials) => {
    const res = await authFetch('/api/line-coach/checklist-runs/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, checklist_id: checklistId, initials }),
    });
    const data = await res.json().catch(() => ({}));
    fetchChecklists();
    if (!res.ok) throw new Error(data.error || 'Sign-off failed');
    return data;
  }, [storeId, fetchChecklists]);

  const checklists = checklistData?.checklists || [];
  const dueChecklists = checklists.filter((c) => c.due_now && !c.run?.completed_at);

  // Shared render pieces, spliced into every branch's return: the
  // header chip props, the overlay (fixed-position, DOM order doesn't
  // matter), and the slow-period nudge banner.
  const checklistHeaderProps = {
    checklistAvailable: checklists.length > 0,
    checklistDue: dueChecklists.length,
    onChecklistOpen: openChecklists,
  };
  const checklistOverlay = checklistOpen && checklists.length > 0 ? (
    <ChecklistOverlay
      checklists={checklists}
      language={language}
      onClose={closeChecklists}
      onToggle={toggleChecklist}
      onComplete={completeChecklist}
    />
  ) : null;
  const checklistNudge = (
    <ChecklistNudge dueChecklists={dueChecklists} language={language} onOpen={openChecklists} />
  );

  // ── Bird oven log ─────────────────────────────────────
  // Chicken is the critical-path cook (30–35 min): every entree waits
  // on it. Cooks log batches via the BIRDS overlay; state is derived
  // client-side from timestamps + brand thresholds so countdowns tick
  // locally between polls (30s idle / 10s with the log open).
  const [birdData, setBirdData] = useState(null);
  const [birdOverlayOpen, setBirdOverlayOpen] = useState(false);

  const fetchBirds = useCallback(() => {
    fetch(`/api/line-coach/bird-log?store=${storeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.batches)) setBirdData(data);
      })
      .catch(() => { /* keep last good value */ });
  }, [storeId]);

  useEffect(() => {
    fetchBirds();
    const interval = setInterval(fetchBirds, birdOverlayOpen ? 10_000 : 30_000);
    return () => clearInterval(interval);
  }, [fetchBirds, birdOverlayOpen]);

  const openBirdLog = useCallback(() => setBirdOverlayOpen(true), []);
  const closeBirdLog = useCallback(() => setBirdOverlayOpen(false), []);

  const birdAction = useCallback(async (payload) => {
    let deviceId = null;
    try { deviceId = window.localStorage.getItem(`lc-device-id-${storeId}`); } catch { /* ignore */ }
    try {
      await authFetch('/api/line-coach/bird-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, device_id: deviceId, ...payload }),
      });
    } catch { /* poll reconciles */ }
    fetchBirds();
  }, [storeId, fetchBirds]);

  const birdCookMin = birdData?.cook_minutes ?? 32;
  const birdWindowMin = birdData?.carve_window_minutes ?? 40;
  const birdActive = (birdData?.batches || []).filter((b) => !b.resolved_at);
  const birdCooking = birdActive.filter((b) => !b.pulled_at);
  const birdHolding = birdActive.filter((b) => b.pulled_at);
  const birdMinsSince = (iso) => (now.getTime() - new Date(iso).getTime()) / 60_000;
  const birdPullDue = birdCooking.filter((b) => birdMinsSince(b.in_oven_at) >= birdCookMin);
  const birdShredDue = birdHolding.filter((b) => birdMinsSince(b.pulled_at) >= birdWindowMin);
  const birdAlertCount = birdPullDue.length + birdShredDue.length;

  // Chime once per batch the moment it first hits PULL NOW — reuses
  // the order-arrival chime; a forgotten batch is the most expensive
  // miss on the line. Set-guarded so re-renders don't re-ring.
  const birdChimedRef = useRef(new Set());
  useEffect(() => {
    for (const b of birdPullDue) {
      if (!birdChimedRef.current.has(b.id)) {
        birdChimedRef.current.add(b.id);
        playChime();
      }
    }
  });

  const birdHeaderProps = {
    birdAvailable: birdData != null,
    birdCookingQty: birdCooking.reduce((sum, b) => sum + (b.qty || 0), 0),
    // Warmer count = cooked minus what incoming orders already drew
    // (smart reduction) — the chip shows real availability.
    birdHoldingQty: Math.round(birdHolding.reduce(
      (sum, b) => sum + Math.max(0, (b.qty || 0) - (Number(b.consumed_qty) || 0)),
      0
    ) * 100) / 100,
    birdAlert: birdAlertCount,
    onBirdOpen: openBirdLog,
  };
  const birdOverlay = birdOverlayOpen && birdData ? (
    <BirdLogOverlay
      batches={birdData.batches || []}
      cookMin={birdCookMin}
      windowMin={birdWindowMin}
      now={now}
      language={language}
      onClose={closeBirdLog}
      onAction={birdAction}
    />
  ) : null;
  const birdBanner = (
    <BirdAlertBanner pullDue={birdPullDue} shredDue={birdShredDue} language={language} onOpen={openBirdLog} />
  );

  // Unpaired / revoked screen. The board keeps rendering orders (reads
  // are open) but nothing it does will stick, so say so loudly rather
  // than let a cook hold a card over and over wondering why it won't
  // clear. Bilingual because the line is Spanish-first.
  const pairingBanner = pairingError ? (
    <PairingBanner reason={pairingError} language={language} />
  ) : null;

  // ── Recipe reference ──────────────────────────────────
  // Read-only step-by-step reference for everything the line executes:
  // entrees (menu_items.build_steps) + sides (sides.build_steps), both
  // synced from the Culinary OS Layer 3. Unlike Learn mode (slow-period
  // practice), this opens anytime from the header chip and shows the
  // full step list at once — mid-service lookup, not training.
  const [recipesOpen, setRecipesOpen] = useState(false);
  const openRecipes = useCallback(() => setRecipesOpen(true), []);
  const closeRecipes = useCallback(() => setRecipesOpen(false), []);

  const referenceRecipes = [
    ...(config?.menu_items || []).map((m) => ({ ...m, steps: normalizeSteps(m.build_steps), kind: 'entree' })),
    ...(config?.sides || []).map((sd) => ({ ...sd, steps: normalizeSteps(sd.build_steps), kind: 'side' })),
  ].filter((r) => r.steps.length > 0);

  const recipeHeaderProps = {
    recipesAvailable: referenceRecipes.length > 0,
    onRecipesOpen: openRecipes,
  };
  const recipeOverlay = recipesOpen && referenceRecipes.length > 0 ? (
    <RecipeOverlay
      recipes={referenceRecipes}
      language={language}
      menuItems={config?.menu_items || []}
      configSides={config?.sides || []}
      onClose={closeRecipes}
    />
  ) : null;

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
    const fetchConfig = () =>
      fetch(`/api/line-coach/config?store=${storeId}`)
        .then((r) => r.json())
        .then(setConfig)
        .catch(console.error);
    fetchConfig();
    // Kiosks run unattended for days — re-poll so daily-generated
    // feedback tips and admin config edits land without a reload.
    // 15 min (was 60): learn_mode_enabled and menu/build-step edits
    // shouldn't take an hour to reach a wall display. Checklist
    // content doesn't ride this poll at all (checklist-runs endpoint).
    const interval = setInterval(fetchConfig, 15 * 60_000);
    return () => clearInterval(interval);
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
    // Paired screens identify themselves by token — the server reads
    // the device id off the JWT, so nothing device-specific goes in the
    // body. Unpaired screens fall back to the legacy self-minted id,
    // which is what keeps the six live Pi kiosks heartbeating until
    // they're re-paired. That branch retires with the grace period.
    let deviceId = null;
    if (!deviceToken) {
      const storageKey = `lc-device-id-${storeId}`;
      try {
        deviceId = localStorage.getItem(storageKey);
      } catch { /* private mode / SSR */ }
      if (!deviceId) {
        deviceId = `display-${storeId}-${Math.random().toString(36).slice(2, 10)}`;
        try { localStorage.setItem(storageKey, deviceId); } catch { /* ignore */ }
      }
    }

    let cancelled = false;
    const body = deviceToken
      ? { store_id: storeId, device_type: 'kds' }
      : { device_id: deviceId, store_id: storeId, device_type: 'kds' };

    const register = () =>
      authFetch('/api/line-coach/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});

    const heartbeat = async () => {
      if (cancelled) return;
      try {
        const res = await authFetch('/api/line-coach/devices/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deviceToken ? {} : { device_id: deviceId }),
        });
        // 404 means the row is gone (admin removed it, or this screen
        // has never registered). Re-register and let the next tick
        // confirm — except when revoked, where re-registering would
        // just 401 again.
        if (res.status === 404) await register();
      } catch { /* network blip — next tick will retry */ }
    };

    register().then(heartbeat);
    const interval = setInterval(heartbeat, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [storeId, deviceToken, authFetch]);

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
      const res = await authFetch('/api/line-coach/bump', {
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
      await authFetch('/api/line-coach/unbump', {
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
  // configs continue to work via normalizeTip. Two sources feed one
  // rotation: brand-wide curated quality_tips, and per-store feedback_tips
  // generated from Momos customer reviews. Each tip carries a `source`
  // tag so the Quality Coach view can label where it came from —
  // normalizeTip only keeps { en, es }, so tags attach after normalizing.
  const hasTipText = (t) => (t.en && t.en.trim()) || (t.es && t.es.trim());
  const curatedTips = (config?.quality_tips || [])
    .map(normalizeTip)
    .filter(hasTipText)
    .map((t) => ({ ...t, source: 'quality' }));
  const feedbackTipsEnabled = config?.settings?.feedback_tips_enabled !== false;
  const feedbackTips = feedbackTipsEnabled
    ? (config?.feedback_tips || [])
        .map((raw) => ({
          ...normalizeTip(raw),
          source: 'feedback',
          source_quote: raw && typeof raw.source_quote === 'string' ? raw.source_quote.trim() : '',
        }))
        .filter(hasTipText)
    : [];
  const tips = interleaveTips(curatedTips, feedbackTips);

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
        // Packaging pseudo-items split off here (the one mapping choke
        // point) so every surface — card, focus mode, detail sheet —
        // sees clean food items plus a `packaging` callout list.
        const rawItems = order.items || [];
        const packaging = rawItems.filter((it) => isPackagingItem(it?.name)).map((it) => it.name);
        // Collapse duplicate line items: Toast sends "5 × $2 Taco"
        // rung in as separate lines as five qty-1 selections. Same
        // name + same modifier set → one row with a summed "5x"
        // (per-item side counts summed too). Items with differing
        // modifiers stay separate on purpose — merging would hide
        // which taco has no onions.
        const collapsed = [];
        const collapseKeys = new Map();
        for (const it of rawItems.filter((x) => !isPackagingItem(x?.name))) {
          const key = `${it.name}|${(it.modifiers || []).join('¦')}`;
          const prev = collapseKeys.get(key);
          if (!prev) {
            const copy = {
              ...it,
              quantity: Number(it.quantity) || 1,
              sides: Array.isArray(it.sides) ? it.sides.map((sd) => ({ ...sd })) : it.sides,
            };
            collapseKeys.set(key, copy);
            collapsed.push(copy);
            continue;
          }
          prev.quantity += Number(it.quantity) || 1;
          if (Array.isArray(prev.sides) && Array.isArray(it.sides)) {
            for (const sd of it.sides) {
              const match = prev.sides.find((p) => p.name === sd.name && (p.size || 'regular') === (sd.size || 'regular'));
              if (match) match.quantity = (Number(match.quantity) || 1) + (Number(sd.quantity) || 1);
              else prev.sides.push({ ...sd });
            }
          }
        }
        const items = collapsed.map((item) => {
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
          packaging,
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


  // ── Learn mode walkthroughs (slow period) ───────────
  // While LEARN is on, quiet periods become a training session. The
  // attract rotation rides qualityTipIndex as before; tapping hands
  // control to the trainee (dish picker → paced step-through) inside
  // LearnModeScreen. Session state lives in that child, so when
  // orders arrive and this branch stops rendering, the half-finished
  // session is discarded automatically — service always wins. Zero
  // items with steps → falls through to the normal tips branch.

  const learnItems = learnModeOn
    ? menuItems
        .map((m) => ({ ...m, steps: normalizeSteps(m.build_steps) }))
        .filter((m) => m.steps.length > 0)
    : [];

  if (isSlowPeriod && learnItems.length > 0) {
    return (
      <LearnModeScreen
        learnItems={learnItems}
        rotationIndex={qualityTipIndex}
        language={language}
        menuItems={menuItems}
        configSides={configSides}
        headerProps={{
          now,
          orderCount: 0,
          staleCount,
          language,
          onLanguageToggle: toggleLanguage,
          learnAllowed: learnModeAllowed,
          learnMode,
          onLearnToggle: toggleLearnMode,
          ...checklistHeaderProps,
          ...birdHeaderProps,
          ...recipeHeaderProps,
        }}
        checklistNudge={<>{birdBanner}{checklistNudge}</>}
        checklistOverlay={<>{checklistOverlay}{birdOverlay}{recipeOverlay}</>}
      />
    );
  }

  // ── Quality Coach mode ──────────────────────────────

  if (isSlowPeriod && tips.length > 0) {
    const tip = tips[qualityTipIndex % tips.length];
    // Single-language mode: pickTipText falls back to the other
    // language silently if the chosen one is empty, so a partially-
    // translated tip still renders something useful.
    const text = pickTipText(tip, language);
    // Feedback tips come from real Momos customer reviews — label them so
    // the crew knows this is what guests actually said, not the standard
    // coaching deck. Terracotta tint separates the two at a glance.
    const isFeedbackTip = tip.source === 'feedback';
    const tipLabel = isFeedbackTip
      ? (language === 'es' ? 'COMENTARIOS DE CLIENTES' : 'CUSTOMER FEEDBACK')
      : 'QUALITY COACH';
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
        <style>{`
          @keyframes lcQualityFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes lcLearnPulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
        `}</style>
        <Header now={now} orderCount={0} staleCount={staleCount} language={language} onLanguageToggle={toggleLanguage} learnAllowed={learnModeAllowed} learnMode={learnMode} onLearnToggle={toggleLearnMode} {...checklistHeaderProps} {...birdHeaderProps} {...recipeHeaderProps} />
        {pairingBanner}
        {birdBanner}
        {checklistNudge}
        {checklistOverlay}
        {birdOverlay}
        {recipeOverlay}
        <div style={s.qualityCoach}>
          <div style={{ ...s.qualityLabel, ...(isFeedbackTip ? { color: BRAND.terracotta } : {}) }}>{tipLabel}</div>
          <div style={s.qualityTipBlock} key={`${qualityTipIndex}-${language}`}>
            {text && (
              <div style={s.qualityLangSection}>
                <div style={tipStyle}>{text}</div>
                {isFeedbackTip && tip.source_quote && (
                  <div style={{
                    marginTop: '2.5vh',
                    color: `${BRAND.cream}A0`,
                    fontStyle: 'italic',
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 'clamp(1rem, 1.6vw, 1.6rem)',
                  }}>
                    &ldquo;{tip.source_quote}&rdquo;
                  </div>
                )}
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
    // Focus mode mirrors the rush/comfortable card's bump gesture: hold
    // anywhere on the order canvas for HOLD_DURATION_MS to bump, with
    // the same optimistic UI + UndoToast path. Short taps do nothing in
    // focus (the whole order is already visible — opening a detail
    // sheet would be redundant), so we omit fromPointerUp.
    const focusIsHolding = !!holdProgress && order.id != null && holdProgress.orderId === order.id;
    const focusHoldPct = focusIsHolding ? holdProgress.pct : 0;
    const focusOrderHandlers = touchEnabled && order.id ? {
      onPointerDown: (e) => {
        if (e.button && e.button !== 0) return;
        startHold(order.id, order);
      },
      onPointerUp: () => cancelHold(order.id),
      onPointerLeave: () => cancelHold(order.id),
      onPointerCancel: () => cancelHold(order.id),
    } : {};
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
    // Learn mode: the coaching panel becomes a numbered build walkthrough
    // for the focused entree. Items without steps fall back to the
    // normal coach-tip path so the panel is never blank.
    const primarySteps = learnModeOn ? normalizeSteps(primaryMenu?.build_steps) : [];
    const showBuildSteps = primarySteps.length > 0;

    const ticketBorderColor = order.priority === 'rush' ? BRAND.red : order.ticketColor;
    const diningColors = {
      'dine in': BRAND.gold,
      'takeout': BRAND.blue,
      'delivery': BRAND.cream,
    };
    const diningLabel = order.diningOption || '';
    const diningColor = diningColors[diningLabel.toLowerCase()] || BRAND.blue;
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
        <Header now={now} orderCount={1} language={language} onLanguageToggle={toggleLanguage} learnAllowed={learnModeAllowed} learnMode={learnMode} onLearnToggle={toggleLearnMode} {...checklistHeaderProps} {...birdHeaderProps} {...recipeHeaderProps} />
        {pairingBanner}
        {birdBanner}
        {checklistOverlay}
        {birdOverlay}
        {recipeOverlay}

        <div
          className="lc-no-callout"
          {...focusOrderHandlers}
          style={{
            position: 'relative',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            // See the card comment below — 'pan-y' keeps a scroll gesture
            // from being read as a hold-to-bump.
            touchAction: touchEnabled ? 'pan-y' : 'auto',
            transform: focusIsHolding ? 'scale(0.99)' : 'scale(1)',
            transition: focusIsHolding ? 'none' : 'transform 120ms ease-out',
          }}>
          {/* Hold-to-bump progress strip — mirrors the card's gradient
              fill, adapted for full-screen: a thin top bar that fills
              left-to-right as the hold progresses. Only renders while
              the user is actually holding. */}
          {focusIsHolding && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '6px',
              background: BRAND.charcoalDark,
              zIndex: 20,
              pointerEvents: 'none',
            }}>
              <div style={{
                width: `${focusHoldPct * 100}%`,
                height: '100%',
                background: BRAND.green,
                transition: 'none',
              }} />
            </div>
          )}
          {focusIsHolding && (
            <div style={{
              position: 'absolute',
              top: '14px',
              right: '14px',
              background: BRAND.green,
              color: BRAND.charcoalDark,
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              fontSize: '0.95rem',
              padding: '4px 12px',
              borderRadius: '999px',
              zIndex: 20,
              pointerEvents: 'none',
            }}>Hold to bump</div>
          )}

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

        {order.packaging?.length > 0 && (
          <div style={{
            background: BRAND.gold,
            color: BRAND.charcoal,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            fontSize: 'clamp(1.2rem, 1.8vw, 1.8rem)',
            padding: '12px 24px',
            margin: '12px 16px 0 16px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
          }}>
            <span>🍴</span>
            <span>{order.packaging.join(' · ')}</span>
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
        <div key={`focus-${focusItemIndex % itemCount}-${language}-${learnModeOn ? 'learn' : 'coach'}`} style={{
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
            {(order.sides || []).length > 0 && (
              <SideThumbRow
                sides={order.sides}
                thumbPx={110}
                menuItems={menuItems}
                configSides={configSides}
                prefix="w/"
              />
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
                {showBuildSteps
                  ? (language === 'es' ? 'PASOS DE PREPARACIÓN' : 'BUILD STEPS')
                  : (primaryCoachTip && (primaryCoachTip.en || primaryCoachTip.es) ? 'COACH' : 'QUALITY COACH')}
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
            {showBuildSteps ? (
              // Numbered build walkthrough. Font scales down past 6 steps
              // so a long build stays fully visible (a wall display can't
              // be scrolled mid-cook); overflowY is the safety net for
              // extreme lists.
              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
                {primarySteps.map((step, si) => {
                  const stepText = pickTipText(step, language);
                  if (!stepText) return null;
                  return (
                    <div key={si} style={{ display: 'flex', gap: '14px', alignItems: 'baseline' }}>
                      <span style={{
                        flexShrink: 0,
                        minWidth: '1.8em',
                        color: BRAND.gold,
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: primarySteps.length > 6 ? 'clamp(1rem, 1.4vw, 1.4rem)' : 'clamp(1.2rem, 1.7vw, 1.7rem)',
                      }}>{si + 1}.</span>
                      <span style={{
                        fontSize: primarySteps.length > 6 ? 'clamp(1rem, 1.5vw, 1.5rem)' : 'clamp(1.2rem, 1.8vw, 1.8rem)',
                        color: language === 'en' ? BRAND.bone : BRAND.cream,
                        fontFamily: "'Playfair Display', Georgia, serif",
                        lineHeight: 1.3,
                        fontStyle: language === 'es' ? 'italic' : 'normal',
                      }}>{stepText}</span>
                    </div>
                  );
                })}
              </div>
            ) : tipText ? (
              <div style={{
                fontSize: language === 'en' ? 'clamp(1.6rem, 2.6vw, 2.6rem)' : 'clamp(1.4rem, 2.3vw, 2.3rem)',
                color: language === 'en' ? BRAND.bone : BRAND.cream,
                fontFamily: "'Playfair Display', Georgia, serif",
                lineHeight: 1.3,
                fontStyle: language === 'es' ? 'italic' : 'normal',
              }}>{tipText}</div>
            ) : (
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
      <Header now={now} orderCount={visibleOrders.length} staleCount={staleCount} language={language} onLanguageToggle={toggleLanguage} learnAllowed={learnModeAllowed} learnMode={learnMode} onLearnToggle={toggleLearnMode} {...checklistHeaderProps} {...birdHeaderProps} {...recipeHeaderProps} />
      {pairingBanner}
      {birdBanner}
      {checklistOverlay}
      {birdOverlay}
      {recipeOverlay}
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
          <div style={s.orderListContainer}>
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

              return (
                <>
                  {visibleOrders.map((order, oi) => {
                    const diningLabel = order.diningOption || '';
                    const diningColor = diningColors[diningLabel.toLowerCase()] || BRAND.blue;
                    const ticketBorderColor = order.priority === 'rush' ? BRAND.red : order.ticketColor;
                    // Per-item side pairing with strict attribution:
                    //  1. An entree's rail shows item.sides (from THAT
                    //     Toast selection's modifiers) and nothing else.
                    //  2. Unattached non-à-la-carte order-level sides
                    //     (legacy rows; meal sides rung as separate
                    //     lines) re-attach ONLY when the order has
                    //     exactly one entree — the only possible owner.
                    //  3. Anything still ambiguous renders in a labeled
                    //     SIDES · ORDER row at the card bottom — never
                    //     visually attached to whichever item happens
                    //     to sit above it (the #1047 mispairing).
                    const itemsCarrySides = order.items.some((it) => Array.isArray(it.sides) && it.sides.length > 0);
                    const unattachedSides = itemsCarrySides
                      ? (order.sides || []).filter((side) => side && side.alaCarte)
                      : (order.sides || []);
                    const nonAlaCarteUnattached = unattachedSides.filter((side) => side && !side.alaCarte);
                    const reattachToSolo = !itemsCarrySides && order.items.length === 1 && nonAlaCarteUnattached.length > 0;
                    const soloExtraSides = reattachToSolo ? nonAlaCarteUnattached : [];
                    const looseSides = reattachToSolo
                      ? unattachedSides.filter((side) => side && side.alaCarte)
                      : unattachedSides;
                    const looseAllAlaCarte = looseSides.length > 0 && looseSides.every((side) => side && side.alaCarte);
                    const cardHasSides = itemsCarrySides || soloExtraSides.length > 0 || looseSides.length > 0;
                    const railW = isComfortable ? 140 : 120;
                    // x-offset of the text column, for order-level rows
                    // (loose sides, notes) to align with the copy above.
                    const textIndent = `${parseInt(photoSize, 10) + 12 + (cardHasSides ? railW + 12 : 0)}px`;
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
                        className="lc-no-callout"
                        {...orderHandlers}
                        style={{
                          marginTop: oi > 0 ? '8px' : 0,
                          padding: rowPad,
                          position: 'relative',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                          // 'pan-y', not 'none': the board can overflow on a
                          // short tablet viewport, and 'none' would swallow
                          // the scroll and run the hold timer to completion —
                          // a swipe would bump the order. With 'pan-y' the
                          // browser claims a vertical drag as a scroll and
                          // fires pointercancel, which the onPointerCancel
                          // handler above already routes to cancelHold.
                          touchAction: touchEnabled ? 'pan-y' : 'auto',
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
                      {order.packaging?.length > 0 && (
                        // Packing callout (utensils / napkins) — gold
                        // banner, not an item row. See isPackagingItem.
                        <div style={{
                          background: BRAND.gold,
                          color: BRAND.charcoal,
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 700,
                          letterSpacing: '1.5px',
                          textTransform: 'uppercase',
                          fontSize: isComfortable ? '1.6rem' : '1.4rem',
                          padding: isComfortable ? '10px 22px' : '8px 18px',
                          marginBottom: '6px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                        }}>
                          <span>🍴</span>
                          <span>{order.packaging.join(' · ')}</span>
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
                            const railSides = [
                              ...(Array.isArray(item.sides) ? item.sides : []),
                              ...(ii === 0 ? soloExtraSides : []),
                            ];
                            // Three-column item row: photo | side rail |
                            // copy. One visual rail on the left, all text
                            // fills the right — the eye scans one line:
                            // photo → sides → words.
                            return (
                            <div key={ii} style={{
                              display: 'flex',
                              gap: '12px',
                              minWidth: 0,
                              alignItems: 'flex-start',
                              ...(ii > 0 ? { borderTop: `1px solid ${BRAND.charcoalLight}`, paddingTop: '10px', marginTop: '8px' } : {}),
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
                              {cardHasSides && (
                                // Fixed-width rail so every text column in
                                // the card starts at the same x; items
                                // without sides get the empty spacer.
                                <div style={{ width: `${railW}px`, flexShrink: 0 }}>
                                  <SideStack
                                    sides={railSides}
                                    dense={!isComfortable}
                                    menuItems={menuItems}
                                    configSides={configSides}
                                  />
                                </div>
                              )}
                              <div style={{
                                flex: 1,
                                minWidth: 0,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '4px',
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flexWrap: 'wrap' }}>
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
                                    lineHeight: 1.1,
                                    minWidth: 0,
                                  }}>
                                    {item.quantity > 1 && (
                                      <span style={{ color: BRAND.gold, marginRight: '6px' }}>{item.quantity}x</span>
                                    )}
                                    {item.name}
                                  </div>
                                </div>
                                {/* Modifiers under the name fill the right
                                    column. One per line, deviations gold
                                    first; cosmetic restatements filtered by
                                    classifyModifier. */}
                                <ModifierLines modifiers={item.modifiers} size={modifierSize} />
                                <AccuracyNote note={menuMatch?.accuracy_note} language={language} size={modifierSize} />
                                {isComfortable && (
                                  <CoachLine tip={menuMatch?.coach_tip} language={language} size={modifierSize} />
                                )}
                              </div>
                            </div>
                            );
                          })}
                          {looseSides.length > 0 && (
                            // Unattached sides: à-la-carte gets the '+'
                            // glyph; anything ambiguous is labeled so it
                            // can't be misread as the item above's.
                            <div style={{
                              borderTop: `1px solid ${BRAND.charcoalLight}`,
                              marginTop: '8px',
                              paddingTop: '8px',
                              paddingLeft: textIndent,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              flexWrap: 'wrap',
                            }}>
                              {!looseAllAlaCarte && (
                                <span style={{
                                  fontFamily: "'Oswald', sans-serif",
                                  fontWeight: 700,
                                  letterSpacing: '2px',
                                  textTransform: 'uppercase',
                                  color: BRAND.gold,
                                  fontSize: isComfortable ? '1rem' : '0.85rem',
                                  flexShrink: 0,
                                }}>{language === 'es' ? 'GUARNICIONES · ORDEN' : 'SIDES · ORDER'}</span>
                              )}
                              <SideStack
                                sides={looseSides}
                                dense={!isComfortable}
                                horizontal
                                menuItems={menuItems}
                                configSides={configSides}
                                prefix={looseAllAlaCarte ? '+' : undefined}
                              />
                            </div>
                          )}
                          {inlineNote && (
                            <div style={{
                              fontSize: sidesLineSize,
                              lineHeight: 1.3,
                              paddingLeft: textIndent,
                              color: BRAND.gold,
                              fontWeight: 700,
                            }}>⚠ {inlineNote}</div>
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
          {/* Aggregate batch-cook counts — deliberately distinct from
              the per-order side thumbnails on the cards. This panel is
              "what to drop in batches"; the thumbs are "what goes on
              each plate." */}
          <div style={s.sidesPanelHeader}>TOTAL SIDES</div>
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

        {order.packaging?.length > 0 && (
          <div style={{
            background: BRAND.gold,
            color: BRAND.charcoal,
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            fontSize: '1.2rem',
            padding: '10px 16px',
            borderRadius: '6px',
            marginBottom: '20px',
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
          }}>
            <span>🍴</span>
            <span>{order.packaging.join(' · ')}</span>
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
                  // Thumb + text row (not SideThumbRow): the sheet's
                  // list layout carries à-la-carte / ×qty detail the
                  // thumb-column format doesn't, and the sheet is a
                  // slow-read surface.
                  <div key={si} style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.1rem', color: BRAND.cream, padding: '6px 0', borderBottom: `1px solid ${BRAND.charcoalLight}` }}>
                    <FoodPhoto
                      src={getSideImageUrl(sn, menuItems, configSides)}
                      alt={sn}
                      style={{ width: '56px', height: '56px', borderRadius: '8px' }}
                    />
                    <span style={{ flex: 1 }}>
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

// ── Bird oven log ───────────────────────────────────────
// Banner + logging overlay for rotisserie bird batches. Facts come
// from lc_bird_batches via the parent's poll; all timing state is
// derived here from `now` so countdowns tick every second.

// Attention banner: red pulsing when a batch hit cook time (pull it
// before it dries out), gold when warmer batches are past the carve
// window (shred, don't carve). Renders nothing when all is well.
// Shown when a write comes back 401. Reads stay open, so the board
// still looks alive — which is exactly the trap: without this a cook
// holds a card, sees the progress fill, and watches the ticket stay put
// with no explanation. Not a button: there is nothing the line can do
// about it, so it points at the one person who can.
function PairingBanner({ reason, language }) {
  const es = language === 'es';
  const detail = {
    revoked: es ? 'Esta pantalla fue desconectada.' : 'This screen was revoked.',
    superseded: es ? 'Se generó un enlace nuevo para esta pantalla.' : 'A newer link was issued for this screen.',
    unknown_device: es ? 'Esta pantalla ya no está registrada.' : 'This screen is no longer registered.',
    no_device_token: es ? 'Esta pantalla no está vinculada.' : 'This screen is not paired.',
  }[reason] || (es ? 'Esta pantalla no está vinculada.' : 'This screen is not paired.');
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 16px 0' }}>
      <div
        role="status"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 26px',
          borderRadius: '999px',
          background: BRAND.red,
          border: `1px solid ${BRAND.red}`,
          color: BRAND.white,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          fontSize: 'clamp(0.95rem, 1.4vw, 1.4rem)',
          letterSpacing: '2px',
          textTransform: 'uppercase',
          minHeight: '44px',
          textAlign: 'center',
        }}
      >
        {detail} {es ? 'Pide un enlace nuevo al admin.' : 'Ask your admin for a new link.'}
      </div>
    </div>
  );
}

function BirdAlertBanner({ pullDue, shredDue, language, onOpen }) {
  if (pullDue.length === 0 && shredDue.length === 0) return null;
  const es = language === 'es';
  const isPull = pullDue.length > 0;
  const qty = (isPull ? pullDue : shredDue).reduce((sum, b) => sum + (b.qty || 0), 0);
  const text = isPull
    ? (es ? `SACA LOS POLLOS — ${qty} en el horno` : `PULL BIRDS NOW — ${qty} in the oven`)
    : (es ? `PASÓ LA VENTANA — deshebra ${qty} pollos` : `PAST CARVE WINDOW — shred ${qty} birds`);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 16px 0' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 26px',
          borderRadius: '999px',
          background: isPull ? BRAND.red : `${BRAND.gold}22`,
          border: `1px solid ${isPull ? BRAND.red : BRAND.gold}`,
          color: isPull ? BRAND.white : BRAND.gold,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          fontSize: 'clamp(0.95rem, 1.4vw, 1.4rem)',
          letterSpacing: '2px',
          textTransform: 'uppercase',
          cursor: 'pointer',
          minHeight: '44px',
          animation: isPull ? 'lcAllergyPulse 1.4s ease-in-out infinite' : 'none',
        }}
      >
        <span>🍗</span>
        <span>{text}</span>
        <span style={{ opacity: 0.7 }}>{es ? 'TOCA' : 'TAP'}</span>
      </button>
    </div>
  );
}

// Full-screen bird log. Three zones: IN THE OVEN (countdown → PULLED
// button), IN THE WARMER (carve-window state → DONE / SHRED), and the
// big + row for logging a new batch. 3-min idle timeout like the
// checklist overlay; ✕ on a row deletes a mis-logged batch.
const BIRD_IDLE_MS = 180_000;
const BIRD_QTY_OPTIONS = [1, 2, 3, 4];
const BIRD_MAX_QTY = 24;

// Show fractional bird counts cleanly: 2 → "2", 2.5 → "2.5", 2.25 →
// "2.25" (quarter-bird orders draw 0.25 at a time).
function fmtBirdQty(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function BirdLogOverlay({ batches, cookMin, windowMin, now, language, onClose, onAction }) {
  const es = language === 'es';
  const [lastTouch, setLastTouch] = useState(() => Date.now());
  // Custom-qty number pad: null = closed, string = digits typed so far
  // (kiosks have no OS keyboard, so a free-type field needs a pad).
  const [customQty, setCustomQty] = useState(null);

  useEffect(() => {
    const t = setTimeout(onClose, BIRD_IDLE_MS);
    return () => clearTimeout(t);
  }, [lastTouch, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const active = batches.filter((b) => !b.resolved_at);
  const cooking = active.filter((b) => !b.pulled_at);
  const holding = active.filter((b) => b.pulled_at);
  // Batch numbers: position in today's oven-in order (the fetched set
  // is active + resolved-today, so numbers stay stable through the
  // day and match what the admin audit table shows).
  const numbered = [...batches].sort((a, b) => new Date(a.in_oven_at) - new Date(b.in_oven_at));
  const batchNoFor = (id) => numbered.findIndex((b) => b.id === id) + 1;
  const secsSince = (iso) => Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtMmSs = (totalSecs) => {
    const s = Math.max(0, totalSecs);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // Kiosks run in LA local time, so a plain same-day check is enough
  // for the shift counter.
  const isToday = (iso) => new Date(iso).toDateString() === now.toDateString();
  const inToday = batches.filter((b) => isToday(b.in_oven_at)).reduce((sum, b) => sum + (b.qty || 0), 0);
  const shreddedToday = batches
    .filter((b) => b.resolution === 'shredded' && b.resolved_at && isToday(b.resolved_at))
    .reduce((sum, b) => sum + (b.qty || 0), 0);

  const label = {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
  };
  const chip = {
    ...label,
    padding: '10px 20px',
    borderRadius: '999px',
    background: 'transparent',
    color: `${BRAND.gold}CC`,
    border: `1px solid ${BRAND.gold}55`,
    fontSize: 'clamp(0.8rem, 1.1vw, 1.1rem)',
    cursor: 'pointer',
    minHeight: '44px',
    minWidth: '64px',
  };
  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '14px 18px',
    minHeight: '64px',
    borderRadius: '12px',
    background: BRAND.charcoalLight,
  };
  const sectionLabel = {
    ...label,
    color: BRAND.gold,
    fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)',
    margin: '18px 0 10px',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={() => setLastTouch(Date.now())}
        style={{
          width: 'min(940px, 94vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: BRAND.charcoalDark,
          border: `2px solid ${BRAND.gold}`,
          borderRadius: '16px',
          padding: 'clamp(18px, 3vw, 32px)',
          boxSizing: 'border-box',
        }}
      >
        {/* Self-contained keyframes — this overlay renders over every
            branch, and not every branch's style tag defines these. */}
        <style>{`
          @keyframes lcLearnPulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
        `}</style>
        <div style={{ ...label, color: BRAND.gold, fontSize: 'clamp(1rem, 1.5vw, 1.5rem)', textAlign: 'center' }}>
          🍗 {es ? 'REGISTRO DE POLLOS' : 'BIRD LOG'}
        </div>

        <div style={sectionLabel}>{es ? 'EN EL HORNO' : 'IN THE OVEN'}</div>
        {cooking.length === 0 && (
          <div style={{ color: `${BRAND.cream}70`, fontFamily: "'Oswald', sans-serif", letterSpacing: '1px' }}>
            {es ? 'Nada en el horno' : 'Nothing in the oven'}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {cooking.map((b) => {
            const remaining = cookMin * 60 - secsSince(b.in_oven_at);
            const overMin = Math.floor(-remaining / 60);
            return (
              <div key={b.id} style={{ ...rowStyle, border: `1px solid ${remaining <= 0 ? BRAND.red : `${BRAND.cream}25`}` }}>
                <span style={{
                  ...label,
                  flexShrink: 0,
                  color: `${BRAND.gold}CC`,
                  border: `1px solid ${BRAND.gold}55`,
                  borderRadius: '6px',
                  padding: '2px 8px',
                  fontSize: 'clamp(0.8rem, 1vw, 1rem)',
                }}>B{batchNoFor(b.id)}</span>
                <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(1rem, 1.4vw, 1.4rem)', flexShrink: 0 }}>
                  {b.qty} 🍗
                </span>
                <span style={{ color: `${BRAND.cream}90`, fontFamily: "'Oswald', sans-serif", fontSize: 'clamp(0.85rem, 1.1vw, 1.1rem)', flexShrink: 0 }}>
                  {es ? 'ENTRÓ' : 'IN'} {fmtClock(b.in_oven_at)}
                </span>
                <span style={{
                  ...label,
                  flex: 1,
                  textAlign: 'center',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 'clamp(1rem, 1.5vw, 1.5rem)',
                  color: remaining <= 0 ? BRAND.red : BRAND.cream,
                  ...(remaining <= 0 ? { animation: 'lcLearnPulse 1.2s ease-in-out infinite' } : {}),
                }}>
                  {remaining > 0
                    ? `${es ? 'LISTO EN' : 'READY IN'} ${fmtMmSs(remaining)}`
                    : `${es ? 'SÁCALO YA' : 'PULL NOW'}${overMin > 0 ? ` · +${overMin} MIN` : ''}`}
                </span>
                <button
                  type="button"
                  onClick={() => onAction({ action: 'pulled', batch_id: b.id })}
                  style={{
                    ...chip,
                    background: BRAND.gold,
                    color: BRAND.charcoal,
                    border: 'none',
                    minHeight: '56px',
                    padding: '10px 26px',
                  }}
                >
                  {es ? 'AFUERA →' : 'PULLED →'}
                </button>
                <button
                  type="button"
                  aria-label="Remove mis-logged batch"
                  onClick={() => onAction({ action: 'undo', batch_id: b.id })}
                  style={{ ...chip, minWidth: '48px', padding: '10px 12px' }}
                >✕</button>
              </div>
            );
          })}
        </div>

        <div style={sectionLabel}>{es ? 'EN EL CALENTADOR' : 'IN THE WARMER'}</div>
        {holding.length === 0 && (
          <div style={{ color: `${BRAND.cream}70`, fontFamily: "'Oswald', sans-serif", letterSpacing: '1px' }}>
            {es ? 'Nada en el calentador' : 'Nothing in the warmer'}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {holding.map((b) => {
            const heldMin = Math.floor(secsSince(b.pulled_at) / 60);
            const leftMin = windowMin - heldMin;
            // Remaining = cooked minus what incoming orders have
            // already drawn (smart reduction, FIFO server-side).
            const birdRemaining = Math.max(0, (b.qty || 0) - (Number(b.consumed_qty) || 0));
            const state = leftMin <= 0 ? 'shred' : leftMin <= 10 ? 'useFirst' : 'ok';
            const stateColor = state === 'shred' ? BRAND.red : state === 'useFirst' ? BRAND.gold : BRAND.green;
            const stateText = state === 'shred'
              ? `${es ? 'DESHEBRA' : 'SHRED'} · ${-leftMin} MIN ${es ? 'PASADO' : 'PAST'}`
              : state === 'useFirst'
                ? `${es ? 'USA PRIMERO' : 'USE FIRST'} · ${leftMin} MIN`
                : `${es ? 'VENTANA' : 'CARVE'} ${leftMin} MIN`;
            return (
              <div key={b.id} style={{ ...rowStyle, border: `1px solid ${state === 'shred' ? BRAND.red : `${BRAND.cream}25`}` }}>
                <span style={{
                  ...label,
                  flexShrink: 0,
                  color: `${BRAND.gold}CC`,
                  border: `1px solid ${BRAND.gold}55`,
                  borderRadius: '6px',
                  padding: '2px 8px',
                  fontSize: 'clamp(0.8rem, 1vw, 1rem)',
                }}>B{batchNoFor(b.id)}</span>
                <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(1rem, 1.4vw, 1.4rem)', flexShrink: 0 }}>
                  {fmtBirdQty(birdRemaining)} <span style={{ color: `${BRAND.cream}70`, fontSize: '0.75em' }}>/ {b.qty}</span> 🍗
                </span>
                <span style={{ color: `${BRAND.cream}90`, fontFamily: "'Oswald', sans-serif", fontSize: 'clamp(0.85rem, 1.1vw, 1.1rem)', flexShrink: 0 }}>
                  {es ? 'SALIÓ' : 'PULLED'} {fmtClock(b.pulled_at)}
                </span>
                <span style={{
                  ...label,
                  flex: 1,
                  textAlign: 'center',
                  fontSize: 'clamp(1rem, 1.5vw, 1.5rem)',
                  color: stateColor,
                }}>{stateText}</span>
                <button
                  type="button"
                  onClick={() => onAction({ action: 'resolve', batch_id: b.id, resolution: 'used' })}
                  style={{ ...chip, minHeight: '56px' }}
                >
                  {es ? 'SE USÓ' : 'DONE'}
                </button>
                <button
                  type="button"
                  onClick={() => onAction({ action: 'resolve', batch_id: b.id, resolution: 'shredded' })}
                  style={{
                    ...chip,
                    minHeight: '56px',
                    ...(state === 'shred' ? { background: BRAND.gold, color: BRAND.charcoal, border: 'none' } : {}),
                  }}
                >
                  {es ? 'DESHEBRAR' : 'SHRED'}
                </button>
              </div>
            );
          })}
        </div>

        <div style={sectionLabel}>{es ? '+ POLLOS AL HORNO' : '+ BIRDS IN THE OVEN'}</div>
        {customQty == null ? (
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {BIRD_QTY_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onAction({ action: 'in', qty: n })}
                style={{
                  ...label,
                  flex: 1,
                  minWidth: '90px',
                  minHeight: '72px',
                  borderRadius: '12px',
                  background: BRAND.charcoalLight,
                  border: `1px solid ${BRAND.gold}40`,
                  color: BRAND.bone,
                  fontSize: 'clamp(1.2rem, 1.8vw, 1.8rem)',
                  cursor: 'pointer',
                }}
              >+{n}</button>
            ))}
            <button
              type="button"
              onClick={() => setCustomQty('')}
              title="Enter a custom quantity"
              style={{
                ...label,
                flex: 1,
                minWidth: '90px',
                minHeight: '72px',
                borderRadius: '12px',
                background: BRAND.charcoalLight,
                border: `1px solid ${BRAND.gold}`,
                color: BRAND.gold,
                fontSize: 'clamp(1.2rem, 1.8vw, 1.8rem)',
                cursor: 'pointer',
              }}
            >#</button>
          </div>
        ) : (
          // Number pad for odd batch sizes (a 12-bird catering fire).
          (() => {
            const qtyNum = parseInt(customQty, 10) || 0;
            const valid = qtyNum >= 1 && qtyNum <= BIRD_MAX_QTY;
            const padBtn = {
              ...label,
              minHeight: '64px',
              borderRadius: '10px',
              background: BRAND.charcoalLight,
              border: `1px solid ${BRAND.gold}30`,
              color: BRAND.bone,
              fontSize: '1.4rem',
              cursor: 'pointer',
            };
            return (
              <div style={{ maxWidth: '420px' }}>
                <div style={{
                  ...label,
                  textAlign: 'center',
                  color: valid || customQty === '' ? BRAND.bone : BRAND.red,
                  fontSize: '2rem',
                  padding: '10px',
                  border: `2px solid ${BRAND.gold}55`,
                  borderRadius: '10px',
                  marginBottom: '10px',
                  minHeight: '58px',
                  boxSizing: 'border-box',
                }}>
                  {customQty || '—'} 🍗
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                    <button key={d} type="button" style={padBtn}
                      onClick={() => setCustomQty((prev) => (prev.length < 2 ? prev + d : prev))}>{d}</button>
                  ))}
                  <button type="button" style={{ ...padBtn, color: BRAND.gold }}
                    onClick={() => setCustomQty((prev) => prev.slice(0, -1))}>⌫</button>
                  <button type="button" style={padBtn}
                    onClick={() => setCustomQty((prev) => (prev.length < 2 ? prev + '0' : prev))}>0</button>
                  <button
                    type="button"
                    disabled={!valid}
                    onClick={() => { onAction({ action: 'in', qty: qtyNum }); setCustomQty(null); }}
                    style={{
                      ...padBtn,
                      background: valid ? BRAND.gold : `${BRAND.gold}30`,
                      color: valid ? BRAND.charcoal : `${BRAND.charcoal}90`,
                      border: 'none',
                      cursor: valid ? 'pointer' : 'default',
                    }}
                  >{es ? 'METER' : 'ADD'}</button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '10px' }}>
                  <button type="button" style={chip} onClick={() => setCustomQty(null)}>
                    {es ? 'CANCELAR' : 'CANCEL'}
                  </button>
                </div>
                {!valid && customQty !== '' && (
                  <div style={{ ...label, color: BRAND.red, textAlign: 'center', marginTop: '8px', fontSize: '0.85rem' }}>
                    1–{BIRD_MAX_QTY}
                  </div>
                )}
              </div>
            );
          })()
        )}

        <div style={{
          marginTop: '18px',
          textAlign: 'center',
          color: `${BRAND.cream}80`,
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: '2px',
          textTransform: 'uppercase',
          fontSize: 'clamp(0.8rem, 1vw, 1rem)',
        }}>
          {es ? 'Hoy' : 'Today'}: {inToday} {es ? 'al horno' : 'in'} · {shreddedToday} {es ? 'deshebrados' : 'shredded'}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
          <button type="button" style={chip} onClick={onClose}>
            {es ? 'CERRAR' : 'CLOSE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Checklists ──────────────────────────────────────────
// Slow-period nudge banner + the full checklist overlay. Templates
// and completion state come from the parent's checklist-runs poll;
// item taps are optimistic (parent reconciles on the next poll).

// Banner shown on the slow-period screens while a scheduled checklist
// is due and unsigned. Tapping opens the overlay; stopPropagation so
// the Learn attract screen underneath doesn't also open its picker.
function ChecklistNudge({ dueChecklists, language, onOpen }) {
  if (dueChecklists.length === 0) return null;
  const es = language === 'es';
  const cl = dueChecklists[0];
  const name = (pickTipText(cl.name, language) || (es ? 'Lista' : 'Checklist')).toUpperCase();
  const done = Object.keys(cl.run?.checked_items || {}).length;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 16px 0' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '14px',
          padding: '14px 28px',
          borderRadius: '999px',
          background: `${BRAND.gold}15`,
          border: `1px solid ${BRAND.gold}`,
          color: BRAND.gold,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          fontSize: 'clamp(0.9rem, 1.3vw, 1.3rem)',
          letterSpacing: '2px',
          textTransform: 'uppercase',
          cursor: 'pointer',
          minHeight: '44px',
          animation: 'lcLearnPulse 2.4s ease-in-out infinite',
        }}
      >
        <span>{name}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{done} / {cl.items.length}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{es ? 'TOCA PARA ABRIR' : 'TAP TO OPEN'}</span>
        {dueChecklists.length > 1 && <span style={{ opacity: 0.7 }}>+{dueChecklists.length - 1}</span>}
      </button>
    </div>
  );
}

// Full-screen checklist overlay. Modeled on OrderDetailSheet (scrim
// click-to-close, stopPropagation, Escape) but with a 3-minute idle
// timeout instead of the sheet's 30s auto-dismiss — someone working
// through a closing list shouldn't have the screen yanked away.
// Views: list of checklists → one checklist's items → initials pad.
// The initials pad is an on-screen A–Z grid because Pi kiosks have no
// OS keyboard.
const CHECKLIST_IDLE_MS = 180_000;
const INITIALS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function ChecklistOverlay({ checklists, language, onClose, onToggle, onComplete }) {
  const es = language === 'es';
  const [activeId, setActiveId] = useState(checklists.length === 1 ? checklists[0].id : null);
  const [signing, setSigning] = useState(false);
  const [initials, setInitials] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Idle clock: any pointerdown on the sheet stamps lastTouch, which
  // restarts the close timer. onClose must be referentially stable
  // (parent useCallback) or the parent's 1s clock tick would restart
  // the timer forever.
  const [lastTouch, setLastTouch] = useState(() => Date.now());

  useEffect(() => {
    const t = setTimeout(onClose, CHECKLIST_IDLE_MS);
    return () => clearTimeout(t);
  }, [lastTouch, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const active = checklists.find((c) => c.id === activeId) || null;
  const activeChecked = active ? Object.keys(active.run?.checked_items || {}) : [];
  const activeComplete = !!active?.run?.completed_at;
  const allChecked = active ? active.items.every((it) => activeChecked.includes(it.id)) : false;

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  };

  const label = {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
  };
  const chip = {
    ...label,
    padding: '10px 20px',
    borderRadius: '999px',
    background: 'transparent',
    color: `${BRAND.gold}CC`,
    border: `1px solid ${BRAND.gold}55`,
    fontSize: 'clamp(0.8rem, 1.1vw, 1.1rem)',
    cursor: 'pointer',
    minHeight: '44px',
    minWidth: '64px',
  };

  const submitInitials = async () => {
    if (busy || !active) return;
    setBusy(true);
    setErrMsg('');
    try {
      await onComplete(active.id, initials);
      setSigning(false);
      setInitials('');
    } catch (err) {
      setErrMsg(err?.message || 'Sign-off failed');
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!active) {
    // Checklist list.
    body = (
      <>
        <div style={{ ...label, color: BRAND.gold, fontSize: 'clamp(1rem, 1.5vw, 1.5rem)', marginBottom: '18px' }}>
          {es ? 'LISTAS DE HOY' : "TODAY'S CHECKLISTS"}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {checklists.map((cl) => {
            const done = Object.keys(cl.run?.checked_items || {}).length;
            const signed = !!cl.run?.completed_at;
            return (
              <button
                key={cl.id}
                type="button"
                onClick={() => { setErrMsg(''); setActiveId(cl.id); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                  padding: '18px 22px',
                  minHeight: '72px',
                  borderRadius: '12px',
                  background: BRAND.charcoalLight,
                  border: `1px solid ${signed ? `${BRAND.green}55` : cl.due_now ? BRAND.gold : `${BRAND.gold}30`}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(1rem, 1.5vw, 1.5rem)' }}>
                  {pickTipText(cl.name, language) || (es ? 'Lista' : 'Checklist')}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '12px' }}>
                  {signed ? (
                    <span style={{ ...label, color: BRAND.green, fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)' }}>
                      ✓ {cl.run.completed_by} · {fmtTime(cl.run.completed_at)}
                    </span>
                  ) : (
                    <>
                      {cl.due_now && (
                        <span style={{ ...label, color: BRAND.red, fontSize: '0.8rem', border: `1px solid ${BRAND.red}88`, borderRadius: '999px', padding: '4px 10px' }}>
                          {es ? 'PENDIENTE' : 'DUE NOW'}
                        </span>
                      )}
                      <span style={{ ...label, color: done > 0 ? BRAND.gold : `${BRAND.cream}80`, fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)' }}>
                        {done} / {cl.items.length}
                      </span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  } else if (signing) {
    // Initials pad.
    body = (
      <>
        <div style={{ ...label, color: BRAND.gold, fontSize: 'clamp(1rem, 1.5vw, 1.5rem)', marginBottom: '8px', textAlign: 'center' }}>
          {es ? 'TUS INICIALES' : 'YOUR INITIALS'}
        </div>
        <div style={{ ...label, color: `${BRAND.cream}90`, fontSize: '0.85rem', textAlign: 'center', marginBottom: '16px' }}>
          {pickTipText(active.name, language)} · {es ? 'firma para completar' : 'sign to complete'}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '18px' }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{
              width: '64px',
              height: '72px',
              borderRadius: '10px',
              border: `2px solid ${initials[i] ? BRAND.gold : `${BRAND.cream}40`}`,
              background: BRAND.charcoalLight,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: '2.2rem',
              color: BRAND.bone,
            }}>{initials[i] || ''}</span>
          ))}
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '8px',
          maxWidth: '560px',
          margin: '0 auto',
        }}>
          {INITIALS_LETTERS.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setInitials((prev) => (prev.length < 3 ? prev + ch : prev))}
              style={{
                ...label,
                minHeight: '56px',
                borderRadius: '10px',
                background: BRAND.charcoalLight,
                border: `1px solid ${BRAND.gold}30`,
                color: BRAND.bone,
                fontSize: '1.3rem',
                cursor: 'pointer',
              }}
            >{ch}</button>
          ))}
          <button
            type="button"
            onClick={() => setInitials((prev) => prev.slice(0, -1))}
            style={{
              ...label,
              minHeight: '56px',
              gridColumn: 'span 2',
              borderRadius: '10px',
              background: BRAND.charcoalLight,
              border: `1px solid ${BRAND.gold}30`,
              color: BRAND.gold,
              fontSize: '1.3rem',
              cursor: 'pointer',
            }}
          >⌫</button>
        </div>
        {errMsg && (
          <div style={{ color: BRAND.red, textAlign: 'center', marginTop: '14px', fontFamily: "'Oswald', sans-serif", letterSpacing: '1px' }}>
            {errMsg}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '14px', marginTop: '20px' }}>
          <button type="button" style={chip} onClick={() => { setSigning(false); setInitials(''); setErrMsg(''); }}>
            {es ? 'CANCELAR' : 'CANCEL'}
          </button>
          <button
            type="button"
            disabled={initials.length < 2 || busy}
            onClick={submitInitials}
            style={{
              ...chip,
              background: initials.length >= 2 && !busy ? BRAND.gold : `${BRAND.gold}30`,
              color: initials.length >= 2 && !busy ? BRAND.charcoal : `${BRAND.charcoal}90`,
              border: 'none',
              cursor: initials.length >= 2 && !busy ? 'pointer' : 'default',
              padding: '10px 32px',
            }}
          >
            {busy ? '…' : (es ? 'FIRMAR' : 'SIGN OFF')}
          </button>
        </div>
      </>
    );
  } else {
    // One checklist's items.
    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
          {checklists.length > 1 ? (
            <button type="button" style={chip} onClick={() => { setErrMsg(''); setActiveId(null); }}>
              ← {es ? 'LISTAS' : 'LISTS'}
            </button>
          ) : <span />}
          <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(1.1rem, 1.6vw, 1.6rem)' }}>
            {pickTipText(active.name, language)}
          </span>
          <span style={{ ...label, color: `${BRAND.cream}90`, fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)' }}>
            {activeChecked.length} / {active.items.length}
          </span>
        </div>
        {activeComplete && (
          <div style={{
            ...label,
            color: BRAND.green,
            border: `1px solid ${BRAND.green}66`,
            borderRadius: '10px',
            padding: '12px 18px',
            marginBottom: '14px',
            textAlign: 'center',
            fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)',
          }}>
            ✓ {es ? 'Firmado' : 'Signed'} {active.run.completed_by} · {fmtTime(active.run.completed_at)}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {active.items.map((it) => {
            const checked = activeChecked.includes(it.id);
            return (
              <button
                key={it.id}
                type="button"
                disabled={activeComplete}
                onClick={() => onToggle(active.id, it.id, !checked)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '18px',
                  padding: '14px 18px',
                  minHeight: '64px',
                  borderRadius: '12px',
                  background: BRAND.charcoalLight,
                  border: `1px solid ${checked ? `${BRAND.gold}66` : `${BRAND.cream}25`}`,
                  cursor: activeComplete ? 'default' : 'pointer',
                  textAlign: 'left',
                  opacity: checked && !activeComplete ? 0.65 : 1,
                }}
              >
                <span style={{
                  flexShrink: 0,
                  width: '38px',
                  height: '38px',
                  borderRadius: '8px',
                  background: checked ? BRAND.gold : 'transparent',
                  border: checked ? 'none' : `2px solid ${BRAND.cream}60`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: BRAND.charcoal,
                  fontWeight: 700,
                  fontSize: '1.4rem',
                }}>{checked ? '✓' : ''}</span>
                <span style={{
                  fontSize: 'clamp(1.05rem, 1.5vw, 1.5rem)',
                  color: language === 'en' ? BRAND.bone : BRAND.cream,
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontStyle: es ? 'italic' : 'normal',
                  lineHeight: 1.3,
                }}>{pickTipText(it, language)}</span>
              </button>
            );
          })}
        </div>
        {errMsg && (
          <div style={{ color: BRAND.red, textAlign: 'center', marginTop: '14px', fontFamily: "'Oswald', sans-serif", letterSpacing: '1px' }}>
            {errMsg}
          </div>
        )}
        {!activeComplete && allChecked && active.items.length > 0 && (
          <button
            type="button"
            onClick={() => { setErrMsg(''); setSigning(true); }}
            style={{
              ...label,
              width: '100%',
              marginTop: '16px',
              minHeight: '72px',
              borderRadius: '12px',
              background: BRAND.gold,
              color: BRAND.charcoal,
              border: 'none',
              fontSize: 'clamp(1rem, 1.5vw, 1.5rem)',
              cursor: 'pointer',
            }}
          >
            ✓ {es ? 'FIRMAR Y COMPLETAR' : 'SIGN OFF & COMPLETE'}
          </button>
        )}
      </>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={() => setLastTouch(Date.now())}
        style={{
          width: 'min(940px, 94vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: BRAND.charcoalDark,
          border: `2px solid ${BRAND.gold}`,
          borderRadius: '16px',
          padding: 'clamp(18px, 3vw, 32px)',
          boxSizing: 'border-box',
        }}
      >
        {body}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
          <button type="button" style={chip} onClick={onClose}>
            {es ? 'CERRAR' : 'CLOSE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recipe reference overlay ────────────────────────────
// Read-only browser over every entree and side with synced build
// steps: photo grid grouped ENTREES / SIDES → full recipe view with
// ALL steps visible and scrollable (mid-service lookup — a cook scans
// to the step they need; one-step-at-a-time paging lives in Learn
// mode, the practice surface). 3-min idle close like the other
// overlays.
const RECIPE_IDLE_MS = 180_000;

function RecipeOverlay({ recipes, language, menuItems, configSides, onClose }) {
  const es = language === 'es';
  const [activeKey, setActiveKey] = useState(null); // `${kind}|${name}`
  const [lastTouch, setLastTouch] = useState(() => Date.now());

  useEffect(() => {
    const t = setTimeout(onClose, RECIPE_IDLE_MS);
    return () => clearTimeout(t);
  }, [lastTouch, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const active = recipes.find((r) => `${r.kind}|${r.name}` === activeKey) || null;

  const label = {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
  };
  const chip = {
    ...label,
    padding: '10px 20px',
    borderRadius: '999px',
    background: 'transparent',
    color: `${BRAND.gold}CC`,
    border: `1px solid ${BRAND.gold}55`,
    fontSize: 'clamp(0.8rem, 1.1vw, 1.1rem)',
    cursor: 'pointer',
    minHeight: '44px',
    minWidth: '64px',
  };

  const renderGroup = (title, group) => group.length > 0 && (
    <>
      <div style={{ ...label, color: BRAND.gold, fontSize: 'clamp(0.9rem, 1.2vw, 1.2rem)', margin: '18px 0 10px' }}>
        {title}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
        gap: '14px',
      }}>
        {group.map((r) => (
          <button
            key={`${r.kind}|${r.name}`}
            type="button"
            onClick={() => setActiveKey(`${r.kind}|${r.name}`)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '10px',
              padding: '14px',
              borderRadius: '12px',
              background: BRAND.charcoalLight,
              border: `1px solid ${BRAND.gold}30`,
              cursor: 'pointer',
              minHeight: '120px',
            }}
          >
            <FoodPhoto
              src={getSideImageUrl(r.name, menuItems, configSides)}
              alt={r.name}
              style={{ width: '120px', height: '120px', borderRadius: '10px' }}
            />
            <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(0.9rem, 1.1vw, 1.1rem)', letterSpacing: '1px', textAlign: 'center' }}>
              {r.name}
            </span>
            <span style={{ ...label, color: `${BRAND.cream}80`, fontSize: '0.75rem', letterSpacing: '1.5px' }}>
              {r.steps.length} {es ? 'pasos' : 'steps'}
            </span>
          </button>
        ))}
      </div>
    </>
  );

  let body;
  if (!active) {
    body = (
      <>
        {renderGroup(es ? 'PLATOS' : 'ENTREES', recipes.filter((r) => r.kind === 'entree'))}
        {renderGroup(es ? 'GUARNICIONES' : 'SIDES', recipes.filter((r) => r.kind === 'side'))}
      </>
    );
  } else {
    const manySteps = active.steps.length > 6;
    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
          <button type="button" style={chip} onClick={() => setActiveKey(null)}>
            ← {es ? 'RECETAS' : 'RECIPES'}
          </button>
          <span style={{ ...label, color: BRAND.bone, fontSize: 'clamp(1.1rem, 1.6vw, 1.6rem)' }}>
            {active.name}
          </span>
          <span style={{ ...label, color: `${BRAND.cream}80`, fontSize: 'clamp(0.85rem, 1.1vw, 1.1rem)' }}>
            {active.steps.length} {es ? 'pasos' : 'steps'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 'clamp(18px, 3vw, 40px)', alignItems: 'flex-start' }}>
          <FoodPhoto
            src={getSideImageUrl(active.name, menuItems, configSides)}
            alt={active.name}
            style={{ width: 'clamp(140px, 22vh, 240px)', height: 'clamp(140px, 22vh, 240px)', borderRadius: '12px', flexShrink: 0 }}
          />
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: manySteps ? '10px' : '14px',
            minWidth: 0,
            flex: 1,
          }}>
            {active.steps.map((step, si) => {
              const stepText = pickTipText(step, language);
              if (!stepText) return null;
              return (
                <div key={si} style={{ display: 'flex', gap: '14px', alignItems: 'baseline', textAlign: 'left' }}>
                  <span style={{
                    flexShrink: 0,
                    minWidth: '1.8em',
                    color: BRAND.blue,
                    fontFamily: "'Oswald', sans-serif",
                    fontWeight: 700,
                    fontSize: manySteps ? 'clamp(1rem, 1.4vw, 1.4rem)' : 'clamp(1.1rem, 1.7vw, 1.7rem)',
                  }}>{si + 1}.</span>
                  <span style={{
                    fontSize: manySteps ? 'clamp(1rem, 1.5vw, 1.5rem)' : 'clamp(1.1rem, 1.8vw, 1.8rem)',
                    color: language === 'en' ? BRAND.bone : BRAND.cream,
                    fontFamily: "'Playfair Display', Georgia, serif",
                    lineHeight: 1.35,
                    fontStyle: es ? 'italic' : 'normal',
                  }}>{stepText}</span>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={() => setLastTouch(Date.now())}
        style={{
          width: 'min(1100px, 96vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: BRAND.charcoalDark,
          border: `2px solid ${BRAND.gold}`,
          borderRadius: '16px',
          padding: 'clamp(18px, 3vw, 32px)',
          boxSizing: 'border-box',
        }}
      >
        {!active && (
          <div style={{ ...label, color: BRAND.gold, fontSize: 'clamp(1rem, 1.5vw, 1.5rem)', textAlign: 'center' }}>
            {es ? 'RECETAS — REFERENCIA' : 'RECIPES — REFERENCE'}
          </div>
        )}
        {body}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
          <button type="button" style={chip} onClick={onClose}>
            {es ? 'CERRAR' : 'CLOSE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Learn mode screen ───────────────────────────────────
// Slow-period training surface. Three views in one component:
//   session === null          → attract: auto-rotating walkthrough,
//                               riding the parent's qualityTipIndex
//   session.view === 'picker' → tap-to-practice dish grid
//   session.view === 'steps'  → trainee-paced step-through, one step
//                               per screen, ✓-and-advance
// Session state is deliberately local: the parent stops rendering
// this branch the moment orders arrive, the component unmounts, and
// the half-finished session evaporates — service always wins. A
// 2-minute idle timeout falls back to attract the same way. Progress
// is anonymous and in-memory only (v1 — no trainee records), and
// nothing is ever written to build_steps (Notion sync owns those).
const LEARN_IDLE_MS = 120_000;

function LearnModeScreen({ learnItems, rotationIndex, language, menuItems, configSides, headerProps, checklistNudge = null, checklistOverlay = null }) {
  const [session, setSession] = useState(null);
  const es = language === 'es';

  // Idle fallback. Every tap replaces `session` with a fresh object,
  // so keying the timeout on it restarts the 2-min clock on activity.
  useEffect(() => {
    if (!session) return undefined;
    const t = setTimeout(() => setSession(null), LEARN_IDLE_MS);
    return () => clearTimeout(t);
  }, [session]);

  // A config repoll mid-session can drop the practiced item (menu
  // edit, Notion sync). Fall back to the picker instead of crashing.
  const activeItem = session?.view === 'steps'
    ? learnItems.find((m) => m.name === session.itemName)
    : null;
  const view = session?.view === 'steps'
    ? (activeItem ? 'steps' : 'picker')
    : (session?.view === 'picker' ? 'picker' : 'attract');

  const chipBtn = {
    padding: '10px 20px',
    borderRadius: '999px',
    background: 'transparent',
    color: `${BRAND.gold}CC`,
    border: `1px solid ${BRAND.gold}55`,
    fontSize: 'clamp(0.8rem, 1.1vw, 1.1rem)',
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    cursor: 'pointer',
    minHeight: '44px',
    minWidth: '64px',
  };

  let body = null;

  if (view === 'attract') {
    const learnItem = learnItems[rotationIndex % learnItems.length];
    const manySteps = learnItem.steps.length > 6;
    body = (
      // Whole surface is the tap target — a trainee shouldn't have to
      // find a small button from across the line. Plain onClick, never
      // the hold-to-bump pointer machine (that's for order cards).
      <div style={{ ...s.qualityCoach, cursor: 'pointer' }} onClick={() => setSession({ view: 'picker' })}>
        <div style={{ ...s.qualityLabel, color: BRAND.blue }}>
          {es ? 'MODO APRENDIZAJE' : 'LEARN MODE'}
        </div>
        <div key={`learn-${rotationIndex}-${language}`} style={{
          display: 'flex',
          gap: 'clamp(24px, 4vw, 64px)',
          alignItems: 'flex-start',
          justifyContent: 'center',
          maxWidth: '90vw',
          marginTop: '3vh',
          animation: 'lcQualityFade 400ms ease-out',
        }}>
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2vh' }}>
            <FoodPhoto
              src={getSideImageUrl(learnItem.name, menuItems, configSides)}
              alt={learnItem.name}
              style={{ width: '28vh', height: '28vh', borderRadius: '14px' }}
            />
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: 'clamp(1.2rem, 2vw, 2rem)',
              color: BRAND.bone,
              letterSpacing: '2px',
              textTransform: 'uppercase',
              textAlign: 'center',
              maxWidth: '30vh',
            }}>{learnItem.name}</div>
          </div>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: manySteps ? '10px' : '16px',
            maxHeight: '56vh',
            overflowY: 'auto',
            minWidth: 0,
          }}>
            {learnItem.steps.map((step, si) => {
              const stepText = pickTipText(step, language);
              if (!stepText) return null;
              return (
                <div key={si} style={{ display: 'flex', gap: '16px', alignItems: 'baseline', textAlign: 'left' }}>
                  <span style={{
                    flexShrink: 0,
                    minWidth: '1.8em',
                    color: BRAND.blue,
                    fontFamily: "'Oswald', sans-serif",
                    fontWeight: 700,
                    fontSize: manySteps ? 'clamp(1.1rem, 1.6vw, 1.6rem)' : 'clamp(1.3rem, 2vw, 2rem)',
                  }}>{si + 1}.</span>
                  <span style={{
                    fontSize: manySteps ? 'clamp(1.1rem, 1.7vw, 1.7rem)' : 'clamp(1.3rem, 2.1vw, 2.1rem)',
                    color: language === 'en' ? BRAND.bone : BRAND.cream,
                    fontFamily: "'Playfair Display', Georgia, serif",
                    lineHeight: 1.35,
                    fontStyle: es ? 'italic' : 'normal',
                  }}>{stepText}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{
          marginTop: '3vh',
          padding: '12px 28px',
          borderRadius: '999px',
          border: `1px solid ${BRAND.gold}66`,
          color: BRAND.gold,
          fontFamily: "'Oswald', sans-serif",
          fontWeight: 700,
          letterSpacing: '3px',
          fontSize: 'clamp(0.9rem, 1.3vw, 1.3rem)',
          textTransform: 'uppercase',
          animation: 'lcLearnPulse 2.4s ease-in-out infinite',
        }}>
          {es ? 'TOCA PARA PRACTICAR' : 'TAP TO PRACTICE'}
        </div>
        {learnItems.length > 1 && (
          <div style={{
            marginTop: '2vh',
            color: `${BRAND.cream}80`,
            fontFamily: "'Oswald', sans-serif",
            fontSize: 'clamp(0.8rem, 1vw, 1rem)',
            letterSpacing: '2px',
            textTransform: 'uppercase',
          }}>
            {(rotationIndex % learnItems.length) + 1} / {learnItems.length}
          </div>
        )}
      </div>
    );
  } else if (view === 'picker') {
    body = (
      <div style={s.qualityCoach}>
        <div style={{ ...s.qualityLabel, color: BRAND.blue }}>
          {es ? 'ELIGE UN PLATILLO PARA PRACTICAR' : 'CHOOSE A DISH TO PRACTICE'}
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '20px',
          width: 'min(90vw, 1400px)',
          maxHeight: '68vh',
          overflowY: 'auto',
          animation: 'lcQualityFade 400ms ease-out',
        }}>
          {learnItems.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => setSession({ view: 'steps', itemName: item.name, stepIndex: 0, checked: [] })}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
                padding: '18px',
                borderRadius: '14px',
                background: BRAND.charcoalLight,
                border: `1px solid ${BRAND.gold}30`,
                cursor: 'pointer',
                minHeight: '120px',
              }}
            >
              <FoodPhoto
                src={getSideImageUrl(item.name, menuItems, configSides)}
                alt={item.name}
                style={{ width: '160px', height: '160px', borderRadius: '10px' }}
              />
              <span style={{
                fontFamily: "'Oswald', sans-serif",
                fontWeight: 700,
                fontSize: 'clamp(1rem, 1.4vw, 1.4rem)',
                color: BRAND.bone,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                textAlign: 'center',
              }}>{item.name}</span>
              <span style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: '0.85rem',
                color: `${BRAND.cream}90`,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
              }}>
                {item.steps.length} {es ? 'pasos' : 'steps'}
              </span>
            </button>
          ))}
        </div>
        <div style={{ marginTop: '3vh' }}>
          <button type="button" style={chipBtn} onClick={() => setSession(null)}>
            {es ? 'VOLVER' : 'BACK'}
          </button>
        </div>
      </div>
    );
  } else {
    // Step-through. One step per screen; the single primary action
    // checks the current step off AND advances, so a greasy-handed
    // trainee only ever needs one big target. Past the last step →
    // completion card.
    const steps = activeItem.steps;
    const total = steps.length;
    const idx = session.stepIndex;
    const complete = idx >= total;
    const markDoneNext = () => setSession((prev) => ({
      ...prev,
      checked: prev.checked.includes(prev.stepIndex) ? prev.checked : [...prev.checked, prev.stepIndex],
      stepIndex: prev.stepIndex + 1,
    }));
    const goBack = () => setSession((prev) => ({ ...prev, stepIndex: Math.max(0, prev.stepIndex - 1) }));

    body = (
      <div style={{ ...s.qualityCoach, justifyContent: 'flex-start' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: 'min(92vw, 1500px)',
        }}>
          <button type="button" style={chipBtn} onClick={() => setSession(null)}>
            {es ? 'SALIR' : 'EXIT'}
          </button>
          <div style={{
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            fontSize: 'clamp(1.1rem, 1.8vw, 1.8rem)',
            color: BRAND.bone,
            letterSpacing: '2px',
            textTransform: 'uppercase',
          }}>{activeItem.name}</div>
          <div style={{
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            fontSize: 'clamp(1rem, 1.4vw, 1.4rem)',
            color: `${BRAND.cream}90`,
            letterSpacing: '2px',
            minWidth: '64px',
            textAlign: 'right',
          }}>
            {complete ? `${total} / ${total}` : `${idx + 1} / ${total}`}
          </div>
        </div>

        {complete ? (
          <div key="learn-complete" style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '3vh',
            animation: 'lcQualityFade 400ms ease-out',
          }}>
            <div style={{ fontSize: 'clamp(4rem, 9vw, 9rem)', color: BRAND.green, lineHeight: 1 }}>✓</div>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700,
              fontSize: 'clamp(1.6rem, 2.8vw, 2.8rem)',
              color: BRAND.bone,
              letterSpacing: '3px',
              textTransform: 'uppercase',
            }}>
              {es ? 'ARMADO COMPLETO' : 'BUILD COMPLETE'}
            </div>
            <div style={{ display: 'flex', gap: '20px', marginTop: '2vh' }}>
              <button
                type="button"
                onClick={() => setSession({ view: 'picker' })}
                style={{
                  ...chipBtn,
                  background: BRAND.gold,
                  color: BRAND.charcoal,
                  border: 'none',
                  minHeight: '64px',
                  padding: '14px 32px',
                  fontSize: 'clamp(1rem, 1.4vw, 1.4rem)',
                }}
              >
                {es ? 'OTRO PLATILLO' : 'PRACTICE ANOTHER'}
              </button>
              <button type="button" style={{ ...chipBtn, minHeight: '64px', padding: '14px 32px' }} onClick={() => setSession(null)}>
                {es ? 'LISTO' : 'DONE'}
              </button>
            </div>
          </div>
        ) : (
          <div key={`learn-step-${idx}-${language}`} style={{
            flex: 1,
            display: 'flex',
            gap: 'clamp(24px, 4vw, 64px)',
            alignItems: 'center',
            justifyContent: 'center',
            width: 'min(92vw, 1500px)',
            animation: 'lcQualityFade 300ms ease-out',
          }}>
            <FoodPhoto
              src={getSideImageUrl(activeItem.name, menuItems, configSides)}
              alt={activeItem.name}
              style={{ width: '30vh', height: '30vh', borderRadius: '14px', flexShrink: 0 }}
            />
            <div style={{ display: 'flex', gap: '20px', alignItems: 'baseline', textAlign: 'left', minWidth: 0 }}>
              <span style={{
                flexShrink: 0,
                color: BRAND.blue,
                fontFamily: "'Oswald', sans-serif",
                fontWeight: 700,
                fontSize: 'clamp(2rem, 4vw, 4rem)',
              }}>{idx + 1}.</span>
              <span style={{
                fontSize: 'clamp(1.8rem, 3.4vw, 3.4rem)',
                color: language === 'en' ? BRAND.bone : BRAND.cream,
                fontFamily: "'Playfair Display', Georgia, serif",
                lineHeight: 1.3,
                fontStyle: es ? 'italic' : 'normal',
              }}>{pickTipText(steps[idx], language)}</span>
            </div>
          </div>
        )}

        {!complete && (
          <>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '2.5vh' }}>
              {steps.map((_, si) => (
                <span key={si} style={{
                  width: 'clamp(10px, 1vw, 14px)',
                  height: 'clamp(10px, 1vw, 14px)',
                  borderRadius: '50%',
                  background: session.checked.includes(si) ? BRAND.gold : 'transparent',
                  border: si === idx ? `2px solid ${BRAND.blue}` : `1px solid ${BRAND.cream}50`,
                  boxSizing: 'border-box',
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '20px', width: 'min(92vw, 900px)', paddingBottom: '2vh' }}>
              <button
                type="button"
                onClick={goBack}
                disabled={idx === 0}
                style={{
                  ...chipBtn,
                  flex: 1,
                  minHeight: '80px',
                  fontSize: 'clamp(1rem, 1.5vw, 1.5rem)',
                  opacity: idx === 0 ? 0.35 : 1,
                  cursor: idx === 0 ? 'default' : 'pointer',
                }}
              >
                {es ? 'ATRÁS' : 'BACK'}
              </button>
              <button
                type="button"
                onClick={markDoneNext}
                style={{
                  ...chipBtn,
                  flex: 2,
                  minHeight: '80px',
                  background: BRAND.gold,
                  color: BRAND.charcoal,
                  border: 'none',
                  fontSize: 'clamp(1.1rem, 1.7vw, 1.7rem)',
                }}
              >
                ✓ {idx === total - 1 ? (es ? 'TERMINAR' : 'FINISH') : (es ? 'HECHO · SIGUIENTE' : 'DONE · NEXT')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={s.container}>
      <style>{`
        @keyframes lcQualityFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes lcLearnPulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      `}</style>
      <Header {...headerProps} />
      {checklistNudge}
      {checklistOverlay}
      {body}
    </div>
  );
}

function Header({ now, orderCount, staleCount = 0, language, onLanguageToggle, learnAllowed = false, learnMode = false, onLearnToggle, checklistAvailable = false, checklistDue = 0, onChecklistOpen, birdAvailable = false, birdCookingQty = 0, birdHoldingQty = 0, birdAlert = 0, onBirdOpen, recipesAvailable = false, onRecipesOpen }) {
  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        {/* Brand logo replaces the wordmark. Sized by height so the
            ~4.18:1 logo image scales cleanly. onError falls back to
            the WILDBIRD text wordmark in case the asset is missing. */}
        <img
          src="/WILDBIRD-LOGO-WHITE.png"
          alt="WILDBIRD"
          draggable={false}
          className="lc-no-callout"
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
        {learnAllowed && onLearnToggle && (
          // Learn-mode chip (new-hire build-step walkthroughs). Only
          // rendered when the store's master switch is on. Active state
          // is the sole solid-gold element in the header so a trainer
          // can confirm the mode from across the kitchen.
          <button
            type="button"
            onClick={onLearnToggle}
            aria-label={`Toggle learn mode (currently ${learnMode ? 'on' : 'off'})`}
            title={learnMode ? 'Learn mode on · tap to turn off' : 'Learn mode off · tap for build-step walkthroughs'}
            style={{
              padding: '8px 14px',
              borderRadius: '999px',
              background: learnMode ? BRAND.gold : 'transparent',
              color: learnMode ? BRAND.charcoal : `${BRAND.gold}AA`,
              border: learnMode ? 'none' : `1px solid ${BRAND.gold}55`,
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
            LEARN
          </button>
        )}
        {recipesAvailable && onRecipesOpen && (
          // Recipe reference chip — read-only step-by-step for every
          // entree and side with synced build steps. Reference, not
          // training: Learn mode stays the practice surface.
          <button
            type="button"
            onClick={onRecipesOpen}
            aria-label="Open recipe reference"
            title="Recipes — step-by-step reference"
            style={{
              padding: '8px 14px',
              borderRadius: '999px',
              background: 'transparent',
              color: `${BRAND.gold}AA`,
              border: `1px solid ${BRAND.gold}55`,
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
            {language === 'es' ? 'RECETAS' : 'RECIPES'}
          </button>
        )}
        {birdAvailable && onBirdOpen && (
          // Bird oven log chip. Shows cooking · warmer counts at a
          // glance; the red badge counts batches needing action (pull
          // due / past carve window). Rendered before LISTS because
          // birds are the critical-path item.
          <button
            type="button"
            onClick={onBirdOpen}
            aria-label={birdAlert > 0 ? `Open bird log (${birdAlert} batches need action)` : 'Open bird log'}
            title={`Birds — ${birdCookingQty} cooking · ${birdHoldingQty} in warmer`}
            style={{
              position: 'relative',
              padding: '8px 14px',
              borderRadius: '999px',
              background: 'transparent',
              color: `${BRAND.gold}AA`,
              border: `1px solid ${BRAND.gold}55`,
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
              gap: '6px',
            }}
          >
            <span>🍗</span>
            <span>{(birdCookingQty > 0 || birdHoldingQty > 0) ? `${birdCookingQty} · ${birdHoldingQty}` : (language === 'es' ? 'POLLOS' : 'BIRDS')}</span>
            {birdAlert > 0 && (
              <span style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                minWidth: '20px',
                height: '20px',
                borderRadius: '999px',
                background: BRAND.red,
                color: BRAND.white,
                fontSize: '0.7rem',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 5px',
              }}>{birdAlert}</span>
            )}
          </button>
        )}
        {checklistAvailable && onChecklistOpen && (
          // Checklist chip. Reachable in every mode (not just slow
          // periods) so a busy closing shift can still open the closing
          // list. The red badge counts checklists that are due now and
          // not yet signed.
          <button
            type="button"
            onClick={onChecklistOpen}
            aria-label={checklistDue > 0 ? `Open checklists (${checklistDue} due)` : 'Open checklists'}
            title={checklistDue > 0 ? `${checklistDue} checklist${checklistDue === 1 ? '' : 's'} due now` : 'Checklists'}
            style={{
              position: 'relative',
              padding: '8px 14px',
              borderRadius: '999px',
              background: 'transparent',
              color: `${BRAND.gold}AA`,
              border: `1px solid ${BRAND.gold}55`,
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
            {language === 'es' ? 'LISTAS' : 'LISTS'}
            {checklistDue > 0 && (
              <span style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                minWidth: '20px',
                height: '20px',
                borderRadius: '999px',
                background: BRAND.red,
                color: BRAND.white,
                fontSize: '0.7rem',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 5px',
              }}>{checklistDue}</span>
            )}
          </button>
        )}
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
  // Order list. Same flex shape as sidesContainer but scrollable, and
  // deliberately NOT shared with it — the sides rail sizes itself to fit
  // (vh-based thumbnails that shrink with count), whereas this list can
  // genuinely overflow.
  //
  // MAX_VISIBLE caps the card *count*, not the total height, so on a
  // shorter tablet viewport the rows still overrun the column. With
  // overflow:hidden they were clipped with no scroll affordance and no
  // indication — the "+N hidden" chip only counts orders past
  // MAX_VISIBLE, not ones cut off by height. Measured on a 1180x820
  // iPad: 2097px of content in a 764px column, so ~1300px unreachable.
  // The MAX_VISIBLE comment above ("better to scroll past 6") always
  // assumed this was scrollable.
  orderListContainer: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    overscrollBehavior: 'contain',
  },
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
