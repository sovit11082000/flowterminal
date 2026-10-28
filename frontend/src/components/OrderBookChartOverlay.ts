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
}): void {
  const { ctx, chart, series, width, height, samples } = args;
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
  ctx.font = '9px monospace';
  for (const wall of selected) {
    const y = series.priceToCoordinate(wall.price);
    if (y === null || y < 0 || y > height) continue;
    const color = wall.side === 'bid' ? '#22d3ee' : '#c084fc';
    const matchingSamples = samples.filter((sample) => sample.time / 1000 >= from && sample.time / 1000 <= to);
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
