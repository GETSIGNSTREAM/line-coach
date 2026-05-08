import { getServiceClient, withRetry } from './supabase.js';

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

// ── Config ──────────────────────────────────────────────
// Brand-wide fields (menu_items, sides, quality_tips, hold_times) live
// in lc_brand_config (single row). Per-store fields (just `settings`)
// live in lc_config keyed by store_id. getConfig merges both so callers
// see one combined object.
//
// Brand cache: 60s in-memory. Invalidated on any brand mutation.

const BRAND_CACHE_TTL_MS = 60_000;
let _brandCache = null; // { data, expiresAt }

const BRAND_FIELDS = ['menu_items', 'sides', 'quality_tips', 'hold_times'];

function brandDefaults() {
  return {
    menu_items: DEFAULT_MENU_ITEMS,
    sides: DEFAULT_SIDES,
    quality_tips: DEFAULT_QUALITY_TIPS,
    hold_times: { fire_now: 5, staging: 15, on_deck: 30 },
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
    hold_times: data.hold_times || { fire_now: 5, staging: 15, on_deck: 30 },
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
  const [brand, storeRow] = await Promise.all([
    getBrandConfig(),
    withRetry(() => db.from('lc_config').select('settings').eq('store_id', storeId).maybeSingle()),
  ]);

  const settings = {
    quality_coach_interval: 30,
    side_batch_threshold: 3,
    ...(storeRow.data?.settings || {}),
  };

  return {
    data: {
      store_id: storeId,
      ...brand,
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

// ── Seed Data Defaults ──────────────────────────────────

// Each menu item supports an optional bilingual coach_tip { en, es } that
// is shown in focus mode (Display when only 1 order is on the board).
// Empty es means English-only is rendered. The display falls back to
// the store-level quality_tips when an item has no coach_tip.
const DEFAULT_MENU_ITEMS = [
  // BETTER CHICKEN
  { name: 'Quarter Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.', es: '' } },
  { name: 'Half Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.', es: '' } },
  { name: 'Whole Bird', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Whole bird presentation — even golden color, breast-up. Confirm 165°F at thickest part of the thigh.', es: '' } },
  { name: 'Chicken Dinner Box', station: 'oven', cook_time: 0, category: 'Better Chicken', coach_tip: { en: 'Pack hot items together, cold items separate. Tortillas warm and pliable, salsa fresh.', es: '' } },
  { name: 'Protein Plate', station: 'line', cook_time: 3, category: 'Better Chicken', coach_tip: { en: 'Portion chicken by weight — 51+ grams protein. Two sides, no shorting the guest.', es: '' } },
  // MARKET PLATE
  { name: 'Boneless Breast Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Boneless breast: even slice, juicy. Two sides per plate. Garnish before it leaves the pass.', es: '' } },
  { name: 'Chicken Tinga Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Tinga should be saucy, not dry. Taste the salsa before plating. Two sides per plate.', es: '' } },
  { name: 'Veggie Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'No protein on this plate — double-check before firing. Two sides, full portion.', es: '' } },
  { name: 'Pollo Verde Market Plate', station: 'line', cook_time: 4, category: 'Market Plate', coach_tip: { en: 'Verde should be bright green, not muddy. Taste before plating. Two sides per plate.', es: '' } },
  // MODERN MEXICAN
  { name: 'Tacos Dorados', station: 'fryer', cook_time: 5, category: 'Modern Mexican', coach_tip: { en: 'Fry oil at 350°F — golden and crisp, not greasy. Plate immediately, no sitting.', es: '' } },
  { name: 'Burrito Mexicano', station: 'line', cook_time: 4, category: 'Modern Mexican', coach_tip: { en: 'Wrap tight — no air gaps. Tortilla pliable from the warmer. Cut on the bias before plating.', es: '' } },
  { name: 'Tostada Bowl', station: 'line', cook_time: 4, category: 'Modern Mexican', coach_tip: { en: 'Build cold to hot — base, protein, garnish last. Tostada shell crisp, not chewy.', es: '' } },
  // PLANT FORWARD
  { name: 'Superfood Ensalada', station: 'cold', cook_time: 3, category: 'Plant Forward', coach_tip: { en: 'Dress to order — never pre-dressed. Toss gently, plate high. Greens crisp.', es: '' } },
  { name: 'Harvest Bowl', station: 'line', cook_time: 4, category: 'Plant Forward', coach_tip: { en: 'Build base first, layer toppings. Grains hot, greens cold. Plate vibrant.', es: '' } },
  // CHICKEN A LA CARTE
  { name: 'Chicken Leg', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.', es: '' } },
  { name: 'Chicken Thigh', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.', es: '' } },
  { name: 'Chicken Breast', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Single piece — confirm 165°F. Slice on the bias if requested. Pull from oldest tray.', es: '' } },
  { name: 'Chicken Wing', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'Crispy skin, juicy meat. Pull from oldest tray. Sauce only if requested.', es: '' } },
  { name: 'Whole Bird (A La Carte)', station: 'oven', cook_time: 0, category: 'A La Carte', coach_tip: { en: 'No sides — bird only. Even golden color. Confirm 165°F at thickest part of the thigh.', es: '' } },
  // OTHER
  { name: 'Kids Quesadilla', station: 'grill', cook_time: 4, category: 'Other', coach_tip: { en: 'Cheese fully melted, tortilla golden — not pale. Cut into 4 triangles before plating.', es: '' } },
  { name: 'Taco (Single)', station: 'line', cook_time: 3, category: 'Other', coach_tip: { en: 'Tortilla warm and pliable. Build hot to cold. Garnish last.', es: '' } },
  // SWEETS
  { name: 'Chocolate Chip + Sea Salt Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: '' } },
  { name: 'Cookies N Cream Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: '' } },
  { name: 'Confetti Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: '' } },
  { name: 'Double Double Cookie', station: 'grab', cook_time: 0, category: 'Sweets', coach_tip: { en: 'Grab and go — confirm cookie is fresh, not stale. Bag with napkin.', es: '' } },
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
  { en: 'Check chicken internal temp — must hit 165°F before serving.', es: '' },
  { en: 'Golden roast color on every bird — no pale skin leaving the pass.', es: '' },
  { en: 'Rotate birds in the holding cabinet — oldest out first.', es: '' },
  { en: 'Salsa should be made fresh every shift — taste before service.', es: '' },
  { en: 'Tortillas should be warm and pliable — check the warmer every 15 min.', es: '' },
  { en: 'Portion chicken by weight — Quarter Bird is 51+ grams protein.', es: '' },
  { en: 'Rice should be fluffy, not clumped — stir and check every 20 min.', es: '' },
  { en: 'Aguas frescas should be fresh-mixed — taste for sweetness balance.', es: '' },
  { en: 'Wipe down the line between every 5th order — keep it clean.', es: '' },
  { en: 'Market plates get 2 sides — don\'t short the guest.', es: '' },
  { en: 'Chips should be warm and crispy — fry in small batches.', es: '' },
  { en: 'Check guac freshness — max 2 hours in the well, then refresh.', es: '' },
  { en: 'Kale slaw should be dressed to order — don\'t let it sit.', es: '' },
  { en: 'Clear the bump bar every 10 minutes to keep the board accurate.', es: '' },
  { en: 'Hot hold items max 30 minutes — toss and refresh after that.', es: '' },
  { en: 'Keep the pass clean — no clutter between expo and window.', es: '' },
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
