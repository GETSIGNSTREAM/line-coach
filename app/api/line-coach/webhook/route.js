import { NextResponse } from 'next/server';
import { insertOrder, resolveStoreId } from '@/lib/line-coach';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET;

export async function POST(request) {
  // Rate limit
  const rlKey = getRateLimitKey(request, 'webhook');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.webhook.limit, RATE_LIMITS.webhook.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  // Auth — bearer token
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== TOAST_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();

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

    // Separate sides from mains (items with "side" in category or small items)
    const sides = [];
    const mains = [];
    for (const item of items) {
      const isSide = (item.name || '').toLowerCase().match(
        /fries|rings|tots|slaw|salad|corn|pickles|mac.*cheese|side/
      );
      if (isSide) {
        sides.push(item);
      } else {
        mains.push(item);
      }
    }

    const order = {
      store_id: storeId,
      toast_order_id: toastOrder.guid || toastOrder.id || null,
      order_number: toastOrder.displayNumber || toastOrder.orderNumber || null,
      items: mains,
      sides: sides,
      priority: toastOrder.priority === 'RUSH' ? 'rush' : 'normal',
      fire_at: new Date().toISOString(),
      notes: toastOrder.specialInstructions || toastOrder.notes || null,
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
