import { NextResponse } from 'next/server';
import { syncRecipesFromNotion } from '@/lib/recipe-sync';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

// Learn mode: sync entree build steps from the Notion Culinary OS
// (Layer 3 Line Build Guides) into menu_items[].build_steps.
// Manual-only by design — recipes change rarely, and a cron would
// clobber hand edits on a schedule nobody chose. Triggered from the
// admin Menu tab's "Sync from Notion" button.

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
  } catch { /* empty body → real sync */ }

  const result = await syncRecipesFromNotion({ dry: body.dry === true });
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 });
}
