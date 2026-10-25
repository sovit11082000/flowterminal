import { useEffect, useMemo, useState } from 'react';

type AlertRule = { id: string; type: 'price' | 'delta'; threshold: number };
const storageKey = (symbol: string) => `flowterminal_alerts_${symbol}`;

export default function AlertManager({ symbol, price, delta }: { symbol: string; price: number | null; delta: number | null }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [priceInput, setPriceInput] = useState('');
  const [deltaInput, setDeltaInput] = useState('');
  const [notice, setNotice] = useState('');
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const previousPrice = useMemo(() => ({ current: null as number | null }), [symbol]);
  const previousDelta = useMemo(() => ({ current: null as number | null }), [symbol]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(symbol)) ?? '[]') as AlertRule[];
      setRules(Array.isArray(saved) ? saved : []);
    } catch { setRules([]); }
    setPermission('Notification' in window ? Notification.permission : 'unsupported');
  }, [symbol]);

  useEffect(() => {
    localStorage.setItem(storageKey(symbol), JSON.stringify(rules));
  }, [rules, symbol]);

  useEffect(() => {
    const triggered = rules.filter((rule) => {
      if (rule.type === 'price' && price !== null && previousPrice.current !== null) {
        return (previousPrice.current < rule.threshold && price >= rule.threshold) ||
          (previousPrice.current > rule.threshold && price <= rule.threshold);
      }
      if (rule.type === 'delta' && delta !== null && previousDelta.current !== null) {
        return Math.abs(delta) >= rule.threshold && Math.abs(previousDelta.current) < rule.threshold;
      }
      return false;
    });
    if (triggered.length) {
      const messages = triggered.map((rule) => rule.type === 'price'
        ? `${symbol} touched ${rule.threshold}`
        : `${symbol} bar delta reached ${rule.threshold}`);
      setNotice(messages.join(' · '));
      if (permission === 'granted') {
        for (const message of messages) new Notification('FlowTerminal alert', { body: message });
      }
      const ids = new Set(triggered.map((rule) => rule.id));
      setRules((current) => current.filter((rule) => !ids.has(rule.id)));
    }
    if (price !== null) previousPrice.current = price;
    if (delta !== null) previousDelta.current = delta;
  }, [symbol, price, delta, rules, permission, previousPrice, previousDelta]);

  const enableNotifications = async () => {
    if (!('Notification' in window)) { setPermission('unsupported'); return; }
    const result = await Notification.requestPermission();
    setPermission(result);
  };
  const addRule = async (type: AlertRule['type'], raw: string) => {
    const threshold = Number(raw);
    if (!Number.isFinite(threshold) || threshold <= 0) return;
    if (permission === 'default') await enableNotifications();
    setRules((current) => [...current, { id: crypto.randomUUID(), type, threshold }]);
    if (type === 'price') setPriceInput(''); else setDeltaInput('');
    setNotice('Alert saved on this browser.');
  };

  return (
    <details style={{ marginTop: 12, background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, color: '#cbd5e1' }}>
      <summary style={{ cursor: 'pointer', padding: '9px 12px', fontSize: 12, fontWeight: 700 }}>PRICE & DELTA ALERTS · {rules.length} armed · click to set alerts</summary>
      <div style={{ padding: '0 12px 10px', color: '#94a3b8', fontSize: 10, lineHeight: 1.6 }}>
        Price touch = one-time alert when the live candle price crosses your level. Delta spike = one-time alert when the current candle’s absolute buy-minus-sell volume first reaches your threshold. Alerts are saved in this browser and only monitor while this page is open.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '0 12px 10px' }}>
        <label style={{ color: '#94a3b8', fontSize: 10 }}>Price level ({price === null ? 'waiting for price' : `now ${price}`})</label>
        <input value={priceInput} onChange={(event) => setPriceInput(event.target.value)} type="number" placeholder="e.g. 82000" style={{ width: 120, background: '#111827', color: '#e2e8f0', border: '1px solid #334155', padding: 6, borderRadius: 4 }} />
        <button onClick={() => void addRule('price', priceInput)} style={{ background: '#1e293b', color: '#e2e8f0', border: 0, padding: 7, borderRadius: 4, cursor: 'pointer' }}>Add price alert</button>
        <label style={{ color: '#94a3b8', fontSize: 10 }}>Absolute bar delta ({delta === null ? 'waiting for footprint' : `now ${delta}`})</label>
        <input value={deltaInput} onChange={(event) => setDeltaInput(event.target.value)} type="number" min="0" placeholder="e.g. 5 BTC" style={{ width: 120, background: '#111827', color: '#e2e8f0', border: '1px solid #334155', padding: 6, borderRadius: 4 }} />
        <button onClick={() => void addRule('delta', deltaInput)} style={{ background: '#1e293b', color: '#e2e8f0', border: 0, padding: 7, borderRadius: 4, cursor: 'pointer' }}>Add delta alert</button>
        <span style={{ color: '#64748b', fontSize: 10 }}>Browser notifications: {permission}</span>
        {notice && <span style={{ color: '#fbbf24', fontSize: 11 }}>{notice}</span>}
        {rules.map((rule) => (
          <button key={rule.id} onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))} style={{ background: '#172033', color: '#cbd5e1', border: '1px solid #334155', padding: '5px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
            {rule.type} {rule.threshold} ×
          </button>
        ))}
      </div>
    </details>
  );
}
