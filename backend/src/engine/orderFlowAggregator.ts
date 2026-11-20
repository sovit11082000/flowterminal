/**
 * FlowTerminal - Order Flow & Footprint Aggregation Engine
 * 
 * Scope: Real-time Trade Aggregation by Price Level (Footprint Clusters),
 *        Bar Delta, Cumulative Volume Delta (CVD), and Point of Control (POC).
 * Constraints: Real Bybit market data only, zero synthetic ticks, deterministic math.
 */

import { NormalizedTrade, FootprintTimeframe } from '../types/market.js';

export interface PriceLevelVolume {
  price: number;
  bidVolume: number;  // Sell aggressor hitting bid
  askVolume: number;  // Buy aggressor hitting ask
  totalVolume: number;
  delta: number;      // askVolume - bidVolume
  tradesCount: number;
}

export interface FootprintBar {
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
  cumulativeDelta: number; // Running CVD across bars
  pocPrice: number;        // Price level with maximum volume
  pocVolume: number;       // Volume executed at POC
  tradesCount: number;
  whaleBuyVolume: number;  // Big single tape prints (Ask sweeps >= 8x avg print)
  whaleSellVolume: number; // Big single tape prints (Bid sweeps >= 8x avg print)
  whaleBuyCount: number;
  whaleSellCount: number;
  bidIcebergPrice: number | null; // Price level showing repeated passive Bid refill absorption
  askIcebergPrice: number | null; // Price level showing repeated passive Ask refill absorption
  priceLevels: Map<number, PriceLevelVolume>;
  isClosed: boolean;
}

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
  time: number;
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
  whaleBuyVolume: number;
  whaleSellVolume: number;
  whaleBuyCount: number;
  whaleSellCount: number;
  bidIcebergPrice: number | null;
  askIcebergPrice: number | null;
  priceLevels: SerializedPriceLevelVolume[];
  isClosed: boolean;
}

export interface OrderFlowAggregatorOptions {
  timeframe: FootprintTimeframe;
  tickSize?: number;           // Defaults to 0.1 for Bybit BTCUSDT
  maxDeduplicationWindow?: number;
  maxHistoricalBars?: number;
  initialCvd?: number;
}

export class OrderFlowAggregator {
  private readonly timeframe: FootprintTimeframe;
  private readonly intervalMs: number;
  private readonly tickSize: number;
  private readonly maxDeduplicationWindow: number;
  private readonly maxHistoricalBars: number;
  private readonly initialCvd: number;

  private currentBar: FootprintBar | null = null;
  private closedBars: Map<number, FootprintBar> = new Map();
  private runningCvd: number = 0;
  private readonly latestTradeTimestampByBar = new Map<number, number>();

  // Bounded deduplication ring buffer
  private recentTradeIds: Set<string> = new Set();
  private tradeIdQueue: string[] = [];

  constructor(options: OrderFlowAggregatorOptions) {
    this.timeframe = options.timeframe;
    this.intervalMs = options.timeframe === '1m' ? 60_000 : 300_000;
    this.tickSize = options.tickSize && options.tickSize > 0 ? options.tickSize : 0.1;
    this.maxDeduplicationWindow = options.maxDeduplicationWindow ?? 5000;
    this.maxHistoricalBars = options.maxHistoricalBars ?? 200;
    this.initialCvd = Number.isFinite(options.initialCvd) ? Number(options.initialCvd) : 0;
    this.runningCvd = this.initialCvd;
  }

  /**
   * Processes a normalized incoming trade.
   * Returns the updated footprint bar or null if trade was duplicate/invalid.
   */
  public processTrade(trade: NormalizedTrade): FootprintBar | null {
    if (
      !trade ||
      !Number.isFinite(trade.price) ||
      trade.price <= 0 ||
      !Number.isFinite(trade.size) ||
      trade.size <= 0 ||
      !Number.isFinite(trade.timestamp) ||
      trade.timestamp <= 0 ||
      (trade.side !== 'Buy' && trade.side !== 'Sell') ||
      !trade.tradeId
    ) {
      return null;
    }

    // Bounded Deduplication
    if (this.recentTradeIds.has(trade.tradeId)) {
      return null;
    }
    this.recordTradeId(trade.tradeId);

    const bucketStartMs = Math.floor(trade.timestamp / this.intervalMs) * this.intervalMs;
    const bucketTimeSec = Math.floor(bucketStartMs / 1000);

    // Initial first bar
    if (!this.currentBar) {
      this.currentBar = this.createEmptyBar(trade, bucketTimeSec);
      this.applyTradeToBar(this.currentBar, trade);
      return this.currentBar;
    }

    const currentBucketMs = this.currentBar.time * 1000;

    // Same bucket progression
    if (bucketStartMs === currentBucketMs) {
      this.applyTradeToBar(this.currentBar, trade);
      return this.currentBar;
    }

    // Future bucket rollover
    if (bucketStartMs > currentBucketMs) {
      this.currentBar.isClosed = true;
      this.closedBars.set(this.currentBar.time, this.currentBar);

      // Memory boundary management
      if (this.closedBars.size > this.maxHistoricalBars) {
        const oldestKey = Array.from(this.closedBars.keys())[0];
        this.closedBars.delete(oldestKey);
        this.latestTradeTimestampByBar.delete(oldestKey);
      }

      this.currentBar = this.createEmptyBar(trade, bucketTimeSec);
      this.applyTradeToBar(this.currentBar, trade);
      return this.currentBar;
    }

    // Out-of-order past bucket trade: discard or safely route to closed bar if present
    const pastBar = this.closedBars.get(bucketTimeSec);
    if (pastBar) {
      this.applyTradeToBar(pastBar, trade, false);
      const signedSize = trade.side === 'Buy' ? trade.size : -trade.size;
      this.runningCvd = Number((this.runningCvd + signedSize).toFixed(6));
      for (const bar of [...this.closedBars.values(), ...(this.currentBar ? [this.currentBar] : [])]) {
        if (bar.time >= bucketTimeSec) bar.cumulativeDelta = Number((bar.cumulativeDelta + signedSize).toFixed(6));
      }
      return pastBar;
    }

    return null;
  }

  public getCurrentBar(): FootprintBar | null {
    return this.currentBar;
  }

  public getRunningCvd(): number {
    return this.runningCvd;
  }

  public getRecentBars(limit: number = 50): FootprintBar[] {
    const bars: FootprintBar[] = [];
    for (const bar of this.closedBars.values()) {
      bars.push(bar);
    }
    if (this.currentBar) {
      bars.push(this.currentBar);
    }
    return bars.slice(-limit);
  }

  public serializeBar(bar: FootprintBar): SerializedFootprintBar {
    const sortedLevels = Array.from(bar.priceLevels.values()).sort((a, b) => b.price - a.price);

    return {
      symbol: bar.symbol,
      timeframe: bar.timeframe,
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      totalVolume: bar.totalVolume,
      buyVolume: bar.buyVolume,
      sellVolume: bar.sellVolume,
      delta: bar.delta,
      cumulativeDelta: bar.cumulativeDelta,
      pocPrice: bar.pocPrice,
      pocVolume: bar.pocVolume,
      tradesCount: bar.tradesCount,
      whaleBuyVolume: bar.whaleBuyVolume,
      whaleSellVolume: bar.whaleSellVolume,
      whaleBuyCount: bar.whaleBuyCount,
      whaleSellCount: bar.whaleSellCount,
      bidIcebergPrice: bar.bidIcebergPrice,
      askIcebergPrice: bar.askIcebergPrice,
      priceLevels: sortedLevels,
      isClosed: bar.isClosed
    };
  }

  public reset(): void {
    this.currentBar = null;
    this.closedBars.clear();
    this.recentTradeIds.clear();
    this.tradeIdQueue = [];
    this.runningCvd = this.initialCvd;
    this.latestTradeTimestampByBar.clear();
  }

  private createEmptyBar(trade: NormalizedTrade, timeSec: number): FootprintBar {
    const quantizedPrice = this.quantizePrice(trade.price);
    return {
      symbol: trade.symbol,
      timeframe: this.timeframe,
      time: timeSec,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      cumulativeDelta: this.runningCvd,
      pocPrice: quantizedPrice,
      pocVolume: 0,
      tradesCount: 0,
      whaleBuyVolume: 0,
      whaleSellVolume: 0,
      whaleBuyCount: 0,
      whaleSellCount: 0,
      bidIcebergPrice: null,
      askIcebergPrice: null,
      priceLevels: new Map(),
      isClosed: false
    };
  }

  private applyTradeToBar(bar: FootprintBar, trade: NormalizedTrade, updateCvd = true): void {
    const price = trade.price;
    const size = trade.size;
    const isBuy = trade.side === 'Buy';

    // 1. OHLC Updates
    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
    const latestTimestamp = this.latestTradeTimestampByBar.get(bar.time) ?? 0;
    if (trade.timestamp >= latestTimestamp) {
      bar.close = price;
      this.latestTradeTimestampByBar.set(bar.time, trade.timestamp);
    }

    // 2. Bar Volume & Delta Accounting
    bar.totalVolume = Number((bar.totalVolume + size).toFixed(6));
    bar.tradesCount += 1;

    if (isBuy) {
      bar.buyVolume = Number((bar.buyVolume + size).toFixed(6));
      if (updateCvd) this.runningCvd = Number((this.runningCvd + size).toFixed(6));
    } else {
      bar.sellVolume = Number((bar.sellVolume + size).toFixed(6));
      if (updateCvd) this.runningCvd = Number((this.runningCvd - size).toFixed(6));
    }

    bar.delta = Number((bar.buyVolume - bar.sellVolume).toFixed(6));
    if (updateCvd) bar.cumulativeDelta = this.runningCvd;

    // 3. Price Level Cluster (Footprint aggregation)
    const levelKey = this.quantizePrice(price);
    let level = bar.priceLevels.get(levelKey);

    if (!level) {
      level = {
        price: levelKey,
        bidVolume: 0,
        askVolume: 0,
        totalVolume: 0,
        delta: 0,
        tradesCount: 0
      };
      bar.priceLevels.set(levelKey, level);
    }

    if (isBuy) {
      level.askVolume = Number((level.askVolume + size).toFixed(6));
    } else {
      level.bidVolume = Number((level.bidVolume + size).toFixed(6));
    }

    level.totalVolume = Number((level.totalVolume + size).toFixed(6));
    level.delta = Number((level.askVolume - level.bidVolume).toFixed(6));
    level.tradesCount += 1;

    // 4. Whale Tape Print Detection (Individual trade >= 8x running average trade size after warmup)
    const avgPrintSize = bar.tradesCount > 5 ? (bar.totalVolume - size) / (bar.tradesCount - 1) : 0;
    if (avgPrintSize > 0 && size >= avgPrintSize * 8) {
      if (isBuy) {
        bar.whaleBuyVolume = Number((bar.whaleBuyVolume + size).toFixed(6));
        bar.whaleBuyCount += 1;
      } else {
        bar.whaleSellVolume = Number((bar.whaleSellVolume + size).toFixed(6));
        bar.whaleSellCount += 1;
      }
    }

    // 5. True Iceberg Refill Detection (25+ prints soaked at exact price level without breaking through)
    if (level.tradesCount >= 25) {
      if (level.bidVolume >= level.askVolume * 2.2 && bar.close >= level.price) {
        bar.bidIcebergPrice = level.price;
      } else if (level.askVolume >= level.bidVolume * 2.2 && bar.close <= level.price) {
        bar.askIcebergPrice = level.price;
      }
    }

    // 6. Point of Control (POC) Evaluation
    if (level.totalVolume > bar.pocVolume) {
      bar.pocPrice = level.price;
      bar.pocVolume = level.totalVolume;
    }
  }

  private quantizePrice(price: number): number {
    const decimals = decimalPlaces(this.tickSize);
    return Number((Math.round(price / this.tickSize) * this.tickSize).toFixed(decimals));
  }

  private recordTradeId(tradeId: string): void {
    this.recentTradeIds.add(tradeId);
    this.tradeIdQueue.push(tradeId);
    if (this.tradeIdQueue.length > this.maxDeduplicationWindow) {
      const evicted = this.tradeIdQueue.shift();
      if (evicted) {
        this.recentTradeIds.delete(evicted);
      }
    }
  }
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const fractionDigits = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  const exponent = exponentText ? Number(exponentText) : 0;
  return Math.max(0, Math.min(12, fractionDigits - exponent));
}
