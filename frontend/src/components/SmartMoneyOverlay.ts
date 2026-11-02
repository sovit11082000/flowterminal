import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts';
import type { SerializedFootprintBar } from '../types/market.js';

export interface StructureCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type StructureEventType = 'BOS' | 'CHOCH' | 'MSS' | 'INDUCEMENT' | 'BSL SWEEP' | 'SSL SWEEP';
export interface StructureEvent { type: StructureEventType; time: number; price: number; bullish: boolean; fromTime?: number; }
export interface PriceZone { startTime: number; endTime: number; createdTime?: number; top: number; bottom: number; bullish: boolean; kind: 'FVG' | 'OB'; }
export interface LiquidityLevel { time: number; price: number; label: 'EQH' | 'EQL'; swept: boolean; endTime?: number; }
export interface PO3Marker { time: number; endTime: number; label: 'ACC' | 'MANIP' | 'DIST'; top: number; bottom: number; bullish?: boolean; }
export interface SmartMoneyAnalysis { events: StructureEvent[]; zones: PriceZone[]; liquidity: LiquidityLevel[]; po3: PO3Marker[]; dailyRanges: Map<number, { high: number; low: number }>; bias: 'Bullish' | 'Bearish' | 'Neutral'; }
export interface SmartMoneyFeatures { structure: boolean; liquidity: boolean; zones: boolean; }

export function isOrderFlowConfirmed(event: StructureEvent, footprint: SerializedFootprintBar | undefined): boolean {
  if (!footprint?.isClosed || footprint.totalVolume <= 0) return false;
  if (event.type === 'SSL SWEEP' || event.type === 'BSL SWEEP') {
    // Aggression into a swept extreme, followed by a close back inside the range,
    // is a possible absorption response; it is not proof of a hidden order.
    return event.bullish
      ? footprint.delta < 0 && footprint.close > footprint.open
      : footprint.delta > 0 && footprint.close < footprint.open;
  }
  const levels = [...footprint.priceLevels].sort((a, b) => a.price - b.price);
  const minimumVolume = footprint.totalVolume * 0.01;
  let alignedRun = 0;
  for (const level of levels) {
    const dominant = event.bullish
      ? level.askVolume >= Math.max(level.bidVolume * 3, 0.000001)
      : level.bidVolume >= Math.max(level.askVolume * 3, 0.000001);
    const qualifies = dominant && level.totalVolume >= minimumVolume;
    alignedRun = qualifies ? alignedRun + 1 : 0;
    if (alignedRun >= 3) break;
  }
  const deltaAligned = event.bullish ? footprint.delta > 0 : footprint.delta < 0;
  return deltaAligned && alignedRun >= 3;
}

const pivotSize = 2;

export function analyzeSmartMoney(candles: StructureCandle[]): SmartMoneyAnalysis {
  const bars = candles;
  const highs: Array<{ index: number; price: number }> = [];
  const lows: Array<{ index: number; price: number }> = [];
  const events: StructureEvent[] = [];
  let trend: -1 | 0 | 1 = 0;

  for (let i = pivotSize; i < bars.length - pivotSize; i++) {
    const candidate = bars[i];
    let isHigh = true; let isLow = true;
    for (let j = i - pivotSize; j <= i + pivotSize; j++) {
      if (j === i) continue;
      if (bars[j].high >= candidate.high) isHigh = false;
      if (bars[j].low <= candidate.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candidate.high });
    if (isLow) lows.push({ index: i, price: candidate.low });
  }

  const liquidity: LiquidityLevel[] = [];
  const equalTolerance = (price: number) => Math.max(price * 0.00005, 0.00000001);
  const maxLiquidityHistory = 256;
  let highCursor = 0; let lowCursor = 0;
  let priorHigh: { index: number; price: number } | undefined;
  let priorLow: { index: number; price: number } | undefined;
  let highCandidates = 0; let lowCandidates = 0;
  let lastBreakIndex = -1;
  const allZones: PriceZone[] = [];
  const activeZones: Array<{ zone: PriceZone; createdIndex: number }> = [];
  const inducementTimes = new Set<number>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    for (let z = activeZones.length - 1; z >= 0; z--) {
      const active = activeZones[z];
      if (i <= active.createdIndex) continue;
      const zone = active.zone;
      zone.endTime = bar.time;
      const invalidated = zone.kind === 'FVG'
        ? (zone.bullish ? bar.low <= zone.bottom : bar.high >= zone.top)
        : (zone.bullish ? bar.close < zone.bottom : bar.close > zone.top);
      if (invalidated || i - active.createdIndex >= 18) activeZones.splice(z, 1);
    }
    // A pivot only becomes knowable after two bars have closed to its right.
    while (highCursor < highs.length && highs[highCursor].index + pivotSize <= i) {
      const next = highs[highCursor++];
      const tolerance = equalTolerance(next.price);
      const matches = highs.slice(Math.max(0, highCandidates - 12), highCandidates).filter((p) =>
        Math.abs(p.price - next.price) <= tolerance && bars.slice(p.index + 1, next.index).some((between) => between.low < Math.min(p.price, next.price) - 2 * tolerance));
      if (matches.length) {
        const cluster = [...matches, next];
        const price = cluster.reduce((sum, p) => sum + p.price, 0) / cluster.length;
        if (!liquidity.some((level) => level.label === 'EQH' && Math.abs(level.price - price) <= tolerance && Math.abs(level.time - bar.time) < 86400)) {
          liquidity.push({ time: bar.time, price, label: 'EQH', swept: false });
          if (liquidity.length > maxLiquidityHistory) liquidity.shift();
        }
      }
      highCandidates++;
      priorHigh = next;
    }
    while (lowCursor < lows.length && lows[lowCursor].index + pivotSize <= i) {
      const next = lows[lowCursor++];
      const tolerance = equalTolerance(next.price);
      const matches = lows.slice(Math.max(0, lowCandidates - 12), lowCandidates).filter((p) =>
        Math.abs(p.price - next.price) <= tolerance && bars.slice(p.index + 1, next.index).some((between) => between.high > Math.max(p.price, next.price) + 2 * tolerance));
      if (matches.length) {
        const cluster = [...matches, next];
        const price = cluster.reduce((sum, p) => sum + p.price, 0) / cluster.length;
        if (!liquidity.some((level) => level.label === 'EQL' && Math.abs(level.price - price) <= tolerance && Math.abs(level.time - bar.time) < 86400)) {
          liquidity.push({ time: bar.time, price, label: 'EQL', swept: false });
          if (liquidity.length > maxLiquidityHistory) liquidity.shift();
        }
      }
      lowCandidates++;
      priorLow = next;
    }

    for (const level of liquidity) {
      if (level.swept) continue;
      const swept = level.label === 'EQH' ? bar.high > level.price && bar.close < level.price : bar.low < level.price && bar.close > level.price;
      if (swept && bar.time > level.time) {
        level.swept = true; level.endTime = bar.time;
        events.push({ type: level.label === 'EQH' ? 'BSL SWEEP' : 'SSL SWEEP', time: bar.time, price: level.price, bullish: level.label === 'EQL' });
      }
    }

    // Single-swing stop runs count only after a wick through the confirmed swing
    // and a candle close back inside it.
    if (priorHigh && bar.high > priorHigh.price && bar.close < priorHigh.price) {
      events.push({ type: 'BSL SWEEP', time: bar.time, price: priorHigh.price, bullish: false });
    }
    if (priorLow && bar.low < priorLow.price && bar.close > priorLow.price) {
      events.push({ type: 'SSL SWEEP', time: bar.time, price: priorLow.price, bullish: true });
    }

    let brokenPivot: { index: number; price: number } | undefined;
    let bullish = false;
    if (priorHigh && bar.close > priorHigh.price) { brokenPivot = priorHigh; bullish = true; }
    else if (priorLow && bar.close < priorLow.price) { brokenPivot = priorLow; bullish = false; }
    if (brokenPivot) {

      const recentSweep = events.slice(-32).reverse().find((event) => event.type.endsWith('SWEEP') && event.bullish === bullish && event.time < bar.time && bar.time - event.time <= intervalSecondsBetween(bars, i) * 8);
      const type: StructureEventType = recentSweep ? 'MSS' : trend !== 0 && (trend === 1) !== bullish ? 'CHOCH' : 'BOS';
      events.push({ type, time: bar.time, fromTime: bars[brokenPivot.index].time, price: brokenPivot.price, bullish });
      if (recentSweep && !inducementTimes.has(recentSweep.time)) {
        events.push({ type: 'INDUCEMENT', time: recentSweep.time, price: recentSweep.price, bullish: recentSweep.bullish });
        inducementTimes.add(recentSweep.time);
      }
      trend = bullish ? 1 : -1;
      lastBreakIndex = i;

      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const prior = bars[j];
        if ((bullish && prior.close < prior.open) || (!bullish && prior.close > prior.open)) {
          const zone: PriceZone = { startTime: prior.time, endTime: bar.time, createdTime: bar.time, top: prior.high, bottom: prior.low, bullish, kind: 'OB' };
          allZones.push(zone); activeZones.push({ zone, createdIndex: i });
          break;
        }
      }
      if (priorHigh === brokenPivot) priorHigh = undefined;
      if (priorLow === brokenPivot) priorLow = undefined;
    }

    if (i >= 2) {
      const first = bars[i - 2];
      if (bar.low > first.high) {
        const zone: PriceZone = { startTime: first.time, endTime: bar.time, createdTime: bar.time, top: bar.low, bottom: first.high, bullish: true, kind: 'FVG' };
        allZones.push(zone); activeZones.push({ zone, createdIndex: i });
      } else if (bar.high < first.low) {
        const zone: PriceZone = { startTime: first.time, endTime: bar.time, createdTime: bar.time, top: first.low, bottom: bar.high, bullish: false, kind: 'FVG' };
        allZones.push(zone); activeZones.push({ zone, createdIndex: i });
      }
      if (allZones.length > 12_000) allZones.splice(0, allZones.length - 12_000);
    }
  }

  const bias: SmartMoneyAnalysis['bias'] = trend === 1 ? 'Bullish' : trend === -1 ? 'Bearish' : 'Neutral';
  const interval = bars.length > 1 ? Math.max(1, bars[bars.length - 1].time - bars[bars.length - 2].time) : 60;
  const dailyRanges = new Map<number, { high: number; low: number }>();
  for (const bar of bars) {
    const day = Math.floor(bar.time / 86400) * 86400;
    const range = dailyRanges.get(day);
    if (range) { range.high = Math.max(range.high, bar.high); range.low = Math.min(range.low, bar.low); }
    else dailyRanges.set(day, { high: bar.high, low: bar.low });
  }
  return {
    events: events.sort((a, b) => a.time - b.time),
    zones: allZones,
    liquidity,
    po3: analyzePO3(bars, interval),
    dailyRanges,
    bias: lastBreakIndex >= 0 ? bias : 'Neutral'
  };
}

function intervalSecondsBetween(bars: StructureCandle[], index: number): number {
  return index > 0 ? Math.max(1, bars[index].time - bars[index - 1].time) : 60;
}

function analyzePO3(bars: StructureCandle[], interval: number): PO3Marker[] {
  if (interval >= 86400 || bars.length < 24) return [];
  const days = new Map<number, StructureCandle[]>();
  for (const bar of bars) {
    const day = Math.floor(bar.time / 86400) * 86400;
    const group = days.get(day) ?? [];
    group.push(bar); days.set(day, group);
  }
  const orderedDays = [...days.entries()].sort((a, b) => a[0] - b[0]);
  const markers: PO3Marker[] = [];
  const completedRanges: number[] = [];
  for (let d = 0; d < orderedDays.length; d++) {
    const [dayStart, dayBars] = orderedDays[d];
    if (dayBars.length < 6) continue;
    const accumulationBars = dayBars.filter((bar) => bar.time < dayStart + 8 * 3600);
    if (accumulationBars.length < 2) continue;
    const top = Math.max(...accumulationBars.map((bar) => bar.high));
    const bottom = Math.min(...accumulationBars.map((bar) => bar.low));
    const range = top - bottom;
    const baseline = completedRanges.slice(-5);
    const qualifiesAsAccumulation = baseline.length < 3 || range <= baseline.reduce((sum, value) => sum + value, 0) / baseline.length * 0.65;
    if (!qualifiesAsAccumulation || range <= 0) {
      completedRanges.push(Math.max(...dayBars.map((bar) => bar.high)) - Math.min(...dayBars.map((bar) => bar.low)));
      continue;
    }
    const accumulationEnd = accumulationBars[accumulationBars.length - 1].time;
    markers.push({ time: accumulationBars[0].time, endTime: accumulationEnd, label: 'ACC', top, bottom });
    let manipulation: { bar: StructureCandle; bullish: boolean } | null = null;
    for (const bar of dayBars) {
      if (bar.time <= accumulationEnd) continue;
      if (bar.low < bottom && bar.close > bottom) { manipulation = { bar, bullish: true }; break; }
      if (bar.high > top && bar.close < top) { manipulation = { bar, bullish: false }; break; }
    }
    if (manipulation) {
      markers.push({ time: manipulation.bar.time, endTime: manipulation.bar.time, label: 'MANIP', top, bottom, bullish: manipulation.bullish });
      const distribution = dayBars.find((bar) => bar.time > manipulation!.bar.time && (manipulation!.bullish ? bar.close > top : bar.close < bottom));
      if (distribution) markers.push({ time: distribution.time, endTime: distribution.time, label: 'DIST', top, bottom, bullish: manipulation.bullish });
    }
    if (dayBars.length >= Math.floor(86400 / interval) - 1) {
      completedRanges.push(Math.max(...dayBars.map((bar) => bar.high)) - Math.min(...dayBars.map((bar) => bar.low)));
    }
  }
  return markers.slice(-90);
}

export function drawSmartMoneyOverlay(args: {
  ctx: CanvasRenderingContext2D; chart: IChartApi; series: ISeriesApi<'Candlestick'>;
  width: number; height: number; candles: StructureCandle[]; features: SmartMoneyFeatures;
  footprints?: ReadonlyMap<number, SerializedFootprintBar>;
  analysis?: SmartMoneyAnalysis;
}): void {
  const { ctx, chart, series, width, height, candles, features, footprints } = args;
  const analysis = args.analysis ?? analyzeSmartMoney(candles);
  const timeScale = chart.timeScale();
  const toX = (seconds: number) => timeScale.timeToCoordinate(seconds as UTCTimestamp | Time);
  const visible = timeScale.getVisibleRange();
  const visibleFrom = visible ? timeToSeconds(visible.from) : -Infinity;
  const visibleTo = visible ? timeToSeconds(visible.to) : Infinity;
  ctx.save();
  ctx.font = '10px monospace';
  const labelYs: number[] = [];
  drawPreviousDayContext(ctx, series, toX, width, height, analysis.dailyRanges, Number.isFinite(visibleTo) ? visibleTo : Math.floor(Date.now() / 1000));
  // Keep the most recent active zones in view so a month of history does not
  // paint every old gap/block over the candles at once.
  const visibleZones = features.zones
    ? analysis.zones.filter((item) => item.startTime <= visibleTo && item.endTime >= visibleFrom).slice(-7)
    : [];
  for (const zone of visibleZones) {
    const x1 = toX(zone.startTime); const x2 = toX(zone.endTime);
    const y1 = series.priceToCoordinate(zone.top); const y2 = series.priceToCoordinate(zone.bottom);
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    const bullish = zone.bullish;
    // FVG is cyan; order blocks are violet. Direction is shown by the arrow,
    // so each concept keeps one consistent color in either direction.
    ctx.fillStyle = zone.kind === 'FVG' ? 'rgba(34,211,238,.10)' : 'rgba(168,85,247,.10)';
    ctx.strokeStyle = zone.kind === 'FVG' ? 'rgba(34,211,238,.72)' : 'rgba(168,85,247,.76)';
    const right = toX(zone.endTime);
    if (right === null) continue;
    const zoneWidth = Math.max(1, Math.min(width, right) - Math.max(0, x1));
    if (zoneWidth <= 1) continue;
    ctx.fillRect(Math.max(0, x1), Math.min(y1, y2), zoneWidth, Math.abs(y2 - y1));
    ctx.strokeRect(Math.max(0, x1), Math.min(y1, y2), zoneWidth, Math.abs(y2 - y1));
    ctx.fillStyle = zone.kind === 'FVG' ? '#67e8f9' : '#d8b4fe';
    const zoneLabelY = Math.min(y1, y2) + 11;
    if (zoneWidth >= 38 && !labelYs.some((previous) => Math.abs(previous - zoneLabelY) < 13)) {
      labelYs.push(zoneLabelY);
      ctx.fillText(`${zone.kind} ${bullish ? '↑' : '↓'}`, Math.max(2, x1 + 3), Math.min(height - 3, zoneLabelY));
    }
  }
  const visibleLiquidity = features.liquidity
    ? analysis.liquidity.filter((item) => item.time <= visibleTo && (item.endTime ?? Infinity) >= visibleFrom).slice(-6)
    : [];
  for (const level of visibleLiquidity) {
    const x = toX(level.time); const y = series.priceToCoordinate(level.price);
    if (x === null || y === null || y < 0 || y > height) continue;
    const endX = level.endTime === undefined ? width - 4 : toX(level.endTime) ?? width - 4;
    ctx.strokeStyle = 'rgba(250,204,21,.72)';
    ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, Math.round(y) + 0.5); ctx.lineTo(Math.max(x + 1, Math.min(width - 4, endX)), Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fde047';
    // The sweep itself is marked as a separate confirmed event below; avoid
    // repeating "swept" across every old level label.
    ctx.fillText(level.label, Math.max(3, x + 3), y - 3);
  }
  const recentEvents = features.structure ? analysis.events.filter((item) => item.time >= visibleFrom && item.time <= visibleTo).slice(-8) : [];
  const eventLabelYs: number[] = [];
  for (const event of recentEvents) {
    const x = toX(event.time); const y = series.priceToCoordinate(event.price);
    if (x === null || y === null || x < 0 || x > width || y < 0 || y > height) continue;
    const flow = isOrderFlowConfirmed(event, footprints?.get(event.time));
    const color = event.type === 'BOS' ? '#60a5fa' : event.type === 'CHOCH' ? '#fbbf24'
      : event.type === 'MSS' ? '#c084fc' : event.type === 'INDUCEMENT' ? '#f97316' : '#f472b6';
    ctx.strokeStyle = color; ctx.setLineDash(event.type === 'BOS' ? [4, 3] : []);
    const startX = event.fromTime === undefined ? Math.max(0, x - 32) : toX(event.fromTime) ?? Math.max(0, x - 32);
    ctx.beginPath(); ctx.moveTo(Math.max(0, startX), Math.round(y) + 0.5); ctx.lineTo(Math.min(width - 2, x + 5), Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color;
    const labelY = y + (event.bullish ? -7 : 12);
    if (!eventLabelYs.some((previous) => Math.abs(previous - labelY) < 13)) {
      eventLabelYs.push(labelY);
      const shortFlowLabel = flow ? ' ✓' : '';
      ctx.fillText(`${event.type}${shortFlowLabel}`, Math.min(width - 68, x + 6), Math.max(11, Math.min(height - 3, labelY)));
    }
  }
  for (const marker of analysis.po3.filter((item) => item.time <= visibleTo && item.endTime >= visibleFrom).slice(-6)) {
    const x1 = toX(marker.time); const x2 = toX(marker.endTime);
    if (x1 === null || x2 === null || x2 < 0 || x1 > width) continue;
    const left = Math.max(0, x1); const right = Math.min(width - 2, Math.max(x2, x1 + 8));
    if (marker.label === 'ACC') {
      const y1 = series.priceToCoordinate(marker.top); const y2 = series.priceToCoordinate(marker.bottom);
      if (y1 === null || y2 === null) continue;
      ctx.fillStyle = 'rgba(148,163,184,.06)'; ctx.strokeStyle = 'rgba(148,163,184,.40)'; ctx.setLineDash([2, 3]);
      ctx.fillRect(left, Math.min(y1, y2), right - left, Math.abs(y2 - y1)); ctx.strokeRect(left, Math.min(y1, y2), right - left, Math.abs(y2 - y1)); ctx.setLineDash([]);
      ctx.fillStyle = '#cbd5e1'; ctx.fillText('PO3 ACC', left + 3, Math.max(11, Math.min(height - 3, Math.min(y1, y2) - 3)));
    } else {
      const y = series.priceToCoordinate(marker.label === 'MANIP' ? (marker.bullish ? marker.bottom : marker.top) : (marker.bullish ? marker.top : marker.bottom));
      if (y === null || y < 0 || y > height) continue;
      ctx.fillStyle = marker.label === 'MANIP' ? '#f97316' : marker.bullish ? '#34d399' : '#fb7185';
      ctx.fillText(marker.label === 'MANIP' ? 'PO3 MANIP ✓' : `PO3 DIST ${marker.bullish ? '↑' : '↓'} ✓`, Math.max(2, Math.min(width - 105, left + 2)), Math.max(11, Math.min(height - 3, y - 5)));
    }
  }
  ctx.restore();
}

function drawPreviousDayContext(
  ctx: CanvasRenderingContext2D,
  series: ISeriesApi<'Candlestick'>,
  toX: (seconds: number) => number | null,
  width: number,
  height: number,
  dailyRanges: ReadonlyMap<number, { high: number; low: number }>,
  referenceTime: number
): void {
  const currentDay = Math.floor(referenceTime / 86400) * 86400;
  const previousDay = currentDay - 86400;
  const priorRange = dailyRanges.get(previousDay);
  if (!priorRange) return;
  const high = priorRange.high;
  const low = priorRange.low;
  const midpoint = (high + low) / 2;
  const xStart = Math.max(0, toX(currentDay) ?? 0);
  const xEnd = width - 3;
  const yHigh = series.priceToCoordinate(high); const yLow = series.priceToCoordinate(low); const yMid = series.priceToCoordinate(midpoint);
  if (yHigh === null || yLow === null || yMid === null || yEndOutside(yHigh, yLow, height)) return;
  ctx.fillStyle = 'rgba(251,113,133,.035)';
  ctx.fillRect(xStart, Math.min(yHigh, yMid), Math.max(0, xEnd - xStart), Math.abs(yMid - yHigh));
  ctx.fillStyle = 'rgba(52,211,153,.035)';
  ctx.fillRect(xStart, Math.min(yMid, yLow), Math.max(0, xEnd - xStart), Math.abs(yLow - yMid));
  for (const [price, y, color, label, dash] of [
    [high, yHigh, '#fbbf24', 'PDH', [5, 3]],
    [midpoint, yMid, '#94a3b8', 'PD EQ', [2, 4]],
    [low, yLow, '#60a5fa', 'PDL', [5, 3]]
  ] as const) {
    void price;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.8; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(xStart, Math.round(y) + 0.5); ctx.lineTo(xEnd, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.fillText(label, Math.max(2, xEnd - 54), Math.max(10, Math.min(height - 3, y - 3)));
  }
}

function timeToSeconds(time: Time): number {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

function yEndOutside(a: number, b: number, height: number): boolean {
  return Math.max(a, b) < 0 || Math.min(a, b) > height;
}
