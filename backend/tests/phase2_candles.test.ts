import { describe, it, expect, beforeEach } from 'vitest';
import { BarAggregator } from '../src/engine/barAggregator.js';
import { NormalizedTrade } from '../src/types/market.js';

describe('Phase 2: BarAggregator Candlestick Engine Tests', () => {
  let agg1m: BarAggregator;
  let agg5m: BarAggregator;

  beforeEach(() => {
    agg1m = new BarAggregator('1m');
    agg5m = new BarAggregator('5m');
  });

  const makeTrade = (
    timestamp: number,
    price: number,
    size: number,
    side: 'Buy' | 'Sell',
    tradeId: string
  ): NormalizedTrade => ({
    symbol: 'BTCUSDT',
    timestamp,
    price,
    size,
    side,
    tradeId
  });

  it('aggregates first trade correctly as Open, High, Low, and Close', () => {
    const trade = makeTrade(1728734415000, 64200.5, 0.5, 'Buy', 't1'); // 12:00:15
    const bar = agg1m.processTrade(trade);

    expect(bar).not.toBeNull();
    expect(bar?.open).toBe(64200.5);
    expect(bar?.high).toBe(64200.5);
    expect(bar?.low).toBe(64200.5);
    expect(bar?.close).toBe(64200.5);
    expect(bar?.volume).toBe(0.5);
    expect(bar?.buyVolume).toBe(0.5);
    expect(bar?.sellVolume).toBe(0);
    expect(bar?.delta).toBe(0.5);
    expect(bar?.tradesCount).toBe(1);
    expect(bar?.time).toBe(1728734400); // 12:00:00 bucket
    expect(bar?.isClosed).toBe(false);
  });

  it('updates High, Low, Close, and Delta progressively in the same bucket', () => {
    agg1m.processTrade(makeTrade(1728734410000, 64200, 1.0, 'Buy', 't1'));
    agg1m.processTrade(makeTrade(1728734420000, 64300, 2.0, 'Buy', 't2')); // New High
    agg1m.processTrade(makeTrade(1728734430000, 64150, 0.5, 'Sell', 't3')); // New Low
    const finalBar = agg1m.processTrade(makeTrade(1728734440000, 64250, 1.5, 'Sell', 't4')); // Latest Close

    expect(finalBar).not.toBeNull();
    expect(finalBar?.open).toBe(64200);
    expect(finalBar?.high).toBe(64300);
    expect(finalBar?.low).toBe(64150);
    expect(finalBar?.close).toBe(64250);
    expect(finalBar?.volume).toBe(5.0);
    expect(finalBar?.buyVolume).toBe(3.0);
    expect(finalBar?.sellVolume).toBe(2.0);
    expect(finalBar?.delta).toBe(1.0);
    expect(finalBar?.tradesCount).toBe(4);
  });

  it('aligns 5-minute bucket boundaries correctly', () => {
    // 12:03:45 should land in 12:00:00 bucket
    const t1 = makeTrade(1728734625000, 64000, 1.0, 'Buy', 't1');
    const bar = agg5m.processTrade(t1);

    expect(bar).not.toBeNull();
    expect(bar?.time).toBe(1728734400); // 12:00:00 in seconds
  });

  it('closes current candle and initializes next candle on bucket rollover', () => {
    // 12:00:30 (Bucket 12:00:00)
    agg1m.processTrade(makeTrade(1728734430000, 64100, 1.0, 'Buy', 't1'));

    // 12:01:05 (Bucket 12:01:00)
    const newBar = agg1m.processTrade(makeTrade(1728734465000, 64200, 2.0, 'Sell', 't2'));

    expect(newBar).not.toBeNull();
    expect(newBar?.time).toBe(1728734460); // 12:01:00 in seconds
    expect(newBar?.open).toBe(64200);
    expect(newBar?.tradesCount).toBe(1);

    const recent = agg1m.getRecentCandles();
    expect(recent.length).toBe(2);
    expect(recent[0].isClosed).toBe(true);
    expect(recent[0].close).toBe(64100);
    expect(recent[1].isClosed).toBe(false);
  });

  it('preserves distinct trades that have identical timestamps', () => {
    const bar1 = agg1m.processTrade(makeTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
    const bar2 = agg1m.processTrade(makeTrade(1728734410000, 64005, 0.5, 'Sell', 't2'));

    expect(bar2?.tradesCount).toBe(2);
    expect(bar2?.volume).toBe(1.5);
    expect(bar2?.delta).toBe(0.5);
  });

  it('deduplicates identical trade IDs', () => {
    agg1m.processTrade(makeTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
    const dupResult = agg1m.processTrade(makeTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));

    expect(dupResult).toBeNull();
    expect(agg1m.getCurrentCandle()?.tradesCount).toBe(1);
    expect(agg1m.getCurrentCandle()?.volume).toBe(1.0);
  });

  it('updates closed candle if late trade arrives within max bounded lateness', () => {
    // Bucket 12:00:00
    agg1m.processTrade(makeTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
    // Bucket 12:01:00 (rolls 12:00)
    agg1m.processTrade(makeTrade(1728734470000, 64050, 1.0, 'Buy', 't2'));

    // Arriving 20 seconds late for 12:00 bucket with a higher price
    const correction = agg1m.processTrade(makeTrade(1728734420000, 64150, 0.5, 'Buy', 't3_late'));

    expect(correction).not.toBeNull();
    expect(correction?.time).toBe(1728734400);
    expect(correction?.high).toBe(64150);
    expect(correction?.volume).toBe(1.5);
  });

  it('rejects invalid prices, negative sizes and non-finite timestamps', () => {
    expect(agg1m.processTrade(makeTrade(1728734410000, NaN, 1.0, 'Buy', 't_bad1'))).toBeNull();
    expect(agg1m.processTrade(makeTrade(1728734410000, 64000, -0.5, 'Buy', 't_bad2'))).toBeNull();
    expect(agg1m.processTrade(makeTrade(1728734410000, 64000, 0, 'Buy', 't_bad3'))).toBeNull();
  });
});