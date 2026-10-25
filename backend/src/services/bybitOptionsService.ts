export type OptionBase = 'BTC' | 'ETH';

export interface OptionMarketRow {
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

export interface OptionGammaSnapshot {
  baseCoin: OptionBase;
  source: string;
  fetchedAt: number;
  underlyingPrice: number | null;
  rows: OptionMarketRow[];
  tickerCount: number;
  rejectedTickerCount: number;
  unrecognizedSymbolCount: number;
  missingOpenInterestCount: number;
  gammaUnavailableCount: number;
}

interface BybitOptionsResponse {
  retCode: number;
  retMsg?: string;
  result?: { list?: Record<string, string>[] };
  time?: number;
}

function finite(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInstrument(symbol: string): Pick<OptionMarketRow, 'strike' | 'optionType' | 'expiry'> | null {
  // Bybit symbols use BASE-DDMMMYY-STRIKE-C/P. Accept a four-digit year too
  // so a naming-format change does not silently hide the whole live chain.
  const match = /^([A-Z0-9]+)-(\d{1,2}[A-Z]{3}\d{2,4})-(\d+(?:\.\d+)?)-([CP])$/.exec(symbol);
  if (!match) return null;
  const strike = Number(match[3]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    expiry: match[2],
    strike,
    optionType: match[4] === 'C' ? 'CALL' : 'PUT'
  };
}

export class BybitOptionsService {
  constructor(private readonly baseUrl = 'https://api.bybit.com', private readonly fetchFn: typeof fetch = fetch) {}

  async fetchSnapshot(baseCoin: OptionBase): Promise<OptionGammaSnapshot> {
    const url = new URL('/v5/market/tickers', this.baseUrl);
    url.searchParams.set('category', 'option');
    url.searchParams.set('baseCoin', baseCoin);
    const response = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Bybit options request failed with HTTP ${response.status}.`);
    const payload = await response.json() as BybitOptionsResponse;
    if (payload.retCode !== 0) throw new Error(`Bybit options API error ${payload.retCode}: ${payload.retMsg ?? 'Unknown error'}`);

    const tickers = Array.isArray(payload.result?.list) ? payload.result.list : [];
    let unrecognizedSymbolCount = 0;
    let missingOpenInterestCount = 0;
    let gammaUnavailableCount = 0;
    const rows = tickers.flatMap((item): OptionMarketRow[] => {
      const symbol = item.symbol?.toUpperCase();
      if (!symbol) return [];
      const contract = parseInstrument(symbol);
      const openInterest = finite(item.openInterest);
      const gamma = finite(item.gamma);
      // Keep valid option/OI rows even when Bybit omits a Greek for an inactive
      // contract. OI walls remain real; gamma walls are withheld without gamma.
      if (!contract) { unrecognizedSymbolCount += 1; return []; }
      if (openInterest === null || openInterest < 0) { missingOpenInterestCount += 1; return []; }
      if (gamma === null) gammaUnavailableCount += 1;
      if (gamma !== null && gamma < 0) { gammaUnavailableCount += 1; return []; }
      return [{
        symbol,
        ...contract,
        openInterest,
        gamma,
        delta: finite(item.delta),
        markIv: finite(item.markIv),
        markPrice: finite(item.markPrice),
        underlyingPrice: finite(item.underlyingPrice)
      }];
    });
    const validUnderlyingPrices = rows.map((row) => row.underlyingPrice).filter((price): price is number => price !== null && price > 0);
    const underlyingPrice = validUnderlyingPrices.length
      ? validUnderlyingPrices.reduce((sum, price) => sum + price, 0) / validUnderlyingPrices.length
      : null;
    return {
      baseCoin,
      source: 'Bybit public options market data',
      fetchedAt: Number.isFinite(payload.time) ? payload.time! : Date.now(),
      underlyingPrice,
      rows: rows.sort((a, b) => a.strike - b.strike || a.expiry.localeCompare(b.expiry)),
      tickerCount: tickers.length,
      rejectedTickerCount: unrecognizedSymbolCount + missingOpenInterestCount,
      unrecognizedSymbolCount,
      missingOpenInterestCount,
      gammaUnavailableCount
    };
  }
}
