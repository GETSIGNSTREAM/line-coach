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

export default function LineCoachSimulator({ storeId }) {
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch('/api/line-coach/simulator')
      .then((r) => r.json())
      .then((data) => setScenarios(data.scenarios || []))
      .catch(console.error);
  }, []);

  async function runScenario(key) {
    setLoading(key);
    setResult(null);
    try {
      const res = await fetch('/api/line-coach/simulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: key, store_id: storeId }),
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
        body: JSON.stringify({ action: 'clear', store_id: storeId }),
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
          <div style={s.subtitle}>Store: {storeId} &middot; Test scenarios to fine-tune coaching</div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <a href={`/?store=${storeId}`} target="_blank" rel="noopener" style={s.linkBtn}>
            Open Display
          </a>
          <button style={s.clearBtn} onClick={clearOrders} disabled={loading === 'clear'}>
            {loading === 'clear' ? 'Clearing...' : 'Clear All Sim Orders'}
          </button>
        </div>
      </div>

      <div style={s.instructions}>
        1. Open the <a href={`/?store=${storeId}`} target="_blank" rel="noopener" style={s.link}>Line Coach display</a> in another window.
        2. Run a scenario below.
        3. Watch the coaching panels update in real-time.
        4. Fine-tune cook times, batch sizes, and tips in the <a href={`/?admin&store=${storeId}`} target="_blank" rel="noopener" style={s.link}>admin panel</a>.
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
