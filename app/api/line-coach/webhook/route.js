import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { getServiceClient } from '@/lib/supabase';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

function tryVerifySignature(rawBody, request, secret) {
  const sig = request.headers.get('toast-signature');
  const ts = request.headers.get('toast-timestamp') || '';

  if (!sig || !secret) return { verified: false, method: 'no-signature' };

  const attempts = [
    { label: 'body+ts', payload: rawBody + ts },
    { label: 'ts+body', payload: ts + rawBody },
    { label: 'body-only', payload: rawBody },
  ];

  for (const attempt of attempts) {
    const computed = createHmac('sha256', secret).update(attempt.payload).digest('base64');
    if (computed === sig) return { verified: true, method: attempt.label };
  }

  for (const attempt of attempts) {
    const computed = createHmac('sha256', secret).update(attempt.payload).digest('hex');
    if (computed === sig) return { verified: true, method: attempt.label + '-hex' };
  }

  return { verified: false, method: 'hmac-mismatch' };
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const rawBody = await request.text();

  // Collect headers
  const headerMap = {};
  for (const [key, value] of request.headers.entries()) {
    headerMap[key] = value;
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
    // TEMP DEBUG: Write debug data to Supabase so we can read it via API
    try {
      const db = getServiceClient();
      await db.from('lc_orders').insert({
        store_id: 'debug',
        order_number: 'WEBHOOK-DEBUG',
        status: 'cancelled',
        items: [{ debug: true, authMethod, headers: headerMap }],
        sides: [{ bodyPreview: rawBody.slice(0, 500), bodyLength: rawBody.length }],
        notes: `secret=${TOAST_WEBHOOK_SECRET ? TOAST_WEBHOOK_SECRET.slice(0, 8) + '...' : 'MISSING'} | sig=${toastSig || 'none'} | ts=${request.headers.get('toast-timestamp') || 'none'}`,
      });
    } catch (e) {
      console.error('Debug insert failed', e);
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
