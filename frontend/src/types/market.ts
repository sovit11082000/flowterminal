/**
 * FlowTerminal Frontend - Core Market Domain Types
 * Scope: Phase A Modularization (Trade, OHLCV, Footprint Clusters & Gateway contracts)
 */

export type AggressorSide = 'Buy' | 'Sell';

export type CandleTimeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type FootprintTimeframe = '1m' | '5m';

export interface Trade {
  symbol: string;
  price: number;
  size: number;
  side: AggressorSide;
  timestamp: number;
  tradeId: string;
  isBlockTrade?: boolean;
}

export interface LiquidationEvent {
  symbol: string;
  timestamp: number;
  side: AggressorSide;
  price: number;
  size: number;
}

export interface NormalizedCandle {
  symbol: string;
  timeframe: CandleTimeframe;
  time: number; // Unix timestamp in seconds (Lightweight Charts compliant)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  tradesCount: number;
  isClosed?: boolean;
}

export interface SerializedPriceLevelVolume {
  price: number;
  bidVolume: number; // Aggressive sell volume hitting bid
  askVolume: number; // Aggressive buy volume lifting ask
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

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'STALE'
  | 'DESYNCHRONIZED';
