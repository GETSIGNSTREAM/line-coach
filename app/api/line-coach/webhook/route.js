import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

function tryVerifySignature(rawBody, request, secret) {
  const sig = request.headers.get('toast-signature');
  const ts = request.headers.get('toast-timestamp') || '';

  if (!sig || !secret) return { verified: false, method: 'no-signature' };

  // Try multiple concatenation orders
  const attempts = [
    { label: 'body+ts', payload: rawBody + ts },
    { label: 'ts+body', payload: ts + rawBody },
    { label: 'body-only', payload: rawBody },
  ];

  for (const attempt of attempts) {
    const computed = createHmac('sha256', secret).update(attempt.payload).digest('base64');
    if (computed === sig) {
      return { verified: true, method: attempt.label };
    }
  }

  // Also try hex encoding
  for (const attempt of attempts) {
    const computed = createHmac('sha256', secret).update(attempt.payload).digest('hex');
    if (computed === sig) {
      return { verified: true, method: attempt.label + '-hex' };
    }
  }

  return { verified: false, method: 'hmac-mismatch' };
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const rawBody = await request.text();

  // Collect all headers for diagnosis
  const headerMap = {};
  for (const [key, value] of request.headers.entries()) {
    headerMap[key] = key.toLowerCase().includes('secret') ? '***' : value;
  }

  const toastSig = request.headers.get('toast-signature');
  const authHeader = request.headers.get('authorization');

  let authenticated = false;
  let authMethod = 'none';

  if (toastSig) {
    const result = tryVerifySignature(rawBody, request, TOAST_WEBHOOK_SECRET);
    authenticated = result.verified;
    authMethod = result.method;
  } else if (authHeader?.startsWith('Bearer ')) {
    authenticated = authHeader.slice(7) === TOAST_WEBHOOK_SECRET;
    authMethod = 'bearer';
  }

  if (!authenticated) {
    // Log ALL headers so we can see exactly what Toast sends
    console.error('WEBHOOK_AUTH_FAIL', JSON.stringify({
      authMethod,
      headers: headerMap,
      bodyPreview: rawBody.slice(0, 200),
      secretConfigured: !!TOAST_WEBHOOK_SECRET,
      secretPreview: TOAST_WEBHOOK_SECRET ? TOAST_WEBHOOK_SECRET.slice(0, 8) + '...' : 'MISSING',
    }));
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  console.log('WEBHOOK_AUTH_OK', authMethod);

  try {
    const body = JSON.parse(rawBody);

    const eventType = body.eventType || body.type || 'ORDER_CREATED';
    if (eventType !== 'ORDER_CREATED' && eventType !== 'order.created') {
      return NextResponse.json({ status: 'ignored', eventType });
    }

    const toastOrder = body.order || body;
    const storeId = resolveStoreId(toastOrder.restaurantGuid || toastOrder.locationGuid);

    const items = (toastOrder.selections || toastOrder.items || []).map((item) => ({
      name: item.displayName || item.name,
      quantity: item.quantity || 1,
      modifiers: (item.modifiers || []).map((m) => m.displayName || m.name),
    }));

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

    const diningOption = toastOrder.diningOption
      || toastOrder.serviceType
      || toastOrder.revenueCenter?.name
      || null;

    const customerName = toastOrder.customer?.firstName
      || toastOrder.customer?.name
      || toastOrder.guestName
      || toastOrder.customerName
      || null;

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
