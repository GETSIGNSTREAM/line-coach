import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { insertOrder, upsertOrderByToastId, bumpOrderByToastId, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

// ── Side and sauce detection ────────────────────────────

const SIDE_NAMES = /^(spanish rice|charro beans|sweet potatoes?|broccoli|charred broc|kale slaw|mac salad|mexican street corn|mex street corn|chips and guac|brussel sprouts|brussels sprouts|green chicken pozole|green pozole|uptown mac.*cheese|buffalo cauliflower|roasted vegg)/i;

const SAUCE_NAMES = /^(wild sauce|house salsa|charred salsa|pico de gallo|salsa verde|nashville fire|extra sauce)/i;

const SKIP_MODIFIERS = /^(2 oz|4 oz|large|small|yes.*tortillas?|add tortillas?|no tortillas?)/i;

function isSideItem(name) {
  return SIDE_NAMES.test(name);
}

function isSauceItem(name) {
  return SAUCE_NAMES.test(name);
}

// ── Name cleanup ────────────────────────────────────────

function cleanItemName(name) {
  return name
    .replace(/\s*-\s*PROTEIN:?\s*\+?\d+G?/gi, '')  // Remove "- PROTEIN: +139G"
    .replace(/\s*\(LARGE\)/gi, '')                    // Remove "(LARGE)"
    .replace(/\s*\(SMALL\)/gi, '')                    // Remove "(SMALL)"
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
    const toastOrderGuid = toastOrder.guid || body.guid || null;
    const restaurantGuid = details.restaurantGuid
      || toastOrder.restaurantGuid
      || request.headers.get('toast-restaurant-external-id')
      || '';
    const storeId = resolveStoreId(restaurantGuid);

    // ── Detect completed/voided orders → auto-bump ──────
    const isVoided = !!toastOrder.voidDate;
    const isDeleted = toastOrder.deleted === true;
    const isCompleted = !!toastOrder.completedDate;

    // Check if all checks are closed (all items fulfilled on KDS)
    const checks = toastOrder.checks || [];
    const allChecksClosed = checks.length > 0 && checks.every((c) =>
      c.closedDate || c.completedDate || c.voidDate
    );

    if ((isVoided || isDeleted || isCompleted || allChecksClosed) && toastOrderGuid) {
      const { data: bumped } = await bumpOrderByToastId(toastOrderGuid);
      if (bumped && bumped.length > 0) {
        return NextResponse.json({ status: 'bumped', count: bumped.length });
      }
      return NextResponse.json({ status: 'ignored', reason: 'completed/voided, not in system' });
    }

    // ── Parse order items ───────────────────────────────
    const allSelections = [];
    let checkNumber = toastOrder.displayNumber || null;
    let customerName = null;
    let diningOption = null;
    let specialInstructions = null;

    for (const check of checks) {
      checkNumber = checkNumber || check.displayNumber;
      diningOption = diningOption || check.diningOption;
      specialInstructions = specialInstructions || check.specialInstructions;
      if (check.customer) {
        customerName = customerName || check.customer.firstName || check.customer.name;
      }
      for (const sel of check.selections || []) {
        allSelections.push(sel);
      }
    }

    if (allSelections.length === 0) {
      allSelections.push(...(toastOrder.selections || toastOrder.items || []));
    }

    // Process items: separate mains, sides, and sauces
    const mains = [];
    const sides = [];

    for (const item of allSelections) {
      const rawName = item.displayName || item.name || item.itemName || 'Unknown';
      const cleanName = cleanItemName(rawName);
      const rawModifiers = (item.modifiers || []).map((m) => m.displayName || m.name);

      if (isSauceItem(cleanName)) continue;

      if (isSideItem(cleanName)) {
        sides.push({ name: titleCase(cleanName), quantity: item.quantity || 1 });
        continue;
      }

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
      customerName = toastOrder.customer.firstName || toastOrder.customer.name;
    }

    const order = {
      store_id: storeId,
      order_number: checkNumber,
      customer_name: customerName,
      items: mains,
      sides: deduplicatedSides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: specialInstructions || toastOrder.specialInstructions || null,
      dining_option: diningOption,
    };

    if (mains.length === 0 && deduplicatedSides.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no items' });
    }

    // Upsert: update existing order or insert new one
    const { data, error } = toastOrderGuid
      ? await upsertOrderByToastId(toastOrderGuid, order)
      : await insertOrder(order);

    if (error) {
      console.error('Order save failed:', error.message);
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook parse error:', err.message);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
