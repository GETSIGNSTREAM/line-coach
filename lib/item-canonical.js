// Canonical menu-item-name resolver — mirrors lib/side-canonical.js
// but for entrees. Toast occasionally sends variant strings ("1/4
// Chicken" vs "Quarter Bird", "PROTEIN PLATE" vs "Protein Plate")
// that would otherwise create one bucket per variant in per-item
// analytics. Collapse to a single canonical name so percentile
// math + the menu-item-performance table merge variants correctly.
//
// Source of truth: the exact `name` strings in
// lc_brand_config.menu_items. The triggers array below maps observed
// Toast variants (plus a few defensive lowercase/abbreviation
// patterns) to those canonical names.
//
// Maintenance: when a new entree lands on the menu, add a row here.
// When Toast surprises us with a new typo, add the typo to its row's
// trigger list rather than fighting the raw input downstream.

const CANONICAL_TRIGGERS = [
  // ── Better Chicken ─────────────────────────────────
  // Order matters: list the more specific multi-word triggers first
  // so a "whole bird (a la carte)" variant doesn't get caught by
  // "whole bird" before reaching the standalone entry below.
  ['Whole Bird (A La Carte)', ['whole bird (a la carte)', 'whole bird a la carte', 'whole bird al', 'whole bird alc']],
  ['Quarter Bird',            ['quarter bird', '1/4 chicken', '1/4 bird', 'qtr bird', 'quarter chicken']],
  ['Half Bird',               ['half bird', '1/2 chicken', '1/2 bird', 'half chicken']],
  ['Whole Bird',              ['whole bird', 'whole chicken']],
  ['Chicken Dinner Box',      ['chicken dinner box', 'dinner box', 'family box']],
  ['Protein Plate',           ['protein plate']],

  // ── Market Plate ──────────────────────────────────
  ['Boneless Breast Market Plate', ['boneless breast market plate', 'boneless breast plate', 'boneless market']],
  ['Chicken Tinga Market Plate',   ['chicken tinga market plate', 'tinga market plate', 'tinga plate', 'chicken tinga plate']],
  ['Veggie Market Plate',          ['veggie market plate', 'veggie plate', 'vegetarian market']],
  ['Pollo Verde Market Plate',     ['pollo verde market plate', 'pollo verde plate', 'verde market plate', 'verde plate']],

  // ── Modern Mexican ────────────────────────────────
  ['Tacos Dorados',     ['tacos dorados', 'dorados']],
  ['Burrito Mexicano',  ['burrito mexicano', 'mex burrito', 'mexican burrito']],
  ['Tostada Bowl',      ['tostada bowl', 'tostada']],

  // ── Plant Forward ─────────────────────────────────
  ['Superfood Ensalada', ['superfood ensalada', 'superfood salad', 'superfood']],
  ['Harvest Bowl',       ['harvest bowl']],

  // ── A La Carte (oven, no sides) ───────────────────
  ['Chicken Leg',    ['chicken leg', 'leg']],
  ['Chicken Thigh',  ['chicken thigh', 'thigh']],
  ['Chicken Breast', ['chicken breast', 'breast']],
  ['Chicken Wing',   ['chicken wing', 'wing']],

  // ── Other ─────────────────────────────────────────
  ['Kids Quesadilla', ['kids quesadilla', 'kids ques', 'quesadilla']],
  ['Taco (Single)',   ['taco (single)', 'single taco']],

  // ── Sweets ────────────────────────────────────────
  ['Chocolate Chip + Sea Salt Cookie', ['chocolate chip + sea salt cookie', 'chocolate chip cookie', 'choc chip cookie', 'cc cookie']],
  ['Cookies N Cream Cookie',           ['cookies n cream cookie', "cookies 'n cream cookie", 'cookies and cream cookie']],
  ['Confetti Cookie',                  ['confetti cookie']],
  ['Double Double Cookie',             ['double double cookie', 'dbl dbl cookie']],
];

const CANONICAL_NAMES = new Set(CANONICAL_TRIGGERS.map((row) => row[0]));

// Strip Toast suffix noise — same regex set as side-canonical so the
// two canonical libs feel consistent. Size markers, regular/large
// suffixes, and any trailing parenthetical descriptors that don't
// change the dish.
function tidy(raw) {
  return String(raw || '')
    .replace(/\s*\((large|small|regular|half tray|full tray|crispy|grilled)\)?/gi, '')
    .replace(/\s*-\s*PROTEIN:?\s*\+?\d+G?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve any menu-item-name variant to its canonical name. Returns
 * the tidied original when no trigger matches, so unknown items still
 * appear in analytics — they just won't merge with other variants
 * until a trigger is added here.
 */
export function canonicalItemName(raw) {
  if (raw == null) return null;
  const tidied = tidy(raw);
  if (!tidied) return null;
  // Already canonical — short-circuit (case-sensitive exact match).
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
 * Test helper: does this name resolve to a known canonical menu item?
 * Useful for downstream code that wants to skip the analytics row
 * when the item isn't a real menu entry.
 */
export function isCanonicalItem(raw) {
  const c = canonicalItemName(raw);
  return c != null && CANONICAL_NAMES.has(c);
}
