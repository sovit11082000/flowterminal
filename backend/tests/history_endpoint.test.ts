import { describe, it, expect } from 'vitest';
import { BybitRestService } from '../src/services/bybitRestService.js';

describe('HTTP /api/history Unit & Contract Tests', () => {
  it('rejects unsupported intervals', async () => {
    const service = new BybitRestService();
    await expect(
      service.fetchHistoricalCandles({
        symbol: 'BTCUSDT',
        timeframe: '15m' as any
      })
    ).rejects.toThrow('Unsupported timeframe');
  });

  it('rejects inverted time ranges (start >= end)', async () => {
    const service = new BybitRestService();
    await expect(
      service.fetchHistoricalCandles({
        symbol: 'BTCUSDT',
        timeframe: '1m',
        startTimeMs: 1728734400000,
        endTimeMs: 1728734300000
      })
    ).rejects.toThrow('startTimeMs (1728734400000) must be strictly less than endTimeMs (1728734300000)');
  });

  it('correctly processes and normalizes mocked Bybit Kline data in chronological order', async () => {
    const mockFetch = async () => {
      const payload = {
        retCode: 0,
        retMsg: 'OK',
        result: {
          category: 'linear',
          symbol: 'BTCUSDT',
          list: [
            // Row 2 (Newer candle: 12:01:00)
            ['1728734460000', '64100', '64150', '64090', '64120', '1.5', '96180'],
            // Row 1 (Older candle: 12:00:00 - aligns with start boundary)
            ['1728734400000', '64000', '64100', '63950', '64050', '2.0', '128100']
          ]
        }
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    };

    const service = new BybitRestService({ fetchFn: mockFetch as any });
    const result = await service.fetchHistoricalCandles({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      startTimeMs: 1728734400000, // Exact boundary match for completeness
      endTimeMs: 1728734500000
    });

    expect(result.candles).toHaveLength(2);
    // Ascending sort check
    expect(result.candles[0].time).toBe(1728734400);
    expect(result.candles[1].time).toBe(1728734460);
    expect(result.candles[0].open).toBe(64000);
    expect(result.candles[1].close).toBe(64120);
    expect(result.metadata.isComplete).toBe(true);
    expect(result.metadata.terminationReason).toBe('RANGE_EXHAUSTED');
  });
});