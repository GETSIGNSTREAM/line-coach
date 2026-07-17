import { NextResponse } from 'next/server';
import { getFeedbackTips, getAllFeedbackTips, generateFeedbackTipsForStore, generateAllFeedbackTips } from '@/lib/feedback-tips';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Admin surface for Momos-derived feedback tips.
// GET  ?store=<slug>   → that store's stored tips + metadata (all stores if omitted)
// POST { store }       → regenerate now for one store (all stores if omitted —
//                        note: 6 sequential LLM calls, ~1-2 min; the admin UI
//                        regenerates the selected store only)
// Cron generation lives at ./generate (CRON_SECRET auth).

export async function GET(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get('store');

  if (storeId) {
    const { data, error } = await getFeedbackTips(storeId);
    if (error) {
      console.error('Failed to fetch feedback tips:', error);
      return NextResponse.json({ error: 'Failed to fetch feedback tips' }, { status: 500 });
    }
    return NextResponse.json(data || { store_id: storeId, tips: [] });
  }

  const { data, error } = await getAllFeedbackTips();
  if (error) {
    console.error('Failed to fetch feedback tips:', error);
    return NextResponse.json({ error: 'Failed to fetch feedback tips' }, { status: 500 });
  }
  return NextResponse.json({ stores: data || [] });
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  let body = {};
  try {
    body = await request.json();
  } catch { /* empty body → all stores */ }

  const result = body.store
    ? await generateFeedbackTipsForStore(body.store)
    : await generateAllFeedbackTips();

  const status = result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status });
}
