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

export async function getConfig(storeId) {
  const db = getServiceClient();
  const { data, error } = await withRetry(() =>
    db.from('lc_config')
      .select('*')
      .eq('store_id', storeId)
      .single()
  );

  if (error && error.code === 'PGRST116') {
    // No config row — return defaults
    return { data: getDefaultConfig(storeId), error: null };
  }
  return { data, error };
}

export async function updateConfig(storeId, config) {
  const db = getServiceClient();
  return withRetry(() =>
    db.from('lc_config')
      .upsert({ store_id: storeId, ...config, updated_at: new Date().toISOString() })
      .select()
      .single()
  );
}

function getDefaultConfig(storeId) {
  return {
    store_id: storeId,
    menu_items: DEFAULT_MENU_ITEMS,
    sides: DEFAULT_SIDES,
    quality_tips: DEFAULT_QUALITY_TIPS,
    hold_times: { fire_now: 5, staging: 15, on_deck: 30 },
    settings: { quality_coach_interval: 30, side_batch_threshold: 3 },
  };
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

// ── Seed Data Defaults ──────────────────────────────────

const DEFAULT_MENU_ITEMS = [
  // BETTER CHICKEN
  { name: 'Quarter Bird', station: 'oven', cook_time: 0, category: 'Better Chicken' },
  { name: 'Half Bird', station: 'oven', cook_time: 0, category: 'Better Chicken' },
  { name: 'Whole Bird', station: 'oven', cook_time: 0, category: 'Better Chicken' },
  { name: 'Chicken Dinner Box', station: 'oven', cook_time: 0, category: 'Better Chicken' },
  { name: 'Protein Plate', station: 'line', cook_time: 3, category: 'Better Chicken' },
  // MARKET PLATE
  { name: 'Boneless Breast Market Plate', station: 'line', cook_time: 4, category: 'Market Plate' },
  { name: 'Chicken Tinga Market Plate', station: 'line', cook_time: 4, category: 'Market Plate' },
  { name: 'Veggie Market Plate', station: 'line', cook_time: 4, category: 'Market Plate' },
  { name: 'Pollo Verde Market Plate', station: 'line', cook_time: 4, category: 'Market Plate' },
  // MODERN MEXICAN
  { name: 'Tacos Dorados', station: 'fryer', cook_time: 5, category: 'Modern Mexican' },
  { name: 'Burrito Mexicano', station: 'line', cook_time: 4, category: 'Modern Mexican' },
  { name: 'Tostada Bowl', station: 'line', cook_time: 4, category: 'Modern Mexican' },
  // PLANT FORWARD
  { name: 'Superfood Ensalada', station: 'cold', cook_time: 3, category: 'Plant Forward' },
  { name: 'Harvest Bowl', station: 'line', cook_time: 4, category: 'Plant Forward' },
  // CHICKEN A LA CARTE
  { name: 'Chicken Leg', station: 'oven', cook_time: 0, category: 'A La Carte' },
  { name: 'Chicken Thigh', station: 'oven', cook_time: 0, category: 'A La Carte' },
  { name: 'Chicken Breast', station: 'oven', cook_time: 0, category: 'A La Carte' },
  { name: 'Chicken Wing', station: 'oven', cook_time: 0, category: 'A La Carte' },
  { name: 'Whole Bird (A La Carte)', station: 'oven', cook_time: 0, category: 'A La Carte' },
  // OTHER
  { name: 'Kids Quesadilla', station: 'grill', cook_time: 4, category: 'Other' },
  { name: 'Taco (Single)', station: 'line', cook_time: 3, category: 'Other' },
  // SWEETS
  { name: 'Chocolate Chip + Sea Salt Cookie', station: 'grab', cook_time: 0, category: 'Sweets' },
  { name: 'Cookies N Cream Cookie', station: 'grab', cook_time: 0, category: 'Sweets' },
  { name: 'Confetti Cookie', station: 'grab', cook_time: 0, category: 'Sweets' },
  { name: 'Double Double Cookie', station: 'grab', cook_time: 0, category: 'Sweets' },
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

const DEFAULT_QUALITY_TIPS = [
  'Check chicken internal temp — must hit 165°F before serving.',
  'Golden roast color on every bird — no pale skin leaving the pass.',
  'Rotate birds in the holding cabinet — oldest out first.',
  'Salsa should be made fresh every shift — taste before service.',
  'Tortillas should be warm and pliable — check the warmer every 15 min.',
  'Portion chicken by weight — Quarter Bird is 51+ grams protein.',
  'Rice should be fluffy, not clumped — stir and check every 20 min.',
  'Aguas frescas should be fresh-mixed — taste for sweetness balance.',
  'Wipe down the line between every 5th order — keep it clean.',
  'Market plates get 2 sides — don\'t short the guest.',
  'Chips should be warm and crispy — fry in small batches.',
  'Check guac freshness — max 2 hours in the well, then refresh.',
  'Kale slaw should be dressed to order — don\'t let it sit.',
  'Clear the bump bar every 10 minutes to keep the board accurate.',
  'Hot hold items max 30 minutes — toss and refresh after that.',
  'Keep the pass clean — no clutter between expo and window.',
];
