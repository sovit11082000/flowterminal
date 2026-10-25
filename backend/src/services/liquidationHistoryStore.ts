import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { NormalizedLiquidation } from '../types/market.js';

// MongoDB is the durable history when configured, so this process keeps only a
// small fallback window instead of duplicating a large event history in RAM.
const maxEvents = process.env.MONGODB_URI?.trim() ? 5_000 : 100_000;

export class LiquidationHistoryStore {
  private readonly filePath: string;
  private readonly events: NormalizedLiquidation[] = [];
  private readonly maxEvents = maxEvents;
  private readonly retentionMs = 30 * 24 * 60 * 60 * 1000;
  private lastPruneAt = 0;

  constructor(filePath = resolve(process.cwd(), 'data', 'liquidation-history.jsonl')) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as NormalizedLiquidation;
          if (this.isValid(event)) this.events.push(event);
        } catch { /* Ignore a truncated last line. */ }
      }
      this.pruneExpired(Date.now(), true);
      this.trimAndPersist();
    } catch (error) {
      console.warn('[Liquidation recorder] Could not restore history:', error);
    }
  }

  save(batch: NormalizedLiquidation[]): void {
    const valid = batch.filter((event) => this.isValid(event));
    if (!valid.length) return;
    this.events.push(...valid);
    appendFileSync(this.filePath, `${valid.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    this.pruneExpired(Date.now());
    if (this.events.length > this.maxEvents + 1000) this.trimAndPersist();
  }

  getHistory(symbol: string, startTimeMs: number, endTimeMs: number, limit = 1000): NormalizedLiquidation[] {
    const matching = this.events.filter((event) => event.symbol === symbol && event.timestamp >= startTimeMs && event.timestamp <= endTimeMs);
    const count = Math.min(Math.max(limit, 1), 10_000);
    return matching.length <= count ? matching : matching.slice(-count);
  }

  private isValid(value: unknown): value is NormalizedLiquidation {
    const event = value as NormalizedLiquidation;
    return !!event && typeof event.symbol === 'string' && Number.isFinite(event.timestamp) &&
      Number.isFinite(event.price) && event.price > 0 && Number.isFinite(event.size) && event.size > 0 &&
      (event.side === 'Buy' || event.side === 'Sell');
  }

  private trimAndPersist(): void {
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    writeFileSync(this.filePath, `${this.events.map((event) => JSON.stringify(event)).join('\n')}${this.events.length ? '\n' : ''}`, 'utf8');
  }

  private pruneExpired(now: number, force = false): void {
    if (!force && now - this.lastPruneAt < 60 * 60_000) return;
    this.lastPruneAt = now;
    const cutoff = now - this.retentionMs;
    const retained = this.events.filter((event) => event.timestamp >= cutoff);
    if (retained.length === this.events.length) return;
    this.events.length = 0;
    for (const event of retained) this.events.push(event);
    writeFileSync(this.filePath, `${this.events.map((event) => JSON.stringify(event)).join('\n')}${this.events.length ? '\n' : ''}`, 'utf8');
  }
}
