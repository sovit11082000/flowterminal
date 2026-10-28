import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api.js';
import type { BookLevel } from './DOMLadder.js';
import { findPersistentLiquidityWalls } from './LiquidityWallAnalysis.js';

export interface BookSample { symbol: string; time: number; bids: BookLevel[]; asks: BookLevel[]; }
interface HeatmapPayload { samples: BookSample[]; status: { sampleIntervalMs: number }; }
export interface TradeDot { symbol: string; timestamp: number; price: number; size: number; side: 'Buy' | 'Sell'; tradeId: string; }
interface TradePayload { samples: TradeDot[]; }

export default function OrderBookHeatmap({ symbol, enabled = true, renderPanel = true, onSnapshot }: {
  symbol: string; enabled?: boolean; renderPanel?: boolean; onSnapshot?: (snapshot: { samples: BookSample[]; trades: TradeDot[] }) => void;
}) {
  const [samples, setSamples] = useState<BookSample[]>([]);
  const [tradeDots, setTradeDots] = useState<TradeDot[]>([]);
  const [sampleIntervalMs, setSampleIntervalMs] = useState(500);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSamples([]);
    setTradeDots([]);
    const load = async () => {
      try {
        const start = Date.now() - 30 * 60_000;
        const [bookResponse, tradeResponse] = await Promise.all([
          fetch(apiUrl(`/api/orderbook/history?symbol=${encodeURIComponent(symbol)}&start=${start}&limit=1800`)),
          fetch(apiUrl(`/api/trades/history?symbol=${encodeURIComponent(symbol)}&start=${start}&limit=3000`))
        ]);
        if (bookResponse.ok) {
          const result = await bookResponse.json() as HeatmapPayload;
          if (!cancelled) {
            setSamples(result.samples ?? []);
            setSampleIntervalMs(result.status?.sampleIntervalMs ?? 500);
          }
        }
        if (tradeResponse.ok) {
          const result = await tradeResponse.json() as TradePayload;
          if (!cancelled) setTradeDots(result.samples ?? []);
        }
      } catch {
        if (!cancelled) setSamples([]);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [symbol]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#080b11';
      ctx.fillRect(0, 0, width, height);
      if (samples.length < 2) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for synchronized Bybit order-book samples. Restart the backend if this remains empty.', width / 2, height / 2);
        return;
      }

      const plot = { left: 72, right: width - 12, top: 12, bottom: height - 28 };
      const visibleTrades = tradeDots.filter((trade) => trade.timestamp >= samples[0].time && trade.timestamp <= samples[samples.length - 1].time);
      let minPrice = Number.POSITIVE_INFINITY;
      let maxPrice = Number.NEGATIVE_INFINITY;
      let maxSize = 0;
      const typicalSnapshotSizes: number[] = [];
      const snapshotSizes: number[] = [];
      for (const sample of samples) {
        snapshotSizes.length = 0;
        for (const [price, size] of sample.bids) {
          minPrice = Math.min(minPrice, price); maxPrice = Math.max(maxPrice, price);
          if (size > 0) { snapshotSizes.push(size); maxSize = Math.max(maxSize, size); }
        }
        for (const [price, size] of sample.asks) {
          minPrice = Math.min(minPrice, price); maxPrice = Math.max(maxPrice, price);
          if (size > 0) { snapshotSizes.push(size); maxSize = Math.max(maxSize, size); }
        }
        if (snapshotSizes.length) {
          snapshotSizes.sort((a, b) => a - b);
          typicalSnapshotSizes.push(snapshotSizes[Math.floor(snapshotSizes.length / 2)]);
        }
      }
      for (const trade of visibleTrades) {
        minPrice = Math.min(minPrice, trade.price);
        maxPrice = Math.max(maxPrice, trade.price);
      }
      typicalSnapshotSizes.sort((a, b) => a - b);
      const typicalBookSize = typicalSnapshotSizes[Math.floor(typicalSnapshotSizes.length / 2)] ?? maxSize;
      // A single oversized level should not wash out every other heatmap band.
      const liquidityScale = Math.max(typicalBookSize * 5, Number.EPSILON);
      const from = samples[0].time;
      const to = samples[samples.length - 1].time;
      const timeSpan = Math.max(to - from, 1);
      const priceSpan = Math.max(maxPrice - minPrice, Number.EPSILON);
      const columnWidth = Math.max(1, Math.min(5, (plot.right - plot.left) / samples.length * 1.2));
      const cellHeight = Math.max(2, Math.min(8, (plot.bottom - plot.top) / 45));
      const persistentWalls = findPersistentLiquidityWalls(samples);
      const strongestWall = (side: 'bid' | 'ask') => persistentWalls.find((level) => level.side === side);

      for (const sample of samples) {
        const x = plot.left + ((sample.time - from) / timeSpan) * (plot.right - plot.left);
        for (const [price, size] of sample.bids) {
          const y = plot.top + ((maxPrice - price) / priceSpan) * (plot.bottom - plot.top);
          const alpha = 0.08 + 0.76 * Math.sqrt(Math.min(size / liquidityScale, 1));
          ctx.fillStyle = `rgba(34, 211, 238, ${alpha})`;
          ctx.fillRect(Math.round(x), Math.round(y - cellHeight / 2), Math.ceil(columnWidth), cellHeight);
        }
        for (const [price, size] of sample.asks) {
          const y = plot.top + ((maxPrice - price) / priceSpan) * (plot.bottom - plot.top);
          const alpha = 0.08 + 0.76 * Math.sqrt(Math.min(size / liquidityScale, 1));
          ctx.fillStyle = `rgba(168, 85, 247, ${alpha})`;
          ctx.fillRect(Math.round(x), Math.round(y - cellHeight / 2), Math.ceil(columnWidth), cellHeight);
        }
      }

      // Mark a current wall only if it was repeatedly large during this sample window.
      for (const side of ['bid', 'ask'] as const) {
        const wall = strongestWall(side);
        if (!wall) continue;
        const y = Math.round(plot.top + ((maxPrice - wall.price) / priceSpan) * (plot.bottom - plot.top));
        ctx.save();
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
        ctx.fillStyle = '#fde68a';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(plot.left, y + 0.5); ctx.lineTo(plot.right, y + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = side === 'bid' ? 'left' : 'right';
        ctx.font = '10px monospace';
        ctx.fillText(`${side.toUpperCase()} WALL ${wall.price} · ${wall.persistencePct}%`, side === 'bid' ? plot.left + 4 : plot.right - 4, Math.max(plot.top + 10, y - 4));
        ctx.restore();
      }

      // Executed trades are plotted at their exchange timestamp and trade price.
      // They are distinct from liquidation markers, which use bankruptcy price.
      const bubbleBins = new Map<string, { x: number; y: number; size: number; side: 'Buy' | 'Sell' }>();
      for (const trade of visibleTrades) {
        const x = plot.left + ((trade.timestamp - from) / timeSpan) * (plot.right - plot.left);
        const y = plot.top + ((maxPrice - trade.price) / priceSpan) * (plot.bottom - plot.top);
        const key = `${Math.floor(x / 9)}:${Math.floor(y / 8)}:${trade.side}`;
        const bin = bubbleBins.get(key) ?? { x: 0, y: 0, size: 0, side: trade.side };
        bin.x += x * trade.size;
        bin.y += y * trade.size;
        bin.size += trade.size;
        bubbleBins.set(key, bin);
      }
      const largestBin = Array.from(bubbleBins.values()).reduce((max, bin) => Math.max(max, bin.size), 0);
      for (const bin of bubbleBins.values()) {
        const x = bin.x / bin.size;
        const y = bin.y / bin.size;
        const radius = Math.min(15, 4 + 10 * Math.sqrt(bin.size / largestBin));
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = bin.side === 'Buy' ? 'rgba(16, 185, 129, 0.62)' : 'rgba(239, 68, 68, 0.62)';
        ctx.fill();
        ctx.strokeStyle = bin.side === 'Buy' ? 'rgba(52, 211, 153, 0.72)' : 'rgba(248, 113, 113, 0.72)';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      ctx.strokeStyle = '#273244';
      ctx.beginPath(); ctx.moveTo(plot.left, plot.top); ctx.lineTo(plot.left, plot.bottom); ctx.lineTo(plot.right, plot.bottom); ctx.stroke();
      ctx.fillStyle = '#94a3b8'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
      ctx.fillText(maxPrice.toFixed(2), plot.left - 6, plot.top + 4);
      ctx.fillText(minPrice.toFixed(2), plot.left - 6, plot.bottom);
      ctx.textAlign = 'left';
      const indiaTime = (timestamp: number) => new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(new Date(timestamp));
      ctx.fillText(indiaTime(from), plot.left, height - 8);
      ctx.textAlign = 'right'; ctx.fillText(indiaTime(to), plot.right, height - 8);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [samples, tradeDots]);

  useEffect(() => { onSnapshot?.({ samples, trades: tradeDots }); }, [samples, tradeDots, onSnapshot]);

  if (!enabled || !renderPanel) return null;

  return (
    <section style={{ marginTop: 16, background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #1f2937', color: '#cbd5e1', fontSize: 13, fontWeight: 700 }}>
        <span>ORDER-BOOK HEATMAP · {symbol}</span>
        <span style={{ color: '#64748b', fontSize: 11 }}>Bybit public depth · {sampleIntervalMs} ms samples · downsampled · last 30 min</span>
      </header>
      <div style={{ display: 'flex', gap: 16, padding: '7px 12px', color: '#94a3b8', fontSize: 10 }}>
        <span style={{ color: '#22d3ee' }}>■ Bid liquidity</span><span style={{ color: '#c084fc' }}>■ Ask liquidity</span>
        <span>Brighter band = more resting liquidity</span>
        <span style={{ color: '#fde68a' }}>┄ Persistent wall</span>
        <span style={{ color: '#34d399' }}>● Buy trades</span><span style={{ color: '#f87171' }}>● Sell trades</span>
        <span>Larger dot = larger executed trade</span>
      </div>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 260 }} />
      <div style={{ padding: '6px 12px', color: '#64748b', fontSize: 10 }}>
        Gold wall marks require a level to be at least 3× that snapshot’s median displayed size in 10% or more of samples, and still present in the latest book. This is visible resting depth, not proof of a limit order’s intent. Dots show recorded trades at their actual time and price; recording starts with the backend, so earlier history may be incomplete.
      </div>
    </section>
  );
}
