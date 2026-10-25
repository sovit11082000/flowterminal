import { useEffect, useMemo, useState } from 'react';
import type { Trade } from '../types/market.js';
import type { BookLevel } from './DOMLadder.js';

interface Candidate { price: number; side: 'Buy' | 'Sell'; count: number; volume: number; displayed: number; lastTime: number; }

/** Heuristic only: public trades and sampled depth cannot prove a hidden order. */
export default function IcebergSignals({ symbol, trades, bids, asks }: {
  symbol: string; trades: Trade[]; bids: BookLevel[]; asks: BookLevel[];
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const candidates = useMemo(() => {
    const groups = new Map<string, Candidate>();
    for (const trade of trades) {
      if (now - trade.timestamp > 30_000 || trade.symbol !== symbol) continue;
      const key = `${trade.side}:${trade.price}`;
      const group = groups.get(key) ?? { price: trade.price, side: trade.side, count: 0, volume: 0, displayed: 0, lastTime: trade.timestamp };
      group.count += 1;
      group.volume += trade.size;
      group.lastTime = Math.max(group.lastTime, trade.timestamp);
      groups.set(key, group);
    }
    const bookBySide = { Buy: asks, Sell: bids };
    return [...groups.values()].map((group) => {
      group.displayed = bookBySide[group.side].find(([price]) => price === group.price)?.[1] ?? 0;
      return group;
    }).filter((group) => group.count >= 4 && group.displayed > 0 && group.volume >= group.displayed * 1.5)
      .sort((a, b) => b.volume / b.displayed - a.volume / a.displayed)
      .slice(0, 5);
  }, [symbol, trades, bids, asks, now]);
  const recentTradeCount = trades.filter((trade) => trade.symbol === symbol && now - trade.timestamp <= 30_000).length;
  const bookLevelCount = bids.length + asks.length;

  return (
    <section style={{ marginTop: 12, background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px', borderBottom: '1px solid #1f2937', color: '#cbd5e1', fontSize: 12, fontWeight: 700 }}>
        <span>POSSIBLE ICEBERG / ABSORPTION · {symbol}</span>
        <span style={{ color: '#fbbf24', fontSize: 10 }}>Heuristic · not confirmed hidden orders</span>
      </header>
      {candidates.length === 0 ? <div style={{ padding: 12, color: '#64748b', fontSize: 11 }}>
        <div style={{ color: '#cbd5e1' }}>{recentTradeCount === 0 ? 'Waiting for recent public trades.' : 'No repeated-trade / remaining-depth pattern detected right now.'}</div>
        <div style={{ marginTop: 5 }}>Monitor: {recentTradeCount} trades in the last 30 sec · {bookLevelCount} displayed DOM levels · {candidates.length} candidates.</div>
        <div style={{ marginTop: 5 }}>A candidate needs at least 4 executions at the same price, executed volume above 1.5× the size still displayed there, and that displayed order still present. This is a rough absorption proxy; current DOM plus public trades cannot prove an iceberg or show whether the order replenished over time.</div>
      </div> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, padding: 10 }}>
        {candidates.map((item) => <div key={`${item.side}-${item.price}`} style={{ padding: 9, background: '#111827', borderLeft: `3px solid ${item.side === 'Buy' ? '#fb7185' : '#34d399'}`, borderRadius: 4, fontSize: 11 }}>
          <strong style={{ color: item.side === 'Buy' ? '#fb7185' : '#34d399' }}>{item.side === 'Buy' ? 'Repeated buys at ask' : 'Repeated sells at bid'}</strong>
          <div style={{ color: '#cbd5e1', marginTop: 4 }}>Possible absorption proxy near {item.price.toFixed(2)}</div>
          <div style={{ color: '#94a3b8', marginTop: 3 }}>{item.count} prints · {item.volume.toFixed(4)} executed / {item.displayed.toFixed(4)} currently displayed</div>
        </div>)}
      </div>}
      <div style={{ padding: '0 12px 9px', color: '#64748b', fontSize: 10 }}>This monitor compares a 30-second public-trade sample with the current displayed book. It does not yet store per-price book history, so it cannot verify replenishment or prove a hidden order.</div>
    </section>
  );
}
