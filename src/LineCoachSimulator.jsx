'use client';

import { useState, useEffect } from 'react';

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  cream: '#E8DCC8',
  red: '#D64545',
  green: '#6FCF97',
  yellow: '#F2C94C',
  terracotta: '#C8654A',
};

// The simulator is hard-wired to a sandbox store on the server side
// (see app/api/line-coach/simulator/route.js). This is the same default
// the API exposes via GET /api/line-coach/simulator → sandbox_store_id;
// we keep a local fallback so links render before that fetch resolves.
const FALLBACK_SANDBOX_STORE_ID = 'sandbox';

// eslint-disable-next-line no-unused-vars
export default function LineCoachSimulator({ storeId }) {
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(null);
  const [result, setResult] = useState(null);
  const [sandboxStoreId, setSandboxStoreId] = useState(FALLBACK_SANDBOX_STORE_ID);

  useEffect(() => {
    fetch('/api/line-coach/simulator')
      .then((r) => r.json())
      .then((data) => {
        setScenarios(data.scenarios || []);
        if (data.sandbox_store_id) setSandboxStoreId(data.sandbox_store_id);
      })
      .catch(console.error);
  }, []);

  async function runScenario(key) {
    setLoading(key);
    setResult(null);
    try {
      const res = await fetch('/api/line-coach/simulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: key }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: 'Failed to run scenario' });
    }
    setLoading(null);
  }

  async function clearOrders() {
    setLoading('clear');
    setResult(null);
    try {
      const res = await fetch('/api/line-coach/simulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult({ error: 'Failed to clear' });
    }
    setLoading(null);
  }

  const scenarioColors = {
    lunch_rush: BRAND.terracotta,
    side_heavy: BRAND.gold,
    mexican_wave: BRAND.yellow,
    single_order: BRAND.green,
    catering_bomb: BRAND.red,
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>LINE COACH SIMULATOR</div>
          <div style={s.subtitle}>
            Sandboxed to <code style={s.code}>{sandboxStoreId}</code> &middot; live stores are never affected
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          {/* Read-only — opens the sandbox in plain display mode for
              checking visual regressions without bump interactions. */}
          <a href={`/?store=${sandboxStoreId}`} target="_blank" rel="noopener" style={s.linkBtn}>
            Open Sandbox Display
          </a>
          {/* Touch-enabled — same display + 800ms hold-to-bump on every
              card. Use this from a desktop browser to test the touch
              gesture with a mouse without needing actual hardware. */}
          <a
            href={`/?store=${sandboxStoreId}&touch=1`}
            target="_blank"
            rel="noopener"
            style={{ ...s.linkBtn, background: BRAND.gold, color: BRAND.charcoal }}
          >
            Touch Test (mouse-friendly)
          </a>
          <button style={s.clearBtn} onClick={clearOrders} disabled={loading === 'clear'}>
            {loading === 'clear' ? 'Clearing...' : 'Clear All Sim Orders'}
          </button>
        </div>
      </div>

      <div style={s.instructions}>
        1. Open the <a href={`/?store=${sandboxStoreId}&touch=1`} target="_blank" rel="noopener" style={s.link}>sandbox display in touch-test mode</a> in another window — every card responds to mouse hold-to-bump (800 ms).
        2. Run a scenario below.
        3. Watch the coaching panels update in real-time and try bumping cards by holding them.
        4. Tune the sandbox menu, sides, and tips in the <a href={`/?admin&store=${sandboxStoreId}`} target="_blank" rel="noopener" style={s.link}>sandbox admin panel</a>.
      </div>

      <div style={s.grid}>
        {scenarios.map((sc) => (
          <div key={sc.key} style={{ ...s.card, borderTop: `4px solid ${scenarioColors[sc.key] || BRAND.gold}` }}>
            <div style={s.cardName}>{sc.name}</div>
            <div style={s.cardDesc}>{sc.description}</div>
            <div style={s.cardMeta}>{sc.orderCount} order{sc.orderCount !== 1 ? 's' : ''}</div>
            <button
              style={{ ...s.runBtn, background: scenarioColors[sc.key] || BRAND.gold }}
              onClick={() => runScenario(sc.key)}
              disabled={loading === sc.key}
            >
              {loading === sc.key ? 'Running...' : 'Run Scenario'}
            </button>
          </div>
        ))}
      </div>

      {result && (
        <div style={s.result}>
          {result.error ? (
            <div style={{ color: BRAND.red }}>{result.error}</div>
          ) : result.status === 'cleared' ? (
            <div style={{ color: BRAND.green }}>All simulator orders cleared.</div>
          ) : (
            <div>
              <div style={{ color: BRAND.green, fontWeight: 700 }}>
                {result.scenario} — {result.ordersInserted} orders inserted
              </div>
              <div style={{ color: BRAND.cream, fontSize: '0.85rem', marginTop: '4px' }}>
                {result.description}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  container: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    padding: '24px',
    fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
    borderBottom: `2px solid ${BRAND.gold}`,
    paddingBottom: '16px',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
  },
  subtitle: { fontSize: '0.9rem', color: BRAND.cream, marginTop: '4px' },
  code: {
    background: BRAND.charcoalDark,
    color: BRAND.gold,
    padding: '1px 6px',
    borderRadius: '3px',
    fontFamily: "'Courier New', monospace",
    fontSize: '0.85rem',
  },
  instructions: {
    background: BRAND.charcoalDark,
    padding: '16px 20px',
    borderRadius: '8px',
    marginBottom: '20px',
    fontSize: '0.9rem',
    color: BRAND.cream,
    lineHeight: 1.8,
    borderLeft: `3px solid ${BRAND.gold}`,
  },
  link: { color: BRAND.gold, textDecoration: 'underline' },
  linkBtn: {
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    border: `1px solid ${BRAND.cream}30`,
    padding: '8px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    textDecoration: 'none',
    fontFamily: "'Open Sans', sans-serif",
  },
  clearBtn: {
    background: BRAND.charcoalLight,
    color: BRAND.red,
    border: `1px solid ${BRAND.red}40`,
    padding: '8px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontFamily: "'Open Sans', sans-serif",
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
    marginBottom: '20px',
  },
  card: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  cardName: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: BRAND.bone,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
  },
  cardDesc: {
    fontSize: '0.85rem',
    color: BRAND.cream,
    lineHeight: 1.4,
    flex: 1,
  },
  cardMeta: {
    fontSize: '0.8rem',
    color: `${BRAND.cream}88`,
  },
  runBtn: {
    color: BRAND.charcoal,
    border: 'none',
    padding: '10px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
    marginTop: '8px',
  },
  result: {
    background: BRAND.charcoalDark,
    padding: '16px 20px',
    borderRadius: '8px',
    fontSize: '0.95rem',
  },
};
