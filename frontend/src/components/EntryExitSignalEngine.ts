import type { SerializedFootprintBar } from '../types/market.js';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { analyzeSmartMoney, isOrderFlowConfirmed, type SmartMoneyAnalysis } from './SmartMoneyOverlay.js';
import { calculateVolumeProfile } from './VolumeProfileCalculator.js';
import type { PersistentLiquidityWall } from './LiquidityWallAnalysis.js';

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
  liquidityWall?: PersistentLiquidityWall;
}

export interface BacktestTrade extends TradeSetup {
  phase: 'TRAIN' | 'VALIDATION';
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'TIME' | 'OPEN';
  exitTime: number | null;
  exitPrice: number | null;
  pnlR: number | null;
  costR: number | null;
  netPnlR: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
  lossReview: string | null;
}

export interface BacktestCostAssumptions {
  feeBpsPerSide: number;
  slippageBpsPerSide: number;
}

export interface HistoricalBookSample {
  time: number;
  bids: [number, number][];
  asks: [number, number][];
}

/**
 * Replays the live entry rules using only candles/footprints available at each
 * signal bar. Future candles are consulted only to score the completed trade.
 * DOM and manual profile are deliberately excluded because historical snapshots
 * for those inputs are not retained consistently.
 */
export function backtestOrderFlow(candles: SignalCandle[], footprints: SerializedFootprintBar[], oiHistory: OIHistoryPoint[], symbol: string, barSeconds: number, strategyVersion = 1, maxBars = 43_200, costs: BacktestCostAssumptions = { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 }, bookSamples: HistoricalBookSample[] = []): BacktestTrade[] {
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
  const sortedBookSamples = bookSamples.filter((sample) => Number.isFinite(sample.time)).sort((a, b) => a.time - b.time);
  const results: BacktestTrade[] = [];
  let blockedThroughIndex = -1;
  let replayVersion = Math.max(1, strategyVersion);
  let paused = false;
  // Split the actual footprint/candle overlap, not all candle history. A
  // 30-day candle cache with only 48h of raw fills must not label every
  // eligible trade as holdout just because the older candles lack flow data.
  const eligibleSignalTimes = history.filter((bar) => footprintsByTime.has(bar.time)).map((bar) => bar.time);
  const validationStartIndex = Math.floor(eligibleSignalTimes.length * 0.7);
  const validationStartTime = eligibleSignalTimes[validationStartIndex] ?? Infinity;

  for (let i = 7; i < history.length; i++) {
    if (paused) break;
    if (i <= blockedThroughIndex) continue;
    const candle = history[i];
    // Let the setup engine build structure/ICT context from this timestamp's
    // closed prefix only. A full-history analysis here leaks later pivots and
    // PO3 distribution markers into earlier decisions.
    const book = latestBookAtOrBefore(sortedBookSamples, (candle.time + barSeconds) * 1000);
    const setup = findOrderFlowSetup(history, recorded, book?.bids ?? [], book?.asks ?? [], replayVersion, oiHistory, symbol, barSeconds, undefined, normalizedOI, dailyRanges, candle.time, footprintsByTime, true);
    if (!setup || setup.time !== candle.time) continue;
    const risk = Math.abs(setup.entry - setup.stop);
    if (!Number.isFinite(risk) || risk <= 0) continue;

    const isLong = setup.side === 'LONG';
    let outcome: BacktestTrade['outcome'] = 'OPEN';
    let exitTime: number | null = null;
    let exitPrice: number | null = null;
    let pnlR: number | null = null;
    let target1Hit = false;
    let target2Hit = false;
    let lossReview: string | null = null;
    const target1 = setup.target1;
    const target2 = setup.target2;
    const fullHorizonAvailable = i + 30 < history.length;
    const horizon = Math.min(history.length - 1, i + 30);
    let maxAdverseR = 0;
    let maxFavorableR = 0;
    let exitBar: SignalCandle | null = null;
    for (let j = i + 1; j <= horizon; j++) {
      const bar = history[j];
      maxAdverseR = Math.max(maxAdverseR, isLong ? (setup.entry - bar.low) / risk : (bar.high - setup.entry) / risk);
      maxFavorableR = Math.max(maxFavorableR, isLong ? (bar.high - setup.entry) / risk : (setup.entry - bar.low) / risk);
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
        exitPrice = target1Hit ? (target1 + setup.stop) / 2 : setup.stop;
        exitBar = bar;
        break;
      }
      if (target2Reached) {
        target1Hit = true; target2Hit = true;
        outcome = 'WIN'; exitTime = bar.time;
        exitPrice = (target1 + target2) / 2;
        exitBar = bar;
        pnlR = 0.5 + setup.targetR * 0.5;
        break;
      }
      if (target1Reached) target1Hit = true;
    }
    if (outcome === 'OPEN' && fullHorizonAvailable) {
      const bar = history[horizon];
      outcome = 'TIME'; exitTime = bar.time;
      exitPrice = target1Hit ? (target1 + bar.close) / 2 : bar.close;
      exitBar = bar;
      const unrealizedR = (isLong ? bar.close - setup.entry : setup.entry - bar.close) / risk;
      pnlR = target1Hit ? 0.5 + 0.5 * unrealizedR : unrealizedR;
    }
    if (outcome === 'LOSS' && exitBar && exitTime !== null) {
      const observations: string[] = ['Structural stop was reached before TP1'];
      const exitFootprint = footprintsByTime.get(exitTime);
      const entryFootprint = footprintsByTime.get(setup.time);
      if (exitFootprint) {
        const deltaAgainst = isLong ? exitFootprint.delta < 0 : exitFootprint.delta > 0;
        if (deltaAgainst) observations.push(`exit-bar aggressive delta opposed ${setup.side} (${exitFootprint.delta.toFixed(3)})`);
        if (entryFootprint) {
          const cvdAgainst = isLong
            ? exitFootprint.cumulativeDelta < entryFootprint.cumulativeDelta
            : exitFootprint.cumulativeDelta > entryFootprint.cumulativeDelta;
          if (cvdAgainst) observations.push(`CVD moved against the position from ${entryFootprint.cumulativeDelta.toFixed(3)} to ${exitFootprint.cumulativeDelta.toFixed(3)}`);
        }
      } else observations.push('no saved footprint on the stop bar, so delta/CVD cannot be checked');
      const entryOiIndex = upperBoundOITime(normalizedOI, (setup.time + barSeconds) * 1000) - 1;
      const exitOiIndex = upperBoundOITime(normalizedOI, (exitTime + barSeconds) * 1000) - 1;
      const entryOi = normalizedOI[entryOiIndex];
      const exitOi = normalizedOI[exitOiIndex];
      if (entryOi && exitOi && exitOi.timeMs - entryOi.timeMs <= 30 * barSeconds * 1000 && exitOi.oi > entryOi.oi) {
        const priceMovedAgainst = isLong ? exitBar.close < setup.entry : exitBar.close > setup.entry;
        observations.push(priceMovedAgainst ? 'open interest rose while price closed against the position (new participation; direction is not identifiable from OI alone)' : 'open interest rose into the stop (positioning direction is ambiguous)');
      }
      observations.push(`during the trade, maximum favorable move was ${Math.max(0, maxFavorableR).toFixed(2)}R and adverse excursion reached ${Math.max(0, maxAdverseR).toFixed(2)}R`);
      lossReview = `${observations.join('; ')}. These are observed conditions, not proof of a single cause.`;
    }
    blockedThroughIndex = outcome === 'OPEN' ? horizon : history.findIndex((bar) => bar.time === exitTime);
    const phase = setup.time >= validationStartTime ? 'VALIDATION' : 'TRAIN';
    const costR = pnlR !== null && exitPrice !== null
      ? ((setup.entry + exitPrice) * (Math.max(0, costs.feeBpsPerSide) + Math.max(0, costs.slippageBpsPerSide)) / 10_000) / risk
      : null;
    const netPnlR = pnlR !== null && costR !== null ? pnlR - costR : null;
    results.push({ ...setup, phase, outcome, exitTime, exitPrice, pnlR, costR, netPnlR, target1Hit, target2Hit, lossReview });
    // A loss updates only later replay decisions: step up the confluence tier;
    // if the strictest tier also loses, stop replaying this strategy entirely.
    const trainingTradeClosedBeforeBoundary = phase === 'TRAIN' && exitTime !== null && exitTime < validationStartTime;
    if (trainingTradeClosedBeforeBoundary && (outcome === 'LOSS' || (netPnlR ?? 0) < 0)) {
      if (replayVersion < 3) replayVersion += 1;
      else paused = true;
    }
  }
  return results;
}

function latestBookAtOrBefore(samples: HistoricalBookSample[], timeMs: number): HistoricalBookSample | null {
  let low = 0; let high = samples.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (samples[mid].time <= timeMs) low = mid + 1; else high = mid;
  }
  const sample = samples[low - 1];
  return sample && timeMs - sample.time <= 60_000 ? sample : null;
}

/**
 * Multi-timeframe SMC/ICT experiment: 4h/1h swing range for location and bias,
 * 15m/5m structure alignment, then a fresh 1m structure break for entry.
 * Every higher-timeframe input is restricted to bars fully closed by entry.
 */
export function backtestMtfSmcIct(oneMinuteCandles: SignalCandle[], costs: BacktestCostAssumptions = { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 }): BacktestTrade[] {
  return backtestMtfSmcIctCore(oneMinuteCandles, costs, {
    stopTimeframeSeconds: 60,
    stopLookback: 5,
    maxEstimatedCostR: Infinity,
    maxHoldMinutes: 30,
    requirePo3SweepRetest: false
  });
}

/** V2 uses a completed 5m structure stop, a 60m time limit, and skips entries whose estimated round-trip cost exceeds 0.5R. */
export function backtestMtfSmcIctV2(oneMinuteCandles: SignalCandle[], costs: BacktestCostAssumptions = { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 }): BacktestTrade[] {
  return backtestMtfSmcIctCore(oneMinuteCandles, costs, { stopTimeframeSeconds: 300, stopLookback: 5, maxEstimatedCostR: 0.5, maxHoldMinutes: 60, requirePo3SweepRetest: false });
}

/** V3 adds a confirmed daily PO3 sequence, same-direction liquidity sweep, and fresh 1m FVG/OB retest. */
export function backtestMtfSmcIctV3(oneMinuteCandles: SignalCandle[], costs: BacktestCostAssumptions = { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 }): BacktestTrade[] {
  return backtestMtfSmcIctCore(oneMinuteCandles, costs, { stopTimeframeSeconds: 300, stopLookback: 5, maxEstimatedCostR: 0.5, maxHoldMinutes: 60, requirePo3SweepRetest: true });
}

function backtestMtfSmcIctCore(oneMinuteCandles: SignalCandle[], costs: BacktestCostAssumptions, options: { stopTimeframeSeconds: 60 | 300; stopLookback: number; maxEstimatedCostR: number; maxHoldMinutes: number; requirePo3SweepRetest: boolean }): BacktestTrade[] {
  const history = oneMinuteCandles.filter((bar) => Number.isFinite(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  if (history.length < 4 * 60 * 24) return [];

  const fiveMinute = aggregateCandles(history, 300);
  const fifteenMinute = aggregateCandles(history, 900);
  const oneHour = aggregateCandles(history, 3600);
  const fourHour = aggregateCandles(history, 14_400);
  const analysis1m = analyzeSmartMoney(history);
  const analysis5m = analyzeSmartMoney(fiveMinute);
  const analysis15m = analyzeSmartMoney(fifteenMinute);
  const analysis1h = analyzeSmartMoney(oneHour);
  for (const analysis of [analysis1m, analysis5m, analysis15m, analysis1h]) analysis.events.sort((a, b) => a.time - b.time);
  const validationStartIndex = Math.floor(history.length * 0.7);
  const results: BacktestTrade[] = [];
  let blockedThroughIndex = -1;

  for (let i = 4 * 60 * 24; i < history.length; i++) {
    if (i <= blockedThroughIndex) continue;
    const current = history[i];
    const entryTime = current.time + 60;
    const range4h = confirmedSwingRange(fourHour, 14_400, entryTime, 30);
    const range1h = confirmedSwingRange(oneHour, 3600, entryTime, 36);
    if (!range4h || !range1h) continue;
    const longLocation = current.close <= (range4h.high + range4h.low) / 2 && current.close <= (range1h.high + range1h.low) / 2;
    const shortLocation = current.close >= (range4h.high + range4h.low) / 2 && current.close >= (range1h.high + range1h.low) / 2;

    const bias1h = latestStructure(analysis1h, 3600, entryTime, 24);
    const confirm15m = latestStructure(analysis15m, 900, entryTime, 8);
    const confirm5m = latestStructure(analysis5m, 300, entryTime, 12);
    const trigger1m = latestStructure(analysis1m, 60, entryTime, 3);
    if (!bias1h || !confirm15m || !confirm5m || !trigger1m) continue;
    const side: SignalSide = bias1h.bullish ? 'LONG' : 'SHORT';
    if (confirm15m.bullish !== bias1h.bullish || confirm5m.bullish !== bias1h.bullish || trigger1m.bullish !== bias1h.bullish) continue;
    if (side === 'LONG' ? !longLocation : !shortLocation) continue;
    const po3RetestEvidence = options.requirePo3SweepRetest
      ? confirmedPo3SweepZoneRetest(analysis1m, history, i, entryTime, side === 'LONG', trigger1m.time)
      : null;
    if (options.requirePo3SweepRetest && !po3RetestEvidence) continue;

    const entry = current.close;
    let stopCandles: SignalCandle[];
    if (options.stopTimeframeSeconds === 300) {
      const closedFiveMinuteEnd = upperBoundCandleTime(fiveMinute, entryTime - 300);
      stopCandles = fiveMinute.slice(Math.max(0, closedFiveMinuteEnd - options.stopLookback), closedFiveMinuteEnd);
      if (stopCandles.length < options.stopLookback) continue;
    } else {
      stopCandles = history.slice(i - options.stopLookback + 1, i + 1);
    }
    const stop = side === 'LONG' ? Math.min(...stopCandles.map((bar) => bar.low)) : Math.max(...stopCandles.map((bar) => bar.high));
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0) continue;
    const direction = side === 'LONG' ? 1 : -1;
    const estimatedRoundTripCostR = entry * 2 * (Math.max(0, costs.feeBpsPerSide) + Math.max(0, costs.slippageBpsPerSide)) / 10_000 / risk;
    if (estimatedRoundTripCostR > options.maxEstimatedCostR) continue;
    const target1 = entry + direction * risk;
    const target2 = entry + direction * risk * 2;
    const horizon = Math.min(history.length - 1, i + options.maxHoldMinutes);
    const fullHorizonAvailable = i + options.maxHoldMinutes < history.length;
    if (i < validationStartIndex && horizon >= validationStartIndex) continue;

    let outcome: BacktestTrade['outcome'] = 'OPEN';
    let exitTime: number | null = null;
    let exitPrice: number | null = null;
    let pnlR: number | null = null;
    let target1Hit = false;
    let target2Hit = false;
    let maxAdverseR = 0;
    let maxFavorableR = 0;
    for (let j = i + 1; j <= horizon; j++) {
      const bar = history[j];
      maxAdverseR = Math.max(maxAdverseR, side === 'LONG' ? (entry - bar.low) / risk : (bar.high - entry) / risk);
      maxFavorableR = Math.max(maxFavorableR, side === 'LONG' ? (bar.high - entry) / risk : (entry - bar.low) / risk);
      const stopHit = side === 'LONG' ? bar.low <= stop : bar.high >= stop;
      const target1Reached = side === 'LONG' ? bar.high >= target1 : bar.low <= target1;
      const target2Reached = side === 'LONG' ? bar.high >= target2 : bar.low <= target2;
      if (stopHit) { outcome = target1Hit ? 'BREAKEVEN' : 'LOSS'; pnlR = target1Hit ? 0 : -1; exitTime = bar.time; exitPrice = target1Hit ? (target1 + stop) / 2 : stop; break; }
      if (target2Reached) { target1Hit = true; target2Hit = true; outcome = 'WIN'; pnlR = 1.5; exitTime = bar.time; exitPrice = (target1 + target2) / 2; break; }
      if (target1Reached) target1Hit = true;
    }
    if (outcome === 'OPEN' && fullHorizonAvailable) {
      const exitBar = history[horizon];
      const unrealizedR = (side === 'LONG' ? exitBar.close - entry : entry - exitBar.close) / risk;
      outcome = 'TIME'; exitTime = exitBar.time; exitPrice = target1Hit ? (target1 + exitBar.close) / 2 : exitBar.close;
      pnlR = target1Hit ? 0.5 + 0.5 * unrealizedR : unrealizedR;
    }
    const exitIndex = exitTime === null ? horizon : history.findIndex((bar) => bar.time === exitTime);
    blockedThroughIndex = Math.max(i, exitIndex);
    const costR = pnlR !== null && exitPrice !== null
      ? ((entry + exitPrice) * (Math.max(0, costs.feeBpsPerSide) + Math.max(0, costs.slippageBpsPerSide)) / 10_000) / risk
      : null;
    const netPnlR = pnlR !== null && costR !== null ? pnlR - costR : null;
    const phase = i >= validationStartIndex ? 'VALIDATION' : 'TRAIN';
    const lossReview = outcome === 'LOSS'
      ? `1m ${trigger1m.type} entry aligned with 5m/15m/1h ${side.toLowerCase()} structure; stop hit first. Favorable ${maxFavorableR.toFixed(2)}R, adverse ${maxAdverseR.toFixed(2)}R. Observed path, not proven cause.`
      : null;
    results.push({
      side, time: current.time, entry, stop, target1, target2, targetR: 2, score: 4, maxScore: 4, strategyVersion: 1,
      reasons: [`4h range ${side === 'LONG' ? 'discount' : 'premium'} ${range4h.low.toFixed(2)}–${range4h.high.toFixed(2)}`,
        `1h ${bias1h.type} ${side.toLowerCase()} bias`, `15m ${confirm15m.type} + 5m ${confirm5m.type} aligned`, `1m ${trigger1m.type} entry`, ...(po3RetestEvidence ?? [])],
      agentReads: [
        { agent: 'SMC', bias: side, strength: 3, findings: [`1h ${bias1h.type}; 15m ${confirm15m.type}; 5m ${confirm5m.type}; 1m trigger ${trigger1m.type}`] },
        { agent: 'ICT', bias: side, strength: 2, findings: [`4h and 1h range location confirms ${side === 'LONG' ? 'discount' : 'premium'}`] },
        { agent: 'ORDER FLOW', bias: 'WAIT', strength: 0, findings: ['Not used in this candle-only MTF experiment'] }
      ],
      phase, outcome, exitTime, exitPrice, pnlR, costR, netPnlR, target1Hit, target2Hit, lossReview
    });
  }
  return results;
}

function confirmedPo3SweepZoneRetest(
  analysis: SmartMoneyAnalysis,
  candles: SignalCandle[],
  candleIndex: number,
  entryTime: number,
  bullish: boolean,
  triggerTime: number
): string[] | null {
  const current = candles[candleIndex];
  const dayStart = Math.floor(current.time / 86400) * 86400;
  const dayMarkers = analysis.po3.filter((marker) => Math.floor(marker.time / 86400) * 86400 === dayStart);
  const accumulation = dayMarkers.find((marker) => marker.label === 'ACC');
  if (!accumulation) return null;
  const manipulations = dayMarkers.filter((marker) => marker.label === 'MANIP' && marker.bullish === bullish && marker.time >= accumulation.endTime && marker.time < entryTime);
  const distribution = dayMarkers.find((marker) => marker.label === 'DIST' && marker.bullish === bullish && marker.time < entryTime);
  if (!distribution || triggerTime < distribution.time) return null;
  const manipulation = manipulations.find((marker) => marker.time < distribution.time);
  if (!manipulation) return null;

  const sweepType = bullish ? 'SSL SWEEP' : 'BSL SWEEP';
  const sweep = [...analysis.events].reverse().find((event) => event.type === sweepType && event.bullish === bullish &&
    event.time >= accumulation.endTime && event.time <= manipulation.time && event.time < entryTime);
  if (!sweep) return null;

  const zones = analysis.zones;
  for (let z = zones.length - 1; z >= 0; z--) {
    const zone = zones[z];
    const createdTime = zone.createdTime;
    if (createdTime === undefined || createdTime >= current.time) continue;
    if (createdTime < distribution.time) break;
    if (zone.bullish !== bullish || (zone.kind !== 'FVG' && zone.kind !== 'OB')) continue;
    const createdIndex = upperBoundCandleTime(candles, createdTime) - 1;
    if (createdIndex < 0 || createdIndex >= candleIndex) continue;
    let invalidated = false;
    let alreadyRetested = false;
    for (let j = createdIndex + 1; j < candleIndex; j++) {
      const bar = candles[j];
      if (zone.kind === 'FVG' ? (bullish ? bar.low <= zone.bottom : bar.high >= zone.top)
        : (bullish ? bar.close < zone.bottom : bar.close > zone.top)) { invalidated = true; break; }
      if (bar.high >= zone.bottom && bar.low <= zone.top) { alreadyRetested = true; break; }
    }
    if (invalidated || alreadyRetested) continue;
    const retests = current.high >= zone.bottom && current.low <= zone.top;
    const rejectionClose = bullish ? current.close > current.open && current.close >= zone.top
      : current.close < current.open && current.close <= zone.bottom;
    if (retests && rejectionClose) {
      return [`${sweepType} then confirmed PO3 ACC → MANIP → DIST`, `Fresh ${zone.kind} retest with ${bullish ? 'bullish' : 'bearish'} 1m close`];
    }
  }
  return null;
}

function aggregateCandles(oneMinute: SignalCandle[], periodSeconds: number): SignalCandle[] {
  const groups = new Map<number, { time: number; open: number; high: number; low: number; close: number; count: number; lastTime: number }>();
  for (const candle of oneMinute) {
    const bucket = Math.floor(candle.time / periodSeconds) * periodSeconds;
    const group = groups.get(bucket);
    if (group) { group.high = Math.max(group.high, candle.high); group.low = Math.min(group.low, candle.low); if (candle.time > group.lastTime) { group.close = candle.close; group.lastTime = candle.time; } group.count++; }
    else groups.set(bucket, { time: bucket, open: candle.open, high: candle.high, low: candle.low, close: candle.close, count: 1, lastTime: candle.time });
  }
  const expected = periodSeconds / 60;
  return [...groups.values()].filter((group) => group.count === expected && group.lastTime === group.time + periodSeconds - 60)
    .map(({ count: _count, lastTime: _lastTime, ...candle }) => candle).sort((a, b) => a.time - b.time);
}

function latestStructure(analysis: SmartMoneyAnalysis, periodSeconds: number, closedAt: number, maxAgeBars: number): SmartMoneyAnalysis['events'][number] | null {
  const events = analysis.events;
  for (let i = upperBoundEventTime(events, closedAt) - 1; i >= 0; i--) {
    const event = events[i];
    if (event.time + periodSeconds > closedAt) continue;
    if (closedAt - (event.time + periodSeconds) > maxAgeBars * periodSeconds) break;
    if (event.type === 'BOS' || event.type === 'CHOCH' || event.type === 'MSS') return event;
  }
  return null;
}

function confirmedSwingRange(candles: SignalCandle[], periodSeconds: number, closedAt: number, lookback: number): { high: number; low: number } | null {
  let end = upperBoundCandleTime(candles, closedAt - periodSeconds);
  while (end > 0 && candles[end - 1].time + periodSeconds > closedAt) end--;
  const closed = candles.slice(Math.max(0, end - lookback), end);
  if (closed.length < 5) return null;
  const highs: number[] = []; const lows: number[] = [];
  for (let i = 2; i < closed.length - 2; i++) {
    const bar = closed[i];
    if (bar.high > closed[i - 1].high && bar.high > closed[i - 2].high && bar.high > closed[i + 1].high && bar.high > closed[i + 2].high) highs.push(bar.high);
    if (bar.low < closed[i - 1].low && bar.low < closed[i - 2].low && bar.low < closed[i + 1].low && bar.low < closed[i + 2].low) lows.push(bar.low);
  }
  if (!highs.length || !lows.length) return null;
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

/** Candle-only SMC + ICT replay for the longer retained candle history. */
export function backtestSmcIct(candles: SignalCandle[], barSeconds: number, costs: BacktestCostAssumptions = { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 }): BacktestTrade[] {
  const history = candles.filter((bar) => Number.isFinite(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);
  if (history.length < 40) return [];
  const analysis = analyzeSmartMoney(history);
  const validationStartIndex = Math.floor(history.length * 0.7);
  const results: BacktestTrade[] = [];
  const usedSignalKeys = new Set<string>();
  let blockedThroughIndex = -1;

  for (let i = 30; i < history.length; i++) {
    if (i <= blockedThroughIndex) continue;
    const current = history[i];
    const dayStart = Math.floor(current.time / 86400) * 86400;
    const previousDay = analysis.dailyRanges.get(dayStart - 86400);
    if (!previousDay) continue;
    const midpoint = (previousDay.high + previousDay.low) / 2;
    let structure: SmartMoneyAnalysis['events'][number] | undefined;
    for (let eventIndex = upperBoundEventTime(analysis.events, current.time) - 1; eventIndex >= 0; eventIndex--) {
      const event = analysis.events[eventIndex];
      if (event.time < current.time - barSeconds * 4) break;
      if (['BOS', 'CHOCH', 'MSS'].includes(event.type)) { structure = event; break; }
    }
    if (!structure) continue;
    const side: SignalSide = structure.bullish ? 'LONG' : 'SHORT';
    const locationAligned = side === 'LONG' ? current.close <= midpoint : current.close >= midpoint;
    if (!locationAligned) continue;
    let distribution: SmartMoneyAnalysis['po3'][number] | undefined;
    for (let markerIndex = analysis.po3.length - 1; markerIndex >= 0; markerIndex--) {
      const marker = analysis.po3[markerIndex];
      if (marker.time > current.time) continue;
      if (Math.floor(marker.time / 86400) < dayStart / 86400) break;
      if (marker.label === 'DIST' && Math.floor(marker.time / 86400) === dayStart / 86400) { distribution = marker; break; }
    }
    if (!distribution || distribution.bullish !== (side === 'LONG')) continue;
    const signalKey = `${structure.time}:${distribution.time}:${side}`;
    if (usedSignalKeys.has(signalKey)) continue;
    usedSignalKeys.add(signalKey);

    const entry = current.close;
    const recent = history.slice(i - 4, i + 1);
    const stop = side === 'LONG' ? Math.min(...recent.map((bar) => bar.low)) : Math.max(...recent.map((bar) => bar.high));
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0) continue;
    const direction = side === 'LONG' ? 1 : -1;
    const target1 = entry + direction * risk;
    const target2 = entry + direction * risk * 2;
    const horizon = Math.min(history.length - 1, i + 30);
    const fullHorizonAvailable = i + 30 < history.length;
    if (i < validationStartIndex && horizon >= validationStartIndex) continue;

    let outcome: BacktestTrade['outcome'] = 'OPEN';
    let exitTime: number | null = null;
    let exitPrice: number | null = null;
    let pnlR: number | null = null;
    let target1Hit = false;
    let target2Hit = false;
    let maxAdverseR = 0;
    let maxFavorableR = 0;
    for (let j = i + 1; j <= horizon; j++) {
      const bar = history[j];
      maxAdverseR = Math.max(maxAdverseR, side === 'LONG' ? (entry - bar.low) / risk : (bar.high - entry) / risk);
      maxFavorableR = Math.max(maxFavorableR, side === 'LONG' ? (bar.high - entry) / risk : (entry - bar.low) / risk);
      const stopHit = side === 'LONG' ? bar.low <= stop : bar.high >= stop;
      const target1Reached = side === 'LONG' ? bar.high >= target1 : bar.low <= target1;
      const target2Reached = side === 'LONG' ? bar.high >= target2 : bar.low <= target2;
      if (stopHit) {
        outcome = target1Hit ? 'BREAKEVEN' : 'LOSS'; pnlR = target1Hit ? 0 : -1;
        exitTime = bar.time; exitPrice = target1Hit ? (target1 + stop) / 2 : stop;
        break;
      }
      if (target2Reached) {
        target1Hit = true; target2Hit = true; outcome = 'WIN'; pnlR = 1.5;
        exitTime = bar.time; exitPrice = (target1 + target2) / 2;
        break;
      }
      if (target1Reached) target1Hit = true;
    }
    if (outcome === 'OPEN' && fullHorizonAvailable) {
      const exitBar = history[horizon];
      const unrealizedR = (side === 'LONG' ? exitBar.close - entry : entry - exitBar.close) / risk;
      outcome = 'TIME'; exitTime = exitBar.time;
      exitPrice = target1Hit ? (target1 + exitBar.close) / 2 : exitBar.close;
      pnlR = target1Hit ? 0.5 + 0.5 * unrealizedR : unrealizedR;
    }
    const exitIndex = exitTime === null ? horizon : history.findIndex((bar) => bar.time === exitTime);
    blockedThroughIndex = Math.max(i, exitIndex);
    const phase = i >= validationStartIndex ? 'VALIDATION' : 'TRAIN';
    const costR = pnlR !== null && exitPrice !== null
      ? ((entry + exitPrice) * (Math.max(0, costs.feeBpsPerSide) + Math.max(0, costs.slippageBpsPerSide)) / 10_000) / risk
      : null;
    const netPnlR = pnlR !== null && costR !== null ? pnlR - costR : null;
    const lossReview = outcome === 'LOSS'
      ? `Candle-only replay: ${structure.type} and PO3 agreed, but stop was reached before TP1; maximum favorable ${Math.max(0, maxFavorableR).toFixed(2)}R and adverse ${Math.max(0, maxAdverseR).toFixed(2)}R. This describes the path, not a proven cause.`
      : null;
    results.push({
      side, time: current.time, entry, stop, target1, target2, targetR: 2, score: 2, maxScore: 2,
      reasons: [`SMC ${structure.type} confirmed at ${structure.price.toFixed(2)}`, `ICT PO3 ${side.toLowerCase()} distribution`, side === 'LONG' ? 'Previous-day discount' : 'Previous-day premium'],
      strategyVersion: 1,
      agentReads: [
        { agent: 'SMC', bias: side, strength: 1, findings: [`${structure.type} confirmed by candle close`] },
        { agent: 'ICT', bias: side, strength: 1, findings: [`PO3 distribution aligned; ${side === 'LONG' ? 'discount' : 'premium'} location`] },
        { agent: 'ORDER FLOW', bias: 'WAIT', strength: 0, findings: ['Excluded from candle-only historical replay'] }
      ],
      phase, outcome, exitTime, exitPrice, pnlR, costR, netPnlR, target1Hit, target2Hit, lossReview
    });
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
    const result = trade.outcome === 'OPEN' ? `OPEN · 1:${trade.targetR}` : `${trade.outcome} ${(trade.netPnlR ?? trade.pnlR)?.toFixed(1)}R net`;
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
export function findOrderFlowSetup(candles: SignalCandle[], footprints: SerializedFootprintBar[], bids: [number, number][], asks: [number, number][], strategyVersion = 1, oiHistory: OIHistoryPoint[] = [], symbol = 'BTCUSDT', barSeconds = 60, smartAnalysis?: SmartMoneyAnalysis, normalizedOI?: NormalizedOIPoint[], dailyRanges?: DailyPriceRanges, signalTime?: number, footprintsByTime?: ReadonlyMap<number, SerializedFootprintBar>, allowMissingOI = false): TradeSetup | null {
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
  const oiAvailable = !!oiBefore && oiRecent;
  if (!oiAvailable && !allowMissingOI) return null;
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

  const oiExpansion = oiAvailable && oiBefore!.oi > 0 && (oiNow!.oi - oiBefore!.oi) / oiBefore!.oi >= minimumOiIncrease;
  const previousOiSec = oiBefore?.timeMs ? oiBefore.timeMs / 1000 : current.time;
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
  const oiLongPass = !oiAvailable || oiLong;
  const oiShortPass = !oiAvailable || oiShort;
  const preAnalysisLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLongPass && breakoutLong && discountLong;
  const preAnalysisShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShortPass && breakoutShort && premiumShort;
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

  const longChecks = [stackedLong, deltaLong, cvdLong, rollingProfileLong, ...(oiAvailable ? [oiLong] : []), structureLong, breakoutLong, po3Long, discountLong, ...(depthAvailable ? [depthLong] : [])];
  const shortChecks = [stackedShort, deltaShort, cvdShort, rollingProfileShort, ...(oiAvailable ? [oiShort] : []), structureShort, breakoutShort, po3Short, premiumShort, ...(depthAvailable ? [depthShort] : [])];
  const longScore = longChecks.filter(Boolean).length;
  const shortScore = shortChecks.filter(Boolean).length;
  const mandatoryLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLongPass && structureLong && breakoutLong && po3Long && discountLong;
  const mandatoryShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShortPass && structureShort && breakoutShort && po3Short && premiumShort;
  const smcBias: SignalSide | null = structureLong ? 'LONG' : structureShort ? 'SHORT' : null;
  const ictBias: SignalSide | null = po3Long && discountLong ? 'LONG' : po3Short && premiumShort ? 'SHORT' : null;
  const orderFlowLong = stackedLong && deltaLong && cvdLong && rollingProfileLong && oiLongPass;
  const orderFlowShort = stackedShort && deltaShort && cvdShort && rollingProfileShort && oiShortPass;
  const orderFlowBias: SignalSide | null = orderFlowLong ? 'LONG' : orderFlowShort ? 'SHORT' : null;
  const agentReads: BacktestAgentRead[] = [
    { agent: 'SMC', bias: smcBias ?? 'WAIT', strength: smcBias ? 3 : 0, findings: [recentStructure ? `${recentStructure.type} break confirmed at ${recentStructure.price.toFixed(2)}` : 'No flow-confirmed BOS/CHoCH/MSS at this bar', recentSweep ? `${recentSweep.type} seen before setup` : 'No recent confirmed sweep'] },
    { agent: 'ICT', bias: ictBias ?? 'WAIT', strength: ictBias ? 3 : 0, findings: [po3Distribution ? `PO3 distribution ${po3Distribution.bullish ? 'up' : 'down'} confirmed` : 'No confirmed PO3 distribution', priorDayMidpoint !== null ? `Previous-day midpoint ${priorDayMidpoint.toFixed(2)}; price is ${discountLong ? 'discount' : premiumShort ? 'premium' : 'near midpoint'}` : 'Previous-day range unavailable'] },
    { agent: 'ORDER FLOW', bias: orderFlowBias ?? 'WAIT', strength: orderFlowBias ? 3 : Math.min(3, [stackedLong || stackedShort, deltaLong || deltaShort, cvdLong || cvdShort, !!rollingProfile, oiAvailable && oiExpansion].filter(Boolean).length), findings: [`Footprint stack ${Math.max(bestAskStack, bestBidStack)} levels; delta ${fp.delta.toFixed(3)}; CVD ${fp.cumulativeDelta.toFixed(3)}`, `Rolling POC ${rollingProfile?.poc.toFixed(2) ?? 'unavailable'}; ${oiAvailable ? `OI ${oiExpansion ? 'expanding with price' : 'not confirmed'}` : 'OI unavailable · omitted from historical checks'}`] }
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
    ...(oiAvailable ? [`OI expanded ${((oiNow!.oi - oiBefore!.oi) / oiBefore!.oi * 100).toFixed(3)}% while price moved in the same direction`] : ['OI unavailable; omitted from historical checks']),
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
