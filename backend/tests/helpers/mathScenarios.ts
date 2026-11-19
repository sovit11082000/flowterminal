import { buildDerivedContext, type AgentSnapshot } from '../../src/agents/orderFlowCouncil.js';

type Candle = AgentSnapshot['candles'][number];
type Footprint = AgentSnapshot['footprints'][number];

/** Scenario prices are written around 100 for readability; this maps 1 unit -> 60 USD so a BTC-like 100,000 base results. */
export const px = (p: number): number => Number((100000 + (p - 100) * 60).toFixed(2));
const bar = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ time: 1_800_000_000 + i * 60, open: px(open), high: px(high), low: px(low), close: px(close) });

/**
 * 40 one-minute candles: a quiet drift, a clear swing low at 98.0, a sweep of it (wick 97.4, close back above),
 * a strong displacement candle and a break of the earlier swing high (100.6).
 * mirror=true flips the whole picture around 100 to produce the bearish twin.
 */
export function bullishCandles(mirror = false): Candle[] {
  const rows: Array<[number, number, number, number]> = [];
  const zig = [0, 0.3, 0.5, 0.3, 0, -0.2];
  for (let i = 0; i < 24; i++) {
    const c = 100 + zig[i % 6] - i * 0.01;
    rows.push([c - 0.05, c + 0.25, c - 0.25, c + 0.05]);
  }
  // 24..29: build the swing high 100.6 at index 27
  rows.push([100.0, 100.3, 99.8, 100.1]);   // 24
  rows.push([100.1, 100.4, 99.9, 100.3]);   // 25
  rows.push([100.3, 100.5, 100.0, 100.2]);  // 26
  rows.push([100.2, 100.6, 100.0, 100.1]);  // 27  swing high
  rows.push([100.1, 100.3, 99.7, 99.8]);    // 28
  rows.push([99.8, 100.0, 99.4, 99.5]);     // 29
  // 30..35: slide into a swing low 98.0 at index 33
  rows.push([99.5, 99.6, 99.0, 99.1]);      // 30
  rows.push([99.1, 99.2, 98.7, 98.8]);      // 31
  rows.push([98.8, 98.9, 98.4, 98.5]);      // 32
  rows.push([98.5, 98.6, 98.0, 98.4]);      // 33  swing low
  rows.push([98.4, 98.9, 98.4, 98.8]);      // 34
  rows.push([98.8, 99.0, 98.6, 98.7]);      // 35
  rows.push([98.7, 98.9, 97.4, 98.9]);      // 36  sweep of 98.0 and reclaim
  rows.push([98.9, 99.4, 98.8, 99.3]);      // 37
  rows.push([99.3, 101.0, 99.2, 100.9]);    // 38  displacement, closes above 100.6
  rows.push([100.9, 101.3, 100.8, 101.2]);  // 39
  return rows.map(([o, h, l, c], i) => (mirror
    ? bar(i, 200 - o, 200 - l, 200 - h, 200 - c)
    : bar(i, o, h, l, c)));
}

/** Eight closed footprints aligned with the last eight candles; the latest one carries bullish (or bearish) order flow. */
export function flowFootprints(candles: Candle[], dir: 'LONG' | 'SHORT' = 'LONG'): Footprint[] {
  const sign = dir === 'LONG' ? 1 : -1;
  return candles.slice(-8).map((c, i, arr) => {
    const latest = i === arr.length - 1;
    const range = c.high - c.low;
    const delta = latest ? 40 * sign : 4 * sign;
    const levels = latest
      ? [0, 1, 2, 3].map((k) => {
          const price = Number((c.low + 6 * k).toFixed(2));
          return dir === 'LONG'
            ? { price, bidVolume: 4, askVolume: 20, totalVolume: 24 }
            : { price, bidVolume: 20, askVolume: 4, totalVolume: 24 };
        })
      : [{ price: c.close, bidVolume: 20, askVolume: 22, totalVolume: 42 }];
    return {
      time: c.time, open: c.open ?? c.close, high: c.high, low: c.low, close: c.close,
      totalVolume: 100, buyVolume: 50 + delta / 2, sellVolume: 50 - delta / 2, delta,
      cumulativeDelta: (i + 1) * 20 * sign, // +/-20 per bar -> clear CVD trend
      pocPrice: c.close - sign * range * 0.4, // POC under price (long) / over price (short)
      isClosed: true, priceLevels: levels
    };
  });
}

export function scenarioSnapshot(dir: 'LONG' | 'SHORT', withDailyRanges = true): AgentSnapshot {
  const candles = bullishCandles(dir === 'SHORT');
  const price = candles[candles.length - 1].close;
  const snapshot: AgentSnapshot = {
    symbol: 'BTCUSDT', timeframe: '1m', feedStatus: 'LIVE', lastTradeAt: Date.now(), latestPrice: price,
    candles, footprints: flowFootprints(candles, dir),
    trades: [{ timestamp: Date.now(), side: dir === 'LONG' ? 'Buy' : 'Sell', price, size: 1 }],
    bids: [[price - 0.05, 3]], asks: [[price + 0.05, 3]]
  };
  if (withDailyRanges) {
    // Prior day low 98.0 (long case) / prior day high 102.0 (short case) was raided and reclaimed by the sweep candle.
    snapshot.technicalContext = {
      smc: { bias: 'UNAVAILABLE', events: [], zones: [], liquidity: [] },
      ict: { po3: [], dailyRanges: dir === 'LONG'
        ? [{ day: 1, high: px(104), low: px(96) }, { day: 2, high: px(103), low: px(98.0) }, { day: 3, high: px(101.3), low: px(97.4) }]
        : [{ day: 1, high: px(104), low: px(96) }, { day: 2, high: px(102.0), low: px(97) }, { day: 3, high: px(102.6), low: px(98.7) }] }
    };
  }
  snapshot.derivedContext = buildDerivedContext(snapshot);
  return snapshot;
}
