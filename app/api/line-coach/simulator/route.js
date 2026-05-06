import { NextResponse } from 'next/server';
import { insertOrder, getActiveOrders } from '@/lib/line-coach';
import { getServiceClient, withRetry } from '@/lib/supabase';

// All simulator activity is sandboxed to a dedicated, non-production
// store_id. This guarantees test orders can NEVER show up on a real
// kitchen display. The store row is is_active=false in lc_stores so
// it does not appear in store pickers; the config row mirrors
// Hollywood so simulated orders have realistic menu/sides/tips.
const SANDBOX_STORE_ID = 'sandbox';

// ── Scenario Definitions ────────────────────────────────

const SCENARIOS = {
  lunch_rush: {
    name: 'Lunch Rush',
    description: '8 orders across all categories, heavy on chicken and sides',
    orders: [
      {
        order_number: '1042',
        customer_name: 'Maria G',
        items: [{ name: 'Quarter Bird', quantity: 1 }, { name: 'Boneless Breast Market Plate', quantity: 1 }],
        sides: [{ name: 'Spanish Rice', quantity: 1 }, { name: 'Kale Slaw', quantity: 1 }, { name: 'Sweet Potatoes', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: '1043',
        customer_name: 'James T',
        items: [{ name: 'Tacos Dorados', quantity: 2 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Chips and Guac', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
        notes: 'Extra salsa on the side',
      },
      {
        order_number: '1044',
        customer_name: 'Ashley R',
        items: [{ name: 'Half Bird', quantity: 1 }],
        sides: [{ name: 'Mac Salad', quantity: 1 }, { name: 'Charro Beans', quantity: 1 }],
        priority: 'rush',
        dining_option: 'Delivery',
        notes: 'No dark meat — breast and wing only',
      },
      {
        order_number: '1045',
        customer_name: 'Carlos M',
        items: [{ name: 'Chicken Tinga Market Plate', quantity: 1 }, { name: 'Burrito Mexicano', quantity: 1 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Mexican Street Corn', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: '1046',
        customer_name: 'Sarah L',
        items: [{ name: 'Veggie Market Plate', quantity: 1 }, { name: 'Superfood Ensalada', quantity: 1 }],
        sides: [{ name: 'Broccoli', quantity: 1 }, { name: 'Sweet Potatoes', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
        notes: 'Allergy: no nuts',
      },
      {
        order_number: '1047',
        customer_name: 'Mike D',
        items: [{ name: 'Whole Bird', quantity: 1 }, { name: 'Kids Quesadilla', quantity: 2 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Kale Slaw', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: '1048',
        customer_name: 'Diana P',
        items: [{ name: 'Pollo Verde Market Plate', quantity: 1 }],
        sides: [{ name: 'Uptown Mac & Cheese', quantity: 1 }, { name: 'Brussel Sprouts', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
      },
      {
        order_number: '1049',
        customer_name: 'Kevin W',
        items: [{ name: 'Tostada Bowl', quantity: 1 }, { name: 'Harvest Bowl', quantity: 1 }],
        sides: [{ name: 'Chips and Guac', quantity: 2 }, { name: 'Buffalo Cauliflower', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Delivery',
        notes: 'Double bag please',
      },
    ],
  },

  side_heavy: {
    name: 'Side Heavy',
    description: '5 orders with lots of duplicate sides — tests batch coaching',
    orders: [
      {
        order_number: 'SIM-201',
        items: [{ name: 'Quarter Bird', quantity: 2 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Sweet Potatoes', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-202',
        items: [{ name: 'Half Bird', quantity: 1 }],
        sides: [{ name: 'Spanish Rice', quantity: 1 }, { name: 'Mac Salad', quantity: 1 }, { name: 'Sweet Potatoes', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
      },
      {
        order_number: 'SIM-203',
        items: [{ name: 'Chicken Dinner Box', quantity: 1 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Kale Slaw', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Takeout',
      },
      {
        order_number: 'SIM-204',
        items: [{ name: 'Protein Plate', quantity: 3 }],
        sides: [{ name: 'Sweet Potatoes', quantity: 3 }, { name: 'Broccoli', quantity: 3 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-205',
        items: [{ name: 'Boneless Breast Market Plate', quantity: 2 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Charro Beans', quantity: 2 }, { name: 'Sweet Potatoes', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Delivery',
        notes: 'Extra napkins',
      },
    ],
  },

  mexican_wave: {
    name: 'Mexican Wave',
    description: '6 orders heavy on Modern Mexican — tests fryer and line stations',
    orders: [
      {
        order_number: 'SIM-301',
        items: [{ name: 'Tacos Dorados', quantity: 2 }, { name: 'Taco (Single)', quantity: 1 }],
        sides: [{ name: 'Chips and Guac', quantity: 1 }, { name: 'Mexican Street Corn', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-302',
        items: [{ name: 'Burrito Mexicano', quantity: 2 }],
        sides: [{ name: 'Spanish Rice', quantity: 2 }, { name: 'Charro Beans', quantity: 2 }],
        priority: 'rush',
        dining_option: 'Delivery',
        notes: 'Hot sauce on the side',
      },
      {
        order_number: 'SIM-303',
        items: [{ name: 'Tostada Bowl', quantity: 1 }, { name: 'Tacos Dorados', quantity: 1 }],
        sides: [{ name: 'Chips and Guac', quantity: 2 }],
        priority: 'normal',
        dining_option: 'Takeout',
      },
      {
        order_number: 'SIM-304',
        items: [{ name: 'Kids Quesadilla', quantity: 3 }],
        sides: [{ name: 'Spanish Rice', quantity: 3 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-305',
        items: [{ name: 'Chicken Tinga Market Plate', quantity: 1 }, { name: 'Pollo Verde Market Plate', quantity: 1 }],
        sides: [{ name: 'Mexican Street Corn', quantity: 2 }, { name: 'Buffalo Cauliflower', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-306',
        items: [{ name: 'Burrito Mexicano', quantity: 1 }, { name: 'Taco (Single)', quantity: 2 }],
        sides: [{ name: 'Chips and Guac', quantity: 1 }, { name: 'Charro Beans', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
        notes: 'No onions',
      },
    ],
  },

  single_order: {
    name: 'Single Order',
    description: '1 simple order to test minimal state',
    orders: [
      {
        order_number: 'SIM-401',
        items: [{ name: 'Quarter Bird', quantity: 1 }],
        sides: [{ name: 'Spanish Rice', quantity: 1 }, { name: 'Kale Slaw', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Takeout',
      },
    ],
  },

  catering_bomb: {
    name: 'Catering Bomb',
    description: 'Large catering order + regular orders — tests volume alerts',
    orders: [
      {
        order_number: 'SIM-501',
        items: [
          { name: 'Whole Bird', quantity: 5 },
          { name: 'Boneless Breast Market Plate', quantity: 10 },
        ],
        sides: [
          { name: 'Spanish Rice', quantity: 10 },
          { name: 'Kale Slaw', quantity: 10 },
          { name: 'Sweet Potatoes', quantity: 10 },
          { name: 'Charro Beans', quantity: 10 },
        ],
        priority: 'rush',
        notes: 'CATERING ORDER — pickup at 12:30',
        dining_option: 'Takeout',
      },
      {
        order_number: 'SIM-502',
        items: [{ name: 'Tacos Dorados', quantity: 1 }],
        sides: [{ name: 'Chips and Guac', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Dine In',
      },
      {
        order_number: 'SIM-503',
        items: [{ name: 'Half Bird', quantity: 1 }, { name: 'Harvest Bowl', quantity: 1 }],
        sides: [{ name: 'Brussel Sprouts', quantity: 1 }, { name: 'Mexican Street Corn', quantity: 1 }],
        priority: 'normal',
        dining_option: 'Delivery',
      },
    ],
  },
};

// ── POST: Run a scenario ────────────────────────────────

export async function POST(request) {
  try {
    const body = await request.json();
    const { scenario, action = 'run' } = body;
    // Ignore any caller-supplied store_id. The simulator is hard-wired
    // to the sandbox store so it cannot pollute live kitchen displays.
    const store_id = SANDBOX_STORE_ID;

    // Clear simulator orders. Cancels ALL active orders in the sandbox
    // store (not just SIM-% prefixed ones) since the sandbox should
    // never have non-simulator data anyway.
    if (action === 'clear') {
      const db = getServiceClient();
      await withRetry(() =>
        db.from('lc_orders')
          .update({ status: 'cancelled' })
          .eq('store_id', store_id)
          .not('status', 'in', '("complete","cancelled")')
      );
      return NextResponse.json({ status: 'cleared', store_id });
    }

    // Run a scenario
    if (!scenario || !SCENARIOS[scenario]) {
      return NextResponse.json({
        error: 'Invalid scenario',
        available: Object.entries(SCENARIOS).map(([key, s]) => ({
          key,
          name: s.name,
          description: s.description,
          orderCount: s.orders.length,
        })),
      }, { status: 400 });
    }

    const scenarioData = SCENARIOS[scenario];
    const results = [];

    // Clear previous sandbox orders first so each scenario starts clean.
    const db = getServiceClient();
    await withRetry(() =>
      db.from('lc_orders')
        .update({ status: 'cancelled' })
        .eq('store_id', store_id)
        .not('status', 'in', '("complete","cancelled")')
    );

    // Insert orders with staggered timestamps
    for (let i = 0; i < scenarioData.orders.length; i++) {
      const orderDef = scenarioData.orders[i];
      const staggerMs = i * 15_000; // 15 seconds apart
      const fireAt = new Date(Date.now() - staggerMs);

      // Compute priority rank
      const isRush = orderDef.priority === 'rush';
      const dOpt = (orderDef.dining_option || '').toLowerCase();
      let priorityRank = 30;
      if (isRush) priorityRank = 10;
      else if (dOpt.includes('dine in')) priorityRank = 20;
      else if (dOpt.includes('delivery')) priorityRank = 40;

      const order = {
        store_id,
        order_number: orderDef.order_number,
        customer_name: orderDef.customer_name || null,
        items: orderDef.items,
        sides: orderDef.sides,
        priority: orderDef.priority || 'normal',
        priority_rank: priorityRank,
        fire_at: fireAt.toISOString(),
        toast_created_at: fireAt.toISOString(),
        estimated_ready_at: new Date(fireAt.getTime() + 10 * 60_000).toISOString(),
        notes: orderDef.notes || null,
        dining_option: orderDef.dining_option || null,
      };

      const { data, error } = await insertOrder(order);
      results.push({ order_number: orderDef.order_number, success: !error, error: error?.message });
    }

    return NextResponse.json({
      status: 'ok',
      store_id,
      scenario: scenarioData.name,
      description: scenarioData.description,
      ordersInserted: results.filter((r) => r.success).length,
      results,
    });
  } catch (err) {
    console.error('Simulator error:', err);
    return NextResponse.json({ error: 'Simulator failed' }, { status: 500 });
  }
}

// ── GET: List available scenarios ───────────────────────

export async function GET() {
  const scenarios = Object.entries(SCENARIOS).map(([key, s]) => ({
    key,
    name: s.name,
    description: s.description,
    orderCount: s.orders.length,
  }));

  return NextResponse.json({ scenarios, sandbox_store_id: SANDBOX_STORE_ID });
}
