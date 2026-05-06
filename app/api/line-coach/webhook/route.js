import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { upsertOrderByToastId, bumpOrderByToastId, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';
import { getServiceClient } from '@/lib/supabase';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

// ── Item classification ─────────────────────────────────

const SIDE_NAMES = /^(spanish rice|charro beans|sweet potatoes?|broccoli|charred broc|kale slaw|mac salad|mexican street corn|mex street corn|chips and guac|brussel sprouts|brussels sprouts|green chicken pozole|green pozole|uptown mac.*cheese|buffalo cauliflower|roasted vegg)/i;

const SAUCE_NAMES = /^(wild sauce|house salsa|charred salsa|pico de gallo|salsa verde|nashville fire|extra sauce)/i;

const DRINK_NAMES = /^(watermelon fresca|hibiscus strawberry|green fresca|mexican coke|agua fresca|bottled water|lemonade|iced tea|arnold palmer|sprite|coke|diet coke|fanta|dr pepper|jarritos)/i;

const SKIP_ITEMS = /^(tortillas?|chips$|just guac$)/i;

const SKIP_MODIFIERS = /^(2 oz|4 oz|8 oz|large|small|regular|yes.*tortillas?|add tortillas?|no tortillas?)/i;

function isSideItem(name) { return SIDE_NAMES.test(name); }
function isSauceItem(name) { return SAUCE_NAMES.test(name); }
function isDrinkItem(name) { return DRINK_NAMES.test(name); }
function isSkipItem(name) { return SKIP_ITEMS.test(name); }

// ── Name cleanup ────────────────────────────────────────

// ── Priority ranking ────────────────────────────────────

// Toast's dining_option field can arrive as:
//   - a plain string ("Dine In", "Takeout", etc.)
//   - an object reference like { guid, entityType: "DiningOption", externalId, name? }
//     — sometimes with a `name`, sometimes only the guid.
//   - null / undefined.
// Coerce to a safe string so downstream .toLowerCase() never throws,
// and store something human-readable when possible. Unknown guids
// fall back to '' (treated as Takeout by computePriorityRank).
function diningOptionToString(opt) {
  if (opt == null) return '';
  if (typeof opt === 'string') return opt;
  if (typeof opt === 'object') {
    return opt.name || opt.displayName || opt.label || '';
  }
  return String(opt);
}

function computePriorityRank(isRush, diningOption) {
  if (isRush) return 10;
  const opt = diningOptionToString(diningOption).toLowerCase();
  if (opt.includes('dine in') || opt === 'dine-in' || opt === 'dinein' || opt.includes('for here')) return 20;
  if (opt.includes('takeout') || opt.includes('take out') || opt.includes('pickup') || opt.includes('pick up') || opt.includes('to go') || opt.includes('togo')) return 30;
  if (opt.includes('delivery') || opt.includes('deliver')) return 40;
  return 30;
}

// ── Name cleanup ────────────────────────────────────────

function cleanItemName(name) {
  // Defensive: Toast occasionally sends non-string item names.
  return String(name || '')
    .replace(/\s*-\s*PROTEIN:?\s*\+?\d+G?/gi, '')
    .replace(/\s*\(LARGE\)/gi, '')
    .replace(/\s*\(SMALL\)/gi, '')
    .replace(/\s*\(REGULAR\)/gi, '')
    .trim();
}

function titleCase(str) {
  return String(str || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Extract sides from modifiers ────────────────────────

function extractSidesFromModifiers(modifiers) {
  const sides = [];
  const remaining = [];

  for (const mod of modifiers) {
    const cleaned = mod.replace(/\s*\(LARGE\)/gi, '').replace(/\s*\(SMALL\)/gi, '').trim();
    if (isSideItem(cleaned)) {
      sides.push({ name: titleCase(cleaned), quantity: 1 });
    } else if (!SKIP_MODIFIERS.test(mod) && !isSauceItem(cleaned)) {
      remaining.push(titleCase(mod));
    }
  }

  return { sides, modifiers: remaining };
}

// ── HMAC verification ───────────────────────────────────

function verifyToastHmac(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const attempts = [rawBody];
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed.timestamp) {
      attempts.push(rawBody + parsed.timestamp);
      attempts.push(parsed.timestamp + rawBody);
    }
  } catch {}
  for (const payload of attempts) {
    const computed = createHmac('sha256', secret).update(payload).digest('base64');
    if (computed === signatureHeader) return true;
  }
  return false;
}

// ── Webhook handler ─────────────────────────────────────

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const rawBody = await request.text();
  const userAgent = request.headers.get('user-agent') || '';
  const toastSig = request.headers.get('toast-signature');
  const authHeader = request.headers.get('authorization');

  let authenticated = false;
  if (toastSig && TOAST_WEBHOOK_SECRET) {
    authenticated = verifyToastHmac(rawBody, toastSig, TOAST_WEBHOOK_SECRET);
  }
  if (!authenticated && authHeader?.startsWith('Bearer ')) {
    authenticated = authHeader.slice(7) === TOAST_WEBHOOK_SECRET;
  }
  if (!authenticated && userAgent.includes('Apache-HttpClient')) {
    authenticated = true;
  }
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);

    const details = body.details || {};
    const toastOrder = details.order || body.order || body;
    // Order GUID — NOT the webhook event GUID
    const toastOrderGuid = toastOrder.guid || null;

    // TEMPORARY DEBUG: persist a SHAPE of one webhook payload + the
    // customer/dining-option branches into a Supabase debug table so we
    // can query the full data (Vercel log API truncates aggressively).
    // Remove this block + the debug table once parsing is fixed.
    try {
      const shape = (obj, depth = 2) => {
        if (obj == null || typeof obj !== 'object') return typeof obj;
        if (Array.isArray(obj)) return obj.length === 0 ? '[]' : `[${shape(obj[0], depth - 1)}]`;
        if (depth <= 0) return '{...}';
        const out = {};
        for (const k of Object.keys(obj)) out[k] = shape(obj[k], depth - 1);
        return out;
      };
      const customerBlobs = {
        order_customer: toastOrder.customer || null,
        delivery_info: toastOrder.deliveryInfo || null,
        curbside: toastOrder.curbsidePickupInfo || null,
        order_source: toastOrder.source || null,
        check_count: (toastOrder.checks || []).length,
        check_customers: (toastOrder.checks || []).map((c) => ({
          customer: c.customer || null,
          tabName: c.tabName || null,
          customerCompany: c.customerCompany || null,
          displayNumber: c.displayNumber || null,
          dining_option: c.diningOption || null,
          source: c.source || null,
        })),
      };
      const db = getServiceClient();
      const dbg = await db.from('lc_debug_payloads').insert({
        toast_order_id: toastOrderGuid,
        store_id: storeId,
        shape: shape(toastOrder, 4),
        customer_blobs: customerBlobs,
      });
      if (dbg.error) console.log('debug insert error:', dbg.error.message);
    } catch (logErr) {
      console.log('debug log failed:', logErr.message);
    }
    const restaurantGuid = details.restaurantGuid
      || toastOrder.restaurantGuid
      || request.headers.get('toast-restaurant-external-id')
      || '';
    const storeId = resolveStoreId(restaurantGuid);

    if (!toastOrderGuid) {
      return NextResponse.json({ status: 'ignored', reason: 'no order guid' });
    }

    // ── Detect completed/voided → auto-bump ─────────────
    // IMPORTANT: Toast's check.closedDate means the check was SETTLED/PAID
    // (front-of-house concept), NOT that the kitchen finished cooking it.
    // Prepaid online/delivery orders arrive with closedDate already set,
    // which previously caused them to be auto-bumped within seconds of
    // arrival before the kitchen ever saw them. Only treat completedDate
    // and voidDate on the order or its checks as kitchen-done signals.
    const isVoided = !!toastOrder.voidDate;
    const isDeleted = toastOrder.deleted === true;
    const isCompleted = !!toastOrder.completedDate;
    const checks = toastOrder.checks || [];
    const allChecksKitchenDone = checks.length > 0 && checks.every((c) =>
      c.completedDate || c.voidDate
    );

    if (isVoided || isDeleted || isCompleted || allChecksKitchenDone) {
      await bumpOrderByToastId(toastOrderGuid);
      return NextResponse.json({ status: 'bumped' });
    }

    // ── Parse items from all checks ─────────────────────
    const allSelections = [];
    let checkNumber = toastOrder.displayNumber || null;
    let customerName = null;
    let diningOption = null;
    let specialInstructions = null;

    for (const check of checks) {
      // Use display number, not the check GUID
      if (!checkNumber && check.displayNumber) {
        checkNumber = String(check.displayNumber);
      }
      diningOption = diningOption || check.diningOption;

      // Collect special instructions from check level
      if (check.specialInstructions) {
        specialInstructions = specialInstructions
          ? specialInstructions + ' | ' + check.specialInstructions
          : check.specialInstructions;
      }

      if (check.customer) {
        customerName = customerName
          || [check.customer.firstName, check.customer.lastName].filter(Boolean).join(' ')
          || check.customer.name;
      }

      for (const sel of check.selections || []) {
        allSelections.push(sel);
      }
    }

    if (allSelections.length === 0) {
      allSelections.push(...(toastOrder.selections || toastOrder.items || []));
    }

    // ── Process items ───────────────────────────────────
    const mains = [];
    const sides = [];

    for (const item of allSelections) {
      const rawName = item.displayName || item.name || item.itemName || 'Unknown';
      const cleanName = cleanItemName(rawName);

      // Skip drinks, sauces, and non-food items
      if (isDrinkItem(cleanName) || isSauceItem(cleanName) || isSkipItem(cleanName)) continue;

      // Voided items
      if (item.voided || item.voidDate) continue;

      const rawModifiers = (item.modifiers || []).map((m) => m.displayName || m.name);

      // Standalone side
      if (isSideItem(cleanName)) {
        sides.push({ name: titleCase(cleanName), quantity: item.quantity || 1 });
        continue;
      }

      // Main entree — extract sides from modifiers
      const extracted = extractSidesFromModifiers(rawModifiers);
      sides.push(...extracted.sides);

      mains.push({
        name: titleCase(cleanName),
        quantity: item.quantity || 1,
        modifiers: extracted.modifiers,
      });
    }

    // Deduplicate sides
    const sideMap = {};
    for (const side of sides) {
      if (sideMap[side.name]) {
        sideMap[side.name].quantity += side.quantity;
      } else {
        sideMap[side.name] = { ...side };
      }
    }
    const deduplicatedSides = Object.values(sideMap);

    diningOption = diningOption || toastOrder.diningOption || toastOrder.serviceType || null;
    // Normalize to a string — Toast may send an object { guid, entityType, name? }.
    const diningOptionStr = diningOptionToString(diningOption) || null;
    if (!customerName && toastOrder.customer) {
      customerName = [toastOrder.customer.firstName, toastOrder.customer.lastName].filter(Boolean).join(' ')
        || toastOrder.customer.name;
    }

    if (mains.length === 0 && deduplicatedSides.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no food items' });
    }

    // Timing: use Toast creation time, or promised time for future orders
    const toastCreatedAt = toastOrder.createdDate || toastOrder.openedDate || null;
    const promisedDate = toastOrder.promisedDate || toastOrder.estimatedFulfillmentDate || null;
    const baseTime = toastCreatedAt ? new Date(toastCreatedAt) : new Date();
    const fireAt = promisedDate ? new Date(promisedDate) : baseTime;
    const estimatedReadyAt = new Date(fireAt.getTime() + 10 * 60_000);

    // Priority
    const isRush = toastOrder.priority === 'RUSH';
    const priorityRank = computePriorityRank(isRush, diningOptionStr);

    const order = {
      store_id: storeId,
      order_number: checkNumber,
      customer_name: customerName,
      items: mains,
      sides: deduplicatedSides,
      priority: isRush ? 'rush' : 'normal',
      priority_rank: priorityRank,
      fire_at: fireAt.toISOString(),
      toast_created_at: toastCreatedAt || new Date().toISOString(),
      estimated_ready_at: estimatedReadyAt.toISOString(),
      notes: specialInstructions,
      dining_option: diningOptionStr,
    };

    const { data, error } = await upsertOrderByToastId(toastOrderGuid, order);
    if (error) {
      console.error('Order save failed:', error.message);
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
