import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { NormalizedTrade } from '../types/market.js';

/** Local rolling recorder for normalized public trades, used by replay and audits. */
export class TradeHistoryStore {
  private readonly filePath: string;
  private readonly trades: NormalizedTrade[] = [];
  private readonly maxTrades = 500_000;
  private readonly retentionMs = 30 * 24 * 60 * 60 * 1000;
  private lastPruneAt = 0;

  constructor(filePath = resolve(process.cwd(), 'data', 'trade-history.jsonl')) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const trade = JSON.parse(line) as NormalizedTrade;
          if (this.isValid(trade)) this.trades.push(trade);
        } catch {
          // Ignore a partial final line and preserve valid recorded trades.
        }
      }
      this.pruneExpired(Date.now(), true);
      this.trimAndPersist();
    } catch (error) {
      console.warn('[Trade recorder] Could not restore saved trades:', error);
    }
  }

  save(batch: NormalizedTrade[]): void {
    const valid = batch.filter((trade) => this.isValid(trade));
    if (!valid.length) return;
    this.trades.push(...valid);
    appendFileSync(this.filePath, `${valid.map((trade) => JSON.stringify(trade)).join('\n')}\n`, 'utf8');
    this.pruneExpired(Date.now());
    if (this.trades.length > this.maxTrades + 10_000) this.trimAndPersist();
  }

  getHistory(options: { symbol: string; startTimeMs?: number; endTimeMs?: number; limit?: number }): NormalizedTrade[] {
    const start = options.startTimeMs ?? 0;
    const end = options.endTimeMs ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(options.limit ?? 5000, 1), 20_000);
    const matching = this.trades.filter((trade) => trade.symbol === options.symbol && trade.timestamp >= start && trade.timestamp <= end);
    if (matching.length <= limit) return matching;
    if (limit === 1) return [matching[matching.length - 1]];
    const stride = (matching.length - 1) / (limit - 1);
    return Array.from({ length: limit }, (_, index) => matching[Math.round(index * stride)]);
  }

  getStatus(): { trades: number; symbols: string[]; oldestTime: number | null; newestTime: number | null } {
    return {
      trades: this.trades.length,
      symbols: [...new Set(this.trades.map((trade) => trade.symbol))],
      oldestTime: this.trades[0]?.timestamp ?? null,
      newestTime: this.trades[this.trades.length - 1]?.timestamp ?? null
    };
  }

  private isValid(value: unknown): value is NormalizedTrade {
    const trade = value as NormalizedTrade;
    return !!trade && typeof trade.symbol === 'string' && Number.isFinite(trade.timestamp) &&
      Number.isFinite(trade.price) && trade.price > 0 && Number.isFinite(trade.size) && trade.size > 0 &&
      (trade.side === 'Buy' || trade.side === 'Sell') && typeof trade.tradeId === 'string';
  }

  private trimAndPersist(): void {
    if (this.trades.length > this.maxTrades) this.trades.splice(0, this.trades.length - this.maxTrades);
    writeFileSync(this.filePath, `${this.trades.map((trade) => JSON.stringify(trade)).join('\n')}${this.trades.length ? '\n' : ''}`, 'utf8');
  }

  private pruneExpired(now: number, force = false): void {
    if (!force && now - this.lastPruneAt < 60 * 60_000) return;
    this.lastPruneAt = now;
    const cutoff = now - this.retentionMs;
    const retained = this.trades.filter((trade) => trade.timestamp >= cutoff);
    if (retained.length === this.trades.length) return;
    this.trades.length = 0;
    for (const trade of retained) this.trades.push(trade);
    writeFileSync(this.filePath, `${this.trades.map((trade) => JSON.stringify(trade)).join('\n')}${this.trades.length ? '\n' : ''}`, 'utf8');
  }
}
