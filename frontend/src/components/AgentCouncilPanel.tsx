import { useMemo, useState, useEffect } from 'react';
import { apiUrl } from '../lib/api.js';
import type { Trade, SerializedFootprintBar } from '../types/market.js';
import type { BookLevel } from './DOMLadder.js';
import type { SignalCandle } from './EntryExitSignalEngine.js';
import { calculateVolumeProfile } from './VolumeProfileCalculator.js';
import type { SmartMoneyAnalysis } from './SmartMoneyOverlay.js';

interface SpecialistReport {
  agentId: string;
  name: string;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  findings: string[];
  strategyCandidates: string[];
  concerns: string[];
  missingData: string[];
}

interface CouncilPlan {
  decision: 'LONG' | 'SHORT' | 'WAIT';
  summary: string;
  reasons?: string[];
  entryTrigger: string;
  entryPrice: number | null;
  invalidation: string;
  stopPrice: number | null;
  target1Price?: number | null;
  targetPrice: number | null;
  targetR: 2 | 3 | null;
  exitPlan: string;
  agreeingAgents: string[];
  dissent: string[];
  strategyIds: string[];
  strategyNames: string[];
}

interface CouncilResult {
  reports: SpecialistReport[];
  plan: CouncilPlan;
  model: string;
  generatedAt: number;
}

const priceFormat = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export default function AgentCouncilPanel({
  symbol,
  timeframe,
  feedStatus,
  lastTradeAt,
  price,
  candles,
  footprints,
  trades,
  bids,
  asks,
  analysis
}: {
  symbol: string;
  timeframe: '1m' | '5m';
  feedStatus: string;
  lastTradeAt: number | null;
  price: number | null;
  candles: SignalCandle[];
  footprints: SerializedFootprintBar[];
  trades: Trade[];
  bids: BookLevel[];
  asks: BookLevel[];
  analysis: SmartMoneyAnalysis;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CouncilResult | null>(null);
  const [analyzedPrice, setAnalyzedPrice] = useState<number | null>(null);
  const [autoTradingActive, setAutoTradingActive] = useState<boolean>(true);
  const [updatingAuto, setUpdatingAuto] = useState<boolean>(false);

  const feedLive =
    feedStatus !== 'DISCONNECTED' &&
    feedStatus !== 'RECONNECTING' &&
    (lastTradeAt === null || Date.now() - lastTradeAt < 45_000);

  // Sync autonomous trading status with backend state
  useEffect(() => {
    let unmounted = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(apiUrl('/api/agents/auto-status'));
        if (res.ok) {
          const data = await res.json() as { autoTrading: boolean };
          if (!unmounted && typeof data.autoTrading === 'boolean') {
            setAutoTradingActive(data.autoTrading);
          }
        }
      } catch {
        // backend offline / connecting
      }
    };
    void fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, []);

  const toggleAutoTrading = async () => {
    setUpdatingAuto(true);
    try {
      const nextState = !autoTradingActive;
      const res = await fetch(apiUrl('/api/agents/toggle-auto'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextState })
      });
      if (res.ok) {
        const data = await res.json() as { autoTrading: boolean };
        setAutoTradingActive(data.autoTrading);
      }
    } catch (err) {
      console.warn('Could not toggle auto trading:', err);
    } finally {
      setUpdatingAuto(false);
    }
  };

  const profile = useMemo(() => {
    const closed = footprints.filter((bar) => bar.isClosed);
    if (!closed.length) return null;
    const calculated = calculateVolumeProfile(
      closed,
      symbol,
      closed[0].time,
      closed[closed.length - 1].time
    );
    return calculated
      ? {
          poc: calculated.poc,
          vah: calculated.vah,
          val: calculated.val,
          capturedBars: calculated.capturedBars
        }
      : null;
  }, [footprints, symbol]);

  const levels = useMemo(() => {
    if (!result || result.plan.decision === 'WAIT') return null;
    const { entryPrice, stopPrice, target1Price, targetPrice, targetR } = result.plan;
    if (
      entryPrice !== null &&
      stopPrice !== null &&
      targetPrice !== null &&
      Number.isFinite(entryPrice) &&
      Number.isFinite(stopPrice) &&
      Number.isFinite(targetPrice)
    ) {
      const risk = Math.abs(entryPrice - stopPrice);
      const direction = result.plan.decision === 'LONG' ? 1 : -1;
      const tp1 =
        target1Price !== undefined && target1Price !== null && Number.isFinite(target1Price)
          ? target1Price
          : entryPrice + direction * risk;
      return {
        entry: entryPrice,
        stop: stopPrice,
        target1: tp1,
        target2: targetPrice,
        targetR: targetR ?? 2
      };
    }
    if (!analyzedPrice) return null;
    const recent = candles.slice(-5);
    if (recent.length < 2) return null;
    const isLong = result.plan.decision === 'LONG';
    const stop = isLong
      ? Math.min(...recent.map((bar) => bar.low))
      : Math.max(...recent.map((bar) => bar.high));
    const risk = Math.abs(analyzedPrice - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const direction = isLong ? 1 : -1;
    return {
      entry: analyzedPrice,
      stop,
      target1: analyzedPrice + direction * risk,
      target2: analyzedPrice + direction * risk * 2,
      targetR: 2
    };
  }, [result, analyzedPrice, candles]);

  const analyze = async () => {
    if (!feedLive || loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    const snapshot = {
      symbol,
      timeframe,
      feedStatus,
      lastTradeAt,
      latestPrice: price,
      profile,
      candles: candles.slice(-200),
      technicalContext: {
        smc: {
          bias: analysis.bias,
          events: analysis.events
            .slice(-80)
            .map(({ type, time, price: level, bullish }) => ({
              type,
              time,
              price: level,
              bullish
            })),
          zones: analysis.zones
            .slice(-30)
            .map(({ kind, startTime, endTime, top, bottom, bullish }) => ({
              kind,
              startTime,
              endTime,
              top,
              bottom,
              bullish
            })),
          liquidity: analysis.liquidity
            .slice(-30)
            .map(({ label, time, price: level, swept }) => ({
              label,
              time,
              price: level,
              swept
            }))
        },
        ict: {
          po3: analysis.po3.slice(-24),
          dailyRanges: [...analysis.dailyRanges.entries()]
            .slice(-31)
            .map(([day, range]) => ({ day, ...range }))
        }
      },
      footprints: footprints
        .filter((bar) => bar.isClosed)
        .slice(-6)
        .map((bar) => ({
          ...bar,
          priceLevels: [...bar.priceLevels]
            .sort((a, b) => Math.abs(a.price - bar.pocPrice) - Math.abs(b.price - bar.pocPrice))
            .slice(0, 24)
        })),
      trades: trades
        .slice(0, 20)
        .map(({ timestamp, side, price: tradePrice, size }) => ({
          timestamp,
          side,
          price: tradePrice,
          size
        })),
      bids: bids.slice(0, 10),
      asks: asks.slice(0, 10)
    };
    try {
      const response = await fetch(apiUrl('/api/agents/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      });
      const data = (await response.json()) as CouncilResult | { error?: string };
      if (!response.ok)
        throw new Error(('error' in data && data.error) || `Agent service error (${response.status}).`);
      setResult(data as CouncilResult);
      setAnalyzedPrice(price);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach agent manager.');
    } finally {
      setLoading(false);
    }
  };

  const decisionColor =
    result?.plan.decision === 'LONG'
      ? '#34d399'
      : result?.plan.decision === 'SHORT'
        ? '#fb7185'
        : '#fbbf24';

  return (
    <section
      style={{
        marginTop: 12,
        border: '1px solid #1e293b',
        borderRadius: 8,
        background: '#0b0e14',
        color: '#cbd5e1',
        overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
      }}
    >
      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #1f2937',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          background: '#0f172a'
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13, letterSpacing: '0.04em', color: '#f8fafc' }}>
              SMC · ICT · ORDER-FLOW COUNCIL · {symbol} ({timeframe})
            </strong>

            {/* BYBIT FEED LIVE / OFFLINE STATUS BADGE */}
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: feedLive ? '#38bdf8' : '#f59e0b',
                background: feedLive ? 'rgba(56, 189, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                border: `1px solid ${feedLive ? '#0284c7' : '#d97706'}`,
                padding: '2px 8px',
                borderRadius: 4
              }}
            >
              {feedLive ? '🟢 BYBIT: LIVE' : '🔴 BYBIT: CONNECTING / PAUSED'}
            </span>

            {/* AUTO TRADING STATUS BADGE */}
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: autoTradingActive ? '#10b981' : '#ef4444',
                background: autoTradingActive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${autoTradingActive ? '#10b981' : '#ef4444'}`,
                padding: '2px 8px',
                borderRadius: 4
              }}
            >
              {autoTradingActive ? '🟢 AUTO TRADER: ACTIVE' : '🔴 AUTO TRADER: PAUSED'}
            </span>
          </div>

          <div style={{ marginTop: 4, color: '#94a3b8', fontSize: 11 }}>
            Runs 24/7. Auto trade alerts, live Bybit tracking, and post-mortem learning stream to Telegram.
          </div>
        </div>

        {/* CONTROLS (AUTO TOGGLE + MANUAL ANALYZE) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            disabled={updatingAuto}
            onClick={() => void toggleAutoTrading()}
            style={{
              background: autoTradingActive ? '#991b1b' : '#065f46',
              color: '#ffffff',
              border: `1px solid ${autoTradingActive ? '#dc2626' : '#10b981'}`,
              borderRadius: 5,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 700,
              cursor: updatingAuto ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s ease'
            }}
          >
            {updatingAuto
              ? 'Updating...'
              : autoTradingActive
                ? '⏸️ PAUSE AUTO'
                : '▶️ RESUME AUTO'}
          </button>

          <button
            disabled={!feedLive || loading}
            onClick={() => void analyze()}
            style={{
              background: !feedLive || loading ? '#1e293b' : '#0284c7',
              color: '#f0f9ff',
              border: '1px solid #0369a1',
              borderRadius: 5,
              padding: '6px 14px',
              fontSize: 11,
              fontWeight: 600,
              cursor: !feedLive || loading ? 'not-allowed' : 'pointer',
              opacity: !feedLive || loading ? 0.6 : 1
            }}
          >
            {loading ? 'Analyzing…' : '🔍 Analyze Now'}
          </button>
        </div>
      </header>

      {!feedLive && (
        <div style={{ padding: '8px 14px', background: '#451a03', color: '#fde68a', fontSize: 11 }}>
          ⚠️ Bybit feed connecting or waiting for next trade block. Auto trader standing by.
        </div>
      )}
      {error && (
        <div style={{ padding: '8px 14px', background: '#450a0a', color: '#fca5a5', fontSize: 11 }}>
          {error}
        </div>
      )}
      {loading && (
        <div style={{ padding: '8px 14px', background: '#082f49', color: '#bae6fd', fontSize: 11 }}>
          SMC, ICT, and Order-Flow specialists are analyzing in parallel; Manager synthesizing plan…
        </div>
      )}

      {result && (
        <>
          <div style={{ padding: 14, borderBottom: '1px solid #1f2937' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  background:
                    result.plan.decision === 'LONG'
                      ? 'rgba(52, 211, 153, 0.15)'
                      : result.plan.decision === 'SHORT'
                        ? 'rgba(251, 113, 133, 0.15)'
                        : 'rgba(251, 191, 36, 0.15)',
                  border: `1px solid ${decisionColor}`,
                  color: decisionColor,
                  padding: '3px 10px',
                  borderRadius: 4,
                  fontWeight: 700,
                  fontSize: 14
                }}
              >
                {result.plan.decision}
              </span>
              <span style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
                {result.plan.summary}
              </span>
            </div>

            {levels && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 16,
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 6,
                  background: '#0f1724',
                  border: '1px solid #1e293b',
                  fontSize: 11
                }}
              >
                <span>
                  Entry Price: <b style={{ color: '#fbbf24' }}>{priceFormat(levels.entry)}</b>
                </span>
                <span>
                  Stop Loss (SL): <b style={{ color: '#fb7185' }}>{priceFormat(levels.stop)}</b>
                </span>
                <span>
                  TP1 (1R): <b style={{ color: '#86efac' }}>{priceFormat(levels.target1)}</b>
                </span>
                <span>
                  Final Target ({levels.targetR}R):{' '}
                  <b style={{ color: '#34d399' }}>{priceFormat(levels.target2)}</b>
                </span>
              </div>
            )}

            {result.plan.reasons && result.plan.reasons.length > 0 && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'rgba(15, 23, 36, 0.7)',
                  border: '1px solid #1e293b',
                  fontSize: 11
                }}
              >
                <b style={{ color: '#38bdf8', fontSize: 11 }}>
                  Manager Confluence Reasons:
                </b>
                {result.plan.reasons.map((reason, idx) => (
                  <div key={`r${idx}`} style={{ marginTop: 4, color: '#cbd5e1' }}>
                    • {reason}
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: 10,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: 8,
                fontSize: 10
              }}
            >
              <div style={{ padding: 8, background: '#0f1724', borderRadius: 4, border: '1px solid #1e293b' }}>
                <b style={{ color: '#7dd3fc' }}>Entry Trigger</b>
                <div style={{ marginTop: 3 }}>{result.plan.entryTrigger}</div>
              </div>
              <div style={{ padding: 8, background: '#0f1724', borderRadius: 4, border: '1px solid #1e293b' }}>
                <b style={{ color: '#fb7185' }}>Invalidation (SL)</b>
                <div style={{ marginTop: 3 }}>{result.plan.invalidation}</div>
              </div>
              <div style={{ padding: 8, background: '#0f1724', borderRadius: 4, border: '1px solid #1e293b' }}>
                <b style={{ color: '#34d399' }}>Exit Plan</b>
                <div style={{ marginTop: 3 }}>{result.plan.exitPlan}</div>
              </div>
            </div>

            {result.plan.strategyIds.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: 8,
                  border: '1px solid #334155',
                  borderRadius: 4,
                  background: '#0f1724',
                  fontSize: 10
                }}
              >
                <b style={{ color: '#c4b5fd' }}>Matched Confluence Strategies:</b>
                <div style={{ marginTop: 4 }}>
                  {result.plan.strategyIds.map((id, index) => (
                    <span key={id} style={{ marginRight: 12 }}>
                      <b style={{ color: '#38bdf8' }}>{id}</b> {result.plan.strategyNames[index] ?? ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 8,
              padding: 12
            }}
          >
            {result.reports.map((report) => (
              <article
                key={report.agentId}
                style={{
                  border: '1px solid #1f2937',
                  borderRadius: 6,
                  padding: 10,
                  background: '#0f1724'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 6,
                    fontSize: 11
                  }}
                >
                  <b>{report.name}</b>
                  <strong
                    style={{
                      color:
                        report.bias === 'LONG'
                          ? '#34d399'
                          : report.bias === 'SHORT'
                            ? '#fb7185'
                            : '#94a3b8'
                    }}
                  >
                    {report.bias} · {report.strength}/3
                  </strong>
                </div>
                {report.findings.map((item, index) => (
                  <div key={`f${index}`} style={{ marginTop: 5, fontSize: 10, color: '#cbd5e1' }}>
                    • {item}
                  </div>
                ))}
                {report.concerns.map((item, index) => (
                  <div key={`c${index}`} style={{ marginTop: 4, fontSize: 9, color: '#fbbf24' }}>
                    ⚠️ {item}
                  </div>
                ))}
              </article>
            ))}
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <div style={{ padding: 12, color: '#94a3b8', fontSize: 11 }}>
          Auto Trader is {autoTradingActive ? 'monitoring live 1m bars' : 'currently paused'}. You can click "Analyze Now" anytime for an on-demand snapshot analysis.
        </div>
      )}
    </section>
  );
}