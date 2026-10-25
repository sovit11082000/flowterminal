import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { apiUrl } from '../lib/api.js';

interface OptionRow {
  symbol: string;
  strike: number;
  optionType: 'CALL' | 'PUT';
  expiry: string;
  openInterest: number;
  gamma: number | null;
  delta: number | null;
  markIv: number | null;
  markPrice: number | null;
  underlyingPrice: number | null;
}

export interface Snapshot {
  baseCoin: 'BTC' | 'ETH';
  source: string;
  fetchedAt: number;
  underlyingPrice: number | null;
  rows: OptionRow[];
  tickerCount: number;
  rejectedTickerCount: number;
  unrecognizedSymbolCount: number;
  missingOpenInterestCount: number;
  gammaUnavailableCount: number;
}

interface StrikeSummary {
  strike: number;
  calls: number;
  puts: number;
  callGammaOi: number;
  putGammaOi: number;
  contracts: number;
  gammaContracts: number;
}

const panelStyle: CSSProperties = { marginTop: 14, padding: 12, border: '1px solid #243244', borderRadius: 6, background: '#0b111b', color: '#dbeafe' };
const muted: CSSProperties = { color: '#8495ad', fontSize: 11 };

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

export default function GammaLevelsPanel({ symbol, onSnapshot }: { symbol: string; onSnapshot?: (snapshot: Snapshot | null) => void }) {
  const baseCoin = symbol === 'BTCUSDT' ? 'BTC' : symbol === 'ETHUSDT' ? 'ETH' : null;
  const [source, setSource] = useState<'binance' | 'bybit'>('binance');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    if (!baseCoin) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      try {
        const response = await fetch(apiUrl(`/api/options-gamma?baseCoin=${baseCoin}&source=${source}`), { signal: controller.signal, cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Options request failed (${response.status}).`);
        if (!cancelled) {
          setSnapshot(body as Snapshot);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled && !(err instanceof Error && err.name === 'AbortError')) {
          setSnapshot(null);
          setError(err instanceof Error ? err.message : `${source} options data is unavailable.`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [baseCoin, source]);

  useEffect(() => { onSnapshot?.(snapshot); }, [snapshot, onSnapshot]);

  const summary = useMemo(() => {
    if (!snapshot) return [] as StrikeSummary[];
    const byStrike = new Map<number, StrikeSummary>();
    for (const row of snapshot.rows) {
      let level = byStrike.get(row.strike);
      if (!level) {
        level = { strike: row.strike, calls: 0, puts: 0, callGammaOi: 0, putGammaOi: 0, contracts: 0, gammaContracts: 0 };
        byStrike.set(row.strike, level);
      }
      level.contracts += 1;
      if (row.gamma !== null) level.gammaContracts += 1;
      if (row.optionType === 'CALL') {
        level.calls += row.openInterest;
        if (row.gamma !== null) level.callGammaOi += row.gamma * row.openInterest;
      } else {
        level.puts += row.openInterest;
        if (row.gamma !== null) level.putGammaOi += row.gamma * row.openInterest;
      }
    }
    return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
  }, [snapshot]);

  if (!baseCoin) return null;

  const callWall = summary.reduce<StrikeSummary | null>((best, level) => !best || level.calls > best.calls ? level : best, null);
  const putWall = summary.reduce<StrikeSummary | null>((best, level) => !best || level.puts > best.puts ? level : best, null);
  const gammaRows = summary.filter((level) => level.gammaContracts > 0);
  const gammaWall = gammaRows.reduce<StrikeSummary | null>((best, level) => {
    const gross = level.callGammaOi + level.putGammaOi;
    const bestGross = best ? best.callGammaOi + best.putGammaOi : -1;
    return !best || gross > bestGross ? level : best;
  }, null);
  const topLevels = [...summary]
    .sort((a, b) => (b.callGammaOi + b.putGammaOi) - (a.callGammaOi + a.putGammaOi))
    .slice(0, 12)
    .sort((a, b) => a.strike - b.strike);
  const maxGammaOi = Math.max(1, ...topLevels.map((level) => level.callGammaOi + level.putGammaOi));

  return (
    <section style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>OPTIONS GAMMA LEVELS · {baseCoin}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={muted}>Source <select value={source} onChange={(event) => setSource(event.target.value as 'binance' | 'bybit')} style={{ marginLeft: 5, padding: '4px 6px', background: '#172333', color: '#dbeafe', border: '1px solid #334155', borderRadius: 4 }}>
            <option value="binance">Binance Options</option>
            <option value="bybit">Bybit Options</option>
          </select></label>
          <span style={muted}>{loading ? `Refreshing ${source} data…` : snapshot ? `${snapshot.source} · updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}` : 'Waiting for live market data'}</span>
        </div>
      </div>
      {!snapshot ? (
        <div style={{ ...muted, padding: '18px 2px' }}>{error ?? (loading ? 'Loading live option chain…' : 'No live options snapshot yet.')}</div>
      ) : snapshot.rows.length === 0 ? (
        <div style={{ ...muted, padding: '18px 2px', lineHeight: 1.7 }}>
          {snapshot.tickerCount === 0
            ? `${snapshot.source} returned an empty ${baseCoin} options chain. No levels are being estimated.`
            : `${snapshot.source} returned ${snapshot.tickerCount} contracts: ${snapshot.unrecognizedSymbolCount} symbols were not recognized and ${snapshot.missingOpenInterestCount} lacked open interest, so ${snapshot.rows.length} contracts could be used. Gamma was unavailable for ${snapshot.gammaUnavailableCount} rows. No levels are estimated when the required source data is missing.`}
          <div style={{ marginTop: 5 }}>When open interest is present, call/put OI walls can still display even if some contracts have no gamma. Gamma concentration is shown only for contracts where the selected exchange supplies gamma.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', padding: '12px 0', borderBottom: '1px solid #243244' }}>
            <div><div style={muted}>UNDERLYING · {snapshot.source.split(' ')[0].toUpperCase()}</div><b>{snapshot.underlyingPrice === null ? '—' : formatNumber(snapshot.underlyingPrice, 4)}</b></div>
            <div><div style={muted}>CALL WALL · MAX CALL OI</div><b style={{ color: '#34d399' }}>{callWall ? formatNumber(callWall.strike, 4) : '—'}</b></div>
            <div><div style={muted}>PUT WALL · MAX PUT OI</div><b style={{ color: '#fb7185' }}>{putWall ? formatNumber(putWall.strike, 4) : '—'}</b></div>
            <div><div style={muted}>GAMMA WALL · MAX GROSS Γ×OI</div><b style={{ color: '#fbbf24' }}>{gammaWall ? formatNumber(gammaWall.strike, 4) : 'Unavailable'}</b></div>
            <div><div style={muted}>CONTRACTS IN SNAPSHOT</div><b>{snapshot.rows.length}</b></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1fr) minmax(100px, 1fr) minmax(100px, 1fr) minmax(180px, 2fr)', gap: 8, padding: '8px 0', ...muted }}>
            <span>STRIKE</span><span>CALL OI</span><span>PUT OI</span><span>GROSS Γ×OI (relative bar)</span>
          </div>
          <div style={{ maxHeight: 250, overflow: 'auto' }}>
            {topLevels.map((level) => {
              const gross = level.callGammaOi + level.putGammaOi;
              return <div key={level.strike} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1fr) minmax(100px, 1fr) minmax(100px, 1fr) minmax(180px, 2fr)', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #172333', fontSize: 11 }}>
                <b>{formatNumber(level.strike, 4)}</b>
                <span style={{ color: '#34d399' }}>{formatNumber(level.calls, 4)}</span>
                <span style={{ color: '#fb7185' }}>{formatNumber(level.puts, 4)}</span>
                <div style={{ height: 8, borderRadius: 5, background: '#172333', overflow: 'hidden' }} title={level.gammaContracts ? `Call Γ×OI ${formatNumber(level.callGammaOi, 6)} · Put Γ×OI ${formatNumber(level.putGammaOi, 6)}` : `${snapshot.source} did not supply gamma for these contracts`}>
                  {level.gammaContracts > 0 && <div style={{ width: `${Math.max(1, gross / maxGammaOi * 100)}%`, height: '100%', background: 'linear-gradient(90deg, #34d399, #fbbf24, #fb7185)' }} />}
                </div>
              </div>;
            })}
          </div>
          <div style={{ ...muted, borderTop: '1px solid #243244', marginTop: 8, paddingTop: 8, lineHeight: 1.5 }}>
          Source: {snapshot.source}. Call/put walls use exchange-reported open interest; gamma concentration ranks only contracts where the exchange supplied Γ×OI ({snapshot.rows.filter((row) => row.gamma !== null).length}/{snapshot.rows.length} rows have gamma). Open interest does not reveal whether customers or dealers are long; these are not confirmed support/resistance levels. Missing exchange fields are left unavailable, not estimated.
          </div>
        </>
      )}
    </section>
  );
}
