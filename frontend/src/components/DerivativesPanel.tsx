import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api.js';
import { createChart, type IChartApi, type Time, type UTCTimestamp } from 'lightweight-charts';

export interface OpenInterestPoint { openInterest: string; timestamp: string; }
export interface FundingPoint { fundingRate: string; fundingRateTimestamp: string; }
export interface DerivativesPayload {
  symbol: string;
  ticker: { openInterest?: string; fundingRate?: string; nextFundingTime?: string; markPrice?: string } | null;
  openInterest: OpenInterestPoint[];
  fundingHistory: FundingPoint[];
  fetchedAt: number;
}

export default function DerivativesPanel({ symbol, onSnapshot }: { symbol: string; onSnapshot?: (payload: DerivativesPayload | null) => void }) {
  const [payload, setPayload] = useState<DerivativesPayload | null>(null);
  const [error, setError] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    const load = async () => {
      try {
        const response = await fetch(apiUrl(`/api/derivatives?symbol=${encodeURIComponent(symbol)}`));
        if (!response.ok) throw new Error('Derivatives data unavailable');
        const result = await response.json() as DerivativesPayload;
        if (!cancelled) { setPayload(result); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [symbol]);

  useEffect(() => { onSnapshot?.(payload); }, [payload, onSnapshot]);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || !payload) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 220,
      layout: { background: { color: '#0b0e14' }, textColor: '#94a3b8', attributionLogo: false },
      grid: { vertLines: { color: '#171c26' }, horzLines: { color: '#171c26' } },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true, tickMarkFormatter: (time: Time) =>
        new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .format(new Date((time as number) * 1000))
      }
    });
    const series = chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, title: 'Open Interest' });
    const data = payload.openInterest.map((point) => ({
      time: Math.floor(Number(point.timestamp) / 1000) as UTCTimestamp,
      value: Number(point.openInterest)
    })).filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value)).sort((a, b) => a.time - b.time);
    if (data.length) series.setData(data);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; };
  }, [payload]);

  const rate = Number(payload?.ticker?.fundingRate);
  const nextFunding = Number(payload?.ticker?.nextFundingTime);
  return (
    <section style={{ marginTop: 16, background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #1f2937', color: '#cbd5e1', fontSize: 13, fontWeight: 700 }}>
        <span>OPEN INTEREST & FUNDING · {symbol}</span>
        <span style={{ color: error ? '#fb7185' : '#64748b', fontSize: 11 }}>{error ? 'Feed unavailable' : 'Bybit · refreshed each minute'}</span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(180px, 1fr)', gap: 12, padding: 12 }}>
        <div>
          <div style={{ color: '#64748b', fontSize: 10, marginBottom: 4 }}>OPEN INTEREST · 5-MIN HISTORY</div>
          <div ref={chartContainerRef} style={{ width: '100%', height: 220 }} />
        </div>
        <div style={{ display: 'grid', alignContent: 'start', gap: 8 }}>
          <div style={{ padding: 12, background: '#111827', borderRadius: 5 }}>
            <div style={{ color: '#64748b', fontSize: 10 }}>CURRENT OPEN INTEREST</div>
            <div style={{ color: '#e2e8f0', fontFamily: 'monospace', fontSize: 15, marginTop: 6 }}>
              {payload?.ticker?.openInterest ? Number(payload.ticker.openInterest).toLocaleString('en-US', { maximumFractionDigits: 3 }) : '—'}
            </div>
          </div>
          <div style={{ padding: 12, background: '#111827', borderRadius: 5 }}>
            <div style={{ color: '#64748b', fontSize: 10 }}>LATEST FUNDING RATE</div>
            <div style={{ color: Number.isFinite(rate) && rate >= 0 ? '#34d399' : '#fb7185', fontFamily: 'monospace', fontSize: 15, marginTop: 6 }}>
              {Number.isFinite(rate) ? `${(rate * 100).toFixed(5)}%` : '—'}
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 5 }}>
              Next: {Number.isFinite(nextFunding) && nextFunding > 0
                ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nextFunding))
                : '—'} IST
            </div>
          </div>
          <div style={{ color: '#64748b', fontSize: 10, lineHeight: 1.5 }}>
            Historical points are from Bybit. The line may have gaps where the exchange has no record.
          </div>
        </div>
      </div>
    </section>
  );
}
