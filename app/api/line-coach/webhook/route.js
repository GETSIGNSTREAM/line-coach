import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { upsertOrderByToastId, bumpOrderByToastId, resolveStoreId, logWebhook, getConfig, isWithinServiceWindow } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';
import { canonicalSideName } from '@/lib/side-canonical';

function clientIp(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || null;
}

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

// ── Customer name extraction ────────────────────────────
//
// Toast does not consistently send a customer.firstName/lastName for
// in-store or delivery-app orders. The customer name (or initial) lives
// in `check.tabName` with provider-specific prefixes:
//   "Y"                          → in-store, cashier typed an initial
//   "CARDHOLDER, VISA"           → in-store paid by card, no name typed
//   "DD 264b82f9 Alosha R"       → DoorDash, "Alosha R" is the customer
//   "DD 7e465e72 PickUp-Sean J"  → DoorDash pickup, "Sean J"
//   "  UBER144F8 Carson H.  "    → UberEats, "Carson H."
//   "GH abc12345 Jordan M"       → Grubhub (assumed pattern; same family)
//
// parseCustomerName strips the courier prefix and identifier and returns
// just the human-readable name, or null if there isn't one to show.
const COURIER_PREFIX_RE = /^\s*(?:DD|UBER(?:EATS)?|GH|GRUBHUB|POSTMATES)[\s_]*[a-f0-9]{4,}[\s_-]*(?:PickUp[-\s])?/i;
const CARDHOLDER_RE = /^\s*CARDHOLDER\b/i;

function parseCustomerName(tabName) {
  if (!tabName || typeof tabName !== 'string') return null;
  let s = tabName.trim();
  if (!s) return null;
  // Card placeholder — never a real name.
  if (CARDHOLDER_RE.test(s)) return null;
  // Strip courier ID prefix if present.
  const stripped = s.replace(COURIER_PREFIX_RE, '').trim();
  if (stripped) s = stripped;
  // Strip courier SUFFIX too (Grubhub uses "<Name> Grubhub #<id>"
  // unlike DD/UberEats which use a prefix). Match here so the
  // customer name is clean regardless of channel.
  s = s.replace(/\s+Grubhub\s+#\S+\s*$/i, '').trim();
  // Tidy any leftover whitespace runs.
  s = s.replace(/\s+/g, ' ').trim();
  // Reject pure single-letter / very short non-courier values? Keep them.
  // The kitchen will see "Y" for walk-ins where that's all the cashier
  // typed — that's still useful (matches their receipt).
  return s || null;
}

// Detect the third-party channel an order came through by inspecting
// Toast's check.tabName, which carries channel signals BEFORE
// parseCustomerName strips them. Run this on every check before the
// customer-name parse so we capture the channel even when the prefix
// is about to be erased.
//
// Patterns observed in 7 days of production data (8,469 webhooks):
//   DoorDash:  "DD <8-hex> <Name>" or "DD <id> PickUp-<Name>"
//   UberEats:  "  UBER<5-hex> <Name>.  " (whitespace-padded)
//   Grubhub:   "<Name> Grubhub #<numeric-id>" (suffix, not prefix)
//   Postmates: "POSTMATES<id> <Name>" (not observed in 7d but pre-mapped)
//   ChowNow:   pattern unknown; left out until we see one
//   In-store:  null / single letter / first name / "CARDHOLDER, VISA"
//
// Returns one of:
//   'doordash' | 'ubereats' | 'grubhub' | 'postmates' | 'in_store' | null
// null means "we couldn't classify this one" — render no badge rather
// than guess wrong.
function parseOrderChannel(tabName) {
  if (!tabName || typeof tabName !== 'string') return null;
  const s = tabName.trim();
  if (!s) return null;
  // CARDHOLDER + null both mean in-store; we treat them the same way.
  if (CARDHOLDER_RE.test(s)) return 'in_store';
  if (/^DD[\s_]+[a-f0-9]{4,}/i.test(s)) return 'doordash';
  if (/^UBER(?:EATS)?[\s_]*[a-f0-9]{4,}/i.test(s)) return 'ubereats';
  if (/\sGrubhub\s+#\S+\s*$/i.test(s)) return 'grubhub';
  if (/^GH[\s_]+[a-f0-9]{4,}/i.test(s)) return 'grubhub';
  if (/^POSTMATES[\s_]*[a-f0-9]{4,}/i.test(s)) return 'postmates';
  // Anything else (first name, single letter, etc.) → in-store walk-up.
  // We deliberately classify rather than return null so the column
  // distinguishes "we tried and it's in-store" from "we haven't run
  // the parser yet on this row."
  return 'in_store';
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

// Modifiers attached to an entree (e.g. "Spanish Rice", "Charred
// Brocolli"). For each that's a known side, we push it to the sides
// array with the parent entree's quantity — so a Protein Plate with
// quantity=3 and modifier "Spanish Rice" yields 3x Spanish Rice for
// the kitchen, not 1.
//
// Side names are normalized to their CANONICAL form (see
// lib/side-canonical.js) so "Charred Brocolli", "Charred Brocoll", and
// "Broccoli" all aggregate together in batching.
function extractSidesFromModifiers(modifiers, entreeQuantity = 1) {
  const sides = [];
  const remaining = [];
  const qty = Math.max(1, parseInt(entreeQuantity, 10) || 1);

  for (const mod of modifiers) {
    const cleaned = mod.replace(/\s*\(LARGE\)/gi, '').replace(/\s*\(SMALL\)/gi, '').trim();
    if (isSideItem(cleaned)) {
      const canonical = canonicalSideName(cleaned) || titleCase(cleaned);
      sides.push({ name: canonical, quantity: qty });
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
  const start = Date.now();
  const ip = clientIp(request);

  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) {
    logWebhook({ status: 'rate_limited', http_status: 429, ip, duration_ms: Date.now() - start });
    return rlRes;
  }

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
    logWebhook({ status: 'unauthorized', http_status: 401, ip, duration_ms: Date.now() - start, error_message: 'Missing or invalid HMAC/bearer' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);

    const details = body.details || {};
    const toastOrder = details.order || body.order || body;
    // Order GUID — NOT the webhook event GUID
    const toastOrderGuid = toastOrder.guid || null;
    const restaurantGuid = details.restaurantGuid
      || toastOrder.restaurantGuid
      || request.headers.get('toast-restaurant-external-id')
      || '';
    const storeId = resolveStoreId(restaurantGuid);

    if (!toastOrderGuid) {
      logWebhook({ store_id: storeId, status: 'ignored', http_status: 200, ip, payload: body, duration_ms: Date.now() - start, error_message: 'no order guid' });
      return NextResponse.json({ status: 'ignored', reason: 'no order guid' });
    }

    // ── Service-hours guard ─────────────────────────────
    // Toast retries late-night webhooks and pushes through orders
    // placed seconds before close, both of which create phantoms in
    // lc_orders for kitchens that are already shut down. Skip insert/
    // bump entirely outside [open, close + 15 min] for the resolved
    // store. We still log to lc_webhook_log so the admin can see what
    // got dropped. Returns 200 so Toast doesn't retry the dropped
    // webhook into a tight loop.
    try {
      const { data: storeCfg } = await getConfig(storeId);
      const hoursMap = storeCfg?.service_hours || {};
      if (!isWithinServiceWindow(hoursMap, storeId)) {
        logWebhook({
          store_id: storeId,
          status: 'ignored',
          http_status: 200,
          event_type: 'closed_hours',
          toast_order_id: toastOrderGuid,
          ip,
          payload: body,
          duration_ms: Date.now() - start,
          error_message: 'outside service hours',
        });
        return NextResponse.json({ status: 'ok', reason: 'closed' });
      }
    } catch (cfgErr) {
      // Fail-open: a config-load error must never silently drop real
      // service traffic. Log and continue.
      console.error('service-hours guard config load failed:', cfgErr.message);
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

    // closedDate (paid/settled) is a payment signal, not a kitchen-done
    // signal — but Toast almost never sends completedDate/voidDate
    // through the webhook for in-house bumps, so without this fallback
    // ~99% of orders never get auto-bumped and Line Coach accumulates
    // phantoms. The 5-min cushion preserves the original concern about
    // prepaid orders (paid != cooked) while still recovering the auto-
    // bump signal Toast does reliably send.
    const CLOSED_DATE_GRACE_MS = 5 * 60_000;
    const checkClosedAges = checks
      .map((c) => (c.closedDate ? Date.now() - new Date(c.closedDate).getTime() : null))
      .filter((v) => v !== null);
    const allChecksClosedPastGrace = checks.length > 0
      && checkClosedAges.length === checks.length
      && checkClosedAges.every((age) => age > CLOSED_DATE_GRACE_MS);

    if (isVoided || isDeleted || isCompleted || allChecksKitchenDone || allChecksClosedPastGrace) {
      await bumpOrderByToastId(toastOrderGuid);
      const eventType = allChecksClosedPastGrace && !isVoided && !isDeleted && !isCompleted && !allChecksKitchenDone
        ? 'bump_closed_grace'
        : 'bump';
      logWebhook({ store_id: storeId, status: 'ok', http_status: 200, event_type: eventType, toast_order_id: toastOrderGuid, ip, payload: body, duration_ms: Date.now() - start });
      return NextResponse.json({ status: 'bumped' });
    }

    // ── Parse items from all checks ─────────────────────
    const allSelections = [];
    let checkNumber = toastOrder.displayNumber || null;
    let customerName = null;
    let diningOption = null;
    let specialInstructions = null;
    // Order channel is extracted from check.tabName BEFORE the
    // courier prefix is stripped by parseCustomerName. First non-null
    // classification across checks wins. Falls back to 'in_store'
    // when checks exist but no channel was identifiable.
    let orderChannel = null;

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

      // Channel detection happens FIRST so the prefix is still
      // intact when we read it. Prefer the first delivery-courier
      // classification; only fall back to in_store at the end.
      if (!orderChannel || orderChannel === 'in_store') {
        const ch = parseOrderChannel(check.tabName);
        // Prefer a courier channel over a previous in_store guess
        // (a multi-check order can mix in-store + delivery; the
        // delivery signal is the one cooks need to see).
        if (ch && ch !== 'in_store') orderChannel = ch;
        else if (!orderChannel && ch) orderChannel = ch;
      }

      if (!customerName && check.customer) {
        customerName = [check.customer.firstName, check.customer.lastName].filter(Boolean).join(' ')
          || check.customer.name
          || null;
      }
      // Fallback: many real Toast payloads ship the customer name only
      // inside check.tabName, with courier prefixes for delivery apps.
      if (!customerName) {
        customerName = parseCustomerName(check.tabName);
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
      const itemQty = Math.max(1, parseInt(item.quantity, 10) || 1);

      // Standalone side
      if (isSideItem(cleanName)) {
        const canonical = canonicalSideName(cleanName) || titleCase(cleanName);
        sides.push({ name: canonical, quantity: itemQty });
        continue;
      }

      // Main entree — extract sides from modifiers, multiplying each
      // by the parent entree's quantity so the kitchen sees the
      // correct count for batching.
      const extracted = extractSidesFromModifiers(rawModifiers, itemQty);
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
      logWebhook({ store_id: storeId, status: 'ignored', http_status: 200, toast_order_id: toastOrderGuid, ip, payload: body, duration_ms: Date.now() - start, error_message: 'no food items' });
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
      order_channel: orderChannel,
    };

    const { data, error } = await upsertOrderByToastId(toastOrderGuid, order);
    if (error) {
      console.error('Order save failed:', error.message);
      logWebhook({ store_id: storeId, status: 'insert_error', http_status: 500, toast_order_id: toastOrderGuid, ip, payload: body, duration_ms: Date.now() - start, error_message: error.message });
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    logWebhook({ store_id: storeId, status: 'ok', http_status: 200, toast_order_id: toastOrderGuid, order_id: data.id, ip, payload: body, duration_ms: Date.now() - start });
    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook error:', err.message);
    logWebhook({ status: 'parse_error', http_status: 400, ip, duration_ms: Date.now() - start, error_message: err.message });
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
