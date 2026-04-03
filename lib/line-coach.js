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
  { name: 'Classic Smash Burger', station: 'grill', cook_time: 6 },
  { name: 'Double Smash Burger', station: 'grill', cook_time: 7 },
  { name: 'Crispy Chicken Sandwich', station: 'fryer', cook_time: 8 },
  { name: 'Grilled Chicken Sandwich', station: 'grill', cook_time: 9 },
  { name: 'Nashville Hot Chicken', station: 'fryer', cook_time: 8 },
  { name: 'Veggie Burger', station: 'grill', cook_time: 6 },
  { name: 'Chicken Tenders', station: 'fryer', cook_time: 7 },
  { name: 'Fish Sandwich', station: 'fryer', cook_time: 8 },
  { name: 'Hot Dog', station: 'grill', cook_time: 5 },
];

const DEFAULT_SIDES = [
  { name: 'French Fries', station: 'fryer', cook_time: 4, batch_size: 4 },
  { name: 'Onion Rings', station: 'fryer', cook_time: 4, batch_size: 3 },
  { name: 'Sweet Potato Fries', station: 'fryer', cook_time: 5, batch_size: 4 },
  { name: 'Mac & Cheese', station: 'hot_hold', cook_time: 0, batch_size: 8 },
  { name: 'Coleslaw', station: 'cold', cook_time: 0, batch_size: 8 },
  { name: 'Side Salad', station: 'cold', cook_time: 0, batch_size: 6 },
  { name: 'Loaded Fries', station: 'fryer', cook_time: 5, batch_size: 3 },
  { name: 'Tater Tots', station: 'fryer', cook_time: 4, batch_size: 4 },
  { name: 'Corn on the Cob', station: 'grill', cook_time: 6, batch_size: 4 },
  { name: 'Pickles & Peppers', station: 'cold', cook_time: 0, batch_size: 10 },
];

const DEFAULT_QUALITY_TIPS = [
  'Check burger patty thickness — should be ¼ inch before pressing.',
  'Buns should be toasted golden, not pale or charred.',
  'Fry oil temp should be 350°F — check every 30 minutes.',
  'Lettuce and tomato should be prepped fresh every 2 hours.',
  'Wipe down the flat top between every 5th order.',
  'Check chicken internal temp — must hit 165°F.',
  'Shake the fry basket twice during cooking for even crispness.',
  'Sauce portions: 1 oz squeeze per sandwich, 2 oz for dipping.',
  'Wrap sandwiches tightly — no air gaps in the foil.',
  'Stack burgers: bottom bun → sauce → patty → cheese → toppings → top bun.',
  'Clear the bump bar every 10 minutes to keep the board accurate.',
  'Rotate stock: first in, first out for all proteins.',
  'Clean the thermometer probe between uses — food safety first.',
  'Side containers should be filled to the line, not over.',
  'Hot hold items max 30 minutes — toss and refresh after that.',
  'Keep the pass clean — no clutter between expo and window.',
];
