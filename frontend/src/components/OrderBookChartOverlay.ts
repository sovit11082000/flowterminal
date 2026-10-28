import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { findPersistentLiquidityWalls, type LiquidityBookSample } from './LiquidityWallAnalysis.js';

/** Draws only currently visible, repeatedly observed book walls on the candle pane. */
export function drawOrderBookLiquidityOverlay(args: {
  ctx: CanvasRenderingContext2D;
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  width: number;
  height: number;
  samples: readonly LiquidityBookSample[];
  timeframeSeconds: number;
}): void {
  const { ctx, chart, series, width, height, samples, timeframeSeconds } = args;
  if (samples.length < 6) return;
  const visible = chart.timeScale().getVisibleRange();
  if (!visible) return;
  const from = typeof visible.from === 'number' ? visible.from : -Infinity;
  const to = typeof visible.to === 'number' ? visible.to : Infinity;
  const walls = findPersistentLiquidityWalls(samples)
    .filter((wall) => wall.persistencePct >= 20)
    .sort((a, b) => b.persistencePct - a.persistencePct || b.averageSize - a.averageSize);
  const selected = (['bid', 'ask'] as const).flatMap((side) => walls.filter((wall) => wall.side === side).slice(0, 2));
  if (!selected.length) return;

  ctx.save();
  // Collapse 15-second snapshots into chart bars so order-book bands line up
  // with the selected candle interval (rather than floating between candles).
  const levelsByBar = new Map<number, Map<string, { side: 'bid' | 'ask'; price: number; size: number }>>();
  for (const sample of samples) {
    const sampleSeconds = Math.floor(sample.time / 1000);
    if (sampleSeconds < from || sampleSeconds > to) continue;
    const barTime = Math.floor(sampleSeconds / timeframeSeconds) * timeframeSeconds;
    const levels = levelsByBar.get(barTime) ?? new Map<string, { side: 'bid' | 'ask'; price: number; size: number }>();
    for (const [side, entries] of [['bid', sample.bids], ['ask', sample.asks]] as const) {
      for (const [price, size] of entries.slice(0, 5)) {
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        const key = `${side}:${price}`;
        const current = levels.get(key);
        // Show the strongest displayed size observed within this candle bucket.
        if (!current || size > current.size) levels.set(key, { side, price, size });
      }
    }
    levelsByBar.set(barTime, levels);
  }
  const timeScale = chart.timeScale();
  for (const [barTime, levelMap] of levelsByBar) {
    const x = timeScale.timeToCoordinate(barTime as import('lightweight-charts').UTCTimestamp);
    if (x === null || x < -20 || x > width + 20) continue;
    const nextX = timeScale.timeToCoordinate((barTime + timeframeSeconds) as import('lightweight-charts').UTCTimestamp);
    const previousX = timeScale.timeToCoordinate((barTime - timeframeSeconds) as import('lightweight-charts').UTCTimestamp);
    const candleWidth = Math.max(3, Math.min(34, Math.abs(nextX !== null ? nextX - x : previousX !== null ? x - previousX : 8) * 0.72));
    const values = [...levelMap.values()];
    const sortedSizes = values.map((level) => level.size).sort((a, b) => a - b);
    const typicalSize = sortedSizes[Math.floor(sortedSizes.length / 2)] ?? 1;
    for (const level of values) {
      const y = series.priceToCoordinate(level.price);
      if (y === null || y < -8 || y > height + 8) continue;
      const intensity = Math.sqrt(Math.min(level.size / Math.max(typicalSize * 3, Number.EPSILON), 1));
      ctx.globalAlpha = 0.08 + intensity * 0.28;
      ctx.fillStyle = level.side === 'bid' ? '#22d3ee' : '#c084fc';
      ctx.fillRect(x - candleWidth / 2, y - 3, candleWidth, 6);
    }
  }

  ctx.font = '9px monospace';
  for (const wall of selected) {
    const y = series.priceToCoordinate(wall.price);
    if (y === null || y < 0 || y > height) continue;
    const color = wall.side === 'bid' ? '#22d3ee' : '#c084fc';
    const wallSamples = samples.filter((sample) => (wall.side === 'bid' ? sample.bids : sample.asks).some(([price]) => price === wall.price));
    const matchingSamples = wallSamples.filter((sample) => sample.time / 1000 >= from && sample.time / 1000 <= to);
    if (!matchingSamples.length) continue;
    const first = matchingSamples[0];
    const last = matchingSamples[matchingSamples.length - 1];
    const x1 = chart.timeScale().timeToCoordinate(Math.floor(first.time / 1000) as import('lightweight-charts').UTCTimestamp);
    const x2 = chart.timeScale().timeToCoordinate(Math.floor(last.time / 1000) as import('lightweight-charts').UTCTimestamp);
    if (x1 === null || x2 === null) continue;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.78;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(Math.max(0, x1), Math.round(y) + 0.5); ctx.lineTo(Math.min(width, Math.max(x1 + 12, x2)), Math.round(y) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    const label = `${wall.side.toUpperCase()} LIQ ${wall.price.toLocaleString('en-US', { maximumFractionDigits: 6 })} · ${wall.persistencePct}%`;
    const labelWidth = ctx.measureText(label).width;
    const labelX = Math.max(3, Math.min(width - labelWidth - 8, x2 + 5));
    ctx.globalAlpha = 0.92;
    ctx.fillText(label, labelX, Math.max(11, y - 3));
  }
  ctx.restore();
}
