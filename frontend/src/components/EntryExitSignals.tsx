import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { SerializedFootprintBar } from '../types/market.js';
import { findOrderFlowSetup, type BacktestTrade, type SignalCandle, type TradeSetup } from './EntryExitSignalEngine.js';
import { findPersistentLiquidityWalls, findSupportingLiquidityWall } from './LiquidityWallAnalysis.js';
import type { VolumeProfileResult } from './VolumeProfileCalculator.js';
import type { BookSample, TradeDot } from './OrderBookHeatmap.js';
import type { DerivativesPayload } from './DerivativesPanel.js';
import type { Snapshot as GammaSnapshot } from './GammaLevelsPanel.js';

interface ConfluenceContext {
  profile: VolumeProfileResult | null;
  heatmap: { samples: BookSample[]; trades: TradeDot[] };
  derivatives: DerivativesPayload | null;
  gamma: GammaSnapshot | null;
}

type PaperPosition = TradeSetup & { symbol: string; timeframe: string; openedAt: number; signalKey: string };
type JournalRow = { side: string; entry: number; exit: number; reason: string; closedAt: number; strategyVersion: number; pnlR: number; result: 'WIN' | 'LOSS' | 'BREAKEVEN' };
type SavedState = { position: PaperPosition | null; journal: JournalRow[]; strategyVersion: number; lastTestedSignal: string };
const keyFor = (symbol: string, timeframe: string) => `flowterminal_signal_${symbol}_${timeframe}`;
const fmt = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const intervalSeconds: Record<string, number> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

export default function EntryExitSignals({ symbol, timeframe, candles, footprints, bids, asks, price, feedStatus, lastTradeAt, context, backtestTrades, historicalOIStatus, onLiveSetupChange }: {
  symbol: string; timeframe: string; candles: SignalCandle[]; footprints: SerializedFootprintBar[];
  bids: [number, number][]; asks: [number, number][]; price: number | null; feedStatus: string; lastTradeAt: number | null;
  context: ConfluenceContext;
  backtestTrades: BacktestTrade[];
  historicalOIStatus: 'idle' | 'loading' | 'ready' | 'error';
  onLiveSetupChange?: (setup: TradeSetup | null) => void;
}) {
  const [position, setPosition] = useState<PaperPosition | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [strategyVersion, setStrategyVersion] = useState(1);
  const [lastTestedSignal, setLastTestedSignal] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [hydratedKey, setHydratedKey] = useState('');
  const ruleSetup = useMemo(() => strategyVersion <= 3 ? findOrderFlowSetup(candles, footprints, bids, asks, strategyVersion, context.derivatives?.openInterest ?? [], symbol, intervalSeconds[timeframe] ?? 60) : null,
    [candles, footprints, bids, asks, strategyVersion, context.derivatives, symbol, timeframe]);
  const supportingWall = useMemo(() => ruleSetup ? findSupportingLiquidityWall(ruleSetup, context.heatmap.samples, price) : null,
    [ruleSetup, context.heatmap.samples, price]);
  const setup = useMemo<TradeSetup | null>(() => ruleSetup && supportingWall ? {
    ...ruleSetup,
    score: ruleSetup.score + 1,
    maxScore: ruleSetup.maxScore + 1,
    liquidityWall: supportingWall,
    reasons: [...ruleSetup.reasons, `Persistent ${supportingWall.side} wall at ${fmt(supportingWall.price)} · present as an outsized level in ${supportingWall.persistencePct}% of heatmap samples`]
  } : null, [ruleSetup, supportingWall]);
  const storageKey = keyFor(symbol, timeframe);
  const feedLive = (feedStatus === 'LIVE' || feedStatus === 'DESYNCHRONIZED') && lastTradeAt !== null && now - lastTradeAt < 15_000;
  const setupRisk = setup ? Math.abs(setup.entry - setup.stop) : 0;
  const setupFresh = setup !== null && now / 1000 - setup.time <= (timeframe === '5m' ? 600 : 120);
  const entryDriftR = setup && price !== null && setupRisk > 0 ? Math.abs(price - setup.entry) / setupRisk : Infinity;
  const entryStillValid = setup !== null && price !== null && entryDriftR <= 0.25 &&
    (setup.side === 'LONG' ? price > setup.stop : price < setup.stop);
  const validationTrades = backtestTrades.filter((trade) => trade.phase === 'VALIDATION' && trade.outcome !== 'OPEN');
  const validationNetR = validationTrades.reduce((sum, trade) => sum + (trade.pnlR ?? 0), 0);
  const validationReady = validationTrades.length >= 10 && validationNetR > 0;

  useEffect(() => {
    onLiveSetupChange?.(position ?? (feedLive && setupFresh ? setup : null));
    return () => onLiveSetupChange?.(null);
  }, [onLiveSetupChange, position, setup, feedLive, setupFresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<SavedState>;
      setPosition(saved.position?.symbol === symbol && saved.position?.timeframe === timeframe ? saved.position : null);
      setJournal(Array.isArray(saved.journal) ? saved.journal.slice(0, 10) : []);
      setStrategyVersion(Number.isInteger(saved.strategyVersion) ? Math.max(1, saved.strategyVersion!) : 1);
      setLastTestedSignal(typeof saved.lastTestedSignal === 'string' ? saved.lastTestedSignal : '');
    } catch { setPosition(null); setJournal([]); }
    setHydratedKey(storageKey);
  }, [storageKey, symbol, timeframe]);

  useEffect(() => {
    if (hydratedKey !== storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ position, journal, strategyVersion, lastTestedSignal } satisfies SavedState));
  }, [hydratedKey, storageKey, position, journal, strategyVersion, lastTestedSignal]);

  const closePosition = (exit: number, reason: string) => {
    if (!position || !Number.isFinite(exit)) return;
    const risk = Math.abs(position.entry - position.stop);
    const signedMove = position.side === 'LONG' ? exit - position.entry : position.entry - exit;
    const pnlR = risk > 0 ? signedMove / risk : 0;
    const result: JournalRow['result'] = pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN';
    const row: JournalRow = { side: position.side, entry: position.entry, exit, reason, closedAt: Date.now(), strategyVersion: position.strategyVersion, pnlR, result };
    setJournal((current) => [row, ...current].slice(0, 10));
    if (result === 'LOSS' && position.strategyVersion === strategyVersion) setStrategyVersion((version) => Math.min(4, version + 1));
    setPosition(null);
    setNotice(`Paper ${position.side.toLowerCase()} ${result} · ${pnlR.toFixed(2)}R · ${reason}. ${result === 'LOSS' ? 'That rule version is paused; the next stricter version will be evaluated.' : ''}`);
  };

  useEffect(() => {
    if (!position || price === null) return;
    if (position.side === 'LONG' && price <= position.stop) closePosition(price, 'stop touched');
    else if (position.side === 'SHORT' && price >= position.stop) closePosition(price, 'stop touched');
    else if (position.side === 'LONG' && price >= position.target2) closePosition(price, `1:${position.targetR} target touched`);
    else if (position.side === 'SHORT' && price <= position.target2) closePosition(price, `1:${position.targetR} target touched`);
    else if (setup && setup.side !== position.side && setup.score >= 3) closePosition(price, 'opposite order-flow setup');
  // A live price update intentionally evaluates the saved paper position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, position, setup]);

  // Automatically shadow-test each eligible, newly closed-bar signal once. This
  // never sends orders; it records a hypothetical fill at the live last price.
  useEffect(() => {
    if (hydratedKey !== storageKey || position || !setup || !setupFresh || !feedLive || price === null || !entryStillValid) return;
    const signalKey = `${symbol}:${timeframe}:v${setup.strategyVersion}:${setup.time}`;
    if (signalKey === lastTestedSignal || lastTestedSignal.endsWith(`:${setup.time}`)) return;
    const risk = Math.abs(price - setup.stop);
    if (!Number.isFinite(risk) || risk <= 0) return;
    const direction = setup.side === 'LONG' ? 1 : -1;
    setLastTestedSignal(signalKey);
    setPosition({ ...setup, entry: price, target1: price + direction * risk, target2: price + direction * risk * setup.targetR,
      symbol, timeframe, openedAt: Date.now(), signalKey });
    setNotice(`Auto paper-test started for strategy V${setup.strategyVersion} at live last price ${fmt(price)}.`);
  }, [hydratedKey, storageKey, position, setup, setupFresh, feedLive, price, entryStillValid, lastTestedSignal, symbol, timeframe]);

  const sideColor = position?.side === 'LONG' || (!position && setup?.side === 'LONG') ? '#34d399' : '#fb7185';
  const currentClose = candles[candles.length - 1]?.close ?? price;
  const profileState = context.profile && context.profile.levels.length && currentClose !== null
    ? currentClose > context.profile.vah ? 'Above value area' : currentClose < context.profile.val ? 'Below value area' : 'Inside value area'
    : context.profile ? 'No captured trades in selected range' : 'Manual range not selected';
  const latestBook = context.heatmap.samples[context.heatmap.samples.length - 1];
  const bookAge = latestBook ? Math.max(0, Math.round((Date.now() - latestBook.time) / 1000)) : null;
  const bestDisplayedBid = latestBook?.bids[0];
  const bestDisplayedAsk = latestBook?.asks[0];
  const visibleWalls = useMemo(() => findPersistentLiquidityWalls(context.heatmap.samples), [context.heatmap.samples]);
  const oiPoints = context.derivatives?.openInterest ?? [];
  const flowFootprintTimes = useMemo(() => footprints.filter((bar) => bar.isClosed).map((bar) => bar.time).sort((a, b) => a - b), [footprints]);
  const oiTimes = useMemo(() => oiPoints.map((point) => {
    const value = Number(point.timestamp);
    return value < 1e12 ? value * 1000 : value;
  }).filter(Number.isFinite).sort((a, b) => a - b), [oiPoints]);
  const overlapStartMs = flowFootprintTimes.length && oiTimes.length ? Math.max(flowFootprintTimes[0] * 1000, oiTimes[0]) : null;
  const overlapEndMs = flowFootprintTimes.length && oiTimes.length ? Math.min(flowFootprintTimes[flowFootprintTimes.length - 1] * 1000, oiTimes[oiTimes.length - 1]) : null;
  const flowHistoryLabel = !['1m', '5m'].includes(timeframe)
    ? 'Trade-side history is recorded only on 1m / 5m; no synthetic signals are shown here.'
    : !flowFootprintTimes.length
      ? 'No saved trade-derived footprint bars for this period; candle OHLC cannot recreate delta or CVD.'
      : overlapStartMs === null || overlapEndMs === null || overlapStartMs > overlapEndMs
        ? 'Recorded footprint and Bybit OI history do not overlap; historical order-flow signals are unavailable.'
        : `Actual footprint + Bybit OI overlap: ${new Date(overlapStartMs).toLocaleDateString('en-IN')} – ${new Date(overlapEndMs).toLocaleDateString('en-IN')}. Older candles remain SMC/ICT context only.`;
  const oiLast = oiPoints.length ? Number(oiPoints[oiPoints.length - 1].openInterest) : NaN;
  const oiPrior = oiPoints.length > 1 ? Number(oiPoints[oiPoints.length - 2].openInterest) : NaN;
  const oiChangePct = Number.isFinite(oiLast) && Number.isFinite(oiPrior) && oiPrior !== 0 ? (oiLast - oiPrior) / oiPrior * 100 : null;
  const gammaByStrike = new Map<number, number>();
  for (const row of context.gamma?.rows ?? []) {
    if (row.gamma !== null) gammaByStrike.set(row.strike, (gammaByStrike.get(row.strike) ?? 0) + row.gamma * row.openInterest);
  }
  const topGamma = [...gammaByStrike.entries()].sort((a, b) => b[1] - a[1])[0];
  const completedBacktests = backtestTrades.filter((trade) => trade.outcome !== 'OPEN');
  const backtestWins = completedBacktests.filter((trade) => trade.outcome === 'WIN').length;
  const backtestLosses = completedBacktests.filter((trade) => trade.outcome === 'LOSS').length;
  const backtestBreakeven = completedBacktests.filter((trade) => trade.outcome === 'BREAKEVEN').length;
  const backtestTimed = completedBacktests.filter((trade) => trade.outcome === 'TIME').length;
  const backtestOpen = backtestTrades.filter((trade) => trade.outcome === 'OPEN').length;
  const netBacktestR = completedBacktests.reduce((sum, trade) => sum + (trade.pnlR ?? 0), 0);
  const backtestWinRate = completedBacktests.length ? backtestWins / completedBacktests.length * 100 : null;
  const validationWinsR = validationTrades.reduce((sum, trade) => sum + Math.max(0, trade.pnlR ?? 0), 0);
  const validationLossesR = validationTrades.reduce((sum, trade) => sum + Math.min(0, trade.pnlR ?? 0), 0);
  const validationProfitFactor = validationLossesR < 0 ? validationWinsR / Math.abs(validationLossesR) : validationWinsR > 0 ? Infinity : null;
  let validationEquityR = 0; let validationPeakR = 0; let validationMaxDrawdownR = 0;
  for (const trade of validationTrades) {
    validationEquityR += trade.pnlR ?? 0;
    validationPeakR = Math.max(validationPeakR, validationEquityR);
    validationMaxDrawdownR = Math.max(validationMaxDrawdownR, validationPeakR - validationEquityR);
  }
  const replaySpanDays = signalCandleSpanDays(candles);
  const replayVersions = [1, 2, 3].map((version) => ({ version, count: backtestTrades.filter((trade) => trade.strategyVersion === version).length }));
  const latestAgentReads = backtestTrades[backtestTrades.length - 1]?.agentReads ?? [];

  return <section style={{ marginTop: 12, border: '1px solid #263449', borderRadius: 6, background: '#0b0e14', color: '#cbd5e1', overflow: 'hidden' }}>
    <header style={{ padding: '10px 12px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 12 }}>AGENT BACKTEST & PAPER PLAN · {symbol} · {timeframe}</strong>
      <span style={{ color: feedLive ? '#34d399' : '#fbbf24', fontSize: 10 }}>{feedLive ? 'LIVE FEED' : 'PAUSED · CHECK FEED'}</span>
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 7, padding: '9px 12px', borderBottom: '1px solid #1f2937' }}>
      <ContextCell label="MANUAL VOLUME PROFILE" value={profileState} detail={context.profile?.levels.length ? `POC ${fmt(context.profile.poc)} · VA ${fmt(context.profile.val)}–${fmt(context.profile.vah)}` : 'Range selection / local trade capture required'} />
      <ContextCell label="RECORDED BOOK HEATMAP" value={bookAge === null ? 'No samples yet' : bookAge < 15 ? 'Live samples' : 'Stale samples'} detail={latestBook ? `Bid ${bestDisplayedBid ? fmt(bestDisplayedBid[0]) : '—'} · Ask ${bestDisplayedAsk ? fmt(bestDisplayedAsk[0]) : '—'} · ${bookAge}s old` : 'Bands are context, not intent'} />
      <ContextCell label="PERSISTENT WALL CONFLUENCE" value={setup?.liquidityWall ? `${setup.liquidityWall.side.toUpperCase()} wall confirmed` : visibleWalls.length ? `${visibleWalls.length} wall(s) visible · no setup match` : 'No persistent wall'} detail={setup?.liquidityWall ? `${fmt(setup.liquidityWall.price)} · ${setup.liquidityWall.persistencePct}% persistence · adds one confluence point` : `Live paper plan needs a nearby ${ruleSetup?.side === 'LONG' ? 'bid' : ruleSetup?.side === 'SHORT' ? 'ask' : 'directional'} wall still present in the latest book.`} />
      <ContextCell label="BYBIT OI / FUNDING" value={oiChangePct === null ? 'Waiting for history' : `OI ${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(2)}%`} detail={`30d replay OI: ${historicalOIStatus === 'ready' ? `${oiPoints.length} points` : historicalOIStatus} · Funding ${context.derivatives?.ticker?.fundingRate ? `${(Number(context.derivatives.ticker.fundingRate) * 100).toFixed(4)}%` : '—'} · OI alone has no direction`} />
      <ContextCell label="OPTIONS GAMMA CONTEXT" value={topGamma ? `${context.gamma?.source ?? 'Options'} max Γ×OI` : 'Unavailable'} detail={topGamma ? `Strike ${fmt(topGamma[0])} · not dealer net-GEX` : 'No valid option Gamma snapshot'} />
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', padding: '9px 12px', borderBottom: '1px solid #1f2937', background: '#0a1019', fontSize: 10 }}>
      <b style={{ color: '#cbd5e1' }}>HISTORICAL REPLAY · up to 30 days · {timeframe}</b>
      <span style={{ color: '#94a3b8' }}>{backtestTrades.length} entries · {replaySpanDays.toFixed(1)}d candles</span>
      <span style={{ color: '#34d399' }}>Wins {backtestWins}</span>
      <span style={{ color: '#fb7185' }}>Losses {backtestLosses}</span>
      <span style={{ color: '#fbbf24' }}>Breakeven {backtestBreakeven}</span>
      <span style={{ color: '#94a3b8' }}>Timed {backtestTimed}</span>
      <span style={{ color: '#fbbf24' }}>Open {backtestOpen}</span>
      <span style={{ color: '#cbd5e1' }}>Win rate {backtestWinRate === null ? '—' : `${backtestWinRate.toFixed(1)}%`}</span>
      <span style={{ color: netBacktestR >= 0 ? '#34d399' : '#fb7185' }}>Net {netBacktestR >= 0 ? '+' : ''}{netBacktestR.toFixed(1)}R</span>
      <span style={{ color: validationReady ? '#34d399' : '#fbbf24' }}>Holdout {validationTrades.length} closed · {validationReady ? 'positive sample' : 'not validated'}</span>
      <span style={{ color: '#64748b' }}>SMC + ICT + Order Flow must agree; manager plans entry, SL, TP1 and final 2R–4R target</span>
    </div>
    {historicalOIStatus === 'error' && <div style={{ padding: '0 12px 8px', color: '#fbbf24', fontSize: 10 }}>30-day Bybit OI history could not be loaded; historical order-flow replay may have fewer valid setups.</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>
      <span>Out-of-sample (last 30%) · expectancy {validationTrades.length ? `${(validationNetR / validationTrades.length >= 0 ? '+' : '')}${(validationNetR / validationTrades.length).toFixed(2)}R/trade` : '—'}</span>
      <span>Profit factor {validationProfitFactor === null ? '—' : Number.isFinite(validationProfitFactor) ? validationProfitFactor.toFixed(2) : '∞'}</span>
      <span>Max drawdown {validationMaxDrawdownR.toFixed(2)}R</span>
      <span>Gross R only · fees and slippage excluded</span>
    </div>
    <div style={{ padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>{flowHistoryLabel}</div>
    <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 9 }}>Historical backtest entry/SL/TP uses the recorded candle, footprint and OI rules. Persistent order-book wall confirmation is required for live paper plans; historical book data is not complete enough to claim a 30-day heatmap backtest.</div>
    {latestAgentReads.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, padding: '0 12px 9px' }}>
      {latestAgentReads.map((read) => <div key={read.agent} style={{ padding: 7, border: '1px solid #1f2937', borderRadius: 4, background: '#0a1019', fontSize: 9 }}>
        <b style={{ color: read.bias === 'LONG' ? '#34d399' : read.bias === 'SHORT' ? '#fb7185' : '#94a3b8' }}>{read.agent} · {read.bias} · {read.strength}/3</b>
        {read.findings.map((finding) => <div key={finding} style={{ color: '#94a3b8', marginTop: 3 }}>{finding}</div>)}
      </div>)}
    </div>}
    {!feedLive ? <div style={{ padding: 12, color: '#fbbf24', fontSize: 11 }}>Paper signal testing is paused because the exchange trade feed is stale or disconnected.</div> : strategyVersion > 3 ? <div style={{ padding: 12, color: '#fbbf24', fontSize: 11 }}>All three rule versions have recorded a loss and are paused. Review the paper journal before resetting or changing rules.</div> : position ? <div style={{ padding: 12 }}>
      <div style={{ color: sideColor, fontSize: 15, fontWeight: 800 }}>AUTO PAPER {position.side} · V{position.strategyVersion} · OPEN</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8, fontSize: 11 }}>
        <span>Entry <b>{fmt(position.entry)}</b></span><span>Stop / exit <b style={{ color: '#fb7185' }}>{fmt(position.stop)}</b></span>
        <span>1R <b>{fmt(position.target1)}</b></span><span>TP 1:{position.targetR} <b style={{ color: '#34d399' }}>{fmt(position.target2)}</b></span>
        <button onClick={() => price !== null && closePosition(price, 'manual paper exit')} style={buttonStyle}>Close paper trade</button>
      </div>
      <div style={{ marginTop: 7, color: '#94a3b8', fontSize: 10 }}>Exit rule: stop, selected 1:{position.targetR} target, or an opposite order-flow setup. These are simulated levels; no order is sent.</div>
    </div> : setup && setupFresh && feedLive ? <div style={{ padding: 12 }}>
      <div style={{ color: sideColor, fontSize: 15, fontWeight: 800 }}>{setup.side} SETUP · {setup.score}/{setup.maxScore} confluence</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8, fontSize: 11 }}>
        <span>Entry reference <b>{fmt(setup.entry)}</b></span><span>Invalidation <b style={{ color: '#fb7185' }}>{fmt(setup.stop)}</b></span>
        <span>1R <b>{fmt(setup.target1)}</b></span><span>TP 1:{setup.targetR} <b style={{ color: '#34d399' }}>{fmt(setup.target2)}</b></span>
      </div>
      <ul style={{ margin: '9px 0', paddingLeft: 18, color: '#94a3b8', fontSize: 10 }}>{setup.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <div style={{ marginTop: 9, color: validationReady ? '#94a3b8' : '#fbbf24', fontSize: 10 }}>Paper test auto-starts once per fresh confirmed signal when price remains within 0.25R of entry and the stop is intact. Holdout: {validationTrades.length}/10 closed · {validationNetR >= 0 ? '+' : ''}{validationNetR.toFixed(1)}R · {validationReady ? 'positive sample' : 'not yet validated'}. Paper only; fees/slippage excluded.</div>
    </div> : <div style={{ padding: 12, color: '#94a3b8', fontSize: 11 }}>
      <b>WAIT · {!ruleSetup ? 'No setup meets the SMC/ICT/order-flow rules on the latest closed bar.' : 'Rule setup found, but there is no fresh nearby persistent supporting wall.'}</b>
      <div style={{ marginTop: 5, color: '#64748b' }}>V{strategyVersion} needs {strategyVersion >= 2 ? '4+' : '3+'} stacked footprint levels ({strategyVersion >= 3 ? '4:1' : '3:1'} imbalance), aligned delta/CVD, rolling POC acceptance, rising OI, flow-confirmed BOS/CHoCH/MSS, a five-bar breakout, confirmed PO3 distribution, and previous-day discount for longs / premium for shorts. A live paper plan additionally needs a current persistent bid wall for LONG or ask wall for SHORT within 0.15% or 2.5R of price. Missing data means WAIT.</div>
      {!['1m', '5m'].includes(timeframe) && <div style={{ marginTop: 5, color: '#fbbf24' }}>Trade-side footprint history is only recorded at 1m and 5m. This timeframe still shows candle-based SMC/ICT marks, but order-flow BUY/SELL replay is unavailable here.</div>}
      <div style={{ marginTop: 4 }}>No-trade is a valid outcome.</div>
    </div>}
    {notice && <div style={{ padding: '0 12px 9px', color: '#fbbf24', fontSize: 10 }}>{notice}</div>}
    <div style={{ padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>Strategy test: {strategyVersion > 3 ? 'ALL VERSIONS PAUSED' : `V${strategyVersion} active`}; {journal.filter((row) => row.strategyVersion === strategyVersion && row.result === 'WIN').length} wins / {journal.filter((row) => row.strategyVersion === strategyVersion && row.result === 'LOSS').length} losses in recent log. A loss pauses that version and moves to stricter confluence rules.</div>
    <details style={{ borderTop: '1px solid #1f2937' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 10 }}>Recent paper decision log · {journal.length}</summary>
      {journal.length ? <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#94a3b8' }}>{journal.map((row, index) => <div key={`${row.closedAt}-${index}`} style={{ padding: '4px 0' }}>{new Date(row.closedAt).toLocaleString('en-IN')} · V{row.strategyVersion} · {row.side} · {fmt(row.entry)} → {fmt(row.exit)} · <b style={{ color: row.result === 'WIN' ? '#34d399' : row.result === 'LOSS' ? '#fb7185' : '#fbbf24' }}>{row.result} {row.pnlR.toFixed(2)}R</b> · {row.reason}</div>)}</div> : <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#64748b' }}>No closed paper trades yet.</div>}
    </details>
    <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 9 }}>Replay versions: {replayVersions.map(({ version, count }) => `V${version} ${count}`).join(' · ')}. Only training-period losses tighten later rules; the final 30% holdout is frozen for evaluation. These SMC, ICT, Order Flow and manager reads are deterministic rules, not AI model calls or self-training. Replay uses recorded footprints/OI only where saved. No automatic exchange orders.</div>
  </section>;
}

const buttonStyle: CSSProperties = { background: '#172033', color: '#e2e8f0', border: '1px solid #334155', padding: '6px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 10 };

function ContextCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div style={{ minWidth: 0, padding: '7px 8px', border: '1px solid #1f2937', borderRadius: 4, background: '#0a1019' }}>
    <div style={{ color: '#64748b', fontSize: 9, fontWeight: 700 }}>{label}</div>
    <div style={{ color: '#cbd5e1', fontSize: 10, fontWeight: 700, marginTop: 4 }}>{value}</div>
    <div style={{ color: '#64748b', fontSize: 9, marginTop: 3, overflowWrap: 'anywhere' }}>{detail}</div>
  </div>;
}

function signalCandleSpanDays(candles: SignalCandle[]): number {
  if (candles.length < 2) return 0;
  return Math.max(0, candles[candles.length - 1].time - candles[0].time) / 86400;
}
