import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

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

  // Method 1: HMAC-SHA256 signature (if Toast sends one)
  if (toastSig && TOAST_WEBHOOK_SECRET) {
    const ts = request.headers.get('toast-timestamp') || '';
    const payloads = [rawBody + ts, ts + rawBody, rawBody];
    for (const payload of payloads) {
      const computed = createHmac('sha256', TOAST_WEBHOOK_SECRET).update(payload).digest('base64');
      if (computed === toastSig) { authenticated = true; break; }
    }
  }

  // Method 2: Bearer token (simulator / direct API)
  if (!authenticated && authHeader?.startsWith('Bearer ')) {
    authenticated = authHeader.slice(7) === TOAST_WEBHOOK_SECRET;
  }

  // Method 3: Toast Java HTTP client (Toast doesn't sign order_updated webhooks)
  if (!authenticated && userAgent.includes('Apache-HttpClient')) {
    authenticated = true;
  }

  if (!authenticated) {
    console.error('Webhook auth failed', { userAgent, hasSig: !!toastSig, hasBearer: !!authHeader });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);

    // Toast order_updated webhook format
    const eventType = body.eventType || body.type || 'order_updated';

    // Extract the order — Toast puts it in different places
    const toastOrder = body.order || body.details || body;
    const storeId = resolveStoreId(
      toastOrder.restaurantGuid || body.restaurantGuid || toastOrder.locationGuid
    );

    // Map Toast order to our schema
    const checks = toastOrder.checks || [];
    const allSelections = [];
    let checkNumber = toastOrder.displayNumber || body.displayNumber || null;
    let customerName = null;
    let diningOption = toastOrder.diningOption || null;
    let specialInstructions = null;

    if (checks.length > 0) {
      // Toast v2 order format — items are inside checks[].selections[]
      for (const check of checks) {
        checkNumber = checkNumber || check.displayNumber;
        customerName = customerName || check.customer?.firstName || check.customer?.name;
        diningOption = diningOption || check.diningOption;
        specialInstructions = specialInstructions || check.specialInstructions;
        for (const sel of check.selections || []) {
          allSelections.push(sel);
        }
      }
    } else {
      // Fallback: items at top level
      allSelections.push(...(toastOrder.selections || toastOrder.items || []));
      customerName = toastOrder.customer?.firstName
        || toastOrder.customer?.name
        || toastOrder.guestName
        || null;
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

    const order = {
      store_id: storeId,
      toast_order_id: toastOrder.guid || body.guid || null,
      order_number: checkNumber || toastOrder.orderNumber || null,
      customer_name: customerName,
      items: mains,
      sides: sides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: specialInstructions || toastOrder.specialInstructions || toastOrder.notes || null,
      dining_option: diningOption,
    };

    // Skip if no items (could be a void/delete event)
    if (mains.length === 0 && sides.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no items' });
    }

    const { data, error } = await insertOrder(order);
    if (error) {
      console.error('Failed to insert order:', error);
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    console.log('Order inserted', { id: data.id, store: storeId, items: mains.length, sides: sides.length });
    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook parse error:', err.message);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
