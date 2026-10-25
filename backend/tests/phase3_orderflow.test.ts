import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrderFlowAggregator,
  PriceLevelVolume
} from '../src/engine/orderFlowAggregator.js';
import { NormalizedTrade } from '../src/types/market.js';

describe('Phase 3: OrderFlow & Footprint Aggregation Engine Tests', () => {
  let agg1m: OrderFlowAggregator;
  let agg5m: OrderFlowAggregator;

  beforeEach(() => {
    agg1m = new OrderFlowAggregator({ timeframe: '1m', tickSize: 0.1 });
    agg5m = new OrderFlowAggregator({ timeframe: '5m', tickSize: 0.1 });
  });

  const createTrade = (
    timestamp: number,
    price: number,
    size: number,
    side: 'Buy' | 'Sell',
    tradeId: string,
    symbol: string = 'BTCUSDT'
  ): NormalizedTrade => ({
    symbol,
    timestamp,
    price,
    size,
    side,
    tradeId
  });

  // ==========================================
  // 1. BASIC AGGREGATION & PRICE CLUSTERS
  // ==========================================
  describe('Basic Aggregation & Price Clusters', () => {
    it('aggregates a single Buy trade into askVolume and positive delta', () => {
      const trade = createTrade(1728734410000, 64000.5, 0.25, 'Buy', 't_buy_1');
      const bar = agg1m.processTrade(trade);

      expect(bar).not.toBeNull();
      expect(bar?.buyVolume).toBe(0.25);
      expect(bar?.sellVolume).toBe(0);
      expect(bar?.totalVolume).toBe(0.25);
      expect(bar?.delta).toBe(0.25);
      expect(bar?.tradesCount).toBe(1);

      const level = bar?.priceLevels.get(64000.5);
      expect(level).toBeDefined();
      expect(level?.askVolume).toBe(0.25);
      expect(level?.bidVolume).toBe(0);
      expect(level?.totalVolume).toBe(0.25);
      expect(level?.delta).toBe(0.25);
      expect(level?.tradesCount).toBe(1);
    });

    it('aggregates a single Sell trade into bidVolume and negative delta', () => {
      const trade = createTrade(1728734410000, 64000.5, 0.5, 'Sell', 't_sell_1');
      const bar = agg1m.processTrade(trade);

      expect(bar).not.toBeNull();
      expect(bar?.buyVolume).toBe(0);
      expect(bar?.sellVolume).toBe(0.5);
      expect(bar?.totalVolume).toBe(0.5);
      expect(bar?.delta).toBe(-0.5);
      expect(bar?.tradesCount).toBe(1);

      const level = bar?.priceLevels.get(64000.5);
      expect(level).toBeDefined();
      expect(level?.askVolume).toBe(0);
      expect(level?.bidVolume).toBe(0.5);
      expect(level?.totalVolume).toBe(0.5);
      expect(level?.delta).toBe(-0.5);
      expect(level?.tradesCount).toBe(1);
    });

    it('sums multiple Buy and Sell trades at the same price level accurately', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 1.0, 'Buy', 't1'));
      agg1m.processTrade(createTrade(1728734415000, 64000.0, 0.4, 'Sell', 't2'));
      const bar = agg1m.processTrade(createTrade(1728734420000, 64000.0, 0.6, 'Buy', 't3'));

      expect(bar?.buyVolume).toBe(1.6);
      expect(bar?.sellVolume).toBe(0.4);
      expect(bar?.totalVolume).toBe(2.0);
      expect(bar?.delta).toBe(1.2);
      expect(bar?.tradesCount).toBe(3);

      const level = bar?.priceLevels.get(64000.0);
      expect(level?.askVolume).toBe(1.6);
      expect(level?.bidVolume).toBe(0.4);
      expect(level?.totalVolume).toBe(2.0);
      expect(level?.delta).toBe(1.2);
      expect(level?.tradesCount).toBe(3);
    });

    it('keeps volume clusters isolated across different price levels', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 1.0, 'Buy', 't1'));
      agg1m.processTrade(createTrade(1728734412000, 64001.0, 2.0, 'Sell', 't2'));
      const bar = agg1m.processTrade(createTrade(1728734415000, 64002.0, 0.5, 'Buy', 't3'));

      expect(bar?.priceLevels.size).toBe(3);
      expect(bar?.priceLevels.get(64000.0)?.totalVolume).toBe(1.0);
      expect(bar?.priceLevels.get(64001.0)?.totalVolume).toBe(2.0);
      expect(bar?.priceLevels.get(64002.0)?.totalVolume).toBe(0.5);
    });

    it('selects Point of Control (POC) as the price level with highest volume', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 1.0, 'Buy', 't1'));
      agg1m.processTrade(createTrade(1728734415000, 64005.0, 3.5, 'Buy', 't2')); // Maximum volume level
      const bar = agg1m.processTrade(createTrade(1728734420000, 64002.0, 0.5, 'Sell', 't3'));

      expect(bar?.pocPrice).toBe(64005.0);
      expect(bar?.pocVolume).toBe(3.5);
    });

    it('retains initial POC price when an equal volume tie occurs (strict greater than rule)', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 2.0, 'Buy', 't1'));
      // Second level matches volume exactly (2.0)
      const bar = agg1m.processTrade(createTrade(1728734415000, 64010.0, 2.0, 'Sell', 't2'));

      // Due to `level.totalVolume > bar.pocVolume`, first level remains POC
      expect(bar?.pocPrice).toBe(64000.0);
      expect(bar?.pocVolume).toBe(2.0);
    });
  });

  // ==========================================
  // 2. TIMEFRAME BOUNDARIES & ROLLOVERS
  // ==========================================
  describe('Timeframe Boundaries & Rollovers', () => {
    it('aligns 1m bucket boundary correctly and rolls over to a new bar', () => {
      // 12:00:59.999 -> lands in 12:00:00 bucket (1728734400)
      const bar1 = agg1m.processTrade(createTrade(1728734459999, 64000, 1.0, 'Buy', 't1'));
      expect(bar1?.time).toBe(1728734400);
      expect(bar1?.isClosed).toBe(false);

      // Exactly at 12:01:00.000 -> rollover to 12:01:00 bucket (1728734460)
      const bar2 = agg1m.processTrade(createTrade(1728734460000, 64050, 0.8, 'Sell', 't2'));
      expect(bar2?.time).toBe(1728734460);
      expect(bar2?.isClosed).toBe(false);
      expect(bar2?.open).toBe(64050);

      // Verify previous bar is marked closed
      const recentBars = agg1m.getRecentBars();
      expect(recentBars.length).toBe(2);
      expect(recentBars[0].time).toBe(1728734400);
      expect(recentBars[0].isClosed).toBe(true);
    });

    it('aligns 5m bucket boundaries across multiple minute marks', () => {
      // 12:04:30 lands in 12:00:00 bucket
      const bar1 = agg5m.processTrade(createTrade(1728734670000, 64000, 1.0, 'Buy', 't1'));
      expect(bar1?.time).toBe(1728734400);

      // 12:05:01 rolls over to 12:05:00 bucket (1728734400 + 300 = 1728734700)
      const bar2 = agg5m.processTrade(createTrade(1728734701000, 64100, 2.0, 'Buy', 't2'));
      expect(bar2?.time).toBe(1728734700);
    });

    it('does not create synthetic bars for empty intervals without trades', () => {
      // Bar 1: 12:00:00
      agg1m.processTrade(createTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
      // Bar 2 arrives 10 minutes later: 12:10:00
      agg1m.processTrade(createTrade(1728735010000, 64500, 1.0, 'Buy', 't2'));

      const recentBars = agg1m.getRecentBars();
      // Exactly 2 bars stored, zero synthetic bars generated
      expect(recentBars.length).toBe(2);
      expect(recentBars[0].time).toBe(1728734400);
      expect(recentBars[1].time).toBe(1728735000);
    });
  });

  // ==========================================
  // 3. DELTA & CUMULATIVE VOLUME DELTA (CVD)
  // ==========================================
  describe('Delta & Running CVD', () => {
    it('maintains a running CVD across sequential trades and bars', () => {
      // Bar 1: Buy 1.5 BTC, Sell 0.5 BTC -> Bar Delta = +1.0, Running CVD = +1.0
      agg1m.processTrade(createTrade(1728734410000, 64000, 1.5, 'Buy', 't1'));
      agg1m.processTrade(createTrade(1728734420000, 64000, 0.5, 'Sell', 't2'));

      expect(agg1m.getCurrentBar()?.delta).toBe(1.0);
      expect(agg1m.getRunningCvd()).toBe(1.0);

      // Bar 2: Sell 2.0 BTC -> Bar Delta = -2.0, Running CVD = 1.0 - 2.0 = -1.0
      const bar2 = agg1m.processTrade(createTrade(1728734470000, 64100, 2.0, 'Sell', 't3'));

      expect(bar2?.delta).toBe(-2.0);
      expect(bar2?.cumulativeDelta).toBe(-1.0);
      expect(agg1m.getRunningCvd()).toBe(-1.0);
    });

    it('resets running CVD to 0 on reset()', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000, 2.5, 'Buy', 't1'));
      expect(agg1m.getRunningCvd()).toBe(2.5);

      agg1m.reset();

      expect(agg1m.getRunningCvd()).toBe(0);
      expect(agg1m.getCurrentBar()).toBeNull();
      expect(agg1m.getRecentBars()).toHaveLength(0);
    });

    it('applies out-of-order trades to past closed bars and documents running CVD behavior', () => {
      // Bar 1 (12:00:00)
      agg1m.processTrade(createTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
      // Bar 2 (12:01:00) - rolls Bar 1
      agg1m.processTrade(createTrade(1728734470000, 64050, 1.0, 'Buy', 't2'));
      expect(agg1m.getRunningCvd()).toBe(2.0);

      // Late trade for Bar 1 (12:00:20)
      const updatedPastBar = agg1m.processTrade(createTrade(1728734420000, 64010, 0.5, 'Sell', 't3_late'));

      expect(updatedPastBar).not.toBeNull();
      expect(updatedPastBar?.time).toBe(1728734400);
      expect(updatedPastBar?.totalVolume).toBe(1.5);
      expect(updatedPastBar?.sellVolume).toBe(0.5);
      expect(updatedPastBar?.delta).toBe(0.5);

      // Verifies that running CVD absorbs late trade upon arrival: 2.0 - 0.5 = 1.5
      expect(agg1m.getRunningCvd()).toBe(1.5);
    });
  });

  // ==========================================
  // 4. DATA INTEGRITY & DEDUPLICATION
  // ==========================================
  describe('Data Integrity & Deduplication', () => {
    it('deduplicates identical trade IDs and ignores repeated trades', () => {
      const trade1 = createTrade(1728734410000, 64000, 1.0, 'Buy', 'trade_dup_1');
      const res1 = agg1m.processTrade(trade1);
      expect(res1).not.toBeNull();

      // Duplicate delivery
      const res2 = agg1m.processTrade(trade1);
      expect(res2).toBeNull();
      expect(agg1m.getCurrentBar()?.tradesCount).toBe(1);
      expect(agg1m.getCurrentBar()?.totalVolume).toBe(1.0);
    });

    it('rejects malformed trades with invalid prices, sizes, timestamps, or sides', () => {
      expect(agg1m.processTrade(null as any)).toBeNull();
      expect(agg1m.processTrade({} as any)).toBeNull();

      // Zero or negative price
      expect(agg1m.processTrade(createTrade(1728734410000, 0, 1.0, 'Buy', 'err1'))).toBeNull();
      expect(agg1m.processTrade(createTrade(1728734410000, -64000, 1.0, 'Buy', 'err2'))).toBeNull();
      expect(agg1m.processTrade(createTrade(1728734410000, NaN, 1.0, 'Buy', 'err3'))).toBeNull();

      // Zero or negative size
      expect(agg1m.processTrade(createTrade(1728734410000, 64000, 0, 'Buy', 'err4'))).toBeNull();
      expect(agg1m.processTrade(createTrade(1728734410000, 64000, -0.5, 'Buy', 'err5'))).toBeNull();

      // Non-positive or non-finite timestamp
      expect(agg1m.processTrade(createTrade(0, 64000, 1.0, 'Buy', 'err6'))).toBeNull();
      expect(agg1m.processTrade(createTrade(-1, 64000, 1.0, 'Buy', 'err7'))).toBeNull();

      // Invalid side
      expect(agg1m.processTrade(createTrade(1728734410000, 64000, 1.0, 'Hold' as any, 'err8'))).toBeNull();

      // Missing or empty tradeId
      expect(agg1m.processTrade(createTrade(1728734410000, 64000, 1.0, 'Buy', ''))).toBeNull();
    });

    it('evicts oldest trade IDs when deduplication ring buffer capacity is exceeded', () => {
      // Custom small deduplication window (capacity = 3)
      const smallAgg = new OrderFlowAggregator({ timeframe: '1m', maxDeduplicationWindow: 3 });

      smallAgg.processTrade(createTrade(1728734410000, 64000, 1.0, 'Buy', 'id_1'));
      smallAgg.processTrade(createTrade(1728734411000, 64000, 1.0, 'Buy', 'id_2'));
      smallAgg.processTrade(createTrade(1728734412000, 64000, 1.0, 'Buy', 'id_3'));

      // Pushing 4th trade evicts id_1 from deduplication memory
      smallAgg.processTrade(createTrade(1728734413000, 64000, 1.0, 'Buy', 'id_4'));

      // Re-submitting id_1 should now be accepted again
      const reprocessed = smallAgg.processTrade(createTrade(1728734414000, 64000, 1.0, 'Buy', 'id_1'));
      expect(reprocessed).not.toBeNull();
    });

    it('discards late trades that arrive for expired evicted historical bars', () => {
      // Historical retention limit of 1 bar
      const smallHistoryAgg = new OrderFlowAggregator({ timeframe: '1m', maxHistoricalBars: 1 });

      // Bar 1 (12:00:00)
      smallHistoryAgg.processTrade(createTrade(1728734410000, 64000, 1.0, 'Buy', 't1'));
      // Bar 2 (12:01:00) - retains Bar 1
      smallHistoryAgg.processTrade(createTrade(1728734470000, 64000, 1.0, 'Buy', 't2'));
      // Bar 3 (12:02:00) - evicts Bar 1 (exceeds maxHistoricalBars: 1)
      smallHistoryAgg.processTrade(createTrade(1728734530000, 64000, 1.0, 'Buy', 't3'));

      // Late trade arriving for evicted Bar 1 (12:00:20)
      const lateResult = smallHistoryAgg.processTrade(createTrade(1728734420000, 64000, 1.0, 'Buy', 't1_late'));
      expect(lateResult).toBeNull();
    });
  });

  // ==========================================
  // 5. PRICE LEVEL QUANTIZATION
  // ==========================================
  describe('Price Level Quantization', () => {
    it('quantizes prices correctly to default 0.10 tick size', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.54, 1.0, 'Buy', 't1')); // Rounds to 64000.5
      agg1m.processTrade(createTrade(1728734415000, 64000.51, 1.5, 'Buy', 't2')); // Rounds to 64000.5
      const bar = agg1m.processTrade(createTrade(1728734420000, 64000.58, 2.0, 'Buy', 't3')); // Rounds to 64000.6

      expect(bar?.priceLevels.size).toBe(2);
      expect(bar?.priceLevels.get(64000.5)?.totalVolume).toBe(2.5);
      expect(bar?.priceLevels.get(64000.6)?.totalVolume).toBe(2.0);
    });

    it('quantizes prices according to custom tick size (e.g., 1.0)', () => {
      const aggTick1 = new OrderFlowAggregator({ timeframe: '1m', tickSize: 1.0 });

      aggTick1.processTrade(createTrade(1728734410000, 64000.2, 1.0, 'Buy', 't1'));
      aggTick1.processTrade(createTrade(1728734412000, 64000.7, 2.0, 'Sell', 't2')); // 64001.0
      const bar = aggTick1.processTrade(createTrade(1728734415000, 64000.4, 0.5, 'Buy', 't3')); // 64000.0

      expect(bar?.priceLevels.size).toBe(2);
      expect(bar?.priceLevels.get(64000.0)?.totalVolume).toBe(1.5);
      expect(bar?.priceLevels.get(64001.0)?.totalVolume).toBe(2.0);
    });

    it('falls back safely to 0.1 tick size if non-positive tick size is passed', () => {
      const fallbackAgg = new OrderFlowAggregator({ timeframe: '1m', tickSize: -0.5 });
      const bar = fallbackAgg.processTrade(createTrade(1728734410000, 64000.24, 1.0, 'Buy', 't1'));

      // Expect quantization to 0.1 (64000.2)
      expect(bar?.priceLevels.has(64000.2)).toBe(true);
    });
  });

  // ==========================================
  // 6. SNAPSHOT & SERIALIZATION
  // ==========================================
  describe('Snapshot & Serialization', () => {
    it('serializes FootprintBar with priceLevels as a descending sorted array', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 1.0, 'Buy', 't1'));
      agg1m.processTrade(createTrade(1728734415000, 64010.0, 3.0, 'Buy', 't2'));
      agg1m.processTrade(createTrade(1728734420000, 64005.0, 2.0, 'Sell', 't3'));

      const liveBar = agg1m.getCurrentBar();
      expect(liveBar).not.toBeNull();

      const serialized = agg1m.serializeBar(liveBar!);

      expect(Array.isArray(serialized.priceLevels)).toBe(true);
      expect(serialized.priceLevels).toHaveLength(3);

      // Verify strict descending price order: 64010 -> 64005 -> 64000
      expect(serialized.priceLevels[0].price).toBe(64010.0);
      expect(serialized.priceLevels[1].price).toBe(64005.0);
      expect(serialized.priceLevels[2].price).toBe(64000.0);

      expect(serialized.pocPrice).toBe(64010.0);
      expect(serialized.pocVolume).toBe(3.0);
      expect(serialized.totalVolume).toBe(6.0);
    });

    it('prevents external mutation of serialized priceLevels from corrupting internal aggregator state', () => {
      agg1m.processTrade(createTrade(1728734410000, 64000.0, 1.0, 'Buy', 't1'));
      const liveBar = agg1m.getCurrentBar()!;
      const serialized = agg1m.serializeBar(liveBar);

      // Mutate serialized array
      serialized.priceLevels.pop();
      serialized.priceLevels.push({
        price: 99999,
        bidVolume: 999,
        askVolume: 999,
        totalVolume: 1998,
        delta: 0,
        tradesCount: 1
      });

      // Internal Map in live bar remains intact and unmodified
      expect(liveBar.priceLevels.size).toBe(1);
      expect(liveBar.priceLevels.has(64000.0)).toBe(true);
      expect(liveBar.priceLevels.has(99999)).toBe(false);
    });
  });
});