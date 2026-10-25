import { useMemo, useState } from 'react';
import type { Trade, SerializedFootprintBar } from '../types/market.js';
import type { BookLevel } from './DOMLadder.js';
import type { SignalCandle } from './EntryExitSignalEngine.js';
import { calculateVolumeProfile } from './VolumeProfileCalculator.js';
import type { SmartMoneyAnalysis } from './SmartMoneyOverlay.js';

interface SpecialistReport { agentId: string; name: string; bias: 'LONG' | 'SHORT' | 'NEUTRAL'; strength: number; findings: string[]; concerns: string[]; missingData: string[]; }
interface CouncilPlan { decision: 'LONG' | 'SHORT' | 'WAIT'; summary: string; entryTrigger: string; invalidation: string; exitPlan: string; agreeingAgents: string[]; dissent: string[]; }
interface CouncilResult {
  reports: SpecialistReport[]; plan: CouncilPlan; model: string; generatedAt: number;
  paperPlanSaved?: boolean;
  paperPerformance?: { resolved: number; wins: number; losses: number; expired: number; winRate: number | null; averageR: number | null } | null;
}
const priceFormat = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export default function AgentCouncilPanel({ symbol, timeframe, feedStatus, lastTradeAt, price, candles, footprints, trades, bids, asks, analysis }: {
  symbol: string; timeframe: '1m' | '5m'; feedStatus: string; lastTradeAt: number | null; price: number | null;
  candles: SignalCandle[]; footprints: SerializedFootprintBar[]; trades: Trade[]; bids: BookLevel[]; asks: BookLevel[];
  analysis: SmartMoneyAnalysis;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CouncilResult | null>(null);
  const [analyzedPrice, setAnalyzedPrice] = useState<number | null>(null);
  // DESYNCHRONIZED is currently used for an order-book reset; fresh public
  // trades can still be valid, but the agent must treat DOM evidence as absent.
  const feedLive = (feedStatus === 'LIVE' || feedStatus === 'DESYNCHRONIZED') && lastTradeAt !== null && Date.now() - lastTradeAt < 15_000;
  const profile = useMemo(() => {
    const closed = footprints.filter((bar) => bar.isClosed);
    if (!closed.length) return null;
    const calculated = calculateVolumeProfile(closed, symbol, closed[0].time, closed[closed.length - 1].time);
    return calculated ? { poc: calculated.poc, vah: calculated.vah, val: calculated.val, capturedBars: calculated.capturedBars } : null;
  }, [footprints, symbol]);
  const levels = useMemo(() => {
    if (!result || !analyzedPrice || result.plan.decision === 'WAIT') return null;
    const recent = candles.slice(-5);
    if (recent.length < 2) return null;
    const isLong = result.plan.decision === 'LONG';
    const stop = isLong ? Math.min(...recent.map((bar) => bar.low)) : Math.max(...recent.map((bar) => bar.high));
    const risk = Math.abs(analyzedPrice - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const direction = isLong ? 1 : -1;
    return { entry: analyzedPrice, stop, target1: analyzedPrice + direction * risk, target2: analyzedPrice + direction * risk * 2 };
  }, [result, analyzedPrice, candles]);

  const analyze = async () => {
    if (!feedLive || loading) return;
    setLoading(true); setError(''); setResult(null);
    const snapshot = {
      symbol, timeframe, feedStatus, lastTradeAt, latestPrice: price, profile,
      candles: candles.slice(-200),
      technicalContext: {
        smc: {
          bias: analysis.bias,
          events: analysis.events.slice(-80).map(({ type, time, price: level, bullish }) => ({ type, time, price: level, bullish })),
          zones: analysis.zones.slice(-30).map(({ kind, startTime, endTime, top, bottom, bullish }) => ({ kind, startTime, endTime, top, bottom, bullish })),
          liquidity: analysis.liquidity.slice(-30).map(({ label, time, price: level, swept }) => ({ label, time, price: level, swept }))
        },
        ict: {
          po3: analysis.po3.slice(-24),
          dailyRanges: [...analysis.dailyRanges.entries()].slice(-31).map(([day, range]) => ({ day, ...range }))
        }
      },
      footprints: footprints.filter((bar) => bar.isClosed).slice(-6).map((bar) => ({
        ...bar,
        priceLevels: [...bar.priceLevels].sort((a, b) => Math.abs(a.price - bar.pocPrice) - Math.abs(b.price - bar.pocPrice)).slice(0, 24)
      })),
      trades: trades.slice(0, 20).map(({ timestamp, side, price: tradePrice, size }) => ({ timestamp, side, price: tradePrice, size })),
      bids: bids.slice(0, 10), asks: asks.slice(0, 10)
    };
    try {
      const response = await fetch('http://localhost:4000/api/agents/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot)
      });
      const data = await response.json() as CouncilResult | { error?: string };
      if (!response.ok) throw new Error(('error' in data && data.error) || `Agent service error (${response.status}).`);
      setResult(data as CouncilResult);
      setAnalyzedPrice(price);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the local agent manager.');
    } finally { setLoading(false); }
  };

  const decisionColor = result?.plan.decision === 'LONG' ? '#34d399' : result?.plan.decision === 'SHORT' ? '#fb7185' : '#fbbf24';
  return <section style={{ marginTop: 12, border: '1px solid #334155', borderRadius: 6, background: '#0b0e14', color: '#cbd5e1', overflow: 'hidden' }}>
    <header style={{ padding: '10px 12px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div><strong style={{ fontSize: 12 }}>SMC · ICT · ORDER-FLOW COUNCIL · {symbol}</strong><div style={{ marginTop: 4, color: '#64748b', fontSize: 10 }}>3 independent specialists → manager decision · all 3 must agree or WAIT</div></div>
      <button disabled={!feedLive || loading} onClick={() => void analyze()} style={{ background: !feedLive || loading ? '#1e293b' : '#075985', color: '#e0f2fe', border: '1px solid #0369a1', borderRadius: 4, padding: '7px 11px', cursor: !feedLive || loading ? 'not-allowed' : 'pointer', opacity: !feedLive || loading ? 0.6 : 1 }}>
        {loading ? 'Agents analyzing…' : result ? 'Analyze again' : 'Analyze order flow'}
      </button>
    </header>
    {!feedLive && <div style={{ padding: 10, color: '#fbbf24', fontSize: 11 }}>Live trade feed is stale or disconnected. Agent analysis is disabled.</div>}
    {feedLive && feedStatus === 'DESYNCHRONIZED' && <div style={{ padding: 10, color: '#fbbf24', fontSize: 11 }}>Trade feed is live; order book is desynchronized. The analysts will be told to ignore DOM evidence until it resynchronizes.</div>}
    {error && <div style={{ padding: 10, color: '#fca5a5', fontSize: 11 }}>{error}</div>}
    {loading && <div style={{ padding: 10, color: '#93c5fd', fontSize: 11 }}>SMC, ICT, and order-flow specialists are analyzing separately; then the manager reviews their reports. A project quota limit moves that role to its next configured credential.</div>}
    {result && <>
      <div style={{ padding: 12, borderBottom: '1px solid #1f2937' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ color: decisionColor, fontSize: 16 }}>{result.plan.decision}</strong>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{result.plan.summary}</span>
        </div>
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 7, fontSize: 10 }}>
          <div><b style={{ color: '#7dd3fc' }}>Entry trigger</b><div>{result.plan.entryTrigger}</div></div>
          <div><b style={{ color: '#fb7185' }}>Invalidation</b><div>{result.plan.invalidation}</div></div>
          <div><b style={{ color: '#34d399' }}>Exit plan</b><div>{result.plan.exitPlan}</div></div>
        </div>
        {levels && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 9, fontSize: 11 }}>
          <span>Analysis price <b>{priceFormat(levels.entry)}</b></span><span>Structure stop <b style={{ color: '#fb7185' }}>{priceFormat(levels.stop)}</b></span>
          <span>1R <b>{priceFormat(levels.target1)}</b></span><span>2R <b style={{ color: '#34d399' }}>{priceFormat(levels.target2)}</b></span>
        </div>}
        {result.plan.decision !== 'WAIT' && !levels && <div style={{ color: '#fbbf24', fontSize: 10, marginTop: 7 }}>Manager has a directional view, but recent candle structure is insufficient to calculate a safe sample stop. Treat this as WAIT.</div>}
        <div style={{ marginTop: 7, color: '#64748b', fontSize: 9 }}>Run {new Date(result.generatedAt).toLocaleTimeString('en-IN')} · {result.model} · {result.plan.agreeingAgents.length}/3 aligned specialist reports · AI plan is paper research only.</div>
        {result.paperPlanSaved && <div style={{ marginTop: 6, color: '#93c5fd', fontSize: 10 }}>Paper plan saved to MongoDB. A later closed candle must touch entry and close in the planned direction to count as filled; if stop and target both fit in one candle, scoring counts the stop first. This candle-based replay approximates the written trigger.</div>}
        {result.paperPerformance && <div style={{ marginTop: 5, color: '#94a3b8', fontSize: 10 }}>Prior AI paper outcomes · {result.paperPerformance.resolved} resolved · {result.paperPerformance.wins} wins / {result.paperPerformance.losses} losses / {result.paperPerformance.expired} expired · win rate {result.paperPerformance.winRate === null ? '—' : `${(result.paperPerformance.winRate * 100).toFixed(1)}%`} · average {result.paperPerformance.averageR === null ? '—' : `${result.paperPerformance.averageR.toFixed(2)}R`}. Small samples are not proof; this only gives the manager cautious historical context.</div>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, padding: 10 }}>
        {result.reports.map((report) => <article key={report.agentId} style={{ border: '1px solid #1f2937', borderRadius: 4, padding: 8, background: '#0f1724' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10 }}><b>{report.name}</b><strong style={{ color: report.bias === 'LONG' ? '#34d399' : report.bias === 'SHORT' ? '#fb7185' : '#94a3b8' }}>{report.bias} · {report.strength}/3</strong></div>
          {report.findings.map((item, index) => <div key={`f${index}`} style={{ marginTop: 5, fontSize: 10, color: '#cbd5e1' }}>• {item}</div>)}
          {report.concerns.map((item, index) => <div key={`c${index}`} style={{ marginTop: 4, fontSize: 9, color: '#fbbf24' }}>Concern: {item}</div>)}
          {report.missingData.length > 0 && <div style={{ marginTop: 4, fontSize: 9, color: '#94a3b8' }}>Missing: {report.missingData.join(', ')}</div>}
        </article>)}
      </div>
    </>}
    {!result && !loading && !error && <div style={{ padding: 10, color: '#94a3b8', fontSize: 10 }}>Press Analyze to request separate SMC, ICT, and order-flow reads. The manager creates a directional paper plan only when all three agree; otherwise it returns WAIT. No automatic API calls run on each tick.</div>}
    <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 9 }}>Each role uses its own backend credential pool. Quotas are tracked per project; keys in the same project share its quota. News analysis is not included until a real news feed is connected. No Bybit order key or automatic order execution.</div>
  </section>;
}
