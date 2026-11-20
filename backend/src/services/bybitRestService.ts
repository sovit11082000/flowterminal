/**
 * FlowTerminal - Bybit V5 REST Historical Candle Ingestion Service
 * 
 * Official Endpoint: GET https://api.bybit.com/v5/market/kline
 * Reference: https://bybit-exchange.github.io/docs/v5/market/kline
 * Scope: Linear USDT Perpetual Historical Kline Ingestion (Public Data Only)
 */

export type CandleTimeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

const BYBIT_INTERVAL: Record<CandleTimeframe, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '4h': '240', '1d': 'D'
};
const INTERVAL_MS: Record<CandleTimeframe, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000
};

export interface HistoricalCandle {
  symbol: string;
  timeframe: CandleTimeframe;
  time: number; // Unix timestamp in seconds (Lightweight Charts compliant)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // Base asset volume (BTC for BTCUSDT)
  turnover: number; // Quote asset volume (USDT)
}

export interface HistoryRequestOptions {
  symbol?: string;
  timeframe: CandleTimeframe;
  startTimeMs?: number;
  endTimeMs?: number;
  limitPerPage?: number;
}

export type HistoryTerminationReason =
  | 'RANGE_EXHAUSTED'
  | 'UPSTREAM_END_OF_DATA'
  | 'NO_PROGRESS_CURSOR'
  | 'PARTIALLY_CORRUPT_PAGE'
  | 'MAX_PAGES_REACHED';

export interface HistoryFetchMetadata {
  requestedRange: {
    startMs: number;
    endMs: number;
  };
  actualRange: {
    firstCandleTimeSec: number | null;
    lastCandleTimeSec: number | null;
  };
  totalPagesFetched: number;
  totalCandlesReturned: number;
  hasCorruptRows: boolean;
  isComplete: boolean;
  terminationReason: HistoryTerminationReason;
}

export interface HistoryFetchResult {
  symbol: string;
  timeframe: CandleTimeframe;
  candles: HistoricalCandle[];
  metadata: HistoryFetchMetadata;
}

export interface BybitKlineResponseRaw {
  retCode: number;
  retMsg: string;
  result?: {
    category?: string;
    symbol?: string;
    list?: string[][];
  };
  retExtInfo?: Record<string, unknown>;
  time?: number;
}

export class BybitRestServiceError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retCode?: number;

  constructor(message: string, code: string, status?: number, retCode?: number) {
    super(message);
    this.name = 'BybitRestServiceError';
    this.code = code;
    this.status = status;
    this.retCode = retCode;
  }
}

export type FetchFunction = typeof fetch;
export type SleepFunction = (ms: number) => Promise<void>;

export interface BybitRestServiceOptions {
  baseUrl?: string;
  fetchFn?: FetchFunction;
  sleepFn?: SleepFunction;
  maxRetries?: number;
  requestTimeoutMs?: number;
  maxPagesLimit?: number;
  pageDelayMs?: number;
}

export class BybitRestService {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFunction;
  private readonly sleepFn: SleepFunction;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPagesLimit: number;
  private readonly pageDelayMs: number;

  constructor(options?: BybitRestServiceOptions) {
    this.baseUrl = (options?.baseUrl || 'https://api.bybit.com').replace(/\/+$/, '');
    this.fetchFn = options?.fetchFn || fetch;
    this.sleepFn = options?.sleepFn || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    const rawRetries = options?.maxRetries;
    this.maxRetries = Number.isFinite(rawRetries) ? Math.min(Math.max(Math.floor(rawRetries!), 0), 10) : 3;

    const rawTimeout = options?.requestTimeoutMs;
    this.requestTimeoutMs = Number.isFinite(rawTimeout) ? Math.min(Math.max(Math.floor(rawTimeout!), 1_000), 60_000) : 10_000;

    const rawMaxPages = options?.maxPagesLimit;
    this.maxPagesLimit = Number.isFinite(rawMaxPages) ? Math.min(Math.max(Math.floor(rawMaxPages!), 1), 500) : 120;

    const rawPageDelay = options?.pageDelayMs;
    this.pageDelayMs = Number.isFinite(rawPageDelay) ? Math.min(Math.max(Math.floor(rawPageDelay!), 0), 5_000) : 120;
  }

  public async fetchHistoricalCandles(options: HistoryRequestOptions): Promise<HistoryFetchResult> {
    if (!options || typeof options !== 'object') {
      throw new BybitRestServiceError('Options parameter must be an object.', 'INVALID_OPTIONS');
    }

    const rawSymbol = typeof options.symbol === 'string' ? options.symbol.trim().toUpperCase() : 'BTCUSDT';
    if (!rawSymbol || !/^[A-Z0-9_-]+$/.test(rawSymbol)) {
      throw new BybitRestServiceError(`Invalid market symbol: "${options.symbol}". Must be non-empty alphanumeric.`, 'INVALID_SYMBOL');
    }
    const symbol = rawSymbol;

    const timeframe = options.timeframe;
    if (!Object.prototype.hasOwnProperty.call(BYBIT_INTERVAL, timeframe)) {
      throw new BybitRestServiceError(`Unsupported timeframe: "${timeframe}".`, 'INVALID_TIMEFRAME');
    }

    const bybitInterval = BYBIT_INTERVAL[timeframe];

    let limitPerPage = 1000;
    if (options.limitPerPage !== undefined) {
      if (!Number.isFinite(options.limitPerPage) || options.limitPerPage <= 0 || !Number.isInteger(options.limitPerPage)) {
        throw new BybitRestServiceError(`limitPerPage must be a positive integer, got ${options.limitPerPage}.`, 'INVALID_LIMIT_PER_PAGE');
      }
      limitPerPage = Math.min(Math.max(options.limitPerPage, 1), 1000);
    }

    const now = Date.now();
    const defaultStartMs = now - 30 * 24 * 60 * 60 * 1000;
    // Keep chart history bounded to the most recent month, even when a client
    // accidentally asks for an older range.
    const requestedStartMs = options.startTimeMs ?? defaultStartMs;
    if (!Number.isFinite(requestedStartMs) || requestedStartMs <= 0 || !Number.isInteger(requestedStartMs)) {
      throw new BybitRestServiceError(`Invalid startTimeMs: ${requestedStartMs}. Must be a positive integer timestamp.`, 'INVALID_START_TIME');
    }
    const startMs = Math.max(requestedStartMs, defaultStartMs);
    const endMs = options.endTimeMs !== undefined ? options.endTimeMs : now;

    if (!Number.isFinite(startMs) || startMs <= 0 || !Number.isInteger(startMs)) {
      throw new BybitRestServiceError(`Invalid startTimeMs: ${startMs}. Must be a positive integer timestamp.`, 'INVALID_START_TIME');
    }

    if (!Number.isFinite(endMs) || endMs <= 0 || !Number.isInteger(endMs)) {
      throw new BybitRestServiceError(`Invalid endTimeMs: ${endMs}. Must be a positive integer timestamp.`, 'INVALID_END_TIME');
    }

    if (startMs >= endMs) {
      throw new BybitRestServiceError(`startTimeMs (${startMs}) must be strictly less than endTimeMs (${endMs}).`, 'INVALID_TIME_RANGE');
    }

    const candleMap = new Map<number, HistoricalCandle>();
    let currentCursorEndMs = endMs;
    let pagesFetched = 0;
    let hasCorruptRows = false;
    let terminationReason: HistoryTerminationReason = 'MAX_PAGES_REACHED';
    let previousOldestTimeMs: number | null = null;

    while (pagesFetched < this.maxPagesLimit) {
      if (pagesFetched > 0 && this.pageDelayMs > 0) {
        await this.sleepFn(this.pageDelayMs);
      }

      pagesFetched++;

      const queryParams = new URLSearchParams({
        category: 'linear',
        symbol,
        interval: bybitInterval,
        start: String(startMs),
        end: String(currentCursorEndMs),
        limit: String(limitPerPage)
      });

      const url = `${this.baseUrl}/v5/market/kline?${queryParams.toString()}`;
      let responseData: BybitKlineResponseRaw;
      try {
        responseData = await this.executeFetchWithRetry(url);
      } catch (err) {
        if (err instanceof BybitRestServiceError && (err.status === 403 || err.code === 'HTTP_ERROR')) {
          return await this.fetchBinanceFuturesFallback(symbol, timeframe, startMs, endMs, limitPerPage);
        }
        throw err;
      }

      if (!responseData.result || typeof responseData.result !== 'object') {
        throw new BybitRestServiceError('Bybit response is missing the required "result" container.', 'MALFORMED_RESPONSE');
      }

      const resultContainer = responseData.result;

      if (typeof resultContainer.category === 'string' && resultContainer.category !== 'linear') {
        throw new BybitRestServiceError(`Upstream returned unexpected category: "${resultContainer.category}". Expected "linear".`, 'UPSTREAM_PAYLOAD_MISMATCH');
      }

      if (typeof resultContainer.symbol === 'string' && resultContainer.symbol.toUpperCase() !== symbol) {
        throw new BybitRestServiceError(`Upstream returned symbol "${resultContainer.symbol}", expected "${symbol}".`, 'UPSTREAM_PAYLOAD_MISMATCH');
      }

      if (!Array.isArray(resultContainer.list)) {
        throw new BybitRestServiceError('Bybit response "result.list" is missing or is not an array.', 'MALFORMED_RESPONSE');
      }

      const rows = resultContainer.list;

      // Legitimate end of upstream history (empty array returned)
      if (rows.length === 0) {
        terminationReason = hasCorruptRows ? 'PARTIALLY_CORRUPT_PAGE' : 'UPSTREAM_END_OF_DATA';
        break;
      }

      let batchOldestTimeMs = Infinity;
      let validParsedInBatch = 0;
      let corruptRowsInBatch = 0;

      for (const row of rows) {
        const parsed = this.parseAndValidateRow(row, symbol, timeframe);
        if (parsed !== null) {
          validParsedInBatch++;
          const timeMs = parsed.time * 1000;
          if (timeMs >= startMs && timeMs <= endMs) {
            candleMap.set(parsed.time, parsed);
          }
          if (timeMs < batchOldestTimeMs) {
            batchOldestTimeMs = timeMs;
          }
        } else {
          corruptRowsInBatch++;
        }
      }

      if (corruptRowsInBatch > 0) {
        hasCorruptRows = true;
      }

      // If all rows on the page failed validation, abort to prevent corrupt dataset
      if (validParsedInBatch === 0 && rows.length > 0) {
        throw new BybitRestServiceError(
          `Upstream returned ${rows.length} rows on page ${pagesFetched}, but none could be parsed into valid OHLCV candles.`,
          'MALFORMED_RESPONSE'
        );
      }

      // Check boundary completion
      if (batchOldestTimeMs === Infinity || batchOldestTimeMs <= startMs) {
        terminationReason = hasCorruptRows ? 'PARTIALLY_CORRUPT_PAGE' : 'RANGE_EXHAUSTED';
        break;
      }

      // No progress check: Upstream returned identical or forward timestamps instead of older candles
      if (previousOldestTimeMs !== null && batchOldestTimeMs >= previousOldestTimeMs) {
        terminationReason = 'NO_PROGRESS_CURSOR';
        break;
      }

      previousOldestTimeMs = batchOldestTimeMs;
      currentCursorEndMs = batchOldestTimeMs - 1;

      if (currentCursorEndMs <= startMs) {
        terminationReason = hasCorruptRows ? 'PARTIALLY_CORRUPT_PAGE' : 'RANGE_EXHAUSTED';
        break;
      }
    }

    const sortedCandles = Array.from(candleMap.values()).sort((a, b) => a.time - b.time);

    // Strict completeness criteria: requested range fully reached without corrupt rows or cursor breaks
    const isComplete = !hasCorruptRows && (terminationReason === 'RANGE_EXHAUSTED' || terminationReason === 'UPSTREAM_END_OF_DATA');

    return {
      symbol,
      timeframe,
      candles: sortedCandles,
      metadata: {
        requestedRange: {
          startMs,
          endMs
        },
        actualRange: {
          firstCandleTimeSec: sortedCandles.length > 0 ? sortedCandles[0].time : null,
          lastCandleTimeSec: sortedCandles.length > 0 ? sortedCandles[sortedCandles.length - 1].time : null
        },
        totalPagesFetched: pagesFetched,
        totalCandlesReturned: sortedCandles.length,
        hasCorruptRows,
        isComplete,
        terminationReason
      }
    };
  }

  private async fetchBinanceFuturesFallback(
    symbol: string,
    timeframe: CandleTimeframe,
    startMs: number,
    endMs: number,
    limit: number
  ): Promise<HistoryFetchResult> {
    const fsym = symbol.replace(/USDT$/i, '');
    const endpointMap: Record<CandleTimeframe, { path: string; aggregate: number }> = {
      '1m': { path: 'histominute', aggregate: 1 },
      '3m': { path: 'histominute', aggregate: 3 },
      '5m': { path: 'histominute', aggregate: 5 },
      '15m': { path: 'histominute', aggregate: 15 },
      '30m': { path: 'histominute', aggregate: 30 },
      '1h': { path: 'histohour', aggregate: 1 },
      '4h': { path: 'histohour', aggregate: 4 },
      '1d': { path: 'histoday', aggregate: 1 }
    };
    const spec = endpointMap[timeframe];
    const query = new URLSearchParams({
      fsym,
      tsym: 'USDT',
      limit: String(Math.min(limit, 300)),
      aggregate: String(spec.aggregate),
      toTs: String(Math.floor(endMs / 1000))
    });
    const res = await this.fetchFn(`https://min-api.cryptocompare.com/data/v2/${spec.path}?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
      throw new BybitRestServiceError(`CryptoCompare fallback HTTP error: ${res.status}`, 'HTTP_ERROR', res.status);
    }
    const payload = (await res.json()) as { Data?: { Data?: Array<{ time: number; open: number; high: number; low: number; close: number; volumefrom?: number; volumeto?: number }> } };
    const rawRows = Array.isArray(payload?.Data?.Data) ? payload.Data.Data : [];
    const candles: HistoricalCandle[] = [];
    for (const r of rawRows) {
      const tSec = Number(r.time);
      const open = Number(r.open);
      const high = Number(r.high);
      const low = Number(r.low);
      const close = Number(r.close);
      const volume = Number(r.volumefrom ?? 0);
      const turnover = Number(r.volumeto ?? 0);
      if ([tSec, open, high, low, close].every(Number.isFinite) && tSec > 0 && open > 0 && high > 0 && low > 0 && close > 0) {
        candles.push({ symbol, timeframe, time: tSec, open, high, low, close, volume: Math.max(0, volume), turnover: Math.max(0, turnover) });
      }
    }
    candles.sort((a, b) => a.time - b.time);
    return {
      symbol,
      timeframe,
      candles,
      metadata: {
        requestedRange: { startMs, endMs },
        actualRange: {
          firstCandleTimeSec: candles[0]?.time ?? null,
          lastCandleTimeSec: candles[candles.length - 1]?.time ?? null
        },
        totalPagesFetched: 1,
        totalCandlesReturned: candles.length,
        hasCorruptRows: false,
        isComplete: true,
        terminationReason: 'RANGE_EXHAUSTED'
      }
    };
  }

  /** Fetch exchange-defined price increments so footprint levels use real tick sizes. */
  public async fetchTickSizes(symbols: string[]): Promise<Record<string, number>> {
    const entries = await Promise.all(symbols.map(async (symbol) => {
      try {
        const url = `${this.baseUrl}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`;
        const response = await this.executeFetchWithRetry(url) as unknown as {
          result?: { list?: Array<{ symbol?: string; priceFilter?: { tickSize?: string } }> };
        };
        const item = response.result?.list?.find((candidate) => candidate.symbol === symbol);
        const tickSize = Number(item?.priceFilter?.tickSize);
        return Number.isFinite(tickSize) && tickSize > 0 ? [symbol, tickSize] as const : null;
      } catch {
        return null;
      }
    }));
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => entry !== null));
  }

  private async executeFetchWithRetry(url: string): Promise<BybitKlineResponseRaw> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      attempt++;
      const controller = new AbortController();
      let timeoutTriggered = false;

      const timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, this.requestTimeoutMs);

      try {
        const response = await this.fetchFn(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          signal: controller.signal
        });

        const rawBodyText = await response.text();
        clearTimeout(timeoutId);

        if (response.status === 429) {
          if (attempt > this.maxRetries) {
            throw new BybitRestServiceError(
              'Bybit REST rate limit exceeded (HTTP 429). Retry attempts exhausted.',
              'RATE_LIMIT_EXCEEDED',
              429
            );
          }
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await this.sleepFn(backoffDelay);
          continue;
        }

        if (response.status >= 500) {
          if (attempt > this.maxRetries) {
            throw new BybitRestServiceError(
              `Bybit upstream server error (HTTP ${response.status}). Retry attempts exhausted.`,
              'UPSTREAM_SERVER_ERROR',
              response.status
            );
          }
          const backoffDelay = 1000 * attempt;
          await this.sleepFn(backoffDelay);
          continue;
        }

        if (!response.ok) {
          throw new BybitRestServiceError(
            `Bybit HTTP error: ${response.status} ${response.statusText}`,
            'HTTP_ERROR',
            response.status
          );
        }

        let json: unknown;
        try {
          json = JSON.parse(rawBodyText);
        } catch {
          throw new BybitRestServiceError('Failed to parse Bybit response as JSON.', 'MALFORMED_RESPONSE');
        }

        if (!json || typeof json !== 'object') {
          throw new BybitRestServiceError('Bybit JSON response is not an object.', 'MALFORMED_RESPONSE');
        }

        const typedPayload = json as Partial<BybitKlineResponseRaw>;

        if (typeof typedPayload.retCode !== 'number') {
          throw new BybitRestServiceError('Missing or invalid retCode in Bybit response.', 'MALFORMED_RESPONSE');
        }

        // Bybit Rate Limit Error Codes: 10006 (API limit) & 10018 (IP limit)
        if (typedPayload.retCode === 10006 || typedPayload.retCode === 10018) {
          if (attempt > this.maxRetries) {
            throw new BybitRestServiceError(
              `Bybit JSON rate limit error (${typedPayload.retCode}: ${typedPayload.retMsg || 'Rate limit exceeded'}). Retries exhausted.`,
              'RATE_LIMIT_EXCEEDED',
              200,
              typedPayload.retCode
            );
          }
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await this.sleepFn(backoffDelay);
          continue;
        }

        if (typedPayload.retCode !== 0) {
          throw new BybitRestServiceError(
            `Bybit API error code ${typedPayload.retCode}: ${typedPayload.retMsg || 'Unknown error'}`,
            'BYBIT_API_ERROR',
            200,
            typedPayload.retCode
          );
        }

        return typedPayload as BybitKlineResponseRaw;
      } catch (err: unknown) {
        clearTimeout(timeoutId);

        if (err instanceof BybitRestServiceError) {
          if (
            err.code === 'BYBIT_API_ERROR' ||
            err.code === 'HTTP_ERROR' ||
            err.code === 'MALFORMED_RESPONSE' ||
            err.code === 'UPSTREAM_PAYLOAD_MISMATCH'
          ) {
            throw err;
          }
          lastError = err;
        } else if (err instanceof Error) {
          if (err.name === 'AbortError' || timeoutTriggered) {
            lastError = new BybitRestServiceError(
              `Request timed out after ${this.requestTimeoutMs}ms (including body read).`,
              'REQUEST_TIMEOUT'
            );
          } else {
            lastError = err;
          }
        } else {
          lastError = new Error(String(err));
        }

        if (attempt <= this.maxRetries) {
          const retryBackoff = 1000 * attempt;
          await this.sleepFn(retryBackoff);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || new BybitRestServiceError('Network communication failure during Bybit historical fetch.', 'NETWORK_FAILURE');
  }

  /**
   * Row Schema (Bybit V5 Market Kline):
   * [0] startTime: string (ms)
   * [1] openPrice: string
   * [2] highPrice: string
   * [3] lowPrice: string
   * [4] closePrice: string
   * [5] volume: string (BTC for BTCUSDT)
   * [6] turnover: string (USDT)
   */
  private parseAndValidateRow(row: unknown, symbol: string, timeframe: CandleTimeframe): HistoricalCandle | null {
    if (!Array.isArray(row) || row.length < 7) {
      return null;
    }

    const timeMs = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    const turnover = Number(row[6]);

    if (!Number.isFinite(timeMs) || timeMs <= 0 || !Number.isInteger(timeMs)) return null;
    if (!Number.isFinite(open) || open <= 0) return null;
    if (!Number.isFinite(high) || high <= 0) return null;
    if (!Number.isFinite(low) || low <= 0) return null;
    if (!Number.isFinite(close) || close <= 0) return null;
    if (!Number.isFinite(volume) || volume < 0) return null;
    if (!Number.isFinite(turnover) || turnover < 0) return null;

    // Timeframe Alignment Check
    const requiredIntervalMs = INTERVAL_MS[timeframe];
    if (timeMs % requiredIntervalMs !== 0) {
      return null;
    }

    // Strict geometric integrity
    if (high < open || high < close || low > open || low > close || high < low) {
      return null;
    }

    return {
      symbol,
      timeframe,
      time: Math.floor(timeMs / 1000),
      open,
      high,
      low,
      close,
      volume,
      turnover
    };
  }
}
