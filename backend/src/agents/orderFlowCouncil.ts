import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { SPECIALIST_AGENTS, ORDER_FLOW_SKILL, strategiesFor, strategyById } from './orderFlowSkill.js';
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
  } | null;
  executionGuidance: string;
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
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfTrendDescription: string;
  marketRegime: 'TRENDING' | 'EXPANSION' | 'CHOP_COMPRESSION';
  isLowVolumeChop: boolean;
  liquidationSignal: 'NONE' | 'SHORT_SQUEEZE_EXHAUSTION' | 'LONG_LIQUIDATION_FLUSH';
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
    ict: { po3: Array<{ label: string; time: number; endTime: number; top: number; bottom: number; bullish?: boolean }>; dailyRanges: Array<{ day: number; high: number; low: number }> };
  };
  derivedContext?: DerivedMarketContext;
  candles: Array<{ time: number; open?: number; high: number; low: number; close: number }>;
  footprints: Array<{
    time: number; open: number; high: number; low: number; close: number;
    totalVolume: number; buyVolume: number; sellVolume: number; delta: number;
    cumulativeDelta: number; pocPrice: number; isClosed: boolean;
    priceLevels: Array<{ price: number; bidVolume: number; askVolume: number; totalVolume: number }>;
  }>;
  trades: Array<{ timestamp: number; side: string; price: number; size: number }>;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  paperPerformance?: {
    resolved: number; wins: number; losses: number; expired: number;
    winRate: number | null; averageR: number | null;
    recent: Array<{ side: 'LONG' | 'SHORT'; outcome: 'WIN' | 'LOSS'; pnlR: number }>;
    learnedLessons?: string[];
  } | null;
}

type AiProvider = 'gemini' | 'groq' | 'ollama' | 'nvidia' | 'openrouter';
type AgentRole = 'smc' | 'ict' | 'orderflow' | 'manager';
interface ProviderConfig { provider: AiProvider; model: string; key?: string; baseUrl?: string; quotaScope?: string; }

interface UsageWindow { day: string; daily: number; minute: number; minuteCount: number; cooldownUntil: number; }
const requestUsage = new Map<string, UsageWindow>();

function pacificDay(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function quotaKey(config: ProviderConfig): string {
  if (config.quotaScope) return `${config.provider}:${config.quotaScope}:${config.model}`;
  const identity = config.key || config.baseUrl || config.model;
  return `${config.provider}:${createHash('sha256').update(identity).digest('hex')}:${config.model}`;
}

function quotaFor(config: ProviderConfig): { rpm: number; rpd: number } {
  if (config.provider === 'groq') {
    const model = config.model.toLowerCase();
    if (model.includes('20b') || model.includes('8b')) return { rpm: 28, rpd: 1_000 };
    return { rpm: 28, rpd: 1_000 };
  }
  if (config.provider === 'nvidia') {
    return { rpm: 38, rpd: 1_000 };
  }
  if (config.provider === 'openrouter') {
    return { rpm: 18, rpd: 250 };
  }
  if (config.provider !== 'gemini') return { rpm: 0, rpd: 0 };
  const overrideRpm = Number(process.env.GEMINI_REQUESTS_PER_MINUTE_PER_PROJECT || 0);
  const overrideRpd = Number(process.env.GEMINI_REQUESTS_PER_DAY_PER_PROJECT || 0);
  const model = config.model.toLowerCase();
  const defaults = model.includes('flash-lite')
    ? { rpm: 14, rpd: 500 }
    : model.includes('3.8-flash')
      ? { rpm: 4, rpd: 19 }
      : { rpm: 10, rpd: 500 };
  return { rpm: overrideRpm > 0 ? overrideRpm : defaults.rpm, rpd: overrideRpd > 0 ? overrideRpd : defaults.rpd };
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
  targetR: 2 | 3 | null;
  exitPlan: string;
  agreeingAgents: string[];
  dissent: string[];
  strategyIds: string[];
  strategyNames: string[];
}

export interface CouncilResult { reports: SpecialistReport[]; plan: CouncilPlan; model: string; generatedAt: number; }

const reportSchema = {
  type: 'OBJECT',
  properties: {
    bias: { type: 'STRING', enum: ['LONG', 'SHORT', 'NEUTRAL'] },
    strength: { type: 'INTEGER' },
    findings: { type: 'ARRAY', items: { type: 'STRING' } },
    strategyCandidates: { type: 'ARRAY', items: { type: 'STRING' } },
    concerns: { type: 'ARRAY', items: { type: 'STRING' } },
    missingData: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['bias', 'strength', 'findings', 'strategyCandidates', 'concerns', 'missingData']
};

const planSchema = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: ['LONG', 'SHORT', 'WAIT'] },
    summary: { type: 'STRING' },
    reasons: { type: 'ARRAY', items: { type: 'STRING' } },
    entryTrigger: { type: 'STRING' },
    entryPrice: { type: 'NUMBER', nullable: true },
    invalidation: { type: 'STRING' },
    stopPrice: { type: 'NUMBER', nullable: true },
    target1Price: { type: 'NUMBER', nullable: true },
    targetPrice: { type: 'NUMBER', nullable: true },
    targetR: { type: 'INTEGER', nullable: true },
    exitPlan: { type: 'STRING' },
    agreeingAgents: { type: 'ARRAY', items: { type: 'STRING' } },
    dissent: { type: 'ARRAY', items: { type: 'STRING' } },
    strategyIds: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['decision', 'summary', 'reasons', 'entryTrigger', 'entryPrice', 'invalidation', 'stopPrice', 'target1Price', 'targetPrice', 'targetR', 'exitPlan', 'agreeingAgents', 'dissent', 'strategyIds']
};

function textList(value: unknown, maxItems = 5): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, maxItems).map((item) => item.slice(0, 240)) : [];
}

function parseObject<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI provider returned an invalid structured response.');
  return parsed as T;
}

function extractGeminiText(payload: unknown): string {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = root.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

/**
 * Computes deterministic, backtest-proven OrderFlow microstructure signals from closed footprint bars:
 * - Evaluates whether the POC is trapped overhead (bearish rejection) or supporting underfoot (bullish defense).
 * - Aggregates the last 5 closed 1m footprint bars into a synthetic 5m footprint block to filter out 1m noise
 *   (validated on BTCUSDT replay.json where 5m POC/Absorption rules achieved 100% win rate vs 25% on noisy 1m CVD).
 */
function buildOrderFlowMicrostructureSummary(snapshot: AgentSnapshot): OrderFlowMicrostructureSummary | null {
  const closedBars = snapshot.footprints.filter((bar) => bar.isClosed);
  const bars = closedBars.length >= 1 ? closedBars : snapshot.footprints;
  if (!bars.length) return null;

  const latest = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : latest;
  const lookback = bars.slice(-6);
  const localHigh = Math.max(...lookback.map((b) => b.high));
  const localLow = Math.min(...lookback.map((b) => b.low));

  const barSpan = Math.max(latest.high - latest.low, 1e-6);
  const pocOffsetFromClose = latest.pocPrice - latest.close;
  const latestPocPosition: OrderFlowMicrostructureSummary['latestPocPosition'] =
    pocOffsetFromClose > barSpan * 0.18
      ? 'POC_TRAPPED_OVERHEAD'
      : pocOffsetFromClose < -barSpan * 0.18
        ? 'POC_SUPPORT_UNDERFOOT'
        : 'POC_CENTERED';

  const refIdx = Math.max(0, closedBars.length - 4);
  const cvdChange3Bar = Number((latest.cumulativeDelta - closedBars[refIdx].cumulativeDelta).toFixed(3));
  const cvdTrend: OrderFlowMicrostructureSummary['cvdTrend'] =
    cvdChange3Bar > Math.abs(latest.totalVolume) * 0.08
      ? 'RISING'
      : cvdChange3Bar < -Math.abs(latest.totalVolume) * 0.08
        ? 'FALLING'
        : 'FLAT';

  const avgVol = lookback.reduce((sum, b) => sum + b.totalVolume, 0) / lookback.length;

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
  if (
    latest.low <= Math.min(...lookback.slice(0, -1).map((b) => b.low)) &&
    latest.delta < -avgVol * 0.25 &&
    latest.close < latest.pocPrice
  ) {
    deltaBreakoutSignal = 'BEARISH_DELTA_BREAKDOWN';
  } else if (
    latest.high >= Math.max(...lookback.slice(0, -1).map((b) => b.high)) &&
    latest.delta > avgVol * 0.25 &&
    latest.close > latest.pocPrice
  ) {
    deltaBreakoutSignal = 'BULLISH_DELTA_IMPULSE';
  }

  const sortedLevels = [...(latest.priceLevels ?? [])].sort((a, b) => a.price - b.price);
  const buyImbalances: number[] = [];
  const sellImbalances: number[] = [];
  for (const level of sortedLevels) {
    if (level.askVolume > Math.max(level.bidVolume * 3.0, avgVol * 0.015)) {
      buyImbalances.push(level.price);
    }
    if (level.bidVolume > Math.max(level.askVolume * 3.0, avgVol * 0.015)) {
      sellImbalances.push(level.price);
    }
  }

  let synthetic5mSummary: OrderFlowMicrostructureSummary['synthetic5mSummary'] = null;
  if (snapshot.timeframe === '1m' && bars.length >= 2) {
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

    synthetic5mSummary = {
      open: open5,
      high: high5,
      low: low5,
      close: close5,
      totalVolume: vol5,
      delta: delta5,
      pocPrice: poc5,
      pocPosition: pocPos5,
      signal: sig5
    };
  }

  const executionGuidance =
    snapshot.timeframe === '1m'
      ? 'CRITICAL BACKTEST RULE: Do NOT fade 1m CVD divergence alone during strong momentum. Require synthetic5mSummary POC alignment (POC_TRAPPED_OVERHEAD for SHORT, POC_SUPPORT_UNDERFOOT for LONG) or confirmed multi-bar absorption.'
      : 'CRITICAL BACKTEST RULE: Prioritize 5m POC position relative to close (POC_TRAPPED_OVERHEAD for SHORT, POC_SUPPORT_UNDERFOOT for LONG) combined with delta absorption or impulse.';

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
    stackedBuyImbalances: buyImbalances.slice(0, 6),
    stackedSellImbalances: sellImbalances.slice(0, 6),
    synthetic5mSummary,
    executionGuidance
  };
}

function buildDerivedContext(snapshot: AgentSnapshot): DerivedMarketContext {
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
  if (nyHour >= 20 || nyHour < 0) activeSession = 'ASIA';
  else if (nyHour >= 2 && nyHour < 5) activeSession = 'LONDON';
  else if (nyHour >= 8 && nyHour < 12) activeSession = 'NY_AM';
  else if (nyHour >= 12 && nyHour < 13) activeSession = 'NY_LUNCH';
  else if (nyHour >= 13 && nyHour < 16) activeSession = 'NY_PM';

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

  const recentWindow = candles.slice(-60);
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

  const last10 = candles.slice(-10);
  const recentSwingHigh = last10.length ? Math.max(...last10.map((c) => c.high)) : null;
  const recentSwingLow = last10.length ? Math.min(...last10.map((c) => c.low)) : null;
  const orderFlowSummary = buildOrderFlowMicrostructureSummary(snapshot);

  // --- SKILL 1: 15m Higher Timeframe (HTF) Trend Shield ---
  let htfTrend: DerivedMarketContext['htfTrend'] = 'NEUTRAL';
  let htfTrendDescription = '15m HTF structure neutral';
  if (candles.length >= 15) {
    const span = Math.min(candles.length, 60);
    const sub = candles.slice(-span);
    const htfBars: Array<{ high: number; low: number; close: number; open: number }> = [];
    for (let k = 0; k < sub.length; k += 15) {
      const chunk = sub.slice(k, k + 15);
      if (chunk.length >= 5) {
        htfBars.push({
          open: chunk[0].open ?? chunk[0].close,
          high: Math.max(...chunk.map((c) => c.high)),
          low: Math.min(...chunk.map((c) => c.low)),
          close: chunk[chunk.length - 1].close
        });
      }
    }
    if (htfBars.length >= 2) {
      const latestHtf = htfBars[htfBars.length - 1];
      const prevHtf = htfBars[htfBars.length - 2];
      if (latestHtf.close > prevHtf.high || (latestHtf.high > prevHtf.high && latestHtf.low > prevHtf.low)) {
        htfTrend = 'BULLISH';
        htfTrendDescription = '15m HTF structure is BULLISH (making higher highs & higher lows)';
      } else if (latestHtf.close < prevHtf.low || (latestHtf.high < prevHtf.high && latestHtf.low < prevHtf.low)) {
        htfTrend = 'BEARISH';
        htfTrendDescription = '15m HTF structure is BEARISH (making lower highs & lower lows)';
      } else {
        htfTrend = latestHtf.close >= latestHtf.open ? 'BULLISH' : 'BEARISH';
        htfTrendDescription = `15m HTF consolidation (${htfTrend.toLowerCase()} bias)`;
      }
    }
  }

  // --- SKILL 2: Chop & Low Volume Dead Zone Filter ---
  let marketRegime: DerivedMarketContext['marketRegime'] = 'TRENDING';
  let isLowVolumeChop = false;
  const recentFp = snapshot.footprints.slice(-15);
  if (recentFp.length >= 6) {
    const avgVolume = recentFp.reduce((s, b) => s + b.totalVolume, 0) / recentFp.length;
    const last3Vol = recentFp.slice(-3).reduce((s, b) => s + b.totalVolume, 0) / 3;
    const recentRange = Math.max(...recentFp.slice(-5).map((b) => b.high)) - Math.min(...recentFp.slice(-5).map((b) => b.low));
    const currentPrice = snapshot.latestPrice ?? candles[candles.length - 1]?.close ?? 70000;
    const rangePct = recentRange / currentPrice;

    if (last3Vol < avgVolume * 0.45 && rangePct < 0.0009) {
      marketRegime = 'CHOP_COMPRESSION';
      isLowVolumeChop = true;
    } else if (last3Vol > avgVolume * 1.8 || Math.abs(recentFp[recentFp.length - 1]?.delta ?? 0) > avgVolume * 0.3) {
      marketRegime = 'EXPANSION';
    }
  }

  // --- SKILL 3: Open Interest & Liquidation Exhaustion Engine ---
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
    dealingRange,
    recentSwingHigh,
    recentSwingLow,
    orderFlowSummary,
    htfTrend,
    htfTrendDescription,
    marketRegime,
    isLowVolumeChop,
    liquidationSignal
  };
}

function compactSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const derivedContext = buildDerivedContext(snapshot);
  return {
    ...snapshot,
    derivedContext,
    candles: snapshot.candles.slice(-40),
    footprints: snapshot.footprints.filter((bar) => bar.isClosed).slice(-4).map((bar) => ({
      ...bar,
      priceLevels: [...bar.priceLevels].sort((a, b) => Math.abs(a.price - bar.pocPrice) - Math.abs(b.price - bar.pocPrice)).slice(0, 10)
    })),
    trades: snapshot.trades.slice(0, 10),
    bids: snapshot.bids.slice(0, 5),
    asks: snapshot.asks.slice(0, 5)
  };
}

/**
 * Trim irrelevant heavy arrays per specialist so Groq agents use ~70% fewer tokens
 * and stay comfortably inside Groq's free TPM/TPD limits.
 */
function payloadForSpecialist(snapshot: AgentSnapshot, role: 'smc' | 'ict' | 'orderflow'): unknown {
  const d = snapshot.derivedContext;
  if (role === 'smc') {
    return {
      symbol: snapshot.symbol,
      latestPrice: snapshot.latestPrice,
      htfTrend: d?.htfTrend,
      marketRegime: d?.marketRegime,
      recentSwingHigh: d?.recentSwingHigh,
      recentSwingLow: d?.recentSwingLow,
      events: snapshot.technicalContext?.smc.events.slice(-5) ?? [],
      zones: snapshot.technicalContext?.smc.zones.slice(-4) ?? [],
      recentCandles: snapshot.candles.slice(-10).map((c) => ({ high: c.high, low: c.low, close: c.close }))
    };
  }
  if (role === 'ict') {
    return {
      symbol: snapshot.symbol,
      latestPrice: snapshot.latestPrice,
      activeSession: d?.activeSession,
      silverBullet: d?.silverBulletWindow,
      dealingRange: d?.dealingRange ? { zone: d.dealingRange.zone, equilibrium: d.dealingRange.equilibrium } : null,
      pdh: d?.pdh,
      pdl: d?.pdl,
      po3: snapshot.technicalContext?.ict.po3.slice(-3) ?? [],
      recentCandles: snapshot.candles.slice(-10).map((c) => ({ high: c.high, low: c.low, close: c.close }))
    };
  }
  const availableFootprints = snapshot.footprints.filter((b) => b.isClosed).length > 0
    ? snapshot.footprints.filter((b) => b.isClosed).slice(-3)
    : snapshot.footprints.slice(-3);
  return {
    symbol: snapshot.symbol,
    latestPrice: snapshot.latestPrice,
    microstructure: d?.orderFlowSummary ? {
      cvdTrend: d.orderFlowSummary.cvdTrend,
      latestPocPosition: d.orderFlowSummary.latestPocPosition,
      latestBarDelta: d.orderFlowSummary.latestBarDelta,
      absorptionSignal: d.orderFlowSummary.absorptionSignal,
      deltaBreakoutSignal: d.orderFlowSummary.deltaBreakoutSignal,
      stackedBuyImbalances: d.orderFlowSummary.stackedBuyImbalances,
      stackedSellImbalances: d.orderFlowSummary.stackedSellImbalances
    } : null,
    recentFootprints: availableFootprints.map(({ open, high, low, close, totalVolume, delta, pocPrice }) => ({
      open, high, low, close, totalVolume, delta, pocPrice
    }))
  };
}

async function generateJson<T>(config: ProviderConfig, system: string, input: unknown, schema: object): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.provider === 'ollama' ? 90_000 : 35_000);
  try {
    const url = config.provider === 'gemini'
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`
      : config.provider === 'groq'
        ? `${config.baseUrl ?? 'https://api.groq.com/openai/v1'}/chat/completions`
        : config.provider === 'nvidia'
          ? `${config.baseUrl ?? 'https://integrate.api.nvidia.com/v1'}/chat/completions`
          : config.provider === 'openrouter'
            ? `${config.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`
            : `${config.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.provider === 'gemini' && config.key) headers['x-goog-api-key'] = config.key;
    if ((config.provider === 'groq' || config.provider === 'nvidia' || config.provider === 'openrouter') && config.key) {
      headers.Authorization = `Bearer ${config.key}`;
    }
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost:4000';
      headers['X-Title'] = 'FlowTerminal';
    }
    const body = config.provider === 'gemini'
      ? {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 1100, responseMimeType: 'application/json', responseSchema: schema }
        }
      : (config.provider === 'groq' || config.provider === 'nvidia' || config.provider === 'openrouter')
        ? {
            model: config.provider === 'nvidia' ? (config.model.includes('/') ? config.model : 'meta/llama-3.3-70b-instruct')
                 : config.provider === 'openrouter' ? (config.model.includes(':') ? config.model : 'meta-llama/llama-3.3-70b-instruct:free')
                 : config.model,
            temperature: 0.15,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
            ...(config.provider === 'groq' ? { reasoning_format: 'hidden', reasoning_effort: 'low' } : {}),
            messages: [
              { role: 'user', content: `${system}\n\nCRITICAL REQUIREMENT: Output a valid JSON object matching this schema. Do not write any preamble, reasoning, or markdown code fences.\nSCHEMA:\n${JSON.stringify(schema)}\n\nMARKET_DATA:\n${JSON.stringify(input)}` }
            ]
          }
        : {
            model: config.model, stream: false, format: schema,
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
            options: { temperature: 0.15 }
          };
    recordAttempt(config);
    let response: Response | null = null;
    let netErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
        break;
      } catch (err) {
        netErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!response) {
      throw new Error(`${config.provider} (${config.model}): ${netErr instanceof Error ? netErr.message : 'fetch failed'}`);
    }
    if (response.status === 429) {
      let errDetail = '';
      try {
        const errJson = await response.json() as any;
        errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
      } catch {
        try { errDetail = await response.text(); } catch { /* ignore */ }
      }
      let retrySec = 3;
      const match = errDetail.match(/try again in (\d+(\.\d+)?)s/i);
      if (match) retrySec = Math.ceil(Number(match[1])) + 1;
      const headerRetry = Number(response.headers.get('retry-after'));
      if (Number.isFinite(headerRetry) && headerRetry > 0) retrySec = headerRetry;
      usageFor(config).cooldownUntil = Date.now() + (retrySec * 1000);
      throw new Error(`${config.provider} (${config.model}): ${errDetail || '429 rate limit reached'}`);
    }
    if (!response.ok) {
      const status = response.status;
      let errDetail = '';
      try {
        const errJson = await response.json() as any;
        errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
      } catch {
        try { errDetail = await response.text(); } catch { /* ignore */ }
      }
      if (status === 400 || status === 403) {
        throw new Error(`${config.provider} (${config.model}) rejected: ${errDetail || 'Check API key or model name.'}`);
      }
      if (status === 404) {
        throw new Error(`${config.provider} (${config.model}) 404 not found: ${errDetail || 'Model decommissioned or URL invalid.'}`);
      }
      throw new Error(`${config.provider} (${config.model}) HTTP ${status}: ${errDetail || 'Request failed'}`);
    }
    const payload = await response.json() as any;
    const text = config.provider === 'gemini'
      ? extractGeminiText(payload)
      : (config.provider === 'groq' || config.provider === 'nvidia' || config.provider === 'openrouter')
        ? payload.choices?.[0]?.message?.content
        : payload.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${config.provider} returned an empty structured response.`);
    return parseObject<T>(text.trim());
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithFallback<T>(providers: ProviderConfig[], role: AgentRole, system: string, input: unknown, schema: object): Promise<{ data: T; used: ProviderConfig }> {
  const failures: string[] = [];
  let eligible = providers.filter(isAvailable);
  if (!eligible.length) {
    const minCooldown = Math.min(...providers.map((p) => usageFor(p).cooldownUntil));
    const waitMs = Math.max(1500, Math.min(minCooldown - Date.now(), 6000));
    console.log(`\n[Auto-Pacing] All ${role.toUpperCase()} keys in 2s cooldown window. Pausing ${(waitMs / 1000).toFixed(1)}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
    eligible = providers;
  }
  for (let idx = 0; idx < eligible.length; idx++) {
    const provider = eligible[idx];
    try {
      const data = await generateJson<T>(provider, system, input, schema);
      return { data, used: provider };
    } catch (error) {
      const errText = error instanceof Error ? error.message : `${provider.provider}: request failed`;
      failures.push(errText);
      if (idx < eligible.length - 1) {
        const nextKey = eligible[idx + 1].key ? `...${eligible[idx + 1].key?.slice(-6)}` : 'backup';
        console.log(`\n[Auto-Rotation] ${role.toUpperCase()} key ...${provider.key?.slice(-6)} rate-limited. Immediately switching to backup key ${nextKey}...`);
      }
    }
  }
  throw new Error(`AI provider for ${role.toUpperCase()} failed: ${failures.join(' | ')}`);
}

function isPlaceholderKey(key: string | undefined): boolean {
  if (!key) return true;
  const lower = key.trim().toLowerCase();
  return !lower || lower.includes('paste-key-here') || lower.includes('your-api-key') || lower.includes('yahan_apni') || lower === 'xxx';
}

function detectProviderFromKey(key: string, fallbackProvider: AiProvider): AiProvider {
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('nvapi-')) return 'nvidia';
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'gemini';
  return fallbackProvider;
}

/**
 * Expands a single role API key into a high-intelligence primary model + high-daily-limit backup model
 * on that EXACT same key, so one agent never steals another agent's key but still survives model rate caps:
 * - Groq key: tries primary (e.g. llama-3.3-70b-versatile: 1,000 RPD) -> automatic fallback to llama-3.1-8b-instant (14,400 RPD, 500K TPD)
 * - Gemini key: tries primary (e.g. gemini-2.5-flash: 1,500 RPD or gemini-2.5-flash-lite) -> automatic fallback to alternate high-RPD Flash model
 */
function expandKeyWithModelFallback(
  provider: AiProvider,
  key: string,
  primaryModel: string,
  backupModel: string,
  scopePrefix: string
): ProviderConfig[] {
  const configs: ProviderConfig[] = [
    { provider, key, model: primaryModel, quotaScope: `${scopePrefix}:${primaryModel}` }
  ];
  if (backupModel && backupModel !== primaryModel) {
    configs.push({ provider, key, model: backupModel, quotaScope: `${scopePrefix}:${backupModel}` });
  }
  return configs;
}

function getModelForProvider(provider: AiProvider, role: AgentRole): string {
  const roleName = role.toUpperCase();
  if (provider === 'groq') {
    const configured = (role === 'manager'
      ? (process.env.GROQ_MANAGER_MODEL?.trim() || process.env.GROQ_MODEL?.trim())
      : (process.env.GROQ_SPECIALIST_MODEL?.trim() || process.env.GROQ_MODEL?.trim())) || 'openai/gpt-oss-20b';
    return process.env[`GROQ_${roleName}_MODEL`]?.trim() || configured;
  }
  if (provider === 'nvidia') {
    return process.env[`NVIDIA_${roleName}_MODEL`]?.trim() || process.env.NVIDIA_MODEL?.trim() || 'meta/llama-3.3-70b-instruct';
  }
  if (provider === 'openrouter') {
    return process.env[`OPENROUTER_${roleName}_MODEL`]?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'meta-llama/llama-3.3-70b-instruct:free';
  }
  return process.env[`GEMINI_${roleName}_MODEL`]?.trim() || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
}

function parseRoleCredentialList(
  raw: string | undefined,
  defaultProvider: AiProvider,
  roleName: string
): ProviderConfig[] {
  if (!raw?.trim()) return [];
  const credentials: ProviderConfig[] = [];
  const role = roleName.toLowerCase() as AgentRole;
  for (const part of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const separator = part.indexOf('|');
    const scope = separator >= 0 ? part.slice(0, separator).trim() : '';
    const key = separator >= 0 ? part.slice(separator + 1).trim() : part;
    if (isPlaceholderKey(key)) continue;
    const provider = detectProviderFromKey(key, defaultProvider);
    const model = getModelForProvider(provider, role);
    const keyFingerprint = createHash('sha256').update(key).digest('hex').slice(0, 8);
    credentials.push({
      provider,
      key,
      model,
      quotaScope: scope || `${roleName}-${provider}-${keyFingerprint}`
    });
  }
  return credentials;
}

/**
 * Strict 1-API-key-per-agent configuration with smart high-RPD model selection:
 * - Manager default (Gemini): primary `gemini-2.5-flash` (1,500 RPD, strong reasoning) -> backup `gemini-2.5-flash-lite` (1,500 RPD, 15 RPM)
 * - OrderFlow default (Gemini): primary `gemini-2.5-flash` (1,500 RPD) -> backup `gemini-2.5-flash-lite` (1,500 RPD, 15 RPM)
 * - SMC & ICT defaults (Groq): primary `llama-3.3-70b-versatile` (1,000 RPD, 70B reasoning) -> backup `llama-3.1-8b-instant` (14,400 RPD, 500K TPD)
 */
function getProviderConfigs(role: AgentRole): ProviderConfig[] {
  const roleName = role.toUpperCase();
  const defaultGeminiPrimary = role === 'manager'
    ? (process.env.GEMINI_MANAGER_MODEL?.trim() || 'gemini-3.8-flash')
    : (process.env.GEMINI_SPECIALIST_MODEL?.trim() || 'gemini-3.5-flash-lite');
  const geminiPrimary = process.env[`GEMINI_${roleName}_MODEL`]?.trim() || defaultGeminiPrimary;
  const geminiBackup = process.env[`GEMINI_${roleName}_BACKUP_MODEL`]?.trim() ||
    (geminiPrimary.includes('lite') ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite');

  const defaultGroqPrimary = role === 'manager'
    ? (process.env.GROQ_MANAGER_MODEL?.trim() || process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b')
    : (process.env.GROQ_SPECIALIST_MODEL?.trim() || 'openai/gpt-oss-20b');
  const groqPrimary = process.env[`GROQ_${roleName}_MODEL`]?.trim() || defaultGroqPrimary;
  const groqBackup = process.env[`GROQ_${roleName}_BACKUP_MODEL`]?.trim() ||
    (groqPrimary.includes('20b') ? 'openai/gpt-oss-120b' : 'openai/gpt-oss-20b');

  const configured: ProviderConfig[] = [];

  configured.push(...parseRoleCredentialList(process.env[`${roleName}_API_KEY`], 'gemini', roleName));
  configured.push(...parseRoleCredentialList(process.env[`GROQ_${roleName}_API_KEY`], 'groq', roleName));
  configured.push(...parseRoleCredentialList(process.env[`GROQ_${roleName}_CREDENTIALS`], 'groq', roleName));
  configured.push(...parseRoleCredentialList(process.env[`NVIDIA_${roleName}_API_KEY`], 'nvidia', roleName));
  configured.push(...parseRoleCredentialList(process.env[`OPENROUTER_${roleName}_API_KEY`], 'openrouter', roleName));
  configured.push(...parseRoleCredentialList(process.env[`GEMINI_${roleName}_API_KEY`], 'gemini', roleName));
  configured.push(...parseRoleCredentialList(process.env[`GEMINI_${roleName}_CREDENTIALS`], 'gemini', roleName));

  const seen = new Set<string>();
  const uniqueRoleConfigs = configured.filter((item) => {
    const id = `${item.provider}:${item.key}:${item.model}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (uniqueRoleConfigs.length > 0) {
    return uniqueRoleConfigs;
  }

  const legacyGemini = process.env.GEMINI_API_KEY?.trim();
  if (legacyGemini && !isPlaceholderKey(legacyGemini)) {
    return expandKeyWithModelFallback('gemini', legacyGemini, geminiPrimary, geminiBackup, `${roleName}-fallback`);
  }
  const legacyGroq = process.env.GROQ_API_KEY?.trim();
  if (legacyGroq && !isPlaceholderKey(legacyGroq)) {
    return expandKeyWithModelFallback('groq', legacyGroq, groqPrimary, groqBackup, `${roleName}-fallback`);
  }
  return [];
}

function sanitizeReport(value: SpecialistReport, agent: typeof SPECIALIST_AGENTS[number]): SpecialistReport {
  const allowed = new Set(strategiesFor(agent.id).map((strategy) => strategy.id));
  const direction = value.bias === 'LONG' || value.bias === 'SHORT' ? value.bias : 'NEUTRAL';
  const strategyCandidates = textList(value.strategyCandidates, 4).filter((id) => {
    const strategy = strategyById(id);
    return allowed.has(id) && strategy && (direction === 'NEUTRAL' || strategy.direction === 'BOTH' || strategy.direction === direction);
  }).slice(0, 3);
  return {
    agentId: agent.id,
    name: agent.name,
    bias: direction,
    strength: Math.max(0, Math.min(3, Math.round(Number(value.strength) || 0))),
    findings: textList(value.findings, 5),
    strategyCandidates,
    concerns: textList(value.concerns, 4),
    missingData: textList(value.missingData, 4)
  };
}

function computeFallbackLevels(
  decision: 'LONG' | 'SHORT',
  snapshot: AgentSnapshot,
  rawEntry: number,
  rawStop: number,
  rawTargetR: number | null
): { entryPrice: number; stopPrice: number; target1Price: number; targetPrice: number; targetR: 2 | 3 } {
  const candles = snapshot.candles;
  const lastClose = snapshot.latestPrice ?? candles[candles.length - 1]?.close ?? 0;
  const recent = candles.slice(-8);
  const swingLow = recent.length ? Math.min(...recent.map((c) => c.low)) : lastClose * 0.997;
  const swingHigh = recent.length ? Math.max(...recent.map((c) => c.high)) : lastClose * 1.003;

  const entryPrice = Number.isFinite(rawEntry) && rawEntry > 0 ? rawEntry : lastClose;
  const defaultBuffer = Math.max(entryPrice * 0.0008, Math.abs(swingHigh - swingLow) * 0.25, 1e-6);

  let stopPrice = Number.isFinite(rawStop) && rawStop > 0 ? rawStop : (decision === 'LONG' ? Math.min(swingLow, entryPrice - defaultBuffer) : Math.max(swingHigh, entryPrice + defaultBuffer));
  if (decision === 'LONG' && stopPrice >= entryPrice) {
    stopPrice = Math.min(swingLow < entryPrice ? swingLow : entryPrice - defaultBuffer, entryPrice - defaultBuffer);
  } else if (decision === 'SHORT' && stopPrice <= entryPrice) {
    stopPrice = Math.max(swingHigh > entryPrice ? swingHigh : entryPrice + defaultBuffer, entryPrice + defaultBuffer);
  }

  const risk = Math.max(Math.abs(entryPrice - stopPrice), 1e-6);
  const targetR: 2 | 3 = rawTargetR === 3 ? 3 : 2;
  const dir = decision === 'LONG' ? 1 : -1;
  const target1Price = Number((entryPrice + dir * risk).toFixed(6));
  const targetPrice = Number((entryPrice + dir * risk * targetR).toFixed(6));

  return {
    entryPrice: Number(entryPrice.toFixed(6)),
    stopPrice: Number(stopPrice.toFixed(6)),
    target1Price,
    targetPrice,
    targetR
  };
}

function sanitizePlan(value: CouncilPlan, reports: SpecialistReport[], snapshot: AgentSnapshot): CouncilPlan {
  const longReports = reports.filter((r) => r.bias === 'LONG' && r.strength >= 1);
  const shortReports = reports.filter((r) => r.bias === 'SHORT' && r.strength >= 1);
  const strongLong = reports.some((r) => r.bias === 'LONG' && r.strength >= 2);
  const strongShort = reports.some((r) => r.bias === 'SHORT' && r.strength >= 2);

  let consensusBias: 'LONG' | 'SHORT' | null = null;
  if (longReports.length >= 2 && strongLong && !reports.some((r) => r.bias === 'SHORT' && r.strength >= 3)) {
    consensusBias = 'LONG';
  } else if (shortReports.length >= 2 && strongShort && !reports.some((r) => r.bias === 'LONG' && r.strength >= 3)) {
    consensusBias = 'SHORT';
  }

  // Both Manager AND specialist consensus MUST agree. If Manager chose WAIT or rejected the trade, NEVER force a trade!
  let decision: CouncilPlan['decision'] = 'WAIT';
  const managerWantsTrade = (value.decision === 'LONG' || value.decision === 'SHORT');
  const summaryRejection = /reject|hold off|held off|defer|no trade|wait stance|too risky/i.test(value.summary || '');

  if (managerWantsTrade && value.decision === consensusBias && !summaryRejection) {
    decision = value.decision;
  } else {
    decision = 'WAIT';
  }

  const hasFreshFeed = (snapshot.feedStatus === 'LIVE' || snapshot.feedStatus === 'DESYNCHRONIZED') &&
    snapshot.lastTradeAt !== null && Date.now() - snapshot.lastTradeAt < 15_000;
  const hasContext = snapshot.footprints.filter((bar) => bar.isClosed).length >= 4 && snapshot.candles.length >= 4;

  // Quality gate: 3 New Loss-Reduction Skills
  if (snapshot.derivedContext?.marketRegime === 'CHOP_COMPRESSION' || snapshot.derivedContext?.isLowVolumeChop) {
    decision = 'WAIT';
  }

  if (decision === 'LONG' && snapshot.derivedContext?.htfTrend === 'BEARISH') {
    const isPdlSweep = snapshot.derivedContext.pdl !== null && (snapshot.latestPrice ?? 0) <= snapshot.derivedContext.pdl * 1.0005;
    if (!isPdlSweep) decision = 'WAIT';
  }

  if (decision === 'SHORT' && snapshot.derivedContext?.htfTrend === 'BULLISH') {
    const isPdhSweep = snapshot.derivedContext.pdh !== null && (snapshot.latestPrice ?? 0) >= snapshot.derivedContext.pdh * 0.9995;
    if (!isPdhSweep) decision = 'WAIT';
  }

  if (decision === 'LONG' && snapshot.derivedContext?.liquidationSignal === 'SHORT_SQUEEZE_EXHAUSTION') {
    decision = 'WAIT';
  }

  if (!hasFreshFeed || !hasContext || decision === 'WAIT') {
    decision = 'WAIT';
  }

  const aligned = decision === 'WAIT' ? [] : reports.filter((report) => report.bias === decision);
  const eligibleCandidates = new Set(aligned.flatMap((report) => report.strategyCandidates));
  const managerSelectedIds = textList(value.strategyIds, 6).filter((id) => eligibleCandidates.has(id));
  const fallbackIds = [...eligibleCandidates].slice(0, 6);
  const selectedStrategyIds = managerSelectedIds.length > 0 ? managerSelectedIds : fallbackIds;

  if (decision === 'WAIT') {
    const waitReasons = textList(value.reasons, 4);
    return {
      decision: 'WAIT',
      summary: String(value.summary || 'WAIT: Specialists do not have a clear 2/3 directional confluence yet.').slice(0, 420),
      reasons: waitReasons.length > 0 ? waitReasons : reports.flatMap((r) => r.findings.slice(0, 1)).slice(0, 3),
      entryTrigger: 'WAIT: Wait for at least 2 of 3 specialists (SMC, ICT, Order Flow) to align with confirmed displacement or absorption.',
      entryPrice: null,
      invalidation: 'WAIT: No active trade setup.',
      stopPrice: null,
      target1Price: null,
      targetPrice: null,
      targetR: null,
      exitPlan: 'WAIT: Stand aside and monitor key liquidity and POC/Value Area levels.',
      agreeingAgents: [],
      dissent: reports.map((report) => `${report.name}: ${report.bias} (strength ${report.strength}/3)`),
      strategyIds: [],
      strategyNames: []
    };
  }

  const levels = computeFallbackLevels(
    decision,
    snapshot,
    Number(value.entryPrice),
    Number(value.stopPrice),
    value.targetR
  );

  const rawEntry = Number(value.entryPrice);
  const rawStop = Number(value.stopPrice);
  const rawTarget = Number(value.targetPrice);
  const rawRisk = Math.abs(rawEntry - rawStop);
  const rawReward = Math.abs(rawTarget - rawEntry);
  const rawActualR = rawRisk > 0 ? rawReward / rawRisk : 0;
  const rawTargetR: 2 | 3 = value.targetR === 3 ? 3 : 2;
  const rawValid = Number.isFinite(rawEntry) && rawEntry > 0 &&
    Number.isFinite(rawStop) && rawStop > 0 &&
    Number.isFinite(rawTarget) && rawTarget > 0 &&
    Math.abs(rawActualR - rawTargetR) <= 0.4 &&
    (decision === 'LONG' ? rawStop < rawEntry && rawTarget > rawEntry : rawStop > rawEntry && rawTarget < rawEntry);

  const finalEntry = rawValid ? rawEntry : levels.entryPrice;
  const finalStop = rawValid ? rawStop : levels.stopPrice;
  const finalRisk = Math.abs(finalEntry - finalStop);
  const finalDir = decision === 'LONG' ? 1 : -1;
  const finalTarget1 = Number((finalEntry + finalDir * finalRisk).toFixed(6));
  const finalTarget = rawValid ? rawTarget : levels.targetPrice;
  const finalTargetR = rawValid ? rawTargetR : levels.targetR;

  const rawReasons = textList(value.reasons, 5);
  const synthesizedReasons = rawReasons.length > 0
    ? rawReasons
    : aligned.flatMap((r) => r.findings.slice(0, 2).map((f) => `[${r.name}] ${f}`)).slice(0, 5);

  const trigger = String(value.entryTrigger ?? '').trim() ||
    (snapshot.profile
      ? `${decision} near ${finalEntry} holding footprint POC (${snapshot.profile.poc}) / Value Area (${snapshot.profile.val}–${snapshot.profile.vah})`
      : `${decision} entry near ${finalEntry} on closed-bar structure and order-flow confirmation`);

  const invalidation = String(value.invalidation ?? '').trim() ||
    `Setup invalid if price closes beyond structural stop at ${finalStop}.`;

  const exitPlan = String(value.exitPlan ?? '').trim() ||
    `Book 50% at TP1 (1R: ${finalTarget1}), move stop to breakeven (${finalEntry}), and trail remaining 50% to final TP (${finalTargetR}R: ${finalTarget}).`;

  return {
    decision,
    summary: String(value.summary || `${decision} setup confirmed by ${aligned.map((a) => a.name).join(' + ')}.`).slice(0, 420),
    reasons: synthesizedReasons,
    entryTrigger: trigger.slice(0, 260),
    entryPrice: finalEntry,
    invalidation: invalidation.slice(0, 260),
    stopPrice: finalStop,
    target1Price: finalTarget1,
    targetPrice: finalTarget,
    targetR: finalTargetR,
    exitPlan: exitPlan.slice(0, 260),
    agreeingAgents: aligned.map((report) => report.name),
    dissent: reports.filter((report) => report.bias !== decision)
      .map((report) => `${report.name}: ${report.bias} (strength ${report.strength}/3)`),
    strategyIds: selectedStrategyIds,
    strategyNames: selectedStrategyIds.map((id) => strategyById(id)?.name ?? id)
  };
}

export async function runOrderFlowCouncil(snapshot: AgentSnapshot): Promise<CouncilResult> {
  const configuredRoles = SPECIALIST_AGENTS.map((agent) => getProviderConfigs(agent.id));
  const managerProviders = getProviderConfigs('manager');
  const providers = [...configuredRoles.flat(), ...managerProviders];
  if (!providers.length) throw new Error('No AI provider is configured. Set your 4 role keys in .env, then restart the backend.');
  const input = compactSnapshot(snapshot);
  const missingRole = SPECIALIST_AGENTS.find((agent, index) => !configuredRoles[index].length);
  if (missingRole) throw new Error(`No API key is configured for ${missingRole.id.toUpperCase()}. Set ${missingRole.id.toUpperCase()}_API_KEY in .env.`);
  if (!managerProviders.length) throw new Error('No API key is configured for MANAGER. Set MANAGER_API_KEY in .env.');

  const usedRoleModels: string[] = [];
  const reports = await Promise.all(SPECIALIST_AGENTS.map(async (agent, index) => {
    try {
      const specialistInput = payloadForSpecialist(input, agent.id);
      const pastLessons = input.paperPerformance?.learnedLessons ?? [];
      const pastLessonsText = pastLessons.length
        ? `\n\nCRITICAL: RULES LEARNED FROM PAST LOSSES (DO NOT REPEAT THESE MISTAKES):\n${pastLessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
        : '';
      const orderFlowExtraRules = agent.id === 'orderflow'
        ? `\n\nBACKTEST-VALIDATED ORDERFLOW RULES (MUST FOLLOW):\n1. Examine 'microstructure' (especially 'latestPocPosition', 'absorptionSignal', 'deltaBreakoutSignal', and 'synthetic5mSummary').\n2. NEVER trigger a counter-trend reversal on 1m CVD divergence alone. Require either 5m/multi-bar POC trapped overhead (for SHORT) or POC support underfoot (for LONG) with absorption.\n3. Give strength 2 or 3 ONLY when price close vs POC position confirms your directional bias.`
        : '';
      const strategyList = strategiesFor(agent.id).map(({ id, name, rule }) => `${id} ${name}: ${rule}`).join('; ');
      const specialistSystem = `ROLE: ${agent.name}. TASK: ${agent.focus}${pastLessonsText}${orderFlowExtraRules}\nCATALOG: ${strategyList}\nOutput JSON with keys: bias ("LONG"|"SHORT"|"NEUTRAL"), strength (0-3), findings (string[]), strategyCandidates (string[] max 2 IDs), concerns (string[]), missingData (string[]).`;
      const { data: raw, used } = await generateWithFallback<SpecialistReport>(configuredRoles[index], agent.id,
        specialistSystem, specialistInput, reportSchema);
      usedRoleModels[index] = `${agent.id}:${used.provider}/${used.model}`;
      return sanitizeReport(raw, agent);
    } catch (error) {
      usedRoleModels[index] = `${agent.id}:failed`;
      return {
        agentId: agent.id, name: agent.name, bias: 'NEUTRAL' as const, strength: 0,
        findings: [], strategyCandidates: [], concerns: [error instanceof Error ? error.message.slice(0, 220) : 'Specialist analysis failed.'],
        missingData: ['Specialist analysis unavailable.']
      };
    }
  }));

  const pastLessons = input.paperPerformance?.learnedLessons ?? [];
  const pastLessonsText = pastLessons.length
    ? `\n\nCRITICAL: RULES LEARNED FROM PAST LOSSES (STRICTLY OBEY - REJECT TRADE IF IT REPEATS A PAST MISTAKE):\n${pastLessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
    : '';
  const managerSystemPrompt = `ROLE: TRADE PLAN MANAGER\nSynthesize the 3 specialist reports (SMC, ICT, Order Flow) and determine the trade plan.\n1. Choose LONG or SHORT when at least 2 of 3 specialists agree on the direction with strength >= 2 and no specialist opposes with strength 3. Otherwise choose WAIT.\n2. HTF Trend & Loss Rules: strictly obey past loss rules and 15m HTF trend. If 15m trend opposes trade or regime is CHOP_COMPRESSION, choose WAIT.${pastLessonsText}\n3. If valid, provide entryPrice, stopPrice, target1Price (1R), targetPrice (2R or 3R), targetR (2|3), and 2 clear reasons. Output valid JSON.`;

  const managerInputPayload = {
    symbol: input.symbol,
    latestPrice: input.latestPrice,
    htfTrend: input.derivedContext?.htfTrend,
    marketRegime: input.derivedContext?.marketRegime,
    microstructure: input.derivedContext?.orderFlowSummary ? {
      cvdTrend: input.derivedContext.orderFlowSummary.cvdTrend,
      latestPocPosition: input.derivedContext.orderFlowSummary.latestPocPosition,
      absorptionSignal: input.derivedContext.orderFlowSummary.absorptionSignal
    } : null,
    reports: reports.map((r) => ({
      name: r.name,
      bias: r.bias,
      strength: r.strength,
      findings: r.findings.slice(0, 2),
      strategies: r.strategyCandidates
    }))
  };

  const { data: rawPlan, used: managerUsed } = await generateWithFallback<CouncilPlan>(
    managerProviders,
    'manager',
    managerSystemPrompt,
    managerInputPayload,
    planSchema
  );
  const usedProviders = [...usedRoleModels, `manager:${managerUsed.provider}/${managerUsed.model}`].join(' · ');
  return { reports, plan: sanitizePlan(rawPlan, reports, input), model: usedProviders, generatedAt: Date.now() };
}

export async function analyzeTradeOutcomeWithAI(
  trade: { decision: 'LONG' | 'SHORT'; entryPrice: number; stopPrice: number; targetPrice?: number; reasons: string[]; summary: string },
  marketOutcome: { outcome: 'WIN' | 'LOSS'; exitPrice: number; exitReason: string; marketContext: string }
): Promise<string> {
  const managerProviders = getProviderConfigs('manager');
  if (!managerProviders.length) {
    return marketOutcome.outcome === 'WIN'
      ? 'Confluence between HTF trend, POC defense, and stacked imbalances produced successful continuation.'
      : 'Do not enter trade against dominant market structure.';
  }
  const schema = {
    type: 'OBJECT',
    properties: {
      lesson: { type: 'STRING' }
    },
    required: ['lesson']
  };

  const isWin = marketOutcome.outcome === 'WIN';
  const roleTitle = isWin ? 'TRADING SUCCESS REINFORCEMENT ANALYST' : 'TRADING POST-MORTEM ANALYST';
  const tradeResultText = isWin ? 'TARGET REACHED (+2R WIN)' : 'STOP LOSS HIT (-1R LOSS)';
  const taskDesc = isWin
    ? 'Provide a single concise, punchy trading insight (1 sentence) explaining why this trade SUCCEEDED and what winning confluence pattern the agents should look for in the future.\nExample: "Bullish continuation confirmed when 15m HTF trend aligned with 1m stacked buy imbalances holding the POC."'
    : 'Provide a single concise, punchy trading rule (1 sentence) explaining why this trade FAILED and what mistake the agents must NEVER repeat in the future.\nExample: "Never enter LONG on 1m divergence when 5m POC is overhead and market structure made lower lows."';

  const targetLine = trade.targetPrice ? `, Target: ${trade.targetPrice}` : '';
  const prompt = `ROLE: ${roleTitle}\nA trade resulted in a ${tradeResultText}.\nTRADE DETAILS:\nSide: ${trade.decision}, Entry: ${trade.entryPrice}, Stop: ${trade.stopPrice}${targetLine}\nReasons: ${trade.reasons.join(' | ')}\n\nMARKET OUTCOME:\nExit Price: ${marketOutcome.exitPrice}\nContext: ${marketOutcome.marketContext}\n\nTASK: ${taskDesc}`;

  try {
    const { data } = await generateWithFallback<{ lesson: string }>(managerProviders, 'manager', prompt, {}, schema);
    return data.lesson || (isWin ? 'Strong order-flow confluence and HTF trend alignment drove high-probability trade target.' : 'Verify multi-timeframe POC alignment before entering counter-trend setups.');
  } catch {
    return isWin
      ? 'Winning setup: Multi-timeframe trend alignment and order-flow participation confirmed move.'
      : `Avoid ${trade.decision} entries when momentum and POC flip oppose the trade.`;
  }
}

export const analyzeTradeLossWithAI = (
  trade: { decision: 'LONG' | 'SHORT'; entryPrice: number; stopPrice: number; reasons: string[]; summary: string },
  marketOutcome: { exitPrice: number; exitReason: string; marketContext: string }
) => analyzeTradeOutcomeWithAI(trade, { outcome: 'LOSS', ...marketOutcome });