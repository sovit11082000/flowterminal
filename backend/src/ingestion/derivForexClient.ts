import type { ConnectionStatus, NormalizedCandle, NormalizedTrade, CandleTimeframe } from '../types/market.js';

const SWISSQUOTE_PAIRS: Record<string, { base: string; quote: string }> = {
  XAUUSD: { base: 'XAU', quote: 'USD' },
  EURUSD: { base: 'EUR', quote: 'USD' },
  GBPUSD: { base: 'GBP', quote: 'USD' }
};

const YAHOO_SYMBOLS: Record<string, string> = {
  XAUUSD: 'GC=F',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X'
};

export interface DerivForexHandlers {
  onStatusChange?: (status: ConnectionStatus, message?: string) => void;
  onTrades: (trades: NormalizedTrade[]) => void;
}

export class DerivForexClient {
  private pollTimer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private isConnected = false;
  private lastQuoteBySymbol = new Map<string, { bid: number; ask: number; mid: number }>();
  private readonly symbols: string[];
  private readonly handlers: DerivForexHandlers;

  constructor(symbols: readonly string[], handlers: DerivForexHandlers) {
    this.symbols = symbols.filter((s) => Boolean(SWISSQUOTE_PAIRS[s]));
    this.handlers = handlers;
  }

  public connect(): void {
    if (!this.symbols.length) return;
    this.isStopped = false;
    if (this.pollTimer) clearInterval(this.pollTimer);

    const pollOnce = async () => {
      if (this.isStopped) return;
      const batchTrades: NormalizedTrade[] = [];

      await Promise.all(
        this.symbols.map(async (symbol) => {
          const pair = SWISSQUOTE_PAIRS[symbol];
          if (!pair) return;
          try {
            const url = `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${pair.base}/${pair.quote}`;
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
            });
            if (!res.ok) return;

            const payload = (await res.json()) as Array<{
              spreadProfilePrices?: Array<{ bid?: number; ask?: number }>;
            }>;

            const quote = payload?.[0]?.spreadProfilePrices?.[0];
            const bid = Number(quote?.bid);
            const ask = Number(quote?.ask);
            if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;

            const mid = Number(((bid + ask) / 2).toFixed(symbol === 'XAUUSD' ? 2 : 5));
            const prev = this.lastQuoteBySymbol.get(symbol);
            this.lastQuoteBySymbol.set(symbol, { bid, ask, mid });

            // Emit tick only when price actually moves (or on first quote)
            if (!prev || prev.mid !== mid || prev.bid !== bid || prev.ask !== ask) {
              const side = !prev || mid > prev.mid || ask > prev.ask ? 'Buy' : 'Sell';
              const timestamp = Date.now();
              batchTrades.push({
                tradeId: `fx-${symbol}-${timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                symbol,
                price: mid,
                size: 1,
                side,
                timestamp
              });
            }
          } catch {
            // ignore transient network blip
          }
        })
      );

      if (!this.isConnected && batchTrades.length > 0) {
        this.isConnected = true;
        console.log(`[Forex Feed] Live BBO connected for ${this.symbols.join(', ')} (Swissquote Institutional Feed)`);
        this.handlers.onStatusChange?.('LIVE', 'Swissquote Forex & Gold feed live');
      }

      if (batchTrades.length > 0) {
        this.handlers.onTrades(batchTrades);
      }
    };

    void pollOnce();
    const pollIntervalMs = Math.max(10_000, Number(process.env.FOREX_POLL_INTERVAL_MS || 10_000));
    this.pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
  }

  public disconnect(): void {
    this.isStopped = true;
    this.isConnected = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  public static async fetchHistoricalCandles(params: {
    symbol: string;
    timeframe: CandleTimeframe;
    count?: number;
  }): Promise<NormalizedCandle[]> {
    const yahooSym = YAHOO_SYMBOLS[params.symbol];
    if (!yahooSym) return [];

    const intervalMap: Record<CandleTimeframe, { interval: string; range: string; resample4h?: boolean }> = {
      '1m': { interval: '1m', range: '1d' },
      '3m': { interval: '5m', range: '5d' },
      '5m': { interval: '5m', range: '5d' },
      '15m': { interval: '15m', range: '5d' },
      '30m': { interval: '30m', range: '1mo' },
      '1h': { interval: '1h', range: '1mo' },
      '4h': { interval: '1h', range: '1mo', resample4h: true },
      '1d': { interval: '1d', range: '1mo' }
    };

    const cfg = intervalMap[params.timeframe] ?? { interval: '15m', range: '5d' };
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${cfg.interval}&range=${cfg.range}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        chart?: {
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: Array<number | null>;
                high?: Array<number | null>;
                low?: Array<number | null>;
                close?: Array<number | null>;
                volume?: Array<number | null>;
              }>;
            };
          }>;
        };
      };

      const result = data.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const q = result?.indicators?.quote?.[0];
      if (!timestamps.length || !q) return [];

      const rawCandles: NormalizedCandle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const open = Number(q.open?.[i]);
        const high = Number(q.high?.[i]);
        const low = Number(q.low?.[i]);
        const close = Number(q.close?.[i]);
        const volume = Number(q.volume?.[i] ?? 100);
        if (![open, high, low, close].every(Number.isFinite) || open <= 0 || close <= 0) continue;

        rawCandles.push({
          symbol: params.symbol,
          timeframe: params.timeframe,
          time: Number(timestamps[i]),
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) && volume > 0 ? volume : 100,
          tradesCount: 0,
          buyVolume: 0,
          sellVolume: 0,
          delta: 0,
          isClosed: true
        });
      }

      if (cfg.resample4h) {
        const grouped: NormalizedCandle[] = [];
        for (let i = 0; i < rawCandles.length; i += 4) {
          const chunk = rawCandles.slice(i, i + 4);
          if (!chunk.length) continue;
          grouped.push({
            ...chunk[0],
            timeframe: '4h',
            high: Math.max(...chunk.map((c) => c.high)),
            low: Math.min(...chunk.map((c) => c.low)),
            close: chunk[chunk.length - 1].close,
            volume: chunk.reduce((s, c) => s + c.volume, 0)
          });
        }
        return grouped.slice(-(params.count ?? 60));
      }

      return rawCandles.slice(-(params.count ?? 120));
    } catch {
      return [];
    }
  }
}