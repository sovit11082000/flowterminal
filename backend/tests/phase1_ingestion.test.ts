import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeTrade,
  parsePublicTradePayload
} from '../src/normalizers/tradeNormalizer.js';
import { OrderBookState } from '../src/normalizers/orderbookNormalizer.js';

describe('Phase 1: Trade Normalizer Tests', () => {
  it('correctly normalizes valid Buy and Sell trade items', () => {
    const rawBuy = {
      T: 1728734400000,
      s: 'BTCUSDT',
      S: 'Buy',
      v: '0.250',
      p: '64500.50',
      i: 'bybit_trade_001',
      BT: false
    };
    const buyResult = normalizeTrade(rawBuy);
    expect(buyResult).not.toBeNull();
    expect(buyResult?.symbol).toBe('BTCUSDT');
    expect(buyResult?.timestamp).toBe(1728734400000);
    expect(buyResult?.side).toBe('Buy');
    expect(buyResult?.price).toBe(64500.5);
    expect(buyResult?.size).toBe(0.25);
    expect(buyResult?.tradeId).toBe('bybit_trade_001');
    expect(buyResult?.isBlockTrade).toBe(false);

    const rawSell = {
      T: 1728734400100,
      s: 'BTCUSDT',
      S: 'Sell',
      v: '1.500',
      p: '64500.00',
      i: 'bybit_trade_002',
      BT: true
    };
    const sellResult = normalizeTrade(rawSell);
    expect(sellResult).not.toBeNull();
    expect(sellResult?.side).toBe('Sell');
    expect(sellResult?.isBlockTrade).toBe(true);
  });

  it('rejects invalid payloads, missing keys, and non-finite numbers', () => {
    expect(normalizeTrade(null)).toBeNull();
    expect(normalizeTrade(undefined)).toBeNull();
    expect(normalizeTrade('invalid_string')).toBeNull();
    expect(normalizeTrade({})).toBeNull();

    // Invalid or missing symbol
    expect(normalizeTrade({ T: 1728734400000, s: '', S: 'Buy', v: '0.1', p: '64000', i: '1' })).toBeNull();

    // Invalid or non-positive timestamp
    expect(normalizeTrade({ T: -1, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '64000', i: '1' })).toBeNull();
    expect(normalizeTrade({ T: 'not_a_number', s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '64000', i: '1' })).toBeNull();

    // Invalid price (zero, negative, NaN)
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '0', i: '1' })).toBeNull();
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '-64000', i: '1' })).toBeNull();
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: 'NaN', i: '1' })).toBeNull();

    // Invalid size (zero, negative, NaN)
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0', p: '64000', i: '1' })).toBeNull();
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '-0.5', p: '64000', i: '1' })).toBeNull();

    // Invalid side
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Hold', v: '0.1', p: '64000', i: '1' })).toBeNull();

    // Missing trade ID
    expect(normalizeTrade({ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '64000', i: '' })).toBeNull();
  });

  it('validates topic and preserves trades occurring in the same millisecond', () => {
    const validBatch = {
      topic: 'publicTrade.BTCUSDT',
      type: 'snapshot',
      ts: 1728734400005,
      data: [
        { T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '64500', i: 'id_1' },
        { T: 1728734400000, s: 'BTCUSDT', S: 'Sell', v: '0.2', p: '64500', i: 'id_2' },
        { T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.3', p: '64501', i: 'id_3' }
      ]
    };

    const parsed = parsePublicTradePayload(validBatch);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].tradeId).toBe('id_1');
    expect(parsed[1].tradeId).toBe('id_2');
    expect(parsed[2].tradeId).toBe('id_3');
    expect(parsed[0].timestamp).toBe(parsed[1].timestamp);

    // Rejects mismatched or non-trade topic
    const wrongTopic = {
      topic: 'orderbook.50.BTCUSDT',
      data: [{ T: 1728734400000, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '64500', i: 'id_1' }]
    };
    expect(parsePublicTradePayload(wrongTopic)).toHaveLength(0);
    expect(parsePublicTradePayload(null)).toHaveLength(0);
  });
});

describe('Phase 1: OrderBook Engine State Tests', () => {
  let orderBook: OrderBookState;

  beforeEach(() => {
    orderBook = new OrderBookState();
  });

  it('correctly initializes state from a valid snapshot', () => {
    const snapshotPayload = {
      topic: 'orderbook.50.BTCUSDT',
      type: 'snapshot',
      ts: 1728734400000,
      data: {
        s: 'BTCUSDT',
        b: [
          ['64000.00', '1.500'],
          ['63990.00', '3.000'],
          ['63980.00', '5.000']
        ],
        a: [
          ['64010.00', '0.800'],
          ['64020.00', '2.200'],
          ['64030.00', '4.000']
        ],
        u: 1001,
        seq: 50001
      }
    };

    const isOk = orderBook.processSnapshot(snapshotPayload);
    expect(isOk).toBe(true);

    const status = orderBook.getStatus();
    expect(status.isSynchronized).toBe(true);
    expect(status.bestBid).toBe(64000);
    expect(status.bestAsk).toBe(64010);
    expect(status.spread).toBe(10);
    expect(status.bidDepthCount).toBe(3);
    expect(status.askDepthCount).toBe(3);
    expect(status.lastUpdateId).toBe(1001);
    expect(status.lastSeq).toBe(50001);

    const sortedBids = orderBook.getSortedBids();
    expect(sortedBids[0]).toEqual([64000, 1.5]);
    expect(sortedBids[1]).toEqual([63990, 3]);

    const sortedAsks = orderBook.getSortedAsks();
    expect(sortedAsks[0]).toEqual([64010, 0.8]);
    expect(sortedAsks[1]).toEqual([64020, 2.2]);
  });

  it('rejects malformed snapshots and non-snapshot payload types', () => {
    expect(orderBook.processSnapshot(null)).toBe(false);
    expect(orderBook.processSnapshot({ type: 'delta', data: {} })).toBe(false);
    expect(orderBook.processSnapshot({ type: 'snapshot', data: { b: 'not_an_array', a: [] } })).toBe(false);

    // Empty book cannot be synchronized
    const emptySnap = {
      type: 'snapshot',
      data: { s: 'BTCUSDT', b: [], a: [], u: 1, seq: 1 }
    };
    expect(orderBook.processSnapshot(emptySnap)).toBe(false);
    expect(orderBook.getStatus().isSynchronized).toBe(false);
  });

  it('applies delta updates and deletes zero-size price levels', () => {
    orderBook.processSnapshot({
      type: 'snapshot',
      data: {
        s: 'BTCUSDT',
        b: [
          ['64000.00', '1.000'],
          ['63990.00', '2.000']
        ],
        a: [
          ['64010.00', '1.000'],
          ['64020.00', '2.000']
        ],
        u: 100,
        seq: 500
      }
    });

    const deltaPayload = {
      type: 'delta',
      data: {
        s: 'BTCUSDT',
        b: [
          ['64000.00', '0'], // Delete existing best bid
          ['63995.00', '4.500'] // Insert new level
        ],
        a: [
          ['64010.00', '2.500'], // Update existing best ask size
          ['64020.00', '0'] // Delete level
        ],
        u: 101,
        seq: 501
      }
    };

    const isOk = orderBook.processDelta(deltaPayload);
    expect(isOk).toBe(true);

    const status = orderBook.getStatus();
    expect(status.isSynchronized).toBe(true);
    expect(status.bestBid).toBe(63995);
    expect(status.bestAsk).toBe(64010);
    expect(status.bidDepthCount).toBe(2);
    expect(status.askDepthCount).toBe(1);
    expect(status.lastUpdateId).toBe(101);
    expect(status.lastSeq).toBe(501);
  });

  it('detects crossed-book conditions and sets synchronized to false', () => {
    orderBook.processSnapshot({
      type: 'snapshot',
      data: {
        s: 'BTCUSDT',
        b: [['64000.00', '1.000']],
        a: [['64010.00', '1.000']],
        u: 100,
        seq: 500
      }
    });
    expect(orderBook.getStatus().isSynchronized).toBe(true);

    // Delta pushes bid >= ask (64015 >= 64010)
    const crossedDelta = {
      type: 'delta',
      data: {
        s: 'BTCUSDT',
        b: [['64015.00', '2.000']],
        a: [],
        u: 102,
        seq: 502
      }
    };

    const isOk = orderBook.processDelta(crossedDelta);
    expect(isOk).toBe(false);
    expect(orderBook.getStatus().isSynchronized).toBe(false);
  });

  it('resets state completely on reset() call', () => {
    orderBook.processSnapshot({
      type: 'snapshot',
      data: {
        s: 'BTCUSDT',
        b: [['64000.00', '1.000']],
        a: [['64010.00', '1.000']],
        u: 100,
        seq: 500
      }
    });
    expect(orderBook.getStatus().isSynchronized).toBe(true);

    orderBook.reset();

    const status = orderBook.getStatus();
    expect(status.isSynchronized).toBe(false);
    expect(status.bestBid).toBeNull();
    expect(status.bestAsk).toBeNull();
    expect(status.spread).toBeNull();
    expect(status.bidDepthCount).toBe(0);
    expect(status.askDepthCount).toBe(0);
    expect(status.lastUpdateId).toBe(0);
    expect(status.lastSeq).toBe(0);
  });
});