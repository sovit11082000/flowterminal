import {
  NormalizedTrade,
  NormalizedCandle,
  CandleTimeframe
} from '../types/market.js';

interface MutableCandle extends NormalizedCandle {
  lastEventTimestamp: number;
}

export class BarAggregator {
  private readonly timeframe: CandleTimeframe;
  private readonly intervalMs: number;
  private readonly maxLatenessMs: number;
  private currentCandle: MutableCandle | null = null;
  private closedCandles: Map<number, MutableCandle> = new Map();
  private recentTradeIds: Set<string> = new Set();
  private tradeIdQueue: string[] = [];
  private readonly maxDeduplicationWindow = 5000;

  constructor(timeframe: CandleTimeframe, maxLatenessSeconds: number = 60) {
    this.timeframe = timeframe;
    this.intervalMs = ({
      '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
      '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000
    } as const)[timeframe];
    this.maxLatenessMs = maxLatenessSeconds * 1000;
  }

  public processTrade(trade: NormalizedTrade): NormalizedCandle | null {
    if (!trade || !Number.isFinite(trade.price) || !Number.isFinite(trade.size) || trade.size <= 0) {
      return null;
    }

    // Bounded Deduplication
    if (this.recentTradeIds.has(trade.tradeId)) {
      return null;
    }
    this.recordTradeId(trade.tradeId);

    const bucketStartMs = Math.floor(trade.timestamp / this.intervalMs) * this.intervalMs;
    const bucketTimeSec = Math.floor(bucketStartMs / 1000);

    // Initial first candle
    if (!this.currentCandle) {
      this.currentCandle = this.createEmptyCandle(trade, bucketTimeSec);
      this.applyTradeToCandle(this.currentCandle, trade);
      return this.cloneCandle(this.currentCandle);
    }

    // Current open candle progression
    const currentBucketMs = this.currentCandle.time * 1000;
    if (bucketStartMs === currentBucketMs) {
      this.applyTradeToCandle(this.currentCandle, trade);
      return this.cloneCandle(this.currentCandle);
    }

    // New future bucket (Rollover current candle)
    if (bucketStartMs > currentBucketMs) {
      this.currentCandle.isClosed = true;
      this.closedCandles.set(this.currentCandle.time, { ...this.currentCandle });

      // Evict old closed candles past 100 bars from memory
      if (this.closedCandles.size > 100) {
        const oldestKey = Array.from(this.closedCandles.keys())[0];
        this.closedCandles.delete(oldestKey);
      }

      this.currentCandle = this.createEmptyCandle(trade, bucketTimeSec);
      this.applyTradeToCandle(this.currentCandle, trade);
      return this.cloneCandle(this.currentCandle);
    }

    // Out-of-order late trade arriving for a previous closed bucket
    if (currentBucketMs - bucketStartMs <= this.maxLatenessMs) {
      const pastCandle = this.closedCandles.get(bucketTimeSec);
      if (pastCandle) {
        this.applyTradeToCandle(pastCandle, trade);
        return this.cloneCandle(pastCandle);
      }
    }

    // Reject trade exceeding max bounded lateness
    return null;
  }

  public getCurrentCandle(): NormalizedCandle | null {
    return this.currentCandle ? this.cloneCandle(this.currentCandle) : null;
  }

  public getRecentCandles(limit: number = 50): NormalizedCandle[] {
    const list: NormalizedCandle[] = [];
    for (const candle of this.closedCandles.values()) {
      list.push(this.cloneCandle(candle));
    }
    if (this.currentCandle) {
      list.push(this.cloneCandle(this.currentCandle));
    }
    return list.slice(-limit);
  }

  private createEmptyCandle(trade: NormalizedTrade, timeSec: number): MutableCandle {
    return {
      symbol: trade.symbol,
      timeframe: this.timeframe,
      time: timeSec,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: 0,
      tradesCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      isClosed: false,
      lastEventTimestamp: trade.timestamp
    };
  }

  private applyTradeToCandle(candle: MutableCandle, trade: NormalizedTrade): void {
    if (trade.price > candle.high) candle.high = trade.price;
    if (trade.price < candle.low) candle.low = trade.price;

    // Preserve deterministic event sequence for Close
    if (trade.timestamp >= candle.lastEventTimestamp) {
      candle.close = trade.price;
      candle.lastEventTimestamp = trade.timestamp;
    }

    candle.volume = Number((candle.volume + trade.size).toFixed(6));
    candle.tradesCount += 1;

    if (trade.side === 'Buy') {
      candle.buyVolume = Number((candle.buyVolume + trade.size).toFixed(6));
    } else {
      candle.sellVolume = Number((candle.sellVolume + trade.size).toFixed(6));
    }

    candle.delta = Number((candle.buyVolume - candle.sellVolume).toFixed(6));
  }

  private cloneCandle(candle: MutableCandle): NormalizedCandle {
    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      tradesCount: candle.tradesCount,
      buyVolume: candle.buyVolume,
      sellVolume: candle.sellVolume,
      delta: candle.delta,
      isClosed: candle.isClosed
    };
  }

  private recordTradeId(tradeId: string): void {
    this.recentTradeIds.add(tradeId);
    this.tradeIdQueue.push(tradeId);
    if (this.tradeIdQueue.length > this.maxDeduplicationWindow) {
      const evicted = this.tradeIdQueue.shift();
      if (evicted) this.recentTradeIds.delete(evicted);
    }
  }

  public reset(): void {
    this.currentCandle = null;
    this.closedCandles.clear();
    this.recentTradeIds.clear();
    this.tradeIdQueue = [];
  }
}
