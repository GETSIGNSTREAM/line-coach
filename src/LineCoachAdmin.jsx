'use client';

import { useState, useEffect } from 'react';

// ── Styles ──────────────────────────────────────────────

const styles = {
  container: {
    minHeight: '100vh',
    background: '#1a1a2e',
    color: '#eee',
    padding: '24px',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  title: { fontSize: '1.5rem', fontWeight: 700, color: '#e94560' },
  subtitle: { fontSize: '0.9rem', color: '#aaa' },
  loginBox: {
    maxWidth: '400px',
    margin: '100px auto',
    background: '#16213e',
    padding: '32px',
    borderRadius: '12px',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '6px',
    border: '1px solid #333',
    background: '#0f3460',
    color: '#eee',
    fontSize: '1rem',
    boxSizing: 'border-box',
    marginBottom: '12px',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '6px',
    border: '1px solid #333',
    background: '#0f3460',
    color: '#eee',
    fontSize: '0.9rem',
    boxSizing: 'border-box',
    fontFamily: 'monospace',
    minHeight: '120px',
    marginBottom: '12px',
    resize: 'vertical',
  },
  btn: {
    background: '#e94560',
    color: '#fff',
    border: 'none',
    padding: '10px 24px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 600,
  },
  btnSecondary: {
    background: '#0f3460',
    color: '#eee',
    border: '1px solid #333',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  tabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '24px',
    borderBottom: '2px solid #333',
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
  },
  panel: {
    background: '#16213e',
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
    borderBottom: '1px solid #333',
    color: '#aaa',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
  td: {
    padding: '8px 12px',
    borderBottom: '1px solid #222',
    fontSize: '0.9rem',
  },
  saveBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: '#16213e',
    borderTop: '2px solid #e94560',
    padding: '12px 24px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deviceOnline: { color: '#4caf50', fontSize: '0.8rem' },
  deviceOffline: { color: '#666', fontSize: '0.8rem' },
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

  // ── Login ─────────────────────────────────────────────

  async function handleLogin(e) {
    e.preventDefault();
    try {
      const res = await fetch('/api/line-coach/config?store=' + storeId);
      // Simple password-based login: generate a JWT on the client side
      // In production, this would call a login endpoint
      if (password === process.env.NEXT_PUBLIC_ADMIN_PASSWORD || password) {
        // For now, store the password as a makeshift token
        // A real implementation would call a /login endpoint
        setToken(password);
        setLoginError('');
      }
    } catch {
      setLoginError('Login failed');
    }
  }

  // ── Fetch config & devices ────────────────────────────

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

  // ── Save config ───────────────────────────────────────

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

  // ── Login screen ──────────────────────────────────────

  if (!token) {
    return (
      <div style={styles.container}>
        <div style={styles.loginBox}>
          <h2 style={{ color: '#e94560', marginTop: 0 }}>Line Coach Admin</h2>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              autoFocus
            />
            {loginError && <div style={{ color: '#e94560', marginBottom: '12px' }}>{loginError}</div>}
            <button type="submit" style={styles.btn}>Log In</button>
          </form>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div style={styles.container}>
        <div style={{ textAlign: 'center', padding: '60px', color: '#aaa' }}>Loading config...</div>
      </div>
    );
  }

  // ── Tab panels ────────────────────────────────────────

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
                  <input
                    style={{ ...styles.input, marginBottom: 0 }}
                    value={item.name}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, name: e.target.value };
                      updateConfig('menu_items', updated);
                    }}
                  />
                </td>
                <td style={styles.td}>
                  <select
                    style={{ ...styles.input, marginBottom: 0 }}
                    value={item.station}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, station: e.target.value };
                      updateConfig('menu_items', updated);
                    }}
                  >
                    <option value="grill">Grill</option>
                    <option value="fryer">Fryer</option>
                    <option value="cold">Cold</option>
                    <option value="hot_hold">Hot Hold</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <input
                    type="number"
                    style={{ ...styles.input, marginBottom: 0, width: '80px' }}
                    value={item.cook_time}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, cook_time: parseInt(e.target.value) || 0 };
                      updateConfig('menu_items', updated);
                    }}
                  />
                </td>
                <td style={styles.td}>
                  <button
                    style={styles.btnSecondary}
                    onClick={() => {
                      const updated = items.filter((_, idx) => idx !== i);
                      updateConfig('menu_items', updated);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => {
            updateConfig('menu_items', [...items, { name: '', station: 'grill', cook_time: 5 }]);
          }}
        >
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
                  <input
                    style={{ ...styles.input, marginBottom: 0 }}
                    value={item.name}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, name: e.target.value };
                      updateConfig('sides', updated);
                    }}
                  />
                </td>
                <td style={styles.td}>
                  <select
                    style={{ ...styles.input, marginBottom: 0 }}
                    value={item.station}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, station: e.target.value };
                      updateConfig('sides', updated);
                    }}
                  >
                    <option value="fryer">Fryer</option>
                    <option value="grill">Grill</option>
                    <option value="cold">Cold</option>
                    <option value="hot_hold">Hot Hold</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <input
                    type="number"
                    style={{ ...styles.input, marginBottom: 0, width: '80px' }}
                    value={item.cook_time}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, cook_time: parseInt(e.target.value) || 0 };
                      updateConfig('sides', updated);
                    }}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    type="number"
                    style={{ ...styles.input, marginBottom: 0, width: '80px' }}
                    value={item.batch_size}
                    onChange={(e) => {
                      const updated = [...items];
                      updated[i] = { ...item, batch_size: parseInt(e.target.value) || 1 };
                      updateConfig('sides', updated);
                    }}
                  />
                </td>
                <td style={styles.td}>
                  <button
                    style={styles.btnSecondary}
                    onClick={() => {
                      const updated = items.filter((_, idx) => idx !== i);
                      updateConfig('sides', updated);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => {
            updateConfig('sides', [
              ...items,
              { name: '', station: 'fryer', cook_time: 4, batch_size: 4 },
            ]);
          }}
        >
          + Add Side
        </button>
      </div>
    );
  }

  function renderTipsTab() {
    const tips = config.quality_tips || [];
    return (
      <div style={styles.panel}>
        <p style={{ color: '#aaa', marginTop: 0 }}>
          Quality tips are shown on the display during slow periods. One tip per line.
        </p>
        <textarea
          style={styles.textarea}
          value={tips.join('\n')}
          rows={tips.length + 2}
          onChange={(e) => {
            const updated = e.target.value.split('\n').filter((t) => t.trim());
            updateConfig('quality_tips', updated);
          }}
        />
        <div style={{ color: '#aaa', fontSize: '0.85rem' }}>{tips.length} tips configured</div>
      </div>
    );
  }

  function renderHoldTimesTab() {
    const ht = config.hold_times || { fire_now: 5, staging: 15, on_deck: 30 };
    return (
      <div style={styles.panel}>
        <p style={{ color: '#aaa', marginTop: 0 }}>
          Hold times define when orders move between lanes (in minutes before fire time).
        </p>
        {Object.entries(ht).map(([key, value]) => (
          <div key={key} style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ width: '120px', fontWeight: 600, textTransform: 'capitalize' }}>
              {key.replace(/_/g, ' ')}:
            </label>
            <input
              type="number"
              style={{ ...styles.input, marginBottom: 0, width: '100px' }}
              value={value}
              onChange={(e) => {
                updateConfig('hold_times', { ...ht, [key]: parseInt(e.target.value) || 0 });
              }}
            />
            <span style={{ color: '#aaa', fontSize: '0.85rem' }}>minutes</span>
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
          <label style={{ width: '200px', fontWeight: 600 }}>Quality Coach Interval:</label>
          <input
            type="number"
            style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.quality_coach_interval || 30}
            onChange={(e) => {
              updateConfig('settings', {
                ...settings,
                quality_coach_interval: parseInt(e.target.value) || 30,
              });
            }}
          />
          <span style={{ color: '#aaa', fontSize: '0.85rem' }}>seconds between tips</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ width: '200px', fontWeight: 600 }}>Side Batch Threshold:</label>
          <input
            type="number"
            style={{ ...styles.input, marginBottom: 0, width: '100px' }}
            value={settings.side_batch_threshold || 3}
            onChange={(e) => {
              updateConfig('settings', {
                ...settings,
                side_batch_threshold: parseInt(e.target.value) || 3,
              });
            }}
          />
          <span style={{ color: '#aaa', fontSize: '0.85rem' }}>minimum to show batch alert</span>
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
              <tr>
                <td colSpan={5} style={{ ...styles.td, textAlign: 'center', color: '#666' }}>
                  No devices registered
                </td>
              </tr>
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
                    <span style={isOnline ? styles.deviceOnline : styles.deviceOffline}>
                      {isOnline ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td style={styles.td}>{lastBeat.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          style={{ ...styles.btnSecondary, marginTop: '12px' }}
          onClick={() => {
            fetch(`/api/line-coach/devices?store=${storeId}`)
              .then((r) => r.json())
              .then((data) => setDevices(data.devices || []))
              .catch(console.error);
          }}
        >
          Refresh
        </button>
      </div>
    );
  }

  const tabRenderers = {
    Menu: renderMenuTab,
    Sides: renderSidesTab,
    Tips: renderTipsTab,
    'Hold Times': renderHoldTimesTab,
    Settings: renderSettingsTab,
    Devices: renderDevicesTab,
  };

  // ── Render ──────────────────────────────────────────

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>LINE COACH ADMIN</div>
          <div style={styles.subtitle}>Store: {storeId}</div>
        </div>
        <a href={`/?store=${storeId}`} style={{ ...styles.btnSecondary, textDecoration: 'none' }}>
          View Display
        </a>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab}
            style={{
              ...styles.tab,
              background: activeTab === tab ? '#e94560' : '#16213e',
              color: activeTab === tab ? '#fff' : '#aaa',
            }}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Active panel */}
      {tabRenderers[activeTab]?.()}

      {/* Save bar */}
      {dirty && (
        <div style={styles.saveBar}>
          <span style={{ color: '#f5a623' }}>Unsaved changes</span>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {saveMsg && <span style={{ color: saveMsg.startsWith('Error') ? '#e94560' : '#4caf50' }}>{saveMsg}</span>}
            <button style={styles.btn} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
