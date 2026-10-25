import type { SerializedFootprintBar } from '../types/market.js';

export interface VolumeProfileLevel {
  price: number;
  bid: number;
  ask: number;
  total: number;
}

export interface VolumeProfileResult {
  levels: VolumeProfileLevel[];
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  capturedBars: number;
  bucketSize: number;
  sourceRange: [number, number] | null;
}

// Profile rows are deliberately wider than exchange ticks. These are display
// bucket sizes, not claims about the exchange's minimum price increment.
const PROFILE_BUCKET_SIZE: Record<string, number> = {
  BTCUSDT: 10, ETHUSDT: 1, SOLUSDT: 0.1, XRPUSDT: 0.001,
  BNBUSDT: 0.1, DOGEUSDT: 0.0001, ADAUSDT: 0.001,
  LINKUSDT: 0.01, AVAXUSDT: 0.01, XAUTUSDT: 0.5
};

export function calculateVolumeProfile(
  bars: Iterable<SerializedFootprintBar>,
  symbol: string,
  from: number,
  to: number,
  valueAreaPercent = 0.70
): VolumeProfileResult | null {
  const bucketSize = PROFILE_BUCKET_SIZE[symbol] ?? 0.1;
  const buckets = new Map<number, { bid: number; ask: number }>();
  let capturedBars = 0;
  let sourceStart = Number.POSITIVE_INFINITY;
  let sourceEnd = 0;

  for (const bar of bars) {
    if (bar.symbol !== symbol || !bar.priceLevels.length) continue;
    if (bar.time < sourceStart) sourceStart = bar.time;
    if (bar.time > sourceEnd) sourceEnd = bar.time;
    if (bar.time < from || bar.time > to) continue;
    capturedBars++;
    for (const level of bar.priceLevels) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.bidVolume) || !Number.isFinite(level.askVolume)) continue;
      const index = Math.round(level.price / bucketSize);
      const bucket = buckets.get(index) ?? { bid: 0, ask: 0 };
      bucket.bid += level.bidVolume;
      bucket.ask += level.askVolume;
      buckets.set(index, bucket);
    }
  }

  if (buckets.size === 0) {
    return Number.isFinite(sourceStart)
      ? { levels: [], poc: 0, vah: 0, val: 0, totalVolume: 0, capturedBars, bucketSize, sourceRange: [sourceStart, sourceEnd] }
      : null;
  }
  const minIndex = Math.min(...buckets.keys());
  const maxIndex = Math.max(...buckets.keys());
  const levels: VolumeProfileLevel[] = [];
  for (let index = minIndex; index <= maxIndex; index++) {
    const bucket = buckets.get(index) ?? { bid: 0, ask: 0 };
    levels.push({ price: index * bucketSize, ...bucket, total: bucket.bid + bucket.ask });
  }

  const totalVolume = levels.reduce((sum, level) => sum + level.total, 0);
  if (!(totalVolume > 0)) return null;

  // POC is the highest-volume bucket. In a tie, use the lower price to keep
  // the output deterministic across reloads and JavaScript runtimes.
  let pocIndex = 0;
  for (let index = 1; index < levels.length; index++) {
    if (levels[index].total > levels[pocIndex].total) pocIndex = index;
  }

  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let valueAreaVolume = levels[pocIndex].total;
  const target = totalVolume * Math.max(0, Math.min(valueAreaPercent, 1));
  while (valueAreaVolume < target && (lowIndex > 0 || highIndex < levels.length - 1)) {
    const below = lowIndex > 0 ? levels[lowIndex - 1].total : -1;
    const above = highIndex < levels.length - 1 ? levels[highIndex + 1].total : -1;
    // Match the reference engine: when adjacent volumes tie, expand upward.
    if (above >= below) {
      highIndex++;
      valueAreaVolume += levels[highIndex].total;
    } else {
      lowIndex--;
      valueAreaVolume += levels[lowIndex].total;
    }
  }

  return {
    levels,
    poc: levels[pocIndex].price,
    vah: levels[highIndex].price,
    val: levels[lowIndex].price,
    totalVolume,
    capturedBars,
    bucketSize,
    sourceRange: Number.isFinite(sourceStart) ? [sourceStart, sourceEnd] : null
  };
}
