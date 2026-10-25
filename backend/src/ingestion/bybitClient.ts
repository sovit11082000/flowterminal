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
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private isExplicitShutdown: boolean = false;
  private hasReceivedMarketData: boolean = false;
  private readonly symbols: string[];
  private readonly callbacks: BybitClientCallbacks;
  private readonly orderBookResubscribeTimers = new Map<string, NodeJS.Timeout>();

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
    this.callbacks.onStatusChange('CONNECTING', 'Connecting to Bybit V5 Public WebSocket...');

    try {
      this.ws = new WebSocket(BYBIT_LINEAR_WS_URL);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStatusChange('DISCONNECTED', `Socket initialization failed: ${errMsg}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.startHeartbeat();
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

    const topics = this.symbols.flatMap((symbol) => [
      TOPIC_PUBLIC_TRADE(symbol), TOPIC_ORDERBOOK_50(symbol), TOPIC_ALL_LIQUIDATION(symbol), TOPIC_TICKER(symbol),
      TOPIC_KLINE('1', symbol), TOPIC_KLINE('3', symbol), TOPIC_KLINE('5', symbol),
      TOPIC_KLINE('15', symbol), TOPIC_KLINE('30', symbol), TOPIC_KLINE('60', symbol),
      TOPIC_KLINE('240', symbol), TOPIC_KLINE('D', symbol)
    ]);
    for (let index = 0; index < topics.length; index += 10) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(index, index + 10) }));
    }
  }

  public resubscribeOrderBook(symbol: string): void {
    if (!this.symbols.includes(symbol) || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.orderBookResubscribeTimers.has(symbol)) return;
    const topic = TOPIC_ORDERBOOK_50(symbol);
    this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
    const timer = setTimeout(() => {
      this.orderBookResubscribeTimers.delete(symbol);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    }, 300);
    this.orderBookResubscribeTimers.set(symbol, timer);
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

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupTimers(): void {
    this.clearHeartbeatTimers();
    this.clearReconnectTimer();
    for (const timer of this.orderBookResubscribeTimers.values()) clearTimeout(timer);
    this.orderBookResubscribeTimers.clear();
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
