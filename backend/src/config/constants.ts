/**
 * FlowTerminal - Core Backend Constants & Configuration
 * 
 * Target Market: Bybit V5 Linear (USDT Perpetual)
 * Scope: Public Market Data Only (Zero-Budget Local-First MVP)
 * Reference: https://bybit-exchange.github.io/docs/v5/websocket/public
 */

// Official Bybit V5 Public Linear WebSocket Endpoint

export const BYBIT_LINEAR_WS_URL = 'wss://stream.bybit.com/v5/public/linear';

// Phase 1 Target Contract
export const DEFAULT_SYMBOL = 'BTCUSDT';
export const SUPPORTED_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT'
] as const;

// Heartbeat & Timeout Parameters (Bybit V5 Documented: Ping every 20s)
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;

// Reconnect Backoff Limits (Exponential Backoff: 1s, 2s, 4s, 8s ... max 30s)
export const INITIAL_RECONNECT_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;

// Local Backend Gateway Configuration
export const LOCAL_GATEWAY_PORT = 4000;

// Market Data Topics (Bybit V5 Documented Format)
export const TOPIC_PUBLIC_TRADE = (symbol: string = DEFAULT_SYMBOL): string => `publicTrade.${symbol}`;
export const TOPIC_ORDERBOOK_50 = (symbol: string = DEFAULT_SYMBOL): string => `orderbook.50.${symbol}`;
export const TOPIC_ALL_LIQUIDATION = (symbol: string = DEFAULT_SYMBOL): string => `allLiquidation.${symbol}`;
export const TOPIC_TICKER = (symbol: string = DEFAULT_SYMBOL): string => `tickers.${symbol}`;
export const TOPIC_KLINE = (interval: '1' | '3' | '5' | '15' | '30' | '60' | '240' | 'D', symbol: string = DEFAULT_SYMBOL): string => `kline.${interval}.${symbol}`;
