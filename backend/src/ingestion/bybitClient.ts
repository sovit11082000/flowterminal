import WebSocket from 'ws';
import {
  BYBIT_LINEAR_WS_URL,
  DEFAULT_SYMBOL,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  TOPIC_PUBLIC_TRADE,
  TOPIC_ORDERBOOK_50,
  TOPIC_ALL_LIQUIDATION,
  TOPIC_TICKER,
  TOPIC_KLINE
} from '../config/constants.js';
import { ConnectionStatus } from '../types/market.js';

export interface BybitClientCallbacks {
  onStatusChange: (status: ConnectionStatus, message?: string) => void;
  onMessage: (topic: string, payload: unknown) => void;
}

export class BybitWebSocketClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  private marketDataWatchdog: NodeJS.Timeout | null = null;
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private isExplicitShutdown: boolean = false;
  private hasReceivedMarketData: boolean = false;
  private lastMarketDataAt = 0;
  private readonly symbols: string[];
  private readonly callbacks: BybitClientCallbacks;
  private readonly topicResubscribeTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastTopicResubscribeAt = new Map<string, number>();
  private readonly lastPublicTradeAtBySymbol = new Map<string, number>();
  private readonly lastTradeEventAtBySymbol = new Map<string, number>();
  private readonly lastTradeMessageAtBySymbol = new Map<string, number>();
  private readonly lastTickerAtBySymbol = new Map<string, number>();
  private readonly lastKlineAtByTopic = new Map<string, number>();

  constructor(symbols: string | string[] = DEFAULT_SYMBOL, callbacks: BybitClientCallbacks) {
    this.symbols = Array.isArray(symbols) ? symbols : [symbols];
    this.callbacks = callbacks;
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.clearReconnectTimer();
    this.isExplicitShutdown = false;
    this.hasReceivedMarketData = false;
    this.lastMarketDataAt = Date.now();
    this.callbacks.onStatusChange('CONNECTING', 'Connecting to Bybit V5 Public WebSocket...');

    try {
      this.ws = new WebSocket(BYBIT_LINEAR_WS_URL);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStatusChange('DISCONNECTED', `Socket initialization failed: ${errMsg}`);
      this.scheduleReconnect();
      return;
    }

    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this.callbacks.onStatusChange('STALE', 'WebSocket handshake timed out (12s); retrying...');
        this.ws.terminate();
      }
    }, 12_000);

    this.ws.on('open', () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.lastMarketDataAt = Date.now();
      const openedAt = this.lastMarketDataAt;
      for (const symbol of this.symbols) {
        this.lastPublicTradeAtBySymbol.set(symbol, openedAt);
        this.lastTickerAtBySymbol.set(symbol, openedAt);
        for (const interval of ['1', '3', '5', '15', '30', '60', '240', 'D'] as const) {
          this.lastKlineAtByTopic.set(TOPIC_KLINE(interval, symbol), openedAt);
        }
      }
      this.startHeartbeat();
      this.startMarketDataWatchdog();
      this.subscribeTopics();
    });

    this.ws.on('message', (rawData: WebSocket.RawData) => {
      this.handleIncomingRawMessage(rawData);
    });

    this.ws.on('error', (err: Error) => {
      this.callbacks.onStatusChange('STALE', `WebSocket transport error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.cleanupTimers();
      this.ws = null;
      this.hasReceivedMarketData = false;

      if (!this.isExplicitShutdown) {
        const reasonStr = reason.toString();
        this.callbacks.onStatusChange(
          'RECONNECTING',
          `Connection closed (code: ${code}${reasonStr ? `, reason: ${reasonStr}` : ''})`
        );
        this.scheduleReconnect();
      } else {
        this.callbacks.onStatusChange('DISCONNECTED', 'Connection explicitly terminated');
      }
    });
  }

  private subscribeTopics(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const enableOrderBookStream = process.env.ENABLE_ORDERBOOK_STREAM === 'true';
    const topics = this.symbols.flatMap((symbol) => [
      TOPIC_PUBLIC_TRADE(symbol),
      ...(enableOrderBookStream ? [TOPIC_ORDERBOOK_50(symbol)] : []),
      TOPIC_ALL_LIQUIDATION(symbol),
      TOPIC_TICKER(symbol),
      TOPIC_KLINE('1', symbol),
      TOPIC_KLINE('5', symbol),
      TOPIC_KLINE('15', symbol)
    ]);
    for (let index = 0; index < topics.length; index += 10) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(index, index + 10) }));
    }
  }

  public resubscribeOrderBook(symbol: string): void {
    if (process.env.ENABLE_ORDERBOOK_STREAM !== 'true') return;
    if (!this.symbols.includes(symbol)) return;
    this.resubscribeTopic(TOPIC_ORDERBOOK_50(symbol));
  }

  private resubscribeTopic(topic: string): void {
    const now = Date.now();
    const lastResubscribeAt = this.lastTopicResubscribeAt.get(topic) ?? 0;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.topicResubscribeTimers.has(topic) || now - lastResubscribeAt < 60_000) return;
    this.lastTopicResubscribeAt.set(topic, now);
    this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
    const timer = setTimeout(() => {
      this.topicResubscribeTimers.delete(topic);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    }, 300);
    this.topicResubscribeTimers.set(topic, timer);
  }

  private handleIncomingRawMessage(rawData: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    const msg = parsed as Record<string, unknown>;

    // Handle pong heartbeat
    if (msg.op === 'pong' || msg.ret_msg === 'pong') {
      this.handlePong();
      return;
    }

    // Handle subscription response
    if (msg.op === 'subscribe') {
      if (msg.success !== true) {
        this.callbacks.onStatusChange(
          'STALE',
          `Subscription failed: ${typeof msg.ret_msg === 'string' ? msg.ret_msg : 'Unknown reason'}`
        );
      }
      return;
    }

    // Route topic messages
    if (typeof msg.topic === 'string') {
      this.lastMarketDataAt = Date.now();
      if (msg.topic.startsWith('publicTrade.')) {
        const symbol = msg.topic.slice('publicTrade.'.length);
        this.lastPublicTradeAtBySymbol.set(symbol, this.lastMarketDataAt);
        const rows = Array.isArray(msg.data) ? msg.data as Array<Record<string, unknown>> : [];
        const latestTradeTime = rows.reduce((latest, row) => {
          const tradeTime = Number(row.T);
          return Number.isFinite(tradeTime) && tradeTime > latest ? tradeTime : latest;
        }, 0);
        if (latestTradeTime > 0) {
          this.lastTradeEventAtBySymbol.set(symbol, latestTradeTime);
          const messageTime = Number(msg.ts);
          if (Number.isFinite(messageTime) && messageTime > 0) this.lastTradeMessageAtBySymbol.set(symbol, messageTime);
        }
      } else if (msg.topic.startsWith('tickers.')) {
        this.lastTickerAtBySymbol.set(msg.topic.slice('tickers.'.length), this.lastMarketDataAt);
      } else if (msg.topic.startsWith('kline.')) {
        this.lastKlineAtByTopic.set(msg.topic, this.lastMarketDataAt);
      }
      if (!this.hasReceivedMarketData) {
        this.hasReceivedMarketData = true;
        this.callbacks.onStatusChange('LIVE', 'Market data streaming verified');
      }
      this.callbacks.onMessage(msg.topic, parsed);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
          }

          this.ws.send(JSON.stringify({ op: 'ping' }));
          this.pongTimeout = setTimeout(() => {
            this.callbacks.onStatusChange('STALE', 'Heartbeat pong timeout exceeded (10s)');
            this.ws?.terminate();
          }, PONG_TIMEOUT_MS);
        } catch {
          this.ws?.terminate();
        }
      }
    }, PING_INTERVAL_MS);
  }

  private handlePong(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /** Ping/pong can stay healthy while subscriptions stop delivering market data. */
  private startMarketDataWatchdog(): void {
    if (this.marketDataWatchdog) clearInterval(this.marketDataWatchdog);
    this.marketDataWatchdog = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const silentForMs = Date.now() - this.lastMarketDataAt;
      if (silentForMs >= 90_000) {
        this.callbacks.onStatusChange('STALE', `No Bybit market-data messages for ${Math.floor(silentForMs / 1000)}s; reconnecting`);
        this.ws.terminate();
        return;
      }

      // Other topics (for example klines) can keep the socket looking healthy
      // while a ticker or public-trade subscription has silently stalled.
      const now = Date.now();
      let allTradesStalled = true;
      for (const symbol of this.symbols) {
        const tickerAt = this.lastTickerAtBySymbol.get(symbol) ?? this.lastMarketDataAt;
        const tradeAt = this.lastPublicTradeAtBySymbol.get(symbol) ?? this.lastMarketDataAt;
        if (now - tickerAt >= 60_000) this.resubscribeTopic(TOPIC_TICKER(symbol));
        if (now - tradeAt >= 45_000) this.resubscribeTopic(TOPIC_PUBLIC_TRADE(symbol));
        if (now - tradeAt < 120_000) {
          allTradesStalled = false;
        }
        for (const interval of ['1', '3', '5', '15', '30', '60', '240', 'D'] as const) {
          const topic = TOPIC_KLINE(interval, symbol);
          const lastAt = this.lastKlineAtByTopic.get(topic) ?? this.lastMarketDataAt;
          if (now - lastAt >= 120_000) this.resubscribeTopic(topic);
        }
      }

      // Only terminate the entire socket if ALL symbols have stopped receiving trades for 120s+ and socket is quiet
      if (allTradesStalled && now - this.lastMarketDataAt >= 60_000) {
        this.callbacks.onStatusChange('STALE', `All Bybit trade streams quiet for 120s; reconnecting socket`);
        this.ws?.terminate();
      }
    }, 15_000);
  }

  private scheduleReconnect(): void {
    if (this.isExplicitShutdown || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect();
    }, this.reconnectDelay);
  }

  private clearHeartbeatTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  public getDiagnostics(): {
    socket: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'DISCONNECTED';
    lastMarketDataAt: number | null;
    lastTradeAtBySymbol: Record<string, number | null>;
    lastTradeEventAtBySymbol: Record<string, number | null>;
    lastTradeMessageAtBySymbol: Record<string, number | null>;
    lastTickerAtBySymbol: Record<string, number | null>;
    lastKlineAtBySymbol: Record<string, Record<string, number | null>>;
  } {
    const readyState = this.ws?.readyState;
    const socket = readyState === WebSocket.CONNECTING ? 'CONNECTING'
      : readyState === WebSocket.OPEN ? 'OPEN'
        : readyState === WebSocket.CLOSING ? 'CLOSING'
          : readyState === WebSocket.CLOSED ? 'CLOSED' : 'DISCONNECTED';
    const intervals = ['1', '3', '5', '15', '30', '60', '240', 'D'] as const;
    return {
      socket,
      lastMarketDataAt: this.lastMarketDataAt || null,
      lastTradeAtBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, this.lastPublicTradeAtBySymbol.get(symbol) ?? null])),
      lastTradeEventAtBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, this.lastTradeEventAtBySymbol.get(symbol) ?? null])),
      lastTradeMessageAtBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, this.lastTradeMessageAtBySymbol.get(symbol) ?? null])),
      lastTickerAtBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, this.lastTickerAtBySymbol.get(symbol) ?? null])),
      lastKlineAtBySymbol: Object.fromEntries(this.symbols.map((symbol) => [
        symbol,
        Object.fromEntries(intervals.map((interval) => [interval, this.lastKlineAtByTopic.get(TOPIC_KLINE(interval, symbol)) ?? null]))
      ]))
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupTimers(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.clearHeartbeatTimers();
    if (this.marketDataWatchdog) {
      clearInterval(this.marketDataWatchdog);
      this.marketDataWatchdog = null;
    }
    this.clearReconnectTimer();
    for (const timer of this.topicResubscribeTimers.values()) clearTimeout(timer);
    this.topicResubscribeTimers.clear();
  }

  public disconnect(): void {
    this.isExplicitShutdown = true;
    this.cleanupTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.hasReceivedMarketData = false;
    this.callbacks.onStatusChange('DISCONNECTED', 'Client disconnected cleanly');
  }
}
