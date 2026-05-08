'use client';

import { Fragment, useState, useEffect, useCallback } from 'react';

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

const TABS = ['Menu', 'Sides', 'Tips', 'Hold Times', 'Settings', 'Devices', 'Webhooks', 'Analytics', 'Maintenance'];

const ALLOWED_STATIONS = ['oven', 'grill', 'fryer', 'line', 'cold', 'hot_hold', 'grab'];

const HEALTH_COLOR = {
  healthy: '#6FCF97',
  warning: '#F2C94C',
  critical: '#D64545',
  silent: '#A8B5A0',
};

const WEBHOOK_STATUS_COLOR = {
  ok: '#6FCF97',
  ignored: '#A8B5A0',
  unauthorized: '#D64545',
  invalid_json: '#D64545',
  parse_error: '#D64545',
  insert_error: '#D64545',
  rate_limited: '#F2C94C',
};

function timeAgo(iso) {
  if (!iso) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// CSV helpers — small and dependency-free.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const out = [headers.join(',')];
  for (const row of rows) out.push(headers.map((h) => csvEscape(row[h])).join(','));
  return out.join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] != null ? r[idx] : ''; });
    return obj;
  });
}

function downloadCsv(filename, headers, rows) {
  const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function validateMenuItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('No rows found');
  return arr.map((row, i) => {
    const name = String(row.name || '').trim();
    const station = String(row.station || '').trim();
    if (!name) throw new Error(`Row ${i + 2}: name required`);
    if (!ALLOWED_STATIONS.includes(station)) throw new Error(`Row ${i + 2}: station "${station}" must be one of ${ALLOWED_STATIONS.join(', ')}`);
    const out = { name, station, cook_time: parseInt(row.cook_time, 10) || 0 };
    if (row.category && String(row.category).trim()) out.category = String(row.category).trim();
    if (row.image_url && String(row.image_url).trim()) out.image_url = String(row.image_url).trim();
    // Bilingual coach_tip — preserved on import. Accepts either an
    // object {en, es} or flat coach_tip_en / coach_tip_es CSV columns.
    const tipEn = (row.coach_tip && typeof row.coach_tip === 'object' && row.coach_tip.en)
      ? String(row.coach_tip.en)
      : (row.coach_tip_en ? String(row.coach_tip_en) : '');
    const tipEs = (row.coach_tip && typeof row.coach_tip === 'object' && row.coach_tip.es)
      ? String(row.coach_tip.es)
      : (row.coach_tip_es ? String(row.coach_tip_es) : '');
    if (tipEn.trim() || tipEs.trim()) {
      out.coach_tip = { en: tipEn, es: tipEs };
    }
    return out;
  });
}

function validateSides(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('No rows found');
  return arr.map((row, i) => {
    const name = String(row.name || '').trim();
    const station = String(row.station || '').trim();
    if (!name) throw new Error(`Row ${i + 2}: name required`);
    if (!ALLOWED_STATIONS.includes(station)) throw new Error(`Row ${i + 2}: station "${station}" must be one of ${ALLOWED_STATIONS.join(', ')}`);
    const out = {
      name,
      station,
      cook_time: parseInt(row.cook_time, 10) || 0,
      batch_size: Math.max(1, parseInt(row.batch_size, 10) || 1),
    };
    if (row.image_url && String(row.image_url).trim()) out.image_url = String(row.image_url).trim();
    return out;
  });
}

const MENU_CSV_HEADERS = ['name', 'station', 'cook_time', 'category', 'image_url', 'coach_tip_en', 'coach_tip_es'];

// Flatten menu items so coach_tip {en, es} round-trips cleanly through
// the CSV (which has no nested-object support).
function flattenMenuItemsForCsv(items) {
  return (items || []).map((it) => {
    const tip = (it.coach_tip && typeof it.coach_tip === 'object') ? it.coach_tip : null;
    return {
      ...it,
      coach_tip_en: tip ? (tip.en || '') : '',
      coach_tip_es: tip ? (tip.es || '') : '',
    };
  });
}
const SIDES_CSV_HEADERS = ['name', 'station', 'cook_time', 'batch_size', 'image_url'];

async function uploadImage(file, kind, name, token) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  fd.append('name', name || '');
  const res = await fetch('/api/line-coach/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  return await res.json();
}

function ImageCell({ value, kind, name, token, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = (typeof window === 'undefined') ? null : { current: null };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
      <label style={{ cursor: 'pointer', display: 'block' }}>
        {value ? (
          <img src={value} alt={name || 'image'}
            style={{ width: '52px', height: '52px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #36363680' }}
            onError={(e) => { e.target.style.opacity = '0.3'; }} />
        ) : (
          <div style={{
            width: '52px', height: '52px', borderRadius: '6px',
            background: '#36363680', border: '1px dashed #E8DCC850',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#E8DCC880', fontSize: '0.7rem', fontFamily: "'Oswald', sans-serif",
          }}>
            {busy ? '...' : '+'}
          </div>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          style={{ display: 'none' }}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setErr('');
            try {
              const { url } = await uploadImage(file, kind, name, token);
              onChange(url);
            } catch (uploadErr) {
              setErr(uploadErr.message);
              setTimeout(() => setErr(''), 4000);
            }
            setBusy(false);
            e.target.value = '';
          }}
        />
      </label>
      {value && !busy && (
        <button type="button"
          onClick={() => onChange(null)}
          style={{ background: 'transparent', border: 'none', color: '#D6454580', cursor: 'pointer', fontSize: '0.65rem', padding: 0 }}>
          remove
        </button>
      )}
      {err && <div style={{ fontSize: '0.65rem', color: '#D64545', maxWidth: '70px', textAlign: 'center' }}>{err}</div>}
    </div>
  );
}

function BrandWideBanner() {
  return (
    <div style={{
      padding: '10px 14px',
      marginBottom: '12px',
      background: '#D4A57415',
      borderLeft: '3px solid #D4A574',
      borderRadius: '4px',
      fontSize: '0.8rem',
      color: '#E8DCC8',
    }}>
      <strong style={{ color: '#D4A574' }}>BRAND-WIDE</strong> — changes here apply to all WILDBIRD stores.
    </div>
  );
}

export default function LineCoachAdmin({ storeId }) {
  const [token, setToken] = useState(null);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState('Menu');
  const [config, setConfig] = useState(null);
  const [devices, setDevices] = useState([]);
  const [hideOfflineDevices, setHideOfflineDevices] = useState(true);
  const [webhookLogs, setWebhookLogs] = useState([]);
  const [webhookFilter, setWebhookFilter] = useState({ status: '', hours: 24 });
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [expandedLog, setExpandedLog] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsHours, setAnalyticsHours] = useState(24);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [maintStats, setMaintStats] = useState(null);
  const [maintMsg, setMaintMsg] = useState('');
  const [maintBusy, setMaintBusy] = useState(false);
  const [logRetentionDays, setLogRetentionDays] = useState(30);
  const [orderRetentionDays, setOrderRetentionDays] = useState(7);
  const [importMsg, setImportMsg] = useState('');
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

  function refreshDevices() {
    fetch(`/api/line-coach/devices?store=${storeId}`)
      .then((r) => r.json())
      .then((data) => setDevices(data.devices || []))
      .catch(console.error);
  }

  async function removeDevice(deviceId) {
    if (!confirm(`Remove device "${deviceId}"? It will re-register on next heartbeat if still online.`)) return;
    const res = await fetch(`/api/line-coach/devices?device_id=${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) refreshDevices();
    else alert('Failed to remove device');
  }

  const loadWebhookLogs = useCallback(async () => {
    setWebhookLoading(true);
    const params = new URLSearchParams();
    if (storeId) params.set('store', storeId);
    if (webhookFilter.status) params.set('status', webhookFilter.status);
    params.set('hours', String(webhookFilter.hours));
    params.set('limit', '100');
    try {
      const res = await fetch(`/api/line-coach/webhook-log?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setWebhookLogs(data.logs || []);
      } else setWebhookLogs([]);
    } catch { setWebhookLogs([]); }
    setWebhookLoading(false);
  }, [token, storeId, webhookFilter.status, webhookFilter.hours]);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch('/api/line-coach/integration-health?hours=24', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setHealth(await res.json());
    } catch { /* ignore */ }
    setHealthLoading(false);
  }, [token]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const res = await fetch(`/api/line-coach/analytics?store=${storeId}&hours=${analyticsHours}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setAnalytics(await res.json());
      else setAnalytics(null);
    } catch { setAnalytics(null); }
    setAnalyticsLoading(false);
  }, [token, storeId, analyticsHours]);

  const loadMaintenance = useCallback(async () => {
    setMaintBusy(true);
    try {
      const res = await fetch('/api/line-coach/maintenance', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMaintStats(await res.json());
    } catch { /* ignore */ }
    setMaintBusy(false);
  }, [token]);

  async function runMaintenance(action, days) {
    setMaintMsg('');
    setMaintBusy(true);
    try {
      const res = await fetch('/api/line-coach/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, days }),
      });
      const json = await res.json();
      if (res.ok) {
        if (action === 'purge_logs') setMaintMsg(`Deleted ${json.deleted} webhook log rows`);
        if (action === 'archive_orders') setMaintMsg(`Archived ${json.archived} orders`);
        await loadMaintenance();
      } else {
        setMaintMsg(`Error: ${json.error || res.status}`);
      }
    } catch (err) { setMaintMsg(`Error: ${err.message}`); }
    setMaintBusy(false);
    setTimeout(() => setMaintMsg(''), 4000);
  }

  useEffect(() => {
    if (token && activeTab === 'Webhooks') { loadWebhookLogs(); loadHealth(); }
    if (token && activeTab === 'Analytics') loadAnalytics();
    if (token && activeTab === 'Maintenance') loadMaintenance();
  }, [token, activeTab, loadWebhookLogs, loadHealth, loadAnalytics, loadMaintenance]);

  function importCsvFor(key, validator) {
    return (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const rows = parseCsv(String(reader.result));
          const cleaned = validator(rows);
          updateConfig(key, cleaned);
          setImportMsg(`Imported ${cleaned.length} rows into ${key}. Click Save Changes to persist.`);
          setTimeout(() => setImportMsg(''), 5000);
        } catch (err) {
          setImportMsg(`Import failed: ${err.message}`);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    };
  }

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
        <BrandWideBanner />
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap' }}>
          <button style={styles.btnSecondary} onClick={() => downloadCsv(`menu-${storeId}.csv`, MENU_CSV_HEADERS, flattenMenuItemsForCsv(items))}>
            Export CSV
          </button>
          <label style={{ ...styles.btnSecondary, display: 'inline-block', cursor: 'pointer' }}>
            Import CSV
            <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
              onChange={importCsvFor('menu_items', validateMenuItems)} />
          </label>
          {importMsg && (
            <span style={{ marginLeft: '8px', color: importMsg.startsWith('Import failed') ? BRAND.red : BRAND.green, fontSize: '0.85rem' }}>{importMsg}</span>
          )}
        </div>
        <div style={{ fontSize: '0.75rem', color: `${BRAND.cream}80`, marginBottom: '12px' }}>
          Headers: <code>name, station, cook_time, category, coach_tip_en, coach_tip_es</code> · Edit in Excel/Sheets, save as CSV, then re-import.
        </div>
        <div style={{ fontSize: '0.8rem', color: BRAND.cream, marginBottom: '12px', padding: '8px 12px', background: `${BRAND.gold}15`, borderLeft: `3px solid ${BRAND.gold}`, borderRadius: '3px' }}>
          <strong style={{ color: BRAND.gold }}>Coach Tips:</strong> Shown on the kitchen display when only this dish is on the board (focus mode). Use to reinforce quality standards specific to this entree. Spanish is optional.
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: '70px' }}>Image</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Station</th>
              <th style={{ ...styles.th, width: '90px' }}>Cook Time</th>
              <th style={styles.th}>Coach Tip (EN)</th>
              <th style={styles.th}>Coach Tip (ES)</th>
              <th style={{ ...styles.th, width: '90px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              // Read existing coach_tip; tolerate missing/legacy shapes.
              const tip = item.coach_tip && typeof item.coach_tip === 'object'
                ? { en: item.coach_tip.en || '', es: item.coach_tip.es || '' }
                : { en: '', es: '' };
              const setTip = (field, value) => {
                const u = [...items];
                const next = { ...item };
                const newTip = { ...tip, [field]: value };
                if (newTip.en.trim() || newTip.es.trim()) next.coach_tip = newTip;
                else delete next.coach_tip;
                u[i] = next;
                updateConfig('menu_items', u);
              };
              return (
                <tr key={i}>
                  <td style={styles.td}>
                    <ImageCell value={item.image_url} kind="item" name={item.name} token={token}
                      onChange={(url) => { const u = [...items]; u[i] = { ...item, image_url: url || undefined }; updateConfig('menu_items', u); }} />
                  </td>
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
                    <textarea
                      style={{ ...styles.textarea, marginBottom: 0, minHeight: '50px', minWidth: '220px' }}
                      rows={2}
                      placeholder="e.g. Check internal temp 165°F, golden skin"
                      value={tip.en}
                      onChange={(e) => setTip('en', e.target.value)}
                    />
                  </td>
                  <td style={styles.td}>
                    <textarea
                      style={{ ...styles.textarea, marginBottom: 0, minHeight: '50px', minWidth: '220px' }}
                      rows={2}
                      placeholder="Optional — leave blank for English only"
                      value={tip.es}
                      onChange={(e) => setTip('es', e.target.value)}
                    />
                  </td>
                  <td style={styles.td}>
                    <button style={styles.btnSecondary} onClick={() => { updateConfig('menu_items', items.filter((_, idx) => idx !== i)); }}>Remove</button>
                  </td>
                </tr>
              );
            })}
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
        <BrandWideBanner />
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap' }}>
          <button style={styles.btnSecondary} onClick={() => downloadCsv(`sides-${storeId}.csv`, SIDES_CSV_HEADERS, items)}>
            Export CSV
          </button>
          <label style={{ ...styles.btnSecondary, display: 'inline-block', cursor: 'pointer' }}>
            Import CSV
            <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
              onChange={importCsvFor('sides', validateSides)} />
          </label>
          {importMsg && (
            <span style={{ marginLeft: '8px', color: importMsg.startsWith('Import failed') ? BRAND.red : BRAND.green, fontSize: '0.85rem' }}>{importMsg}</span>
          )}
        </div>
        <div style={{ fontSize: '0.75rem', color: `${BRAND.cream}80`, marginBottom: '12px' }}>
          Headers: <code>name, station, cook_time, batch_size</code> · Edit in Excel/Sheets, save as CSV, then re-import.
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: '70px' }}>Image</th>
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
                  <ImageCell value={item.image_url} kind="side" name={item.name} token={token}
                    onChange={(url) => { const u = [...items]; u[i] = { ...item, image_url: url || undefined }; updateConfig('sides', u); }} />
                </td>
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
        <BrandWideBanner />
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
    // Merge with defaults so newly-introduced keys (e.g. max_ticket_minutes)
    // appear in the UI even if the stored config predates them.
    const ht = { fire_now: 5, staging: 15, on_deck: 30, max_ticket_minutes: 60, ...(config.hold_times || {}) };
    const HELP = {
      fire_now: 'minutes before fire time — moves to FIRE NOW lane',
      staging: 'minutes before fire time — moves to STAGING lane',
      on_deck: 'minutes before fire time — moves to ON DECK lane',
      max_ticket_minutes: 'orders older than this disappear from the display (still kept in DB for analytics)',
    };
    return (
      <div style={styles.panel}>
        <BrandWideBanner />
        <p style={{ color: BRAND.cream, marginTop: 0 }}>
          Hold times define when orders move between lanes, and when stale tickets fall off the display.
        </p>
        {Object.entries(ht).map(([key, value]) => (
          <div key={key} style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ width: '180px', fontWeight: 600, textTransform: 'capitalize', fontFamily: "'Oswald', sans-serif" }}>
              {key.replace(/_/g, ' ')}:
            </label>
            <input type="number" style={{ ...styles.input, marginBottom: 0, width: '100px' }} value={value}
              onChange={(e) => { updateConfig('hold_times', { ...ht, [key]: parseInt(e.target.value) || 0 }); }} />
            <span style={{ color: BRAND.cream, fontSize: '0.8rem' }}>{HELP[key] || 'minutes'}</span>
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
    const SEVEN_DAYS = 7 * 24 * 3600_000;
    const visible = devices.filter((d) => {
      if (!hideOfflineDevices) return true;
      return Date.now() - new Date(d.last_heartbeat).getTime() < SEVEN_DAYS;
    });
    return (
      <div style={styles.panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <label style={{ fontSize: '0.85rem', color: BRAND.cream, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" checked={hideOfflineDevices} onChange={(e) => setHideOfflineDevices(e.target.checked)} />
            Hide devices offline &gt; 7 days
          </label>
          <span style={{ marginLeft: 'auto', color: `${BRAND.cream}80`, fontSize: '0.85rem' }}>{visible.length} of {devices.length}</span>
          <button style={styles.btnSecondary} onClick={refreshDevices}>Refresh</button>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Device ID</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Last Heartbeat</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={6} style={{ ...styles.td, textAlign: 'center', color: `${BRAND.cream}60` }}>
                {devices.length === 0 ? 'No devices registered' : 'No devices match the filter'}
              </td></tr>
            )}
            {visible.map((device) => {
              const lastBeat = new Date(device.last_heartbeat);
              const ageMs = Date.now() - lastBeat.getTime();
              const isOnline = ageMs < 120_000;
              const isStale = ageMs > SEVEN_DAYS;
              return (
                <tr key={device.device_id}>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{device.device_id}</td>
                  <td style={styles.td}>{device.device_name || '—'}</td>
                  <td style={styles.td}>{device.device_type}</td>
                  <td style={styles.td}>
                    <span style={isOnline ? styles.deviceOnline : styles.deviceOffline}>
                      {isOnline ? 'Online' : isStale ? 'Stale' : 'Offline'}
                    </span>
                  </td>
                  <td style={{ ...styles.td, fontSize: '0.85rem' }}>
                    {lastBeat.toLocaleString()}
                    <div style={{ color: `${BRAND.cream}60`, fontSize: '0.75rem' }}>{timeAgo(device.last_heartbeat)}</div>
                  </td>
                  <td style={styles.td}>
                    <button style={styles.btnSecondary} onClick={() => removeDevice(device.device_id)}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderWebhooksTab() {
    return (
      <div style={styles.panel}>
        <div style={{ marginBottom: '16px', padding: '12px', background: BRAND.charcoal, borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: '0.85rem' }}>POS Integration Health (last 24h)</div>
            <button style={styles.btnSecondary} onClick={loadHealth} disabled={healthLoading}>{healthLoading ? '...' : 'Refresh'}</button>
          </div>
          {!health && (<div style={{ color: `${BRAND.cream}80`, fontSize: '0.85rem' }}>{healthLoading ? 'Loading...' : 'No data'}</div>)}
          {health && health.stores.length === 0 && (<div style={{ color: `${BRAND.cream}80`, fontSize: '0.85rem' }}>No stores configured</div>)}
          {health && health.stores.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' }}>
              {health.stores.map((s) => (
                <div key={s.store_id || 'unrouted'} style={{
                  background: BRAND.charcoalDark,
                  border: `1px solid ${HEALTH_COLOR[s.state]}40`,
                  borderLeft: `4px solid ${HEALTH_COLOR[s.state]}`,
                  borderRadius: '6px',
                  padding: '10px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: "'Oswald', sans-serif", color: BRAND.bone }}>{s.store_id || '(unrouted)'}</span>
                    <span style={{
                      background: `${HEALTH_COLOR[s.state]}20`,
                      color: HEALTH_COLOR[s.state],
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      letterSpacing: '0.5px',
                      textTransform: 'uppercase',
                      fontFamily: "'Oswald', sans-serif",
                    }}>{s.state}</span>
                  </div>
                  <div style={{ color: `${BRAND.cream}99`, fontSize: '0.75rem', marginTop: '4px' }}>
                    {s.ok}/{s.total} ok · last ok {timeAgo(s.last_ok_at)}
                  </div>
                  {s.reason && (<div style={{ color: HEALTH_COLOR[s.state], fontSize: '0.75rem', marginTop: '2px' }}>{s.reason}</div>)}
                </div>
              ))}
            </div>
          )}
        </div>

        <p style={{ color: BRAND.cream, marginTop: 0 }}>Last incoming Toast webhooks for store <strong>{storeId}</strong>. Click a row to inspect the raw payload.</p>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.85rem', color: BRAND.cream }}>Status:</label>
          <select style={{ ...styles.input, marginBottom: 0, width: 'auto' }} value={webhookFilter.status}
            onChange={(e) => setWebhookFilter({ ...webhookFilter, status: e.target.value })}>
            <option value="">All</option>
            <option value="ok">ok</option>
            <option value="ignored">ignored</option>
            <option value="unauthorized">unauthorized</option>
            <option value="parse_error">parse_error</option>
            <option value="insert_error">insert_error</option>
            <option value="rate_limited">rate_limited</option>
          </select>
          <label style={{ fontSize: '0.85rem', color: BRAND.cream }}>Last:</label>
          <select style={{ ...styles.input, marginBottom: 0, width: 'auto' }} value={webhookFilter.hours}
            onChange={(e) => setWebhookFilter({ ...webhookFilter, hours: parseInt(e.target.value, 10) })}>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={24}>24 hours</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
          </select>
          <button style={styles.btnSecondary} onClick={loadWebhookLogs} disabled={webhookLoading}>{webhookLoading ? 'Loading...' : 'Refresh'}</button>
          <span style={{ marginLeft: 'auto', color: `${BRAND.cream}80`, fontSize: '0.85rem' }}>{webhookLogs.length} entries</span>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Time</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Event</th>
              <th style={styles.th}>Store</th>
              <th style={styles.th}>Order #</th>
              <th style={styles.th}>Duration</th>
              <th style={styles.th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {webhookLogs.length === 0 && !webhookLoading && (
              <tr><td colSpan={7} style={{ ...styles.td, textAlign: 'center', color: `${BRAND.cream}60` }}>No webhook activity in this window</td></tr>
            )}
            {webhookLogs.map((log) => {
              const isOpen = expandedLog === log.id;
              return (
                <Fragment key={log.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedLog(isOpen ? null : log.id)}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {new Date(log.created_at).toLocaleTimeString()}
                      <div style={{ color: `${BRAND.cream}60`, fontSize: '0.7rem' }}>{new Date(log.created_at).toLocaleDateString()}</div>
                    </td>
                    <td style={styles.td}>
                      <span style={{
                        background: `${WEBHOOK_STATUS_COLOR[log.status] || BRAND.cream}20`,
                        color: WEBHOOK_STATUS_COLOR[log.status] || BRAND.cream,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                      }}>{log.status}</span>
                      <span style={{ marginLeft: '6px', color: `${BRAND.cream}80`, fontSize: '0.75rem' }}>{log.http_status}</span>
                    </td>
                    <td style={{ ...styles.td, fontSize: '0.8rem' }}>{log.event_type || '—'}</td>
                    <td style={{ ...styles.td, fontSize: '0.8rem' }}>{log.store_id || '—'}</td>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{log.toast_order_id ? log.toast_order_id.slice(0, 8) + '…' : '—'}</td>
                    <td style={{ ...styles.td, fontSize: '0.8rem' }}>{typeof log.duration_ms === 'number' ? `${log.duration_ms}ms` : '—'}</td>
                    <td style={{ ...styles.td, fontSize: '0.8rem', color: BRAND.red, maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.error_message || ''}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} style={{ ...styles.td, background: BRAND.charcoal, padding: '12px' }}>
                        <div style={{ color: `${BRAND.cream}80`, fontSize: '0.75rem', marginBottom: '6px' }}>IP: {log.ip || '—'} · Logged at {new Date(log.created_at).toISOString()}</div>
                        <pre style={{
                          background: BRAND.charcoalDark,
                          padding: '12px',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                          color: BRAND.bone,
                          overflow: 'auto',
                          maxHeight: '300px',
                          margin: 0,
                          fontFamily: 'monospace',
                        }}>{JSON.stringify(log.payload, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderAnalyticsTab() {
    const a = analytics;
    const maxBucket = a?.hourly?.length ? Math.max(...a.hourly.map((b) => b.count)) : 1;
    return (
      <div style={styles.panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div style={{ color: BRAND.cream }}>Window:</div>
          <select style={{ ...styles.input, marginBottom: 0, width: 'auto' }} value={analyticsHours}
            onChange={(e) => setAnalyticsHours(parseInt(e.target.value, 10))}>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={24}>24 hours</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
          <button style={styles.btnSecondary} onClick={loadAnalytics} disabled={analyticsLoading}>{analyticsLoading ? 'Loading...' : 'Refresh'}</button>
          <span style={{ marginLeft: 'auto', color: `${BRAND.cream}80`, fontSize: '0.85rem' }}>Store: {storeId}</span>
        </div>
        {!a && (<div style={{ padding: '40px', textAlign: 'center', color: `${BRAND.cream}80` }}>{analyticsLoading ? 'Loading...' : 'No data'}</div>)}
        {a && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              {[
                { label: 'Orders bumped', value: a.count },
                { label: 'Avg bump time', value: fmtDuration(a.avg_bump_seconds) },
                { label: 'p50', value: fmtDuration(a.p50_bump_seconds) },
                { label: 'p90', value: fmtDuration(a.p90_bump_seconds) },
                { label: 'p95', value: fmtDuration(a.p95_bump_seconds) },
                { label: 'Max', value: fmtDuration(a.max_bump_seconds) },
              ].map((k) => (
                <div key={k.label} style={{ background: BRAND.charcoal, padding: '14px', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: `${BRAND.cream}80`, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase' }}>{k.label}</div>
                  <div style={{ fontSize: '1.6rem', color: BRAND.gold, fontFamily: "'Oswald', sans-serif", marginTop: '4px' }}>{k.value}</div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '8px' }}>Volume by hour (UTC)</div>
              {a.hourly.length === 0 ? (
                <div style={{ color: `${BRAND.cream}60`, padding: '20px', textAlign: 'center' }}>No bumps in this window</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '160px', padding: '8px', background: BRAND.charcoal, borderRadius: '8px' }}>
                  {a.hourly.map((b) => {
                    const h = Math.max(4, (b.count / maxBucket) * 140);
                    const hourLabel = b.hour.slice(11, 13);
                    return (
                      <div key={b.hour} title={`${b.hour}\n${b.count} orders, avg ${fmtDuration(b.avg_bump_seconds)}`}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                          <div style={{ width: '100%', height: `${h}px`, background: BRAND.gold, borderRadius: '4px 4px 0 0' }} />
                        </div>
                        <div style={{ fontSize: '0.65rem', color: `${BRAND.cream}80`, fontFamily: 'monospace' }}>{hourLabel}</div>
                        <div style={{ fontSize: '0.7rem', color: BRAND.bone, fontFamily: "'Oswald', sans-serif" }}>{b.count}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '8px' }}>Top items shipped</div>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Item</th><th style={{ ...styles.th, textAlign: 'right' }}>Count</th></tr></thead>
                <tbody>
                  {a.top_items.length === 0 && (<tr><td colSpan={2} style={{ ...styles.td, textAlign: 'center', color: `${BRAND.cream}60` }}>No items</td></tr>)}
                  {a.top_items.map((it) => (
                    <tr key={it.name}>
                      <td style={styles.td}>{it.name}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontFamily: "'Oswald', sans-serif" }}>{it.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderMaintenanceTab() {
    const m = maintStats;
    return (
      <div style={styles.panel}>
        <p style={{ color: BRAND.cream, marginTop: 0 }}>
          Periodic cleanup keeps the DB lean. Webhook logs accumulate fast; old bumped/cancelled orders move to a separate archive table.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
          {[
            { label: 'Active orders', value: m?.orders_count ?? '—' },
            { label: 'Archived orders', value: m?.archive_count ?? '—' },
            { label: 'Webhook log rows', value: m?.webhook_log_count ?? '—' },
            { label: 'Oldest order', value: m?.oldest_order_at ? timeAgo(m.oldest_order_at) : '—' },
            { label: 'Oldest log', value: m?.oldest_webhook_log_at ? timeAgo(m.oldest_webhook_log_at) : '—' },
          ].map((k) => (
            <div key={k.label} style={{ background: BRAND.charcoal, padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '0.7rem', color: `${BRAND.cream}80`, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase' }}>{k.label}</div>
              <div style={{ fontSize: '1.4rem', color: BRAND.gold, fontFamily: "'Oswald', sans-serif", marginTop: '4px' }}>
                {typeof k.value === 'number' ? k.value.toLocaleString() : k.value}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
          <button style={styles.btnSecondary} onClick={loadMaintenance} disabled={maintBusy}>{maintBusy ? '...' : 'Refresh stats'}</button>
          {maintMsg && (<span style={{ color: maintMsg.startsWith('Error') ? BRAND.red : BRAND.green, fontSize: '0.85rem', alignSelf: 'center' }}>{maintMsg}</span>)}
        </div>
        <div style={{ background: BRAND.charcoal, padding: '16px', borderRadius: '8px', marginBottom: '12px' }}>
          <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '8px' }}>Purge webhook logs</div>
          <div style={{ color: `${BRAND.cream}99`, fontSize: '0.85rem', marginBottom: '12px' }}>Permanently delete webhook log rows older than the retention window. This cannot be undone.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ fontSize: '0.85rem', color: BRAND.cream }}>Keep days:</label>
            <input type="number" min={1} max={365} style={{ ...styles.input, marginBottom: 0, width: '100px' }}
              value={logRetentionDays} onChange={(e) => setLogRetentionDays(parseInt(e.target.value, 10) || 30)} />
            <button style={styles.btn} disabled={maintBusy}
              onClick={() => { if (confirm(`Permanently delete webhook log rows older than ${logRetentionDays} days?`)) runMaintenance('purge_logs', logRetentionDays); }}>
              Purge logs
            </button>
          </div>
        </div>
        <div style={{ background: BRAND.charcoal, padding: '16px', borderRadius: '8px' }}>
          <div style={{ color: BRAND.gold, fontFamily: "'Oswald', sans-serif", letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '8px' }}>Archive old orders</div>
          <div style={{ color: `${BRAND.cream}99`, fontSize: '0.85rem', marginBottom: '12px' }}>Moves bumped/cancelled orders older than the retention window from <code>lc_orders</code> to <code>lc_orders_archive</code>. Active orders are never archived.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ fontSize: '0.85rem', color: BRAND.cream }}>Keep days:</label>
            <input type="number" min={1} max={365} style={{ ...styles.input, marginBottom: 0, width: '100px' }}
              value={orderRetentionDays} onChange={(e) => setOrderRetentionDays(parseInt(e.target.value, 10) || 7)} />
            <button style={styles.btn} disabled={maintBusy}
              onClick={() => { if (confirm(`Archive bumped/cancelled orders older than ${orderRetentionDays} days?`)) runMaintenance('archive_orders', orderRetentionDays); }}>
              Archive now
            </button>
          </div>
        </div>
        <div style={{ marginTop: '20px', padding: '12px', background: `${BRAND.gold}10`, borderLeft: `3px solid ${BRAND.gold}`, borderRadius: '4px', fontSize: '0.8rem', color: BRAND.cream }}>
          <strong>Tip:</strong> if pg_cron is enabled, schedule <code>SELECT lc_purge_old_logs(30);</code> and <code>SELECT lc_archive_orders(7);</code> daily so this never piles up.
        </div>
      </div>
    );
  }

  const tabRenderers = { Menu: renderMenuTab, Sides: renderSidesTab, Tips: renderTipsTab, 'Hold Times': renderHoldTimesTab, Settings: renderSettingsTab, Devices: renderDevicesTab, Webhooks: renderWebhooksTab, Analytics: renderAnalyticsTab, Maintenance: renderMaintenanceTab };

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
