import React from 'react';

export type BookLevel = [price: number, size: number];

interface DOMLadderProps {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export default function DOMLadder({ symbol, bids, asks }: DOMLadderProps) {
  const baseAsset = symbol.replace(/USDT$/, '');
  const maxSize = Math.max(Number.EPSILON, ...bids.map(([, size]) => size), ...asks.map(([, size]) => size));
  let askTotal = 0;
  const askRows = [...asks].slice(0, 12).map(([price, size]) => {
    askTotal += size;
    return { price, size, total: askTotal };
  }).reverse();
  let bidTotal = 0;
  const bidRows = bids.slice(0, 12).map(([price, size]) => {
    bidTotal += size;
    return { price, size, total: bidTotal };
  });
  const rowStyle: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8,
    position: 'relative', padding: '4px 8px', fontSize: 12, fontFamily: 'monospace'
  };

  const renderRows = (rows: Array<{ price: number; size: number; total: number }>, side: 'bid' | 'ask') => (
    rows.map((row) => (
      <div key={`${side}-${row.price}`} style={{ ...rowStyle, color: side === 'bid' ? '#34d399' : '#fb7185', background: '#0b0e14' }}>
        <div style={{ position: 'absolute', inset: '1px 0 1px auto', width: `${Math.min(100, row.size / maxSize * 100)}%`, background: side === 'bid' ? 'rgba(16,185,129,.11)' : 'rgba(239,68,68,.11)' }} />
        <span style={{ zIndex: 1 }}>{row.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}</span>
        <span style={{ zIndex: 1, textAlign: 'right' }}>{row.size.toFixed(3)}</span>
        <span style={{ zIndex: 1, textAlign: 'right', color: '#94a3b8' }}>{row.total.toFixed(3)}</span>
      </div>
    ))
  );

  return (
    <section style={{ background: '#0b0e14', border: '1px solid #1f2937', borderRadius: 6, overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #1f2937', color: '#cbd5e1', fontSize: 13, fontWeight: 700 }}>
        <span>DOM LADDER · {symbol}</span><span style={{ color: '#64748b', fontSize: 11 }}>Live · top 12 levels</span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '5px 8px', color: '#64748b', fontSize: 10, textTransform: 'uppercase' }}>
        <span>Price (USDT)</span><span style={{ textAlign: 'right' }}>Size ({baseAsset})</span><span style={{ textAlign: 'right' }}>Cum.</span>
      </div>
      {bids.length === 0 && asks.length === 0 ? (
        <div style={{ padding: 18, textAlign: 'center', color: '#fbbf24', fontSize: 12 }}>No synchronized Bybit order book yet · check backend connection and restart it if this remains empty.</div>
      ) : (
        <>
          {renderRows(askRows, 'ask')}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 8px', background: '#111827', color: '#e2e8f0', fontSize: 11 }}>
            <span>Spread</span><span>{bids[0] && asks[0] ? (asks[0][0] - bids[0][0]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : '—'} USDT</span>
          </div>
          {renderRows(bidRows, 'bid')}
        </>
      )}
    </section>
  );
}
