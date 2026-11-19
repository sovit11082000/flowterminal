import http from 'node:http';
import dns from 'node:dns';

// Force IPv4 DNS lookup first to prevent connection dropouts on cloud hosts
dns.setDefaultResultOrder('ipv4first');

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { LOCAL_GATEWAY_PORT, DEFAULT_SYMBOL, SUPPORTED_SYMBOLS, CRYPTO_SYMBOLS, FOREX_SYMBOLS } from './config/constants.js';
import {
  ConnectionStatus,
  GatewayMessage,
  StatusGatewayMessage,
  TradeGatewayMessage,
  OrderBookSnapshotGatewayMessage,
  OrderBookDeltaGatewayMessage,
  CandleGatewayMessage,
  FootprintBarGatewayMessage,
  SerializedFootprintBar,
  CandleTimeframe,
  FootprintTimeframe,
  NormalizedLiquidation,
  NormalizedCandle,
  NormalizedTrade
} from './types/market.js';
import { parsePublicTradePayload } from './normalizers/tradeNormalizer.js';
import { OrderBookState } from './normalizers/orderbookNormalizer.js';
import { BybitWebSocketClient } from './ingestion/bybitClient.js';
import { DerivForexClient } from './ingestion/derivForexClient.js';
import { OrderFlowAggregator } from './engine/orderFlowAggregator.js';
import { BybitRestService, BybitRestServiceError } from './services/bybitRestService.js';
import { BybitOptionsService, type OptionBase } from './services/bybitOptionsService.js';
import { BinanceOptionsService } from './services/binanceOptionsService.js';
import { FootprintHistoryStore } from './services/footprintHistoryStore.js';
import { OrderBookHistoryStore } from './services/orderBookHistoryStore.js';
import { TradeHistoryStore } from './services/tradeHistoryStore.js';
import { LiquidationHistoryStore } from './services/liquidationHistoryStore.js';
import { MongoHistoryStore, type AgentPaperPerformance } from './services/mongoHistoryStore.js';
import { runOrderFlowCouncil, type AgentSnapshot, type RiskAllocation } from './agents/orderFlowCouncil.js';
import { sendTradeEntryAlert, sendTradeOutcomeAlert, sendTelegramMessage, sendOrEditLiveStatusMessage } from './services/telegramService.js';
import { runNightlyAuditCycle, renderAuditDashboardHtml } from './services/nightlyAuditService.js';


// --- ROBUST ENVIRONMENT & RENDER SECRET FILES LOADER ---
function loadProjectEnv(): void {
  const candidates = [
    resolve('/etc/secrets/.env'),
    resolve('/etc/secrets/env'),
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '.env'),
    resolve(process.cwd(), 'backend', '.env')
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)$/);
        if (!match) continue;
        const key = match[1];
        let val = match[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    } catch {
      // ignore read issues
    }
  }
}
loadProjectEnv();

let currentMarketStatus: ConnectionStatus = 'DISCONNECTED';
const marketStatusBySymbol = new Map<string, ConnectionStatus>();
let lastTradeReceivedAt: number | null = null;
const lastTradeAtBySymbol = new Map<string, number>();
let lastCouncilRequestAt = 0;

function istDayString(tsMs = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(tsMs));
}

interface MarketPipeline {
  orderBook: OrderBookState;
  footprints: Record<FootprintTimeframe, OrderFlowAggregator>;
}

const CANDLE_INTERVALS: Record<string, CandleTimeframe> = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', D: '1d'
};
const SUPPORTED_CANDLE_TIMEFRAMES = new Set<CandleTimeframe>(Object.values(CANDLE_INTERVALS));

const tickSizes: Record<string, number> = {
  BTCUSDT: 0.1, ETHUSDT: 0.01, SOLUSDT: 0.01, XRPUSDT: 0.0001,
  BNBUSDT: 0.01, DOGEUSDT: 0.00001, ADAUSDT: 0.0001, LINKUSDT: 0.001,
  AVAXUSDT: 0.01, XAUTUSDT: 0.1,
  XAUUSD: 0.1, EURUSD: 0.0001, GBPUSD: 0.0001
};
let resolvedTickSizes: Record<string, number> = { ...tickSizes };

const footprintHistory = new FootprintHistoryStore();
const marketPipelines = new Map<string, MarketPipeline>(SUPPORTED_SYMBOLS.map((symbol): [string, MarketPipeline] => [symbol, {
  orderBook: new OrderBookState(),
  footprints: {
    '1m': new OrderFlowAggregator({ timeframe: '1m', tickSize: tickSizes[symbol], initialCvd: footprintHistory.getLatestClosedBar(symbol, '1m')?.cumulativeDelta ?? 0 }),
    '5m': new OrderFlowAggregator({ timeframe: '5m', tickSize: tickSizes[symbol], initialCvd: footprintHistory.getLatestClosedBar(symbol, '5m')?.cumulativeDelta ?? 0 })
  }
}]));

const BYBIT_REST_BASE = (process.env.BYBIT_REST_URL?.trim() || 'https://api.bytick.com').replace(/\/+$/, '');

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBybitRest(endpoint: string, init?: RequestInit): Promise<Response> {
  const mirrors = [
    BYBIT_REST_BASE,
    BYBIT_REST_BASE.includes('bytick') ? 'https://api.bybit.com' : 'https://api.bytick.com'
  ];
  let lastError: unknown;
  for (const base of mirrors) {
    try {
      const res = await fetchWithTimeout(`${base}${endpoint}`, init, 6500);
      if (res.ok) return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Bybit REST unreachable for ${endpoint}`);
}

const restService = new BybitRestService({ baseUrl: BYBIT_REST_BASE });
const optionsService = new BybitOptionsService(BYBIT_REST_BASE);
const binanceOptionsService = new BinanceOptionsService();
const orderBookHistory = new OrderBookHistoryStore();
const tradeHistory = new TradeHistoryStore();
const liquidationHistory = new LiquidationHistoryStore();
const mongoHistory = new MongoHistoryStore();

type MongoWriteTask = { label: string; priority: number; write: () => Promise<void> };
const mongoWriteQueue: MongoWriteTask[] = [];
const MAX_PENDING_MONGO_WRITES = 1024;
const MAX_ACTIVE_MONGO_WRITES = 12;
const MONGO_TRADE_FLUSH_MS = 1_500;
const MAX_BUFFERED_MONGO_TRADES = 25_000;
const MAX_TRADES_PER_MONGO_BATCH = 5_000;
const lastOrderBookPersistAtBySymbol = new Map<string, number>();
const ORDERBOOK_MONGO_SAMPLE_MS = 15_000;
let activeMongoWrites = 0;
let lastMongoQueueWarningAt = 0;
const droppedMongoWrites: Record<string, number> = {};
const bufferedMongoTrades: NormalizedTrade[] = [];
let mongoTradeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function mongoWritePriority(label: string): number {
  if (label === 'footprint bar') return 3;
  if (label === 'trades') return 2;
  if (label === 'liquidations') return 1;
  return 0;
}

function recordDroppedMongoWrite(label: string): void {
  droppedMongoWrites[label] = (droppedMongoWrites[label] ?? 0) + 1;
  if (Date.now() - lastMongoQueueWarningAt > 60_000) {
    lastMongoQueueWarningAt = Date.now();
    console.warn(`[MongoDB] Write queue is full; dropped a ${label} record to protect service memory.`);
  }
}

function drainMongoWriteQueue(): void {
  while (activeMongoWrites < MAX_ACTIVE_MONGO_WRITES && mongoWriteQueue.length) {
    let next = 0;
    for (let i = 1; i < mongoWriteQueue.length; i++) {
      if (mongoWriteQueue[i].priority > mongoWriteQueue[next].priority) next = i;
    }
    const [task] = mongoWriteQueue.splice(next, 1);
    activeMongoWrites++;
    void task.write().catch((error: unknown) => {
      console.warn(`[MongoDB] Could not persist ${task.label}:`, error instanceof Error ? error.message : error);
    }).finally(() => {
      activeMongoWrites--;
      drainMongoWriteQueue();
    });
  }
}

function persistToMongo(label: string, write: () => Promise<void>): void {
  if (mongoWriteQueue.length >= MAX_PENDING_MONGO_WRITES) {
    const incomingPriority = mongoWritePriority(label);
    let lowest = 0;
    for (let i = 1; i < mongoWriteQueue.length; i++) {
      if (mongoWriteQueue[i].priority < mongoWriteQueue[lowest].priority) lowest = i;
    }
    const queuedVictim = mongoWriteQueue[lowest];
    if (incomingPriority < queuedVictim.priority) {
      recordDroppedMongoWrite(label);
      return;
    }
    mongoWriteQueue.splice(lowest, 1);
    recordDroppedMongoWrite(queuedVictim.label);
  }
  mongoWriteQueue.push({ label, priority: mongoWritePriority(label), write });
  drainMongoWriteQueue();
}

function flushBufferedMongoTrades(): void {
  if (mongoTradeFlushTimer) clearTimeout(mongoTradeFlushTimer);
  mongoTradeFlushTimer = null;
  if (!bufferedMongoTrades.length) return;
  const batch = bufferedMongoTrades.splice(0, MAX_TRADES_PER_MONGO_BATCH);
  persistToMongo('trades', () => mongoHistory.saveTrades(batch));
  if (bufferedMongoTrades.length) mongoTradeFlushTimer = setTimeout(flushBufferedMongoTrades, 0);
}

function queueMongoTrades(trades: NormalizedTrade[]): void {
  if (process.env.MONGO_PERSIST_TRADES !== 'true') return;
  bufferedMongoTrades.push(...trades);
  if (bufferedMongoTrades.length > MAX_BUFFERED_MONGO_TRADES) {
    const excess = bufferedMongoTrades.length - MAX_BUFFERED_MONGO_TRADES;
    bufferedMongoTrades.splice(0, excess);
    recordDroppedMongoWrite('trades');
  }
  if (bufferedMongoTrades.length >= MAX_TRADES_PER_MONGO_BATCH) {
    flushBufferedMongoTrades();
  } else if (!mongoTradeFlushTimer) {
    mongoTradeFlushTimer = setTimeout(flushBufferedMongoTrades, MONGO_TRADE_FLUSH_MS);
  }
}

async function waitForMongoWrites(maxWaitMs = 20_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while ((mongoWriteQueue.length > 0 || activeMongoWrites > 0) && Date.now() < deadline) {
    drainMongoWriteQueue();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (mongoWriteQueue.length || activeMongoWrites) {
    console.warn(`[MongoDB] Shutdown wait expired with ${mongoWriteQueue.length} queued and ${activeMongoWrites} active writes.`);
  }
}

async function readMongoOrLocal<T>(label: string, readMongo: () => Promise<T>, readLocal: () => T): Promise<T> {
  if (!mongoHistory.connected) return readLocal();
  try { return await readMongo(); }
  catch (error) {
    console.warn(`[MongoDB] Could not read ${label}; using current-process cache:`, error instanceof Error ? error.message : error);
    return readLocal();
  }
}

const liveTickerBySymbol = new Map<string, { lastPrice: number | null; markPrice: number | null; indexPrice: number | null }>();
const latestExchangeCandles = new Map<string, NormalizedCandle>();
const firstFootprintBarByKey = new Map<string, number>();
const derivativesHistoryCache = new Map<string, { expiresAt: number; points: Array<{ openInterest: string; timestamp: string }> }>();
const liveDerivativesCache = new Map<string, { expiresAt: number; data: any }>();
const derivativesHistoryPending = new Map<string, Promise<Array<{ openInterest: string; timestamp: string }>>>();

async function loadThirtyDayOpenInterest(symbol: string): Promise<Array<{ openInterest: string; timestamp: string }>> {
  const now = Date.now();
  const startTime = now - 30 * 24 * 60 * 60 * 1000;
  const collected = new Map<string, { openInterest: string; timestamp: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const query = new URLSearchParams({ category: 'linear', symbol, intervalTime: '5min', startTime: String(startTime), endTime: String(now), limit: '200' });
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await fetchBybitRest(`/v5/market/open-interest?${query}`);
      if (!response.ok) break;
      const payload = await response.json() as { retCode?: number; result?: { list?: Array<{ openInterest: string; timestamp: string }>; nextPageCursor?: string } };
      if (payload.retCode !== 0 || !payload.result) break;
      for (const point of payload.result.list ?? []) {
        const timestamp = Number(point.timestamp);
        if (Number.isFinite(timestamp) && timestamp >= startTime && timestamp <= now) collected.set(String(timestamp), point);
      }
      const next = payload.result.nextPageCursor;
      if (!next || next === cursor || !(payload.result.list?.length)) break;
      cursor = next;
    } catch {
      if (collected.size > 0) break;
      throw new Error('Bybit OI history endpoint timed out.');
    }
  }
  return [...collected.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

async function getThirtyDayOpenInterest(symbol: string): Promise<Array<{ openInterest: string; timestamp: string }>> {
  const cached = derivativesHistoryCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.points;
  let pending = derivativesHistoryPending.get(symbol);
  if (!pending) {
    pending = loadThirtyDayOpenInterest(symbol);
    derivativesHistoryPending.set(symbol, pending);
  }
  try {
    const points = await pending;
    derivativesHistoryCache.set(symbol, { expiresAt: Date.now() + 60 * 60_000, points });
    return points;
  } finally {
    if (derivativesHistoryPending.get(symbol) === pending) derivativesHistoryPending.delete(symbol);
  }
}

// --- MULTI-COIN LIVE TRADING ENGINE (STRICTLY PAPER TRADING + TELEGRAM SIGNALS) ---
interface LiveActiveTrade {
  tradeId: string;
  symbol: string;
  decision: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  initialStopPrice: number;
  initialRisk: number;
  targetPrice: number;
  targetR: number;
  riskAllocation?: RiskAllocation | null;
  macro1hTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  macro4hTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reasons: string[];
  strategies: string[];
  summary: string;
  barsHeld: number;
  enteredAt: number;
}

const liveActiveTrades = new Map<string, LiveActiveTrade>();
const symbolCooldownUntil = new Map<string, number>();
const lastSlDirectionBySymbol = new Map<string, { side: 'LONG' | 'SHORT'; at: number }>();
const liveLearnedLessons: string[] = [];

// IST Calendar-Day Persistent Trade History (Survives restarts via MongoDB reload)
interface TodayResolvedRecord {
  istDay: string;
  side: 'LONG' | 'SHORT';
  outcome: 'WIN' | 'LOSS';
  pnlR: number;
  resolvedAt: number;
}
const todayIstResolvedResults: TodayResolvedRecord[] = [];

function getTodayIstResults(): Array<{ side: 'LONG' | 'SHORT'; outcome: 'WIN' | 'LOSS'; pnlR: number; resolvedAt: number }> {
  const today = istDayString();
  // Prune any previous IST day entries
  while (todayIstResolvedResults.length && todayIstResolvedResults[0].istDay !== today) {
    todayIstResolvedResults.shift();
  }
  return todayIstResolvedResults.map(({ side, outcome, pnlR, resolvedAt }) => ({ side, outcome, pnlR, resolvedAt }));
}

async function hydrateTodayIstResultsFromMongo(): Promise<void> {
  if (!mongoHistory.connected) return;
  try {
    const today = istDayString();
    const istMidnightMs = new Date(`${today}T00:00:00+05:30`).getTime();
    const todaysFromDb = await mongoHistory.getLiveTradesSince(istMidnightMs);

    todayIstResolvedResults.length = 0;
    for (const t of todaysFromDb) {
      todayIstResolvedResults.push({
        istDay: today,
        side: t.side,
        outcome: t.outcome,
        pnlR: t.pnlR,
        resolvedAt: t.resolvedAt ?? Date.now()
      });
    }
    if (todayIstResolvedResults.length > 0) {
      const netR = todayIstResolvedResults.reduce((s, r) => s + r.pnlR, 0);
      console.log(`[Startup Risk Guard] Loaded ${todayIstResolvedResults.length} resolved trades for today (${today} IST) | Net PnL: ${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R`);
    }
  } catch (err) {
    console.warn('[Startup Risk Guard] Could not hydrate today IST trades:', err instanceof Error ? err.message : err);
  }
}

function isMissingProviderError(message: string): boolean {
  return /no (ai|groq) (provider|key)/i.test(message) || message.includes('not configured');
}

function rememberLesson(lesson: string): void {
  const clean = lesson.trim();
  if (!clean || liveLearnedLessons.some((existing) => existing.toLowerCase() === clean.toLowerCase())) return;
  liveLearnedLessons.push(clean);
  if (liveLearnedLessons.length > 40) liveLearnedLessons.splice(0, liveLearnedLessons.length - 40);
}

const DAILY_RANGE_TTL_MS = 30 * 60_000;
const dailyRangeCache = new Map<string, { fetchedAt: number; ranges: Array<{ day: number; high: number; low: number }> }>();

async function getDailyRanges(symbol: string): Promise<Array<{ day: number; high: number; low: number }>> {
  const cached = dailyRangeCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < DAILY_RANGE_TTL_MS) return cached.ranges;
  try {
    if ((FOREX_SYMBOLS as readonly string[]).includes(symbol)) {
      const fxDaily = await DerivForexClient.fetchHistoricalCandles({ symbol, timeframe: '1d', count: 10 });
      const ranges = fxDaily.map((c) => ({ day: c.time, high: c.high, low: c.low })).sort((a, b) => a.day - b.day);
      dailyRangeCache.set(symbol, { fetchedAt: ranges.length ? Date.now() : Date.now() - DAILY_RANGE_TTL_MS + 60_000, ranges });
      return ranges;
    }
    const now = Date.now();
    const result = await restService.fetchHistoricalCandles({ symbol, timeframe: '1d', startTimeMs: now - 10 * 86_400_000, endTimeMs: now });
    const ranges = result.candles
      .filter((c) => Number.isFinite(c.high) && Number.isFinite(c.low))
      .map((c) => ({ day: c.time, high: c.high, low: c.low }))
      .sort((a, b) => a.day - b.day);
    dailyRangeCache.set(symbol, { fetchedAt: ranges.length ? now : now - DAILY_RANGE_TTL_MS + 60_000, ranges });
    return ranges;
  } catch (error) {
    console.warn(`[Daily Ranges] Could not load 1d candles for ${symbol}:`, error instanceof Error ? error.message : error);
    dailyRangeCache.set(symbol, { fetchedAt: Date.now() - DAILY_RANGE_TTL_MS + 60_000, ranges: cached?.ranges ?? [] });
    return cached?.ranges ?? [];
  }
}

const MACRO_TREND_TTL_MS = 5 * 60_000;
const macroTrendCache = new Map<string, {
  fetchedAt: number;
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  candles1h: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  candles15m: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  candles5m: Array<{ time: number; open: number; high: number; low: number; close: number }>;
}>();

function classifyMacroCandles(candles: Array<{ open: number; high: number; low: number; close: number }>): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (candles.length < 20) return 'NEUTRAL';
  const closes = candles.map((c) => c.close);
  const k = 2 / 21;
  let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) {
    ema20 = closes[i] * k + ema20 * (1 - k);
  }
  const last = candles[candles.length - 1];
  const bar3Ago = candles[candles.length - 4];
  const bar6Ago = candles[candles.length - 7];

  if (last.close > ema20 && last.close > bar3Ago.close && last.close > bar6Ago.close) return 'BULLISH';
  if (last.close < ema20 && last.close < bar3Ago.close && last.close < bar6Ago.close) return 'BEARISH';
  return 'NEUTRAL';
}

async function getMacroTrends(symbol: string) {
  const cached = macroTrendCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < MACRO_TREND_TTL_MS) {
    return cached;
  }
  try {
    if ((FOREX_SYMBOLS as readonly string[]).includes(symbol)) {
      const [c5m, c15m, c1h, c4h] = await Promise.all([
        DerivForexClient.fetchHistoricalCandles({ symbol, timeframe: '5m', count: 100 }),
        DerivForexClient.fetchHistoricalCandles({ symbol, timeframe: '15m', count: 96 }),
        DerivForexClient.fetchHistoricalCandles({ symbol, timeframe: '1h', count: 72 }),
        DerivForexClient.fetchHistoricalCandles({ symbol, timeframe: '4h', count: 40 })
      ]);
      const entry = {
        fetchedAt: Date.now(),
        trend1h: classifyMacroCandles(c1h),
        trend4h: classifyMacroCandles(c4h),
        candles1h: c1h.slice(-72),
        candles15m: c15m.slice(-96),
        candles5m: c5m.slice(-100)
      };
      macroTrendCache.set(symbol, entry);
      return entry;
    }
    const now = Date.now();
    const [res5m, res15m, res1h, res4h] = await Promise.all([
      restService.fetchHistoricalCandles({ symbol, timeframe: '5m', startTimeMs: now - 9 * 3600_000, endTimeMs: now }),
      restService.fetchHistoricalCandles({ symbol, timeframe: '15m', startTimeMs: now - 24 * 3600_000, endTimeMs: now }),
      restService.fetchHistoricalCandles({ symbol, timeframe: '1h', startTimeMs: now - 72 * 3600_000, endTimeMs: now }),
      restService.fetchHistoricalCandles({ symbol, timeframe: '4h', startTimeMs: now - 5 * 86_400_000, endTimeMs: now })
    ]);
    const trend1h = classifyMacroCandles(res1h.candles);
    const trend4h = classifyMacroCandles(res4h.candles);
    const entry = {
      fetchedAt: now,
      trend1h,
      trend4h,
      candles1h: res1h.candles.slice(-72),
      candles15m: res15m.candles.slice(-96),
      candles5m: res5m.candles.slice(-100)
    };
    macroTrendCache.set(symbol, entry);
    return entry;
  } catch {
    return cached ?? { fetchedAt: 0, trend1h: 'NEUTRAL' as const, trend4h: 'NEUTRAL' as const, candles1h: [], candles15m: [], candles5m: [] };
  }
}

// Per-symbol concurrency lock with overall API concurrency cap (prevents BTC from blocking ETH/SOL)
const councilInFlightSymbols = new Set<string>();
const MAX_CONCURRENT_COUNCILS = 2;

let isAutoTradingEnabled = true;
let lastQuotaAlertTime = 0;
let lastMissingConfigLogAt = 0;
let lastStaleFeedLogAt = 0;

const sessionPerformance = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  netR: 0
};

async function handleQuotaExhaustedAlert(errorMsg: string): Promise<void> {
  const now = Date.now();
  if (now - lastQuotaAlertTime < 5 * 60_000) return;
  lastQuotaAlertTime = now;
  isAutoTradingEnabled = false;

  const alertText = `⚠️ <b>FLOWTERMINAL ALERT: API QUOTA EXHAUSTED</b>
━━━━━━━━━━━━━━━━━━━━
🚨 <b>Status:</b> Groq / AI Provider rate limit reached!
🔍 <b>Error:</b> <code>${errorMsg.slice(0, 160)}</code>

⏸️ <b>Auto Trader ko temporarly PAUSE kar diya gaya hai.</b>
👉 Groq keys verify karein, fir UI se "RESUME AUTO" daba kar dubara chalu karein.
━━━━━━━━━━━━━━━━━━━━`;

  await sendTelegramMessage(alertText);
}

// Create HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(req.url || '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request URL' }));
    return;
  }
  const parsed = {
    pathname: requestUrl.pathname,
    query: Object.fromEntries(requestUrl.searchParams.entries()) as Record<string, string>
  };

  if (req.method === 'GET' && parsed.pathname === '/audit-report') {
    const logs = mongoHistory.connected ? await mongoHistory.getSystemAuditLogs(100) : [];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAuditDashboardHtml(logs));
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/agents/run-audit') {
    try {
      const result = await runNightlyAuditCycle(mongoHistory, { forceAllRecent: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Audit failed' }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/agents/auto-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ autoTrading: isAutoTradingEnabled }));
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/health') {
    const feedAgeSec = lastTradeReceivedAt ? Math.round((Date.now() - lastTradeReceivedAt) / 1000) : null;
    const isHealthy = currentMarketStatus === 'LIVE' && feedAgeSec !== null && feedAgeSec < 30;
    const perSymbolAgeSec = Object.fromEntries(
      SUPPORTED_SYMBOLS.map((sym) => {
        const ts = lastTradeAtBySymbol.get(sym);
        return [sym, ts ? Math.round((Date.now() - ts) / 1000) : null];
      })
    );
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'OK' : 'DEGRADED',
      marketStatus: currentMarketStatus,
      feedAgeSec,
      perSymbolAgeSec,
      autoTrading: isAutoTradingEnabled,
      activeTrades: liveActiveTrades.size,
      todayResolvedCount: getTodayIstResults().length,
      uptimeMin: Math.round(process.uptime() / 60)
    }));
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/agents/toggle-auto') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body || '{}') as { active?: boolean };
      if (typeof data.active === 'boolean') {
        isAutoTradingEnabled = data.active;
      } else {
        isAutoTradingEnabled = !isAutoTradingEnabled;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ autoTrading: isAutoTradingEnabled }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload' }));
    }
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/agents/analyze') {
    const origin = req.headers.origin;
    const forwardedProtocol = req.headers['x-forwarded-proto'];
    const requestProtocol = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)?.split(',')[0] ?? 'http';
    const requestHost = req.headers.host;
    const sameOrigin = Boolean(requestHost && origin === `${requestProtocol}://${requestHost}`);
    if (origin && !sameOrigin && origin !== 'http://localhost:3000' && origin !== 'http://127.0.0.1:3000' && origin !== 'http://localhost:5173') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent analysis accepts requests only from the local FlowTerminal UI.' }));
      return;
    }
    if (Date.now() - lastCouncilRequestAt < 15_000) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((15_000 - (Date.now() - lastCouncilRequestAt)) / 1000)) });
      res.end(JSON.stringify({ error: 'Please wait a few seconds between manual analysis requests.' }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let byteCount = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.byteLength;
        if (byteCount > 256_000) throw new Error('Agent snapshot is too large.');
        chunks.push(buffer);
      }
      const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AgentSnapshot;
      if (!snapshot || typeof snapshot !== 'object' ||
        !SUPPORTED_SYMBOLS.includes(snapshot.symbol as typeof SUPPORTED_SYMBOLS[number]) ||
        (snapshot.timeframe !== '1m' && snapshot.timeframe !== '5m') ||
        !Array.isArray(snapshot.candles) || snapshot.candles.length > 200 ||
        !Array.isArray(snapshot.footprints) || snapshot.footprints.length > 12 ||
        !Array.isArray(snapshot.trades) || snapshot.trades.length > 50 ||
        !Array.isArray(snapshot.bids) || snapshot.bids.length > 20 ||
        !Array.isArray(snapshot.asks) || snapshot.asks.length > 20 ||
        typeof snapshot.feedStatus !== 'string' ||
        (snapshot.lastTradeAt !== null && !Number.isFinite(snapshot.lastTradeAt))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid market snapshot for the SMC, ICT, and order-flow agents.' }));
        return;
      }
      if ((snapshot.feedStatus !== 'LIVE' && snapshot.feedStatus !== 'DESYNCHRONIZED') ||
        snapshot.lastTradeAt === null || Date.now() - snapshot.lastTradeAt >= 25_000) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Order-flow analysis is paused because the live trade feed is stale.' }));
        return;
      }
      lastCouncilRequestAt = Date.now();
      let paperPerformance: AgentPaperPerformance | null = null;
      if (mongoHistory.connected) {
        try {
          paperPerformance = await mongoHistory.getAgentPaperPerformance(snapshot.symbol, snapshot.timeframe);
          const persistentLessons = await mongoHistory.getLearnedLessons(10);
          snapshot.paperPerformance = {
            ...paperPerformance,
            recent: getTodayIstResults(),
            learnedLessons: [...persistentLessons, ...liveLearnedLessons]
          };
        } catch (error) {
          console.warn('[MongoDB] Could not load prior agent outcomes:', error instanceof Error ? error.message : error);
        }
      }
      const result = await runOrderFlowCouncil(snapshot);
      let paperPlanSaved = false;
      if (mongoHistory.connected) {
        try { paperPlanSaved = await mongoHistory.saveAgentDecision(snapshot, result); }
        catch (error) { console.warn('[MongoDB] Could not save agent paper plan:', error instanceof Error ? error.message : error); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, paperPerformance, paperPlanSaved }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Agent analysis failed.';
      if (message.includes('429') || message.includes('quota') || message.includes('rate limit')) {
        void handleQuotaExhaustedAlert(message);
      }
      const status = message.includes('too large') ? 413 : isMissingProviderError(message) ? 503 : message.includes('quota') ? 429 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const timeframe = parsed.query.timeframe as CandleTimeframe;
    const startTimeMs = parsed.query.start ? Number(parsed.query.start) : undefined;
    const endTimeMs = parsed.query.end ? Number(parsed.query.end) : undefined;

    if (!SUPPORTED_CANDLE_TIMEFRAMES.has(timeframe)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported candle timeframe.' }));
      return;
    }
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number])) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported symbol.' }));
      return;
    }

    try {
      const result = await restService.fetchHistoricalCandles({ symbol, timeframe, startTimeMs, endTimeMs });
      if ((FOREX_SYMBOLS as readonly string[]).includes(symbol)) {
        const candles = await DerivForexClient.fetchHistoricalCandles({ symbol, timeframe, count: 200 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ symbol, timeframe, candles }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      if (err instanceof BybitRestServiceError) {
        res.writeHead(err.status && err.status >= 400 && err.status < 600 ? err.status : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: err.code }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error while fetching history' }));
      }
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/options-gamma') {
    const baseCoin = parsed.query.baseCoin;
    const source = typeof parsed.query.source === 'string' ? parsed.query.source.toLowerCase() : 'binance';
    if (baseCoin !== 'BTC' && baseCoin !== 'ETH') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'baseCoin must be BTC or ETH.' }));
      return;
    }
    if (source !== 'binance' && source !== 'bybit') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'source must be binance or bybit.' }));
      return;
    }
    try {
      const snapshot = source === 'binance'
        ? await binanceOptionsService.fetchSnapshot(baseCoin as OptionBase)
        : await optionsService.fetchSnapshot(baseCoin as OptionBase);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(snapshot));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `Unable to fetch ${source} options market data.`;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/footprint/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const timeframe = parsed.query.timeframe as CandleTimeframe;
    const startTimeMs = parsed.query.start === undefined ? undefined : Number(parsed.query.start);
    const endTimeMs = parsed.query.end === undefined ? undefined : Number(parsed.query.end);
    if ((timeframe !== '1m' && timeframe !== '5m') ||
      !SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
      (startTimeMs !== undefined && (!Number.isSafeInteger(startTimeMs) || startTimeMs <= 0)) ||
      (endTimeMs !== undefined && (!Number.isSafeInteger(endTimeMs) || endTimeMs <= 0)) ||
      (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs >= endTimeMs)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid footprint history timeframe or time range.' }));
      return;
    }
    const bars = await readMongoOrLocal('footprints',
      () => mongoHistory.getFootprints({ symbol, timeframe, startTimeMs, endTimeMs }),
      () => footprintHistory.getHistory({ symbol, timeframe, startTimeMs, endTimeMs }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ symbol, timeframe, bars }));
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/footprint/replay') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const timeframe = parsed.query.timeframe;
    const hours = parsed.query.hours === undefined ? 48 : Number(parsed.query.hours);
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
      (timeframe !== '1m' && timeframe !== '5m') || !Number.isInteger(hours) || hours < 1 || hours > 48) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Replay accepts a supported symbol, 1m/5m timeframe and a 1–48 hour window.' }));
      return;
    }
    if (!mongoHistory.connected) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MongoDB must be connected to rebuild a replay from retained raw trades.' }));
      return;
    }
    try {
      const endTimeMs = Date.now();
      const startTimeMs = endTimeMs - hours * 60 * 60_000;
      const replay = await mongoHistory.reconstructFootprintsFromTrades({ symbol, timeframe, startTimeMs, endTimeMs, tickSize: resolvedTickSizes[symbol] ?? tickSizes[symbol] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ symbol, timeframe, windowHours: hours, sourceTradeCount: replay.trades, bars: replay.bars }));
    } catch (error) {
      console.warn('[Trade replay] Could not aggregate raw fills:', error);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not rebuild replay bars from MongoDB raw trades.' }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/derivatives') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number])) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported symbol.' }));
      return;
    }
    const cached = liveDerivativesCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached.data));
      return;
    }
    try {
      const [tickerRes, oiRes, fundingRes] = await Promise.allSettled([
        fetchBybitRest(`/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`),
        fetchBybitRest(`/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(symbol)}&intervalTime=5min&limit=200`),
        fetchBybitRest(`/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=200`)
      ]);
      const parseSafe = async (settled: PromiseSettledResult<Response>) => {
        if (settled.status !== 'fulfilled' || !settled.value.ok) return null;
        try {
          const json = await settled.value.json() as { retCode?: number; result?: { list?: any[] } };
          return json.retCode === 0 ? (json.result?.list ?? null) : null;
        } catch {
          return null;
        }
      };
      const [tickerList, oiList, fundingList] = await Promise.all([
        parseSafe(tickerRes),
        parseSafe(oiRes),
        parseSafe(fundingRes)
      ]);
      if (!tickerList && !oiList && !fundingList) {
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached.data));
          return;
        }
        throw new Error('Bybit derivatives endpoints timed out.');
      }
      const data = {
        symbol,
        ticker: tickerList?.[0] ?? cached?.data.ticker ?? null,
        openInterest: oiList ?? cached?.data.openInterest ?? [],
        fundingHistory: fundingList ?? cached?.data.fundingHistory ?? [],
        fetchedAt: Date.now()
      };
      liveDerivativesCache.set(symbol, { expiresAt: Date.now() + 30_000, data });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) {
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cached.data));
        return;
      }
      console.warn('[Derivatives] Bybit request failed:', error instanceof Error ? error.message : error);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not load current Bybit derivatives data.' }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/derivatives/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number])) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported symbol.' }));
      return;
    }
    try {
      const now = Date.now();
      const points = await getThirtyDayOpenInterest(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ symbol, interval: '5min', requestedDays: 30, openInterest: points, fetchedAt: now }));
    } catch (error) {
      console.warn('[Derivatives] Historical OI request failed:', error);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not load 30-day Bybit open-interest history.' }));
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/orderbook/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const startTimeMs = parsed.query.start === undefined ? undefined : Number(parsed.query.start);
    const endTimeMs = parsed.query.end === undefined ? undefined : Number(parsed.query.end);
    const limit = parsed.query.limit === undefined ? 3000 : Number(parsed.query.limit);
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
      (startTimeMs !== undefined && (!Number.isSafeInteger(startTimeMs) || startTimeMs <= 0)) ||
      (endTimeMs !== undefined && (!Number.isSafeInteger(endTimeMs) || endTimeMs <= 0)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 10_000 ||
      (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs >= endTimeMs)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid order-book history request.' }));
      return;
    }
    const samples = await readMongoOrLocal('order-book samples',
      () => mongoHistory.getOrderBooks({ symbol, startTimeMs, endTimeMs, limit }),
      () => orderBookHistory.getHistory({ symbol, startTimeMs, endTimeMs, limit }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ symbol, status: orderBookHistory.getStatus(), samples }));
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/trades/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const startTimeMs = parsed.query.start === undefined ? undefined : Number(parsed.query.start);
    const endTimeMs = parsed.query.end === undefined ? undefined : Number(parsed.query.end);
    const limit = parsed.query.limit === undefined ? 5000 : Number(parsed.query.limit);
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
      (startTimeMs !== undefined && (!Number.isSafeInteger(startTimeMs) || startTimeMs <= 0)) ||
      (endTimeMs !== undefined && (!Number.isSafeInteger(endTimeMs) || endTimeMs <= 0)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 20_000 ||
      (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs >= endTimeMs)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid recorded-trade history request.' }));
      return;
    }
    const samples = await readMongoOrLocal('trades',
      () => mongoHistory.getTrades({ symbol, startTimeMs, endTimeMs, limit }),
      () => tradeHistory.getHistory({ symbol, startTimeMs, endTimeMs, limit }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ symbol, samples }));
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/liquidations/history') {
    const symbol = (typeof parsed.query.symbol === 'string' ? parsed.query.symbol : DEFAULT_SYMBOL).toUpperCase();
    const endTimeMs = parsed.query.end === undefined ? Date.now() : Number(parsed.query.end);
    const startTimeMs = parsed.query.start === undefined ? endTimeMs - 60 * 60_000 : Number(parsed.query.start);
    const limit = parsed.query.limit === undefined ? 1000 : Number(parsed.query.limit);
    if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
      !Number.isSafeInteger(startTimeMs) || startTimeMs <= 0 || !Number.isSafeInteger(endTimeMs) || endTimeMs <= startTimeMs ||
      !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid liquidation history request.' }));
      return;
    }
    const events = await readMongoOrLocal('liquidations',
      () => mongoHistory.getLiquidations({ symbol, startTimeMs, endTimeMs, limit }),
      () => liquidationHistory.getHistory(symbol, startTimeMs, endTimeMs, limit));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ symbol, events }));
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/recorder/status') {
    const mongoCounts = await readMongoOrLocal('recorder counts',
      () => mongoHistory.getCounts(), () => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const memory = process.memoryUsage();
    res.end(JSON.stringify({
      marketStatus: currentMarketStatus,
      lastTradeReceivedAt,
      bybit: bybitClient.getDiagnostics(),
      memory: { heapUsedMb: Math.round(memory.heapUsed / 1_048_576), rssMb: Math.round(memory.rss / 1_048_576) },
      mongoWriteQueue: {
        pending: mongoWriteQueue.length, active: activeMongoWrites, maxPending: MAX_PENDING_MONGO_WRITES,
        bufferedTrades: bufferedMongoTrades.length,
        dropped: { ...droppedMongoWrites }
      },
      retention: { footprintsDays: 7, otherRecordedDataHours: 48 },
      trades: tradeHistory.getStatus(), orderBook: orderBookHistory.getStatus(), footprints: footprintHistory.getStatus(),
      storage: { provider: mongoHistory.connected ? 'mongodb' : 'local', mongoCounts }
    }));
    return;
  }

  // Serve Frontend UI in Production (if built)
  if ((req.method === 'GET' || req.method === 'HEAD') && !parsed.pathname?.startsWith('/api/')) {
    const frontendDirectory = [
      resolve(process.cwd(), 'frontend', 'dist'),
      resolve(process.cwd(), '..', 'frontend', 'dist')
    ].find((directory) => existsSync(resolve(directory, 'index.html')));
    if (frontendDirectory) {
      const indexFile = resolve(frontendDirectory, 'index.html');
      let requestedPath = '/';
      try { requestedPath = decodeURIComponent(parsed.pathname || '/'); } catch { /* ignore */ }
      const candidate = resolve(frontendDirectory, `.${requestedPath}`);
      const isInsideFrontend = candidate.startsWith(`${frontendDirectory}${sep}`) || candidate === indexFile;
      const requestedFile = isInsideFrontend && existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexFile;
      const contentTypes: Record<string, string> = {
        '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
        '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff',
        '.woff2': 'font/woff2'
      };
      res.writeHead(200, { 'Content-Type': contentTypes[extname(requestedFile)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(requestedFile));
      return;
    }

    // Headless Cloud Mode Root Status
    if (parsed.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
        engine: 'FlowTerminal Headless Paper-Trading & Signal Engine',
        status: currentMarketStatus,
        autoTrading: isAutoTradingEnabled,
        activeTrades: liveActiveTrades.size,
        todayResolvedCount: getTodayIstResults().length,
        auditDashboard: '/audit-report'
      }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Bind WebSocket Server to HTTP server
const wss = new WebSocketServer({ server });
const selectedSymbolByClient = new WeakMap<WebSocket, string>();
const gatewayPort = Number(process.env.PORT) || LOCAL_GATEWAY_PORT;
console.log(`[FlowTerminal Engine] HTTP & WebSocket Gateway listening on port ${gatewayPort}`);

function messageSymbol(msg: GatewayMessage): string | null {
  const topLevelSymbol = (msg as { symbol?: unknown }).symbol;
  if (typeof topLevelSymbol === 'string') return topLevelSymbol;
  const data = (msg as { data?: unknown }).data;
  if (data && !Array.isArray(data) && typeof data === 'object' && 'symbol' in data && typeof (data as {symbol?: unknown}).symbol === 'string') {
    return (data as { symbol: string }).symbol;
  }
  if (Array.isArray(data) && data.length > 0) {
    const symbols = [...new Set(data.map((item) => (item as {symbol?: unknown})?.symbol).filter((symbol): symbol is string => typeof symbol === 'string'))];
    return symbols.length === 1 ? symbols[0] : null;
  }
  return null;
}

export function broadcast(msg: GatewayMessage): void {
  const payload = JSON.stringify(msg);
  const symbol = messageSymbol(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && (!symbol || (selectedSymbolByClient.get(client) ?? DEFAULT_SYMBOL) === symbol)) {
      client.send(payload);
    }
  }
}

const dirtyFootprintAggregators = new Set<OrderFlowAggregator>();
let footprintFlushTimer: NodeJS.Timeout | null = null;
function queueFormingFootprint(aggregator: OrderFlowAggregator): void {
  dirtyFootprintAggregators.add(aggregator);
  if (footprintFlushTimer) return;
  footprintFlushTimer = setTimeout(() => {
    footprintFlushTimer = null;
    for (const dirty of dirtyFootprintAggregators) {
      const bar = dirty.getCurrentBar();
      if (bar) broadcast({ type: 'FOOTPRINT_BAR', timeframe: bar.timeframe, data: dirty.serializeBar(bar), timestamp: Date.now() });
    }
    dirtyFootprintAggregators.clear();
  }, 75);
}

let lastDisconnectAlertAt = 0;
let wasDisconnectedAlertSent = false;

export function updateMarketStatus(status: ConnectionStatus, message?: string, affectedSymbol?: string): void {
  if (!affectedSymbol) {
    currentMarketStatus = status;
    if (status === 'DISCONNECTED' || status === 'RECONNECTING') {
      if (!wasDisconnectedAlertSent && Date.now() - lastDisconnectAlertAt > 3 * 60_000) {
        lastDisconnectAlertAt = Date.now();
        wasDisconnectedAlertSent = true;
        void sendTelegramMessage(
          `⚠️ <b>FLOWTERMINAL FEED DISCONNECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Status:</b> ${status}\n🔍 <b>Details:</b> ${message || 'Bybit WebSocket dropped'}\n⏳ Auto-reconnecting...`
        ).catch(() => {});
      }
    } else if (status === 'LIVE' && wasDisconnectedAlertSent) {
      wasDisconnectedAlertSent = false;
      void sendTelegramMessage(
        `✅ <b>FLOWTERMINAL FEED RECONNECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n📡 Live market data & auto-trader back online!`
      ).catch(() => {});
    }
  }
  if (status === 'DISCONNECTED' || status === 'RECONNECTING' || status === 'DESYNCHRONIZED') {
    if (affectedSymbol) marketPipelines.get(affectedSymbol)?.orderBook.reset();
    else for (const pipeline of marketPipelines.values()) pipeline.orderBook.reset();
  }
  const statusMsg: StatusGatewayMessage = {
    type: 'STATUS',
    status: affectedSymbol ? status : currentMarketStatus,
    timestamp: Date.now(),
    message,
    symbol: affectedSymbol
  };
  broadcast(statusMsg);
}

// --- MULTI-COIN LIVE BAR PROCESSING & LEARNING (STRICTLY PAPER + TELEGRAM) ---
async function handleLiveBarAutonomousTrading(symbol: string, bar: SerializedFootprintBar): Promise<void> {
  if (!isAutoTradingEnabled) {
    return;
  }

  // --- PER-SYMBOL FEED & ORDERBOOK SAFETY GUARD ---
  const symbolStatus = marketStatusBySymbol.get(symbol) ?? currentMarketStatus;
  const symbolLastTradeAt = lastTradeAtBySymbol.get(symbol) ?? null;
  const isSymbolFeedFresh = symbolStatus === 'LIVE' &&
                            symbolLastTradeAt !== null &&
                            (Date.now() - symbolLastTradeAt < 25_000);

  if (!isSymbolFeedFresh) {
    const now = Date.now();
    if (now - lastStaleFeedLogAt > 60_000) {
      lastStaleFeedLogAt = now;
      console.log(`[Auto-Trader] Feed stale/disconnected for ${symbol} (${currentMarketStatus}). Skipping AI calls to protect API quota.`);
    }
    return;
  }

  const pipeline = marketPipelines.get(symbol);
  if (!pipeline) return;

  const isCrypto = (CRYPTO_SYMBOLS as readonly string[]).includes(symbol);
  const bookStatus = pipeline.orderBook.getStatus();
  const isOrderBookSafe = !isCrypto || bookStatus.isSynchronized;

  // 1. Smart Active Trade Management (0 API calls: Breakeven at 1.2R + Runner Protection + Confirmed Reversal Exit)
  const currentTrade = liveActiveTrades.get(symbol);
  if (currentTrade) {
    currentTrade.barsHeld += 1;
    let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
    let exitKind: 'TARGET' | 'STOP' | 'EARLY_EXIT' | 'SCRATCH_EXIT' | 'TIMEOUT' | null = null;
    let exitPrice = bar.close;

    const initialRisk = currentTrade.initialRisk;
    const isLong = currentTrade.decision === 'LONG';
    const currentR = isLong
      ? (bar.close - currentTrade.entryPrice) / initialRisk
      : (currentTrade.entryPrice - bar.close) / initialRisk;
    const peakR = isLong
      ? (bar.high - currentTrade.entryPrice) / initialRisk
      : (currentTrade.entryPrice - bar.low) / initialRisk;

    const beLocked = isLong
      ? currentTrade.stopPrice >= currentTrade.entryPrice + initialRisk * 0.10
      : currentTrade.stopPrice <= currentTrade.entryPrice - initialRisk * 0.10;

    if (isLong) {
      if (currentTrade.targetR >= 2.2 && peakR >= 2.1 && currentTrade.stopPrice < currentTrade.entryPrice + initialRisk * 1.0) {
        currentTrade.stopPrice = currentTrade.entryPrice + initialRisk * 1.0;
        console.log(`[Trailing SL] [${currentTrade.tradeId}] ${symbol} hit 2.1R -> SL moved up to +1.0R ($${currentTrade.stopPrice.toFixed(4)})`);
      } else if (peakR >= 1.2 && !beLocked) {
        currentTrade.stopPrice = currentTrade.entryPrice + initialRisk * 0.15;
        console.log(`[Trailing SL] [${currentTrade.tradeId}] ${symbol} hit 1.2R -> SL moved to Breakeven +0.15R ($${currentTrade.stopPrice.toFixed(4)})`);
      }

      if (bar.low <= currentTrade.stopPrice) {
        exitPrice = currentTrade.stopPrice;
        const lockedR = (exitPrice - currentTrade.entryPrice) / initialRisk;
        outcome = lockedR > 0.05 ? 'WIN' : 'LOSS';
        exitKind = lockedR > 0.05 ? 'EARLY_EXIT' : 'STOP';
      } else if (bar.high >= currentTrade.targetPrice) {
        outcome = 'WIN';
        exitPrice = currentTrade.targetPrice;
        exitKind = 'TARGET';
      }
    } else {
      if (currentTrade.targetR >= 2.2 && peakR >= 2.1 && currentTrade.stopPrice > currentTrade.entryPrice - initialRisk * 1.0) {
        currentTrade.stopPrice = currentTrade.entryPrice - initialRisk * 1.0;
        console.log(`[Trailing SL] [${currentTrade.tradeId}] ${symbol} hit 2.1R -> SL moved down to +1.0R ($${currentTrade.stopPrice.toFixed(4)})`);
      } else if (peakR >= 1.2 && !beLocked) {
        currentTrade.stopPrice = currentTrade.entryPrice - initialRisk * 0.15;
        console.log(`[Trailing SL] [${currentTrade.tradeId}] ${symbol} hit 1.2R -> SL moved to Breakeven +0.15R ($${currentTrade.stopPrice.toFixed(4)})`);
      }

      if (bar.high >= currentTrade.stopPrice) {
        exitPrice = currentTrade.stopPrice;
        const lockedR = (currentTrade.entryPrice - exitPrice) / initialRisk;
        outcome = lockedR > 0.05 ? 'WIN' : 'LOSS';
        exitKind = lockedR > 0.05 ? 'EARLY_EXIT' : 'STOP';
      } else if (bar.low <= currentTrade.targetPrice) {
        outcome = 'WIN';
        exitPrice = currentTrade.targetPrice;
        exitKind = 'TARGET';
      }
    }

    // Confirmed Reversal Guard (ONLY after 1.1R+ profit so normal pullbacks never get cut prematurely)
    if (outcome === 'OPEN' && currentR >= 1.1) {
      const recent4 = pipeline.footprints['1m'].getRecentBars(4);
      if (recent4.length === 4) {
        const prev3 = recent4.slice(0, 3);
        const avgVol4 = recent4.reduce((s, b) => s + b.totalVolume, 0) / 4;
        const brokeDown = isLong && bar.close < Math.min(...prev3.map((b) => b.low)) && bar.delta < -avgVol4 * 0.30;
        const brokeUp = !isLong && bar.close > Math.max(...prev3.map((b) => b.high)) && bar.delta > avgVol4 * 0.30;
        if (brokeDown || brokeUp) {
          outcome = 'WIN';
          exitPrice = bar.close;
          exitKind = 'EARLY_EXIT';
          console.log(`[Reversal Guard] [${currentTrade.tradeId}] ${symbol} structure broke after +1.1R -> Locking profit @ $${exitPrice}`);
        }
      }
    }

    // Never cut winning runners early: let profitable trades (beLocked or currentR > 0.15R) run up to 180m; close flat/losing trades after 75m
    const isProfitableRunner = beLocked || currentR > 0.15;
    const maxAllowedBars = isProfitableRunner ? 180 : 75;
    const isStagnantTimeout = currentTrade.barsHeld >= maxAllowedBars;

    if (outcome !== 'OPEN' || isStagnantTimeout) {
      const diff = isLong ? exitPrice - currentTrade.entryPrice : currentTrade.entryPrice - exitPrice;
      const rawR = diff / initialRisk;
      const feeSlippageR = 0.05; // Realistic round-trip maker/taker fee + spread slippage deduction
      const pnlR = Number((rawR - feeSlippageR).toFixed(2));
      const resolvedOutcome: 'WIN' | 'LOSS' = outcome !== 'OPEN' ? outcome : (pnlR > 0.15 ? 'WIN' : 'LOSS');
      const finalExitKind = exitKind ?? 'TIMEOUT';

      const finishedTrade = { ...currentTrade };
      liveActiveTrades.delete(symbol);

      const resolvedIst = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
      if (resolvedOutcome === 'LOSS' && finalExitKind === 'STOP') {
        symbolCooldownUntil.set(symbol, Date.now() + 10 * 60_000);
        lastSlDirectionBySymbol.set(symbol, { side: finishedTrade.decision, at: Date.now() });
        macroTrendCache.delete(symbol);
      } else if (resolvedOutcome === 'WIN') {
        lastSlDirectionBySymbol.delete(symbol);
      }

      sessionPerformance.totalTrades += 1;
      if (resolvedOutcome === 'WIN') sessionPerformance.wins += 1;
      else sessionPerformance.losses += 1;
      sessionPerformance.netR += pnlR;

      const winRate = sessionPerformance.totalTrades > 0
        ? (sessionPerformance.wins / sessionPerformance.totalTrades) * 100
        : 0;

      console.log(`[${resolvedIst}] [Trade Resolved] [${finishedTrade.tradeId}] ${finishedTrade.decision} on ${symbol} -> ${resolvedOutcome} [${finalExitKind}] (${pnlR > 0 ? '+' : ''}${pnlR}R) @ $${exitPrice}`);

      const resolvedAtMs = Date.now();
      todayIstResolvedResults.push({
        istDay: istDayString(resolvedAtMs),
        side: finishedTrade.decision,
        outcome: resolvedOutcome,
        pnlR,
        resolvedAt: resolvedAtMs
      });

      if (mongoHistory.connected) {
        void mongoHistory.saveLiveTradeJournal({
          tradeId: finishedTrade.tradeId,
          symbol,
          side: finishedTrade.decision,
          entryPrice: finishedTrade.entryPrice,
          stopPrice: finishedTrade.initialStopPrice ?? finishedTrade.stopPrice,
          initialRisk: finishedTrade.initialRisk,
          targetPrice: finishedTrade.targetPrice,
          targetR: finishedTrade.targetR,
          exitPrice,
          outcome: resolvedOutcome,
          exitKind: finalExitKind,
          pnlR,
          barsHeld: finishedTrade.barsHeld,
          enteredAt: finishedTrade.enteredAt,
          resolvedAt: resolvedAtMs,
          macro1hTrend: finishedTrade.macro1hTrend,
          macro4hTrend: finishedTrade.macro4hTrend,
          strategies: finishedTrade.strategies,
          reasons: finishedTrade.reasons,
          summary: finishedTrade.summary,
          audited: false
        });
      }

      const statusNote = finalExitKind === 'TARGET'
        ? 'Target hit! Setup logged for Nightly Audit reinforcement.'
        : finalExitKind === 'EARLY_EXIT'
          ? 'Trailing SL locked profit (+1.0R / +1.5R) hit. Queued for 1:30 AM IST Nightly Audit.'
          : 'Queued for 1:30 AM IST Nightly Audit (checking 1H/4H + 4.5h pre-trade & 1h post-trade context).';

      void sendTradeOutcomeAlert({
        tradeId: finishedTrade.tradeId,
        symbol,
        decision: finishedTrade.decision,
        outcome: resolvedOutcome,
        entryPrice: finishedTrade.entryPrice,
        exitPrice,
        pnlR,
        barsHeld: finishedTrade.barsHeld,
        lessonLearned: statusNote,
        sessionStats: {
          totalTrades: sessionPerformance.totalTrades,
          wins: sessionPerformance.wins,
          losses: sessionPerformance.losses,
          winRate,
          netR: sessionPerformance.netR
        }
      }).catch(() => {});

      return;
    }
  }

  // 2. Evaluate new setup across coins (Per-symbol lock + overall concurrency limit + OrderBook sync gate)
  if (
    !liveActiveTrades.has(symbol) &&
    !councilInFlightSymbols.has(symbol) &&
    councilInFlightSymbols.size < MAX_CONCURRENT_COUNCILS
  ) {
    if (!isOrderBookSafe) {
      return;
    }
    if (Date.now() < (symbolCooldownUntil.get(symbol) ?? 0)) {
      return;
    }

    const recentBars = pipeline.footprints['1m'].getRecentBars(15);
    if (recentBars.length < 12) return;

    const avgVol = recentBars.reduce((s, b) => s + b.totalVolume, 0) / recentBars.length;
    if (bar.totalVolume < avgVol * 0.75) {
      return;
    }

    const lookback = recentBars.slice(-8);
    const isLocalExtreme = bar.high >= Math.max(...lookback.map((b) => b.high)) ||
                           bar.low <= Math.min(...lookback.map((b) => b.low));
    const isSignificantDelta = Math.abs(bar.delta) >= avgVol * 0.22;

    if (!isLocalExtreme && !isSignificantDelta) {
      return;
    }

    councilInFlightSymbols.add(symbol);
    try {
      const candles1m = pipeline.footprints['1m'].getRecentBars(300).map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }));

      let persistentLessons: string[] = [];
      if (mongoHistory.connected) {
        persistentLessons = await mongoHistory.getLearnedLessons(10);
      }
      const [dailyRanges, macroTrends] = await Promise.all([
        getDailyRanges(symbol),
        getMacroTrends(symbol)
      ]);

      const todayResults = getTodayIstResults();
      const snapshot: AgentSnapshot = {
        symbol,
        timeframe: '1m',
        feedStatus: isOrderBookSafe ? symbolStatus : 'DESYNCHRONIZED',
        lastTradeAt: symbolLastTradeAt,
        latestPrice: bar.close,
        profile: {
          poc: bar.pocPrice,
          vah: Math.max(...recentBars.map((b) => b.high)),
          val: Math.min(...recentBars.map((b) => b.low)),
          capturedBars: recentBars.length
        },
        technicalContext: {
          smc: { bias: 'UNAVAILABLE', events: [], zones: [], liquidity: [] },
          ict: {
            po3: [],
            dailyRanges,
            macro1hTrend: macroTrends.trend1h,
            macro4hTrend: macroTrends.trend4h
          }
        },
        candles: candles1m,
        candles5m: macroTrends.candles5m,
        candles15m: macroTrends.candles15m,
        candles1h: macroTrends.candles1h,
        footprints5m: pipeline.footprints['5m'].getRecentBars(20).map((b) => pipeline.footprints['5m'].serializeBar(b)),
        footprints: recentBars.map((b) => pipeline.footprints['1m'].serializeBar(b)),
        trades: tradeHistory.getHistory({ symbol, limit: 150 }),
        bids: pipeline.orderBook.getSortedBids(5),
        asks: pipeline.orderBook.getSortedAsks(5),
        paperPerformance: {
          resolved: sessionPerformance.totalTrades,
          wins: sessionPerformance.wins,
          losses: sessionPerformance.losses,
          expired: 0,
          winRate: sessionPerformance.totalTrades > 0 ? Number(((sessionPerformance.wins / sessionPerformance.totalTrades) * 100).toFixed(1)) : null,
          averageR: sessionPerformance.totalTrades > 0 ? Number((sessionPerformance.netR / sessionPerformance.totalTrades).toFixed(2)) : null,
          recent: todayResults,
          learnedLessons: [...persistentLessons, ...liveLearnedLessons]
        }
      };

      const councilResult = await runOrderFlowCouncil(snapshot);
      const plan = councilResult.plan;
      const checkIst = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
      const activeSignals = councilResult.reports.map((r) => `${r.agentId}:${r.bias}/${r.strength}`).join(' ');
      console.log(`[${checkIst}] [Manager Check] ${symbol} | 15m/5m [${activeSignals}] -> Decision: ${plan.decision} (${plan.summary})`);
      const prevSl = lastSlDirectionBySymbol.get(symbol);
      if (plan.decision !== 'WAIT' && prevSl && prevSl.side === plan.decision && (Date.now() - prevSl.at) < 45 * 60_000) {
        console.log(`[${checkIst}] [Anti-Revenge Block] ${symbol} ${plan.decision} blocked (same direction hit SL ${Math.round((Date.now() - prevSl.at) / 60_000)}m ago).`);
        return;
      }
      if (plan.decision !== 'WAIT') {
        const generatedTradeId = `#${symbol.replace('USDT', '')}-${Date.now().toString().slice(-4)}`;
        const riskInfo = plan.riskAllocation
          ? ` | Size: ${plan.riskAllocation.positionSizeUnits} units ($${plan.riskAllocation.notionalValueUsd} notional, Risk $${plan.riskAllocation.maxRiskUsd})`
          : '';
        console.log(`\n[${checkIst}] 🚨 [A+ PAPER TRADE TRIGGERED]: [${generatedTradeId}] ${plan.decision} ${symbol} @ $${plan.entryPrice} (15m/5m Flow)`);
        console.log(`   SL: $${plan.stopPrice} | TP: $${plan.targetPrice} (${plan.targetR}R)${riskInfo}`);

        const newTrade: LiveActiveTrade = {
          tradeId: generatedTradeId,
          symbol,
          decision: plan.decision,
          entryPrice: plan.entryPrice!,
          stopPrice: plan.stopPrice!,
          initialStopPrice: plan.stopPrice!,
          initialRisk: Math.abs(plan.entryPrice! - plan.stopPrice!) || (plan.entryPrice! * 0.0015),
          targetPrice: plan.targetPrice!,
          targetR: plan.targetR || 2,
          riskAllocation: plan.riskAllocation ?? null,
          macro1hTrend: macroTrends.trend1h,
          macro4hTrend: macroTrends.trend4h,
          reasons: plan.reasons,
          strategies: plan.strategyNames || [],
          summary: plan.summary,
          barsHeld: 0,
          enteredAt: Date.now()
        };

        liveActiveTrades.set(symbol, newTrade);

        void sendTradeEntryAlert({
          tradeId: generatedTradeId,
          symbol,
          decision: plan.decision,
          entryPrice: plan.entryPrice!,
          stopPrice: plan.stopPrice!,
          targetPrice: plan.targetPrice!,
          targetR: plan.targetR || 2,
          reasons: plan.reasons,
          strategies: plan.strategyNames || [],
          summary: `${plan.summary}${riskInfo}`
        }).catch((e) => console.warn('[Telegram Entry Alert Error]:', e instanceof Error ? e.message : e));

        if (mongoHistory.connected) {
          void mongoHistory.saveAgentDecision(snapshot, councilResult).catch((e) => console.warn('[MongoDB Save Error]:', e));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('429') ||
        msg.toLowerCase().includes('quota') ||
        msg.toLowerCase().includes('rate limit') ||
        msg.includes('All Groq keys for')
      ) {
        void handleQuotaExhaustedAlert(msg);
      }
      if (isMissingProviderError(msg)) {
        const now = Date.now();
        if (now - lastMissingConfigLogAt > 60_000) {
          lastMissingConfigLogAt = now;
          console.warn('[Live Council Error]: No Groq provider is configured. Set GROQ_MANAGER_API_KEY in .env (or COUNCIL_MANAGER=off for math-only mode), then restart the backend.');
        }
      } else {
        console.warn('[Live Council Error]:', msg);
      }
    } finally {
      councilInFlightSymbols.delete(symbol);
    }
  }
}

const bybitClient = new BybitWebSocketClient([...CRYPTO_SYMBOLS], {
  onStatusChange: (status: ConnectionStatus, message?: string) => {
    for (const sym of CRYPTO_SYMBOLS) marketStatusBySymbol.set(sym, status);
    updateMarketStatus(status, message);
  },
  onMessage: (topic: string, payload: unknown) => {
    if (topic.startsWith('kline.')) {
      const [, interval, symbol] = topic.split('.');
      const timeframe: CandleTimeframe | null = CANDLE_INTERVALS[interval] ?? null;
      const rows = (payload as { data?: unknown }).data;
      if (!timeframe || !symbol || !Array.isArray(rows)) return;
      for (const row of rows as Array<Record<string, unknown>>) {
        const start = Number(row.start);
        const open = Number(row.open); const high = Number(row.high);
        const low = Number(row.low); const close = Number(row.close); const volume = Number(row.volume);
        if (![start, open, high, low, close, volume].every(Number.isFinite) || start <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
        const candle: NormalizedCandle = {
          symbol, timeframe, time: Math.floor(start / 1000), open, high, low, close, volume,
          tradesCount: 0, buyVolume: 0, sellVolume: 0, delta: 0, isClosed: row.confirm === true
        };
        latestExchangeCandles.set(`${symbol}:${timeframe}`, candle);
        if (candle.isClosed) {
          void mongoHistory.settleAgentDecisions(candle).catch((error: unknown) => {
            console.warn('[MongoDB] Could not settle an agent paper plan:', error instanceof Error ? error.message : error);
          });
        }
        broadcast({ type: 'CANDLE', timeframe, data: candle, timestamp: Number((payload as { ts?: unknown }).ts) || Date.now() });
      }
    } else if (topic.startsWith('tickers.')) {
      const data = (payload as { data?: Record<string, unknown> }).data;
      const symbol = topic.split('.').pop();
      if (!symbol || !SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number])) return;
      // Do NOT update trade freshness from ticker messages — only actual trades refresh trade timestamps
      const previous = liveTickerBySymbol.get(symbol) ?? { lastPrice: null, markPrice: null, indexPrice: null };
      const readPrice = (key: 'lastPrice' | 'markPrice' | 'indexPrice') => {
        const value = Number(data?.[key]);
        return Number.isFinite(value) && value > 0 ? value : previous[key];
      };
      const ticker = { lastPrice: readPrice('lastPrice'), markPrice: readPrice('markPrice'), indexPrice: readPrice('indexPrice') };
      liveTickerBySymbol.set(symbol, ticker);
      broadcast({ type: 'TICKER', data: { symbol, ...ticker }, timestamp: Date.now() });
    } else if (topic.startsWith('publicTrade.')) {
      const trades = parsePublicTradePayload(payload);
      if (trades.length > 0) {
        const nowMs = Date.now();
        lastTradeReceivedAt = nowMs;
        for (const t of trades) {
          lastTradeAtBySymbol.set(t.symbol, nowMs);
        }
        tradeHistory.save(trades);
        queueMongoTrades(trades);

        const tradeMsg: TradeGatewayMessage = {
          type: 'TRADE',
          data: trades,
          timestamp: nowMs
        };
        broadcast(tradeMsg);

        for (const trade of trades) {
          const pipeline = marketPipelines.get(trade.symbol);
          if (!pipeline) continue;
          const prevBarTime1m = pipeline.footprints['1m'].getCurrentBar()?.time;
          const fpBar1m = pipeline.footprints['1m'].processTrade(trade);
          if (fpBar1m) {
            const fpKey1m = `${trade.symbol}:1m`;
            if (prevBarTime1m === undefined && !firstFootprintBarByKey.has(fpKey1m)) firstFootprintBarByKey.set(fpKey1m, fpBar1m.time);

            if (prevBarTime1m !== undefined && fpBar1m.time > prevBarTime1m) {
              const closedBar = pipeline.footprints['1m'].getRecentBars().find((b) => b.time === prevBarTime1m);
              if (closedBar) {
                const serialized = pipeline.footprints['1m'].serializeBar(closedBar);
                if (firstFootprintBarByKey.get(fpKey1m) !== closedBar.time) {
                  footprintHistory.save(serialized);
                  if (process.env.MONGO_PERSIST_1M_FOOTPRINTS === 'true') persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
                }
                broadcast({
                  type: 'FOOTPRINT_BAR',
                  timeframe: '1m',
                  data: serialized,
                  timestamp: Date.now()
                });

                void handleLiveBarAutonomousTrading(trade.symbol, serialized);
              }
            }

            if (prevBarTime1m !== undefined && fpBar1m.time < prevBarTime1m) {
              for (const corrected of pipeline.footprints['1m'].getRecentBars(200).filter((bar) => bar.time >= fpBar1m.time && bar.isClosed)) {
                const serialized = pipeline.footprints['1m'].serializeBar(corrected);
                footprintHistory.save(serialized);
                if (process.env.MONGO_PERSIST_1M_FOOTPRINTS === 'true') persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
                broadcast({ type: 'FOOTPRINT_BAR', timeframe: '1m', data: serialized, timestamp: Date.now() });
              }
            }

            if (prevBarTime1m === undefined || fpBar1m.time >= prevBarTime1m) queueFormingFootprint(pipeline.footprints['1m']);
          }

          // 5-Minute Footprint handling
          const prevBarTime5m = pipeline.footprints['5m'].getCurrentBar()?.time;
          const fpBar5m = pipeline.footprints['5m'].processTrade(trade);
          if (fpBar5m) {
            const fpKey5m = `${trade.symbol}:5m`;
            if (prevBarTime5m === undefined && !firstFootprintBarByKey.has(fpKey5m)) firstFootprintBarByKey.set(fpKey5m, fpBar5m.time);
            if (prevBarTime5m !== undefined && fpBar5m.time > prevBarTime5m) {
              const closedBar = pipeline.footprints['5m'].getRecentBars().find((b) => b.time === prevBarTime5m);
              if (closedBar) {
                const serialized = pipeline.footprints['5m'].serializeBar(closedBar);
                if (firstFootprintBarByKey.get(fpKey5m) !== closedBar.time) {
                  footprintHistory.save(serialized);
                  persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
                }
                broadcast({
                  type: 'FOOTPRINT_BAR',
                  timeframe: '5m',
                  data: serialized,
                  timestamp: Date.now()
                });
              }
            }

            if (prevBarTime5m !== undefined && fpBar5m.time < prevBarTime5m) {
              for (const corrected of pipeline.footprints['5m'].getRecentBars(200).filter((bar) => bar.time >= fpBar5m.time && bar.isClosed)) {
                const serialized = pipeline.footprints['5m'].serializeBar(corrected);
                footprintHistory.save(serialized);
                persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
                broadcast({ type: 'FOOTPRINT_BAR', timeframe: '5m', data: serialized, timestamp: Date.now() });
              }
            }

            if (prevBarTime5m === undefined || fpBar5m.time >= prevBarTime5m) queueFormingFootprint(pipeline.footprints['5m']);
          }
        }
      }
    } else if (topic.startsWith('allLiquidation.')) {
      const data = (payload as { data?: unknown }).data;
      if (!Array.isArray(data)) return;
      const liquidations: NormalizedLiquidation[] = data.flatMap((item: any) => {
        const symbol = typeof item?.s === 'string' ? item.s : '';
        const timestamp = Number(item?.T);
        const price = Number(item?.p);
        const size = Number(item?.v);
        const side = item?.S;
        if (!SUPPORTED_SYMBOLS.includes(symbol as typeof SUPPORTED_SYMBOLS[number]) ||
          !Number.isFinite(timestamp) || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0 ||
          (side !== 'Buy' && side !== 'Sell')) return [];
        return [{ symbol, timestamp, price, size, side }];
      });
      if (liquidations.length) {
        liquidationHistory.save(liquidations);
        persistToMongo('liquidations', () => mongoHistory.saveLiquidations(liquidations));
        broadcast({ type: 'LIQUIDATION', data: liquidations, timestamp: Date.now() });
      }
    } else if (topic.startsWith('orderbook.50.')) {
      const bookData = (payload as { data?: { s?: string } }).data;
      const symbol = bookData?.s ?? topic.split('.').pop();
      const pipeline = symbol ? marketPipelines.get(symbol) : undefined;
      if (!pipeline || !symbol) return;
      const raw = payload as { type?: string };
      if (raw.type === 'snapshot') {
        const ok = pipeline.orderBook.processSnapshot(payload);
        if (ok) {
          const nowMs = Date.now();
          const lastSaved = lastOrderBookPersistAtBySymbol.get(symbol) ?? 0;
          if (nowMs - lastSaved >= ORDERBOOK_MONGO_SAMPLE_MS) {
            lastOrderBookPersistAtBySymbol.set(symbol, nowMs);
            const sample = {
              symbol,
              time: nowMs,
              bids: pipeline.orderBook.getSortedBids(20),
              asks: pipeline.orderBook.getSortedAsks(20)
            };
            if (orderBookHistory.save(sample) && process.env.MONGO_PERSIST_ORDERBOOK === 'true') persistToMongo('order-book sample', () => mongoHistory.saveOrderBook(sample));
          }
          const status = pipeline.orderBook.getStatus();
          broadcast({
            type: 'ORDERBOOK_SNAPSHOT',
            data: {
              symbol,
              bids: pipeline.orderBook.getSortedBids(20),
              asks: pipeline.orderBook.getSortedAsks(20),
              bestBid: status.bestBid,
              bestAsk: status.bestAsk,
              seq: status.lastSeq,
              updateId: status.lastUpdateId
            },
            timestamp: Date.now()
          });
          if (currentMarketStatus === 'LIVE') updateMarketStatus('LIVE', `Orderbook synchronized for ${symbol}`, symbol);
        } else {
          pipeline.orderBook.reset();
          updateMarketStatus('DESYNCHRONIZED', `Orderbook reset for ${symbol}; requesting a fresh snapshot`, symbol);
          bybitClient.resubscribeOrderBook(symbol);
        }
      } else if (raw.type === 'delta') {
        const ok = pipeline.orderBook.processDelta(payload);
        if (ok) {
          const nowMs = Date.now();
          const lastSaved = lastOrderBookPersistAtBySymbol.get(symbol) ?? 0;
          if (nowMs - lastSaved >= ORDERBOOK_MONGO_SAMPLE_MS) {
            lastOrderBookPersistAtBySymbol.set(symbol, nowMs);
            const sample = {
              symbol,
              time: nowMs,
              bids: pipeline.orderBook.getSortedBids(20),
              asks: pipeline.orderBook.getSortedAsks(20)
            };
            if (orderBookHistory.save(sample) && process.env.MONGO_PERSIST_ORDERBOOK === 'true') persistToMongo('order-book sample', () => mongoHistory.saveOrderBook(sample));
          }
          const status = pipeline.orderBook.getStatus();
          broadcast({
            type: 'ORDERBOOK_DELTA',
            data: {
              symbol,
              bids: pipeline.orderBook.getSortedBids(20),
              asks: pipeline.orderBook.getSortedAsks(20),
              bestBid: status.bestBid,
              bestAsk: status.bestAsk,
              seq: status.lastSeq,
              updateId: status.lastUpdateId
            },
            timestamp: Date.now()
          });
        } else {
          pipeline.orderBook.reset();
          updateMarketStatus('DESYNCHRONIZED', `Orderbook reset for ${symbol}; requesting a fresh snapshot`, symbol);
          bybitClient.resubscribeOrderBook(symbol);
        }
      }
    }
  }
});

const derivForexClient = new DerivForexClient(FOREX_SYMBOLS, {
  onStatusChange: (status: ConnectionStatus, message?: string) => {
    for (const sym of FOREX_SYMBOLS) marketStatusBySymbol.set(sym, status);
    if (currentMarketStatus !== 'LIVE') updateMarketStatus(status, message);
  },
  onTrades: (trades: NormalizedTrade[]) => {
    if (!trades.length) return;
    const nowMs = Date.now();
    lastTradeReceivedAt = nowMs;
    for (const t of trades) {
      lastTradeAtBySymbol.set(t.symbol, nowMs);
    }
    tradeHistory.save(trades);
    queueMongoTrades(trades);
    broadcast({ type: 'TRADE', data: trades, timestamp: nowMs });

    for (const trade of trades) {
      liveTickerBySymbol.set(trade.symbol, { lastPrice: trade.price, markPrice: trade.price, indexPrice: trade.price });
      const pipeline = marketPipelines.get(trade.symbol);
      if (!pipeline) continue;

      const prevBarTime1m = pipeline.footprints['1m'].getCurrentBar()?.time;
      const fpBar1m = pipeline.footprints['1m'].processTrade(trade);
      if (fpBar1m) {
        const fpKey1m = `${trade.symbol}:1m`;
        if (prevBarTime1m === undefined && !firstFootprintBarByKey.has(fpKey1m)) firstFootprintBarByKey.set(fpKey1m, fpBar1m.time);
        if (prevBarTime1m !== undefined && fpBar1m.time > prevBarTime1m) {
          const closedBar = pipeline.footprints['1m'].getRecentBars().find((b) => b.time === prevBarTime1m);
          if (closedBar) {
            const serialized = pipeline.footprints['1m'].serializeBar(closedBar);
            if (firstFootprintBarByKey.get(fpKey1m) !== closedBar.time) {
              footprintHistory.save(serialized);
              if (process.env.MONGO_PERSIST_1M_FOOTPRINTS === 'true') persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
            }
            broadcast({ type: 'FOOTPRINT_BAR', timeframe: '1m', data: serialized, timestamp: Date.now() });
            void handleLiveBarAutonomousTrading(trade.symbol, serialized);
          }
        }
        if (prevBarTime1m === undefined || fpBar1m.time >= prevBarTime1m) queueFormingFootprint(pipeline.footprints['1m']);
      }

      const prevBarTime5m = pipeline.footprints['5m'].getCurrentBar()?.time;
      const fpBar5m = pipeline.footprints['5m'].processTrade(trade);
      if (fpBar5m) {
        const fpKey5m = `${trade.symbol}:5m`;
        if (prevBarTime5m === undefined && !firstFootprintBarByKey.has(fpKey5m)) firstFootprintBarByKey.set(fpKey5m, fpBar5m.time);
        if (prevBarTime5m !== undefined && fpBar5m.time > prevBarTime5m) {
          const closedBar = pipeline.footprints['5m'].getRecentBars().find((b) => b.time === prevBarTime5m);
          if (closedBar) {
            const serialized = pipeline.footprints['5m'].serializeBar(closedBar);
            if (firstFootprintBarByKey.get(fpKey5m) !== closedBar.time) {
              footprintHistory.save(serialized);
              persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
            }
            broadcast({ type: 'FOOTPRINT_BAR', timeframe: '5m', data: serialized, timestamp: Date.now() });
          }
        }
        if (prevBarTime5m === undefined || fpBar5m.time >= prevBarTime5m) queueFormingFootprint(pipeline.footprints['5m']);
      }
    }
  }
});

void restService.fetchTickSizes([...CRYPTO_SYMBOLS]).then((exchangeTickSizes) => {
  resolvedTickSizes = { ...resolvedTickSizes, ...exchangeTickSizes };
  for (const [symbol, tickSize] of Object.entries(exchangeTickSizes)) {
    const pipeline = marketPipelines.get(symbol);
    if (!pipeline) continue;
    pipeline.footprints = {
      '1m': new OrderFlowAggregator({ timeframe: '1m', tickSize }),
      '5m': new OrderFlowAggregator({ timeframe: '5m', tickSize })
    };
  }
  console.log(`[FlowTerminal] Loaded exchange tick sizes for ${Object.keys(exchangeTickSizes).length}/${SUPPORTED_SYMBOLS.length} markets`);
}).catch((error: unknown) => {
  console.warn('[FlowTerminal] Could not load instrument tick sizes; using configured fallback sizes.', error);
}).finally(() => {
  void mongoHistory.connect()
    .then(async () => {
      await hydrateTodayIstResultsFromMongo();
      for (const symbol of SUPPORTED_SYMBOLS) {
        try {
          const recentDbTrades = await mongoHistory.getTrades({ symbol, limit: 50 });
          if (recentDbTrades.length > 0) {
            tradeHistory.save(recentDbTrades);
            console.log(`[Startup Tape] Preloaded ${recentDbTrades.length} trades for ${symbol} from local MongoDB.`);
          }
        } catch {
          // ignore if collection warming up
        }
      }
    })
    .catch((error: unknown) => console.error('[MongoDB] Connection failed; local recording remains active:', error))
    .finally(() => {
      bybitClient.connect();
      derivForexClient.connect();
    });
});

wss.on('connection', (ws: WebSocket) => {
  selectedSymbolByClient.set(ws, DEFAULT_SYMBOL);
  ws.send(JSON.stringify({
    type: 'STATUS',
    status: currentMarketStatus,
    timestamp: Date.now(),
    message: 'Connected to local FlowTerminal gateway'
  } as StatusGatewayMessage));

  const sendSymbolState = (symbol: string) => {
    const pipeline = marketPipelines.get(symbol);
    if (!pipeline) return;
    const bookStatus = pipeline.orderBook.getStatus();
    if (bookStatus.isSynchronized) {
      ws.send(JSON.stringify({
        type: 'ORDERBOOK_SNAPSHOT',
        data: { symbol, bids: pipeline.orderBook.getSortedBids(20), asks: pipeline.orderBook.getSortedAsks(20),
          bestBid: bookStatus.bestBid, bestAsk: bookStatus.bestAsk, seq: bookStatus.lastSeq, updateId: bookStatus.lastUpdateId },
        timestamp: Date.now()
      } as OrderBookSnapshotGatewayMessage));
    }
    for (const timeframe of ['1m', '5m'] as const) {
      const candle = latestExchangeCandles.get(`${symbol}:${timeframe}`);
      if (candle) ws.send(JSON.stringify({ type: 'CANDLE', timeframe, data: candle, timestamp: Date.now() } as CandleGatewayMessage));
      const aggregator = pipeline.footprints[timeframe];
      const footprint = aggregator?.getCurrentBar();
      if (footprint) ws.send(JSON.stringify({ type: 'FOOTPRINT_BAR', timeframe,
        data: aggregator!.serializeBar(footprint), timestamp: Date.now() } as FootprintBarGatewayMessage));
    }
  };
  sendSymbolState(DEFAULT_SYMBOL);
  ws.on('message', (raw) => {
    try {
      const request = JSON.parse(raw.toString()) as { type?: unknown; symbol?: unknown };
      if (request.type !== 'SELECT_SYMBOL' || typeof request.symbol !== 'string' || !SUPPORTED_SYMBOLS.includes(request.symbol as typeof SUPPORTED_SYMBOLS[number])) return;
      selectedSymbolByClient.set(ws, request.symbol);
      sendSymbolState(request.symbol);
    } catch { /* Ignore malformed client messages */ }
  });

  ws.on('error', (err: Error) => {
    console.error('[FlowTerminal Gateway] Client socket error:', err.message);
  });
});

wss.on('error', (err: Error) => {
  console.error('[FlowTerminal Gateway] Server error:', err.message);
});

let isShuttingDown = false;
function gracefulShutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[FlowTerminal Gateway] Initiating graceful shutdown...');
  bybitClient.disconnect();
  derivForexClient.disconnect();
  flushBufferedMongoTrades();
  updateMarketStatus('DISCONNECTED', 'Gateway shutting down');

  for (const client of wss.clients) {
    client.close();
  }

  wss.close(() => {
    server.close(() => {
      void waitForMongoWrites().finally(() => mongoHistory.close()).finally(() => {
        console.log('[FlowTerminal Gateway] HTTP server and gateway closed.');
        process.exit(0);
      });
    });
  });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

server.listen(gatewayPort, '0.0.0.0');

// --- ROLLING 1-2 HOUR POST-TRADE AUDIT SCHEDULER (Checks every 15 mins & feeds rules directly to Manager) ---
let rollingAuditRunning = false;
setInterval(() => {
  if (rollingAuditRunning || !mongoHistory.connected) return;
  rollingAuditRunning = true;
  void runNightlyAuditCycle(mongoHistory, {
    silentIfEmpty: true,
    onNewRule: (rule) => {
      rememberLesson(rule);
      console.log(`[Manager Memory Updated] New post-trade audit rule active immediately: "${rule}"`);
    }
  })
    .catch((err) => {
      console.error('[Rolling Post-Trade Audit Error]:', err);
    })
    .finally(() => {
      rollingAuditRunning = false;
    });
}, 15 * 60_000);


// --- MOBILE LIVE P&L TELEGRAM TRACKER (Updates silently every 60s) ---
let liveTrackerMessageId: number | null = null;
setInterval(() => {
  if (currentMarketStatus !== 'LIVE') return;

  const activeList = [...liveActiveTrades.values()];
  let openBlock = '💤 <i>No open trade right now (Scanning market...)</i>';

  if (activeList.length > 0) {
    openBlock = activeList.map((t) => {
      const currentPrice = liveTickerBySymbol.get(t.symbol)?.lastPrice ?? t.entryPrice;
      const diff = t.decision === 'LONG' ? currentPrice - t.entryPrice : t.entryPrice - currentPrice;
      const liveR = Number((diff / t.initialRisk).toFixed(2));
      const emoji = liveR >= 0 ? '🟢' : '🔴';
      return `${emoji} <b>[${t.tradeId}] ${t.decision} ${t.symbol}</b>\n` +
             `   • Entry: <code>$${t.entryPrice}</code> ➔ Now: <code>$${currentPrice}</code>\n` +
             `   • Live PnL: <b>${liveR >= 0 ? '+' : ''}${liveR}R</b> | SL: <code>$${t.stopPrice}</code> | TP: <code>$${t.targetPrice}</code>`;
    }).join('\n\n');
  }

  const timeIst = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const winRate = sessionPerformance.totalTrades > 0
    ? ((sessionPerformance.wins / sessionPerformance.totalTrades) * 100).toFixed(0)
    : '0';

  const statusHtml = `📱 <b>FLOWTERMINAL LIVE POCKET MONITOR</b>
━━━━━━━━━━━━━━━━━━━━
${openBlock}

📊 <b>Today's Session:</b>
• Net PnL: <b>${sessionPerformance.netR >= 0 ? '+' : ''}${sessionPerformance.netR.toFixed(2)}R</b> (${sessionPerformance.wins}W - ${sessionPerformance.losses}L | ${winRate}% WR)
• Feed: <b>${currentMarketStatus}</b> | Auto-Trader: <b>${isAutoTradingEnabled ? 'ON' : 'PAUSED'}</b>
🕒 <i>Updated: ${timeIst} IST</i>`;

  void sendOrEditLiveStatusMessage(statusHtml, liveTrackerMessageId).then((id) => {
    if (id) liveTrackerMessageId = id;
  });
}, 60_000);