/**
 * FlowTerminal - Core Market Data & Gateway Types
 * Scope: Phase 1 Ingestion + Phase 2 Candlestick Aggregation + Phase 3 Order Flow
 */

export type AggressorSide = 'Buy' | 'Sell';

export interface NormalizedTrade {
  symbol: string;
  timestamp: number;
  price: number;
  size: number;
  side: AggressorSide;
  tradeId: string;
  isBlockTrade?: boolean;
}

export interface NormalizedLiquidation {
  symbol: string;
  timestamp: number;
  side: AggressorSide;
  price: number;
  size: number;
}

export type OrderBookEntry = [price: number, size: number];

export interface OrderBookLevelUpdate {
  price: number;
  size: number;
}

export interface NormalizedOrderBookSnapshot {
  symbol: string;
  timestamp: number;
  updateId: number;
  seq: number;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface NormalizedOrderBookDelta {
  symbol: string;
  timestamp: number;
  updateId: number;
  seq: number;
  bids: OrderBookLevelUpdate[];
  asks: OrderBookLevelUpdate[];
}

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'STALE'
  | 'DESYNCHRONIZED';

export type CandleTimeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type FootprintTimeframe = '1m' | '5m';

export interface NormalizedCandle {
  symbol: string;
  timeframe: CandleTimeframe;
  time: number; // Unix timestamp in seconds (Lightweight Charts compliant)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradesCount: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  isClosed: boolean;
}

// --- PHASE 3: ORDER FLOW & FOOTPRINT TYPES (NEW) ---

export interface SerializedPriceLevelVolume {
  price: number;
  bidVolume: number;
  askVolume: number;
  totalVolume: number;
  delta: number;
  tradesCount: number;
}

export interface SerializedFootprintBar {
  symbol: string;
  timeframe: FootprintTimeframe;
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeDelta: number;
  pocPrice: number;
  pocVolume: number;
  tradesCount: number;
  priceLevels: SerializedPriceLevelVolume[];
  isClosed: boolean;
}

export interface CvdUpdateData {
  symbol: string;
  timeframe: CandleTimeframe;
  time: number;
  barDelta: number;
  cumulativeDelta: number;
  lastTradeSide: AggressorSide;
  lastTradeSize: number;
  lastTradePrice: number;
}

// --- GATEWAY MESSAGES ---

export interface StatusGatewayMessage {
  type: 'STATUS';
  status: ConnectionStatus;
  timestamp: number;
  message?: string;
  symbol?: string;
}

export interface TradeGatewayMessage {
  type: 'TRADE';
  data: NormalizedTrade[];
  timestamp: number;
}

export interface LiquidationGatewayMessage {
  type: 'LIQUIDATION';
  data: NormalizedLiquidation[];
  timestamp: number;
}

export interface TickerGatewayMessage {
  type: 'TICKER';
  data: { symbol: string; lastPrice: number | null; markPrice: number | null; indexPrice: number | null };
  timestamp: number;
}

export interface OrderBookSnapshotGatewayMessage {
  type: 'ORDERBOOK_SNAPSHOT';
  data: {
    symbol: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
    bestBid: number | null;
    bestAsk: number | null;
    seq: number;
    updateId: number;
  };
  timestamp: number;
}

export interface OrderBookDeltaGatewayMessage {
  type: 'ORDERBOOK_DELTA';
  data: {
    symbol: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
    bestBid: number | null;
    bestAsk: number | null;
    seq: number;
    updateId: number;
  };
  timestamp: number;
}

export interface CandleGatewayMessage {
  type: 'CANDLE';
  timeframe: CandleTimeframe;
  data: NormalizedCandle;
  timestamp: number;
}

export interface FootprintBarGatewayMessage {
  type: 'FOOTPRINT_BAR';
  timeframe: CandleTimeframe;
  data: SerializedFootprintBar;
  timestamp: number;
}

export interface CvdGatewayMessage {
  type: 'CVD_UPDATE';
  data: CvdUpdateData;
  timestamp: number;
}

export type GatewayMessage =
  | StatusGatewayMessage
  | TradeGatewayMessage
  | LiquidationGatewayMessage
  | TickerGatewayMessage
  | OrderBookSnapshotGatewayMessage
  | OrderBookDeltaGatewayMessage
  | CandleGatewayMessage
  | FootprintBarGatewayMessage
  | CvdGatewayMessage;

// --- BYBIT RAW PAYLOADS ---

export interface BybitRawTradeItem {
  T: number | string;
  s: string;
  S: 'Buy' | 'Sell' | string;
  v: string;
  p: string;
  L?: string;
  i: string;
  BT?: boolean;
}

export interface BybitRawTradePayload {
  topic: string;
  type?: string;
  ts: number;
  data: BybitRawTradeItem[];
}

export interface BybitRawOrderBookData {
  s: string;
  b: [string, string][];
  a: [string, string][];
  u: number;
  seq: number;
}

export interface BybitRawOrderBookPayload {
  topic: string;
  type: 'snapshot' | 'delta';
  ts: number;
  data: BybitRawOrderBookData;
}
