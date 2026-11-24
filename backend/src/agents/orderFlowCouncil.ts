import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { SPECIALIST_AGENTS, strategiesFor, strategyById, MANAGER_RULES } from './orderFlowSkill.js';
import { computeMathReports } from './mathSpecialists.js';
import { scanMarketActivity } from './marketScanner.js';
import { createHash } from 'node:crypto';

export interface OrderFlowMicrostructureSummary {
  timeframe: '1m' | '5m';
  closedBarCount: number;
  cvdTrend: 'RISING' | 'FALLING' | 'FLAT';
  cvdChange3Bar: number;
  latestPocPosition: 'POC_TRAPPED_OVERHEAD' | 'POC_SUPPORT_UNDERFOOT' | 'POC_CENTERED';
  latestBarDelta: number;
  latestBarVolume: number;
  absorptionSignal: 'BULLISH_ABSORPTION' | 'BEARISH_ABSORPTION' | 'NONE';
  deltaBreakoutSignal: 'BULLISH_DELTA_IMPULSE' | 'BEARISH_DELTA_BREAKDOWN' | 'NONE';
  stackedBuyImbalances: number[];
  stackedSellImbalances: number[];
  synthetic5mSummary?: {
    open: number;
    high: number;
    low: number;
    close: number;
    totalVolume: number;
    delta: number;
    pocPrice: number;
    pocPosition: 'POC_TRAPPED_OVERHEAD' | 'POC_SUPPORT_UNDERFOOT' | 'POC_CENTERED';
    signal: string;
    cvdTrend?: 'RISING' | 'FALLING' | 'FLAT' | null;
  } | null;
  buyImbalanceLevels?: number[];
  sellImbalanceLevels?: number[];
  executionGuidance: string;
}

export interface IndependentContextMetrics {
  ema50: number | null;
  ema200: number | null;
  emaAlignment: 'BULLISH_ABOVE_50_200' | 'BEARISH_BELOW_50_200' | 'MIXED_CROSSOVER';
  adx14: number | null;
  trendStrengthLabel: 'STRONG_TREND' | 'MODERATE_TREND' | 'WEAK_CHOP';
  rsi14: number | null;
  recent5mTimeline: Array<{
    timeEt: string;
    open: number;
    close: number;
    changePct: number;
    bodyType: 'BULL' | 'BEAR' | 'DOJI';
  }>;
}

export interface RiskAllocation {
  accountBalanceUsd: number;
  riskPerTradePct: number;
  maxRiskUsd: number;
  positionSizeUnits: number;
  notionalValueUsd: number;
  effectiveLeverage: number;
}

export interface DerivedMarketContext {
  nyTimeFormatted: string;
  activeSession: 'ASIA' | 'LONDON' | 'NY_AM' | 'NY_LUNCH' | 'NY_PM' | 'OFF_HOURS';
  silverBulletWindow: 'LONDON_SB' | 'NY_AM_SB' | 'NY_PM_SB' | 'NONE';
  pdh: number | null;
  pdl: number | null;
  pdEq: number | null;
  pwh: number | null;
  pwl: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  drawOnLiquidity: {
    nextBullishTarget: number | null;
    nextBearishTarget: number | null;
    context: string;
  };
  dealingRange: {
    swingHigh: number;
    swingLow: number;
    equilibrium: number;
    zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
    oteLongZone: [number, number];
    oteShortZone: [number, number];
  } | null;
  recentSwingHigh: number | null;
  recentSwingLow: number | null;
  orderFlowSummary?: OrderFlowMicrostructureSummary | null;
  independentContext?: IndependentContextMetrics;
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfTrendDescription: string;
  macro1hTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  macro4hTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  marketRegime: 'TRENDING' | 'EXPANSION' | 'CHOP_COMPRESSION';
  isLowVolumeChop: boolean;
  liquidationSignal: 'NONE' | 'SHORT_SQUEEZE_EXHAUSTION' | 'LONG_LIQUIDATION_FLUSH';
  atr?: number | null;
  sweepReclaim?: { long: boolean; short: boolean; levels: string[] };
}

export interface GammaContext {
  symbol: 'BTC' | 'ETH';
  spotPrice: number;
  netGexUsd: number;
  regime: 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA';
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  pcrRatio: number;
  summary: string;
  updatedAt: number;
}

export interface AgentSnapshot {
  symbol: string;
  timeframe: '1m' | '5m';
  feedStatus: string;
  lastTradeAt: number | null;
  latestPrice: number | null;
  profile?: { poc: number; vah: number; val: number; capturedBars: number } | null;
  technicalContext?: {
    smc: { bias: string; events: Array<{ type: string; time: number; price: number; bullish: boolean }>; zones: Array<{ kind: string; startTime: number; endTime: number; top: number; bottom: number; bullish: boolean }>; liquidity: Array<{ label: string; time: number; price: number; swept: boolean }> };
    ict: {
      po3: Array<{ label: string; time: number; endTime: number; top: number; bottom: number; bullish?: boolean }>;
      dailyRanges: Array<{ day: number; high: number; low: number }>;
      macro1hTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
      macro4hTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    };
  };
  derivedContext?: DerivedMarketContext;
  candles: Array<{ time: number; open?: number; high: number; low: number; close: number }>;
  candles5m?: Array<{ time: number; open?: number; high: number; low: number; close: number }>;
  candles15m?: Array<{ time: number; open?: number; high: number; low: number; close: number }>;
  candles1h?: Array<{ time: number; open?: number; high: number; low: number; close: number }>;
  footprints5m?: Array<{
    time: number; open: number; high: number; low: number; close: number;
    totalVolume: number; buyVolume: number; sellVolume: number; delta: number;
    cumulativeDelta: number; pocPrice: number; isClosed: boolean;
  }>;
  footprints: Array<{
    time: number; open: number; high: number; low: number; close: number;
    totalVolume: number; buyVolume: number; sellVolume: number; delta: number;
    cumulativeDelta: number; pocPrice: number; isClosed: boolean;
    priceLevels: Array<{ price: number; bidVolume: number; askVolume: number; totalVolume: number }>;
  }>;
  derivativesContext?: {
    openInterest: number | null;
    oiChangePct: number | null;
    fundingRate: number | null;
    btcLeaderBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  } | null;
  gammaContext?: GammaContext | null;
  recentLiquidations?: Array<{ symbol: string; timestamp: number; price: number; size: number; side: 'Buy' | 'Sell' }>;
  trades: Array<{ timestamp: number; side: string; price: number; size: number }>;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  paperPerformance?: {
    resolved: number; wins: number; losses: number; expired: number;
    winRate: number | null; averageR: number | null;
    recent: Array<{ side: 'LONG' | 'SHORT'; outcome: 'WIN' | 'LOSS'; pnlR: number }>;
    learnedLessons?: string[];
    strategyScorecard?: Array<{
      strategy: string;
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      netR: number;
      avgR?: number;
    }>;
  } | null;
}

type AiProvider = 'groq' | 'cloudflare' | 'agentrouter';
type AgentRole = 'smc' | 'ict' | 'orderflow' | 'manager';
interface ProviderConfig { provider: AiProvider; model: string; key: string; baseUrl?: string; quotaScope?: string; }

interface UsageWindow { day: string; daily: number; minute: number; minuteCount: number; cooldownUntil: number; }
const requestUsage = new Map<string, UsageWindow>();

function pacificDay(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function quotaKey(config: ProviderConfig): string {
  if (config.quotaScope) return `${config.provider}:${config.quotaScope}:${config.model}`;
  return `${config.provider}:${createHash('sha256').update(config.key).digest('hex')}:${config.model}`;
}

function quotaFor(_config: ProviderConfig): { rpm: number; rpd: number } {
  return { rpm: 28, rpd: 1_000 };
}

function usageFor(config: ProviderConfig): UsageWindow {
  const id = quotaKey(config);
  const today = pacificDay();
  const existing = requestUsage.get(id);
  if (!existing || existing.day !== today) {
    const fresh = { day: today, daily: 0, minute: Math.floor(Date.now() / 60_000), minuteCount: 0, cooldownUntil: 0 };
    requestUsage.set(id, fresh);
    return fresh;
  }
  const currentMinute = Math.floor(Date.now() / 60_000);
  if (existing.minute !== currentMinute) { existing.minute = currentMinute; existing.minuteCount = 0; }
  return existing;
}

function isAvailable(config: ProviderConfig): boolean {
  const usage = usageFor(config);
  const quota = quotaFor(config);
  return Date.now() >= usage.cooldownUntil &&
    (!quota.rpm || usage.minuteCount < quota.rpm) &&
    (!quota.rpd || usage.daily < quota.rpd);
}

function recordAttempt(config: ProviderConfig): void {
  const usage = usageFor(config);
  usage.daily += 1;
  usage.minuteCount += 1;
}

export interface SpecialistReport {
  agentId: string;
  name: string;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  findings: string[];
  strategyCandidates: string[];
  concerns: string[];
  missingData: string[];
}

export interface CouncilPlan {
  decision: 'LONG' | 'SHORT' | 'WAIT';
  summary: string;
  reasons: string[];
  entryTrigger: string;
  entryPrice: number | null;
  invalidation: string;
  stopPrice: number | null;
  target1Price: number | null;
  targetPrice: number | null;
  targetR: number | null;
  exitPlan: string;
  agreeingAgents: string[];
  dissent: string[];
  strategyIds: string[];
  strategyNames: string[];
  riskAllocation?: RiskAllocation | null;
}

export interface CouncilDiagnostics {
  llmCalls: number;
  totalTokens: number;
  permittedDirections: Array<'LONG' | 'SHORT'>;
  gateBlocked: string | null;
  skipped: string[];
}

export interface CouncilResult { reports: SpecialistReport[]; plan: CouncilPlan; model: string; generatedAt: number; diagnostics?: CouncilDiagnostics; }

function textList(value: unknown, maxItems = 5): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, maxItems).map((item) => item.slice(0, 240)) : [];
}

/** Parses model output tolerantly: strips code fences and any preamble/postamble around the first JSON object. */
export function parseObject<T>(text: string): T {
  let cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  }
  let inString = false;
  let escaped = false;
  let repaired = '';
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      repaired += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      repaired += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      repaired += ch;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      repaired += ch === '\n' ? '\\n' : '';
      continue;
    }
    if (inString && ch === '\t') {
      repaired += '\\t';
      continue;
    }
    repaired += ch;
  }
  const parsed: unknown = JSON.parse(repaired);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI provider returned an invalid structured response.');
  return parsed as T;
}

/** Average true range over the last `period` candles (null when there is too little data). */
export function computeAtr(candles: AgentSnapshot['candles'], period = 14): number | null {
  if (candles.length < 3) return null;
  const slice = candles.slice(-(period + 1));
  const ranges: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const prevClose = slice[i - 1].close;
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return ranges.length ? Number((ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(6)) : null;
}

function computeSimpleEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return Number(ema.toFixed(6));
}

/**
 * Wilder's Smoothed RSI (industry-standard implementation).
 *
 * Steps:
 *  1. Need at least (period + 1) closes to compute first diff, so minimum
 *     length required = period + 1 for the seed average.
 *  2. Seed: simple average of gains/losses over the first `period` diffs.
 *  3. Smooth: for every subsequent close apply Wilder's EMA:
 *       avgGain = (prevAvgGain * (period - 1) + currentGain) / period
 *       avgLoss = (prevAvgLoss * (period - 1) + currentLoss) / period
 *  4. RS = avgGain / avgLoss  →  RSI = 100 - 100 / (1 + RS)
 *
 * Returns null when there is not enough data.
 */
function computeRsi(closes: number[], period = 14): number | null {
  // Need period diffs for the seed + at least 1 more diff to smooth over
  if (closes.length < period + 1) return null;

  // --- Step 1: Seed average (simple mean over first `period` diffs) ---
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff; // store as positive
  }
  avgGain /= period;
  avgLoss /= period;

  // --- Step 2: Wilder's smoothing for all remaining closes ---
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

function computeAdx(candles: AgentSnapshot['candles'], period = 14): number | null {
  // Wilder's Smoothed ADX — same exponential smoothing as RSI uses for avgGain/avgLoss.
  // Requires period*2 + 1 bars: first period bars seed the Wilder smoothed ATR/+DM/-DM,
  // then we iterate the remaining bars to converge DX before returning the final ADX value.
  if (candles.length < period * 2 + 1) return null;

  // Helper: single bar TR / +DM / -DM
  const barMetrics = (curr: typeof candles[0], prev: typeof candles[0]) => {
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    return { tr, plusDm, minusDm };
  };

  // Seed: simple sum of first `period` bars
  let smTr = 0, smPlusDm = 0, smMinusDm = 0;
  for (let i = 1; i <= period; i++) {
    const m = barMetrics(candles[i], candles[i - 1]);
    smTr += m.tr; smPlusDm += m.plusDm; smMinusDm += m.minusDm;
  }

  // Wilder smooth the rest
  let dxSum = 0;
  let dxCount = 0;
  for (let i = period + 1; i < candles.length; i++) {
    const m = barMetrics(candles[i], candles[i - 1]);
    smTr     = smTr     - smTr / period     + m.tr;
    smPlusDm = smPlusDm - smPlusDm / period + m.plusDm;
    smMinusDm = smMinusDm - smMinusDm / period + m.minusDm;
    if (smTr <= 0) continue;
    const plusDi  = (smPlusDm  / smTr) * 100;
    const minusDi = (smMinusDm / smTr) * 100;
    const diSum   = plusDi + minusDi;
    if (diSum <= 0) continue;
    // Accumulate DX values to smooth into ADX
    dxSum += (Math.abs(plusDi - minusDi) / diSum) * 100;
    dxCount++;
  }

  if (dxCount === 0) return null;
  return Number((dxSum / dxCount).toFixed(1));
}

function buildIndependentContext(snapshot: AgentSnapshot): IndependentContextMetrics {
  const baseCandles = (snapshot.candles5m && snapshot.candles5m.length >= 20)
    ? snapshot.candles5m
    : snapshot.candles;
  const closes = baseCandles.map((c) => c.close);
  const lastPrice = snapshot.latestPrice ?? closes[closes.length - 1] ?? null;

  const ema50 = computeSimpleEma(closes, 50);
  const ema200 = computeSimpleEma(closes, 200);
  let emaAlignment: IndependentContextMetrics['emaAlignment'] = 'MIXED_CROSSOVER';
  if (lastPrice !== null && ema50 !== null && ema200 !== null) {
    if (lastPrice > ema50 && ema50 > ema200) emaAlignment = 'BULLISH_ABOVE_50_200';
    else if (lastPrice < ema50 && ema50 < ema200) emaAlignment = 'BEARISH_BELOW_50_200';
  } else if (lastPrice !== null && ema50 !== null) {
    emaAlignment = lastPrice > ema50 ? 'BULLISH_ABOVE_50_200' : 'BEARISH_BELOW_50_200';
  }

  const adx14 = computeAdx(baseCandles, 14);
  const trendStrengthLabel: IndependentContextMetrics['trendStrengthLabel'] =
    adx14 === null ? 'MODERATE_TREND' : adx14 >= 28 ? 'STRONG_TREND' : adx14 >= 18 ? 'MODERATE_TREND' : 'WEAK_CHOP';
  const rsi14 = computeRsi(closes, 14);

  const recent5m = (snapshot.candles5m ?? []).slice(-10);
  const recent5mTimeline = recent5m.map((c) => {
    const o = c.open ?? c.close;
    const changePct = o > 0 ? Number((((c.close - o) / o) * 100).toFixed(3)) : 0;
    const bodyType: 'BULL' | 'BEAR' | 'DOJI' =
      Math.abs(changePct) < 0.015 ? 'DOJI' : c.close > o ? 'BULL' : 'BEAR';
    const timeEt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(c.time * 1000));
    return { timeEt, open: o, close: c.close, changePct, bodyType };
  });

  return { ema50, ema200, emaAlignment, adx14, trendStrengthLabel, rsi14, recent5mTimeline };
}

/**
 * A real liquidity sweep needs a wick through the level AND a later closed reclaim back across it.
 * lookback=30 covers a full 30-minute window on 1m charts — enough to catch session sweeps
 * that mature over several candles rather than the previous too-tight 10-bar window.
 */
export function detectSweepReclaim(
  candles: AgentSnapshot['candles'],
  levels: {
    pdh: number | null;
    pdl: number | null;
    pwh: number | null;
    pwl: number | null;
    sessionHigh?: number | null;
    sessionLow?: number | null;
    swingHigh?: number | null;
    swingLow?: number | null;
  },
  lookback = 30
): { long: boolean; short: boolean; levels: string[] } {
  const out = { long: false, short: false, levels: [] as string[] };
  const recent = candles.slice(-lookback);
  const last = recent[recent.length - 1];
  if (!last) return out;
  const longLevels: Array<readonly [string, number | null | undefined]> = [
    ['PDL', levels.pdl],
    ['PWL', levels.pwl],
    ['SESSION_LOW', levels.sessionLow],
    ['SWING_LOW', levels.swingLow]
  ];
  for (const [name, level] of longLevels) {
    if (level !== null && level !== undefined && recent.some((c) => c.low < level) && last.close > level) {
      out.long = true;
      out.levels.push(name);
    }
  }
  const shortLevels: Array<readonly [string, number | null | undefined]> = [
    ['PDH', levels.pdh],
    ['PWH', levels.pwh],
    ['SESSION_HIGH', levels.sessionHigh],
    ['SWING_HIGH', levels.swingHigh]
  ];
  for (const [name, level] of shortLevels) {
    if (level !== null && level !== undefined && recent.some((c) => c.high > level) && last.close < level) {
      out.short = true;
      out.levels.push(name);
    }
  }
  return out;
}

export function detectSidewaysMarket(
  candles: AgentSnapshot['candles'],
  footprints: AgentSnapshot['footprints'],
  lookback = 45,
  activeSession: DerivedMarketContext['activeSession'] = 'OFF_HOURS',
  isForex = false
): { isChop: boolean; chopIndex: number; efficiencyRatio: number; reason: string } {
  if (candles.length < 14) {
    return { isChop: false, chopIndex: 0, efficiencyRatio: 1, reason: '' };
  }

  const windowSize = Math.min(candles.length, lookback);
  const slice = candles.slice(-windowSize);
  const highest = Math.max(...slice.map((c) => c.high));
  const lowest = Math.min(...slice.map((c) => c.low));
  const rangeSpan = Math.max(highest - lowest, 1e-6);
  const rangePct = (rangeSpan / Math.max(lowest, 1e-6)) * 100;

  let trueRangeSum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    trueRangeSum += tr;
  }

  const chopIndex = (Math.log10(trueRangeSum / rangeSpan) / Math.log10(windowSize)) * 100;
  const netMove = Math.abs(slice[slice.length - 1].close - slice[0].close);
  const efficiencyRatio = netMove / Math.max(trueRangeSum, 1e-6);

  const closedFp = footprints.filter((f) => f.isClosed);
  const recentPocs = closedFp.slice(-3).map((f) => f.pocPrice).filter(Boolean);
  let pocOverlap = false;
  if (recentPocs.length === 3) {
    const maxPoc = Math.max(...recentPocs);
    const minPoc = Math.min(...recentPocs);
    if ((maxPoc - minPoc) / recentPocs[0] < 0.0008) {
      pocOverlap = true;
    }
  }

  const tightThreshold = isForex ? 0.08 : 0.55;
  const deadRangeThreshold = isForex ? 0.05 : 0.38;
  const isQuietSession = activeSession === 'ASIA' || activeSession === 'OFF_HOURS' || activeSession === 'NY_LUNCH';
  const isTightSessionGrind = isQuietSession && rangePct < tightThreshold && efficiencyRatio < 0.11;
  const isDeadRangeAnySession = rangePct < deadRangeThreshold;
  const isChop =
    isTightSessionGrind ||
    isDeadRangeAnySession ||
    (chopIndex >= 68.5 && efficiencyRatio < 0.09) ||
    efficiencyRatio < 0.075;

  const reason = isChop
    ? `Sideways Regime (${windowSize}m Range: ${rangePct.toFixed(2)}%, Session: ${activeSession}, ChopIndex: ${chopIndex.toFixed(1)}, ER: ${efficiencyRatio.toFixed(2)})`
    : '';

  return { isChop, chopIndex, efficiencyRatio, reason };
}

export function buildOrderFlowMicrostructureSummary(snapshot: AgentSnapshot): OrderFlowMicrostructureSummary | null {
  const closedBars = snapshot.footprints.filter((bar) => bar.isClosed);
  const bars = closedBars.length >= 1 ? closedBars : snapshot.footprints;
  if (!bars.length) return null;

  const latest = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : latest;
  // Extended lookback: 10 bars (was 6) for better local high/low context — avoids
  // flagging absorption at mid-range when real structure has shifted further out
  const lookback = bars.slice(-10);
  const localHigh = Math.max(...lookback.map((b) => b.high));
  const localLow  = Math.min(...lookback.map((b) => b.low));

  const barSpan = Math.max(latest.high - latest.low, 1e-6);
  const pocOffsetFromClose = latest.pocPrice - latest.close;
  const latestPocPosition: OrderFlowMicrostructureSummary['latestPocPosition'] =
    pocOffsetFromClose > barSpan * 0.18
      ? 'POC_TRAPPED_OVERHEAD'
      : pocOffsetFromClose < -barSpan * 0.18
        ? 'POC_SUPPORT_UNDERFOOT'
        : 'POC_CENTERED';

  // CVD change over last 5 bars (was 3) — more reliable trend signal, less noise from single spike bar.
  // Also normalize against avgVol of lookback window (not just latest bar volume) to avoid
  // a single high-volume bar making everything else look FLAT.
  const refBar5 = bars[Math.max(0, bars.length - 6)];
  const cvdChange3Bar = Number((latest.cumulativeDelta - refBar5.cumulativeDelta).toFixed(3));
  const avgLookbackVol = lookback.reduce((s, b) => s + b.totalVolume, 0) / Math.max(lookback.length, 1);
  const cvdTrend: OrderFlowMicrostructureSummary['cvdTrend'] =
    cvdChange3Bar > avgLookbackVol * 0.08
      ? 'RISING'
      : cvdChange3Bar < -avgLookbackVol * 0.08
        ? 'FALLING'
        : 'FLAT';

  const avgVol = avgLookbackVol;

  let absorptionSignal: OrderFlowMicrostructureSummary['absorptionSignal'] = 'NONE';
  if (
    (latest.low <= localLow * 1.0004 || prev.low <= localLow * 1.0004) &&
    (latest.delta < -avgVol * 0.12 || prev.delta < -avgVol * 0.15) &&
    latest.close > latest.open &&
    latestPocPosition === 'POC_SUPPORT_UNDERFOOT'
  ) {
    absorptionSignal = 'BULLISH_ABSORPTION';
  } else if (
    (latest.high >= localHigh * 0.9996 || prev.high >= localHigh * 0.9996) &&
    (latest.delta > avgVol * 0.12 || prev.delta > avgVol * 0.15) &&
    latest.close < latest.open &&
    latestPocPosition === 'POC_TRAPPED_OVERHEAD'
  ) {
    absorptionSignal = 'BEARISH_ABSORPTION';
  }

  let deltaBreakoutSignal: OrderFlowMicrostructureSummary['deltaBreakoutSignal'] = 'NONE';
  // Require 2 consecutive bars with aligned delta (not just latest bar) to reduce false spikes.
  // prev bar must also be bearish/bullish delta-aligned to confirm institutional commitment.
  const prevDeltaAlignsBear = prev.delta < -avgVol * 0.10;
  const prevDeltaAlignsBull = prev.delta > avgVol * 0.10;
  if (
    lookback.length >= 3 &&
    latest.low <= Math.min(...lookback.slice(0, -1).map((b) => b.low)) &&
    latest.delta < -avgVol * 0.25 &&
    latest.close < latest.pocPrice &&
    prevDeltaAlignsBear                                     // ← 2nd bar confirms bear pressure
  ) {
    deltaBreakoutSignal = 'BEARISH_DELTA_BREAKDOWN';
  } else if (
    lookback.length >= 3 &&
    latest.high >= Math.max(...lookback.slice(0, -1).map((b) => b.high)) &&
    latest.delta > avgVol * 0.25 &&
    latest.close > latest.pocPrice &&
    prevDeltaAlignsBull                                     // ← 2nd bar confirms bull pressure
  ) {
    deltaBreakoutSignal = 'BULLISH_DELTA_IMPULSE';
  }

  const sortedLevels = [...(latest.priceLevels ?? [])].sort((a, b) => a.price - b.price);
  const minRowVolume = avgVol * 0.015;
  const buyFlags = sortedLevels.map((level) => level.askVolume > Math.max(level.bidVolume * 3.0, minRowVolume));
  const sellFlags = sortedLevels.map((level) => level.bidVolume > Math.max(level.askVolume * 3.0, minRowVolume));
  const buyImbalances = sortedLevels.filter((_, i) => buyFlags[i]).map((l) => l.price);
  const sellImbalances = sortedLevels.filter((_, i) => sellFlags[i]).map((l) => l.price);
  const tick = sortedLevels.length > 1
    ? Math.min(...sortedLevels.slice(1).map((l, i) => l.price - sortedLevels[i].price).filter((g) => g > 0))
    : 0;
  const stackedRuns = (flags: boolean[]): number[] => {
    const out: number[] = [];
    let run: number[] = [];
    const flush = (): void => { if (run.length >= 3) out.push(...run); run = []; };
    for (let i = 0; i < sortedLevels.length; i++) {
      const adjacent = run.length > 0 && Number.isFinite(tick) && tick > 0 &&
        sortedLevels[i].price - run[run.length - 1] <= tick * 1.5;
      if (flags[i] && (run.length === 0 || adjacent)) run.push(sortedLevels[i].price);
      else { flush(); if (flags[i]) run.push(sortedLevels[i].price); }
    }
    flush();
    return out;
  };
  const stackedBuy = stackedRuns(buyFlags);
  const stackedSell = stackedRuns(sellFlags);

  let synthetic5mSummary: OrderFlowMicrostructureSummary['synthetic5mSummary'] = null;
  // Prefer REAL 5-minute closed footprints from the 5m OrderFlowAggregator if supplied
  const real5mBars = (snapshot.footprints5m ?? []).filter((b) => b.isClosed);
  const useReal5m = real5mBars.length >= 2;
  const bar5 = useReal5m ? real5mBars[real5mBars.length - 1] : null;
  const prevBar5 = useReal5m ? real5mBars[real5mBars.length - 2] : null;

  if (useReal5m && bar5 && prevBar5) {
    const span5 = Math.max(bar5.high - bar5.low, 1e-6);
    const pocPos5: 'POC_TRAPPED_OVERHEAD' | 'POC_SUPPORT_UNDERFOOT' | 'POC_CENTERED' =
      bar5.pocPrice - bar5.close > span5 * 0.15
        ? 'POC_TRAPPED_OVERHEAD'
        : bar5.close - bar5.pocPrice > span5 * 0.15
          ? 'POC_SUPPORT_UNDERFOOT'
          : 'POC_CENTERED';

    let sig5 = 'NEUTRAL_CONSOLIDATION';
    if (bar5.close < bar5.open && pocPos5 === 'POC_TRAPPED_OVERHEAD' && bar5.delta > 0) {
      sig5 = 'BEARISH_TRAPPED_BUYERS_OVERHEAD_POC';
    } else if (bar5.close < bar5.open && pocPos5 === 'POC_TRAPPED_OVERHEAD' && bar5.delta < -bar5.totalVolume * 0.12) {
      sig5 = 'BEARISH_5M_DELTA_BREAKDOWN';
    } else if (bar5.close > bar5.open && pocPos5 === 'POC_SUPPORT_UNDERFOOT' && bar5.delta < 0) {
      sig5 = 'BULLISH_SELLER_ABSORPTION_UNDERFOOT_POC';
    } else if (bar5.close > bar5.open && pocPos5 === 'POC_SUPPORT_UNDERFOOT' && bar5.delta > bar5.totalVolume * 0.12) {
      sig5 = 'BULLISH_5M_DELTA_IMPULSE';
    }

    const cvdTrend5m = bar5.cumulativeDelta > prevBar5.cumulativeDelta
      ? 'RISING'
      : bar5.cumulativeDelta < prevBar5.cumulativeDelta
        ? 'FALLING'
        : 'FLAT';

    synthetic5mSummary = {
      open: bar5.open,
      high: bar5.high,
      low: bar5.low,
      close: bar5.close,
      totalVolume: Number(bar5.totalVolume.toFixed(3)),
      delta: Number(bar5.delta.toFixed(3)),
      pocPrice: bar5.pocPrice,
      pocPosition: pocPos5,
      signal: sig5,
      cvdTrend: cvdTrend5m
    };
  } else if (snapshot.timeframe === '1m' && bars.length >= 2) {
    const last5 = bars.slice(-5);
    const open5 = last5[0].open;
    const close5 = last5[last5.length - 1].close;
    const high5 = Math.max(...last5.map((b) => b.high));
    const low5 = Math.min(...last5.map((b) => b.low));
    const vol5 = Number(last5.reduce((s, b) => s + b.totalVolume, 0).toFixed(3));
    const delta5 = Number(last5.reduce((s, b) => s + b.delta, 0).toFixed(3));
    const levelMap = new Map<number, number>();
    for (const bar of last5) {
      for (const pl of bar.priceLevels ?? []) {
        levelMap.set(pl.price, (levelMap.get(pl.price) ?? 0) + pl.totalVolume);
      }
    }
    let poc5 = close5;
    let maxVol5 = -1;
    for (const [price, vol] of levelMap.entries()) {
      if (vol > maxVol5) {
        maxVol5 = vol;
        poc5 = price;
      }
    }
    const span5 = Math.max(high5 - low5, 1e-6);
    const pocPos5: 'POC_TRAPPED_OVERHEAD' | 'POC_SUPPORT_UNDERFOOT' | 'POC_CENTERED' =
      poc5 - close5 > span5 * 0.15
        ? 'POC_TRAPPED_OVERHEAD'
        : close5 - poc5 > span5 * 0.15
          ? 'POC_SUPPORT_UNDERFOOT'
          : 'POC_CENTERED';

    let sig5 = 'NEUTRAL_CONSOLIDATION';
    if (close5 < open5 && pocPos5 === 'POC_TRAPPED_OVERHEAD' && delta5 > 0) {
      sig5 = 'BEARISH_TRAPPED_BUYERS_OVERHEAD_POC';
    } else if (close5 < open5 && pocPos5 === 'POC_TRAPPED_OVERHEAD' && delta5 < -vol5 * 0.12) {
      sig5 = 'BEARISH_5M_DELTA_BREAKDOWN';
    } else if (close5 > open5 && pocPos5 === 'POC_SUPPORT_UNDERFOOT' && delta5 < 0) {
      sig5 = 'BULLISH_SELLER_ABSORPTION_UNDERFOOT_POC';
    } else if (close5 > open5 && pocPos5 === 'POC_SUPPORT_UNDERFOOT' && delta5 > vol5 * 0.12) {
      sig5 = 'BULLISH_5M_DELTA_IMPULSE';
    }

    const cvdTrendFallback: 'RISING' | 'FALLING' | 'FLAT' =
      delta5 > vol5 * 0.05 ? 'RISING' : delta5 < -vol5 * 0.05 ? 'FALLING' : 'FLAT';

    synthetic5mSummary = {
      open: open5,
      high: high5,
      low: low5,
      close: close5,
      totalVolume: vol5,
      delta: delta5,
      pocPrice: poc5,
      pocPosition: pocPos5,
      signal: sig5,
      cvdTrend: cvdTrendFallback
    };
  }

  const executionGuidance =
    snapshot.timeframe === '1m'
      ? 'CRITICAL RULE: Never counter-trade momentum on 1m divergence alone. Require synthetic 5m POC alignment or confirmed multi-level absorption.'
      : 'CRITICAL RULE: Align entries with institutional absorption and POC support/resistance relative to close.';

  return {
    timeframe: snapshot.timeframe,
    closedBarCount: closedBars.length,
    cvdTrend,
    cvdChange3Bar,
    latestPocPosition,
    latestBarDelta: Number(latest.delta.toFixed(3)),
    latestBarVolume: Number(latest.totalVolume.toFixed(3)),
    absorptionSignal,
    deltaBreakoutSignal,
    stackedBuyImbalances: stackedBuy.slice(0, 6),
    stackedSellImbalances: stackedSell.slice(0, 6),
    buyImbalanceLevels: buyImbalances.slice(0, 6),
    sellImbalanceLevels: sellImbalances.slice(0, 6),
    synthetic5mSummary,
    executionGuidance
  };
}

export function buildDerivedContext(snapshot: AgentSnapshot): DerivedMarketContext {
  const candles = snapshot.candles;
  const lastCandleTimeSec = candles[candles.length - 1]?.time ?? Math.floor(Date.now() / 1000);
  const refDate = new Date(lastCandleTimeSec * 1000);
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(refDate);
  const partMap = Object.fromEntries(nyParts.map((p) => [p.type, p.value]));
  const nyHour = Number(partMap.hour ?? 0) % 24;
  const nyMinute = Number(partMap.minute ?? 0);
  const nyTimeFormatted = `${partMap.year}-${partMap.month}-${partMap.day} ${String(nyHour).padStart(2, '0')}:${String(nyMinute).padStart(2, '0')} ET`;

  let activeSession: DerivedMarketContext['activeSession'] = 'OFF_HOURS';
  // ET Session map (all times in New York local hour, 24h):
  //   0–1   : NY late-night / very early Asia pre-market → OFF_HOURS
  //   2–4   : Frankfurt open + London pre-market overlap → LONDON
  //   5–7   : London peak hours (5 AM–8 AM ET) → LONDON (was OFF_HOURS — fixed!)
  //   8–11  : NY AM session
  //   12    : NY Lunch
  //   13–15 : NY PM session
  //   16–19 : US after-hours / early Asia pre-market → ASIA (was OFF_HOURS — fixed!)
  //   20–23 : Asia main session
  if (nyHour >= 20 || nyHour < 2) activeSession = 'ASIA';
  else if (nyHour >= 2 && nyHour < 8) activeSession = 'LONDON';
  else if (nyHour >= 8 && nyHour < 12) activeSession = 'NY_AM';
  else if (nyHour >= 12 && nyHour < 13) activeSession = 'NY_LUNCH';
  else if (nyHour >= 13 && nyHour < 16) activeSession = 'NY_PM';
  else activeSession = 'ASIA'; // 16–19: US after-hours bleeds into early Asia

  let silverBulletWindow: DerivedMarketContext['silverBulletWindow'] = 'NONE';
  if (nyHour === 3) silverBulletWindow = 'LONDON_SB';
  else if (nyHour === 10) silverBulletWindow = 'NY_AM_SB';
  else if (nyHour === 14) silverBulletWindow = 'NY_PM_SB';

  const dailyRanges = snapshot.technicalContext?.ict.dailyRanges ?? [];
  const sortedDays = [...dailyRanges].sort((a, b) => a.day - b.day);
  const prevDay = sortedDays.length >= 2 ? sortedDays[sortedDays.length - 2] : sortedDays[0] ?? null;
  const pdh = prevDay ? prevDay.high : null;
  const pdl = prevDay ? prevDay.low : null;
  const pdEq = pdh !== null && pdl !== null ? Number(((pdh + pdl) / 2).toFixed(6)) : null;

  const priorWeekDays = sortedDays.length > 1 ? sortedDays.slice(Math.max(0, sortedDays.length - 8), sortedDays.length - 1) : [];
  const pwh = priorWeekDays.length ? Math.max(...priorWeekDays.map((d) => d.high)) : null;
  const pwl = priorWeekDays.length ? Math.min(...priorWeekDays.map((d) => d.low)) : null;

  const recentSessionCandles = candles.slice(-180);
  const sessionHigh = recentSessionCandles.length ? Math.max(...recentSessionCandles.map((c) => c.high)) : null;
  const sessionLow = recentSessionCandles.length ? Math.min(...recentSessionCandles.map((c) => c.low)) : null;

  const recentWindow = candles.slice(-240);
  const latestPrice = snapshot.latestPrice ?? candles[candles.length - 1]?.close ?? null;
  let dealingRange: DerivedMarketContext['dealingRange'] = null;
  if (recentWindow.length >= 10 && latestPrice !== null) {
    const swingHigh = Math.max(...recentWindow.map((c) => c.high));
    const swingLow = Math.min(...recentWindow.map((c) => c.low));
    const span = swingHigh - swingLow;
    if (span > 0) {
      const equilibrium = Number(((swingHigh + swingLow) / 2).toFixed(6));
      const zone = latestPrice > equilibrium * 1.0002 ? 'PREMIUM' : latestPrice < equilibrium * 0.9998 ? 'DISCOUNT' : 'EQUILIBRIUM';
      dealingRange = {
        swingHigh,
        swingLow,
        equilibrium,
        zone,
        oteLongZone: [Number((swingHigh - span * 0.79).toFixed(6)), Number((swingHigh - span * 0.62).toFixed(6))],
        oteShortZone: [Number((swingLow + span * 0.62).toFixed(6)), Number((swingLow + span * 0.79).toFixed(6))]
      };
    }
  }

  const atrVal = computeAtr(candles) ?? (latestPrice ? latestPrice * 0.004 : 0);
  const rawBullDol = pdh && latestPrice && latestPrice < pdh ? pdh : sessionHigh;
  const rawBearDol = pdl && latestPrice && latestPrice > pdl ? pdl : sessionLow;
  const nextBullishTarget = latestPrice && rawBullDol && (rawBullDol - latestPrice) > atrVal * 2
    ? rawBullDol
    : latestPrice ? Number((latestPrice + atrVal * 3.5).toFixed(6)) : rawBullDol;
  const nextBearishTarget = latestPrice && rawBearDol && (latestPrice - rawBearDol) > atrVal * 2
    ? rawBearDol
    : latestPrice ? Number((latestPrice - atrVal * 3.5).toFixed(6)) : rawBearDol;
  const dolContext = latestPrice && nextBullishTarget && nextBearishTarget
    ? `Bullish Target: ${nextBullishTarget} (Distance: ${(nextBullishTarget - latestPrice).toFixed(1)}) | Bearish Target: ${nextBearishTarget} (Distance: ${(latestPrice - nextBearishTarget).toFixed(1)})`
    : 'DOL searching external liquidity pools';

  const last10 = candles.slice(-10);
  const recentSwingHigh = last10.length ? Math.max(...last10.map((c) => c.high)) : null;
  const recentSwingLow = last10.length ? Math.min(...last10.map((c) => c.low)) : null;
  const orderFlowSummary = buildOrderFlowMicrostructureSummary(snapshot);
  const independentContext = buildIndependentContext(snapshot);

  const macro1hTrend: DerivedMarketContext['macro1hTrend'] = snapshot.technicalContext?.ict.macro1hTrend ?? 'NEUTRAL';
  const macro4hTrend: DerivedMarketContext['macro4hTrend'] = snapshot.technicalContext?.ict.macro4hTrend ?? 'NEUTRAL';

  let htfTrend: DerivedMarketContext['htfTrend'] = 'NEUTRAL';
  if (candles.length >= 30) {
    const span = Math.min(candles.length, 75);
    const sub = candles.slice(-span);
    const htfBars: Array<{ high: number; low: number; close: number; open: number }> = [];
    for (let k = 0; k < sub.length; k += 15) {
      const chunk = sub.slice(k, k + 15);
      if (chunk.length >= 10) {
        htfBars.push({
          open: chunk[0].open ?? chunk[0].close,
          high: Math.max(...chunk.map((c) => c.high)),
          low: Math.min(...chunk.map((c) => c.low)),
          close: chunk[chunk.length - 1].close
        });
      }
    }
    if (htfBars.length >= 3) {
      const latestHtf = htfBars[htfBars.length - 1];
      const prevHtf = htfBars[htfBars.length - 2];
      const oldHtf = htfBars[0];
      const macroUp = latestHtf.close >= oldHtf.close && latestHtf.low >= prevHtf.low;
      const macroDown = latestHtf.close <= oldHtf.close && latestHtf.high <= prevHtf.high;
      if (macroUp && (latestHtf.close > prevHtf.high || latestHtf.high > prevHtf.high)) {
        htfTrend = 'BULLISH';
      } else if (macroDown && (latestHtf.close < prevHtf.low || latestHtf.low < prevHtf.low)) {
        htfTrend = 'BEARISH';
      }
    }
  }

  const htfTrendDescription = `Intraday 15m/5m Bias: ${htfTrend}`;

  let marketRegime: DerivedMarketContext['marketRegime'] = 'TRENDING';
  let isLowVolumeChop = false;
  const recentFp = snapshot.footprints.slice(-15);

  const isForex = /^(XAUUSD|EURUSD|GBPUSD)$/i.test(snapshot.symbol);
  const chopSourceCandles = (snapshot.candles5m && snapshot.candles5m.length >= 20) ? snapshot.candles5m : candles;
  const chopAnalysis = detectSidewaysMarket(chopSourceCandles, snapshot.footprints, 24, activeSession, isForex);

  if (chopAnalysis.isChop) {
    marketRegime = 'CHOP_COMPRESSION';
    isLowVolumeChop = true;
  } else if (recentFp.length >= 6) {
    const avgVolume = recentFp.reduce((s, b) => s + b.totalVolume, 0) / recentFp.length;
    const last3Vol = recentFp.slice(-3).reduce((s, b) => s + b.totalVolume, 0) / 3;
    if (last3Vol > avgVolume * 1.8 || Math.abs(recentFp[recentFp.length - 1]?.delta ?? 0) > avgVolume * 0.3) {
      marketRegime = 'EXPANSION';
    }
  }

  let liquidationSignal: DerivedMarketContext['liquidationSignal'] = 'NONE';
  if (recentFp.length >= 4) {
    const lastBar = recentFp[recentFp.length - 1];
    const prev3 = recentFp.slice(-4, -1);
    const maxHigh = Math.max(...prev3.map((b) => b.high));
    const minLow = Math.min(...prev3.map((b) => b.low));

    if (lastBar.high > maxHigh && lastBar.close < (lastBar.high + lastBar.low) / 2 && lastBar.delta < 0) {
      liquidationSignal = 'SHORT_SQUEEZE_EXHAUSTION';
    } else if (lastBar.low < minLow && lastBar.close > lastBar.open && lastBar.delta > 0) {
      liquidationSignal = 'LONG_LIQUIDATION_FLUSH';
    }
  }

  return {
    nyTimeFormatted,
    activeSession,
    silverBulletWindow,
    pdh,
    pdl,
    pdEq,
    pwh,
    pwl,
    sessionHigh,
    sessionLow,
    drawOnLiquidity: {
      nextBullishTarget,
      nextBearishTarget,
      context: dolContext
    },
    dealingRange,
    recentSwingHigh,
    recentSwingLow,
    orderFlowSummary,
    independentContext,
    htfTrend,
    htfTrendDescription,
    macro1hTrend,
    macro4hTrend,
    marketRegime,
    isLowVolumeChop,
    liquidationSignal,
    atr: computeAtr(candles),
    sweepReclaim: detectSweepReclaim(candles, {
      pdh,
      pdl,
      pwh,
      pwl,
      sessionHigh,
      sessionLow,
      swingHigh: recentSwingHigh,
      swingLow: recentSwingLow
    })
  };
}

// ===========================================================================
// Council configuration
// ===========================================================================
export type Direction = 'LONG' | 'SHORT';

export function councilConfig() {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    minClosedFootprints: 4,
    minCandles: 10,
    minAgreeing: 2,
    minLeadStrength: 2,
    opposeVetoStrength: 2,
    minRR: num('COUNCIL_MIN_RR', 1.25),
    maxRR: num('COUNCIL_MAX_RR', 2.2),
    minRiskPct: num('COUNCIL_MIN_RISK_PCT', 0.15),
    maxRiskPct: num('COUNCIL_MAX_RISK_PCT', 0.45),
    maxEntryDriftPct: num('COUNCIL_MAX_ENTRY_DRIFT_PCT', 0.25),
    accountBalanceUsd: num('ACCOUNT_BALANCE_USD', 1000),
    riskPerTradePct: num('RISK_PER_TRADE_PCT', 0.5),
    maxDailyLossR: num('MAX_DAILY_LOSS_R', 8.0),
    managerMode: (process.env.COUNCIL_MANAGER ?? '').trim().toLowerCase() === 'off' ? 'off' as const : 'llm' as const,
    reasoningEffort: (process.env.GROQ_REASONING_EFFORT ?? '').trim().toLowerCase()
  };
}

// ===========================================================================
// Deterministic hard gates (Data Quality + Stale Feed + Risk Circuit Breaker + Intraday Gates)
// ===========================================================================
export interface GateResult {
  blocked: string | null;
  permitted: Direction[];
  denied: Partial<Record<Direction, string>>;
}

export function evaluateGates(snapshot: AgentSnapshot): GateResult {
  const cfg = councilConfig();
  const derived = snapshot.derivedContext ?? buildDerivedContext(snapshot);
  const closed = snapshot.footprints.filter((bar) => bar.isClosed).length;
  const none: Direction[] = [];

  // 1. Critical Data Quality & Stale/Missing Feed Hard Gate
  if (snapshot.feedStatus !== 'LIVE') {
    return { blocked: `Data quality gate: feed status is ${snapshot.feedStatus || 'UNKNOWN'} (must be LIVE).`, permitted: none, denied: {} };
  }
  if (snapshot.lastTradeAt === null || !Number.isFinite(snapshot.lastTradeAt)) {
    return { blocked: 'Data quality gate: missing lastTradeAt market timestamp.', permitted: none, denied: {} };
  }
  if (Date.now() - snapshot.lastTradeAt > 120_000) {
    const staleSec = Math.round((Date.now() - snapshot.lastTradeAt) / 1000);
    return { blocked: `Data quality gate: market feed stale (${staleSec}s since last trade).`, permitted: none, denied: {} };
  }

  // 2. Account-Level Risk Circuit Breaker (20-min cooldown after 3 consecutive losses, not permanent day lock)
  const recentTrades = snapshot.paperPerformance?.recent ?? [];
  const lastThree = recentTrades.slice(-3);
  if (lastThree.length === 3 && lastThree.every((t) => t.outcome === 'LOSS')) {
    const lastLossAt = (lastThree[2] as { resolvedAt?: number }).resolvedAt ?? 0;
    const elapsedMin = lastLossAt > 0 ? (Date.now() - lastLossAt) / 60_000 : 999;
    if (elapsedMin < 20) {
      const waitMin = Math.ceil(20 - elapsedMin);
      return { blocked: `Risk circuit breaker: 3 consecutive losses; cooling down for ${waitMin}m more.`, permitted: none, denied: {} };
    }
  }
  const recentNetR = recentTrades.reduce((sum, t) => sum + t.pnlR, 0);
  if (recentNetR <= -cfg.maxDailyLossR) {
    return { blocked: `Risk circuit breaker: daily drawdown (${recentNetR.toFixed(2)}R) hit -${cfg.maxDailyLossR}R limit.`, permitted: none, denied: {} };
  }

  if (closed < cfg.minClosedFootprints) {
    return { blocked: `Insufficient context: ${closed} closed footprints supplied (need ${cfg.minClosedFootprints}).`, permitted: none, denied: {} };
  }
  if (snapshot.candles.length < cfg.minCandles) {
    return { blocked: `Insufficient context: ${snapshot.candles.length} candles supplied (need ${cfg.minCandles}).`, permitted: none, denied: {} };
  }

  const sweep = derived.sweepReclaim ?? detectSweepReclaim(snapshot.candles, derived);
  const absorption = derived.orderFlowSummary?.absorptionSignal ?? 'NONE';
  const isChopRegime = derived.marketRegime === 'CHOP_COMPRESSION' || derived.isLowVolumeChop;

  const sweptLevels = sweep.levels ?? [];
  const hasMajorSweepLong = sweep.long && sweptLevels.some((l) => l === 'PDL' || l === 'PWL' || l === 'SESSION_LOW' || l === 'SWING_LOW');
  const hasMajorSweepShort = sweep.short && sweptLevels.some((l) => l === 'PDH' || l === 'PWH' || l === 'SESSION_HIGH' || l === 'SWING_HIGH');

  // Compute dealing range position percentage early so reversal triggers and filters can use it
  const rangeBars = (snapshot.candles5m && snapshot.candles5m.length >= 20)
    ? snapshot.candles5m.slice(-54)
    : snapshot.candles.slice(-270);
  const lastPrice = snapshot.latestPrice ?? snapshot.candles[snapshot.candles.length - 1]?.close ?? null;
  let rangePosPct: number | null = null;
  if (rangeBars.length >= 10 && lastPrice !== null) {
    const rHigh = Math.max(...rangeBars.map((c) => c.high));
    const rLow = Math.min(...rangeBars.map((c) => c.low));
    const rSpan = rHigh - rLow;
    if (rSpan > 0) rangePosPct = ((lastPrice - rLow) / rSpan) * 100;
  }
  if (rangePosPct === null && derived.dealingRange && lastPrice !== null) {
    const dr = derived.dealingRange;
    const span = dr.swingHigh - dr.swingLow;
    if (span > 0) rangePosPct = ((lastPrice - dr.swingLow) / span) * 100;
  }

  const fpNetDelta = snapshot.footprints.slice(-60).reduce((s, b) => s + b.delta, 0);
  const recent15Delta = snapshot.footprints.slice(-15).reduce((s, b) => s + b.delta, 0);

  // RULE 2: Institutional Top Rejection & Bottom Absorption Triggers
  // Unblock counter-trend reversals when price is at range extremes with confirmed order flow absorption
  const ofSummary = derived.orderFlowSummary;
  const isCeilingAbsorption = ofSummary?.absorptionSignal === 'BEARISH_ABSORPTION' ||
    ofSummary?.deltaBreakoutSignal === 'BEARISH_DELTA_BREAKDOWN' ||
    (ofSummary?.stackedSellImbalances && ofSummary.stackedSellImbalances.length >= 3);
  const isFloorAbsorption = ofSummary?.absorptionSignal === 'BULLISH_ABSORPTION' ||
    ofSummary?.deltaBreakoutSignal === 'BULLISH_DELTA_IMPULSE' ||
    (ofSummary?.stackedBuyImbalances && ofSummary.stackedBuyImbalances.length >= 3);

  // If price is at or above 78% of range (Deep Premium) and shows selling delta or ceiling rejection
  const isPremiumTopRejection = (rangePosPct !== null && rangePosPct >= 78) &&
    (recent15Delta < 0 || isCeilingAbsorption || (ofSummary?.cvdTrend === 'FALLING' && (ofSummary?.latestBarDelta ?? 0) < 0));

  // If price is at or below 22% of range (Deep Discount) and shows buying delta or floor absorption
  const isDiscountBottomAbsorption = (rangePosPct !== null && rangePosPct <= 22) &&
    (recent15Delta > 0 || isFloorAbsorption || (ofSummary?.cvdTrend === 'RISING' && (ofSummary?.latestBarDelta ?? 0) > 0));

  const hasReversalTriggerLong = hasMajorSweepLong || absorption === 'BULLISH_ABSORPTION' || isFloorAbsorption || isDiscountBottomAbsorption;
  const hasReversalTriggerShort = hasMajorSweepShort || absorption === 'BEARISH_ABSORPTION' || isCeilingAbsorption || isPremiumTopRejection;

  // Do not block CHOP if there is an active institutional absorption or sweep-reclaim
  if (isChopRegime && !hasReversalTriggerLong && !hasReversalTriggerShort) {
    return { blocked: 'CHOP_COMPRESSION: sideways/low-volume market detected; standing aside completely.', permitted: none, denied: {} };
  }

  const denied: Partial<Record<Direction, string>> = {};

  const activityScan = scanMarketActivity(snapshot);
  const is15mBullish = activityScan.structure15m === 'UPTREND_STRUCTURE' || activityScan.structure15m === 'DIP_IN_UPTREND';
  const is15mBearish = activityScan.structure15m === 'DOWNTREND_STRUCTURE' || activityScan.structure15m === 'BOUNCE_IN_DOWNTREND';

  const macroBearish = is15mBearish && !is15mBullish;
  const macroBullish = is15mBullish && !is15mBearish;

  // Flow Conflict Guard: If 15m structure says BULLISH but delta says BEARISH (or vice-versa),
  // the market is sending contradictory signals — downgrade to soft warning on the weaker direction.
  if (activityScan.flowConflictWarning) {
    const conflictDir: Direction = (activityScan.dominantFlow === 'BULLISH' && activityScan.cumDelta15m < 0) ? 'LONG'
      : (activityScan.dominantFlow === 'BEARISH' && activityScan.cumDelta15m > 0) ? 'SHORT' : null as unknown as Direction;
    if (conflictDir && !denied[conflictDir] && !hasMajorSweepLong && !hasMajorSweepShort) {
      denied[conflictDir] = `Flow Conflict: 15m structure (${activityScan.dominantFlow}) contradicted by delta (${activityScan.cumDelta15m}); ${conflictDir} needs sweep/absorption to override.`;
    }
  }

  // RULE 1: Strict Premium / Discount Range & EMA Overextension Guard
  const ema50 = derived.independentContext?.ema50 ?? null;
  const isCrypto = /USDT|USDC|BUSD/i.test(snapshot.symbol);
  const maxEmaOverextensionPct = isCrypto ? 0.9 : 0.6; // Tightened: 0.9% for crypto to prevent chasing vertical pumps
  const distEmaPct = (lastPrice !== null && ema50 !== null && ema50 > 0)
    ? ((lastPrice - ema50) / ema50) * 100
    : null;

  const upperPremiumThreshold = isCrypto ? 74 : 80;
  const deepPremiumThreshold = isCrypto ? 82 : 88;
  const lowerDiscountThreshold = isCrypto ? 26 : 20;
  const deepDiscountThreshold = isCrypto ? 18 : 12;

  // Long Filter in Premium:
  if (rangePosPct !== null && rangePosPct >= upperPremiumThreshold && !hasMajorSweepLong) {
    if (rangePosPct >= deepPremiumThreshold) {
      denied.LONG = `Top chasing blocked: price already at ${rangePosPct.toFixed(0)}% of range (Deep Premium); wait for pullback to Discount/EMA before buying.`;
    } else if (distEmaPct !== null && distEmaPct > maxEmaOverextensionPct) {
      denied.LONG = `Top chasing blocked: price at ${rangePosPct.toFixed(0)}% of range and +${distEmaPct.toFixed(2)}% stretched above 50 EMA; wait for mean-reversion retest.`;
    }
  }

  // Short Filter in Discount:
  if (rangePosPct !== null && rangePosPct <= lowerDiscountThreshold && !hasMajorSweepShort) {
    if (rangePosPct <= deepDiscountThreshold) {
      denied.SHORT = `Bottom chasing blocked: price already at ${rangePosPct.toFixed(0)}% of range (Deep Discount); wait for bounce before shorting.`;
    } else if (distEmaPct !== null && distEmaPct < -maxEmaOverextensionPct) {
      denied.SHORT = `Bottom chasing blocked: price at ${rangePosPct.toFixed(0)}% of range and ${distEmaPct.toFixed(2)}% stretched below 50 EMA; wait for mean-reversion bounce.`;
    }
  }

  // Short-term 30-bar extension check: never buy the top of a vertical rally or sell the bottom of a dump
  const shortWindow = snapshot.candles.slice(-30);
  if (shortWindow.length >= 15 && lastPrice !== null) {
    const sHigh = Math.max(...shortWindow.map((c) => c.high));
    const sLow = Math.min(...shortWindow.map((c) => c.low));
    const sSpan = sHigh - sLow;
    if (sSpan > 0) {
      const shortPosPct = ((lastPrice - sLow) / sSpan) * 100;
      const shortPosLongLimit = isCrypto ? 78 : 84;
      const shortPosShortLimit = isCrypto ? 22 : 16;
      if (shortPosPct > shortPosLongLimit && !denied.LONG && !hasMajorSweepLong) {
        denied.LONG = `Late entry blocked: price at ${shortPosPct.toFixed(0)}% of 30m rally top; wait for pullback to value area.`;
      }
      if (shortPosPct < shortPosShortLimit && !denied.SHORT && !hasMajorSweepShort && !macroBearish) {
        denied.SHORT = `Late entry blocked: price at ${shortPosPct.toFixed(0)}% of 30m dump bottom; wait for bounce to value area.`;
      }
    }
  }

  // RULE 3: Falling Knife & Rising Rocket Guard (Multi-candle momentum direction)
  const recentBars5m = (snapshot.candles5m && snapshot.candles5m.length >= 4)
    ? snapshot.candles5m.slice(-4)
    : snapshot.candles.slice(-12);
  if (recentBars5m.length >= 2) {
    const bPrev = recentBars5m[recentBars5m.length - 2];
    const bCurr = recentBars5m[recentBars5m.length - 1];
    const bPrevOpen = bPrev.open ?? bPrev.close;
    const bCurrOpen = bCurr.open ?? bCurr.close;
    const currRange = bCurr.high - bCurr.low;

    // Falling Knife: 2+ consecutive red bars with lower lows dropping from highs
    const isConsecutiveRed = bPrev.close < bPrevOpen && bCurr.close < bCurrOpen && bCurr.low <= bPrev.low;
    const dropPct = bPrev.high > 0 ? ((bPrev.high - bCurr.low) / bPrev.high) * 100 : 0;
    const minImpulsiveDrop = isCrypto ? 0.3 : 0.1; // 0.3% drop on crypto
    if (isConsecutiveRed && dropPct >= minImpulsiveDrop && !denied.LONG && !hasMajorSweepLong) {
      const lowerWick = Math.min(bCurr.close, bCurrOpen) - bCurr.low;
      const hasBullishAbsorptionWick = currRange > 0 && (lowerWick / currRange >= 0.38) && (bCurr.close > bCurr.low + currRange * 0.35);
      const hasGreenReclaim = bCurr.close > bCurrOpen;
      if (!hasBullishAbsorptionWick && !hasGreenReclaim) {
        denied.LONG = `Falling Knife Guard: 2+ consecutive impulsive red candles dropping (-${dropPct.toFixed(2)}%); LONG blocked until bullish wick rejection or green candle confirmation.`;
      }
    }

    // Rising Rocket: 2+ consecutive green bars with higher highs rallying into resistance
    const isConsecutiveGreen = bPrev.close > bPrevOpen && bCurr.close > bCurrOpen && bCurr.high >= bPrev.high;
    const pumpPct = bPrev.low > 0 ? ((bCurr.high - bPrev.low) / bPrev.low) * 100 : 0;
    const minImpulsivePump = isCrypto ? 0.3 : 0.1;
    if (isConsecutiveGreen && pumpPct >= minImpulsivePump && !denied.SHORT && !hasMajorSweepShort) {
      const upperWick = bCurr.high - Math.max(bCurr.close, bCurrOpen);
      const hasBearishRejectionWick = currRange > 0 && (upperWick / currRange >= 0.38) && (bCurr.close < bCurr.high - currRange * 0.35);
      const hasRedReversal = bCurr.close < bCurrOpen;
      if (!hasBearishRejectionWick && !hasRedReversal) {
        denied.SHORT = `Rising Rocket Guard: 2+ consecutive impulsive green candles rallying (+${pumpPct.toFixed(2)}%); SHORT blocked until bearish wick rejection or red candle confirmation.`;
      }
    }
  }

  if (macroBearish && !hasReversalTriggerLong) {
    denied.LONG = `Intraday 15m/5m trend is BEARISH (${activityScan.structure15m}); LONGs blocked unless sweep-reclaim or absorption occurs.`;
  } else if (macroBearish && fpNetDelta < 0 && recent15Delta <= 0 && !isDiscountBottomAbsorption) {
    denied.LONG = `Counter-trend LONG blocked: 15m/5m BEARISH and both 60m (${fpNetDelta.toFixed(1)}) and 15m (${recent15Delta.toFixed(1)}) delta remain negative.`;
  }

  if (macroBullish && !hasReversalTriggerShort) {
    denied.SHORT = `Intraday 15m/5m trend is BULLISH (${activityScan.structure15m}); SHORTs blocked unless sweep-rejection or absorption occurs.`;
  } else if (macroBullish && fpNetDelta > 0 && recent15Delta >= 0 && !isPremiumTopRejection) {
    denied.SHORT = `Counter-trend SHORT blocked: 15m/5m BULLISH and both 60m (+${fpNetDelta.toFixed(1)}) and 15m (+${recent15Delta.toFixed(1)}) delta remain positive.`;
  } else if (rangePosPct !== null && rangePosPct < 12 && !hasMajorSweepShort && !macroBearish) {
    // Bottom-chasing: only block SHORT when trend is NOT already bearish
    // In a real downtrend, price IS at the bottom — that's the trade! Block only counter-trend shorts into dumps
    denied.SHORT = `Bottom chasing blocked: price at ${rangePosPct.toFixed(0)}% of dealing range in a neutral/bullish market; wait for bounce or OTE retest.`;
  }

  if (activityScan.blockedDirection === 'LONG' && !denied.LONG) {
    denied.LONG = activityScan.blockReason ?? 'Blocked by Pre-Trade Market Activity Scanner.';
  }
  if (activityScan.blockedDirection === 'SHORT' && !denied.SHORT) {
    denied.SHORT = activityScan.blockReason ?? 'Blocked by Pre-Trade Market Activity Scanner.';
  }

  // Higher-Low / Lower-High Micro-Structure Guard (prevents shorting higher lows like 15:51 BTC trap)
  if (snapshot.candles.length >= 45 && lastPrice !== null) {
    const prev30to15 = snapshot.candles.slice(-45, -15);
    const last15 = snapshot.candles.slice(-15);
    const priorLow = Math.min(...prev30to15.map((c) => c.low));
    const recentLow = Math.min(...last15.map((c) => c.low));
    const priorHigh = Math.max(...prev30to15.map((c) => c.high));
    const recentHigh = Math.max(...last15.map((c) => c.high));

    if (recentLow > priorLow && lastPrice > recentLow && recent15Delta > 0 && macroBullish && !hasMajorSweepShort && !isPremiumTopRejection && !denied.SHORT) {
      denied.SHORT = `Higher-Low Guard: higher low formed with positive delta in bullish structure; SHORT blocked.`;
    }
    if (recentHigh < priorHigh && lastPrice < recentHigh && recent15Delta < 0 && macroBearish && !hasMajorSweepLong && !isDiscountBottomAbsorption && !denied.LONG) {
      denied.LONG = `Lower-High Guard: lower high formed with negative delta in bearish structure; LONG blocked.`;
    }
  }

  if (derived.macro1hTrend === 'BEARISH' && !denied.LONG) {
    const isLegitDiscountReversal = hasMajorSweepLong && (rangePosPct !== null && rangePosPct <= 25);
    if (!isLegitDiscountReversal) {
      denied.LONG = 'HTF Alignment Shield: Macro 1H trend is BEARISH; counter-trend LONG blocked without major HTF sweep in extreme Discount (<=25%).';
    }
  }
  if (derived.macro1hTrend === 'BULLISH' && !denied.SHORT) {
    const isLegitPremiumReversal = hasMajorSweepShort && (rangePosPct !== null && rangePosPct >= 75);
    if (!isLegitPremiumReversal) {
      denied.SHORT = 'HTF Alignment Shield: Macro 1H trend is BULLISH; counter-trend SHORT blocked without major HTF sweep in extreme Premium (>=75%).';
    }
  }

  if (derived.macro4hTrend === 'BEARISH' && !denied.LONG) {
    const isLegitDiscountReversal = hasMajorSweepLong && (rangePosPct !== null && rangePosPct <= 20);
    if (!isLegitDiscountReversal) {
      denied.LONG = 'Macro 4H trend is BEARISH; counter-trend LONG blocked without confirmed HTF liquidity sweep in deep discount.';
    }
  }
  if (derived.macro4hTrend === 'BULLISH' && !denied.SHORT) {
    const isLegitPremiumReversal = hasMajorSweepShort && (rangePosPct !== null && rangePosPct >= 80);
    if (!isLegitPremiumReversal) {
      denied.SHORT = 'Macro 4H trend is BULLISH; counter-trend SHORT blocked without confirmed HTF liquidity raid in deep premium.';
    }
  }

  // 4. Open Interest + Funding Rate Trap Filter & BTC Market-Leader Correlation Guard
  const deriv = snapshot.derivativesContext;
  if (deriv) {
    // Block chasing a rally driven purely by falling OI (short-covering squeeze without fresh longs)
    if (deriv.oiChangePct !== null && deriv.oiChangePct <= -0.45 && recent15Delta > 0 && !hasMajorSweepLong && !denied.LONG) {
      denied.LONG = `OI Squeeze Trap blocked: Open Interest dropping (${deriv.oiChangePct.toFixed(2)}%) on rally (short-covering only, no fresh longs).`;
    }
    // Altcoin correlation: never buy ETH/SOL into an active BTC dump or short into an active BTC pump
    const isAltCrypto = /^(ETHUSDT|SOLUSDT)$/i.test(snapshot.symbol);
    if (isAltCrypto && deriv.btcLeaderBias === 'BEARISH' && !hasMajorSweepLong && !denied.LONG) {
      denied.LONG = `BTC Correlation Guard: BTCUSDT is actively dumping; ${snapshot.symbol} LONG blocked.`;
    }
    if (isAltCrypto && deriv.btcLeaderBias === 'BULLISH' && !hasMajorSweepShort && !denied.SHORT) {
      denied.SHORT = `BTC Correlation Guard: BTCUSDT is actively pumping; ${snapshot.symbol} SHORT blocked.`;
    }
  }

  // 5. Options Gamma Exposure (GEX) & Wall Guard (Deribit Institutional Flow)
  const gamma = snapshot.gammaContext;
  if (gamma && lastPrice !== null) {
    // In POSITIVE GAMMA regime, Market Makers hedge against the move (suppressing volatility / pinning to walls)
    // Chasing LONG right into Call Wall is high risk unless there is an active sweep or breakout
    if (gamma.regime === 'POSITIVE_GAMMA' && gamma.callWall !== null) {
      const distToCallWallPct = ((gamma.callWall - lastPrice) / lastPrice) * 100;
      if (distToCallWallPct >= -0.15 && distToCallWallPct <= 0.35 && !hasMajorSweepLong && !denied.LONG) {
        denied.LONG = `Positive Gamma Call Wall: price ($${lastPrice}) right at institutional Call Wall ($${gamma.callWall}); dealers actively pin/sell rallies here.`;
      }
    }
    // Chasing SHORT right into Put Wall in positive gamma is high risk (dealers buy dips)
    if (gamma.regime === 'POSITIVE_GAMMA' && gamma.putWall !== null) {
      const distToPutWallPct = ((lastPrice - gamma.putWall) / lastPrice) * 100;
      if (distToPutWallPct >= -0.15 && distToPutWallPct <= 0.35 && !hasMajorSweepShort && !denied.SHORT) {
        denied.SHORT = `Positive Gamma Put Wall: price ($${lastPrice}) right at institutional Put Wall ($${gamma.putWall}); dealers actively pin/buy dips here.`;
      }
    }
  }

  const permitted = (['LONG', 'SHORT'] as Direction[]).filter((dir) => !denied[dir]);
  return { blocked: null, permitted, denied };
}

// ===========================================================================
// Strict Multi-Specialist Consensus (Minimum 2 independent specialists required)
// ===========================================================================
export function computeConsensus(reports: SpecialistReport[]): { bias: Direction | null; reason: string } {
  const cfg = councilConfig();
  // Any specialist opposing at strength >= opposeVetoStrength kills the consensus.
  const vetoed = (dir: Direction) => reports.some((r) => r.bias !== dir && r.bias !== 'NEUTRAL' && r.strength >= cfg.opposeVetoStrength);

  for (const dir of ['LONG', 'SHORT'] as Direction[]) {
    const supporters = reports.filter((r) => r.bias === dir && r.strength >= 2);
    const allAgreeing = reports.filter((r) => r.bias === dir && r.strength >= 1);
    const opposing = reports.filter((r) => r.bias !== dir && r.bias !== 'NEUTRAL' && r.strength >= 1);

    const standardConsensus = supporters.length >= cfg.minAgreeing && (supporters.some((r) => r.strength >= cfg.minLeadStrength) || (supporters.length >= 2 && opposing.length === 0));
    // Max conviction lead (Strength 3) + at least 1 agreeing specialist (strength >= 1) with 0 opposition
    const maxLeadConsensus = reports.some((r) => r.bias === dir && r.strength >= 3) && allAgreeing.length >= 2 && opposing.length === 0;
    const unanimousConsensus = allAgreeing.length >= 3 && supporters.length >= 2 && opposing.length === 0;

    if ((standardConsensus || maxLeadConsensus || unanimousConsensus) && !vetoed(dir)) {
      const names = allAgreeing.map((r) => `${r.name} (${r.strength}/3)`).join(' + ');
      return { bias: dir, reason: `${names} agree on ${dir}.` };
    }
  }
  const summary = reports.map((r) => `${r.agentId}:${r.bias}/${r.strength}`).join(', ');
  return { bias: null, reason: `No qualifying consensus (${summary}). Need ${cfg.minAgreeing}+ specialists at strength >= 2, or Strength 3 lead with agreeing confirmation, and no opposing specialist at strength >= ${cfg.opposeVetoStrength}.` };
}

// ===========================================================================
// Trade levels & Account-Level Position Sizing Engine
// ===========================================================================
export type LevelsResult =
  | { ok: true; entryPrice: number; stopPrice: number; target1Price: number; targetPrice: number; targetR: number; riskAllocation: RiskAllocation; notes: string[] }
  | { ok: false; reason: string };

export function computeRiskAllocation(entryPrice: number, stopPrice: number): RiskAllocation {
  const cfg = councilConfig();
  const maxRiskUsd = Number(((cfg.accountBalanceUsd * cfg.riskPerTradePct) / 100).toFixed(2));
  const stopDistance = Math.max(Math.abs(entryPrice - stopPrice), 1e-8);
  const positionSizeUnits = Number((maxRiskUsd / stopDistance).toFixed(6));
  const notionalValueUsd = Number((positionSizeUnits * entryPrice).toFixed(2));
  const effectiveLeverage = Number((notionalValueUsd / Math.max(cfg.accountBalanceUsd, 1)).toFixed(2));
  return {
    accountBalanceUsd: cfg.accountBalanceUsd,
    riskPerTradePct: cfg.riskPerTradePct,
    maxRiskUsd,
    positionSizeUnits,
    notionalValueUsd,
    effectiveLeverage
  };
}

export function resolveTradeLevels(
  decision: Direction,
  snapshot: AgentSnapshot,
  raw: { entry: unknown; stop: unknown; target: unknown }
): LevelsResult {
  const cfg = councilConfig();
  const candles = snapshot.candles;
  const last = snapshot.latestPrice ?? candles[candles.length - 1]?.close ?? null;
  if (last === null || !(last > 0)) return { ok: false, reason: 'No valid latest price to anchor the trade levels.' };

  const dir = decision === 'LONG' ? 1 : -1;
  const notes: string[] = [];
  const positive = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  let entry = positive(raw.entry);
  if (entry === null || (Math.abs(entry - last) / last) * 100 > cfg.maxEntryDriftPct) {
    if (entry !== null) notes.push(`Entry ${entry} drifted more than ${cfg.maxEntryDriftPct}% from price; using ${last}.`);
    entry = last;
  }

  const atr = snapshot.derivedContext?.atr ?? computeAtr(candles);
  const recent = candles.slice(-8);
  const swingLow = recent.length ? Math.min(...recent.map((c) => c.low)) : last * 0.997;
  const swingHigh = recent.length ? Math.max(...recent.map((c) => c.high)) : last * 1.003;
  const buffer = Math.max(atr !== null ? atr * 0.6 : 0, entry * 0.0012);

  let stop = positive(raw.stop);
  const wrongSide = (value: number | null): boolean => value === null || (dir === 1 ? value >= entry : value <= entry);
  if (wrongSide(stop)) {
    notes.push(stop === null ? 'Stop placed beyond the recent structural swing.' : 'Proposed stop was on the wrong side; used the structural swing stop.');
    stop = dir === 1 ? swingLow - buffer : swingHigh + buffer;
    if (wrongSide(stop)) stop = entry - dir * buffer * 2;
  }
  let stopPrice = stop as number;
  let risk = Math.abs(entry - stopPrice);

  const isForex = /^(XAUUSD|EURUSD|GBPUSD)$/i.test(snapshot.symbol);
  const isBtc = /^BTCUSDT$/i.test(snapshot.symbol);
  const isEth = /^ETHUSDT$/i.test(snapshot.symbol);
  const isAltCrypto = /^(SOLUSDT)$/i.test(snapshot.symbol);
  const effectiveMinRiskPct = isForex
    ? (snapshot.symbol === 'XAUUSD' ? 0.14 : 0.08)
    : isEth
      ? Math.max(cfg.minRiskPct, 0.60)
      : isBtc
        ? Math.max(cfg.minRiskPct, 0.45)
        : isAltCrypto
          ? Math.max(cfg.minRiskPct, 0.70)
          : Math.max(cfg.minRiskPct, 0.50);
  const effectiveMaxRiskPct = isForex
    ? 0.50
    : isAltCrypto
      ? 2.20
      : 1.50;

  // Structural Stop Floor: Stop must be BEYOND the recent swing high/low that caused the setup
  // This prevents "noise stops" that get hit instantly by normal market breathing
  const structuralStopLong = swingLow - buffer;   // For LONG: below the wick that swept lows
  const structuralStopShort = swingHigh + buffer;  // For SHORT: above the wick that swept highs
  const structuralStop = dir === 1 ? structuralStopLong : structuralStopShort;
  const structuralRisk = Math.abs(entry - structuralStop);

  // Volatility noise floor: 1.5x ATR minimum (raised from 1.2x — 1.2x was too tight for crypto volatility)
  const minRisk = Math.max(
    (entry * effectiveMinRiskPct) / 100,
    atr !== null ? atr * 1.5 : 0,
    structuralRisk  // Stop must be AT LEAST beyond the structural swing
  );
  if (risk < minRisk) {
    stopPrice = entry - dir * minRisk;
    risk = minRisk;
    notes.push(`Stop widened to structural/volatility floor (structural swing: ${dir === 1 ? swingLow.toFixed(2) : swingHigh.toFixed(2)}, ATR floor: ${atr !== null ? (atr * 1.5).toFixed(2) : 'n/a'}).`);
  }
  const riskPct = (risk / entry) * 100;
  if (riskPct > effectiveMaxRiskPct) {
    return { ok: false, reason: `Stop distance ${riskPct.toFixed(2)}% exceeds the ${effectiveMaxRiskPct}% limit; structure is too wide for this timeframe.` };
  }

  const validSide = (value: number | null): value is number => value !== null && (dir === 1 ? value > entry : value < entry);
  let target = positive(raw.target);

  if (!validSide(target) || (target !== null && Math.abs(target - entry) / risk < cfg.minRR)) {
    if (target !== null && !validSide(target)) notes.push('Target was on the wrong side of entry; ignored.');
    const dolRaw = snapshot.derivedContext?.drawOnLiquidity;
    const dol = positive(dir === 1 ? dolRaw?.nextBullishTarget : dolRaw?.nextBearishTarget);

    if (validSide(dol) && Math.abs(dol - entry) / risk >= cfg.minRR) {
      target = dol;
      notes.push('Target taken from next draw on liquidity.');
    } else {
      return { ok: false, reason: `Nearest Draw on Liquidity is less than minimum ${cfg.minRR}R; skipping trade instead of forcing an artificial target.` };
    }
  }

  let finalTarget = target as number;
  let rr = Math.abs(finalTarget - entry) / risk;

  if (rr < cfg.minRR) {
    finalTarget = entry + dir * risk * cfg.minRR;
    rr = cfg.minRR;
    notes.push(`Target expanded to meet minimum ${cfg.minRR}R.`);
  }
  if (rr > cfg.maxRR) {
    finalTarget = entry + dir * risk * cfg.maxRR;
    rr = cfg.maxRR;
    notes.push(`Target capped at ${cfg.maxRR}R.`);
  }

  const round = (value: number): number => Number(value.toFixed(6));
  const entryPrice = round(entry);
  const roundedStop = round(stopPrice);
  return {
    ok: true,
    entryPrice,
    stopPrice: roundedStop,
    target1Price: round(entry + dir * risk),
    targetPrice: round(finalTarget),
    targetR: Number(rr.toFixed(2)),
    riskAllocation: computeRiskAllocation(entryPrice, roundedStop),
    notes
  };
}

// ===========================================================================
// Lessons memory hygiene
// ===========================================================================
export function normalizeLessons(lessons: readonly string[] | undefined, max = 15): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of lessons ?? []) {
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    clean.push(text);
  }
  if (clean.length <= max) return clean;
  const head = Math.ceil(max / 2);
  return [...clean.slice(0, head), ...clean.slice(clean.length - (max - head))];
}

function lessonsBlock(lessons: string[], title: string): string {
  return lessons.length ? `\n${title}\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n` : '';
}

// ===========================================================================
// Snapshot compaction
// ===========================================================================
function compactSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const derivedContext = buildDerivedContext(snapshot);
  const latestPrice = snapshot.latestPrice ?? snapshot.candles[snapshot.candles.length - 1]?.close ?? 0;
  return {
    ...snapshot,
    derivedContext,
    candles: snapshot.candles.slice(-300),
    footprints: snapshot.footprints.filter((bar) => bar.isClosed).slice(-12).map((bar) => {
      // Sort price levels by proximity to current price (key area first) rather than raw volume.
      // This ensures the LLM sees levels AROUND the current price (imbalances, POC area, key S/R)
      // instead of only the highest-volume cluster which may be far from price action.
      const byProximity = [...bar.priceLevels]
        .sort((a, b) => Math.abs(a.price - latestPrice) - Math.abs(b.price - latestPrice))
        .slice(0, 20);                     // keep 20 levels (was 14, sorted by volume)
      return { ...bar, priceLevels: byProximity };
    }),
    trades: [...snapshot.trades]
      .sort((a, b) => b.size - a.size)
      .slice(0, 25),
    bids: snapshot.bids.slice(0, 5),
    asks: snapshot.asks.slice(0, 5)
  };
}

// ===========================================================================
// LLM transport
// ===========================================================================
interface GenerateOptions { maxTokens: number; effort?: 'low' | 'medium' | 'high'; temperature?: number; }
interface GenerateOutput<T> { data: T; tokens: number; }

function parseRetrySeconds(detail: string, headerValue: string | null): number {
  const header = Number(headerValue);
  if (Number.isFinite(header) && header > 0) return Math.min(Math.ceil(header), 6 * 3600);
  const match = detail.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (match && (match[1] || match[2] || match[3])) {
    const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Math.ceil(Number(match[3] ?? 0));
    if (seconds > 0) return Math.min(seconds + 1, 6 * 3600);
  }
  return 4;
}

function penalizeKey(config: ProviderConfig, ms: number): void {
  const usage = usageFor(config);
  usage.cooldownUntil = Math.max(usage.cooldownUntil, Date.now() + ms);
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as any;
    return json?.error?.message || json?.message || JSON.stringify(json);
  } catch {
    try { return await response.text(); } catch { return ''; }
  }
}

async function generateJson<T>(config: ProviderConfig, system: string, input: unknown, template: string, options: GenerateOptions): Promise<GenerateOutput<T>> {
  const cfg = councilConfig();
  const isAnthropicModel = config.provider === 'agentrouter' && /^claude/i.test(config.model);
  const isResponsesModel = config.provider === 'agentrouter' && !isAnthropicModel;

  const url = isAnthropicModel
    ? `${config.baseUrl ?? 'https://agentrouter.org/v1'}/messages`
    : isResponsesModel
      ? `${config.baseUrl ?? 'https://agentrouter.org/v1'}/responses`
      : config.provider === 'cloudflare'
        ? (config.baseUrl?.includes('/accounts/')
            ? `${config.baseUrl}/chat/completions`
            : `${config.baseUrl}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`)
        : `${config.baseUrl ?? 'https://api.groq.com/openai/v1'}/chat/completions`;

  const headers: Record<string, string> = isAnthropicModel
    ? {
        'Content-Type': 'application/json',
        'x-api-key': config.key,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'claude-cli/1.0.24 (external, cli)'
      }
    : {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.key}`,
        ...(config.provider === 'agentrouter' ? { 'User-Agent': 'claude-cli/1.0.24 (external, cli)' } : {})
      };

  const body: Record<string, unknown> = isAnthropicModel
    ? {
        model: config.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 0.1,
        system: `${system}\n\nRespond with ONE valid JSON object only (no markdown, no preamble), shaped exactly like:\n${template}`,
        messages: [
          { role: 'user', content: input === undefined ? 'Produce the JSON object now.' : `MARKET_DATA:\n${JSON.stringify(input)}` }
        ]
      }
    : isResponsesModel
      ? {
          model: config.model,
          max_output_tokens: 16000,
          reasoning: { effort: 'low' },
          instructions: `${system}\n\nKeep each string concise (max 25 words). Respond with ONE valid JSON object only (no markdown, no preamble), shaped exactly like:\n${template}`,
          input: input === undefined ? 'Produce the JSON object now.' : `MARKET_DATA:\n${JSON.stringify(input)}`
        }
      : {
          model: config.model,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxTokens,
          ...(!/gpt-oss/i.test(config.model) ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: `${system}\n\nRespond with ONE valid JSON object only (no markdown, no preamble), shaped exactly like:\n${template}` },
            { role: 'user', content: input === undefined ? 'Produce the JSON object now.' : `MARKET_DATA:\n${JSON.stringify(input)}` }
          ]
        };

  if (config.provider === 'groq' && /gpt-oss/i.test(config.model) && cfg.reasoningEffort !== 'off') {
    body.reasoning_effort = ['low', 'medium', 'high'].includes(cfg.reasoningEffort) ? cfg.reasoningEffort : (options.effort ?? 'low');
  }

  recordAttempt(config);
  let sentReasoningParam = 'reasoning_effort' in body;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeoutMs = config.provider === 'agentrouter' ? 120_000 : 35_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      penalizeKey(config, 20_000);
      throw new Error(`${config.provider} (${config.model}): network error - ${err instanceof Error ? err.message : 'fetch failed'}`);
    }

    try {
      if (response.status === 429) {
        const detail = await readErrorDetail(response);
        const retrySec = parseRetrySeconds(detail, response.headers.get('retry-after'));
        usageFor(config).cooldownUntil = Date.now() + retrySec * 1000;
        throw new Error(`${config.provider} (${config.model}): ${detail || '429 rate limit reached'}`);
      }
      if (response.status >= 500 && attempt < 2) {
        await readErrorDetail(response);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        if (response.status === 400 && sentReasoningParam && /reasoning/i.test(detail)) {
          delete body.reasoning_effort;
          sentReasoningParam = false;
          continue;
        }
        if (/restricted|suspended|deactivated|disabled|blocked/i.test(detail)) penalizeKey(config, 30 * 60_000);
        else if (response.status === 401 || response.status === 403 || response.status === 404) penalizeKey(config, 10 * 60_000);
        else penalizeKey(config, response.status >= 500 ? 20_000 : 60_000);
        throw new Error(`${config.provider} (${config.model}) HTTP ${response.status}: ${detail || 'Request failed'}`);
      }

      const payload = (await response.json()) as any;
      const choice = payload.choices?.[0];
      const text = isAnthropicModel
        ? payload.content?.[0]?.text
        : isResponsesModel
          ? (payload.output_text ??
              payload.output
                ?.flatMap((item: any) => item?.content ?? [])
                ?.find((c: any) => c?.type === 'output_text' || typeof c?.text === 'string')
                ?.text)
          : choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        const why = choice?.finish_reason === 'length' ? 'ran out of max_tokens' : 'returned an empty response';
        throw new Error(`${config.provider} (${config.model}) ${why}.`);
      }
      return { data: parseObject<T>(text.trim()), tokens: Number(payload.usage?.total_tokens) || 0 };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${config.provider} (${config.model}): request failed after retries.`);
}

async function generateWithFallback<T>(
  providers: ProviderConfig[], role: AgentRole, system: string, input: unknown, template: string, options: GenerateOptions
): Promise<{ data: T; used: ProviderConfig; tokens: number }> {
  if (!providers.length) throw new Error(`No Groq key configured for ${role.toUpperCase()} (set GROQ_${role.toUpperCase()}_API_KEY).`);
  const failures: string[] = [];
  let eligible = providers.filter(isAvailable);

  if (!eligible.length) {
    const minCooldown = Math.min(...providers.map((p) => usageFor(p).cooldownUntil));
    const remainingMs = minCooldown - Date.now();
    if (remainingMs > 5000) {
      throw new Error(`All Groq keys for ${role.toUpperCase()} are paused for another ${Math.round(remainingMs / 1000)}s after earlier failures (check the key/account).`);
    }
    const waitMs = Math.max(1200, remainingMs);
    console.log(`\n[Auto-Pacing] All Groq keys for ${role.toUpperCase()} cooling down. Pausing ${(waitMs / 1000).toFixed(1)}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
    eligible = providers;
  }

  for (let idx = 0; idx < eligible.length; idx++) {
    const provider = eligible[idx];
    try {
      const { data, tokens } = await generateJson<T>(provider, system, input, template, options);
      return { data, used: provider, tokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : `${provider.provider}: request failed`;
      failures.push(message);
      const cooldownSec = Math.max(0, Math.round((usageFor(provider).cooldownUntil - Date.now()) / 1000));
      const reason = message.replace(/^groq \([^)]*\)\s*/, '').slice(0, 220);
      const note = cooldownSec > 0 ? ` (key paused ${cooldownSec}s)` : '';
      if (idx < eligible.length - 1) {
        console.log(`[Auto-Rotation] ${role.toUpperCase()} key ...${provider.key.slice(-6)} failed: ${reason}${note} -> trying ...${eligible[idx + 1].key.slice(-6)}`);
      } else {
        console.warn(`[Auto-Rotation] ${role.toUpperCase()} last key ...${provider.key.slice(-6)} failed: ${reason}${note}`);
      }
    }
  }
  throw new Error(`All Groq keys for ${role.toUpperCase()} failed: ${failures.join(' | ')}`);
}

function parseRoleCredentialList(raw: string | undefined, roleName: string): ProviderConfig[] {
  if (!raw?.trim()) return [];
  const credentials: ProviderConfig[] = [];
  const role = roleName.toLowerCase() as AgentRole;

  const defaultModel = role === 'manager'
    ? (process.env.GROQ_MANAGER_MODEL?.trim() || 'openai/gpt-oss-120b')
    : (process.env[`GROQ_${roleName}_MODEL`]?.trim() || 'openai/gpt-oss-20b');

  for (const part of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
    if (!part.startsWith('gsk_')) continue;
    const keyFingerprint = createHash('sha256').update(part).digest('hex').slice(0, 8);
    credentials.push({
      provider: 'groq',
      key: part,
      model: defaultModel,
      quotaScope: `${roleName}-groq-${keyFingerprint}`
    });
  }
  return credentials;
}

function getProviderConfigs(role: AgentRole): ProviderConfig[] {
  const roleName = role.toUpperCase();
  const configured: ProviderConfig[] = [];

  if (role === 'manager' && process.env.AGENT_ROUTER_API_KEY?.trim()) {
    configured.push({
      provider: 'agentrouter',
      key: process.env.AGENT_ROUTER_API_KEY.trim(),
      model: process.env.AGENT_ROUTER_MODEL?.trim() || 'gpt-5.6-sol',
      baseUrl: (process.env.AGENT_ROUTER_BASE_URL?.trim() || 'https://agentrouter.org/v1').replace(/\/+$/, ''),
      quotaScope: 'agent-router-live-manager'
    });
  }

  configured.push(...parseRoleCredentialList(process.env[`GROQ_${roleName}_API_KEY`], roleName));

  if (role === 'manager' && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    configured.push({
      provider: 'cloudflare',
      key: process.env.CLOUDFLARE_API_TOKEN,
      model: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      quotaScope: 'cloudflare-workers-ai'
    });
  }

  const seen = new Set<string>();
  return configured.filter((item) => {
    const id = `${item.provider}:${item.key}:${item.model}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ===========================================================================
// Report / plan sanitising
// ===========================================================================
export function sanitizeReport(value: SpecialistReport, agent: typeof SPECIALIST_AGENTS[number]): SpecialistReport {
  const allowed = new Set(strategiesFor(agent.id).map((strategy) => strategy.id));
  let direction: SpecialistReport['bias'] = value.bias === 'LONG' || value.bias === 'SHORT' ? value.bias : 'NEUTRAL';
  let strength = Math.max(0, Math.min(3, Math.round(Number(value.strength) || 0)));
  if (strength === 0) direction = 'NEUTRAL';
  if (direction === 'NEUTRAL') strength = 0;
  const strategyCandidates = textList(value.strategyCandidates, 4).filter((id) => {
    const strategy = strategyById(id);
    return allowed.has(id) && strategy && (direction === 'NEUTRAL' || strategy.direction === 'BOTH' || strategy.direction === direction);
  }).slice(0, 3);
  return {
    agentId: agent.id,
    name: agent.name,
    bias: direction,
    strength,
    findings: textList(value.findings, 5),
    strategyCandidates,
    concerns: textList(value.concerns, 4),
    missingData: textList(value.missingData, 4)
  };
}

export function buildWaitPlan(reports: SpecialistReport[], summary: string, reasons: string[] = []): CouncilPlan {
  const fallbackReasons = reports.flatMap((r) => r.findings.slice(0, 1)).slice(0, 3);
  return {
    decision: 'WAIT',
    summary: summary.slice(0, 420),
    reasons: (reasons.length ? reasons : fallbackReasons).slice(0, 4).map((r) => r.slice(0, 240)),
    entryTrigger: 'WAIT: Wait for 2/3 specialist confluence + liquidity sweep confirmation.',
    entryPrice: null,
    invalidation: 'WAIT: No active trade setup.',
    stopPrice: null,
    target1Price: null,
    targetPrice: null,
    targetR: null,
    exitPlan: 'WAIT: Stand aside and monitor key liquidity and POC levels.',
    agreeingAgents: [],
    dissent: reports.map((report) => `${report.name}: ${report.bias} (strength ${report.strength}/3)`),
    strategyIds: [],
    strategyNames: [],
    riskAllocation: null
  };
}

const SUMMARY_VETO = /^\s*(wait|no[\s-]?trade|stand(?:ing)?\s+aside|stay(?:ing)?\s+out|pass)\b/i;

export function sanitizePlan(value: CouncilPlan, reports: SpecialistReport[], snapshot: AgentSnapshot): CouncilPlan {
  const consensus = computeConsensus(reports);
  const gates = evaluateGates(snapshot);

  const proposedDir = value.decision === 'LONG' || value.decision === 'SHORT' ? value.decision : null;

  let waitReason: string | null = null;
  if (!proposedDir) waitReason = null;
  else if (!consensus.bias) waitReason = consensus.reason;
  else if (proposedDir !== consensus.bias) waitReason = `Manager proposed ${proposedDir} but the specialist consensus is ${consensus.bias}.`;
  else if (SUMMARY_VETO.test(value.summary || '')) waitReason = 'Manager summary itself recommends standing aside.';
  else if (gates.blocked) waitReason = gates.blocked;
  else if (!gates.permitted.includes(proposedDir)) waitReason = gates.denied[proposedDir] ?? 'Direction blocked by a hard gate.';

  const wantsTrade = proposedDir !== null && waitReason === null;
  if (!wantsTrade) {
    const managerSummary = String(value.summary || '').trim();
    const summary = waitReason
      ? `WAIT: ${waitReason}`
      : (managerSummary || 'WAIT: Confluence threshold or clean Draw on Liquidity not reached. Standing aside.');
    return buildWaitPlan(reports, summary, textList(value.reasons, 4));
  }

  const decision = proposedDir as Direction;
  const levels = resolveTradeLevels(decision, snapshot, { entry: value.entryPrice, stop: value.stopPrice, target: value.targetPrice });
  if (!levels.ok) {
    return buildWaitPlan(reports, `WAIT: ${levels.reason}`, textList(value.reasons, 4));
  }

  const aligned = reports.filter((report) => report.bias === decision);
  const eligibleCandidates = new Set(aligned.flatMap((report) => report.strategyCandidates));

  const aPlusTriggers = [
    'SMC01', 'SMC02', 'SMC03', 'SMC04',
    'SMC05', 'SMC06',
    'SMC07', 'SMC08',
    'SMC09', 'SMC10', 'SMC11', 'SMC12', 'SMC13', 'SMC14', 'SMC15', 'SMC17',
    'ICT01', 'ICT02', 'ICT03', 'ICT04', 'ICT05', 'ICT06', 'ICT11', 'ICT12',
    'ICT13', 'ICT14', 'ICT15', 'ICT16', 'ICT19',
    'OF01', 'OF02', 'OF03', 'OF04', 'OF13', 'OF14', 'OF21', 'OF23', 'OF24', 'OF25', 'OF26', 'OF27'
  ];
  const hasAPlusTrigger = aPlusTriggers.some((id) => eligibleCandidates.has(id));
  if (!hasAPlusTrigger) {
    return buildWaitPlan(
      reports,
      'WAIT: No A+ structural/liquidity trigger (Sweep, IDM, OB/Breaker, PDH/PDL raid, or Whale Absorption). Skipping plain pullback.',
      textList(value.reasons, 4)
    );
  }

  const smcReport = reports.find((r) => r.agentId === 'smc');
  if (!smcReport || smcReport.bias !== decision || smcReport.strength < 1) {
    return buildWaitPlan(
      reports,
      `WAIT: SMC market structure (${smcReport?.bias ?? 'NEUTRAL'}) has not confirmed ${decision} shift yet.`,
      textList(value.reasons, 4)
    );
  }

  const sweepIds = ['SMC05', 'SMC06', 'SMC07', 'SMC08', 'ICT13', 'ICT14', 'ICT15', 'ICT16', 'ICT19'];
  const derivedSweep = snapshot.derivedContext?.sweepReclaim;
  const liquidityAlreadyTaken =
    sweepIds.some((id) => eligibleCandidates.has(id)) ||
    (decision === 'LONG' && Boolean(derivedSweep?.long)) ||
    (decision === 'SHORT' && Boolean(derivedSweep?.short));

  if (!liquidityAlreadyTaken) {
    if (decision === 'LONG' && snapshot.derivedContext?.dealingRange?.zone === 'PREMIUM') {
      return buildWaitPlan(
        reports,
        `WAIT: Dealing range is PREMIUM. Buying here risks distribution trap; wait for discount retracement or sweep-reclaim.`,
        textList(value.reasons, 4)
      );
    }
    if (decision === 'SHORT' && snapshot.derivedContext?.dealingRange?.zone === 'DISCOUNT') {
      return buildWaitPlan(
        reports,
        `WAIT: Dealing range is DISCOUNT. Shorting here risks accumulation bounce; wait for premium retracement or sweep-reclaim.`,
        textList(value.reasons, 4)
      );
    }

    const closedFps = snapshot.footprints.filter((b) => b.isClosed);
    const lastClosedFp = closedFps[closedFps.length - 1];
    if (lastClosedFp) {
      const midBar = (lastClosedFp.high + lastClosedFp.low) / 2;
      if (decision === 'SHORT' && (lastClosedFp.close >= lastClosedFp.open || lastClosedFp.close > midBar)) {
        return buildWaitPlan(
          reports,
          `WAIT: No liquidity sweep yet; waiting for bearish rejection candle close (last bar closed at ${lastClosedFp.close}).`,
          textList(value.reasons, 4)
        );
      }
      if (decision === 'LONG' && (lastClosedFp.close <= lastClosedFp.open || lastClosedFp.close < midBar)) {
        return buildWaitPlan(
          reports,
          `WAIT: No liquidity sweep yet; waiting for bullish reclaim candle close (last bar closed at ${lastClosedFp.close}).`,
          textList(value.reasons, 4)
        );
      }
    }
  }

  const managerSelectedIds = textList(value.strategyIds, 6).filter((id) => eligibleCandidates.has(id));
  const selectedStrategyIds = managerSelectedIds.length > 0 ? managerSelectedIds : [...eligibleCandidates].slice(0, 6);

  const rawReasons = textList(value.reasons, 5);
  const reasons = rawReasons.length > 0
    ? rawReasons
    : aligned.flatMap((r) => r.findings.slice(0, 2).map((f) => `[${r.name}] ${f}`)).slice(0, 5);

  const trigger = String(value.entryTrigger ?? '').trim() ||
    `${decision} entry near ${levels.entryPrice} with Draw on Liquidity targeting ${levels.targetPrice} (${levels.targetR}R)`;
  const invalidation = String(value.invalidation ?? '').trim() ||
    `Setup invalid if price closes beyond structural stop at ${levels.stopPrice}.`;
  const exitPlan = String(value.exitPlan ?? '').trim() ||
    `Take partials at 1R (${levels.target1Price}), move SL to breakeven, and let runner hit Draw on Liquidity target at ${levels.targetPrice}.`;
  const summaryText = String(value.summary || `${decision} setup confirmed toward Draw on Liquidity.`);
  const levelNotes = levels.notes.length ? ` [Levels adjusted: ${levels.notes.join(' ')}]` : '';

  return {
    decision,
    summary: `${summaryText.slice(0, 340)}${levelNotes}`.slice(0, 420),
    reasons,
    entryTrigger: trigger.slice(0, 260),
    entryPrice: levels.entryPrice,
    invalidation: invalidation.slice(0, 260),
    stopPrice: levels.stopPrice,
    target1Price: levels.target1Price,
    targetPrice: levels.targetPrice,
    targetR: levels.targetR,
    exitPlan: exitPlan.slice(0, 260),
    agreeingAgents: aligned.map((report) => report.name),
    dissent: reports.filter((report) => report.bias !== decision)
      .map((report) => `${report.name}: ${report.bias} (strength ${report.strength}/3)`),
    strategyIds: selectedStrategyIds,
    strategyNames: selectedStrategyIds.map((id) => strategyById(id)?.name ?? id),
    riskAllocation: levels.riskAllocation
  };
}

// ===========================================================================
// Prompts
// ===========================================================================
const PLAN_TEMPLATE = '{"decision":"LONG|SHORT|WAIT","summary":"string","reasons":["string"],"entryTrigger":"string","entryPrice":number|null,"invalidation":"string","stopPrice":number|null,"target1Price":number|null,"targetPrice":number|null,"targetR":number|null,"exitPlan":"string","agreeingAgents":["string"],"dissent":["string"],"strategyIds":["string"]}';

function buildManagerPrompt(
  consensus: { bias: Direction | null },
  permitted: Direction[],
  lessons: string[],
  symbol = '',
  strategyScorecard?: Array<{ strategy: string; trades: number; wins: number; losses: number; winRate: number; netR: number }>,
  gammaContext?: GammaContext | null
): string {
  const cfg = councilConfig();
  const isForex = /^(XAUUSD|EURUSD|GBPUSD)$/i.test(symbol);
  const isBtc = /^BTCUSDT$/i.test(symbol);
  const isEth = /^ETHUSDT$/i.test(symbol);
  const isAltCrypto = /^(SOLUSDT)$/i.test(symbol);
  const minRiskPct = isForex
    ? (symbol === 'XAUUSD' ? 0.14 : 0.08)
    : isEth
      ? Math.max(cfg.minRiskPct, 0.60)
      : isBtc
        ? Math.max(cfg.minRiskPct, 0.45)
        : isAltCrypto
          ? Math.max(cfg.minRiskPct, 0.70)
          : Math.max(cfg.minRiskPct, 0.50);
  const maxRiskPct = isForex ? 0.50 : isAltCrypto ? 2.20 : 1.50;
  const allowedList = consensus.bias ? `${consensus.bias} or WAIT` : 'WAIT';

  let scorecardBlock = '';
  if (Array.isArray(strategyScorecard) && strategyScorecard.length > 0) {
    const lines = strategyScorecard.slice(0, 10).map((s) =>
      `  • ${s.strategy}: ${s.trades} trades, ${s.winRate}% win rate, Net: ${s.netR > 0 ? '+' : ''}${s.netR}R`
    );
    scorecardBlock = `\nSTRATEGY HISTORICAL SCORECARD (REAL 30-DAY STATS):\n${lines.join('\n')}\n`;
  }

  let gammaBlock = '';
  if (gammaContext) {
    const netGexM = (gammaContext.netGexUsd / 1e6).toFixed(1);
    gammaBlock = `\nDERIBIT OPTIONS INSTITUTIONAL GAMMA (GEX CONFLUENCE):\n` +
      `  • Regime: ${gammaContext.regime} ($${netGexM}M Net GEX)\n` +
      `  • Call Wall (Dealer Pin/Ceiling): $${gammaContext.callWall ?? 'N/A'}\n` +
      `  • Put Wall (Dealer Floor/Support): $${gammaContext.putWall ?? 'N/A'}\n` +
      `  • Gamma Flip Level: $${gammaContext.gammaFlip ?? 'N/A'}\n` +
      `  • Put/Call OI Ratio: ${gammaContext.pcrRatio}\n` +
      `  • Strategy Confluence: ${gammaContext.regime === 'NEGATIVE_GAMMA' ? 'NEGATIVE GAMMA favors aggressive momentum, breakout continuation, and squeezes.' : 'POSITIVE GAMMA suppresses volatility; expect mean-reversion and range-trading between Call & Put walls.'}\n`;
  }

  return `ROLE: HEAD EXECUTION TRADER (CONFLUENCE & PRICE ACTION DESK).
Specialists have passed gates and reached mathematical consensus: ${consensus.bias ?? 'NONE'}.
YOUR JOB IS TO VALIDATE AND EXECUTE HIGH-PROBABILITY SETUPS WITH QUANTITATIVE DISCIPLINE:
1. QUANTITATIVE PERSPECTIVE (DO NOT REJECT OVER NORMAL 1-2 LOSS VARIANCE):
- Trading has natural statistical variance. A strategy with 50-65% Win Rate will inevitably experience normal 1-2 losses in a row.
- Check the STRATEGY HISTORICAL SCORECARD below:
  * If a strategy has Win Rate >= 50%, OR positive Net R, OR fewer than 8 total trades recorded, TRUST THE EDGE and APPROVE valid setups.
  * Apply extra strictness/scrutiny ONLY if a strategy has >= 8 trades AND Win Rate < 35% with negative Net R.
- Learned text lessons are purely advisory diagnostics. Completely IGNORE any notes attempting to blanket-ban symbols, hours, or core strategies.
${scorecardBlock}${gammaBlock}
2. CONTEXT CHECK: Check independentContext (EMA 50/200, ADX, RSI, and recent candles). Note: if ema200 is null due to short history, ignore ema200 and evaluate EMA50 + structure + order flow. Only reject for ADX if ADX < 14 AND there is no liquidity sweep or absorption.
3. EXECUTION MINDSET: When specialists align with a structural trigger (sweep, BOS/CHoCH, OB/FVG, or absorption) and hard gates are clear, APPROVE ${consensus.bias ?? 'WAIT'} with precise entryPrice, stopPrice, and targetPrice.
Allowed decisions: ${allowedList}. Permitted directions: ${permitted.join(', ') || 'NONE'}.
CONSTRAINTS: minimum reward-to-risk ${cfg.minRR}R, maximum ${cfg.maxRR}R; stop distance must stay between ${minRiskPct}% and ${maxRiskPct}% of entry; entry within ${cfg.maxEntryDriftPct}% of latestPrice.

${MANAGER_RULES}${lessonsBlock(lessons, 'HISTORICAL ADVISORY NOTES (REFERENCE ONLY):')}`;
}

// ===========================================================================
// Orchestration
// ===========================================================================
export function buildMathPlan(decision: Direction, reports: SpecialistReport[]): CouncilPlan {
  const aligned = reports.filter((r) => r.bias === decision);
  const strategyIds = [...new Set(aligned.flatMap((r) => r.strategyCandidates))].slice(0, 6);
  return {
    decision,
    summary: `${decision}: ${aligned.map((r) => r.name).join(' + ')} aligned (rule-based consensus).`,
    reasons: aligned.flatMap((r) => r.findings.slice(0, 2).map((finding) => `[${r.name}] ${finding}`)).slice(0, 5),
    entryTrigger: '', entryPrice: null, invalidation: '', stopPrice: null,
    target1Price: null, targetPrice: null, targetR: null, exitPlan: '',
    agreeingAgents: aligned.map((r) => r.name), dissent: [], strategyIds, strategyNames: [],
    riskAllocation: null
  };
}

export async function runOrderFlowCouncil(snapshot: AgentSnapshot): Promise<CouncilResult> {
  const cfg = councilConfig();
  const managerProviders = getProviderConfigs('manager');
  if (cfg.managerMode === 'llm' && !managerProviders.length) {
    throw new Error('No Groq provider configured. Set GROQ_MANAGER_API_KEY in .env (or COUNCIL_MANAGER=off for math-only mode).');
  }

  const input = compactSnapshot(snapshot);
  const derived = input.derivedContext as DerivedMarketContext;
  const gates = evaluateGates(input);
  const diagnostics: CouncilDiagnostics = { llmCalls: 0, totalTokens: 0, permittedDirections: gates.permitted, gateBlocked: gates.blocked, skipped: [] };

  const reports = computeMathReports(input, derived).map((report, index) => sanitizeReport(report, SPECIALIST_AGENTS[index]));
  const specialistLabel = 'math:smc+ict+orderflow';
  const finish = (plan: CouncilPlan, managerLabel: string): CouncilResult => ({
    reports, plan, model: `${specialistLabel} · ${managerLabel}`, generatedAt: Date.now(), diagnostics
  });

  if (gates.blocked) {
    diagnostics.skipped.push('manager');
    return finish(buildWaitPlan(reports, `WAIT: ${gates.blocked}`, [gates.blocked]), 'manager:skipped');
  }

  const consensus = computeConsensus(reports);
  if (!consensus.bias) {
    diagnostics.skipped.push('manager');
    return finish(buildWaitPlan(reports, `WAIT: ${consensus.reason}`), 'manager:skipped');
  }
  if (!gates.permitted.includes(consensus.bias)) {
    diagnostics.skipped.push('manager');
    return finish(buildWaitPlan(reports, `WAIT: ${gates.denied[consensus.bias] ?? 'Direction blocked by a hard gate.'}`), 'manager:skipped');
  }

  if (cfg.managerMode === 'off') {
    diagnostics.skipped.push('manager');
    return finish(sanitizePlan(buildMathPlan(consensus.bias, reports), reports, input), 'manager:math');
  }

  const lessons = normalizeLessons(input.paperPerformance?.learnedLessons);
  const perf = input.paperPerformance;
  const managerPayload = {
    symbol: input.symbol,
    latestPrice: input.latestPrice,
    atr: derived.atr ?? null,
    htfTrend: derived.htfTrend,
    marketRegime: derived.marketRegime,
    independentContext: derived.independentContext ?? null,
    marketActivityScan: scanMarketActivity(input),
    activeSession: derived.activeSession,
    derivativesContext: input.derivativesContext ?? null,
    gammaContext: input.gammaContext ?? null,
    recentLiquidationCount30m: input.recentLiquidations?.length ?? 0,
    liquidationSignal: derived.liquidationSignal,
    sweepReclaim: derived.sweepReclaim,
    dealingRange: derived.dealingRange ?? null,
    drawOnLiquidity: derived.drawOnLiquidity,
    swings: { recentSwingHigh: derived.recentSwingHigh, recentSwingLow: derived.recentSwingLow },
    levels: { pdh: derived.pdh, pdl: derived.pdl, pwh: derived.pwh, pwl: derived.pwl, sessionHigh: derived.sessionHigh, sessionLow: derived.sessionLow },
    profile: input.profile ?? null,
    paperContext: perf ? {
      resolved: perf.resolved,
      winRate: perf.winRate,
      averageR: perf.averageR,
      recent: perf.recent?.slice(-5),
      strategyScorecard: perf.strategyScorecard
    } : null,
    reports: reports.map((r) => ({
      name: r.name,
      bias: r.bias,
      strength: r.strength,
      findings: r.findings.slice(0, 4),
      concerns: r.concerns.slice(0, 3),
      missingData: r.missingData.slice(0, 2),
      strategies: r.strategyCandidates
    }))
  };

  const { data: rawPlan, used: managerUsed, tokens } = await generateWithFallback<CouncilPlan>(
    managerProviders, 'manager', buildManagerPrompt({ bias: consensus.bias }, gates.permitted, lessons, input.symbol, perf?.strategyScorecard, input.gammaContext), managerPayload, PLAN_TEMPLATE,
    { maxTokens: 3000, effort: 'low' }
  );
  diagnostics.llmCalls += 1;
  diagnostics.totalTokens += tokens;
  return finish(sanitizePlan(rawPlan, reports, input), `manager:${managerUsed.provider}/${managerUsed.model}`);
}

// ===========================================================================
// Post-trade learning
// ===========================================================================
export function cleanLesson(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/\$?\d[\d,]{3,}(?:\.\d+)?/g, 'the level')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

  // Never allow blanket strategy/symbol bans from a single loss
  if (/\b(never\s+trade|ban\s+|disable\s+|stop\s+using|avoid\s+all)\b/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export async function analyzeTradeOutcomeWithAI(
  trade: { decision: 'LONG' | 'SHORT'; entryPrice: number; stopPrice: number; targetPrice?: number; reasons: string[]; summary: string },
  marketOutcome: { outcome: 'WIN' | 'LOSS'; exitPrice: number; exitReason: string; marketContext: string }
): Promise<string> {
  const isWin = marketOutcome.outcome === 'WIN';
  const managerProviders = getProviderConfigs('manager');
  const fallbackLesson = isWin
    ? 'Winning setup: HTF Draw on Liquidity alignment and volume absorption reached target.'
    : `Avoid ${trade.decision} entries when momentum opposes market structure.`;
  if (!managerProviders.length) {
    return isWin
      ? 'Confluence between HTF trend, POC defense, and stacked imbalances produced successful continuation.'
      : 'Do not enter trade against dominant market structure.';
  }

  const roleTitle = isWin ? 'TRADING SUCCESS REINFORCEMENT ANALYST' : 'TRADING POST-MORTEM ANALYST';
  const tradeResultText = isWin ? 'TARGET REACHED (WIN)' : 'STOP LOSS HIT (LOSS)';
  const taskDesc = isWin
    ? 'State which combination of conditions made this trade work, as a reusable rule worth repeating.'
    : 'Identify the most likely avoidable cause (premature entry, no sweep/reclaim confirmation, counter-HTF momentum, entry inside chop, stop inside noise, weak flow confirmation) and turn it into a filter.';
  const targetLine = trade.targetPrice ? `, Target: ${trade.targetPrice}` : '';
  const prompt = `ROLE: ${roleTitle}
A paper trade resolved: ${tradeResultText}.
TRADE: ${trade.decision}, Entry: ${trade.entryPrice}, Stop: ${trade.stopPrice}${targetLine}
PLAN SUMMARY: ${trade.summary.slice(0, 300)}
ORIGINAL REASONS: ${trade.reasons.slice(0, 4).join(' | ')}
OUTCOME: Exit ${marketOutcome.exitPrice} (${marketOutcome.exitReason}). ${marketOutcome.marketContext}
TASK: ${taskDesc}
FORMAT: ONE sentence, at most 30 words, written as a reusable IF <measurable conditions> THEN <action> rule. Use measurable terms (htfTrend, session, sweep/reclaim, POC position, delta/CVD, regime). Do NOT include specific prices or times. Do not blame luck.`;

  try {
    const { data } = await generateWithFallback<{ lesson: string }>(
      managerProviders, 'manager', prompt, undefined, '{"lesson":"string"}', { maxTokens: 600, effort: 'low' }
    );
    const lesson = typeof data.lesson === 'string' ? cleanLesson(data.lesson) : '';
    return lesson || fallbackLesson;
  } catch {
    return fallbackLesson;
  }
}

export const analyzeTradeLossWithAI = (
  trade: { decision: 'LONG' | 'SHORT'; entryPrice: number; stopPrice: number; reasons: string[]; summary: string },
  marketOutcome: { exitPrice: number; exitReason: string; marketContext: string }
) => analyzeTradeOutcomeWithAI(trade, { outcome: 'LOSS', ...marketOutcome });

// ===========================================================================
// Dedicated Nightly Audit Engine
// ===========================================================================
function getAuditProviderConfigs(): ProviderConfig[] {
  const configured: ProviderConfig[] = [];

  if (process.env.AGENT_ROUTER_API_KEY?.trim()) {
    configured.push({
      provider: 'agentrouter',
      key: process.env.AGENT_ROUTER_API_KEY.trim(),
      model: process.env.AGENT_ROUTER_MODEL?.trim() || 'gpt-5.6-sol',
      baseUrl: (process.env.AGENT_ROUTER_BASE_URL?.trim() || 'https://agentrouter.org/v1').replace(/\/+$/, ''),
      quotaScope: 'agent-router-audit'
    });
  }

  const auditModel = process.env.GROQ_AUDIT_MODEL?.trim() || 'openai/gpt-oss-120b';

  if (process.env.GROQ_AUDIT_API_KEY?.trim()) {
    for (const part of process.env.GROQ_AUDIT_API_KEY.split(',').map((v) => v.trim()).filter(Boolean)) {
      if (!part.startsWith('gsk_')) continue;
      const fp = createHash('sha256').update(part).digest('hex').slice(0, 8);
      configured.push({
        provider: 'groq',
        key: part,
        model: auditModel,
        quotaScope: `AUDIT-groq-${fp}`
      });
    }
  }

  if (process.env.CLOUDFLARE_AUDIT_API_TOKEN?.trim() && process.env.CLOUDFLARE_AUDIT_ACCOUNT_ID?.trim()) {
    configured.push({
      provider: 'cloudflare',
      key: process.env.CLOUDFLARE_AUDIT_API_TOKEN.trim(),
      model: process.env.CLOUDFLARE_AUDIT_MODEL?.trim() || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_AUDIT_ACCOUNT_ID.trim()}/ai/v1`,
      quotaScope: 'cloudflare-audit-ai'
    });
  }

  for (const fallback of getProviderConfigs('manager')) {
    if (!configured.some((c) => c.provider === fallback.provider && c.key === fallback.key)) {
      configured.push(fallback);
    }
  }
  return configured;
}

export interface AuditTradeInput {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number;
  outcome: 'WIN' | 'LOSS';
  exitKind: string;
  pnlR: number;
  barsHeld: number;
  macro1hTrend: string;
  macro4hTrend: string;
  strategies: string[];
  reasons: string[];
  preTradeSummary: string;
  postTrade1hSummary: string;
}

export interface AuditFindingOutput {
  tradeId: string;
  symbol: string;
  category: 'SL_TOO_TIGHT' | 'STRATEGY_FAILURE' | 'EARLY_EXIT_SAVED' | 'EARLY_EXIT_PREMATURE' | 'WINNING_PATTERN' | 'SYSTEM_ISSUE';
  problemDetected: string;
  rootCause: string;
  recommendedFix: string;
  verifiedRuleToSave: string | null;
}

export async function runNightlyBatchAuditWithAI(trades: AuditTradeInput[]): Promise<AuditFindingOutput[]> {
  if (!trades.length) return [];
  const providers = getAuditProviderConfigs();
  if (!providers.length) {
    throw new Error('No Audit AI provider configured (set GROQ_AUDIT_API_KEY or CLOUDFLARE_AUDIT_API_TOKEN).');
  }

  const systemPrompt = `ROLE: SENIOR QUANTITATIVE TRADING AUDITOR.
You are conducting the nightly post-market deep audit of completed trades.
For each trade, you are given:
1. Macro Trend (1H & 4H) at entry.
2. Pre-Trade 4-5 Hour Intraday Context (range position, sweeps, delta/CVD, SL width).
3. Actual Trade Execution & Exit Kind (TARGET, STOP, EARLY_EXIT, SCRATCH_EXIT, TIMEOUT).
4. Post-Trade 1-Hour Actual Price Follow-Through (what price did AFTER exit!).

DIAGNOSIS RULES:
- If exitKind is STOP, check Post-Trade 1-Hour Follow-Through:
  * If price reversed and reached the original TP within 1 hour -> category MUST be "SL_TOO_TIGHT". The setup/strategy was VALID; only the stop loss was inside wick noise. Set verifiedRuleToSave = null. Recommend a specific SL buffer fix in recommendedFix.
  * If price continued moving against the trade -> category MUST be "STRATEGY_FAILURE":
    - If the loss was caused by ordinary market variance, chop, or normal noise without an undeniable structural flaw, set verifiedRuleToSave: null (do NOT create knee-jerk fear rules).
    - ONLY if there was an undeniable, repetitive structural mistake (e.g. trading directly into an unmitigated HTF OB or entering against confirmed macro trend), write ONE measurable "IF <condition> THEN <filter>" rule in verifiedRuleToSave. Never suggest banning symbols or strategies.
- If exitKind is EARLY_EXIT or SCRATCH_EXIT:
  * If price later hit the original SL -> category = "EARLY_EXIT_SAVED" (verifiedRuleToSave = null).
  * If price later hit the original TP -> category = "EARLY_EXIT_PREMATURE" (verifiedRuleToSave = null; explain what triggered premature exit and how to tighten the exit threshold).
- If outcome is WIN (TARGET hit):
  * category = "WINNING_PATTERN". Summarize the exact confluence (Trend + Sweep + Order Flow) that worked so it is documented in the audit report (verifiedRuleToSave = null).`;

  const template = '{"findings":[{"tradeId":"string","symbol":"string","category":"SL_TOO_TIGHT|STRATEGY_FAILURE|EARLY_EXIT_SAVED|EARLY_EXIT_PREMATURE|WINNING_PATTERN|SYSTEM_ISSUE","problemDetected":"string","rootCause":"string","recommendedFix":"string","verifiedRuleToSave":"string|null"}]}';

  const { data } = await generateWithFallback<Record<string, unknown>>(
    providers,
    'manager',
    systemPrompt,
    { trades },
    template,
    { maxTokens: 6000, effort: 'medium' }
  );

  if (Array.isArray(data)) return data as AuditFindingOutput[];
  if (Array.isArray(data?.findings)) return data.findings as AuditFindingOutput[];
  if (Array.isArray(data?.results)) return data.results as AuditFindingOutput[];
  const firstArray = Object.values(data ?? {}).find((v) => Array.isArray(v));
  if (Array.isArray(firstArray)) return firstArray as AuditFindingOutput[];
  console.warn('[Nightly Audit] Unexpected AI response shape:', JSON.stringify(data).slice(0, 300));
  return [];
}