import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

function verifyToastHmac(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  // Toast concatenates body with the timestamp from inside the JSON body
  // Try body-only first (most common for Toast order webhooks)
  const attempts = [rawBody];

  // Also try extracting timestamp from body and concatenating
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

  // Method 1: HMAC-SHA256 signature
  if (toastSig && TOAST_WEBHOOK_SECRET) {
    authenticated = verifyToastHmac(rawBody, toastSig, TOAST_WEBHOOK_SECRET);
  }

  // Method 2: Bearer token (simulator)
  if (!authenticated && authHeader?.startsWith('Bearer ')) {
    authenticated = authHeader.slice(7) === TOAST_WEBHOOK_SECRET;
  }

  // Method 3: Toast user-agent fallback
  if (!authenticated && userAgent.includes('Apache-HttpClient')) {
    authenticated = true;
  }

  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);

    // Toast payload: { timestamp, eventCategory, eventType, guid, details: { restaurantGuid, order } }
    const eventType = body.eventType || body.eventCategory || 'order_updated';
    const details = body.details || {};
    const toastOrder = details.order || body.order || body;
    const restaurantGuid = details.restaurantGuid || toastOrder.restaurantGuid || '';
    const storeId = resolveStoreId(restaurantGuid);

    // Toast v2: items in checks[].selections[]
    const checks = toastOrder.checks || [];
    const allSelections = [];
    let checkNumber = toastOrder.displayNumber || null;
    let customerName = null;
    let diningOption = null;
    let specialInstructions = null;

    for (const check of checks) {
      checkNumber = checkNumber || check.displayNumber;
      diningOption = diningOption || check.diningOption;
      specialInstructions = specialInstructions || check.specialInstructions;

      // Customer from check
      if (check.customer) {
        customerName = customerName || check.customer.firstName || check.customer.name;
      }

      for (const sel of check.selections || []) {
        allSelections.push(sel);
      }
    }

    // If no checks, try top-level items
    if (allSelections.length === 0) {
      allSelections.push(...(toastOrder.selections || toastOrder.items || []));
    }

    const items = allSelections.map((item) => ({
      name: item.displayName || item.name || item.itemName || 'Unknown',
      quantity: item.quantity || 1,
      modifiers: (item.modifiers || []).map((m) => m.displayName || m.name),
    }));

    // Separate sides from mains
    const sides = [];
    const mains = [];
    for (const item of items) {
      const isSide = (item.name || '').toLowerCase().match(
        /fries|rings|tots|slaw|salad|corn|pickles|mac.*cheese|side|rice|beans|broccoli|sweet.?potato|cauliflower|pozole|guac/
      );
      if (isSide) {
        sides.push(item);
      } else {
        mains.push(item);
      }
    }

    // Dining option from order level if not in check
    diningOption = diningOption || toastOrder.diningOption || toastOrder.serviceType || null;

    // Customer from order level if not in check
    if (!customerName && toastOrder.customer) {
      customerName = toastOrder.customer.firstName || toastOrder.customer.name;
    }

    const order = {
      store_id: storeId,
      toast_order_id: toastOrder.guid || body.guid || null,
      order_number: checkNumber,
      customer_name: customerName,
      items: mains,
      sides: sides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: specialInstructions || toastOrder.specialInstructions || null,
      dining_option: diningOption,
    };

    if (mains.length === 0 && sides.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no items' });
    }

    const { data, error } = await insertOrder(order);
    if (error) {
      console.error('Insert failed:', error.message);
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook parse error:', err.message);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
