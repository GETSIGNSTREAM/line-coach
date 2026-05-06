'use client';

import { useState, useEffect } from 'react';

// ── WILDBIRD Brand Colors ───────────────────────────────

const BRAND = {
  gold: '#D4A574',
  charcoal: '#2B2B2B',
  charcoalLight: '#363636',
  charcoalDark: '#1E1E1E',
  bone: '#F5F1E8',
  white: '#FFFFFF',
  cream: '#E8DCC8',
  terracotta: '#C8654A',
  blue: '#4A7C8C',
  red: '#D64545',
  green: '#6FCF97',
};

// ── Styles ──────────────────────────────────────────────

const styles = {
  container: {
    minHeight: '100vh',
    background: BRAND.charcoal,
    color: BRAND.bone,
    padding: '24px',
    boxSizing: 'border-box',
    fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
    borderBottom: `2px solid ${BRAND.gold}`,
    paddingBottom: '16px',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: BRAND.gold,
    fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
    letterSpacing: '3px',
    textTransform: 'uppercase',
  },
  subtitle: { fontSize: '0.9rem', color: BRAND.cream },
  loginBox: {
    maxWidth: '400px',
    margin: '100px auto',
    background: BRAND.charcoalDark,
    padding: '32px',
    borderRadius: '12px',
    border: `1px solid ${BRAND.gold}30`,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${BRAND.charcoalLight}`,
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    fontSize: '1rem',
    boxSizing: 'border-box',
    marginBottom: '12px',
    fontFamily: "'Open Sans', sans-serif",
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${BRAND.charcoalLight}`,
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    fontSize: '0.9rem',
    boxSizing: 'border-box',
    fontFamily: "'Open Sans', monospace",
    minHeight: '120px',
    marginBottom: '12px',
    resize: 'vertical',
  },
  btn: {
    background: BRAND.gold,
    color: BRAND.charcoal,
    border: 'none',
    padding: '10px 24px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  btnSecondary: {
    background: BRAND.charcoalLight,
    color: BRAND.bone,
    border: `1px solid ${BRAND.cream}30`,
    padding: '8px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontFamily: "'Open Sans', sans-serif",
  },
  tabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '24px',
    borderBottom: `2px solid ${BRAND.charcoalLight}`,
    paddingBottom: '4px',
  },
  tab: {
    padding: '8px 20px',
    borderRadius: '6px 6px 0 0',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 600,
    border: 'none',
    transition: 'background 0.2s',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  panel: {
    background: BRAND.charcoalDark,
    borderRadius: '8px',
    padding: '20px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: `1px solid ${BRAND.charcoalLight}`,
    color: BRAND.cream,
    fontSize: '0.85rem',
    fontWeight: 600,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: '1px',
    textTransform: 'uppercase',
  },
  td: {
    padding: '8px 12px',
    borderBottom: `1px solid ${BRAND.charcoal}`,
    fontSize: '0.9rem',
  },
  saveBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: BRAND.charcoalDark,
    borderTop: `2px solid ${BRAND.gold}`,
    padding: '12px 24px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deviceOnline: { color: BRAND.green, fontSize: '0.8rem' },
  deviceOffline: { color: `${BRAND.cream}60`, fontSize: '0.8rem' },
};

const TABS = ['Menu', 'Sides', 'Tips', 'Hold Times', 'Settings', 'Devices'];

export default function LineCoachAdmin({ storeId }) {
  const [token, setToken] = useState(null);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState('Menu');
  const [config, setConfig] = useState(null);
  const [devices, setDevices] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  async function handleLogin(e) {
    e.preventDefault();
    try {
      await fetch('/api/line-coach/config?store=' + storeId);
      if (password) {
        setToken(password);
        setLoginError('');
      }
    } catch {
      setLoginError('Login failed');
    }
  }

  useEffect(() => {
    if (!token) return;

    fetch(`/api/line-coach/config?store=${storeId}`)
      .then((r) => r.json())
      .then(setConfig)
      .catch(console.error);

    fetch(`/api/line-coach/devices?store=${storeId}`)
      .then((r) => r.json())
      .then((data) => setDevices(data.devices || []))
      .catch(console.error);
  }, [token, storeId]);

  async function handleSave() {
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch('/api/line-coach/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ store_id: storeId, ...config }),
      });
      if (res.ok) {
        setDirty(false);
        setSaveMsg('Saved!');
        setTimeout(() => setSaveMsg(''), 3000);
      } else {
        const err = await res.json();
        setSaveMsg(`Error: ${err.error}`);
      }
    } catch {
      setSaveMsg('Save failed');
    }
    setSaving(false);
  }

  function updateConfig(key, value) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  if (!token) {
    return (
      <div style={styles.container}>
        <div style={styles.loginBox}>
          <h2 style={{ color: BRAND.gold, marginTop: 0, fontFamily: "'Oswald', sans-serif", letterSpacing: '2px', textTransform: 'uppercase' }}>
            Line Coach Admin
          </h2>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              autoFocus
            />
            {loginError && <div style={{ color: BRAND.red, marginBottom: '12px' }}>{loginError}</div>}
            <button type="submit" style={styles.btn}>Log In</button>
          </form>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div style={styles.container}>
        <div style={{ textAlign: 'center', padding: '60px', color: BRAND.cream }}>Loading config...</div>
      </div>
    );
  }

  function renderMenuTab() {
    const items = config.menu_items || [];
    return (
      <div style={styles.panel}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Station</th>
              <th style={styles.th}>Cook Time (min)</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td style={styles.td}>
                  <input style={{ ...styles.input, marginBottom: 0 }} value={item.name}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, name: e.target.value }; updateConfig('menu_items', u); }} />
                </td>
                <td style={styles.td}>
                  <select style={{ ...styles.input, marginBottom: 0 }} value={item.station}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, station: e.target.value }; updateConfig('menu_items', u); }}>
                    <option value="oven">Oven</option>
                    <option value="grill">Grill</option>
                    <option value="fryer">Fryer</option>
                    <option value="line">Line</option>
                    <option value="cold">Cold</option>
                    <option value="hot_hold">Hot Hold</option>
                    <option value="grab">Grab</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <input type="number" style={{ ...styles.input, marginBottom: 0, width: '80px' }} value={item.cook_time}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, cook_time: parseInt(e.target.value) || 0 }; updateConfig('menu_items', u); }} />
                </td>
                <td style={styles.td}>
                  <button style={styles.btnSecondary} onClick={() => { updateConfig('menu_items', items.filter((_, idx) => idx !== i)); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => { updateConfig('menu_items', [...items, { name: '', station: 'line', cook_time: 4 }]); }}>
          + Add Item
        </button>
      </div>
    );
  }

  function renderSidesTab() {
    const items = config.sides || [];
    return (
      <div style={styles.panel}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Station</th>
              <th style={styles.th}>Cook Time</th>
              <th style={styles.th}>Batch Size</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td style={styles.td}>
                  <input style={{ ...styles.input, marginBottom: 0 }} value={item.name}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, name: e.target.value }; updateConfig('sides', u); }} />
                </td>
                <td style={styles.td}>
                  <select style={{ ...styles.input, marginBottom: 0 }} value={item.station}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, station: e.target.value }; updateConfig('sides', u); }}>
                    <option value="hot_hold">Hot Hold</option>
                    <option value="cold">Cold</option>
                    <option value="fryer">Fryer</option>
                    <option value="grill">Grill</option>
                    <option value="oven">Oven</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <input type="number" style={{ ...styles.input, marginBottom: 0, width: '80px' }} value={item.cook_time}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, cook_time: parseInt(e.target.value) || 0 }; updateConfig('sides', u); }} />
                </td>
                <td style={styles.td}>
                  <input type="number" style={{ ...styles.input, marginBottom: 0, width: '80px' }} value={item.batch_size}
                    onChange={(e) => { const u = [...items]; u[i] = { ...item, batch_size: parseInt(e.target.value) || 1 }; updateConfig('sides', u); }} />
                </td>
                <td style={styles.td}>
                  <button style={styles.btnSecondary} onClick={() => { updateConfig('sides', items.filter((_, idx) => idx !== i)); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => { updateConfig('sides', [...items, { name: '', station: 'hot_hold', cook_time: 0, batch_size: 4 }]); }}>
          + Add Side
        </button>
      </div>
    );
  }

  function renderTipsTab() {
    // Normalize legacy string-only tips into { en, es } so they show up
    // pre-filled in the EN column. First save upgrades the stored shape.
    const normalizeTip = (t) => {
      if (typeof t === 'string') return { en: t, es: '' };
      if (t && typeof t === 'object') {
        return {
          en: typeof t.en === 'string' ? t.en : '',
          es: typeof t.es === 'string' ? t.es : '',
        };
      }
      return { en: '', es: '' };
    };
    const tips = (config.quality_tips || []).map(normalizeTip);
    const setTip = (i, field, value) => {
      const next = tips.map((t, idx) => (idx === i ? { ...t, [field]: value } : t));
      updateConfig('quality_tips', next);
    };
    const removeTip = (i) => {
      updateConfig('quality_tips', tips.filter((_, idx) => idx !== i));
    };
    const addTip = () => {
      updateConfig('quality_tips', [...tips, { en: '', es: '' }]);
    };
    const translatedCount = tips.filter((t) => t.es && t.es.trim()).length;
    return (
      <div style={styles.panel}>
        <p style={{ color: BRAND.cream, marginTop: 0 }}>
          Quality tips are shown on the display during slow periods. Each tip
          can have an English and a Spanish translation — both are shown
          stacked on the kitchen display. Spanish is optional; leave it blank
          to show English only.
        </p>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: '40px' }}>#</th>
              <th style={styles.th}>English</th>
              <th style={styles.th}>Español</th>
              <th style={{ ...styles.th, width: '90px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tips.map((tip, i) => (
              <tr key={i}>
                <td style={{ ...styles.td, color: BRAND.gold, fontWeight: 700, textAlign: 'center' }}>{i + 1}</td>
                <td style={styles.td}>
                  <textarea
                    style={{ ...styles.textarea, marginBottom: 0, minHeight: '60px' }}
                    rows={2}
                    value={tip.en}
                    onChange={(e) => setTip(i, 'en', e.target.value)}
                  />
                </td>
                <td style={styles.td}>
                  <textarea
                    style={{ ...styles.textarea, marginBottom: 0, minHeight: '60px' }}
                    rows={2}
                    placeholder="Optional — leave blank for English only"
                    value={tip.es}
                    onChange={(e) => setTip(i, 'es', e.target.value)}
                  />
                </td>
                <td style={styles.td}>
                  <button style={styles.btnSecondary} onClick={() => removeTip(i)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={{ ...styles.btnSecondary, marginTop: '12px' }} onClick={addTip}>
          + Add Tip
        </button>
        <div style={{ color: BRAND.cream, fontSize: '0.85rem', marginTop: '8px' }}>
          {tips.length} tips configured · {translatedCount} translated to Spanish
        </div>
      </div>
    );
  }

  function renderHoldTimesTab() {
    const ht = config.hold_times || { fire_now: 5, staging: 15, on_deck: 30 };
    return (
      <div style={styles.panel}>
        <p style={{ color: BRAND.cream, marginTop: 0 }}>
          Hold times define when orders move between lanes (in minutes before fire time).
        </p>
        {Object.entries(ht).map(([key, value]) => (
          <div key={key} style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ width: '120px', fontWeight: 600, textTransform: 'capitalize', fontFamily: "'Oswald', sans-serif" }}>
              {key.replace(/_/g, ' ')}:
            </label>
            <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }} value={value}
              onChange={(e) => { updateConfig('hold_times', { ...ht, [key]: parseInt(e.target.value) || 0 }); }} />
            <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>minutes</span>
          </div>
        ))}
      </div>
    );
  }

  function renderSettingsTab() {
    const settings = config.settings || {};
    return (
      <div style={styles.panel}>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Quality Coach Interval:</label>
          <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.quality_coach_interval || 30}
            onChange={(e) => { updateConfig('settings', { ...settings, quality_coach_interval: parseInt(e.target.value) || 30 }); }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>seconds between tips</span>
        </div>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Side Batch Threshold:</label>
          <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.side_batch_threshold || 3}
            onChange={(e) => { updateConfig('settings', { ...settings, side_batch_threshold: parseInt(e.target.value) || 3 }); }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>minimum to show batch alert</span>
        </div>
        <div style={{ borderTop: `1px solid ${BRAND.charcoalLight}`, paddingTop: '16px', marginTop: '8px', marginBottom: '16px' }}>
          <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", fontSize: '0.9rem', letterSpacing: '1px', marginBottom: '12px' }}>TICKET TIMERS</div>
        </div>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Warning (Yellow):</label>
          <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.ticket_warning_minutes || 5}
            onChange={(e) => { updateConfig('settings', { ...settings, ticket_warning_minutes: parseInt(e.target.value) || 5 }); }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>minutes until yellow</span>
        </div>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Danger (Red):</label>
          <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.ticket_danger_minutes || 8}
            onChange={(e) => { updateConfig('settings', { ...settings, ticket_danger_minutes: parseInt(e.target.value) || 8 }); }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>minutes until red</span>
        </div>
        <div style={{ borderTop: `1px solid ${BRAND.charcoalLight}`, paddingTop: '16px', marginTop: '8px', marginBottom: '16px' }}>
          <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", fontSize: '0.9rem', letterSpacing: '1px', marginBottom: '12px' }}>AUDIO ALERTS</div>
        </div>
        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Enable chime:</label>
          <input type="checkbox"
            checked={settings.alerts_enabled !== false}
            onChange={(e) => { updateConfig('settings', { ...settings, alerts_enabled: e.target.checked }); }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>play tone on each new order</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600, fontFamily: "'Oswald', sans-serif" }}>Volume:</label>
          <input type="range" min={0} max={1} step={0.1}
            value={settings.alerts_volume ?? 0.5}
            onChange={(e) => { updateConfig('settings', { ...settings, alerts_volume: parseFloat(e.target.value) }); }}
            style={{ width: '200px' }} />
          <span style={{ color: BRAND.cream, fontSize: '0.85rem' }}>{Math.round((settings.alerts_volume ?? 0.5) * 100)}%</span>
        </div>
        <div style={{ marginTop: '8px', color: `${BRAND.cream}80`, fontSize: '0.8rem' }}>
          Browsers block audio until the kitchen tablet is tapped once. The display shows a one-time prompt.
        </div>
      </div>
    );
  }

  function renderDevicesTab() {
    return (
      <div style={styles.panel}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Device ID</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Last Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && (
              <tr><td colSpan={5} style={{ ...styles.td, textAlign: 'center', color: `${BRAND.cream}60` }}>No devices registered</td></tr>
            )}
            {devices.map((device) => {
              const lastBeat = new Date(device.last_heartbeat);
              const isOnline = Date.now() - lastBeat.getTime() < 120_000;
              return (
                <tr key={device.device_id}>
                  <td style={styles.td}>{device.device_id}</td>
                  <td style={styles.td}>{device.device_name || '—'}</td>
                  <td style={styles.td}>{device.device_type}</td>
                  <td style={styles.td}>
                    <span style={isOnline ? styles.deviceOnline : styles.deviceOffline}>{isOnline ? 'Online' : 'Offline'}</span>
                  </td>
                  <td style={styles.td}>{lastBeat.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => { fetch(`/api/line-coach/devices?store=${storeId}`).then((r) => r.json()).then((data) => setDevices(data.devices || [])).catch(console.error); }}>
          Refresh
        </button>
      </div>
    );
  }

  const tabRenderers = { Menu: renderMenuTab, Sides: renderSidesTab, Tips: renderTipsTab, 'Hold Times': renderHoldTimesTab, Settings: renderSettingsTab, Devices: renderDevicesTab };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Line Coach Admin</div>
          <div style={styles.subtitle}>Store: {storeId}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a href="/?hub" style={{ ...styles.btnSecondary, textDecoration: 'none' }}>All Stores</a>
          <a href="/?simulator" style={{ ...styles.btnSecondary, textDecoration: 'none' }}>Simulator</a>
          <a href={`/?store=${storeId}`} style={{ ...styles.btnSecondary, textDecoration: 'none' }}>View Display</a>
        </div>
      </div>

      <div style={styles.tabs}>
        {TABS.map((tab) => (
          <button key={tab} style={{
            ...styles.tab,
            background: activeTab === tab ? BRAND.gold : BRAND.charcoalDark,
            color: activeTab === tab ? BRAND.charcoal : BRAND.cream,
          }} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      {tabRenderers[activeTab]?.()}

      {dirty && (
        <div style={styles.saveBar}>
          <span style={{ color: BRAND.gold }}>Unsaved changes</span>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {saveMsg && <span style={{ color: saveMsg.startsWith('Error') ? BRAND.red : BRAND.green }}>{saveMsg}</span>}
            <button style={styles.btn} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
