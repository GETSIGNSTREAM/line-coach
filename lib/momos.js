import { getServiceClient, withRetry } from './supabase.js';

// ── Momos source adapter ────────────────────────────────
// Customer reviews land in this same Supabase project via an existing
// Momos pipeline that lives outside this repo (Kitchen Command's
// kc_reviews, NOT a wm_ table — those are Wingman's Notion-sync tables).
// ALL schema knowledge about that pipeline is quarantined in the
// constants below so a mismatch is a one-file fix.
//
// Schema verified against the live instance 2026-07-17: ~4.2k rows, no
// null rating/review_date. `message` is null for star-only reviews.
// `created_at` is the sync-batch timestamp (reviews arrive in bulk), so
// recency filters must use `review_date` — the time the customer left
// the review.

const MOMOS_TABLE = 'kc_reviews';

const COL = {
  text: 'message',          // review body — null for star-only reviews
  rating: 'rating',         // integer 1-5
  source: 'platform',       // Google, Yelp, UberEats, Doordash, Grubhub
  location: 'location_id',  // unhyphenated slug: hollywood, dtla, labrea, ...
  createdAt: 'review_date', // when the customer reviewed (NOT sync time)
};

// kc_reviews location_id → Line Coach store slug. Mirrors the
// TOAST_LOCATION_MAP pattern (lib/line-coach.js). Keys confirmed via
// SELECT DISTINCT location_id FROM kc_reviews — these six are exhaustive.
const MOMOS_LOCATION_MAP = {
  'hollywood': 'hollywood',
  'dtla': 'dtla',
  'westwood': 'westwood',
  'culvercity': 'culver-city',
  'labrea': '3rd-la-brea',
  'elsegundo': 'el-segundo',
};

const MAX_REVIEWS = 100;

// Fetch recent reviews for one store, normalized to
// { text, rating, source, created_at }. Returns { data, error } like every
// other reader in lib/line-coach.js. Reviews without comment text ARE
// included — the rating mix is itself a signal for the tip generator.
export async function getRecentFeedback(storeId, days = 14) {
  if (process.env.LC_FEEDBACK_MOCK === '1') {
    return { data: mockFeedback(storeId), error: null };
  }

  const locations = Object.entries(MOMOS_LOCATION_MAP)
    .filter(([, slug]) => slug === storeId)
    .map(([loc]) => loc);
  if (locations.length === 0) {
    return { data: null, error: new Error(`No Momos location mapped for store "${storeId}" — update MOMOS_LOCATION_MAP in lib/momos.js`) };
  }

  const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const db = getServiceClient();
  const { data, error } = await withRetry(() =>
    db.from(MOMOS_TABLE)
      .select(`${COL.text}, ${COL.rating}, ${COL.source}, ${COL.location}, ${COL.createdAt}`)
      .in(COL.location, locations)
      .gte(COL.createdAt, cutoff)
      .order(COL.createdAt, { ascending: false })
      .limit(MAX_REVIEWS)
  );
  if (error) return { data: null, error };

  const normalized = (data || []).map((row) => ({
    text: typeof row[COL.text] === 'string' ? row[COL.text].trim() : '',
    rating: typeof row[COL.rating] === 'number' ? row[COL.rating] : null,
    source: row[COL.source] || '',
    created_at: row[COL.createdAt] || null,
  }));
  return { data: normalized, error: null };
}

// Canned reviews for local dev (LC_FEEDBACK_MOCK=1) so the whole
// pipeline — generation route, LLM call, display — is testable before
// the real Momos schema is confirmed and without prod data locally.
function mockFeedback(storeId) {
  const now = Date.now();
  const at = (daysAgo) => new Date(now - daysAgo * 24 * 3600_000).toISOString();
  return [
    { text: 'Best rotisserie chicken in LA, the skin was perfectly crispy.', rating: 5, source: 'Google', created_at: at(1) },
    { text: 'Chicken was a little dry this time, usually it is great.', rating: 3, source: 'Google', created_at: at(2) },
    { text: '', rating: 5, source: 'Uber Eats', created_at: at(2) },
    { text: 'Missing my side of mac and cheese from the delivery bag.', rating: 2, source: 'Uber Eats', created_at: at(3) },
    { text: 'Joe is the man — dropped my salsa and he replaced it without me asking.', rating: 5, source: 'Google', created_at: at(4) },
    { text: '', rating: 4, source: 'Uber Eats', created_at: at(5) },
    { text: 'Tortillas were cold and stiff. Everything else was solid.', rating: 3, source: 'Google', created_at: at(6) },
    { text: `Love this ${storeId} location, staff is always friendly.`, rating: 5, source: 'Google', created_at: at(8) },
  ];
}
