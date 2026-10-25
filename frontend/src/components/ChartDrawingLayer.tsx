import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { BarPrice, IChartApi, ISeriesApi, Logical, Time, UTCTimestamp } from 'lightweight-charts';
import { loadDrawingsFromDB, saveDrawingsToDB, type DrawingPoint, type DrawingTool, type StoredChartDrawing } from '../storage/db.js';
import type { CachedCandle } from '../storage/db.js';
import type { CandleTimeframe, SerializedFootprintBar } from '../types/market.js';

const timeframeSeconds: Record<CandleTimeframe, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400
};

type Tool = DrawingTool | 'select' | 'off';
const tools: Array<{ key: Tool; label: string; shortcut?: string }> = [
  { key: 'off', label: 'Pan' }, { key: 'select', label: 'Select' }, { key: 'horizontal', label: 'H-Line', shortcut: 'H' },
  { key: 'trendline', label: 'Trend', shortcut: 'T' }, { key: 'rectangle', label: 'Zone', shortcut: 'R' },
  { key: 'vertical', label: 'V-Line', shortcut: 'V' }, { key: 'text', label: 'Note', shortcut: 'N' },
  { key: 'measure', label: 'Measure', shortcut: 'M' }, { key: 'long', label: 'Long', shortcut: 'L' },
  { key: 'short', label: 'Short', shortcut: 'S' }, { key: 'fib', label: 'Fib', shortcut: 'F' }
];
const pointCount = (tool: DrawingTool) => tool === 'horizontal' || tool === 'vertical' || tool === 'text' ? 1 : tool === 'long' || tool === 'short' ? 3 : 2;
type DragState = { id: string; pointIndex: number | null; origin: DrawingPoint; initialPoints: DrawingPoint[] };

function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
  return Math.hypot(x - (a.x + ratio * dx), y - (a.y + ratio * dy));
}

function drawingBodyDistance(drawing: StoredChartDrawing, points: Array<{ x: number; y: number }>, x: number, y: number): number {
  const first = points[0]; const second = points[1];
  if (!first) return Infinity;
  switch (drawing.type) {
    case 'horizontal': return Math.abs(y - first.y);
    case 'vertical': return Math.abs(x - first.x);
    case 'text': return Math.hypot(x - first.x, y - first.y);
    case 'trendline': case 'measure':
      return second ? segmentDistance(x, y, first, second) : Infinity;
    case 'fib': {
      if (!second) return Infinity;
      const left = Math.min(first.x, second.x); const right = Math.max(first.x, second.x);
      const top = Math.min(first.y, second.y); const bottom = Math.max(first.y, second.y);
      return x >= left && x <= right && y >= top && y <= bottom
        ? 0
        : Math.min(Math.abs(x - left), Math.abs(x - right), Math.abs(y - top), Math.abs(y - bottom));
    }
    case 'rectangle': {
      if (!second) return Infinity;
      const left = Math.min(first.x, second.x); const right = Math.max(first.x, second.x);
      const top = Math.min(first.y, second.y); const bottom = Math.max(first.y, second.y);
      if (x >= left && x <= right && y >= top && y <= bottom) return 0;
      return Math.min(segmentDistance(x, y, { x: left, y: top }, { x: right, y: top }), segmentDistance(x, y, { x: right, y: top }, { x: right, y: bottom }), segmentDistance(x, y, { x: right, y: bottom }, { x: left, y: bottom }), segmentDistance(x, y, { x: left, y: bottom }, { x: left, y: top }));
    }
    case 'long': case 'short': {
      const third = points[2];
      if (!second || !third) return Infinity;
      const left = Math.min(first.x, third.x); const right = Math.max(first.x, third.x);
      if (x >= left && x <= right && y >= Math.min(second.y, third.y) && y <= Math.max(second.y, third.y)) return 0;
      return Math.min(segmentDistance(x, y, first, third), segmentDistance(x, y, first, second));
    }
  }
}

interface Props {
  chart: IChartApi | null;
  candleSeries: ISeriesApi<'Candlestick'> | null;
  symbol: string;
  timeframe: CandleTimeframe;
  candleCache: Map<number, CachedCandle>;
  latestTime: number | null;
  footprints: ReadonlyMap<number, SerializedFootprintBar>;
}

export default function ChartDrawingLayer({ chart, candleSeries, symbol, timeframe, candleCache, latestTime, footprints }: Props) {
  const [drawings, setDrawings] = useState<StoredChartDrawing[]>([]);
  const [readyScope, setReadyScope] = useState('');
  const [tool, setTool] = useState<Tool>('off');
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [color, setColor] = useState('#fbbf24');
  const [lineStyle, setLineStyle] = useState<'solid' | 'dashed' | 'dotted'>('solid');
  const [note, setNote] = useState('Note');
  const [snap, setSnap] = useState(true);
  const [hiddenAll, setHiddenAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ type: DrawingTool; points: DrawingPoint[] } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const undoRef = useRef<StoredChartDrawing[][]>([]);
  const dragHandleRef = useRef<DragState | null>(null);
  const sortedCandlesRef = useRef<CachedCandle[]>([]);
  const scope = `${symbol}:${timeframe}`;

  useEffect(() => {
    sortedCandlesRef.current = Array.from(candleCache.values()).sort((a, b) => a.time - b.time);
  }, [candleCache, latestTime]);

  useEffect(() => {
    let cancelled = false;
    setReadyScope('');
    void loadDrawingsFromDB(symbol, timeframe).then((saved) => {
      if (!cancelled) { setDrawings(saved); setReadyScope(scope); }
    });
    return () => { cancelled = true; };
  }, [symbol, timeframe, scope]);

  useEffect(() => {
    if (readyScope !== scope) return;
    const timer = window.setTimeout(() => void saveDrawingsToDB(symbol, timeframe, drawings), 250);
    return () => window.clearTimeout(timer);
  }, [drawings, readyScope, scope, symbol, timeframe]);

  const commit = useCallback((next: StoredChartDrawing[]) => {
    undoRef.current.push(drawings);
    if (undoRef.current.length > 50) undoRef.current.shift();
    setDrawings(next);
  }, [drawings]);

  const unixTime = (time: Time): number => {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  };

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>, applySnap = snap): DrawingPoint | null => {
    if (!chart || !candleSeries || !canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const timeScale = chart.timeScale();
    let time = timeScale.coordinateToTime(x);
    let timestamp = time ? unixTime(time) : NaN;
    if (!Number.isFinite(timestamp)) {
      const logical = timeScale.coordinateToLogical(x);
      const candles = sortedCandlesRef.current;
      const last = candles[candles.length - 1];
      const latestX = last ? timeScale.timeToCoordinate(last.time as UTCTimestamp) : null;
      const latestLogical = latestX === null ? null : timeScale.coordinateToLogical(latestX);
      if (logical === null || latestLogical === null || !last) return null;
      const interval = timeframeSeconds[timeframe];
      timestamp = last.time + Math.round(Number(logical) - Number(latestLogical)) * interval;
    }
    const rawPrice = candleSeries.coordinateToPrice(y);
    if (rawPrice === null) return null;

    let snappedTime = timestamp;
    let snappedPrice = Number(rawPrice);
    const candles = sortedCandlesRef.current;
    if (applySnap && candles.length) {
      let low = 0; let high = candles.length - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (candles[middle].time < timestamp) low = middle + 1; else high = middle - 1;
      }
      const candidateIndices = [Math.max(0, high), Math.min(candles.length - 1, low)];
      let nearest = candles[candidateIndices[0]];
      let distance = Math.abs(nearest.time - timestamp);
      for (const index of candidateIndices) {
        const candidate = candles[index];
        const nextDistance = Math.abs(candidate.time - timestamp);
        if (nextDistance < distance) { nearest = candidate; distance = nextDistance; }
      }
      const interval = timeframeSeconds[timeframe];
      if (distance <= interval / 2) {
        snappedTime = nearest.time;
        const candidates = [nearest.open, nearest.high, nearest.low, nearest.close];
        const fp = footprints.get(nearest.time);
        if (fp) candidates.push(...fp.priceLevels.map((level) => level.price));
        let bestPrice = Number(rawPrice);
        let bestPixelDistance = 9;
        for (const candidate of candidates) {
          const candidateY = candleSeries.priceToCoordinate(candidate as BarPrice);
          if (candidateY === null) continue;
          const pixelDistance = Math.abs(candidateY - y);
          if (pixelDistance < bestPixelDistance) { bestPixelDistance = pixelDistance; bestPrice = candidate; }
        }
        snappedPrice = bestPrice;
      }
    }
    return { time: Math.max(0, Math.floor(snappedTime)), price: Number(snappedPrice) };
  }, [chart, candleSeries, candleCache, footprints, snap, timeframe]);

  const coordinateForPoint = useCallback((point: DrawingPoint): { x: number; y: number } | null => {
    if (!chart || !candleSeries) return null;
    let x = chart.timeScale().timeToCoordinate(point.time as UTCTimestamp);
    if (x === null && latestTime !== null) {
      const last = { time: latestTime };
      const lastX = chart.timeScale().timeToCoordinate(last.time as UTCTimestamp);
      const lastLogical = lastX === null ? null : chart.timeScale().coordinateToLogical(lastX);
      if (lastLogical !== null) {
        const interval = timeframeSeconds[timeframe];
        x = chart.timeScale().logicalToCoordinate((Number(lastLogical) + (point.time - last.time) / interval) as Logical);
      }
    }
    const y = candleSeries.priceToCoordinate(point.price as BarPrice);
    return x === null || y === null ? null : { x, y };
  }, [chart, candleSeries, latestTime, timeframe]);

  const drawOne = useCallback((ctx: CanvasRenderingContext2D, drawing: StoredChartDrawing | { type: DrawingTool; points: DrawingPoint[]; color: string; lineStyle?: string; text?: string; id?: string }) => {
    if (!chart || !candleSeries || drawing.points.length === 0) return;
    const points = drawing.points.map(coordinateForPoint);
    if (points.some((point) => point === null)) return;
    const p = points as Array<{ x: number; y: number }>;
    const style = drawing.lineStyle ?? 'solid';
    ctx.save();
    ctx.strokeStyle = drawing.color;
    ctx.fillStyle = drawing.color;
    ctx.lineWidth = drawing.id === selectedId ? 2 : 1.5;
    ctx.setLineDash(style === 'dashed' ? [7, 4] : style === 'dotted' ? [2, 4] : []);
    const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    };
    switch (drawing.type) {
      case 'horizontal': line({ x: 0, y: p[0].y }, { x: canvasRef.current?.clientWidth ?? 0, y: p[0].y }); break;
      case 'vertical': line({ x: p[0].x, y: 0 }, { x: p[0].x, y: canvasRef.current?.clientHeight ?? 0 }); break;
      case 'trendline': case 'measure': line(p[0], p[1]); break;
      case 'rectangle': {
        const left = Math.min(p[0].x, p[1].x); const top = Math.min(p[0].y, p[1].y);
        const rectWidth = Math.abs(p[1].x - p[0].x); const rectHeight = Math.abs(p[1].y - p[0].y);
        ctx.fillStyle = `${drawing.color}22`; ctx.fillRect(left, top, rectWidth, rectHeight);
        ctx.strokeRect(left, top, rectWidth, rectHeight); break;
      }
      case 'text':
        ctx.setLineDash([]); ctx.font = '12px monospace'; ctx.fillText(drawing.text || 'Note', p[0].x + 5, p[0].y - 5); break;
      case 'fib': {
        // Retracement 0 is anchored at the second (swing-end) click; 1 is at
        // the first click (swing origin), matching the common TradingView/OTE convention.
        const high = drawing.points[1].price; const low = drawing.points[0].price; const diff = low - high;
        for (const ratio of [0, 0.5, 0.618, 0.705, 0.786, 1]) {
          const price = high + diff * ratio; const y = candleSeries.priceToCoordinate(price);
          if (y === null) continue;
          line({ x: Math.min(p[0].x, p[1].x), y }, { x: Math.max(p[0].x, p[1].x), y });
          ctx.setLineDash([]); ctx.font = '10px monospace'; ctx.fillText(`${ratio.toFixed(3)} · ${price.toFixed(2)}`, Math.max(p[0].x, p[1].x) + 3, y - 2);
          ctx.setLineDash(style === 'dashed' ? [7, 4] : style === 'dotted' ? [2, 4] : []);
        }
        break;
      }
      case 'long': case 'short': {
        if (p.length < 3) break;
        const entry = drawing.points[0].price; const stop = drawing.points[1].price; const target = drawing.points[2].price;
        const x0 = Math.min(p[0].x, p[2].x); const x1 = Math.max(p[0].x, p[2].x);
        const entryY = candleSeries.priceToCoordinate(entry); const stopY = candleSeries.priceToCoordinate(stop); const targetY = candleSeries.priceToCoordinate(target);
        if (entryY === null || stopY === null || targetY === null) break;
        const profitColor = drawing.type === 'long' ? '#10b981' : '#ef4444';
        const riskColor = drawing.type === 'long' ? '#ef4444' : '#10b981';
        ctx.setLineDash([]); ctx.fillStyle = `${profitColor}30`;
        ctx.fillRect(x0, Math.min(entryY, targetY), Math.max(1, x1 - x0), Math.abs(entryY - targetY));
        ctx.fillStyle = `${riskColor}30`;
        ctx.fillRect(x0, Math.min(entryY, stopY), Math.max(1, x1 - x0), Math.abs(entryY - stopY));
        ctx.strokeStyle = drawing.color;
        line({ x: x0, y: entryY }, { x: x1, y: entryY });
        const risk = Math.abs(entry - stop); const reward = Math.abs(target - entry);
        ctx.setLineDash([]); ctx.font = '10px monospace'; ctx.fillStyle = drawing.color;
        ctx.fillText(`${drawing.type.toUpperCase()} · R ${risk ? (reward / risk).toFixed(2) : '—'}`, x1 + 4, entryY - 4);
        break;
      }
    }
    if (drawing.type === 'measure') {
      ctx.setLineDash([]); ctx.font = '10px monospace';
      const delta = drawing.points[1].price - drawing.points[0].price;
      const pct = drawing.points[0].price ? delta / drawing.points[0].price * 100 : 0;
      const interval = timeframeSeconds[timeframe];
      const barCount = Math.round(Math.abs(drawing.points[1].time - drawing.points[0].time) / interval);
      ctx.fillText(`${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${pct.toFixed(2)}%) · ${barCount} bars`, p[1].x + 5, p[1].y - 5);
    }
    if (drawing.id === selectedId) {
      ctx.setLineDash([]); ctx.fillStyle = '#fff';
      for (const point of p) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }, [chart, candleSeries, coordinateForPoint, selectedId, timeframe]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth; const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) { canvas.width = width * dpr; canvas.height = height * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      if (!hiddenAll) for (const drawing of drawings) if (!drawing.hidden) drawOne(ctx, drawing);
      if (draft && draft.points.length >= pointCount(draft.type)) drawOne(ctx, { ...draft, color, lineStyle, text: note });
    };
    draw();
    const container = canvas.parentElement;
    const observer = container ? new ResizeObserver(draw) : null;
    if (container) observer?.observe(container);
    const redraw = () => draw();
    chart?.timeScale().subscribeVisibleTimeRangeChange(redraw);
    chart?.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    return () => {
      observer?.disconnect();
      chart?.timeScale().unsubscribeVisibleTimeRangeChange(redraw);
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
    };
  }, [chart, drawings, hiddenAll, draft, color, lineStyle, note, drawOne]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'off') return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (tool === 'select') {
      let handleHit: { drawing: StoredChartDrawing; pointIndex: number; distance: number } | null = null;
      let bodyHit: { drawing: StoredChartDrawing; distance: number } | null = null;
      const rect = canvasRef.current?.getBoundingClientRect();
      const cursorX = rect ? event.clientX - rect.left : 0;
      const cursorY = rect ? event.clientY - rect.top : 0;
      for (const drawing of drawings) {
        if (drawing.hidden || hiddenAll) continue;
        const projected = drawing.points.map(coordinateForPoint);
        if (projected.some((anchor) => anchor === null)) continue;
        const projectedPoints = projected as Array<{ x: number; y: number }>;
        for (let pointIndex = 0; pointIndex < drawing.points.length; pointIndex++) {
          const xy = projectedPoints[pointIndex];
          const distance = Math.hypot(xy.x - cursorX, xy.y - cursorY);
          if (distance < 14 && (!handleHit || distance < handleHit.distance)) handleHit = { drawing, pointIndex, distance };
        }
        const distance = drawingBodyDistance(drawing, projectedPoints, cursorX, cursorY);
        if (distance < 10 && (!bodyHit || distance < bodyHit.distance)) bodyHit = { drawing, distance };
      }
      const selectedDrawing = handleHit?.drawing ?? bodyHit?.drawing;
      if (selectedDrawing) {
        const draggingHandle = handleHit?.drawing.id === selectedDrawing.id;
        const dragOrigin = draggingHandle ? point : pointFromEvent(event, false);
        setSelectedId(selectedDrawing.id);
        if (selectedDrawing.locked) dragHandleRef.current = null;
        else if (dragOrigin) {
          undoRef.current.push(drawings);
          if (undoRef.current.length > 50) undoRef.current.shift();
          dragHandleRef.current = {
            id: selectedDrawing.id,
            pointIndex: draggingHandle && handleHit ? handleHit.pointIndex : null,
            origin: dragOrigin,
            initialPoints: selectedDrawing.points
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      else setSelectedId(null);
      return;
    }
    if (tool === 'horizontal' || tool === 'vertical' || tool === 'text') {
      commit([...drawings, { id: crypto.randomUUID(), symbol, timeframe, type: tool, points: [point], color, lineStyle, text: tool === 'text' ? note : undefined }]);
      setSelectedId(null); setDraft(null); setTool('off'); return;
    }
    if (!draft || draft.type !== tool) {
      setDraft({ type: tool, points: [point] });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const anchors = draft.points.slice(0, Math.max(1, pointCount(tool) - 1));
    const nextPoints = [...anchors, point];
    if (nextPoints.length >= pointCount(tool)) {
      commit([...drawings, { id: crypto.randomUUID(), symbol, timeframe, type: tool, points: nextPoints, color, lineStyle }]);
      setDraft(null); setTool('off');
    } else setDraft({ ...draft, points: nextPoints });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragHandleRef.current;
    if (drag) {
      const point = pointFromEvent(event, drag.pointIndex !== null);
      if (!point) return;
      const deltaTime = point.time - drag.origin.time;
      const deltaPrice = point.price - drag.origin.price;
      setDrawings((current) => current.map((drawing) => {
        if (drawing.id !== drag.id) return drawing;
        const points = drag.pointIndex === null
          ? drag.initialPoints.map((anchor) => ({ time: anchor.time + deltaTime, price: anchor.price + deltaPrice }))
          : drag.initialPoints.map((anchor, index) => index === drag.pointIndex ? point : anchor);
        return { ...drawing, points };
      }));
      return;
    }
    const point = pointFromEvent(event);
    if (!point) return;
    if (draft) {
      const anchors = draft.points.slice(0, Math.max(1, pointCount(draft.type) - 1));
      setDraft({ ...draft, points: [...anchors, point] });
    }
  };

  const deleteSelected = () => {
    const selected = drawings.find((drawing) => drawing.id === selectedId);
    if (selected?.locked) return;
    if (selectedId) { commit(drawings.filter((drawing) => drawing.id !== selectedId)); setSelectedId(null); }
  };
  const undo = () => {
    const previous = undoRef.current.pop();
    if (previous) setDrawings(previous);
    else if (draft) setDraft(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { deleteSelected(); return; }
      const shortcut = tools.find((item) => item.shortcut?.toLowerCase() === event.key.toLowerCase());
      if (shortcut) { setTool(shortcut.key); setDraft(null); }
      if (event.key === 'Escape') { setDraft(null); setTool('off'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const updateSelected = (update: Partial<StoredChartDrawing>) => {
    if (!selectedId) return;
    commit(drawings.map((drawing) => drawing.id === selectedId ? { ...drawing, ...update } : drawing));
  };
  const active = tool !== 'off';

  return (
    <>
      <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={() => { dragHandleRef.current = null; }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 4, pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }} />
      <div style={{ position: 'absolute', left: 8, top: 8, zIndex: 5 }}>
        <button aria-expanded={toolMenuOpen} onClick={() => setToolMenuOpen((open) => !open)}
          style={{ ...buttonStyle, padding: '7px 10px', background: 'rgba(11,14,20,.96)', color: '#e2e8f0', fontWeight: 700 }}>
          Drawing tools ▾{tool !== 'off' ? ` · ${tools.find((item) => item.key === tool)?.label ?? tool}` : ''}
        </button>
        {toolMenuOpen && <div style={{ position: 'absolute', top: 36, left: 0, width: 'min(340px, calc(100vw - 48px))', maxHeight: '65vh', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, padding: 10, background: 'rgba(11,14,20,.98)', border: '1px solid #334155', borderRadius: 6, boxShadow: '0 8px 28px #000a' }}>
          {tools.map((item) => (
            <button key={item.key} title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label} onClick={() => { setTool(item.key); setDraft(null); setToolMenuOpen(false); }}
              style={{ ...buttonStyle, color: '#e2e8f0', background: tool === item.key ? '#7c3aed' : '#1e293b' }}>
              {item.label}{item.shortcut ? ` (${item.shortcut})` : ''}
            </button>
          ))}
          <label style={labelStyle}>Color <input aria-label="Drawing color" type="color" value={color} onChange={(event) => setColor(event.target.value)} style={{ width: 30, height: 24, padding: 1 }} /></label>
          <label style={labelStyle}>Style <select aria-label="Line style" value={lineStyle} onChange={(event) => setLineStyle(event.target.value as typeof lineStyle)} style={selectStyle}>
            <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
          </select></label>
          <label style={{ ...labelStyle, gridColumn: 'span 2' }}>Note <input aria-label="Note text" value={note} onChange={(event) => setNote(event.target.value)} style={{ ...inputStyle, width: 115 }} /></label>
          <label style={labelStyle}><input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} /> Snap</label>
          <button onClick={undo} title="Undo (Ctrl+Z)" style={buttonStyle}>Undo</button>
          <button onClick={deleteSelected} title="Delete selected (Del)" style={buttonStyle}>Delete</button>
          <button onClick={() => updateSelected({ locked: !drawings.find((drawing) => drawing.id === selectedId)?.locked })} style={buttonStyle}>Lock</button>
          <button onClick={() => updateSelected({ hidden: !drawings.find((drawing) => drawing.id === selectedId)?.hidden })} style={buttonStyle}>Hide</button>
          <button onClick={() => setHiddenAll((current) => !current)} style={buttonStyle}>{hiddenAll ? 'Show all' : 'Hide all'}</button>
          <span style={{ gridColumn: 'span 3', color: '#64748b', fontSize: 10 }}>{drawings.length} saved · {readyScope === scope ? 'IndexedDB' : 'loading'}</span>
        </div>}
      </div>
    </>
  );
}

const buttonStyle: CSSProperties = {
  padding: '4px 6px', border: '1px solid #334155', borderRadius: 3,
  color: '#cbd5e1', background: '#172033', cursor: 'pointer', fontSize: 10
};
const labelStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: '#94a3b8', fontSize: 10, minWidth: 0 };
const selectStyle: CSSProperties = { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', fontSize: 10, minWidth: 0 };
const inputStyle: CSSProperties = { background: '#111827', color: '#e2e8f0', border: '1px solid #334155', fontSize: 10, minWidth: 0 };
