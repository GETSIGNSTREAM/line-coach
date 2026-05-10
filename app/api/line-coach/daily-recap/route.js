import { NextResponse } from 'next/server';
import { buildDailyRecap, getConfig, resolveStoreId } from '@/lib/line-coach';

// Daily recap: morning Slack DM to each store's manager summarizing
// yesterday's service. 6 stores, posted at 13:00 UTC = 5:00 AM PT
// (before opening prep) so the manager has the brief on their phone
// walking in.
//
// Auth: CRON_SECRET via Authorization: Bearer.
// Slack: requires SLACK_BOT_TOKEN env (xoxb-...) with chat:write +
// im:write scopes. Recipient Slack user IDs are stored in
// lc_brand_config.recap_recipients keyed by store slug.

const STORE_DISPLAY = {
  hollywood: 'Hollywood',
  dtla: 'DTLA',
  westwood: 'Westwood',
  'culver-city': 'Culver City',
  '3rd-la-brea': '3rd & La Brea',
  'el-segundo': 'El Segundo',
};

function unauthorized(reason) {
  return NextResponse.json({ error: 'Unauthorized', reason }, { status: 401 });
}

function fmtSec(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function buildMessage(recap, slaBreachMin) {
  const name = STORE_DISPLAY[recap.store_id] || recap.store_id;
  const avgUnder = recap.avg_seconds && recap.avg_seconds < slaBreachMin * 60;
  const p90Under = recap.p90_seconds && recap.p90_seconds < slaBreachMin * 60;
  const overSlaPct = recap.over_sla_pct.toFixed(1);
  const sides = (recap.top_sides || []).map((s) => `• ${s.name} × ${s.count}`).join('\n') || '• (none)';
  const entrees = (recap.top_entrees || []).map((e) => `• ${e.name} × ${e.count}`).join('\n') || '• (none)';

  if (recap.tickets === 0) {
    return `🐦 *WILDBIRD — ${name} — ${recap.day}*\n\nNo bumped orders yesterday.\n\n— sent by Line Coach`;
  }

  const cleanupNote = recap.cleanup_bumped > 0
    ? `\nCleanup-bumped: ${recap.cleanup_bumped} (hit the 12-min wall — not counted in averages above)`
    : '';

  // Anomaly section: only render if there's something to flag.
  // Anomaly is demand-pattern (customer ordered more or less than the
  // 14-day baseline) — not waste, since lc_orders.sides records what
  // was ordered, not what was prepped. The recap calls this out
  // honestly so managers don't misread the signal.
  const anomalies = recap.anomalies || [];
  const anomalySection = anomalies.length > 0
    ? '\n*⚠️ Demand anomalies (vs 14-day avg):*\n' + anomalies.map((a) => {
        const arrow = a.anomaly_flag === 'high' ? '↑' : '↓';
        const pct = a.pct_vs_avg != null ? `${a.pct_vs_avg}% of avg` : '—';
        return `• ${a.name}: ${a.count} ordered (${arrow} ${pct}, baseline ${a.avg_14d})`;
      }).join('\n') + '\n'
    : '';

  return [
    `🐦 *WILDBIRD — ${name} — yesterday (${recap.day})*`,
    '',
    `Tickets:        ${recap.tickets}`,
    `Avg out-the-door: ${fmtSec(recap.avg_seconds)}   ${avgUnder ? '✅ under' : '⚠️ over'} ${slaBreachMin}-min brand promise`,
    `p90:            ${fmtSec(recap.p90_seconds)}   ${p90Under ? '✅' : '⚠️ tail edging over'}`,
    `Over-SLA:       ${recap.over_sla} (${overSlaPct}%)${recap.over_sla_pct > 5 ? '   ⚠️ investigate' : ''}` + cleanupNote,
    anomalySection,
    'Top batches:',
    sides,
    '',
    'Top entrees:',
    entrees,
    '',
    '— sent by Line Coach',
  ].join('\n');
}

async function slackOpenDm(userId, token) {
  const res = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`conversations.open: ${json.error || 'unknown'}`);
  return json.channel?.id;
}

async function slackPost(channel, text, token) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`chat.postMessage: ${json.error || 'unknown'}`);
  return json.ts;
}

async function handle(request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== expected) return unauthorized('bad bearer');

  const slackToken = process.env.SLACK_BOT_TOKEN;
  // Read brand config once to get recap_recipients + sla thresholds.
  const { data: cfg } = await getConfig(resolveStoreId('default'));
  const recipients = cfg?.recap_recipients || {};
  const slaBreachMin = cfg?.hold_times?.sla_breach_minutes ?? 10;
  const cleanupCutoffMinutes = cfg?.hold_times?.max_ticket_minutes ?? 12;

  // Manual run via ?dry=1 returns the rendered messages without posting
  // to Slack. Useful for verifying formatting before flipping the cron
  // on, and for testing in environments without SLACK_BOT_TOKEN.
  const { searchParams } = new URL(request.url);
  const dry = searchParams.get('dry') === '1' || !slackToken;

  const stores = Object.keys(STORE_DISPLAY);
  const results = [];

  for (const storeId of stores) {
    try {
      const { data: recap, error } = await buildDailyRecap({ storeId, slaBreachMin, cleanupCutoffMinutes });
      if (error) {
        results.push({ store: storeId, status: 'recap_error', error: error.message });
        continue;
      }
      const text = buildMessage(recap, slaBreachMin);
      const userId = recipients[storeId];
      if (!userId) {
        results.push({ store: storeId, status: 'no_recipient', tickets: recap.tickets });
        continue;
      }
      if (dry) {
        results.push({ store: storeId, status: 'dry_run', recipient: userId, tickets: recap.tickets, preview: text });
        continue;
      }
      const channel = await slackOpenDm(userId, slackToken);
      const ts = await slackPost(channel, text, slackToken);
      results.push({ store: storeId, status: 'sent', recipient: userId, ts, tickets: recap.tickets });
    } catch (err) {
      results.push({ store: storeId, status: 'send_error', error: err.message });
    }
  }

  const summary = {
    sent: results.filter((r) => r.status === 'sent').length,
    dry_run: results.filter((r) => r.status === 'dry_run').length,
    skipped: results.filter((r) => r.status === 'no_recipient').length,
    errors: results.filter((r) => r.status.endsWith('_error')).length,
  };

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    sla_breach_min: slaBreachMin,
    dry,
    summary,
    results,
  });
}

export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }
