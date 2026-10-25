import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OrderBookEntry } from '../types/market.js';

export interface OrderBookSample {
  symbol: string;
  time: number;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

/** Rolling local order-book recorder. Samples the synchronized top 20 levels twice a second. */
export class OrderBookHistoryStore {
  private readonly filePath: string;
  private readonly samples: OrderBookSample[] = [];
  private readonly lastSavedBySymbol = new Map<string, number>();
  private readonly sampleIntervalMs = 500;
  private readonly maxSamples = 120_000;
  private readonly retentionMs = 30 * 24 * 60 * 60 * 1000;
  private lastPruneAt = 0;

  constructor(filePath = resolve(process.cwd(), 'data', 'orderbook-history.jsonl')) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const sample = JSON.parse(line) as OrderBookSample;
          if (this.isValid(sample)) this.samples.push(sample);
        } catch {
          // Ignore a partial final line and retain earlier valid samples.
        }
      }
      this.pruneExpired(Date.now(), true);
      this.trimAndPersist();
      for (const sample of this.samples) {
        this.lastSavedBySymbol.set(sample.symbol, Math.max(this.lastSavedBySymbol.get(sample.symbol) ?? 0, sample.time));
      }
    } catch (error) {
      console.warn('[OrderBook recorder] Could not restore saved book history:', error);
    }
  }

  save(sample: OrderBookSample): void {
    if (!this.isValid(sample)) return;
    const lastSaved = this.lastSavedBySymbol.get(sample.symbol) ?? 0;
    if (sample.time - lastSaved < this.sampleIntervalMs) return;
    this.samples.push(sample);
    this.lastSavedBySymbol.set(sample.symbol, sample.time);
    appendFileSync(this.filePath, `${JSON.stringify(sample)}\n`, 'utf8');
    this.pruneExpired(Date.now());
    if (this.samples.length > this.maxSamples + 5_000) this.trimAndPersist();
  }

  getHistory(options: { symbol: string; startTimeMs?: number; endTimeMs?: number; limit?: number }): OrderBookSample[] {
    const start = options.startTimeMs ?? 0;
    const end = options.endTimeMs ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(options.limit ?? 3000, 1), 10_000);
    const matching = this.samples.filter((sample) => sample.symbol === options.symbol && sample.time >= start && sample.time <= end);
    if (limit === 1) return matching.length ? [matching[matching.length - 1]] : [];
    if (matching.length <= limit) return matching;
    const stride = (matching.length - 1) / (limit - 1);
    return Array.from({ length: limit }, (_, index) => matching[Math.round(index * stride)]);
  }

  getStatus(): { samples: number; symbols: string[]; oldestTime: number | null; newestTime: number | null; sampleIntervalMs: number } {
    return {
      samples: this.samples.length,
      symbols: [...new Set(this.samples.map((sample) => sample.symbol))],
      oldestTime: this.samples[0]?.time ?? null,
      newestTime: this.samples[this.samples.length - 1]?.time ?? null,
      sampleIntervalMs: this.sampleIntervalMs
    };
  }

  private isValid(value: unknown): value is OrderBookSample {
    const sample = value as OrderBookSample;
    return !!sample && typeof sample.symbol === 'string' && Number.isFinite(sample.time) &&
      Array.isArray(sample.bids) && Array.isArray(sample.asks) &&
      sample.bids.every((level) => Array.isArray(level) && Number.isFinite(level[0]) && Number.isFinite(level[1])) &&
      sample.asks.every((level) => Array.isArray(level) && Number.isFinite(level[0]) && Number.isFinite(level[1]));
  }

  private trimAndPersist(): void {
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    writeFileSync(this.filePath, `${this.samples.map((sample) => JSON.stringify(sample)).join('\n')}${this.samples.length ? '\n' : ''}`, 'utf8');
  }

  private pruneExpired(now: number, force = false): void {
    if (!force && now - this.lastPruneAt < 60 * 60_000) return;
    this.lastPruneAt = now;
    const cutoff = now - this.retentionMs;
    const retained = this.samples.filter((sample) => sample.time >= cutoff);
    if (retained.length === this.samples.length) return;
    this.samples.length = 0;
    for (const sample of retained) this.samples.push(sample);
    writeFileSync(this.filePath, `${this.samples.map((sample) => JSON.stringify(sample)).join('\n')}${this.samples.length ? '\n' : ''}`, 'utf8');
  }
}
