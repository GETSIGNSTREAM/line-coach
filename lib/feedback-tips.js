import Anthropic from '@anthropic-ai/sdk';
import { getServiceClient, withRetry } from './supabase.js';
import { getConfig, normalizeTip } from './line-coach.js';
import { getRecentFeedback } from './momos.js';

// ── Feedback tips generation ────────────────────────────
// Turns recent Momos customer reviews into short, bilingual kitchen
// reminders per store — both coaching (recurring complaints) and positive
// reinforcement (praise, strong rating weeks). Results are stored in
// lc_feedback_tips so the display never pays LLM latency; getConfig
// merges them in as `feedback_tips`.
//
// Runs: daily Vercel cron → /api/line-coach/feedback-tips/generate,
// or on demand from the admin's "Regenerate now" button.

const STORE_DISPLAY = {
  hollywood: 'Hollywood',
  dtla: 'DTLA',
  westwood: 'Westwood',
  'culver-city': 'Culver City',
  '3rd-la-brea': '3rd & La Brea',
  'el-segundo': 'El Segundo',
};

// Below this many reviews in the window we skip generation AND clear the
// store's row — stale tips must not outlive their evidence.
const MIN_REVIEWS = 3;
const MAX_TIPS = 8;
const MAX_REVIEW_CHARS = 500;

const DEFAULT_MODEL = 'claude-opus-4-8';

const TIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tips'],
  properties: {
    tips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'es', 'source_quote'],
        properties: {
          en: { type: 'string', description: 'Reminder in English, max ~140 characters' },
          es: { type: 'string', description: 'Same reminder in Mexican Spanish (kitchen-floor register, tú form), max ~140 characters' },
          source_quote: { type: 'string', description: 'Short anonymized paraphrase of what customers said, or empty string' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a kitchen quality coach for WILDBIRD, a fast-casual rotisserie chicken restaurant in Los Angeles. Given recent customer feedback for ONE store, write 3-${MAX_TIPS} short reminders for the kitchen line, shown on the kitchen display during slow periods.

Rules:
- Two kinds of reminders, and BOTH matter: constructive coaching from recurring complaints, and positive reinforcement from praise ("Guests are loving the crispy skin — keep it up"). When the feedback is mostly positive, favor praise — don't nag a crew that's doing well. A strong or weak star-rating trend counts as a signal even when reviews have no text.
- Each reminder must be actionable or motivating for the LINE (food quality, temperature, portioning, order accuracy, bag checks for delivery, speed, hospitality). Ignore themes the kitchen can't act on (parking, prices, app bugs).
- Max ~140 characters per language. Write the English and a Mexican Spanish translation (kitchen-floor register, tú form — match the tone of "Verifica la temperatura interna del pollo").
- NEVER include customer names, reviewer handles, employee names, dates, or anything identifying. source_quote, if used, must be a short anonymized paraphrase (or empty string).
- Base every reminder on the feedback provided — do not invent issues.`;

function buildUserMessage(storeId, reviews, days) {
  const name = STORE_DISPLAY[storeId] || storeId;
  const rated = reviews.filter((r) => r.rating != null);
  const avg = rated.length
    ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(2)
    : 'n/a';
  const dist = [5, 4, 3, 2, 1]
    .map((star) => `${star}★: ${rated.filter((r) => r.rating === star).length}`)
    .join(', ');

  const withText = reviews.filter((r) => r.text);
  const noText = reviews.length - withText.length;
  const lines = withText.map((r, i) =>
    `${i + 1}. [${r.rating != null ? `${r.rating}★` : 'no rating'}${r.source ? `, ${r.source}` : ''}] ${r.text.slice(0, MAX_REVIEW_CHARS)}`
  );

  return [
    `Store: WILDBIRD ${name}`,
    `Window: last ${days} days · ${reviews.length} reviews · avg rating ${avg}`,
    `Rating distribution: ${dist}`,
    `Reviews without comment text: ${noText} (their ratings are in the distribution above)`,
    '',
    'Reviews with text:',
    lines.length ? lines.join('\n') : '(none — work from the rating mix alone)',
  ].join('\n');
}

async function clearFeedbackTips(storeId) {
  const db = getServiceClient();
  return withRetry(() => db.from('lc_feedback_tips').delete().eq('store_id', storeId));
}

// Generate + persist tips for one store.
// Returns { store, status, tipCount?, reviewCount?, tips?, error? }.
export async function generateFeedbackTipsForStore(storeId, { days = 14, dry = false } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { store: storeId, status: 'error', error: 'ANTHROPIC_API_KEY not configured' };
  }

  const { data: cfg } = await getConfig(storeId);
  if (cfg?.settings?.feedback_tips_enabled === false) {
    return { store: storeId, status: 'disabled' };
  }

  const { data: reviews, error: feedbackError } = await getRecentFeedback(storeId, days);
  if (feedbackError) {
    return { store: storeId, status: 'error', error: feedbackError.message || String(feedbackError) };
  }
  if (!reviews || reviews.length < MIN_REVIEWS) {
    if (!dry) await clearFeedbackTips(storeId);
    return { store: storeId, status: 'skipped_insufficient', reviewCount: reviews?.length || 0 };
  }

  const model = process.env.LC_FEEDBACK_TIPS_MODEL || DEFAULT_MODEL;
  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: TIP_SCHEMA } },
      messages: [{ role: 'user', content: buildUserMessage(storeId, reviews, days) }],
    });
  } catch (err) {
    return { store: storeId, status: 'error', error: err.message || String(err) };
  }
  if (response.stop_reason === 'max_tokens') {
    return { store: storeId, status: 'error', error: 'Generation truncated (max_tokens) — not storing partial tips' };
  }
  if (response.stop_reason === 'refusal') {
    return { store: storeId, status: 'error', error: 'Generation refused by model' };
  }

  let parsed;
  try {
    const text = response.content.find((b) => b.type === 'text')?.text || '';
    parsed = JSON.parse(text);
  } catch {
    return { store: storeId, status: 'error', error: 'Could not parse generated tips' };
  }

  // Belt-and-braces even with the schema: normalize to the { en, es }
  // contract, drop empties, clamp count and length.
  const clamp = (s) => (typeof s === 'string' ? s.trim().slice(0, 200) : '');
  const tips = (parsed.tips || [])
    .map((raw) => ({ ...normalizeTip(raw), source_quote: clamp(raw?.source_quote) }))
    .map((t) => ({ en: clamp(t.en), es: clamp(t.es), source_quote: t.source_quote }))
    .filter((t) => t.en || t.es)
    .slice(0, MAX_TIPS);

  if (tips.length === 0) {
    return { store: storeId, status: 'error', error: 'Model returned no usable tips' };
  }

  const rated = reviews.filter((r) => r.rating != null);
  const row = {
    store_id: storeId,
    tips,
    review_count: reviews.length,
    avg_rating: rated.length
      ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 100) / 100
      : null,
    window_start: new Date(Date.now() - days * 24 * 3600_000).toISOString(),
    window_end: new Date().toISOString(),
    model,
    generated_at: new Date().toISOString(),
  };

  if (dry) {
    return { store: storeId, status: 'dry_run', tipCount: tips.length, reviewCount: reviews.length, tips };
  }

  const db = getServiceClient();
  const { error } = await withRetry(() =>
    db.from('lc_feedback_tips').upsert(row, { onConflict: 'store_id' }).select().single()
  );
  if (error) {
    return { store: storeId, status: 'error', error: error.message || String(error) };
  }
  return { store: storeId, status: 'generated', tipCount: tips.length, reviewCount: reviews.length };
}

// Sequential loop over all stores (6 LLM calls — sequential avoids
// rate-limit bursts; whole run is ~1-2 min, fine for a cron).
export async function generateAllFeedbackTips({ days = 14, dry = false } = {}) {
  const results = [];
  for (const storeId of Object.keys(STORE_DISPLAY)) {
    try {
      results.push(await generateFeedbackTipsForStore(storeId, { days, dry }));
    } catch (err) {
      results.push({ store: storeId, status: 'error', error: err.message || String(err) });
    }
  }
  const summary = {
    generated: results.filter((r) => r.status === 'generated').length,
    dry_run: results.filter((r) => r.status === 'dry_run').length,
    skipped: results.filter((r) => r.status === 'skipped_insufficient' || r.status === 'disabled').length,
    errors: results.filter((r) => r.status === 'error').length,
  };
  return { ran_at: new Date().toISOString(), days, dry, summary, results };
}

// ── Readers (admin surface) ─────────────────────────────

export async function getFeedbackTips(storeId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_feedback_tips').select('*').eq('store_id', storeId).maybeSingle()
  );
}

export async function getAllFeedbackTips() {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_feedback_tips').select('*').order('store_id')
  );
}
