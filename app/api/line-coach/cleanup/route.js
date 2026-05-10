import { NextResponse } from 'next/server';
import { sweepStaleOrders, getConfig, resolveStoreId } from '@/lib/line-coach';

// Cleanup endpoint — invoked every 2 min by Vercel Cron to expire stale
// active orders. Bridges the gap left by Toast almost never sending
// completedDate/voidDate webhooks: without this sweep, lc_orders
// accumulates phantoms that pollute side-batch aggregation and the
// display's "+N HIDDEN" count climbs forever.
//
// Cutoff = brand-config hold_times.max_ticket_minutes (default 12).
// 12 leaves a 2-min grace after the 10-min brand-promise alarm so
// legitimate large/catering cooks aren't yanked from batching mid-cook.
//
// Auth: Vercel Cron sets `Authorization: Bearer <CRON_SECRET>`. Reject
// anything else (including unauthenticated public hits) so a stranger
// can't trigger DB writes by guessing the URL.

function unauthorized(reason) {
  return NextResponse.json({ error: 'Unauthorized', reason }, { status: 401 });
}

async function handle(request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed — never run the sweep without a configured secret.
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }

  const auth = request.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== expected) return unauthorized('bad bearer');

  // Read max_ticket_minutes from brand config. Any store works because
  // hold_times is brand-wide; resolveStoreId('default') gives a stable
  // slug without depending on a Toast GUID.
  const defaultStore = resolveStoreId('default');
  const cfgRes = await getConfig(defaultStore);
  const maxTicketMin = cfgRes?.data?.hold_times?.max_ticket_minutes || 12;

  const { data, error } = await sweepStaleOrders(maxTicketMin);
  if (error) {
    console.error('cleanup sweep failed:', error.message || error);
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 });
  }

  // Group counts by store so the cron log is easy to scan during
  // incident review without paging through every row.
  const swept = data || [];
  const byStore = {};
  for (const row of swept) {
    const sid = row.store_id || '__unknown__';
    byStore[sid] = (byStore[sid] || 0) + 1;
  }

  return NextResponse.json({
    swept: swept.length,
    by_store: byStore,
    cutoff_minutes: maxTicketMin,
    ran_at: new Date().toISOString(),
  });
}

// Both verbs supported: Vercel Cron uses GET, but POST is convenient for
// manual runs (`curl -X POST -H "Authorization: Bearer ..."`).
export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }
