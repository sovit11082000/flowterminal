import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { SerializedFootprintBar } from '../types/market.js';
import { calculateVolumeProfile } from './VolumeProfileCalculator.js';

export type VolumeProfileMode = 'Off' | 'Range';
export type VolumeProfileViewMode = 'Total Volume' | 'Bid x Ask Split' | 'Net Delta';
interface VolumeProfileOverlayOptions {
  ctx: CanvasRenderingContext2D;
  chart: IChartApi;
  candleSeries: ISeriesApi<'Candlestick'>;
  width: number;
  height: number;
  mode: VolumeProfileMode;
  viewMode: VolumeProfileViewMode;
  symbol: string;
  bars: Iterable<SerializedFootprintBar>;
  candleTimes: Iterable<number>;
  latestTime: number | null;
  fixedRange: [number, number] | null;
  shelfX: number | null;
}

interface PixelRow {
  y: number;
  bid: number;
  ask: number;
  total: number;
  delta: number;
  active: boolean;
}

const timeToUnixSeconds = (time: Time): number => {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
};

// The chart redraw callback is synchronous. Reuse its screen-row storage across
// redraws so a pan/zoom does not allocate a Map and row objects every frame.
const rowPool: PixelRow[] = [];
const activeRowIndexes: number[] = [];

export function drawVolumeProfile(options: VolumeProfileOverlayOptions): void {
  const { ctx, chart, candleSeries, width, height, mode, viewMode, symbol, bars, candleTimes, latestTime, fixedRange, shelfX } = options;
  if (mode === 'Off') return;

  const timeRange = chart.timeScale().getVisibleRange();
  if (!timeRange) return;

  const now = latestTime ?? Math.floor(Date.now() / 1000);
  if (mode === 'Range' && !fixedRange) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Click start and end candles · click one candle twice for its profile', Math.round(chart.timeScale().width() / 2), 20);
    return;
  }

  // One pass, no intermediate candle-time array.
  const visibleRightEdge = timeToUnixSeconds(timeRange.to);
  let selectedRangeEnd = 0;
  let expectedBars = 0;
  const visibleFrom = timeToUnixSeconds(timeRange.from);
  for (const time of candleTimes) {
    if (time <= visibleRightEdge && time > selectedRangeEnd) selectedRangeEnd = time;
  }
  if (!selectedRangeEnd) selectedRangeEnd = now;

  const from = fixedRange ? Math.min(fixedRange[0], fixedRange[1]) : visibleFrom;
  const to = fixedRange ? Math.max(fixedRange[0], fixedRange[1]) : selectedRangeEnd;

  for (const time of candleTimes) if (time >= from && time <= to) expectedBars += 1;
  const profile = calculateVolumeProfile(bars, symbol, from, to);
  const timeScale = chart.timeScale();
  const plotWidth = timeScale.width();
  if (!profile || profile.levels.length === 0) {
    const centerX = Math.round(plotWidth / 2);
    const centerY = Math.round(height / 2);
    ctx.fillStyle = 'rgba(7, 12, 21, 0.92)';
    ctx.fillRect(centerX - 250, centerY - 42, 500, 84);
    ctx.fillStyle = 'rgba(248, 250, 252, 0.96)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No recorded trade volume inside this selection.', centerX, centerY - 17);
    if (profile?.sourceRange) {
      const formatIST = (time: number) => new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      }).format(new Date(time * 1000));
      ctx.fillStyle = 'rgba(148, 163, 184, 0.96)';
      ctx.font = '11px monospace';
      ctx.fillText(`Recorder coverage: ${formatIST(profile.sourceRange[0])} – ${formatIST(profile.sourceRange[1])} IST`, centerX, centerY + 4);
      ctx.fillText('Choose candles inside this period; older candles have no saved trade-by-price data.', centerX, centerY + 24);
    } else {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.96)';
      ctx.font = '11px monospace';
      ctx.fillText('Keep the backend recorder running to collect real trade-by-price data.', centerX, centerY + 10);
    }
    return;
  }

  const { levels, poc, vah, val, capturedBars, bucketSize } = profile;
  const maxBarWidth = Math.min(180, Math.max(130, width * 0.16));
  const shelfLeft = Math.max(4, Math.min(shelfX ?? 8, plotWidth - maxBarWidth - 16));
  const shelfRight = shelfLeft + maxBarWidth + 12;
  const rowHeight = 6;

  for (let i = 0; i < activeRowIndexes.length; i += 1) {
    const row = rowPool[activeRowIndexes[i]];
    row.bid = 0; row.ask = 0; row.total = 0; row.delta = 0; row.active = false;
  }
  activeRowIndexes.length = 0;
  let maxVolume = 0;
  let maxSideVolume = 0;
  let maxAbsDelta = 0;
  for (const level of levels) {
    const y = candleSeries.priceToCoordinate(level.price);
    if (y === null || y < 4 || y > height - 4) continue;
    const rowIndex = Math.floor(y / rowHeight);
    let row = rowPool[rowIndex];
    if (!row) {
      row = { y: rowIndex * rowHeight, bid: 0, ask: 0, total: 0, delta: 0, active: false };
      rowPool[rowIndex] = row;
    }
    if (!row.active) {
      row.active = true;
      activeRowIndexes.push(rowIndex);
    }
    row.bid += level.bid;
    row.ask += level.ask;
    row.total += level.total;
    row.delta += level.ask - level.bid;
    if (row.total > maxVolume) maxVolume = row.total;
    if (row.bid > maxSideVolume) maxSideVolume = row.bid;
    if (row.ask > maxSideVolume) maxSideVolume = row.ask;
    const absDelta = Math.abs(row.delta);
    if (absDelta > maxAbsDelta) maxAbsDelta = absDelta;
  }

  ctx.fillStyle = 'rgba(7, 12, 21, 0.9)';
  ctx.fillRect(Math.round(shelfLeft), 0, Math.round(maxBarWidth + 12), Math.ceil(height));
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.72)';
  ctx.beginPath(); ctx.moveTo(Math.round(shelfLeft) + 0.5, 0); ctx.lineTo(Math.round(shelfLeft) + 0.5, Math.ceil(height)); ctx.stroke();

  const profileName = mode === 'Range' ? 'MANUAL RANGE' : mode;
  const baseX = Math.round(shelfLeft + 4);
  const centerX = Math.round(baseX + maxBarWidth / 2);
  const halfWidth = maxBarWidth / 2;
  for (let i = 0; i < activeRowIndexes.length; i += 1) {
    const row = rowPool[activeRowIndexes[i]];
    const y = Math.round(row.y);
    const h = Math.max(1, Math.round(rowHeight - 1));
    if (maxVolume <= 0) continue;

    const totalWidth = Math.round(maxBarWidth * row.total / maxVolume);
    ctx.fillStyle = viewMode === 'Total Volume' ? 'rgba(148, 163, 184, 0.56)' : 'rgba(148, 163, 184, 0.2)';
    ctx.fillRect(baseX, y, totalWidth, h);

    if (viewMode === 'Bid x Ask Split' && maxSideVolume > 0) {
      const bidWidth = Math.round(halfWidth * row.bid / maxSideVolume);
      const askWidth = Math.round(halfWidth * row.ask / maxSideVolume);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
      ctx.fillRect(centerX - bidWidth, y, bidWidth, h);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.92)';
      ctx.fillRect(centerX, y, askWidth, h);
    } else if (viewMode === 'Net Delta' && maxAbsDelta > 0) {
      const deltaWidth = Math.round(halfWidth * Math.abs(row.delta) / maxAbsDelta);
      ctx.fillStyle = row.delta >= 0 ? 'rgba(16, 185, 129, 0.95)' : 'rgba(239, 68, 68, 0.95)';
      ctx.fillRect(row.delta >= 0 ? centerX : centerX - deltaWidth, y, deltaWidth, h);
    }
  }

  if (viewMode !== 'Total Volume') {
    ctx.strokeStyle = 'rgba(203, 213, 225, 0.42)';
    ctx.beginPath(); ctx.moveTo(centerX + 0.5, 32); ctx.lineTo(centerX + 0.5, Math.ceil(height)); ctx.stroke();
  }

  // Keep the old broad single-profile presentation as the default.
  ctx.fillStyle = 'rgba(7, 12, 21, 0.94)';
  ctx.fillRect(Math.round(shelfLeft + 1), 0, Math.round(maxBarWidth + 10), 32);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  const viewLabel = viewMode === 'Bid x Ask Split' ? 'BID ← | → ASK' : viewMode === 'Net Delta' ? 'NET DELTA' : 'TOTAL VOLUME';
  ctx.fillText(`${profileName} · ${viewLabel}`, Math.round(shelfLeft + 6), 13);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`POC ${poc.toFixed(priceDecimals(bucketSize))} · ${capturedBars}/${expectedBars} ${capturedBars < expectedBars ? 'PARTIAL' : 'BARS'}`, Math.round(shelfLeft + 6), 27);

  ctx.strokeStyle = 'rgba(203, 213, 225, 0.42)';
  ctx.beginPath(); ctx.moveTo(centerX + 0.5, 46); ctx.lineTo(centerX + 0.5, Math.ceil(height)); ctx.stroke();

  const drawLevel = (price: number, label: string, color: string, dashed = false) => {
    const y = candleSeries.priceToCoordinate(price);
    if (y === null || y < 0 || y > height) return;
    const snappedY = Math.round(y) + 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = label === 'POC' ? 1.5 : 1;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, snappedY);
    ctx.lineTo(Math.round(plotWidth - 8), snappedY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${label} ${price.toFixed(priceDecimals(bucketSize))}`, Math.round(shelfRight + 4), Math.round(y - 3));
    ctx.restore();
  };
  drawLevel(poc, 'POC', '#fbbf24');
  drawLevel(vah, 'VAH', '#60a5fa', true);
  drawLevel(val, 'VAL', '#60a5fa', true);
}

function priceDecimals(step: number): number {
  const text = step.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const decimals = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  return Math.max(0, Math.min(10, decimals - (exponentText ? Number(exponentText) : 0)));
}
