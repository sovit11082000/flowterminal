import http from 'node:http';
import dns from 'node:dns';

// Force IPv4 DNS lookup first to prevent connection dropouts on cloud hosts
dns.setDefaultResultOrder('ipv4first');

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { LOCAL_GATEWAY_PORT, DEFAULT_SYMBOL, SUPPORTED_SYMBOLS } from './config/constants.js';
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
import { OrderFlowAggregator } from './engine/orderFlowAggregator.js';
import { BybitRestService, BybitRestServiceError } from './services/bybitRestService.js';
import { BybitOptionsService, type OptionBase } from './services/bybitOptionsService.js';
import { BinanceOptionsService } from './services/binanceOptionsService.js';
import { FootprintHistoryStore } from './services/footprintHistoryStore.js';
import { OrderBookHistoryStore } from './services/orderBookHistoryStore.js';
import { TradeHistoryStore } from './services/tradeHistoryStore.js';
import { LiquidationHistoryStore } from './services/liquidationHistoryStore.js';
import { MongoHistoryStore, type AgentPaperPerformance } from './services/mongoHistoryStore.js';
import { runOrderFlowCouncil, analyzeTradeOutcomeWithAI, type AgentSnapshot } from './agents/orderFlowCouncil.js';
import { sendTradeEntryAlert, sendTradeOutcomeAlert, sendTelegramMessage } from './services/telegramService.js';

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
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore read issues
    }
  }
}
loadProjectEnv();

let currentMarketStatus: ConnectionStatus = 'DISCONNECTED';
let lastTradeReceivedAt: number | null = null;
let lastCouncilRequestAt = 0;

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
  AVAXUSDT: 0.01, XAUTUSDT: 0.1
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

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 6500): Promise<Response> {
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

// --- MULTI-COIN LIVE TRADING ENGINE ---
interface LiveActiveTrade {
  symbol: string;
  decision: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  targetR: number;
  reasons: string[];
  strategies: string[];
  summary: string;
  barsHeld: number;
  enteredAt: number;
}

const liveActiveTrades = new Map<string, LiveActiveTrade>();
const liveLearnedLessons: string[] = [];
let liveCouncilInFlight = false;
let isAutoTradingEnabled = true;
let lastQuotaAlertTime = 0;
let lastMissingConfigLogAt = 0;
let lastStaleFeedLogAt = 0;

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

  // Status check for UI Toggle Button
  if (req.method === 'GET' && parsed.pathname === '/api/agents/auto-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ autoTrading: isAutoTradingEnabled }));
    return;
  }

  // Toggle Auto Trading On/Off from UI Button
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
      const status = message.includes('too large') ? 413 : message.includes('not configured') ? 503 : message.includes('quota') ? 429 : 502;
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

  // Serve Frontend UI in Production
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

export function updateMarketStatus(status: ConnectionStatus, message?: string, affectedSymbol?: string): void {
  if (!affectedSymbol) currentMarketStatus = status;
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

// --- MULTI-COIN LIVE BAR PROCESSING & LEARNING ---
async function handleLiveBarAutonomousTrading(symbol: string, bar: SerializedFootprintBar): Promise<void> {
  if (!isAutoTradingEnabled) {
    return;
  }

  // --- HARD FEED GUARD: ZERO API CALLS IF FEED IS NOT 100% LIVE ---
  const isFeedFresh = currentMarketStatus === 'LIVE' &&
                      lastTradeReceivedAt !== null &&
                      (Date.now() - lastTradeReceivedAt < 25_000);

  if (!isFeedFresh) {
    const now = Date.now();
    if (now - lastStaleFeedLogAt > 60_000) {
      lastStaleFeedLogAt = now;
      console.log(`[Auto-Trader] Feed stale/disconnected (${currentMarketStatus}). Skipping AI calls to protect API quota.`);
    }
    return;
  }

  // 1. Check open position for this specific symbol
  const currentTrade = liveActiveTrades.get(symbol);
  if (currentTrade) {
    currentTrade.barsHeld += 1;
    let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
    let exitPrice = bar.close;

    if (currentTrade.decision === 'LONG') {
      if (bar.low <= currentTrade.stopPrice) {
        outcome = 'LOSS';
        exitPrice = currentTrade.stopPrice;
      } else if (bar.high >= currentTrade.targetPrice) {
        outcome = 'WIN';
        exitPrice = currentTrade.targetPrice;
      }
    } else {
      if (bar.high >= currentTrade.stopPrice) {
        outcome = 'LOSS';
        exitPrice = currentTrade.stopPrice;
      } else if (bar.low <= currentTrade.targetPrice) {
        outcome = 'WIN';
        exitPrice = currentTrade.targetPrice;
      }
    }

    if (outcome !== 'OPEN' || currentTrade.barsHeld >= 15) {
      const resolvedOutcome: 'WIN' | 'LOSS' = outcome !== 'OPEN'
        ? outcome
        : (currentTrade.decision === 'LONG' ? (exitPrice >= currentTrade.entryPrice ? 'WIN' : 'LOSS') : (exitPrice <= currentTrade.entryPrice ? 'WIN' : 'LOSS'));

      const risk = Math.abs(currentTrade.entryPrice - currentTrade.stopPrice) || 1;
      const diff = currentTrade.decision === 'LONG' ? exitPrice - currentTrade.entryPrice : currentTrade.entryPrice - exitPrice;
      const pnlR = Number((diff / risk).toFixed(2));
      const finishedTrade = { ...currentTrade };
      liveActiveTrades.delete(symbol);

      console.log(`[Trade Resolved] ${finishedTrade.decision} on ${symbol} -> ${resolvedOutcome} (${pnlR > 0 ? '+' : ''}${pnlR}R) @ $${exitPrice}`);

      const forwardContext = resolvedOutcome === 'WIN'
        ? `Target reached at $${exitPrice.toFixed(2)} within ${finishedTrade.barsHeld} bars with strong order-flow continuation.`
        : `Stop loss hit at $${exitPrice.toFixed(2)} within ${finishedTrade.barsHeld} bars.`;

      void analyzeTradeOutcomeWithAI(
        {
          decision: finishedTrade.decision,
          entryPrice: finishedTrade.entryPrice,
          stopPrice: finishedTrade.stopPrice,
          targetPrice: finishedTrade.targetPrice,
          reasons: finishedTrade.reasons,
          summary: finishedTrade.summary
        },
        {
          outcome: resolvedOutcome,
          exitPrice,
          exitReason: resolvedOutcome === 'WIN' ? 'Hit Target (+2R)' : 'Hit Stop Loss (-1R)',
          marketContext: forwardContext
        }
      ).then(async (insight) => {
        if (resolvedOutcome === 'LOSS') {
          liveLearnedLessons.push(insight);
          if (mongoHistory.connected) {
            void mongoHistory.saveLearnedLesson({
              symbol,
              outcome: 'LOSS',
              lesson: insight,
              source: 'LIVE'
            });
          }
          console.log(`[AI Rule Learned for ${symbol}]: "${insight}"`);
        } else {
          console.log(`[AI Win Signature for ${symbol}]: "${insight}"`);
        }

        await sendTradeOutcomeAlert({
          symbol,
          decision: finishedTrade.decision,
          outcome: resolvedOutcome,
          entryPrice: finishedTrade.entryPrice,
          exitPrice,
          pnlR,
          barsHeld: finishedTrade.barsHeld,
          lessonLearned: insight
        });
      }).catch((e) => console.warn('[AI Learning Warning]:', e instanceof Error ? e.message : e));

      return;
    }
  }

  // 2. Evaluate new setup across coins when no trade is active for this symbol
  if (!liveActiveTrades.has(symbol) && !liveCouncilInFlight) {
    const pipeline = marketPipelines.get(symbol);
    if (!pipeline) return;

    const recentBars = pipeline.footprints['1m'].getRecentBars(15);
    if (recentBars.length < 6) return;

    const lookback = recentBars.slice(-6);
    const isLocalExtreme = bar.high >= Math.max(...lookback.map((b) => b.high)) ||
                           bar.low <= Math.min(...lookback.map((b) => b.low));
    const isDeltaSpike = Math.abs(bar.delta) >= 20;
    const isFiveMinBoundary = bar.time % 300 === 0;

    if (!isLocalExtreme && !isDeltaSpike && !isFiveMinBoundary) {
      return;
    }

    liveCouncilInFlight = true;
    try {
      const candles1m = pipeline.footprints['1m'].getRecentBars(40).map((b) => ({
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

      const snapshot: AgentSnapshot = {
        symbol,
        timeframe: '1m',
        feedStatus: currentMarketStatus,
        lastTradeAt: lastTradeReceivedAt,
        latestPrice: bar.close,
        profile: {
          poc: bar.pocPrice,
          vah: Math.max(...recentBars.map((b) => b.high)),
          val: Math.min(...recentBars.map((b) => b.low)),
          capturedBars: recentBars.length
        },
        candles: candles1m,
        footprints: recentBars.map((b) => pipeline.footprints['1m'].serializeBar(b)),
        trades: [],
        bids: pipeline.orderBook.getSortedBids(5),
        asks: pipeline.orderBook.getSortedAsks(5),
        paperPerformance: {
          resolved: 0,
          wins: 0,
          losses: 0,
          expired: 0,
          winRate: null,
          averageR: null,
          recent: [],
          learnedLessons: [...persistentLessons, ...liveLearnedLessons]
        }
      };

      const councilResult = await runOrderFlowCouncil(snapshot);
      const plan = councilResult.plan;

      if (plan.decision !== 'WAIT') {
        console.log(`\n🚨 [LIVE TRADE TRIGGERED]: ${plan.decision} ${symbol} @ $${plan.entryPrice}`);
        console.log(`   SL: $${plan.stopPrice} | TP: $${plan.targetPrice} (${plan.targetR}R)`);

        const newTrade: LiveActiveTrade = {
          symbol,
          decision: plan.decision,
          entryPrice: plan.entryPrice!,
          stopPrice: plan.stopPrice!,
          targetPrice: plan.targetPrice!,
          targetR: plan.targetR || 2,
          reasons: plan.reasons,
          strategies: plan.strategyNames || [],
          summary: plan.summary,
          barsHeld: 0,
          enteredAt: Date.now()
        };
        liveActiveTrades.set(symbol, newTrade);

        void sendTradeEntryAlert({
          symbol,
          decision: plan.decision,
          entryPrice: plan.entryPrice!,
          stopPrice: plan.stopPrice!,
          targetPrice: plan.targetPrice!,
          targetR: plan.targetR || 2,
          reasons: plan.reasons,
          strategies: plan.strategyNames || [],
          summary: plan.summary
        }).catch((e) => console.warn('[Telegram Entry Alert Error]:', e instanceof Error ? e.message : e));

        if (mongoHistory.connected) {
          void mongoHistory.saveAgentDecision(snapshot, councilResult).catch((e) => console.warn('[MongoDB Save Error]:', e));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
        void handleQuotaExhaustedAlert(msg);
      }
      if (msg.includes('No AI provider is configured')) {
        const now = Date.now();
        if (now - lastMissingConfigLogAt > 60_000) {
          lastMissingConfigLogAt = now;
          console.warn('[Live Council Error]: No AI provider is configured. Set your 4 role keys in .env, then restart the backend.');
        }
      } else {
        console.warn('[Live Council Error]:', msg);
      }
    } finally {
      liveCouncilInFlight = false;
    }
  }
}

const bybitClient = new BybitWebSocketClient([...SUPPORTED_SYMBOLS], {
  onStatusChange: (status: ConnectionStatus, message?: string) => {
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
      lastTradeReceivedAt = Date.now();
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
        lastTradeReceivedAt = Date.now();
        tradeHistory.save(trades);
        if (process.env.MONGO_PERSIST_RAW_TRADES === 'true') queueMongoTrades(trades);

        // BANDWIDTH SAVER: Raw tick trades broadcast disabled on cloud hosts
        if (process.env.BROADCAST_RAW_TRADES === 'true') {
          const tradeMsg: TradeGatewayMessage = {
            type: 'TRADE',
            data: trades,
            timestamp: Date.now()
          };
          broadcast(tradeMsg);
        }

        // Process in Order Flow Aggregator
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
                  persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
                }
                broadcast({
                  type: 'FOOTPRINT_BAR',
                  timeframe: '1m',
                  data: serialized,
                  timestamp: Date.now()
                });

                // Auto Trading Trigger
                void handleLiveBarAutonomousTrading(trade.symbol, serialized);
              }
            }

            if (prevBarTime1m !== undefined && fpBar1m.time < prevBarTime1m) {
              for (const corrected of pipeline.footprints['1m'].getRecentBars(200).filter((bar) => bar.time >= fpBar1m.time && bar.isClosed)) {
                const serialized = pipeline.footprints['1m'].serializeBar(corrected);
                footprintHistory.save(serialized);
                persistToMongo('footprint bar', () => mongoHistory.saveFootprint(serialized));
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

void restService.fetchTickSizes([...SUPPORTED_SYMBOLS]).then((exchangeTickSizes) => {
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
    .catch((error: unknown) => console.error('[MongoDB] Connection failed; local recording remains active:', error))
    .finally(() => bybitClient.connect());
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