import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api.js';

interface RecorderSnapshot {
  marketStatus?: string;
  lastTradeReceivedAt?: number | null;
  memory?: { heapUsedMb: number; rssMb: number };
  trades: { trades: number; symbols: string[]; oldestTime: number | null; newestTime: number | null };
  orderBook: { samples: number; symbols: string[]; oldestTime: number | null; newestTime: number | null; sampleIntervalMs: number };
  footprints: { bars: number; oneMinuteBars: number; fiveMinuteBars: number; symbols: string[]; oldestTime: number | null; newestTime: number | null };
  storage?: { provider: 'mongodb' | 'local'; mongoCounts: { footprints: number; footprints1m?: number; footprints5m?: number; latestFootprintTime?: number | null; trades: number; orderBooks: number; liquidations: number } | null };
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

  const feedAgeSeconds = status?.lastTradeReceivedAt ? Math.max(0, Math.round((Date.now() - status.lastTradeReceivedAt) / 1000)) : null;
  const feedIsFresh = feedAgeSeconds !== null && feedAgeSeconds < 60 && status?.marketStatus === 'LIVE';
  const mongo = status?.storage?.mongoCounts;
  const latestFootprintTime = mongo?.latestFootprintTime ?? status?.footprints?.newestTime ?? null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 12px', padding: '8px 12px', background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, color: '#94a3b8', fontSize: 11 }}>
      <strong style={{ color: '#cbd5e1' }}>RECORDER STATUS</strong>
      <span style={{ color: !status ? '#fbbf24' : feedIsFresh ? '#34d399' : '#fbbf24' }}>
        {!status ? '○ Waiting for backend' : feedAgeSeconds === null ? '○ Waiting for trades' : feedIsFresh ? `● Feed live · ${feedAgeSeconds}s ago` : `● Feed stale · last trade ${feedAgeSeconds}s ago`}
      </span>
      <span style={{ color: status?.storage?.provider === 'mongodb' ? '#34d399' : '#fbbf24' }}>
        {status?.storage?.provider === 'mongodb' && mongo
          ? `MongoDB · ${mongo.trades.toLocaleString()} trades · ${mongo.orderBooks.toLocaleString()} books · ${mongo.footprints.toLocaleString()} footprint bars (1m ${mongo.footprints1m?.toLocaleString() ?? '—'} / 5m ${mongo.footprints5m?.toLocaleString() ?? '—'})`
          : 'MongoDB not connected'}
      </span>
      <span style={{ color: '#64748b' }}>{latestFootprintTime ? `Latest saved footprint ${new Date(latestFootprintTime * 1000).toLocaleString('en-IN')}` : 'No closed footprint bar saved yet'} · footprints record on 1m / 5m only.</span>
      <span style={{ color: '#64748b' }}>RAM cache {status?.trades.trades.toLocaleString() ?? 0} trades · {status?.orderBook.samples.toLocaleString() ?? 0} book samples · {status?.footprints.bars.toLocaleString() ?? 0} footprints · heap {status?.memory?.heapUsedMb ?? '—'} MB</span>
    </div>
  );
}
