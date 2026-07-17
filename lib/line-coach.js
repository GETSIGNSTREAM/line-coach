import { getServiceClient, withRetry } from './supabase.js';
import { canonicalSideName } from './side-canonical.js';
import { canonicalItemName } from './item-canonical.js';

// Toast location GUID → store slug mapping
const TOAST_LOCATION_MAP = {
  '6d44b706-08a6-49fc-a1e6-c79d66727105': 'culver-city',
  'f5c0456a-7cfb-4e27-91fb-da1479c6bfa9': '3rd-la-brea',
  '8bc05d81-83ff-44ea-84e7-2c69c3e3f4c7': 'hollywood',
  '78575cd0-76ac-404b-90a1-2dd093d01c55': 'westwood',
  'd6a5e94b-d3cf-4a86-8022-47813e4c1d3b': 'dtla',
  'a06d8b87-37f4-4704-bbb8-acc92945d9fe': 'el-segundo',
  'default': 'hollywood',
};

export function resolveStoreId(toastLocationGuid) {
  return TOAST_LOCATION_MAP[toastLocationGuid] || TOAST_LOCATION_MAP['default'];
}

// ── Orders ──────────────────────────────────────────────

export async function getActiveOrders(storeId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_active_orders')
      .select('*')
      .eq('store_id', storeId)
      .order('priority_rank', { ascending: true })
      .order('fire_at', { ascending: true })
  );
}

export async function insertOrder(order) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_orders').insert(order).select().single()
  );
}

export async function upsertOrderByToastId(toastOrderId, order) {
  const db = getServiceClient();
  const { data: existing } = await withRetry(() =>
    db.from('lc_orders')
      .select('id, status')
      .eq('toast_order_id', toastOrderId)
      .eq('status', 'active')
      .maybeSingle()
  );

  if (existing) {
    return withRetry(() =>
      db.from('lc_orders')
        .update(order)
        .eq('id', existing.id)
        .select()
        .single()
    );
  }

  return withRetry(() =>
    db.from('lc_orders').insert({ ...order, toast_order_id: toastOrderId }).select().single()
  );
}

export async function bumpOrderByToastId(toastOrderId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_orders')
      .update({ status: 'bumped', bumped_at: new Date().toISOString() })
      .eq('toast_order_id', toastOrderId)
      .eq('status', 'active')
      .select()
  );
}

export async function bumpOrder(orderId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_orders')
      .update({ status: 'bumped', bumped_at: new Date().toISOString() })
      .eq('id', orderId)
      .select()
      .single()
  );
}

// Reverses a bump: returns the order to active status and clears
// bumped_at. Used by the kitchen-display "Undo" button so a misfired
// touch-to-bump can be recovered within the 5-second undo window.
export async function unbumpOrder(orderId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_orders')
      .update({ status: 'active', bumped_at: null })
      .eq('id', orderId)
      .select()
      .single()
  );
}

// Sweep stale active orders so the side-batch aggregation never sees
// them. Uses created_at as the age signal because that's what the
// display's stale-ticket filter uses; staying in lockstep means a cook
// never sees an order disappear from the screen while the batching math
// still includes it (or vice versa).
//
// We flip status to 'bumped' (the existing terminal state in the
// schema's CHECK constraint) rather than adding an 'expired' enum.
// Semantically these ARE bumped — just by timeout instead of by an
// explicit Toast completion event. lc_active_orders already filters
// status='active', so this drops them from the display + batch math.
//
// PostgREST caps the rows returned by `.update().select()` (commonly
// 1000), and we hit that limit in production: a 1,357-row phantom
// backlog accumulated over days while the cron quietly under-swept
// each invocation. We loop until a pass returns zero, capped at
// SWEEP_MAX_ITERATIONS to keep a single cron run bounded. Each pass
// commits its own update, so partial progress is safe.
//
// Returns the aggregated swept rows so callers can log a total count.
// Idempotent: a second invocation with no fresh phantoms is a no-op.
const SWEEP_MAX_ITERATIONS = 10;
const SWEEP_BATCH_LIMIT = 1000;

export async function sweepStaleOrders(maxTicketMinutes) {
  const db = getServiceClient();
  const cutoffIso = new Date(Date.now() - maxTicketMinutes * 60_000).toISOString();
  const aggregated = [];

  for (let i = 0; i < SWEEP_MAX_ITERATIONS; i++) {
    // Pull a bounded batch of stale IDs first, then update by id IN
    // (...). This avoids relying on PostgREST's implicit row cap on
    // update().select() and gives us deterministic batch sizes.
    const { data: stale, error: pickError } = await withRetry(() =>
      db.from('lc_orders')
        .select('id')
        .eq('status', 'active')
        .lt('created_at', cutoffIso)
        .limit(SWEEP_BATCH_LIMIT)
    );
    if (pickError) return { data: aggregated, error: pickError };
    if (!stale || stale.length === 0) break;

    const ids = stale.map((r) => r.id);
    const { data: bumped, error: updateError } = await withRetry(() =>
      db.from('lc_orders')
        .update({ status: 'bumped', bumped_at: new Date().toISOString() })
        .in('id', ids)
        .select('id, store_id, created_at')
    );
    if (updateError) return { data: aggregated, error: updateError };
    if (bumped) aggregated.push(...bumped);

    // If the batch returned fewer rows than we asked for, there's
    // nothing left to sweep — short-circuit.
    if (stale.length < SWEEP_BATCH_LIMIT) break;
  }

  return { data: aggregated, error: null };
}

// ── Config ──────────────────────────────────────────────
// Brand-wide fields (menu_items, sides, quality_tips, hold_times) live
// in lc_brand_config (single row). Per-store fields (just `settings`)
// live in lc_config keyed by store_id. getConfig merges both so callers
// see one combined object.
//
// Brand cache: 60s in-memory. Invalidated on any brand mutation.

const BRAND_CACHE_TTL_MS = 60_000;
let _brandCache = null; // { data, expiresAt }

const BRAND_FIELDS = ['menu_items', 'sides', 'quality_tips', 'hold_times', 'service_hours', 'recap_recipients', 'default_languages', 'dining_option_labels'];

// Hold-times defaults are brand-wide and anchor the 10-min brand promise:
//   sla_target_minutes (8)  → amber band (internal target)
//   sla_breach_minutes (10) → red band   (brand promise breach)
//   max_ticket_minutes (12) → hard DB cleanup cutoff (sweep cron)
// 12 leaves a 2-min grace after the breach band so legitimate large/
// catering cooks don't get yanked from batching math mid-cook.
const HOLD_TIME_DEFAULTS = {
  fire_now: 5,
  staging: 15,
  on_deck: 30,
  max_ticket_minutes: 12,
  sla_target_minutes: 8,
  sla_breach_minutes: 10,
  // Minutes a Toast promise must exceed creation time before we treat
  // it as a genuine schedule-ahead order (future fire_at). Below this,
  // promisedDate is just the ASAP ready quote and the ticket fires now.
  schedule_ahead_minutes: 30,
};

function brandDefaults() {
  return {
    menu_items: DEFAULT_MENU_ITEMS,
    sides: DEFAULT_SIDES,
    quality_tips: DEFAULT_QUALITY_TIPS,
    hold_times: { ...HOLD_TIME_DEFAULTS },
    service_hours: {},
    recap_recipients: {},
    // Per-store default language for the kitchen display + phone
    // companion. Shape: { [storeSlug]: 'en' | 'es' }. Empty map means
    // every store falls back to the hardcoded 'es' default. Device
    // localStorage overrides this per-screen.
    default_languages: {},
    // Per-store dining-option GUID → human label map. Toast sends
    // dining_option as an opaque GUID per-restaurant; admins map
    // each GUID to a label ("Dine In", "Takeout", "Pickup", etc.)
    // and the webhook resolves it at write time. Shape:
    //   { storeSlug: { guid: 'Dine In', … }, … }
    dining_option_labels: {},
  };
}

async function loadBrandConfig() {
  const db = getServiceClient();
  const { data, error } = await withRetry(() =>
    db.from('lc_brand_config').select('*').eq('id', 1).maybeSingle()
  );
  if (error || !data) return brandDefaults();
  return {
    menu_items: data.menu_items || [],
    sides: data.sides || [],
    quality_tips: data.quality_tips || [],
    hold_times: { ...HOLD_TIME_DEFAULTS, ...(data.hold_times || {}) },
    service_hours: data.service_hours || {},
    recap_recipients: data.recap_recipients || {},
    default_languages: data.default_languages || {},
    dining_option_labels: data.dining_option_labels || {},
  };
}

export function invalidateBrandCache() {
  _brandCache = null;
}

async function getBrandConfig() {
  if (!_brandCache || Date.now() > _brandCache.expiresAt) {
    _brandCache = { data: await loadBrandConfig(), expiresAt: Date.now() + BRAND_CACHE_TTL_MS };
  }
  return _brandCache.data;
}

export async function getConfig(storeId) {
  const db = getServiceClient();
  const [brand, storeRow, feedbackRow] = await Promise.all([
    getBrandConfig(),
    withRetry(() => db.from('lc_config').select('settings').eq('store_id', storeId).maybeSingle()),
    // Per-store, machine-written tips generated from Momos customer
    // feedback (lib/feedback-tips.js). Kept separate from quality_tips so
    // the display can tag their source. Not a BRAND_FIELD on purpose:
    // updateConfig must never write it.
    withRetry(() => db.from('lc_feedback_tips').select('tips, generated_at').eq('store_id', storeId).maybeSingle()),
  ]);

  const settings = {
    quality_coach_interval: 30,
    side_batch_threshold: 3,
    feedback_tips_enabled: true,
    // Learn mode is opt-in per store: when false the display hides the
    // LEARN toggle entirely (new-hire build-step walkthroughs).
    learn_mode_enabled: false,
    ...(storeRow.data?.settings || {}),
  };

  return {
    data: {
      store_id: storeId,
      ...brand,
      feedback_tips: feedbackRow.data?.tips || [],
      feedback_tips_generated_at: feedbackRow.data?.generated_at || null,
      settings,
    },
    error: null,
  };
}

// Splits an incoming config payload into brand-wide fields and per-store
// fields, then writes each to its own table. The admin UI sends the
// merged shape; callers don't need to know about the split.
export async function updateConfig(storeId, config) {
  const db = getServiceClient();
  const brandUpdate = {};
  for (const f of BRAND_FIELDS) {
    if (f in config) brandUpdate[f] = config[f];
  }

  const writes = [];

  if (Object.keys(brandUpdate).length > 0) {
    writes.push(
      withRetry(() =>
        db.from('lc_brand_config')
          .upsert({ id: 1, ...brandUpdate, updated_at: new Date().toISOString() })
          .select()
          .single()
      ).then((r) => { invalidateBrandCache(); return r; })
    );
  }

  if ('settings' in config) {
    writes.push(
      withRetry(() =>
        db.from('lc_config')
          .upsert({ store_id: storeId, settings: config.settings, updated_at: new Date().toISOString() }, { onConflict: 'store_id' })
          .select()
          .single()
      )
    );
  }

  if (writes.length === 0) {
    return { data: { store_id: storeId, ...config }, error: null };
  }

  const results = await Promise.all(writes);
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) return { data: null, error: firstError };

  // Return the freshly-merged shape so the admin can re-render with truth.
  return getConfig(storeId);
}

// ── Devices ─────────────────────────────────────────────

export async function registerDevice(device) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_devices')
      .upsert(
        { ...device, last_heartbeat: new Date().toISOString() },
        { onConflict: 'device_id' }
      )
      .select()
      .single()
  );
}

export async function getDevices(storeId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_devices')
      .select('*')
      .eq('store_id', storeId)
      .order('last_heartbeat', { ascending: false })
  );
}

export async function heartbeatDevice(deviceId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_devices')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('device_id', deviceId)
      .select()
      .single()
  );
}

export async function deleteDevice(deviceId) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_devices')
      .delete()
      .eq('device_id', deviceId)
      .select()
      .maybeSingle()
  );
}

// ── Webhook log ─────────────────────────────────────────
// Fire-and-forget logger for inbound Toast webhooks. Call from the
// webhook route on each exit branch so failures (auth, parse, insert)
// are visible in the admin Webhooks tab.

const WEBHOOK_LOG_PAYLOAD_MAX = 64 * 1024;

export function logWebhook(entry) {
  try {
    const db = getServiceClient();
    let payload = entry.payload;
    if (typeof payload === 'string') {
      const head = payload.slice(0, WEBHOOK_LOG_PAYLOAD_MAX);
      payload = { _raw: head, _truncated: payload.length > WEBHOOK_LOG_PAYLOAD_MAX };
    }
    db.from('lc_webhook_log')
      .insert({
        store_id: entry.store_id || null,
        status: entry.status,
        http_status: entry.http_status,
        event_type: entry.event_type || null,
        order_id: entry.order_id || null,
        toast_order_id: entry.toast_order_id || null,
        error_message: entry.error_message || null,
        payload: payload ?? null,
        ip: entry.ip || null,
        duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
      })
      .then(({ error }) => {
        if (error) console.error('logWebhook failed:', error.message);
      });
  } catch (err) {
    console.error('logWebhook threw:', err.message);
  }
}

export async function listWebhookLogs({ storeId, limit = 50, status, sinceHours = 24 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  let query = db.from('lc_webhook_log')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500));
  if (storeId) query = query.eq('store_id', storeId);
  if (status) query = query.eq('status', status);
  return withRetry(() => query);
}

// ── Integration health ──────────────────────────────────

export async function getIntegrationHealth({ sinceHours = 24 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const { data, error } = await withRetry(() => db.from('lc_webhook_log')
    .select('store_id, status, created_at, error_message')
    .gte('created_at', since)
    .order('created_at', { ascending: false }));

  if (error) return { data: null, error };

  const stores = Object.keys(TOAST_LOCATION_MAP)
    .filter((k) => k !== 'default')
    .map((guid) => ({ store_id: TOAST_LOCATION_MAP[guid], toast_location: guid }));
  // Dedup store_ids
  const uniqueStores = [...new Map(stores.map((s) => [s.store_id, s])).values()];

  const now = Date.now();
  const byStore = new Map();
  for (const row of data || []) {
    const sid = row.store_id || '__unrouted__';
    const bucket = byStore.get(sid) || { total: 0, ok: 0, errors: 0, last_ok_at: null, last_error: null };
    bucket.total += 1;
    if (row.status === 'ok') {
      bucket.ok += 1;
      if (!bucket.last_ok_at) bucket.last_ok_at = row.created_at;
    } else if (row.status !== 'ignored') {
      bucket.errors += 1;
      if (!bucket.last_error) bucket.last_error = { status: row.status, at: row.created_at, message: row.error_message };
    }
    byStore.set(sid, bucket);
  }

  function classify(bucket) {
    if (!bucket || bucket.total === 0) return { state: 'silent', reason: 'No webhook activity in window' };
    if (!bucket.last_ok_at) return { state: 'critical', reason: 'No successful webhooks in window' };
    const minsSinceOk = Math.floor((now - new Date(bucket.last_ok_at).getTime()) / 60_000);
    const errorRate = bucket.total ? bucket.errors / bucket.total : 0;
    if (minsSinceOk > 60) return { state: 'critical', reason: `No success in ${minsSinceOk} min` };
    if (errorRate > 0.2) return { state: 'warning', reason: `${Math.round(errorRate * 100)}% error rate` };
    if (minsSinceOk > 30) return { state: 'warning', reason: `Last ok ${minsSinceOk} min ago` };
    return { state: 'healthy', reason: null };
  }

  const perStore = uniqueStores.map((s) => {
    const bucket = byStore.get(s.store_id);
    const cls = classify(bucket);
    return {
      store_id: s.store_id,
      total: bucket?.total || 0,
      ok: bucket?.ok || 0,
      errors: bucket?.errors || 0,
      last_ok_at: bucket?.last_ok_at || null,
      last_error: bucket?.last_error || null,
      state: cls.state,
      reason: cls.reason,
    };
  });

  const unrouted = byStore.get('__unrouted__');
  if (unrouted) {
    perStore.push({
      store_id: null,
      total: unrouted.total,
      ok: unrouted.ok,
      errors: unrouted.errors,
      last_ok_at: unrouted.last_ok_at,
      last_error: unrouted.last_error,
      state: unrouted.errors > 0 ? 'warning' : 'healthy',
      reason: 'Webhooks with no resolved store',
    });
  }

  return { data: { since_hours: sinceHours, stores: perStore }, error: null };
}

// ── Retention / maintenance ─────────────────────────────

export async function getMaintenanceStats() {
  const db = getServiceClient();
  const [orders, archive, logs, oldestOrder, oldestLog] = await Promise.all([
    withRetry(() => db.from('lc_orders').select('*', { count: 'exact', head: true })),
    withRetry(() => db.from('lc_orders_archive').select('*', { count: 'exact', head: true })),
    withRetry(() => db.from('lc_webhook_log').select('*', { count: 'exact', head: true })),
    withRetry(() => db.from('lc_orders').select('created_at').order('created_at', { ascending: true }).limit(1).maybeSingle()),
    withRetry(() => db.from('lc_webhook_log').select('created_at').order('created_at', { ascending: true }).limit(1).maybeSingle()),
  ]);
  return {
    data: {
      orders_count: orders.count ?? null,
      archive_count: archive.count ?? null,
      webhook_log_count: logs.count ?? null,
      oldest_order_at: oldestOrder.data?.created_at || null,
      oldest_webhook_log_at: oldestLog.data?.created_at || null,
    },
    error: null,
  };
}

export async function purgeOldLogs(daysToKeep = 30) {
  const db = getServiceClient();
  return withRetry(() => db.rpc('lc_purge_old_logs', { days_to_keep: daysToKeep }));
}

export async function archiveOldOrders(daysToKeep = 7) {
  const db = getServiceClient();
  return withRetry(() => db.rpc('lc_archive_orders', { days_to_keep: daysToKeep }));
}

// ── Analytics ───────────────────────────────────────────

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export async function getAnalytics({ storeId, sinceHours = 24 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  let query = db.from('lc_orders')
    .select('id, created_at, bumped_at, items, sides')
    .gte('bumped_at', since)
    .not('bumped_at', 'is', null);
  if (storeId) query = query.eq('store_id', storeId);

  const { data, error } = await withRetry(() => query);
  if (error) return { data: null, error };

  const rows = data || [];
  const bumpSeconds = [];
  const byHour = new Map();
  const byItem = new Map();

  for (const row of rows) {
    if (!row.created_at || !row.bumped_at) continue;
    const created = new Date(row.created_at).getTime();
    const bumped = new Date(row.bumped_at).getTime();
    const sec = Math.max(0, Math.round((bumped - created) / 1000));
    bumpSeconds.push(sec);

    const d = new Date(row.bumped_at);
    const hourKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}:00:00Z`;
    const bucket = byHour.get(hourKey) || { count: 0, sumSec: 0 };
    bucket.count += 1;
    bucket.sumSec += sec;
    byHour.set(hourKey, bucket);

    for (const item of row.items || []) {
      const name = item.name || (typeof item === 'string' ? item : null);
      if (!name) continue;
      byItem.set(name, (byItem.get(name) || 0) + (item.quantity || 1));
    }
    for (const side of row.sides || []) {
      const name = side.name || (typeof side === 'string' ? side : null);
      if (!name) continue;
      byItem.set(name, (byItem.get(name) || 0) + (side.quantity || 1));
    }
  }

  bumpSeconds.sort((a, b) => a - b);
  const count = bumpSeconds.length;
  const avg = count ? Math.round(bumpSeconds.reduce((s, v) => s + v, 0) / count) : 0;

  const hourly = [...byHour.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, b]) => ({ hour, count: b.count, avg_bump_seconds: Math.round(b.sumSec / b.count) }));

  const topItems = [...byItem.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, n]) => ({ name, count: n }));

  return {
    data: {
      since_hours: sinceHours,
      count,
      avg_bump_seconds: avg,
      p50_bump_seconds: percentile(bumpSeconds, 50),
      p90_bump_seconds: percentile(bumpSeconds, 90),
      p95_bump_seconds: percentile(bumpSeconds, 95),
      max_bump_seconds: count ? bumpSeconds[count - 1] : 0,
      hourly,
      top_items: topItems,
    },
    error: null,
  };
}

// ── Dining-option GUID discovery ────────────────────────
//
// Toast sends dining_option as an opaque object referencing a per-
// restaurant GUID. We surface every distinct GUID we've seen (per
// store) so an admin can map it to a human label like "Dine In" or
// "Takeout". Used by the admin Dining Options tab.
//
// Returns shape: [{ store_id, guid, n, last_seen, current_label }]
// where current_label comes from the existing dining_option_labels
// brand-config map (so a saved label round-trips through the UI).

export async function getDistinctDiningGuids({ days = 30 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  // Pull only rows whose dining_option is a JSON object (i.e. has a
  // GUID we'd want to label). Plain-string dining_options like
  // "Dine In" are already labeled.
  const { data, error } = await withRetry(() =>
    db.from('lc_orders')
      .select('store_id, dining_option, toast_created_at')
      .gte('toast_created_at', since)
      .not('dining_option', 'is', null)
  );
  if (error) return { data: null, error };

  // Aggregate per (store, guid).
  const counts = new Map();
  for (const row of data || []) {
    let guid = null;
    const raw = row.dining_option;
    if (typeof raw === 'string' && raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        guid = parsed?.guid || null;
      } catch { /* malformed; skip */ }
    } else if (raw && typeof raw === 'object' && raw.guid) {
      guid = raw.guid;
    }
    if (!guid) continue;
    const key = `${row.store_id}::${guid}`;
    const prev = counts.get(key);
    const ts = row.toast_created_at ? new Date(row.toast_created_at).getTime() : 0;
    if (prev) {
      prev.n += 1;
      if (ts > prev.last_seen_ts) prev.last_seen_ts = ts;
    } else {
      counts.set(key, { store_id: row.store_id, guid, n: 1, last_seen_ts: ts });
    }
  }

  // Layer in the saved labels from brand config so the admin sees
  // existing entries with their current label, not as "unlabeled".
  const brand = await loadBrandConfig();
  const labelMap = brand.dining_option_labels || {};

  const out = [...counts.values()]
    .map((row) => ({
      store_id: row.store_id,
      guid: row.guid,
      n: row.n,
      last_seen: row.last_seen_ts ? new Date(row.last_seen_ts).toISOString() : null,
      current_label: labelMap?.[row.store_id]?.[row.guid] || '',
    }))
    .sort((a, b) => {
      if (a.store_id !== b.store_id) return a.store_id.localeCompare(b.store_id);
      return b.n - a.n;
    });

  return { data: out, error: null };
}

// ── Service hours ───────────────────────────────────────
// Per-store open/close windows live in lc_brand_config.service_hours
// keyed by store slug. The webhook checks them at the top of POST so
// late-night Toast retries / pre-close orders pushed through after
// the kitchen has shut down don't create phantoms in lc_orders.
//
// CLOSE_GRACE_MIN: 15-min buffer past close so genuine last-minute
// orders still get through (an order placed at 21:58 that hits the
// webhook at 22:01 should still cook).

const CLOSE_GRACE_MIN = 15;

// Returns true when `at` falls inside [open, close + 15 min] for the
// store's configured timezone. When no hours are configured for the
// store, returns true (fail-open — never block a webhook for a store
// the admin hasn't set up yet). Intended for the webhook guard only.
//
// hoursMap shape: { [storeSlug]: { open: 'HH:MM', close: 'HH:MM', tz: 'IANA/Zone' } }
export function isWithinServiceWindow(hoursMap, storeId, at = new Date()) {
  const win = hoursMap?.[storeId];
  if (!win || !win.open || !win.close) return true;
  const tz = win.tz || 'America/Los_Angeles';
  // Get the wall-clock H/M in the store's tz so a UTC `at` lines up
  // with the strings the admin typed in.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(at);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return true;
  const nowMin = hh * 60 + mm;

  const [oh, om] = String(win.open).split(':').map(Number);
  const [ch, cm] = String(win.close).split(':').map(Number);
  if (![oh, om, ch, cm].every(Number.isFinite)) return true;
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm + CLOSE_GRACE_MIN;

  // Handle overnight windows (e.g., open 18:00, close 02:00).
  if (closeMin < openMin) {
    return nowMin >= openMin || nowMin <= closeMin;
  }
  return nowMin >= openMin && nowMin <= closeMin;
}

// ── Ticket-time analytics (B2.1) ────────────────────────
// Daily percentiles over (bumped_at - toast_created_at) for the last
// `days` days, scoped to a single store. Used by the admin Analytics
// chart with the 8/10/12-min SLA reference bands.
//
// CRITICAL: rows older than max_ticket_minutes when bumped are
// excluded. Those bumps came from the cleanup cron (or an emergency
// SQL sweep), not the kitchen — including them would dominate the
// percentiles with values orders of magnitude larger than any real
// ticket and make the chart useless. The brand-promise question is
// "of the orders the kitchen actually cooked, how long did they
// take?", and anything that hit the 12-min wall by definition wasn't
// cooked on time. The chart's "n=" annotation tells the manager how
// many tickets actually counted.

export async function getTicketTimePercentiles({ storeId, days = 7, cleanupCutoffMinutes = 12 } = {}) {
  if (!storeId) return { data: [], error: { message: 'storeId required' } };
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const cutoffSec = cleanupCutoffMinutes * 60;

  // Pull bumped + toast_created pairs and bin in JS. Avoids depending
  // on a SQL function being installed; the volume in this window
  // (≤ 6 stores * ≤ 200 orders/day * 7 days = ~8400 rows) is small
  // enough that this is fine.
  const { data, error } = await withRetry(() =>
    db.from('lc_orders')
      .select('toast_created_at, bumped_at')
      .eq('store_id', storeId)
      .gte('toast_created_at', since)
      .not('bumped_at', 'is', null)
  );
  if (error) return { data: null, error };

  const byDay = new Map();
  for (const row of data || []) {
    if (!row.toast_created_at || !row.bumped_at) continue;
    const created = new Date(row.toast_created_at).getTime();
    const bumped = new Date(row.bumped_at).getTime();
    const sec = Math.max(0, Math.round((bumped - created) / 1000));
    if (sec > cutoffSec) continue; // exclude cleanup-driven bumps
    const day = row.toast_created_at.slice(0, 10); // YYYY-MM-DD (UTC)
    const arr = byDay.get(day) || [];
    arr.push(sec);
    byDay.set(day, arr);
  }

  const pick = (sortedAsc, p) => {
    if (sortedAsc.length === 0) return null;
    const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
    return sortedAsc[idx];
  };

  const out = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, secs]) => {
      secs.sort((a, b) => a - b);
      return {
        day,
        n: secs.length,
        p50: pick(secs, 50),
        p90: pick(secs, 90),
        p99: pick(secs, 99),
      };
    });
  return { data: out, error: null };
}

// ── Menu-item performance ───────────────────────────────
//
// Per-canonical-item time-from-fire-to-bump distribution. Same
// percentile pattern as getTicketTimePercentiles but bucketed by
// item.name (canonicalized via lib/item-canonical) instead of by day.
// Each item gets its station looked up against brand-config menu_items.
//
// IMPORTANT semantics: the time we attribute to an item is the
// WHOLE-TICKET time. If an order contains a Quarter Bird + Tacos
// Dorados and the ticket took 8 min, both items get an 8-min sample.
// That's "ticket time when this item is present", not "this item
// took X to plate." Honest naming in the UI prevents misreading.
//
// Excludes cleanup-bumped rows (bumped_at - created_at > 12 min)
// for the same reason getTicketTimePercentiles does: those are
// cron-driven, not kitchen-driven.

export async function getItemTimePercentiles({ storeId = null, days = 30, cleanupCutoffMinutes = 12 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const cutoffSec = cleanupCutoffMinutes * 60;

  // Pull bumped orders with their items. Filter by store optionally;
  // omit the eq() for brand-wide aggregation.
  let q = db.from('lc_orders')
    .select('toast_created_at, bumped_at, items, store_id')
    .gte('toast_created_at', since)
    .not('bumped_at', 'is', null);
  if (storeId) q = q.eq('store_id', storeId);
  const { data, error } = await withRetry(() => q);
  if (error) return { data: null, error };

  // Look up station per canonical item against brand menu_items.
  // getBrandConfig is private; use loadBrandConfig directly here. We
  // don't need the cached path because this endpoint is admin-only
  // and called rarely (~1 query per tab visit).
  const brand = await loadBrandConfig();
  const menuItems = brand.menu_items || [];
  const stationByCanonical = new Map();
  for (const m of menuItems) {
    const canonical = canonicalItemName(m.name) || m.name;
    if (canonical && !stationByCanonical.has(canonical)) {
      stationByCanonical.set(canonical, m.station || null);
    }
  }

  // Per-canonical-name array of seconds-to-bump.
  const perItem = new Map();
  for (const row of data || []) {
    if (!row.toast_created_at || !row.bumped_at) continue;
    const created = new Date(row.toast_created_at).getTime();
    const bumped = new Date(row.bumped_at).getTime();
    const sec = Math.max(0, Math.round((bumped - created) / 1000));
    if (sec > cutoffSec) continue; // exclude cleanup-bumped
    for (const it of row.items || []) {
      const raw = typeof it === 'string' ? it : it?.name;
      if (!raw) continue;
      const canonical = canonicalItemName(raw) || raw;
      if (!perItem.has(canonical)) perItem.set(canonical, []);
      perItem.get(canonical).push(sec);
    }
  }

  const pick = (sortedAsc, p) => {
    if (sortedAsc.length === 0) return null;
    const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
    return sortedAsc[idx];
  };

  const out = [...perItem.entries()]
    .map(([name, secs]) => {
      secs.sort((a, b) => a - b);
      const n = secs.length;
      const avg = n ? Math.round(secs.reduce((s, v) => s + v, 0) / n) : 0;
      return {
        name,
        station: stationByCanonical.get(name) || null,
        n,
        avg,
        p50: pick(secs, 50),
        p90: pick(secs, 90),
        p99: pick(secs, 99),
      };
    })
    .sort((a, b) => b.n - a.n);

  return { data: out, error: null };
}

// ── Daily recap (B2.2) ──────────────────────────────────
// Yesterday's stats for one store, used to build the morning Slack DM.
// "Yesterday" is computed in America/Los_Angeles (all stores are LA),
// so the recap that arrives at 5:00 AM PT covers the prior service day
// from open to close, not a UTC-shifted window.

const LA_TZ = 'America/Los_Angeles';

function laDayBoundaries(daysAgo = 1) {
  // Build the local YYYY-MM-DD then anchor to midnight LA time.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: LA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const target = new Date(Date.now() - daysAgo * 24 * 3600_000);
  const dayStr = fmt.format(target); // 'YYYY-MM-DD'
  // Use noon to dodge DST edge cases when computing the offset.
  const noonLocalIso = `${dayStr}T12:00:00`;
  const probe = new Date(noonLocalIso + 'Z');
  // Compute the offset between LA wall-clock and UTC for this date.
  const laParts = new Intl.DateTimeFormat('en-US', {
    timeZone: LA_TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(probe);
  const laHour = Number(laParts.find((p) => p.type === 'hour')?.value || '12');
  const offsetHours = 12 - laHour; // LA hour = 12 - offset
  const startUtc = new Date(`${dayStr}T00:00:00Z`).getTime() + offsetHours * 3600_000;
  const endUtc = startUtc + 24 * 3600_000;
  return { dayStr, startIso: new Date(startUtc).toISOString(), endIso: new Date(endUtc).toISOString() };
}

// Per-side rolling averages over a trailing window. Used by the
// daily recap + phone companion to flag demand anomalies — e.g.
// "today's brussels were 2.5× the 14-day avg."
//
// Important caveat: lc_orders.sides records what customers ORDERED,
// not what the kitchen prepped. So this helper detects demand-pattern
// anomalies (spikes in customer demand for a side), not literal
// over- or under-production. Names are run through canonicalSideName
// so production typos like "Charred Brocolli" / "Brussels Sprouts"
// merge into one bucket — same source of truth the display uses.
export async function getSideRollingAverages({ storeId, days = 14 } = {}) {
  if (!storeId) return { data: {}, error: { message: 'storeId required' } };
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const { data, error } = await withRetry(() =>
    db.from('lc_orders')
      .select('toast_created_at, sides')
      .eq('store_id', storeId)
      .gte('toast_created_at', since)
  );
  if (error) return { data: null, error };

  // Build a (sideName, dayKey) → count map, then collapse to per-side
  // arrays so we can compute mean + stddev across the window.
  const perDay = new Map(); // key = `${name}::${YYYY-MM-DD}` → qty
  for (const row of data || []) {
    if (!row.toast_created_at) continue;
    const day = row.toast_created_at.slice(0, 10);
    for (const side of row.sides || []) {
      const rawName = typeof side === 'string' ? side : side?.name;
      if (!rawName) continue;
      const name = canonicalSideName(rawName) || rawName;
      const qty = typeof side === 'object' ? Math.max(1, parseInt(side.quantity, 10) || 1) : 1;
      const key = `${name}::${day}`;
      perDay.set(key, (perDay.get(key) || 0) + qty);
    }
  }
  // Group by side name → array of daily totals.
  const perSide = new Map();
  for (const [key, total] of perDay) {
    const [name] = key.split('::');
    if (!perSide.has(name)) perSide.set(name, []);
    perSide.get(name).push(total);
  }
  const out = {};
  for (const [name, dailyTotals] of perSide) {
    const n = dailyTotals.length;
    if (n === 0) continue;
    const mean = dailyTotals.reduce((s, v) => s + v, 0) / n;
    const variance = dailyTotals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    out[name] = {
      avg: mean,
      std: Math.sqrt(variance),
      days_observed: n,
    };
  }
  return { data: out, error: null };
}

// Local helper to find a side's batch_size from the brand-config sides
// array, case- and canonical-name-insensitive. Used by the recap to
// estimate batch-driven waste.
function findSideBatchSize(canonicalName, configSides, fallback = 4) {
  if (!canonicalName) return fallback;
  const lower = canonicalName.toLowerCase();
  const cfg = (configSides || []).find((s) => {
    const n = (s?.name || '').toLowerCase();
    return n === lower || canonicalSideName(s?.name) === canonicalName;
  });
  return cfg?.batch_size || fallback;
}

// Hide imports we now need (canonicalSideName) — already imported in
// the webhook; it's a sibling lib file.

// daysAgo: 0 = today (LA), 1 = yesterday, etc. The 5am Slack recap
// uses 1; the hub TodayPerformance panel + phone companion use 0.
export async function buildDailyRecap({ storeId, slaBreachMin = 10, cleanupCutoffMinutes = 12, daysAgo = 1 } = {}) {
  if (!storeId) return { data: null, error: { message: 'storeId required' } };
  const db = getServiceClient();
  const { dayStr, startIso, endIso } = laDayBoundaries(daysAgo);
  const cleanupCutoffSec = cleanupCutoffMinutes * 60;

  const { data, error } = await withRetry(() =>
    db.from('lc_orders')
      .select('toast_created_at, bumped_at, items, sides')
      .eq('store_id', storeId)
      .gte('toast_created_at', startIso)
      .lt('toast_created_at', endIso)
  );
  if (error) return { data: null, error };

  const rows = data || [];
  const ages = [];
  const sideCounts = new Map();
  const entreeCounts = new Map();
  let overSla = 0;
  let cleanupBumped = 0;

  for (const row of rows) {
    if (row.toast_created_at && row.bumped_at) {
      const created = new Date(row.toast_created_at).getTime();
      const bumped = new Date(row.bumped_at).getTime();
      const sec = Math.max(0, Math.round((bumped - created) / 1000));
      // Cleanup-driven bumps don't represent kitchen performance —
      // count them separately so the manager sees how many tickets
      // hit the wall, but keep them out of the percentile math.
      if (sec > cleanupCutoffSec) {
        cleanupBumped += 1;
      } else {
        ages.push(sec);
        if (sec > slaBreachMin * 60) overSla += 1;
      }
    }
    for (const item of row.items || []) {
      const name = item?.name || (typeof item === 'string' ? item : null);
      if (!name) continue;
      entreeCounts.set(name, (entreeCounts.get(name) || 0) + (item.quantity || 1));
    }
    for (const side of row.sides || []) {
      // Canonicalize so "Brussel Sprouts" / "brussel sprouts" /
      // "Charred Brocolli" all merge into the same bucket — and
      // critically, match what getSideRollingAverages produces
      // so the anomaly join below works.
      const raw = side?.name || (typeof side === 'string' ? side : null);
      if (!raw) continue;
      const name = canonicalSideName(raw) || raw;
      sideCounts.set(name, (sideCounts.get(name) || 0) + (side.quantity || 1));
    }
  }

  ages.sort((a, b) => a - b);
  const n = ages.length;
  const avg = n ? Math.round(ages.reduce((s, v) => s + v, 0) / n) : 0;
  const p90 = n ? ages[Math.min(n - 1, Math.floor(0.9 * n))] : null;
  const overSlaPct = n ? (overSla / n) * 100 : 0;

  const topSides = [...sideCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topEntrees = [...entreeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Side-batch anomaly detection. Pull rolling averages over the
  // trailing 14 days (excluding today's window) and flag sides whose
  // demand today is materially above or below the trailing baseline.
  // Uses 1.5σ thresholds when std is meaningful; falls back to 1.5×
  // mean when the day-to-day std is tiny (means a side that always
  // sells ~the same amount). Only looks at sides we saw today.
  let perSideAnalysis = [];
  let anomalies = [];
  let configSides = [];
  try {
    const { data: cfg } = await getConfig(storeId);
    configSides = cfg?.sides || [];
    const { data: rolling } = await getSideRollingAverages({ storeId, days: 14 });
    perSideAnalysis = [...sideCounts.entries()]
      .map(([name, count]) => {
        const r = rolling?.[name];
        const avg14 = r?.avg ?? null;
        const std14 = r?.std ?? null;
        const daysObserved = r?.days_observed ?? 0;
        const pctVsAvg = (avg14 != null && avg14 > 0) ? (count / avg14) : null;
        const batchSize = findSideBatchSize(name, configSides);
        const preppedEst = Math.ceil(count / batchSize) * batchSize;
        const estWaste = Math.max(0, preppedEst - count);
        // Flag rules:
        //   high: count >= max(avg + 1.5σ, avg × 1.5)
        //   low:  count <= min(avg - 1.5σ, avg × 0.5) AND avg > 5
        // The "avg > 5" floor on low avoids spamming flags for rare
        // sides that average 1-2/day where one zero day is normal.
        let flag = null;
        if (avg14 != null && daysObserved >= 5) {
          const sigmaHigh = avg14 + 1.5 * (std14 || 0);
          const ratioHigh = avg14 * 1.5;
          const sigmaLow = avg14 - 1.5 * (std14 || 0);
          const ratioLow = avg14 * 0.5;
          if (count >= Math.max(sigmaHigh, ratioHigh)) flag = 'high';
          else if (count <= Math.min(sigmaLow, ratioLow) && avg14 > 5) flag = 'low';
        }
        return {
          name,
          count,
          avg_14d: avg14 != null ? Math.round(avg14 * 10) / 10 : null,
          std_14d: std14 != null ? Math.round(std14 * 10) / 10 : null,
          days_observed: daysObserved,
          pct_vs_avg: pctVsAvg != null ? Math.round(pctVsAvg * 100) : null,
          batch_size: batchSize,
          prepped_estimate: preppedEst,
          est_waste: estWaste,
          anomaly_flag: flag,
        };
      })
      .sort((a, b) => b.count - a.count);
    anomalies = perSideAnalysis.filter((s) => s.anomaly_flag);
  } catch (sideErr) {
    // Fail-soft: a config or rolling-avg failure must not break the
    // rest of the recap. Log and ship with empty analysis.
    console.error('side anomaly compute failed:', sideErr.message);
  }

  return {
    data: {
      store_id: storeId,
      day: dayStr,
      tickets: n,
      cleanup_bumped: cleanupBumped,
      avg_seconds: avg,
      p90_seconds: p90,
      over_sla: overSla,
      over_sla_pct: overSlaPct,
      sla_breach_min: slaBreachMin,
      top_sides: topSides.map(([name, count]) => ({ name, count })),
      top_entrees: topEntrees.map(([name, count]) => ({ name, count })),
      per_side_analysis: perSideAnalysis,
      anomalies,
    },
    error: null,
  };
}

// ── Seed Data Defaults ──────────────────────────────────

// Each menu item supports an optional bilingual coach_tip { en, es } that
// is shown in focus mode (Display when only 1 order is on the board).
// Empty es means English-only is rendered. The display falls back to
// the store-level quality_tips when an item has no coach_tip.
const DEFAULT_MENU_ITEMS = [
  // BETTER CHICKEN
  { name: 'Quarter Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.', es: 'Verifica temperatura interna — 74°C (165°F). Piel dorada, sin partes pálidas. Saca primero el pollo más viejo del calentador.' } },
  { name: 'Half Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.', es: 'Verifica temperatura interna — 74°C (165°F). Piel dorada, sin partes pálidas. Saca primero el pollo más viejo del calentador.' } },
  { name: 'Whole Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Whole bird presentation — even golden color, breast-up. Confirm 165°F at thickest part of the thigh.', es: 'Presentación de pollo entero — color dorado uniforme, pechuga arriba. Confirma 74°C (165°F) en la parte más gruesa del muslo.' } },
  { name: 'Chicken Dinner Box', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Pack hot items together, cold items separate. Tortillas warm and pliable, salsa fresh.', es: 'Empaca lo caliente junto, lo frío aparte. Tortillas calientes y suaves, salsa fresca.' } },
  { name: 'Protein Plate', station: 'line', cook_time: 3, category: 'Better Chicken', coach_tip: { en: 'Portion chicken by weight — 51+ grams protein. Two sides, no shorting the guest.', es: 'Porciona el pollo por peso — 51+ gramos de proteína. Dos guarniciones, no le faltes al cliente.' } },
  // MARKET PLATE
  { name: 'Boneless Breast Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Boneless breast: even slice, juicy. Two sides per plate. Garnish before it leaves the pass.', es: 'Pechuga sin hueso: rebanada pareja, jugosa. Dos guarniciones por plato. Decora antes de que salga del pase.' } },
  { name: 'Chicken Tinga Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Tinga should be saucy, not dry. Taste the salsa before plating. Two sides per plate.', es: 'La tinga debe estar con salsa, no seca. Prueba la salsa antes de servir. Dos guarniciones por plato.' } },
  { name: 'Veggie Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'No protein on this plate — double-check before firing. Two sides, full portion.', es: 'Sin proteína en este plato — confirma antes de empezar. Dos guarniciones, porción completa.' } },
  { name: 'Pollo Verde Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Verde should be bright green, not muddy. Taste before plating. Two sides per plate.', es: 'El pollo verde debe estar verde brillante, no opaco. Prueba antes de servir. Dos guarniciones por plato.' } },
  // MODERN MEXICAN
  { name: 'Tacos Dorados', station: 'fryer', cook_time: 5, category: 'Modern Mexican', coach_tip: { en: 'Fry oil at 350°F — golden and crisp, not greasy. Plate immediately, no sitting.', es: 'Aceite a 175°C (350°F) — dorados y crujientes, no grasosos. Sirve de inmediato, que no se enfríen.' } },
  { name: 'Burrito Mexicano', station: 'line', cook_time: 4, category: 'Modern Mexican', coach_tip: { en: 'Wrap tight — no air gaps. Tortilla pliable from the warmer. Cut on the bias before plating.', es: 'Enróllalo apretado — sin huecos de aire. Tortilla suave del calentador. Córtalo en diagonal antes de servir.' } },
  { name: 'Tostada Bowl', station: 'line', cook_time: 4, category: 'Modern Mexican', coach_tip: { en: 'Build cold to hot — base, protein, garnish last. Tostada shell crisp, not chewy.', es: 'Arma de frío a caliente — base, proteína, decoración al final. Tostada crujiente, no aguada.' } },
  // PLANT FORWARD
  { name: 'Superfood Ensalada', station: 'cold', cook_time: 3, category: 'Plant Forward', coach_tip: { en: 'Dress to order — never pre-dressed. Toss gently, plate high. Greens crisp.', es: 'Aderézala al momento — nunca aderezada antes. Mézclala con cuidado, monta alto. Verduras crujientes.' } },
  { name: 'Harvest Bowl', station: 'line', cook_time: 4, category: 'Plant Forward', coach_tip: { en: 'Build base first, layer toppings. Grains hot, greens cold. Plate vibrant.', es: 'Arma la base primero, luego pon los toppings. Granos calientes, verduras frías. Presentación vibrante.' } },
  // CHICKEN A LA CARTE
  { name: 'Chicken Leg', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.', es: 'Una pieza — confirma 74°C (165°F). Saca de la charola más vieja. Decora antes de que salga.' } },
  { name: 'Chicken Thigh', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.', es: 'Una pieza — confirma 74°C (165°F). Saca de la charola más vieja. Decora antes de que salga.' } },
  { name: 'Chicken Breast', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Slice on the bias if requested. Pull from oldest tray.', es: 'Una pieza — confirma 74°C (165°F). Rebana en diagonal si lo piden. Saca de la charola más vieja.' } },
  { name: 'Chicken Wing', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Crispy skin, juicy meat. Pull from oldest tray. Sauce only if requested.', es: 'Piel crujiente, carne jugosa. Saca de la charola más vieja. Salsa solo si la piden.' } },
  { name: 'Whole Bird (A La Carte)', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'No sides — bird only. Even golden color. Confirm 165°F at thickest part of the thigh.', es: 'Sin guarniciones — solo el pollo. Color dorado uniforme. Confirma 74°C (165°F) en la parte más gruesa del muslo.' } },
  // OTHER
  { name: 'Kids Quesadilla', station: 'grill', cook_time: 4, category: 'Other', coach_tip: { en: 'Cheese fully melted, tortilla golden — not pale. Cut into 4 triangles before plating.', es: 'Queso bien derretido, tortilla dorada — no pálida. Córtala en 4 triángulos antes de servir.' } },
  { name: 'Taco (Single)', station: 'line', cook_time: 3, category: 'Other', coach_tip: { en: 'Tortilla warm and pliable. Build hot to cold. Garnish last.', es: 'Tortilla caliente y suave. Arma de caliente a frío. Decora al final.' } },
  // SWEETS
  { name: 'Chocolate Chip + Sea Salt Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: 'Para llevar — confirma que la galleta está fresca, no dura. Embolsa con servilleta.' } },
  { name: 'Cookies N Cream Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: 'Para llevar — confirma que la galleta está fresca, no dura. Embolsa con servilleta.' } },
  { name: 'Confetti Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: 'Para llevar — confirma que la galleta está fresca, no dura. Embolsa con servilleta.' } },
  { name: 'Double Double Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: 'Para llevar — confirma que la galleta está fresca, no dura. Embolsa con servilleta.' } },
];

const DEFAULT_SIDES = [
  // MARKET SIDE
  { name: 'Spanish Rice', station: 'hot_hold', cook_time: 0, batch_size: 8 },
  { name: 'Kale Slaw', station: 'cold', cook_time: 0, batch_size: 8 },
  { name: 'Sweet Potatoes', station: 'hot_hold', cook_time: 0, batch_size: 6 },
  { name: 'Broccoli', station: 'hot_hold', cook_time: 0, batch_size: 6 },
  { name: 'Charro Beans', station: 'hot_hold', cook_time: 0, batch_size: 8 },
  { name: 'Mac Salad', station: 'cold', cook_time: 0, batch_size: 6 },
  // PREMIUM SIDE
  { name: 'Mexican Street Corn', station: 'grill', cook_time: 5, batch_size: 4 },
  { name: 'Chips and Guac', station: 'cold', cook_time: 0, batch_size: 6 },
  { name: 'Brussel Sprouts', station: 'oven', cook_time: 8, batch_size: 4 },
  { name: 'Green Chicken Pozole', station: 'hot_hold', cook_time: 0, batch_size: 4 },
  { name: 'Uptown Mac & Cheese', station: 'hot_hold', cook_time: 0, batch_size: 6 },
  { name: 'Buffalo Cauliflower', station: 'fryer', cook_time: 6, batch_size: 4 },
];

// Quality tips are bilingual: { en, es }. Spanish (es) is optional —
// admins fill it in via the admin UI; defaults ship English-only.
// Read-time normalization (see normalizeTip below) preserves
// backward compatibility with legacy string-array configs.
const DEFAULT_QUALITY_TIPS = [
  { en: 'Check chicken internal temp — must hit 165°F before serving.', es: 'Verifica la temperatura interna del pollo — debe llegar a 74°C (165°F) antes de servir.' },
  { en: 'Golden roast color on every bird — no pale skin leaving the pass.', es: 'Color dorado en cada pollo — nada de piel pálida saliendo del pase.' },
  { en: 'Rotate birds in the holding cabinet — oldest out first.', es: 'Rota los pollos en el calentador — primero sale el más viejo.' },
  { en: 'Salsa should be made fresh every shift — taste before service.', es: 'Haz la salsa fresca cada turno — pruébala antes del servicio.' },
  { en: 'Tortillas should be warm and pliable — check the warmer every 15 min.', es: 'Las tortillas deben estar calientes y suaves — revisa el calentador cada 15 minutos.' },
  { en: 'Portion chicken by weight — Quarter Bird is 51+ grams protein.', es: 'Porciona el pollo por peso — el Quarter Bird lleva 51+ gramos de proteína.' },
  { en: 'Rice should be fluffy, not clumped — stir and check every 20 min.', es: 'El arroz debe estar suelto, no apelmazado — revuélvelo y revisa cada 20 minutos.' },
  { en: 'Aguas frescas should be fresh-mixed — taste for sweetness balance.', es: 'Las aguas frescas deben prepararse al momento — prueba el balance de dulzor.' },
  { en: 'Wipe down the line between every 5th order — keep it clean.', es: 'Limpia la línea cada 5 órdenes — mantén todo limpio.' },
  { en: 'Market plates get 2 sides — don\'t short the guest.', es: 'Los Market Plates llevan 2 guarniciones — no le faltes al cliente.' },
  { en: 'Chips should be warm and crispy — fry in small batches.', es: 'Los chips deben estar calientes y crujientes — fríelos en tandas pequeñas.' },
  { en: 'Check guac freshness — max 2 hours in the well, then refresh.', es: 'Revisa la frescura del guacamole — máximo 2 horas en el insertable, luego cámbialo.' },
  { en: 'Kale slaw should be dressed to order — don\'t let it sit.', es: 'El kale slaw se adereza al momento — no lo dejes reposando.' },
  { en: 'Clear the bump bar every 10 minutes to keep the board accurate.', es: 'Limpia el bump bar cada 10 minutos para mantener el tablero al día.' },
  { en: 'Hot hold items max 30 minutes — toss and refresh after that.', es: 'Productos en hot hold máximo 30 minutos — tíralos y renueva después de ese tiempo.' },
  { en: 'Keep the pass clean — no clutter between expo and window.', es: 'Mantén el pase limpio — sin desorden entre expo y la ventana.' },
];

// Normalize a quality tip into the canonical { en, es } shape.
// Accepts:
//   - string                → { en: string, es: '' }   (legacy format)
//   - { en?, es? }          → { en: en || '', es: es || '' }
//   - anything else         → { en: '', es: '' }
// Used by both display (LineCoachDisplay) and admin (LineCoachAdmin)
// to keep the data shape contract in one place.
export function normalizeTip(tip) {
  if (typeof tip === 'string') return { en: tip, es: '' };
  if (tip && typeof tip === 'object') {
    return {
      en: typeof tip.en === 'string' ? tip.en : '',
      es: typeof tip.es === 'string' ? tip.es : '',
    };
  }
  return { en: '', es: '' };
}

// Normalize a menu item's build_steps (Learn mode) into an array of
// canonical { en, es } steps in assembly order. Accepts legacy plain
// strings per step; drops steps that are empty in both languages.
// Mirrored client-side in LineCoachDisplay.jsx.
export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map(normalizeTip)
    .filter((s) => (s.en && s.en.trim()) || (s.es && s.es.trim()));
}
