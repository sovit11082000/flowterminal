import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api.js';

interface RecorderSnapshot {
  trades: { trades: number; symbols: string[]; oldestTime: number | null; newestTime: number | null };
  orderBook: { samples: number; symbols: string[]; oldestTime: number | null; newestTime: number | null; sampleIntervalMs: number };
  footprints: { bars: number; oneMinuteBars: number; fiveMinuteBars: number; symbols: string[]; oldestTime: number | null; newestTime: number | null };
  storage?: { provider: 'mongodb' | 'local'; mongoCounts: { footprints: number; trades: number; orderBooks: number; liquidations: number } | null };
}

export default function RecorderStatus() {
  const [status, setStatus] = useState<RecorderSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(apiUrl('/api/recorder/status'));
        if (!response.ok) return;
        const snapshot = await response.json() as RecorderSnapshot;
        if (!cancelled) setStatus(snapshot);
      } catch { /* Gateway is not available yet. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const hasSamples = (status?.trades.trades ?? 0) > 0 || (status?.orderBook.samples ?? 0) > 0 || (status?.footprints?.bars ?? 0) > 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 12px', padding: '8px 12px', background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, color: '#94a3b8', fontSize: 11 }}>
      <strong style={{ color: '#cbd5e1' }}>LOCAL RECORDER</strong>
      <span style={{ color: hasSamples ? '#34d399' : '#fbbf24' }}>{!status ? '○ Waiting for backend' : hasSamples ? '● Recording' : '○ Waiting for first data'}</span>
      <span>{(status?.trades.trades ?? 0).toLocaleString()} trades stored</span>
      <span>{(status?.footprints?.bars ?? 0).toLocaleString()} footprint bars · 1m {(status?.footprints?.oneMinuteBars ?? 0).toLocaleString()} / 5m {(status?.footprints?.fiveMinuteBars ?? 0).toLocaleString()}</span>
      <span>{(status?.orderBook.samples ?? 0).toLocaleString()} order-book samples</span>
      <span style={{ color: status?.storage?.provider === 'mongodb' ? '#34d399' : '#fbbf24' }}>
        {status?.storage?.provider === 'mongodb' && status.storage.mongoCounts
          ? `MongoDB · ${status.storage.mongoCounts.trades.toLocaleString()} trades · ${status.storage.mongoCounts.orderBooks.toLocaleString()} book samples · ${status.storage.mongoCounts.footprints.toLocaleString()} footprints`
          : 'MongoDB not connected'}
      </span>
      <span>Book sample interval: {status?.orderBook.sampleIntervalMs ?? 500} ms</span>
      <span style={{ color: '#64748b' }}>{status?.footprints?.newestTime ? `Latest footprint ${new Date(status.footprints.newestTime * 1000).toLocaleString('en-IN')}` : 'Waiting for first closed footprint bar'} · Rolling local history.</span>
    </div>
  );
}
