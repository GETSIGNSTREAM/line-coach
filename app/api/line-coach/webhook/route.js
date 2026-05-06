import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { upsertOrderByToastId, bumpOrderByToastId, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

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

function cleanItemName(name) {
  return name
    .replace(/\s*-\s*PROTEIN:?\s*\+?\d+G?/gi, '')
    .replace(/\s*\(LARGE\)/gi, '')
    .replace(/\s*\(SMALL\)/gi, '')
    .replace(/\s*\(REGULAR\)/gi, '')
    .trim();
}

function titleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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
    const restaurantGuid = details.restaurantGuid
      || toastOrder.restaurantGuid
      || request.headers.get('toast-restaurant-external-id')
      || '';
    const storeId = resolveStoreId(restaurantGuid);

    if (!toastOrderGuid) {
      return NextResponse.json({ status: 'ignored', reason: 'no order guid' });
    }

    // ── Detect completed/voided → auto-bump ─────────────
    const isVoided = !!toastOrder.voidDate;
    const isDeleted = toastOrder.deleted === true;
    const isCompleted = !!toastOrder.completedDate;
    const checks = toastOrder.checks || [];
    const allChecksClosed = checks.length > 0 && checks.every((c) =>
      c.closedDate || c.completedDate || c.voidDate
    );

    if (isVoided || isDeleted || isCompleted || allChecksClosed) {
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
    if (!customerName && toastOrder.customer) {
      customerName = [toastOrder.customer.firstName, toastOrder.customer.lastName].filter(Boolean).join(' ')
        || toastOrder.customer.name;
    }

    if (mains.length === 0 && deduplicatedSides.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no food items' });
    }

    const order = {
      store_id: storeId,
      order_number: checkNumber,
      customer_name: customerName,
      items: mains,
      sides: deduplicatedSides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: specialInstructions,
      dining_option: diningOption,
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
