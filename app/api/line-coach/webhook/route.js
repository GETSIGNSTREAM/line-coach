import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

function verifyToastSignature(rawBody, signature, timestamp, secret) {
  if (!signature || !secret) return false;
  const payload = rawBody + timestamp;
  const computed = createHmac('sha256', secret).update(payload).digest('base64');
  return computed === signature;
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  // Read raw body for HMAC verification
  const rawBody = await request.text();

  // Try Toast HMAC-SHA256 signature verification first
  const toastSignature = request.headers.get('toast-signature');
  const toastTimestamp = request.headers.get('toast-timestamp');
  const authHeader = request.headers.get('authorization');

  let authenticated = false;

  if (toastSignature) {
    // Toast HMAC verification
    authenticated = verifyToastSignature(rawBody, toastSignature, toastTimestamp || '', TOAST_WEBHOOK_SECRET);
    if (!authenticated) {
      // Debug: log headers to help diagnose (remove after confirmed working)
      console.error('Toast signature verification failed', {
        hasSignature: !!toastSignature,
        hasTimestamp: !!toastTimestamp,
        signaturePreview: toastSignature?.slice(0, 20) + '...',
        userAgent: request.headers.get('user-agent'),
        allHeaders: Object.fromEntries([...request.headers.entries()].filter(([k]) =>
          k.startsWith('toast') || k === 'content-type' || k === 'user-agent' || k === 'authorization'
        )),
      });
    }
  } else if (authHeader?.startsWith('Bearer ')) {
    // Fallback: Bearer token (for simulator and direct API calls)
    authenticated = authHeader.slice(7) === TOAST_WEBHOOK_SECRET;
  }

  if (!authenticated) {
    console.error('Webhook auth failed', {
      method: toastSignature ? 'HMAC' : authHeader ? 'Bearer' : 'none',
      userAgent: request.headers.get('user-agent'),
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);

    // Toast sends different event types — we only care about order creation
    const eventType = body.eventType || body.type || 'ORDER_CREATED';
    if (eventType !== 'ORDER_CREATED' && eventType !== 'order.created') {
      return NextResponse.json({ status: 'ignored', eventType });
    }

    const toastOrder = body.order || body;
    const storeId = resolveStoreId(toastOrder.restaurantGuid || toastOrder.locationGuid);

    // Map Toast order to our schema
    const items = (toastOrder.selections || toastOrder.items || []).map((item) => ({
      name: item.displayName || item.name,
      quantity: item.quantity || 1,
      modifiers: (item.modifiers || []).map((m) => m.displayName || m.name),
    }));

    // Separate sides from mains
    const sides = [];
    const mains = [];
    for (const item of items) {
      const isSide = (item.name || '').toLowerCase().match(
        /fries|rings|tots|slaw|salad|corn|pickles|mac.*cheese|side|rice|beans|broccoli|sweet.?potato/
      );
      if (isSide) {
        sides.push(item);
      } else {
        mains.push(item);
      }
    }

    // Determine dining option
    const diningOption = toastOrder.diningOption
      || toastOrder.serviceType
      || toastOrder.revenueCenter?.name
      || null;

    // Customer name from Toast
    const customerName = toastOrder.customer?.firstName
      || toastOrder.customer?.name
      || toastOrder.guestName
      || toastOrder.customerName
      || null;

    // Check number
    const checkNumber = toastOrder.checkNumber
      || toastOrder.displayNumber
      || toastOrder.orderNumber
      || null;

    const order = {
      store_id: storeId,
      toast_order_id: toastOrder.guid || toastOrder.id || null,
      order_number: checkNumber,
      customer_name: customerName,
      items: mains,
      sides: sides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: toastOrder.specialInstructions || toastOrder.notes || null,
      dining_option: diningOption,
    };

    const { data, error } = await insertOrder(order);
    if (error) {
      console.error('Failed to insert order:', error);
      return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
    }

    return NextResponse.json({ status: 'ok', orderId: data.id });
  } catch (err) {
    console.error('Webhook error:', err);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
