// Canonical side-name resolver — used by both the webhook (at write
// time) and the display (at read time) so every Toast variant of a
// side name maps to the single configured name.
//
// Why this exists: in production we observed the same side rendered
// across orders as "Charred Brocolli" (935×), "Charred Brocoll" (45×),
// "Broccoli" (32×), "Charred Broccoli" (1×), and "BUFFALO CAULIFLOWER"
// (case mismatch). Each variant became its own batching bucket, so a
// "Broccoli x 4" coaching alert only counted 1 of 1,013 actual orders.
//
// The fix is data-shape rather than UI: collapse all variants to ONE
// canonical name before they ever land in batching math. The
// configured side names in lc_brand_config.sides are the source of
// truth — we map every observed variant to one of those exact strings.
//
// Maintenance: when a new side is added to the menu, add a row here
// with its trigger pattern. When Toast introduces a new typo (it
// happens), add the typo to the trigger list rather than fighting the
// raw input downstream.

// One canonical name → array of trigger fragments (lowercased,
// substring match). Order matters: the FIRST canonical name whose
// triggers match wins, so list the more specific entries first.
const CANONICAL_TRIGGERS = [
  // Modern Mexican / cold sides — listed first because some triggers
  // overlap with less-specific patterns below.
  ['Chips and Guac',         ['chips and guac', 'chips & guac', 'chips guac']],
  ['Mexican Street Corn',    ['mexican street corn', 'mex street corn', 'street corn', 'elote']],
  ['Green Chicken Pozole',   ['green chicken pozole', 'green pozole', 'pozole']],
  ['Buffalo Cauliflower',    ['buffalo cauliflower', 'buff cauliflower', 'buffalo caul']],
  ['Brussel Sprouts',        ['brussel sprouts', 'brussels sprouts', 'brussel', 'brussels']],
  ['Uptown Mac & Cheese',    ['uptown mac', 'uptown m&c']],
  // Charred Broccoli — also catches the legacy "Broccoli" row in
  // lc_brand_config.sides since cooks have always batched these
  // together. If the menu later splits them, add a separate canonical
  // entry above this one with a more specific trigger.
  ['Broccoli',               ['charred brocolli', 'charred brocoll', 'charred broccoli', 'charred broccolli', 'broccoli', 'brocolli']],
  // Hot-hold sides
  ['Spanish Rice',           ['spanish rice', 'rice']],
  ['Charro Beans',           ['charro beans', 'charro', 'beans']],
  ['Sweet Potatoes',         ['sweet potatoes', 'sweet potato', 'sweet pot']],
  ['Mac Salad',              ['mac salad', 'macaroni salad']],
  ['Kale Slaw',              ['kale slaw', 'kale']],
];

// Pre-build a Set of canonical names for fast O(1) "is this already
// canonical?" checks. We never want to mutate a name that already
// matches a configured side exactly.
const CANONICAL_NAMES = new Set(CANONICAL_TRIGGERS.map((row) => row[0]));

// Strip common Toast suffix noise: size markers, trailing parens,
// double whitespace. We do NOT strip qualifiers that change the dish
// (e.g. "Half Tray" vs "Full Tray" — those map to the same canonical
// side via trigger match, since the kitchen still cooks one batch
// regardless of tray size, but the trigger list above already catches
// "brussel" without the size suffix).
function tidy(raw) {
  return String(raw || '')
    .replace(/\s*\((large|small|regular|half tray|full tray)\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve any side-name variant to its canonical name.
 * Returns the original input (tidied) when no trigger matches, so
 * unknown sides still appear in batching — they just won't merge with
 * other variants until a trigger is added here.
 */
export function canonicalSideName(raw) {
  if (raw == null) return null;
  const tidied = tidy(raw);
  if (!tidied) return null;
  // Already canonical — short-circuit.
  if (CANONICAL_NAMES.has(tidied)) return tidied;
  const lower = tidied.toLowerCase();
  for (const [canonical, triggers] of CANONICAL_TRIGGERS) {
    for (const trigger of triggers) {
      if (lower.includes(trigger)) return canonical;
    }
  }
  return tidied;
}

/**
 * Test helper: does this name resolve to a known canonical side?
 * Used by display logic to avoid double-counting items that the
 * webhook already extracted into the sides array.
 */
export function isCanonicalSide(raw) {
  const c = canonicalSideName(raw);
  return c != null && CANONICAL_NAMES.has(c);
}

/**
 * Resolve a side's portion size from a Toast string. Size arrives two
 * ways: baked into a modifier name as a parenthetical ("CHARRO BEANS
 * (LARGE)", sometimes missing the close paren) or as a bare size
 * modifier on an à la carte side line ("Large" / "Regular"). Anything
 * without an explicit upsize is the default "regular" portion.
 * Returns 'large' | 'small' | 'regular'.
 */
export function parseSideSize(raw) {
  const t = String(raw || '').toLowerCase();
  if (/\(?\blarge\b|\blg\b/.test(t)) return 'large';
  if (/\(?\bsmall\b|\bsm\b/.test(t)) return 'small';
  return 'regular';
}

/**
 * First non-regular size found across a list of modifier strings, else
 * 'regular'. Used for à la carte sides whose size is a separate modifier.
 */
export function sizeFromModifiers(modifiers) {
  for (const m of modifiers || []) {
    const size = parseSideSize(m);
    if (size !== 'regular') return size;
  }
  return 'regular';
}
