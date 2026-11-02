import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { SerializedFootprintBar } from '../types/market.js';
import { findOrderFlowSetup, type BacktestCostAssumptions, type BacktestTrade, type SignalCandle, type TradeSetup } from './EntryExitSignalEngine.js';
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
type JournalRow = { side: string; entry: number; exit: number; reason: string; closedAt: number; strategyVersion: number; grossPnlR?: number; costR?: number; feeBpsPerSide?: number; slippageBpsPerSide?: number; pnlR: number; result: 'WIN' | 'LOSS' | 'BREAKEVEN' };
type SavedState = { position: PaperPosition | null; journal: JournalRow[]; strategyVersion: number; lastTestedSignal: string };
const keyFor = (symbol: string, timeframe: string) => `flowterminal_signal_${symbol}_${timeframe}`;
const fmt = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const intervalSeconds: Record<string, number> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

export default function EntryExitSignals({ symbol, timeframe, candles, footprints, bids, asks, price, feedStatus, lastTradeAt, context, backtestTrades, mtfBacktestTrades, mtfV2BacktestTrades, orderFlowBacktestTrades, bookReplayInfo, costs, onCostsChange, historicalOIStatus, tradeReplayInfo, onLiveSetupChange }: {
  symbol: string; timeframe: string; candles: SignalCandle[]; footprints: SerializedFootprintBar[];
  bids: [number, number][]; asks: [number, number][]; price: number | null; feedStatus: string; lastTradeAt: number | null;
  context: ConfluenceContext;
  backtestTrades: BacktestTrade[];
  mtfBacktestTrades: BacktestTrade[];
  mtfV2BacktestTrades: BacktestTrade[];
  orderFlowBacktestTrades: BacktestTrade[];
  bookReplayInfo: { status: 'idle' | 'loading' | 'ready' | 'error'; samples: number; firstTime: number | null; lastTime: number | null };
  costs: BacktestCostAssumptions;
  onCostsChange: (costs: BacktestCostAssumptions) => void;
  tradeReplayInfo: { status: 'idle' | 'loading' | 'ready' | 'error'; sourceTradeCount: number; windowHours: number; barsCount: number };
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
  const validationNetR = validationTrades.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
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
      setJournal(Array.isArray(saved.journal) ? saved.journal.slice(0, 200) : []);
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
    const grossPnlR = risk > 0 ? signedMove / risk : 0;
    const costR = risk > 0 ? ((position.entry + exit) * (costs.feeBpsPerSide + costs.slippageBpsPerSide) / 10_000) / risk : 0;
    const pnlR = grossPnlR - costR;
    const result: JournalRow['result'] = pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN';
    const row: JournalRow = {
      side: position.side, entry: position.entry, exit, reason, closedAt: Date.now(), strategyVersion: position.strategyVersion,
      grossPnlR, costR, feeBpsPerSide: costs.feeBpsPerSide, slippageBpsPerSide: costs.slippageBpsPerSide, pnlR, result
    };
    setJournal((current) => [row, ...current].slice(0, 200));
    if (result === 'LOSS' && position.strategyVersion === strategyVersion) setStrategyVersion((version) => Math.min(4, version + 1));
    setPosition(null);
    const nextStep = result !== 'LOSS' ? '' : position.strategyVersion < 3
      ? ` V${position.strategyVersion + 1} stricter rules will be evaluated.`
      : ' All three versions are now paused; start a new V1 paper cycle when ready.';
    setNotice(`Paper ${position.side.toLowerCase()} ${result} · ${pnlR.toFixed(2)}R · ${reason}.${nextStep}`);
  };

  const restartPaperCycle = () => {
    if (position) return;
    setStrategyVersion(1);
    // Keep the last signal key so a reset cannot immediately reopen the same bar.
    // The next eligible, newly closed signal can start the new cycle.
    setNotice('New V1 paper cycle ready. Existing journal is preserved; waiting for the next fresh signal.');
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
  }, [price, position, setup, costs]);

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
  const paperWins = journal.filter((row) => row.pnlR > 0).length;
  const paperLosses = journal.filter((row) => row.pnlR < 0).length;
  const paperNetR = journal.reduce((sum, row) => sum + row.pnlR, 0);
  const paperGrossR = journal.reduce((sum, row) => sum + (row.grossPnlR ?? row.pnlR), 0);
  const paperCostsR = journal.reduce((sum, row) => sum + (row.costR ?? 0), 0);
  const paperWinR = journal.reduce((sum, row) => sum + Math.max(0, row.pnlR), 0);
  const paperLossR = journal.reduce((sum, row) => sum + Math.min(0, row.pnlR), 0);
  const paperProfitFactor = paperLossR < 0 ? paperWinR / Math.abs(paperLossR) : paperWinR > 0 ? Infinity : null;
  const completedBacktests = backtestTrades.filter((trade) => trade.outcome !== 'OPEN');
  const completedMtfBacktests = mtfBacktestTrades.filter((trade) => trade.outcome !== 'OPEN');
  const mtfNetWins = completedMtfBacktests.filter((trade) => (trade.netPnlR ?? 0) > 0).length;
  const mtfNetLosses = completedMtfBacktests.filter((trade) => (trade.netPnlR ?? 0) < 0).length;
  const mtfNetR = completedMtfBacktests.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const mtfWinRate = completedMtfBacktests.length ? mtfNetWins / completedMtfBacktests.length * 100 : null;
  const mtfValidation = completedMtfBacktests.filter((trade) => trade.phase === 'VALIDATION');
  const mtfValidationNetR = mtfValidation.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const completedMtfV2Backtests = mtfV2BacktestTrades.filter((trade) => trade.outcome !== 'OPEN');
  const mtfV2NetWins = completedMtfV2Backtests.filter((trade) => (trade.netPnlR ?? 0) > 0).length;
  const mtfV2NetLosses = completedMtfV2Backtests.filter((trade) => (trade.netPnlR ?? 0) < 0).length;
  const mtfV2NetR = completedMtfV2Backtests.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const mtfV2Validation = completedMtfV2Backtests.filter((trade) => trade.phase === 'VALIDATION');
  const mtfV2ValidationNetR = mtfV2Validation.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const backtestTradeLog = [...backtestTrades].reverse();
  const backtestGrossWins = completedBacktests.filter((trade) => (trade.pnlR ?? 0) > 0).length;
  const backtestGrossLosses = completedBacktests.filter((trade) => (trade.pnlR ?? 0) < 0).length;
  const grossWinsErasedByCosts = completedBacktests.filter((trade) => (trade.pnlR ?? 0) > 0 && (trade.netPnlR ?? 0) <= 0).length;
  const backtestWins = completedBacktests.filter((trade) => (trade.netPnlR ?? 0) > 0).length;
  const backtestLosses = completedBacktests.filter((trade) => (trade.netPnlR ?? 0) < 0).length;
  const backtestBreakeven = completedBacktests.filter((trade) => trade.outcome === 'BREAKEVEN').length;
  const backtestTimed = completedBacktests.filter((trade) => trade.outcome === 'TIME').length;
  const backtestOpen = backtestTrades.filter((trade) => trade.outcome === 'OPEN').length;
  const netBacktestR = completedBacktests.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const backtestWinRate = completedBacktests.length ? backtestWins / completedBacktests.length * 100 : null;
  const setupTypeBreakdown = ['BOS', 'CHOCH', 'MSS'].map((type) => {
    const trades = completedBacktests.filter((trade) => trade.reasons.some((reason) => reason.startsWith(`SMC ${type} `)));
    const validation = trades.filter((trade) => trade.phase === 'VALIDATION');
    return {
      type,
      trades: trades.length,
      wins: trades.filter((trade) => (trade.netPnlR ?? 0) > 0).length,
      losses: trades.filter((trade) => (trade.netPnlR ?? 0) < 0).length,
      netR: trades.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0),
      validationTrades: validation.length,
      validationNetR: validation.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0)
    };
  });
  const sideBreakdown = (['LONG', 'SHORT'] as const).map((side) => {
    const trades = completedBacktests.filter((trade) => trade.side === side);
    return {
      side, trades: trades.length,
      wins: trades.filter((trade) => (trade.netPnlR ?? 0) > 0).length,
      losses: trades.filter((trade) => (trade.netPnlR ?? 0) < 0).length,
      netR: trades.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0)
    };
  });
  const withoutBosTrades = completedBacktests.filter((trade) => !trade.reasons.some((reason) => reason.startsWith('SMC BOS ')));
  const withoutBosWins = withoutBosTrades.filter((trade) => (trade.netPnlR ?? 0) > 0).length;
  const withoutBosLosses = withoutBosTrades.filter((trade) => (trade.netPnlR ?? 0) < 0).length;
  const withoutBosNetR = withoutBosTrades.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const withoutBosValidation = withoutBosTrades.filter((trade) => trade.phase === 'VALIDATION');
  const withoutBosValidationNetR = withoutBosValidation.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const validationWinsR = validationTrades.reduce((sum, trade) => sum + Math.max(0, trade.netPnlR ?? 0), 0);
  const validationLossesR = validationTrades.reduce((sum, trade) => sum + Math.min(0, trade.netPnlR ?? 0), 0);
  const validationProfitFactor = validationLossesR < 0 ? validationWinsR / Math.abs(validationLossesR) : validationWinsR > 0 ? Infinity : null;
  let validationEquityR = 0; let validationPeakR = 0; let validationMaxDrawdownR = 0;
  for (const trade of validationTrades) {
    validationEquityR += trade.netPnlR ?? 0;
    validationPeakR = Math.max(validationPeakR, validationEquityR);
    validationMaxDrawdownR = Math.max(validationMaxDrawdownR, validationPeakR - validationEquityR);
  }
  const replaySpanDays = signalCandleSpanDays(candles);
  const latestAgentReads = backtestTrades[backtestTrades.length - 1]?.agentReads ?? [];
  const closedFootprintBars = footprints.filter((bar) => bar.isClosed);
  const orderFlowCompleted = orderFlowBacktestTrades.filter((trade) => trade.outcome !== 'OPEN');
  const orderFlowNetR = orderFlowCompleted.reduce((sum, trade) => sum + (trade.netPnlR ?? 0), 0);
  const orderFlowNetWins = orderFlowCompleted.filter((trade) => (trade.netPnlR ?? 0) > 0).length;
  const orderFlowNetLosses = orderFlowCompleted.filter((trade) => (trade.netPnlR ?? 0) < 0).length;
  const orderFlowWinRate = orderFlowCompleted.length ? orderFlowNetWins / orderFlowCompleted.length * 100 : null;
  const orderFlowGrossWins = orderFlowCompleted.filter((trade) => (trade.pnlR ?? 0) > 0).length;
  const orderFlowBookFirst = bookReplayInfo.firstTime === null ? '—' : new Date(bookReplayInfo.firstTime).toLocaleString('en-IN');
  const orderFlowBookLast = bookReplayInfo.lastTime === null ? '—' : new Date(bookReplayInfo.lastTime).toLocaleString('en-IN');

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
      <b style={{ color: '#cbd5e1' }}>SMC + ICT HISTORICAL REPLAY · {timeframe}</b>
      <span style={{ color: '#94a3b8' }}>{backtestTrades.length} entries · {replaySpanDays.toFixed(1)}d candles</span>
      <span style={{ color: '#67e8f9' }}>Candle-only replay · order-flow is excluded</span>
      <span style={{ color: tradeReplayInfo.status === 'ready' ? '#67e8f9' : '#fbbf24' }}>Live paper order-flow fills: {tradeReplayInfo.status === 'ready' ? `${tradeReplayInfo.sourceTradeCount.toLocaleString()} ${symbol} fills captured` : tradeReplayInfo.status === 'loading' ? 'loading recent fills…' : tradeReplayInfo.status === 'error' ? 'unavailable · saved footprints remain available' : 'not loaded'}</span>
      <span style={{ color: '#34d399' }}>Gross wins {backtestGrossWins}</span>
      <span style={{ color: '#fb7185' }}>Gross losses {backtestGrossLosses}</span>
      <span style={{ color: '#34d399' }}>Net wins {backtestWins}</span>
      <span style={{ color: '#fb7185' }}>Net losses {backtestLosses}</span>
      <span style={{ color: grossWinsErasedByCosts ? '#fbbf24' : '#94a3b8' }}>Gross wins turned net-negative by costs {grossWinsErasedByCosts}</span>
      <span style={{ color: '#fbbf24' }}>Gross breakeven exits {backtestBreakeven} · may be net losses after costs</span>
      <span style={{ color: '#94a3b8' }}>Timed exits {backtestTimed} · included in net wins/losses</span>
      <span style={{ color: '#fbbf24' }}>Open {backtestOpen}</span>
      <span style={{ color: '#cbd5e1' }}>Win rate {backtestWinRate === null ? '—' : `${backtestWinRate.toFixed(1)}%`}</span>
      <span style={{ color: netBacktestR >= 0 ? '#34d399' : '#fb7185' }}>Net after estimated costs {netBacktestR >= 0 ? '+' : ''}{netBacktestR.toFixed(1)}R</span>
      <span style={{ color: validationReady ? '#34d399' : '#fbbf24' }}>Holdout {validationTrades.length} closed · {validationReady ? 'positive sample' : 'not validated'}</span>
      <span style={{ color: '#64748b' }}>Historical entries require candle-confirmed SMC + ICT agreement; fixed 2R target, estimated costs included</span>
    </div>
    {historicalOIStatus === 'error' && <div style={{ padding: '0 12px 8px', color: '#fbbf24', fontSize: 10 }}>30-day Bybit OI history could not be loaded. It is not used in this candle-only SMC + ICT replay.</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>
      <span>Out-of-sample (last 30%) · expectancy {validationTrades.length ? `${(validationNetR / validationTrades.length >= 0 ? '+' : '')}${(validationNetR / validationTrades.length).toFixed(2)}R/trade` : '—'}</span>
      <span>Profit factor {validationProfitFactor === null ? '—' : Number.isFinite(validationProfitFactor) ? validationProfitFactor.toFixed(2) : '∞'}</span>
      <span>Max drawdown {validationMaxDrawdownR.toFixed(2)}R</span>
      <span>Estimated round-trip costs · {costs.feeBpsPerSide.toFixed(2)} bps fee + {costs.slippageBpsPerSide.toFixed(2)} bps slippage per side · funding/gap fills excluded</span>
    </div>
    <details open style={{ borderTop: '1px solid #1f2937', borderBottom: '1px solid #1f2937', marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 10, color: '#fbbf24' }}>Loss breakdown by SMC trigger and trade side</summary>
      <div style={{ padding: '0 12px 9px', fontSize: 9, color: '#94a3b8' }}>
        These are trigger types inside the same combined SMC + ICT ruleset, not three independently tested strategies. Net results include estimated fees and slippage.
        <div style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead><tr style={{ textAlign: 'left', color: '#64748b' }}>{['Trigger', 'Closed trades', 'Net wins', 'Net losses', 'Net result', 'Holdout trades', 'Holdout net'].map((label) => <th key={label} style={{ padding: '5px 7px', borderBottom: '1px solid #263449' }}>{label}</th>)}</tr></thead>
            <tbody>{[
              ...setupTypeBreakdown.map((row) => ({ label: row.type, ...row })),
              ...sideBreakdown.map((row) => ({ label: row.side, ...row, validationTrades: 0, validationNetR: null as number | null }))
            ].map((row) => <tr key={row.label} style={{ borderBottom: '1px solid #172033' }}>
              <td style={{ padding: '5px 7px', color: '#cbd5e1' }}>{row.label}</td><td style={{ padding: '5px 7px' }}>{row.trades}</td>
              <td style={{ padding: '5px 7px', color: '#34d399' }}>{row.wins}</td><td style={{ padding: '5px 7px', color: '#fb7185' }}>{row.losses}</td>
              <td style={{ padding: '5px 7px', color: row.netR >= 0 ? '#34d399' : '#fb7185' }}>{row.netR >= 0 ? '+' : ''}{row.netR.toFixed(2)}R</td>
              <td style={{ padding: '5px 7px' }}>{row.validationTrades}</td><td style={{ padding: '5px 7px' }}>{row.validationNetR === null ? '—' : `${row.validationNetR >= 0 ? '+' : ''}${row.validationNetR.toFixed(2)}R`}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div style={{ marginTop: 7, color: '#fbbf24' }}>
          BOS removed · same-data what-if only: {withoutBosTrades.length} trades · {withoutBosWins} net wins / {withoutBosLosses} net losses · {withoutBosNetR >= 0 ? '+' : ''}{withoutBosNetR.toFixed(2)}R; holdout {withoutBosValidation.length} trades · {withoutBosValidationNetR >= 0 ? '+' : ''}{withoutBosValidationNetR.toFixed(2)}R. This does not change paper/live rules and is not a fresh validation.
        </div>
      </div>
    </details>
    <details open style={{ border: '1px solid #164e63', margin: '0 12px 9px', borderRadius: 4, background: '#08131b' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', color: '#67e8f9', fontSize: 10 }}>MTF V2 EXPERIMENT · 5m structure stop · 60m max hold · cost-risk filter ≤ 0.5R</summary>
      <div style={{ padding: '0 10px 9px', fontSize: 10, color: '#94a3b8' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <span>Closed {completedMtfV2Backtests.length}</span><span>Net wins {mtfV2NetWins}</span><span>Net losses {mtfV2NetLosses}</span>
          <span style={{ color: mtfV2NetR >= 0 ? '#34d399' : '#fb7185' }}>Net {mtfV2NetR >= 0 ? '+' : ''}{mtfV2NetR.toFixed(2)}R</span>
          <span>Holdout {mtfV2Validation.length} · {mtfV2ValidationNetR >= 0 ? '+' : ''}{mtfV2ValidationNetR.toFixed(2)}R</span>
        </div>
        <div style={{ marginTop: 5 }}>Stop comes from the last five fully closed 5m candles; time exit is 60 minutes. A setup is skipped when estimated round-trip costs exceed half the initial stop risk. Research-only candidate; it does not change paper or live rules.</div>
        {mtfV2BacktestTrades.length > 0 && <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', color: '#67e8f9' }}>V2 trade log · {mtfV2BacktestTrades.length}</summary>
          <div style={{ overflowX: 'auto', marginTop: 5 }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, whiteSpace: 'nowrap' }}>
            <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>{['Signal', 'Side · phase', 'Entry', 'SL', 'TP1 / TP2', 'Net result', 'Reason'].map((label) => <th key={label} style={{ padding: 5, borderBottom: '1px solid #263449' }}>{label}</th>)}</tr></thead>
            <tbody>{[...mtfV2BacktestTrades].reverse().map((trade, index) => <tr key={`${trade.time}-${index}`} style={{ borderBottom: '1px solid #172033' }}>
              <td style={{ padding: 5 }}>{new Date(trade.time * 1000).toLocaleString('en-IN')}</td><td style={{ padding: 5 }}>{trade.side} · {trade.phase}</td><td style={{ padding: 5 }}>{fmt(trade.entry)}</td><td style={{ padding: 5 }}>{fmt(trade.stop)}</td><td style={{ padding: 5 }}>{fmt(trade.target1)} / {fmt(trade.target2)}</td><td style={{ padding: 5, color: (trade.netPnlR ?? 0) < 0 ? '#fb7185' : '#34d399' }}>{trade.netPnlR === null ? '—' : `${trade.netPnlR >= 0 ? '+' : ''}${trade.netPnlR.toFixed(2)}R`}</td><td style={{ padding: 5, whiteSpace: 'normal', minWidth: 300 }}>{trade.lossReview ?? trade.reasons.join(' · ')}</td>
            </tr>)}</tbody>
          </table></div>
        </details>}
      </div>
    </details>
    <details open style={{ border: '1px solid #164e63', margin: '0 12px 9px', borderRadius: 4, background: '#08131b' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', color: '#67e8f9', fontSize: 10 }}>MTF SMC + ICT CANDIDATE · 4h/1h range · 15m/5m structure · 1m entry</summary>
      <div style={{ padding: '0 10px 9px', fontSize: 10, color: '#94a3b8' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <span>Trades {mtfBacktestTrades.length} · closed {completedMtfBacktests.length}</span>
          <span>Net wins {mtfNetWins}</span><span>Net losses {mtfNetLosses}</span>
          <span>Net win rate {mtfWinRate === null ? '— · no closed trades' : `${mtfWinRate.toFixed(1)}%`}</span>
          <span style={{ color: mtfNetR >= 0 ? '#34d399' : '#fb7185' }}>Net {mtfNetR >= 0 ? '+' : ''}{mtfNetR.toFixed(2)}R</span>
          <span>Holdout {mtfValidation.length} · {mtfValidationNetR >= 0 ? '+' : ''}{mtfValidationNetR.toFixed(2)}R</span>
        </div>
        <div style={{ marginTop: 5 }}>4h/1h confirmed swing highs-lows set premium/discount and 1h structure bias. 15m and 5m BOS/CHOCH/MSS must agree; a fresh 1m BOS/CHOCH/MSS triggers entry. Higher-timeframe bars are used only after their close. This is a candidate comparison, not an approved live rule; its historical window has already been viewed, so forward paper validation is still needed.</div>
        {mtfBacktestTrades.length > 0 && <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', color: '#67e8f9' }}>MTF trade log · {mtfBacktestTrades.length} · newest first</summary>
          <div style={{ overflowX: 'auto', marginTop: 5 }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, whiteSpace: 'nowrap' }}>
            <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>{['Signal', 'Side', 'Entry', 'SL', 'TP1 / TP2', 'Exit', 'Net', 'MTF evidence / review'].map((label) => <th key={label} style={{ padding: 5, borderBottom: '1px solid #263449' }}>{label}</th>)}</tr></thead>
            <tbody>{[...mtfBacktestTrades].reverse().map((trade, index) => <tr key={`${trade.time}-${index}`} style={{ borderBottom: '1px solid #172033' }}>
              <td style={{ padding: 5 }}>{new Date(trade.time * 1000).toLocaleString('en-IN')}</td><td style={{ padding: 5 }}>{trade.side} · {trade.phase}</td><td style={{ padding: 5 }}>{fmt(trade.entry)}</td><td style={{ padding: 5 }}>{fmt(trade.stop)}</td><td style={{ padding: 5 }}>{fmt(trade.target1)} / {fmt(trade.target2)}</td><td style={{ padding: 5 }}>{trade.exitTime === null ? 'Open' : new Date(trade.exitTime * 1000).toLocaleString('en-IN')}</td><td style={{ padding: 5, color: (trade.netPnlR ?? 0) < 0 ? '#fb7185' : '#34d399' }}>{trade.netPnlR === null ? '—' : `${trade.netPnlR >= 0 ? '+' : ''}${trade.netPnlR.toFixed(2)}R`}</td><td style={{ padding: 5, whiteSpace: 'normal', minWidth: 300 }}>{trade.lossReview ?? trade.reasons.join(' · ')}</td>
            </tr>)}</tbody>
          </table></div>
        </details>}
      </div>
    </details>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>
      <span>Cost assumptions (saved in this browser; update fee to match your Bybit account):</span>
      <label>Perp taker fee bps/side <input aria-label="Perp taker fee basis points per side" type="number" min="0" max="100" step="0.1" value={costs.feeBpsPerSide} onChange={(event) => onCostsChange({ ...costs, feeBpsPerSide: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })} style={costInputStyle} /></label>
      <label>Slippage bps/side <input aria-label="Slippage basis points per side" type="number" min="0" max="100" step="0.1" value={costs.slippageBpsPerSide} onChange={(event) => onCostsChange({ ...costs, slippageBpsPerSide: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })} style={costInputStyle} /></label>
      <span>Bybit VIP 0 perp taker baseline is 5.5 bps; slippage 2 bps is only an editable estimate.</span>
    </div>
    <div style={{ padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>{flowHistoryLabel}</div>
    <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 9 }}>Historical replay entries use candle-only SMC + ICT rules. Footprints, recent fills and order-book context are reserved for live paper order-flow analysis; no raw fill is counted as a strategy trade.</div>
    {backtestTradeLog.length > 0 && <details style={{ borderTop: '1px solid #1f2937', borderBottom: '1px solid #1f2937', marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 10, color: '#fda4af' }}>Backtest trade log · {backtestTradeLog.length} entries · newest first</summary>
      <div style={{ overflowX: 'auto', padding: '0 8px 9px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, whiteSpace: 'nowrap' }}>
          <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>
            {['Signal date / time', 'Side · split', 'Entry', 'SL', 'TP1 / TP2', 'Exit date / time', 'Exit price', 'Gross outcome · net result', 'Loss notes'].map((label) => <th key={label} style={{ padding: '6px 7px', borderBottom: '1px solid #263449' }}>{label}</th>)}
          </tr></thead>
          <tbody>{backtestTradeLog.map((trade, index) => {
            const resultColor = trade.netPnlR === null ? '#94a3b8' : trade.netPnlR < 0 ? '#fb7185' : '#34d399';
            return <tr key={`${trade.time}-${index}`} style={{ borderBottom: '1px solid #172033', verticalAlign: 'top' }}>
              <td style={{ padding: '6px 7px' }}>{new Date(trade.time * 1000).toLocaleString('en-IN')}</td>
              <td style={{ padding: '6px 7px', color: trade.side === 'LONG' ? '#34d399' : '#fb7185' }}>{trade.side} · {trade.phase}</td>
              <td style={{ padding: '6px 7px' }}>{fmt(trade.entry)}</td>
              <td style={{ padding: '6px 7px', color: '#fb7185' }}>{fmt(trade.stop)}</td>
              <td style={{ padding: '6px 7px', color: '#34d399' }}>{fmt(trade.target1)} / {fmt(trade.target2)}</td>
              <td style={{ padding: '6px 7px' }}>{trade.exitTime === null ? 'Still open' : new Date(trade.exitTime * 1000).toLocaleString('en-IN')}</td>
              <td style={{ padding: '6px 7px' }}>{trade.exitPrice === null ? '—' : fmt(trade.exitPrice)}</td>
              <td style={{ padding: '6px 7px', color: resultColor }}><div>{trade.outcome === 'WIN' ? 'TARGETS HIT' : trade.outcome === 'LOSS' ? 'STOP HIT' : trade.outcome}</div><div>{trade.netPnlR === null ? 'Net —' : `Net ${trade.netPnlR > 0 ? '+' : ''}${trade.netPnlR.toFixed(2)}R · ${trade.netPnlR > 0 ? 'PROFIT' : trade.netPnlR < 0 ? 'LOSS' : 'FLAT'}`}</div><div style={{ color: '#64748b' }}>gross {trade.pnlR === null ? '—' : `${trade.pnlR > 0 ? '+' : ''}${trade.pnlR.toFixed(2)}R`} · cost −{trade.costR === null ? '—' : `${trade.costR.toFixed(2)}R`}</div></td>
              <td style={{ padding: '6px 7px', whiteSpace: 'normal', minWidth: 230 }}>{trade.lossReview ?? trade.reasons.join(' · ')}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div style={{ padding: '0 12px 8px', color: '#64748b', fontSize: 9 }}>“TARGETS HIT” is the gross price outcome; the separate net result subtracts estimated round-trip fees and slippage. Net loss can occur even after targets hit when modeled costs exceed gross profit. Signal time is the candle close used for entry. Stop/target hits within the same candle are scored stop-first.</div>
    </details>}
    <div style={{ borderTop: '1px solid #1f2937', padding: '9px 12px', background: '#0a1019', fontSize: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <b style={{ color: '#cbd5e1' }}>SAVED ORDER-FLOW HISTORICAL REPLAY · {symbol} · {timeframe}</b>
        <span>Raw trades: {tradeReplayInfo.status === 'ready' ? `${tradeReplayInfo.sourceTradeCount.toLocaleString()} rebuilt` : `${tradeReplayInfo.status} · saved footprints used`}</span>
        <span>Closed footprint bars: {closedFootprintBars.length}</span>
        <span>Captured range: {closedFootprintBars.length ? `${new Date(closedFootprintBars[0].time * 1000).toLocaleString('en-IN')} → ${new Date(closedFootprintBars[closedFootprintBars.length - 1].time * 1000).toLocaleString('en-IN')}` : '—'}</span>
        <span>Book samples: {bookReplayInfo.status === 'ready' ? `${bookReplayInfo.samples.toLocaleString()} · ${orderFlowBookFirst} → ${orderFlowBookLast}` : `${bookReplayInfo.status} · depth omitted`}</span>
        <span>Order-flow signals: {orderFlowBacktestTrades.length} · closed {orderFlowCompleted.length}</span>
        <span>Net win rate {orderFlowWinRate === null ? '— · no closed trades' : `${orderFlowWinRate.toFixed(1)}%`}</span>
        <span>Gross wins {orderFlowGrossWins}</span>
        <span style={{ color: '#34d399' }}>Net wins {orderFlowNetWins}</span>
        <span style={{ color: '#fb7185' }}>Net losses {orderFlowNetLosses}</span>
        <span style={{ color: orderFlowNetR >= 0 ? '#34d399' : '#fb7185' }}>Net {orderFlowNetR >= 0 ? '+' : ''}{orderFlowNetR.toFixed(2)}R</span>
      </div>
      <div style={{ marginTop: 5, color: '#64748b' }}>Uses saved closed footprint price levels, bid/ask imbalance, delta/CVD and rolling POC. Historical OI and 5-level book depth are included only when available at the signal time; missing inputs are omitted, never treated as confirmation. Candle wicks score stops/targets; same-candle ordering is conservatively stop-first.</div>
      {closedFootprintBars.length >= 6 && orderFlowBacktestTrades.length === 0 && <div style={{ marginTop: 5, color: '#fbbf24' }}>No setup passed the current strict order-flow rules in the saved-footprint sample. This is not a 0% win-rate result: there were no qualifying trades. The sample is short/incomplete and cannot establish profitability.</div>}
      {orderFlowBacktestTrades.length > 0 && <details style={{ marginTop: 7 }}>
        <summary style={{ cursor: 'pointer', color: '#67e8f9' }}>Order-flow trade log · {orderFlowBacktestTrades.length} entries · newest first</summary>
        <div style={{ overflowX: 'auto', marginTop: 5 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, whiteSpace: 'nowrap' }}>
            <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>{['Signal time', 'Side', 'Entry', 'SL', 'TP1 / TP', 'Exit time', 'Exit', 'Outcome / net', 'Signal evidence / review'].map((label) => <th key={label} style={{ padding: '5px 6px', borderBottom: '1px solid #263449' }}>{label}</th>)}</tr></thead>
            <tbody>{[...orderFlowBacktestTrades].reverse().map((trade, index) => <tr key={`${trade.time}-${index}`} style={{ borderBottom: '1px solid #172033', verticalAlign: 'top' }}>
              <td style={{ padding: 5 }}>{new Date(trade.time * 1000).toLocaleString('en-IN')}</td><td style={{ padding: 5 }}>{trade.side}</td><td style={{ padding: 5 }}>{fmt(trade.entry)}</td><td style={{ padding: 5 }}>{fmt(trade.stop)}</td><td style={{ padding: 5 }}>{fmt(trade.target1)} / {fmt(trade.target2)}</td><td style={{ padding: 5 }}>{trade.exitTime === null ? 'Open' : new Date(trade.exitTime * 1000).toLocaleString('en-IN')}</td><td style={{ padding: 5 }}>{trade.exitPrice === null ? '—' : fmt(trade.exitPrice)}</td><td style={{ padding: 5, color: (trade.netPnlR ?? 0) < 0 ? '#fb7185' : '#34d399' }}>{trade.outcome} · net {trade.netPnlR === null ? '—' : `${trade.netPnlR > 0 ? '+' : ''}${trade.netPnlR.toFixed(2)}R`}</td><td style={{ padding: 5, whiteSpace: 'normal', minWidth: 320 }}>{trade.lossReview ?? trade.reasons.join(' · ')}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>}
    </div>
    {latestAgentReads.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, padding: '0 12px 9px' }}>
      {latestAgentReads.map((read) => <div key={read.agent} style={{ padding: 7, border: '1px solid #1f2937', borderRadius: 4, background: '#0a1019', fontSize: 9 }}>
        <b style={{ color: read.bias === 'LONG' ? '#34d399' : read.bias === 'SHORT' ? '#fb7185' : '#94a3b8' }}>{read.agent} · {read.bias} · {read.strength}/3</b>
        {read.findings.map((finding) => <div key={finding} style={{ color: '#94a3b8', marginTop: 3 }}>{finding}</div>)}
      </div>)}
    </div>}
    {!feedLive ? <div style={{ padding: 12, color: '#fbbf24', fontSize: 11 }}>Paper signal testing is paused because the exchange trade feed is stale or disconnected.</div> : strategyVersion > 3 ? <div style={{ padding: 12, color: '#fbbf24', fontSize: 11 }}>
      All three rule versions have reached a losing trade and testing is paused. The saved journal is kept.
      <button onClick={restartPaperCycle} style={{ ...buttonStyle, marginLeft: 10 }}>Start new V1 paper cycle</button>
    </div> : position ? <div style={{ padding: 12 }}>
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
      <div style={{ marginTop: 9, color: validationReady ? '#94a3b8' : '#fbbf24', fontSize: 10 }}>Paper test auto-starts once per fresh confirmed signal when price remains within 0.25R of entry and the stop is intact. Holdout: {validationTrades.length}/10 closed · net {validationNetR >= 0 ? '+' : ''}{validationNetR.toFixed(1)}R after estimated fees/slippage · {validationReady ? 'positive sample' : 'not yet validated'}. Paper only.</div>
    </div> : <div style={{ padding: 12, color: '#94a3b8', fontSize: 11 }}>
      <b>WAIT · {!ruleSetup ? 'No setup meets the SMC/ICT/order-flow rules on the latest closed bar.' : 'Rule setup found, but there is no fresh nearby persistent supporting wall.'}</b>
      <div style={{ marginTop: 5, color: '#64748b' }}>V{strategyVersion} needs {strategyVersion >= 2 ? '4+' : '3+'} stacked footprint levels ({strategyVersion >= 3 ? '4:1' : '3:1'} imbalance), aligned delta/CVD, rolling POC acceptance, rising OI, flow-confirmed BOS/CHoCH/MSS, a five-bar breakout, confirmed PO3 distribution, and previous-day discount for longs / premium for shorts. A live paper plan additionally needs a current persistent bid wall for LONG or ask wall for SHORT within 0.15% or 2.5R of price. Missing data means WAIT.</div>
      {!['1m', '5m'].includes(timeframe) && <div style={{ marginTop: 5, color: '#fbbf24' }}>Trade-side footprint history is only recorded at 1m and 5m. This timeframe still shows candle-based SMC/ICT marks, but order-flow BUY/SELL replay is unavailable here.</div>}
      <div style={{ marginTop: 4 }}>No-trade is a valid outcome.</div>
    </div>}
    {notice && <div style={{ padding: '0 12px 9px', color: '#fbbf24', fontSize: 10 }}>{notice}</div>}
    <div style={{ margin: '0 12px 9px', padding: '9px', border: '1px solid #263449', borderRadius: 4, background: '#0a1019', fontSize: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <b style={{ color: '#cbd5e1' }}>PAPER FORWARD JOURNAL · {symbol} · {timeframe}</b>
        <span>{journal.length} / 200 saved trades</span>
        <span style={{ color: '#34d399' }}>Net wins {paperWins}</span>
        <span style={{ color: '#fb7185' }}>Net losses {paperLosses}</span>
        <span>Gross {paperGrossR >= 0 ? '+' : ''}{paperGrossR.toFixed(2)}R</span>
        <span>Estimated costs −{paperCostsR.toFixed(2)}R</span>
        <b style={{ color: paperNetR >= 0 ? '#34d399' : '#fb7185' }}>Net {paperNetR >= 0 ? '+' : ''}{paperNetR.toFixed(2)}R</b>
        <span>Expectancy {journal.length ? `${(paperNetR / journal.length >= 0 ? '+' : '')}${(paperNetR / journal.length).toFixed(2)}R/trade` : '—'}</span>
        <span>Profit factor {paperProfitFactor === null ? '—' : Number.isFinite(paperProfitFactor) ? paperProfitFactor.toFixed(2) : '∞'}</span>
      </div>
      <div style={{ marginTop: 5, color: '#64748b' }}>Stored in this browser for this symbol/timeframe; survives refresh and Render restarts and uses no MongoDB space. Clearing browser site data will remove it. Results include the fee/slippage assumptions recorded with each trade.</div>
    </div>
    <div style={{ padding: '0 12px 9px', color: '#94a3b8', fontSize: 10 }}>Strategy test: {strategyVersion > 3 ? 'ALL VERSIONS PAUSED' : `V${strategyVersion} active`}; {journal.filter((row) => row.strategyVersion === strategyVersion && row.result === 'WIN').length} wins / {journal.filter((row) => row.strategyVersion === strategyVersion && row.result === 'LOSS').length} losses in saved journal. Each losing paper trade advances to stricter rules; a loss on V3 pauses the cycle. Starting a new V1 cycle preserves this journal.</div>
    <details style={{ borderTop: '1px solid #1f2937' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 10 }}>Recent paper decision log · {journal.length}</summary>
      {journal.length ? <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#94a3b8' }}>{journal.map((row, index) => <div key={`${row.closedAt}-${index}`} style={{ padding: '4px 0' }}>{new Date(row.closedAt).toLocaleString('en-IN')} · V{row.strategyVersion} · {row.side} · {fmt(row.entry)} → {fmt(row.exit)} · <b style={{ color: row.result === 'WIN' ? '#34d399' : row.result === 'LOSS' ? '#fb7185' : '#fbbf24' }}>{row.result} {row.pnlR.toFixed(2)}R</b> · {row.reason}</div>)}</div> : <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#64748b' }}>No closed paper trades yet.</div>}
    </details>
    <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 9 }}>One fixed SMC + ICT ruleset: timestamped candle structure (BOS/CHoCH/MSS), same-day PO3 distribution and previous-day premium/discount. It does not use footprints, order-book depth, OI, funding or future bars to create entries. The final 30% of candles is the holdout and training trades crossing into it are excluded. Trades use a 5-bar structural stop, 1R/2R scale-out and a 30-bar time exit; same-bar stop/target ambiguity is scored conservatively. Costs estimate taker fees/slippage on both sides; funding and gap-through-stop fills are excluded. Rules are deterministic, not AI self-training. No exchange orders are sent.</div>
  </section>;
}

const buttonStyle: CSSProperties = { background: '#172033', color: '#e2e8f0', border: '1px solid #334155', padding: '6px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 10 };
const costInputStyle: CSSProperties = { width: 66, marginLeft: 5, padding: '4px 5px', color: '#e2e8f0', background: '#0a1019', border: '1px solid #334155', borderRadius: 4, fontSize: 10 };

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
