import type { OptionBase, OptionGammaSnapshot, OptionMarketRow } from './bybitOptionsService.js';

interface BinanceExchangeInfo {
  serverTime?: number;
  optionSymbols?: Array<{
    symbol?: string;
    side?: string;
    strikePrice?: string;
    expiryDate?: number;
    underlying?: string;
    unit?: number;
    status?: string;
  }>;
}

interface BinanceTicker { symbol?: string; }
interface BinanceMark {
  symbol?: string;
  markPrice?: string;
  markIV?: string;
  delta?: string;
  gamma?: string;
}
interface BinanceOpenInterest {
  symbol?: string;
  sumOpenInterest?: string;
}

function finite(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function contractDetails(symbol: string): Pick<OptionMarketRow, 'strike' | 'optionType' | 'expiry'> | null {
  const match = /^(BTC|ETH)-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/.exec(symbol.toUpperCase());
  if (!match) return null;
  const [, , expiryCode, strikeText, side] = match;
  const year = 2000 + Number(expiryCode.slice(0, 2));
  const month = Number(expiryCode.slice(2, 4));
  const day = Number(expiryCode.slice(4, 6));
  const expiry = new Date(Date.UTC(year, month - 1, day));
  if (expiry.getUTCMonth() !== month - 1 || expiry.getUTCDate() !== day) return null;
  const strike = Number(strikeText);
  if (!(strike > 0)) return null;
  return {
    strike,
    optionType: side === 'C' ? 'CALL' : 'PUT',
    expiry: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

function expirationQuery(expiry: string): string {
  const [year, month, day] = expiry.split('-');
  return `${year.slice(-2)}${month}${day}`;
}

export class BinanceOptionsService {
  constructor(
    private readonly baseUrl = 'https://eapi.binance.com',
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Binance options ${path} failed with HTTP ${response.status}.`);
    return await response.json() as T;
  }

  async fetchSnapshot(baseCoin: OptionBase): Promise<OptionGammaSnapshot> {
    const underlying = `${baseCoin}USDT`;
    const [exchangeInfo, tickers, marks, index] = await Promise.all([
      this.get<BinanceExchangeInfo>('/eapi/v1/exchangeInfo'),
      this.get<BinanceTicker[]>('/eapi/v1/ticker'),
      this.get<BinanceMark[]>('/eapi/v1/mark'),
      this.get<{ indexPrice?: string; time?: number }>('/eapi/v1/index', { underlying })
    ]);

    const listed = (exchangeInfo.optionSymbols ?? []).filter((item) =>
      item.symbol?.startsWith(`${baseCoin}-`) &&
      (item.status === undefined || item.status === 'TRADING')
    );
    const tickerSymbols = new Set((tickers ?? []).map((row) => row.symbol).filter((symbol): symbol is string => !!symbol));
    const markBySymbol = new Map((marks ?? []).filter((row) => !!row.symbol).map((row) => [row.symbol!, row]));
    const expiryCodes = [...new Set(listed.map((item) => {
      const match = item.symbol?.match(/^[A-Z]+-(\d{6})-/);
      return match?.[1];
    }).filter((value): value is string => !!value))];

    // Binance reports OI by underlying+expiry, then identifies each contract
    // in the returned list. Its 24h ticker endpoint is not an OI/Greeks feed.
    const oiResults = await Promise.all(expiryCodes.map(async (expiration) => {
      const rows = await this.get<BinanceOpenInterest[]>('/eapi/v1/openInterest', {
        underlyingAsset: underlying,
        expiration
      });
      return rows ?? [];
    }));
    const oiBySymbol = new Map<string, number>();
    for (const row of oiResults.flat()) {
      const oi = finite(row.sumOpenInterest);
      if (row.symbol && oi !== null && oi >= 0) oiBySymbol.set(row.symbol, oi);
    }

    let unrecognizedSymbolCount = 0;
    let missingOpenInterestCount = 0;
    let gammaUnavailableCount = 0;
    const rows: OptionMarketRow[] = [];
    for (const item of listed) {
      const symbol = item.symbol?.toUpperCase();
      if (!symbol) continue;
      const details = contractDetails(symbol);
      const openInterest = oiBySymbol.get(symbol);
      if (!details) { unrecognizedSymbolCount++; continue; }
      if (openInterest === undefined) { missingOpenInterestCount++; continue; }
      const mark = markBySymbol.get(symbol);
      const gamma = finite(mark?.gamma);
      if (gamma === null) gammaUnavailableCount++;
      const delta = finite(mark?.delta);
      rows.push({
        symbol,
        ...details,
        openInterest,
        gamma: gamma !== null && gamma >= 0 ? gamma : null,
        delta,
        markIv: finite(mark?.markIV),
        markPrice: finite(mark?.markPrice),
        underlyingPrice: finite(index?.indexPrice)
      });
    }

    return {
      baseCoin,
      source: 'Binance Options public market data',
      fetchedAt: Number.isFinite(exchangeInfo.serverTime) ? exchangeInfo.serverTime! : Date.now(),
      underlyingPrice: finite(index?.indexPrice),
      rows: rows.sort((a, b) => a.strike - b.strike || a.expiry.localeCompare(b.expiry)),
      tickerCount: listed.length || tickerSymbols.size,
      rejectedTickerCount: unrecognizedSymbolCount + missingOpenInterestCount,
      unrecognizedSymbolCount,
      missingOpenInterestCount,
      gammaUnavailableCount
    };
  }
}
