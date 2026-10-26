export type DepthLevel = readonly [price: number, size: number];

export interface LiquidityBookSample {
  time: number;
  bids: readonly DepthLevel[];
  asks: readonly DepthLevel[];
}

export interface PersistentLiquidityWall {
  side: 'bid' | 'ask';
  price: number;
  persistencePct: number;
  averageSize: number;
}

/** Find unusually large displayed levels that persisted and remain in the latest book. */
export function findPersistentLiquidityWalls(samples: readonly LiquidityBookSample[]): PersistentLiquidityWall[] {
  if (samples.length < 6) return [];
  const sampleSizes: number[] = [];
  const levels = new Map<string, { side: 'bid' | 'ask'; price: number; largeSamples: number; sizeSum: number; presentSamples: number }>();

  for (const sample of samples) {
    sampleSizes.length = 0;
    for (const [, size] of sample.bids) if (Number.isFinite(size) && size > 0) sampleSizes.push(size);
    for (const [, size] of sample.asks) if (Number.isFinite(size) && size > 0) sampleSizes.push(size);
    sampleSizes.sort((a, b) => a - b);
    const median = sampleSizes[Math.floor(sampleSizes.length / 2)] ?? 0;

    for (const [side, sideLevels] of [['bid', sample.bids], ['ask', sample.asks]] as const) {
      for (const [price, size] of sideLevels) {
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        const key = `${side}:${price}`;
        const stats = levels.get(key) ?? { side, price, largeSamples: 0, sizeSum: 0, presentSamples: 0 };
        stats.presentSamples++;
        stats.sizeSum += size;
        if (median > 0 && size >= median * 3) stats.largeSamples++;
        levels.set(key, stats);
      }
    }
  }

  const minimumLargeSamples = Math.max(6, Math.ceil(samples.length * 0.1));
  const latest = samples[samples.length - 1];
  const currentLevels = new Set<string>();
  for (const [price] of latest.bids) currentLevels.add(`bid:${price}`);
  for (const [price] of latest.asks) currentLevels.add(`ask:${price}`);

  return Array.from(levels.values())
    .filter((level) => level.largeSamples >= minimumLargeSamples && currentLevels.has(`${level.side}:${level.price}`))
    .map((level) => ({
      side: level.side,
      price: level.price,
      persistencePct: Math.round(level.largeSamples / samples.length * 100),
      averageSize: level.sizeSum / level.presentSamples
    }))
    .sort((a, b) => b.persistencePct - a.persistencePct || b.averageSize - a.averageSize);
}

/** A LONG needs nearby bid support; a SHORT needs nearby ask resistance. */
export function findSupportingLiquidityWall(
  setup: { side: 'LONG' | 'SHORT'; entry: number; stop: number },
  samples: readonly LiquidityBookSample[],
  referencePrice: number | null
): PersistentLiquidityWall | null {
  const latest = samples[samples.length - 1];
  if (!latest || referencePrice === null || !Number.isFinite(referencePrice) || Date.now() - latest.time > 15_000) return null;
  const risk = Math.abs(setup.entry - setup.stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const maxDistance = Math.max(risk * 2.5, referencePrice * 0.0015);
  const expectedSide = setup.side === 'LONG' ? 'bid' : 'ask';
  const candidates = findPersistentLiquidityWalls(samples)
    .filter((wall) => wall.side === expectedSide)
    .filter((wall) => setup.side === 'LONG' ? wall.price <= referencePrice : wall.price >= referencePrice)
    .filter((wall) => Math.abs(wall.price - referencePrice) <= maxDistance)
    .sort((a, b) => Math.abs(a.price - referencePrice) - Math.abs(b.price - referencePrice) || b.persistencePct - a.persistencePct);
  return candidates[0] ?? null;
}
