import { NextResponse } from 'next/server';
import { generateFeedbackTipsForStore, generateAllFeedbackTips } from '@/lib/feedback-tips';

// Feedback tips generation: daily cron (vercel.json, 12:00 UTC = 4/5 AM PT,
// an hour before the daily recap) regenerates every store's tips from the
// last 14 days of Momos reviews.
//
// Auth: CRON_SECRET via Authorization: Bearer — same pattern as daily-recap.
// Manual runs: ?store=<slug> for one store, ?dry=1 to return tips without
// writing, ?days=N to change the review window.

export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }

async function handle(request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized', reason: 'bad bearer' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const store = searchParams.get('store');
  const dry = searchParams.get('dry') === '1';
  const days = Math.max(1, Math.min(90, parseInt(searchParams.get('days'), 10) || 14));

  if (store) {
    const result = await generateFeedbackTipsForStore(store, { days, dry });
    return NextResponse.json({ ran_at: new Date().toISOString(), days, dry, results: [result] });
  }
  return NextResponse.json(await generateAllFeedbackTips({ days, dry }));
}
