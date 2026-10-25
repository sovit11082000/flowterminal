import type { SerializedFootprintBar } from '../types/market.js';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { analyzeSmartMoney, isOrderFlowConfirmed, type SmartMoneyAnalysis } from './SmartMoneyOverlay.js';
import { calculateVolumeProfile } from './VolumeProfileCalculator.js';

export interface OIHistoryPoint { timestamp: string; openInterest: string; }
interface NormalizedOIPoint { timeMs: number; oi: number; }
interface DailyPriceRange { high: number; low: number; }
type DailyPriceRanges = Map<number, DailyPriceRange>;

export type SignalCandle = Pick<import('../types/market.js').NormalizedCandle, 'time' | 'open' | 'high' | 'low' | 'close'>;

export type SignalSide = 'LONG' | 'SHORT';
export interface BacktestAgentRead { agent: 'SMC' | 'ICT' | 'ORDER FLOW'; bias: SignalSide | 'WAIT'; strength: number; findings: string[]; }
export interface TradeSetup {
  side: SignalSide;
  time: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  targetR: 2 | 3 | 4;
  score: number;
  maxScore: number;
  reasons: string[];
  strategyVersion: number;
  agentReads: BacktestAgentRead[];
}

export interface BacktestTrade extends TradeSetup {
  phase: 'TRAIN' | 'VALIDATION';
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'TIME' | 'OPEN';
  exitTime: number | null;
  pnlR: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
}

/**
 * Replays the live entry rules using only candles/footprints available at each
 * signal bar. Future candles are consulted only to score the completed trade.
 * DOM and manual profile are deliberately excluded because historical snapshots
 * for those inputs are not retained consistently.
 */
export function backtestOrderFlow(candles: SignalCandle[], footprints: SerializedFootprintBar[], oiHistory: OIHistoryPoint[], symbol: string, barSeconds: number, strategyVersion = 1, maxBars = 43_200): BacktestTrade[] {
  const closedFootprints = footprints.filter((bar) => bar.isClosed).sort((a, b) => a.time - b.time);
  const latestClosedTime = closedFootprints[closedFootprints.length - 1]?.time ?? 0;
  // Do not score against the currently-forming candle. The latest closed
  // footprint timestamp is our exchange-captured cutoff for this replay.
  const history = candles.filter((bar) => Number.isFinite(bar.time) && bar.time <= latestClosedTime).slice(-maxBars);
  const fromTime = history[0]?.time ?? 0;
  const recorded = closedFootprints.filter((bar) => bar.time >= fromTime && bar.time <= latestClosedTime);
  const normalizedOI = normalizeOIHistory(oiHistory);
  const dailyRanges = aggregateDailyRanges(history);
  const footprintsByTime = new Map(recorded.map((bar) => [bar.time, bar]));
  const results: BacktestTrade[] = [];
  let blockedThroughIndex = -1;
  let replayVersion = Math.max(1, strategyVersion);
  let paused = false;
  // Keep the latest 30% as a chronological holdout. Strategy tightening is
  // learned only from trades closed entirely before this boundary.
  const validationStartIndex = Math.floor(history.length * 0.7);
  const validationStartTime = history[validationStartIndex]?.time ?? Infinity;

  for (let i = 7; i < history.length; i++) {
    if (paused) break;
    if (i <= blockedThroughIndex) continue;
    const candle = history[i];
    // Let the setup engine build structure/ICT context from this timestamp's
    // closed prefix only. A full-history analysis here leaks later pivots and
    // PO3 distribution markers into earlier decisions.
    const setup = findOrderFlowSetup(history, recorded, [], [], replayVersion, oiHistory, symbol, barSeconds, undefined, normalizedOI, dailyRanges, candle.time, footprintsByTime);
    if (!setup || setup.time !== candle.time) continue;
    const risk = Math.abs(setup.entry - setup.stop);
    if (!Number.isFinite(risk) || risk <= 0) continue;

    const isLong = setup.side === 'LONG';
    let outcome: BacktestTrade['outcome'] = 'OPEN';
    let exitTime: number | null = null;
    let pnlR: number | null = null;
    let target1Hit = false;
    let target2Hit = false;
    const target1 = setup.target1;
    const target2 = setup.target2;
    const fullHorizonAvailable = i + 30 < history.length;
    const horizon = Math.min(history.length - 1, i + 30);
    for (let j = i + 1; j <= horizon; j++) {
      const bar = history[j];
      const stopHit = isLong ? bar.low <= setup.stop : bar.high >= setup.stop;
      const target1Reached = isLong ? bar.high >= target1 : bar.low <= target1;
      const target2Reached = isLong ? bar.high >= target2 : bar.low <= target2;
      // Conservative OHLC ordering: when the stop and either target fit inside
      // the same bar, count the stop first. Scale half at 1R and half at final TP.
      if (stopHit) {
        if (target1Hit) {
          // Half was realized at +1R and half loses 1R at the original stop:
          // net gross result is zero before fees.
          outcome = 'BREAKEVEN'; pnlR = 0;
        } else {
          outcome = 'LOSS'; pnlR = -1;
        }
        exitTime = bar.time;
        break;
      }
      if (target2Reached) {
        target1Hit = true; target2Hit = true;
        outcome = 'WIN'; exitTime = bar.time;
        pnlR = 0.5 + setup.targetR * 0.5;
        break;
      }
      if (target1Reached) target1Hit = true;
    }
    if (outcome === 'OPEN' && fullHorizonAvailable) {
      const bar = history[horizon];
      outcome = 'TIME'; exitTime = bar.time;
      const unrealizedR = (isLong ? bar.close - setup.entry : setup.entry - bar.close) / risk;
      pnlR = target1Hit ? 0.5 + 0.5 * unrealizedR : unrealizedR;
    }
    blockedThroughIndex = outcome === 'OPEN' ? horizon : history.findIndex((bar) => bar.time === exitTime);
    const phase = setup.time >= validationStartTime ? 'VALIDATION' : 'TRAIN';
    results.push({ ...setup, phase, outcome, exitTime, pnlR, target1Hit, target2Hit });
    // A loss updates only later replay decisions: step up the confluence tier;
    // if the strictest tier also loses, stop replaying this strategy entirely.
    const trainingTradeClosedBeforeBoundary = phase === 'TRAIN' && exitTime !== null && exitTime < validationStartTime;
    if (trainingTradeClosedBeforeBoundary && (outcome === 'LOSS' || (outcome === 'TIME' && (pnlR ?? 0) < 0))) {
      if (replayVersion < 3) replayVersion += 1;
      else paused = true;
    }
  }
  return results;
}

export function drawBacktestMarkers(args: {
  ctx: CanvasRenderingContext2D; chart: IChartApi; series: ISeriesApi<'Candlestick'>;
  width: number; height: number; trades: BacktestTrade[]; liveSetup?: TradeSetup | null;
}): void {
  const { ctx, chart, series, width, height, trades, liveSetup } = args;
  const labels: number[] = [];
  ctx.save();
  ctx.font = 'bold 10px monospace';
  const visibleRange = chart.timeScale().getVisibleRange();
  const visibleFrom = visibleRange ? chartTimeSeconds(visibleRange.from) : -Infinity;
  const visibleTo = visibleRange ? chartTimeSeconds(visibleRange.to) : Infinity;
  const visibleTrades = trades.filter((trade) => trade.time >= visibleFrom && trade.time <= visibleTo);
  for (const trade of visibleTrades) {
    const x1 = chart.timeScale().timeToCoordinate(trade.time as import('lightweight-charts').UTCTimestamp);
    if (x1 === null || x1 < 0 || x1 > width) continue;
    const xExit = trade.exitTime === null ? null : chart.timeScale().timeToCoordinate(trade.exitTime as import('lightweight-charts').UTCTimestamp);
    const x2 = Math.min(width - 3, Math.max(x1 + 36, xExit ?? x1 + 72));
    const risk = Math.abs(trade.entry - trade.stop);
    const targetPrice = trade.side === 'LONG' ? trade.entry + risk * trade.targetR : trade.entry - risk * trade.targetR;
    const lines = [
      { price: trade.entry, color: '#fbbf24', label: 'ENTRY' },
      { price: trade.stop, color: '#fb7185', label: 'SL' },
      { price: trade.target1, color: '#86efac', label: 'TP1 · 1R' },
      { price: targetPrice, color: '#34d399', label: `TP 1:${trade.targetR}` }
    ];
    for (const line of lines) {
      const y = chart.timeScale().width() > 0 ? args.series.priceToCoordinate(line.price) : null;
      if (y === null || y < 0 || y > height) continue;
      ctx.strokeStyle = line.color; ctx.globalAlpha = 0.75; ctx.setLineDash(line.label === 'ENTRY' ? [] : [4, 3]);
      ctx.beginPath(); ctx.moveTo(x1, Math.round(y) + 0.5); ctx.lineTo(x2, Math.round(y) + 0.5); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = line.color; ctx.font = '9px monospace';
      ctx.fillText(line.label, Math.max(2, Math.min(width - 44, x2 - 42)), Math.max(10, y - 3));
    }
  }
  ctx.font = 'bold 10px monospace';
  for (const trade of visibleTrades) {
    const x = chart.timeScale().timeToCoordinate(trade.time as import('lightweight-charts').UTCTimestamp);
    const y = series.priceToCoordinate(trade.entry);
    if (x === null || y === null || x < 0 || x > width || y < 8 || y > height - 8) continue;
    const isLong = trade.side === 'LONG';
    const color = isLong ? '#22c55e' : '#ef4444';
    const markerY = y + (isLong ? 15 : -15);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, markerY + (isLong ? -5 : 5));
    ctx.lineTo(x - 5, markerY + (isLong ? 5 : -5));
    ctx.lineTo(x + 5, markerY + (isLong ? 5 : -5));
    ctx.closePath(); ctx.fill();
    if (labels.some((previous) => Math.abs(previous - markerY) < 14)) continue;
    labels.push(markerY);
    const result = trade.outcome === 'OPEN' ? `OPEN · 1:${trade.targetR}` : `${trade.outcome} ${trade.pnlR?.toFixed(1)}R`;
    const text = `${isLong ? 'BUY' : 'SELL'} · ${result}`;
    const textWidth = ctx.measureText(text).width;
    const labelX = Math.max(2, Math.min(width - textWidth - 8, x + 7));
    ctx.fillStyle = 'rgba(11,14,20,.92)';
    ctx.fillRect(labelX - 3, markerY - 7, textWidth + 6, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, labelX, markerY + 3);
  }
  if (liveSetup) {
    const x = chart.timeScale().timeToCoordinate(liveSetup.time as import('lightweight-charts').UTCTimestamp);
    if (x !== null && x <= width) {
      const risk = Math.abs(liveSetup.entry - liveSetup.stop);
      const target = liveSetup.side === 'LONG' ? liveSetup.entry + risk * liveSetup.targetR : liveSetup.entry - risk * liveSetup.targetR;
      for (const line of [
        { price: liveSetup.entry, label: `ENTRY ${liveSetup.side}`, color: '#fbbf24' },
        { price: liveSetup.stop, label: 'SL', color: '#fb7185' },
        { price: liveSetup.target1, label: 'TP1 · 1R', color: '#86efac' },
        { price: target, label: `TP 1:${liveSetup.targetR}`, color: '#34d399' }
      ]) {
        const y = series.priceToCoordinate(line.price);
        if (y === null || y < 0 || y > height) continue;
        ctx.strokeStyle = line.color; ctx.globalAlpha = 0.9; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(Math.max(0, x), Math.round(y) + 0.5); ctx.lineTo(width - 4, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.fillStyle = line.color; ctx.fillText(line.label, Math.max(3, width - 90), Math.max(10, y - 3));
      }
    }
  }
  ctx.restore();
}

/** Transparent, bar-close order-flow rules. This is a study aid, not a profitability claim. */
export function findOrderFlowSetup(candles: SignalCandle[], footprints: SerializedFootprintBar[], bids: [number, number][], asks: [number, number][], strategyVersion = 1, oiHistory: OIHistoryPoint[] = [], symbol = 'BTCUSDT', barSeconds = 60, smartAnalysis?: SmartMoneyAnalysis, normalizedOI?: NormalizedOIPoint[], dailyRanges?: DailyPriceRanges, signalTime?: number, footprintsByTime?: ReadonlyMap<number, SerializedFootprintBar>): TradeSetup | null {
  const candleLimit = upperBoundCandleTime(candles, signalTime ?? candles[candles.length - 1]?.time ?? 0);
  const recentCandles = candles.slice(Math.max(0, candleLimit - 8), candleLimit);
  const wantedTimes = new Set(recentCandles.map((bar) => bar.time));
  let byTime: ReadonlyMap<number, SerializedFootprintBar>;
  const oldestWanted = recentCandles[0]?.time ?? 0;
  if (footprintsByTime) byTime = footprintsByTime;
  else {
    const recentByTime = new Map<number, SerializedFootprintBar>();
    for (let i = footprints.length - 1; i >= 0; i--) {
      const footprint = footprints[i];
      if (footprint.time < oldestWanted) break;
      if (footprint.isClosed && wantedTimes.has(footprint.time)) recentByTime.set(footprint.time, footprint);
    }
    byTime = recentByTime;
  }
  const bars = recentCandles.filter((bar) => byTime.has(bar.time));
  if (bars.length < 6) return null;

  const current = bars[bars.length - 1];
  const fp = byTime.get(current.time)!;
  const oiRows = normalizedOI ?? normalizeOIHistory(oiHistory);
  const barCloseMs = (current.time + barSeconds) * 1000;
  const oiIndex = upperBoundOITime(oiRows, barCloseMs) - 1;
  const oiNow = oiIndex >= 0 ? oiRows[oiIndex] : null;
  const oiBefore = oiIndex > 0 ? oiRows[oiIndex - 1] : null;
  const oiRecent = !!oiNow && barCloseMs - oiNow.timeMs <= 10 * 60_000;
  if (!oiBefore || !oiRecent) return null;
  const previous = bars.slice(-6, -1);
  const priorHigh = Math.max(...previous.map((bar) => bar.high));
  const priorLow = Math.min(...previous.map((bar) => bar.low));
  const deltaSum = bars.slice(-3).reduce((sum, bar) => sum + (byTime.get(bar.time)?.delta ?? 0), 0);
  const previousFp = byTime.get(bars[bars.length - 2].time)!;
  const breakoutLong = current.close > priorHigh;
  const breakoutShort = current.close < priorLow;
  const imbalanceRatio = strategyVersion >= 3 ? 4 : 3;
  const requiredStack = strategyVersion >= 2 ? 4 : 3;
  const minimumOiIncrease = strategyVersion >= 3 ? 0.0005 : strategyVersion >= 2 ? 0.0004 : 0.0002;

  const levels = [...fp.priceLevels].sort((a, b) => a.price - b.price);
  const minimumLevelVolume = fp.totalVolume * 0.01;
  let askStack = 0; let bidStack = 0; let bestAskStack = 0; let bestBidStack = 0;
  for (const level of levels) {
    const qualifiesByVolume = level.totalVolume >= minimumLevelVolume;
    const askImbalance = qualifiesByVolume && level.askVolume > 0 && level.askVolume >= Math.max(level.bidVolume * imbalanceRatio, 0.000001);
    const bidImbalance = qualifiesByVolume && level.bidVolume > 0 && level.bidVolume >= Math.max(level.askVolume * imbalanceRatio, 0.000001);
    askStack = askImbalance ? askStack + 1 : 0;
    bidStack = bidImbalance ? bidStack + 1 : 0;
    bestAskStack = Math.max(bestAskStack, askStack);
    bestBidStack = Math.max(bestBidStack, bidStack);
  }
  const stackedLong = bestAskStack >= requiredStack;
  const stackedShort = bestBidStack >= requiredStack;
  const deltaLong = fp.delta > 0 && deltaSum > 0;
  const deltaShort = fp.delta < 0 && deltaSum < 0;
  const cvdLong = fp.cumulativeDelta > previousFp.cumulativeDelta;
  const cvdShort = fp.cumulativeDelta < previousFp.cumulativeDelta;
  const priorDayStart = Math.floor(current.time / 86400) * 86400 - 86400;
  const previousDayRange = (dailyRanges ?? aggregateDailyRanges(candles)).get(priorDayStart);
  const priorDayMidpoint = previousDayRange ? (previousDayRange.high + previousDayRange.low) / 2 : null;
  const discountLong = priorDayMidpoint !== null && current.close <= priorDayMidpoint;
  const premiumShort = priorDayMidpoint !== null && current.close >= priorDayMidpoint;
  // Use a trailing, signal-time-only profile so historical tests cannot borrow
  // the user's current manual range or any later candles.
  const profileBars: SerializedFootprintBar[] = [];
  const profileCursor = upperBoundFootprintTime(footprints, current.time) - 1;
  for (let i = profileCursor; i >= 0 && profileBars.length < 30; i--) {
    const bar = footprints[i];
    if (bar.time <= current.time && bar.isClosed) profileBars.push(bar);
    if (bar.time < current.time - barSeconds * 30) break;
  }
  profileBars.reverse();
  const rollingProfile = profileBars.length >= 12
    ? calculateVolumeProfile(profileBars, symbol, profileBars[0].time, profileBars[profileBars.length - 1].time)
    : null;
  const rollingProfileLong = !!rollingProfile && current.close > rollingProfile.poc;
  const rollingProfileShort = !!rollingProfile && current.close < rollingProfile.poc;

  const oiExpansion = oiBefore.oi > 0 && (oiNow!.oi - oiBefore.oi) / oiBefore.oi >= minimumOiIncrease;
  const previousOiSec = oiBefore.timeMs / 1000;
  const priceAtPreviousOi = candles[upperBoundCandleTime(candles, Math.min(previousOiSec, current.time)) - 1];
  const oiPriceUp = !!priceAtPreviousOi && current.close > priceAtPreviousOi.close;
  const oiPriceDown = !!priceAtPreviousOi && current.close < priceAtPreviousOi.close;
  // OI expansion says participation is rising, not whether the initiating
  // traders are long or short; price direction supplies the directional side.
  const oiLong = oiExpansion && oiPriceUp;
  const oiShort = oiExpansion && oiPriceDown;

  // Reject bars that fail the order-flow prerequisites before running the
  // structure/ICT replay. This keeps causal prefix analysis practical on a
  // month of minute bars while ensuring later candles never affect a decision.
  const preAnalysisLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLong && breakoutLong && discountLong;
  const preAnalysisShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShort && breakoutShort && premiumShort;
  if (!preAnalysisLong && !preAnalysisShort) return null;
  const analysis = smartAnalysis ?? analyzeSmartMoney(candles.slice(0, candleLimit));
  const events = analysis.events;
  const startTime = bars[Math.max(0, bars.length - 4)].time;
  let eventIndex = upperBoundEventTime(events, current.time) - 1;
  let recentStructure: SmartMoneyAnalysis['events'][number] | undefined;
  while (eventIndex >= 0 && events[eventIndex].time >= startTime) {
    const event = events[eventIndex--];
    if (['BOS', 'CHOCH', 'MSS'].includes(event.type) && isOrderFlowConfirmed(event, byTime.get(event.time))) { recentStructure = event; break; }
  }
  const structureLong = recentStructure?.bullish === true;
  const structureShort = recentStructure?.bullish === false;
  let sweepIndex = upperBoundEventTime(events, current.time) - 1;
  let recentSweep: SmartMoneyAnalysis['events'][number] | undefined;
  while (sweepIndex >= 0 && events[sweepIndex].time >= current.time - barSeconds * 8) {
    const event = events[sweepIndex--];
    if (event.time < current.time && event.type.endsWith('SWEEP')) { recentSweep = event; break; }
  }
  const po3Distribution = analysis.po3.slice().reverse().find((marker) => marker.label === 'DIST' && marker.time <= current.time && Math.floor(marker.time / 86400) === Math.floor(current.time / 86400));
  const po3Long = po3Distribution?.bullish === true;
  const po3Short = po3Distribution?.bullish === false;

  const bidDepth = bids.slice(0, 5).reduce((sum, level) => sum + level[1], 0);
  const askDepth = asks.slice(0, 5).reduce((sum, level) => sum + level[1], 0);
  const depthAvailable = bidDepth > 0 && askDepth > 0;
  const depthLong = depthAvailable && bidDepth >= askDepth * 1.5;
  const depthShort = depthAvailable && askDepth >= bidDepth * 1.5;

  const longChecks = [stackedLong, deltaLong, cvdLong, rollingProfileLong, oiLong, structureLong, breakoutLong, po3Long, discountLong, ...(depthAvailable ? [depthLong] : [])];
  const shortChecks = [stackedShort, deltaShort, cvdShort, rollingProfileShort, oiShort, structureShort, breakoutShort, po3Short, premiumShort, ...(depthAvailable ? [depthShort] : [])];
  const longScore = longChecks.filter(Boolean).length;
  const shortScore = shortChecks.filter(Boolean).length;
  const mandatoryLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLong && structureLong && breakoutLong && po3Long && discountLong;
  const mandatoryShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShort && structureShort && breakoutShort && po3Short && premiumShort;
  const smcBias: SignalSide | null = structureLong ? 'LONG' : structureShort ? 'SHORT' : null;
  const ictBias: SignalSide | null = po3Long && discountLong ? 'LONG' : po3Short && premiumShort ? 'SHORT' : null;
  const orderFlowLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLong;
  const orderFlowShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShort;
  const orderFlowBias: SignalSide | null = orderFlowLong ? 'LONG' : orderFlowShort ? 'SHORT' : null;
  const agentReads: BacktestAgentRead[] = [
    { agent: 'SMC', bias: smcBias ?? 'WAIT', strength: smcBias ? 3 : 0, findings: [recentStructure ? `${recentStructure.type} break confirmed at ${recentStructure.price.toFixed(2)}` : 'No flow-confirmed BOS/CHoCH/MSS at this bar', recentSweep ? `${recentSweep.type} seen before setup` : 'No recent confirmed sweep'] },
    { agent: 'ICT', bias: ictBias ?? 'WAIT', strength: ictBias ? 3 : 0, findings: [po3Distribution ? `PO3 distribution ${po3Distribution.bullish ? 'up' : 'down'} confirmed` : 'No confirmed PO3 distribution', priorDayMidpoint !== null ? `Previous-day midpoint ${priorDayMidpoint.toFixed(2)}; price is ${discountLong ? 'discount' : premiumShort ? 'premium' : 'near midpoint'}` : 'Previous-day range unavailable'] },
    { agent: 'ORDER FLOW', bias: orderFlowBias ?? 'WAIT', strength: orderFlowBias ? 3 : Math.min(3, [stackedLong || stackedShort, deltaLong || deltaShort, cvdLong || cvdShort, !!rollingProfile, oiExpansion].filter(Boolean).length), findings: [`Footprint stack ${Math.max(bestAskStack, bestBidStack)} levels; delta ${fp.delta.toFixed(3)}; CVD ${fp.cumulativeDelta.toFixed(3)}`, `Rolling POC ${rollingProfile?.poc.toFixed(2) ?? 'unavailable'}; OI ${oiExpansion ? 'expanding with price' : 'not confirmed'}`] }
  ];
  const allAgentsAgreeLong = agentReads.every((agent) => agent.bias === 'LONG');
  const allAgentsAgreeShort = agentReads.every((agent) => agent.bias === 'SHORT');
  const side: SignalSide | null = mandatoryLong && allAgentsAgreeLong && longScore > shortScore
    ? 'LONG'
    : mandatoryShort && allAgentsAgreeShort && shortScore > longScore ? 'SHORT' : null;
  if (!side) return null;

  const entry = current.close;
  const stop = side === 'LONG' ? Math.min(...bars.slice(-5).map((bar) => bar.low)) : Math.max(...bars.slice(-5).map((bar) => bar.high));
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const sign = side === 'LONG' ? 1 : -1;
  // Select only an R target that sits before a confirmed opposing swing.
  // Swings require two closed bars on their right, so this remains causal.
  const targetCandles = candles.slice(Math.max(0, candleLimit - 60), candleLimit);
  const opposingLevels: number[] = [];
  for (let i = 2; i < targetCandles.length - 2; i++) {
    const candidate = targetCandles[i];
    if (side === 'LONG') {
      if (candidate.high > targetCandles[i - 1].high && candidate.high > targetCandles[i - 2].high && candidate.high > targetCandles[i + 1].high && candidate.high > targetCandles[i + 2].high && candidate.high > entry) opposingLevels.push(candidate.high);
    } else if (candidate.low < targetCandles[i - 1].low && candidate.low < targetCandles[i - 2].low && candidate.low < targetCandles[i + 1].low && candidate.low < targetCandles[i + 2].low && candidate.low < entry) opposingLevels.push(candidate.low);
  }
  const nearestLiquidity = opposingLevels.length
    ? side === 'LONG' ? Math.min(...opposingLevels) : Math.max(...opposingLevels)
    : null;
  const availableR = nearestLiquidity === null ? 0 : Math.abs(nearestLiquidity - entry) / risk;
  const targetR = ([4, 3, 2] as const).find((multiple) => multiple <= availableR * 0.95);
  if (!targetR) return null;
  const reasons = [
    side === 'LONG' ? 'Footprint delta and recent three-bar delta agree' : 'Footprint delta and recent three-bar delta agree',
    side === 'LONG' ? `Ask imbalance: ${bestAskStack} consecutive levels at ${imbalanceRatio}:1 or stronger` : `Bid imbalance: ${bestBidStack} consecutive levels at ${imbalanceRatio}:1 or stronger`,
    `CVD moved ${side === 'LONG' ? 'up' : 'down'} on the closed bar`,
    `Trailing 30-bar volume profile accepted ${side === 'LONG' ? 'above' : 'below'} POC ${rollingProfile?.poc.toFixed(2) ?? '—'}`,
    `OI expanded ${(oiBefore && oiNow ? ((oiNow.oi - oiBefore.oi) / oiBefore.oi * 100) : 0).toFixed(3)}% while price moved in the same direction`,
    ...(recentStructure ? [`Recent confirmed ${recentStructure.type} aligns with ${side}`] : []),
    `PO3 distribution confirmed ${side === 'LONG' ? 'up' : 'down'} after manipulation`,
    `Previous-day ${side === 'LONG' ? 'discount' : 'premium'} accepted around ${priorDayMidpoint?.toFixed(2) ?? '—'}`,
    ...(recentSweep ? [`Recent ${recentSweep.type} confirmed a liquidity run before the setup`] : []),
    side === 'LONG' ? 'Close broke above the prior five-bar range' : 'Close broke below the prior five-bar range',
    `Target selected at 1:${targetR} before confirmed opposing swing liquidity ${nearestLiquidity?.toFixed(2) ?? '—'}`,
    ...(depthAvailable && (side === 'LONG' ? depthLong : depthShort) ? ['Top-five DOM depth leans the same way'] : [])
  ];
  const maxScore = longChecks.length;
  return { side, time: current.time, entry, stop, target1: entry + sign * risk, target2: entry + sign * risk * targetR, targetR,
    score: side === 'LONG' ? longScore : shortScore, maxScore, reasons, strategyVersion, agentReads };
}

function normalizeOIHistory(history: OIHistoryPoint[]): NormalizedOIPoint[] {
  return history.map((point) => {
    const rawTimestamp = Number(point.timestamp);
    return { timeMs: rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp, oi: Number(point.openInterest) };
  }).filter((point) => Number.isFinite(point.timeMs) && Number.isFinite(point.oi) && point.oi > 0)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function aggregateDailyRanges(candles: SignalCandle[]): DailyPriceRanges {
  const ranges: DailyPriceRanges = new Map();
  for (const candle of candles) {
    const dayStart = Math.floor(candle.time / 86400) * 86400;
    const range = ranges.get(dayStart);
    if (range) { range.high = Math.max(range.high, candle.high); range.low = Math.min(range.low, candle.low); }
    else ranges.set(dayStart, { high: candle.high, low: candle.low });
  }
  return ranges;
}

function upperBoundOITime(rows: NormalizedOIPoint[], timeMs: number): number {
  let low = 0; let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].timeMs <= timeMs) low = mid + 1; else high = mid;
  }
  return low;
}

function upperBoundEventTime(events: SmartMoneyAnalysis['events'], time: number): number {
  let low = 0; let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].time <= time) low = mid + 1; else high = mid;
  }
  return low;
}

function upperBoundCandleTime(candles: SignalCandle[], time: number): number {
  let low = 0; let high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].time <= time) low = mid + 1; else high = mid;
  }
  return low;
}

function upperBoundFootprintTime(footprints: SerializedFootprintBar[], time: number): number {
  let low = 0; let high = footprints.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (footprints[mid].time <= time) low = mid + 1; else high = mid;
  }
  return low;
}

function chartTimeSeconds(time: Time): number {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}
