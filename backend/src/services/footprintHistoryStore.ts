import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CandleTimeframe, SerializedFootprintBar } from '../types/market.js';

/** Persists completed, locally captured footprint bars. Klines cannot reconstruct trade-side volume. */
export class FootprintHistoryStore {
  private readonly filePath: string;
  private readonly bars = new Map<string, SerializedFootprintBar>();
  private readonly maxBars = 20_000;
  private readonly retentionMs = 30 * 24 * 60 * 60 * 1000;

  constructor(filePath = resolve(process.cwd(), 'data', 'footprint-history.jsonl')) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;

    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const bar = JSON.parse(line) as SerializedFootprintBar;
        if (this.isValidBar(bar)) this.bars.set(this.key(bar.symbol, bar.timeframe, bar.time), bar);
      } catch {
        // Ignore a truncated final line and continue with valid recorded bars.
      }
    }
    this.pruneExpired(Date.now(), true);
    this.trim();
  }

  save(bar: SerializedFootprintBar): void {
    if (!this.isValidBar(bar) || !bar.isClosed) return;
    const key = this.key(bar.symbol, bar.timeframe, bar.time);
    this.bars.set(key, bar);
    appendFileSync(this.filePath, `${JSON.stringify(bar)}\n`, 'utf8');
    this.pruneExpired(Date.now());
    if (this.bars.size > this.maxBars + 1_000) this.trim();
  }

  getHistory(options: { symbol: string; timeframe: CandleTimeframe; startTimeMs?: number; endTimeMs?: number }): SerializedFootprintBar[] {
    return Array.from(this.bars.values())
      .filter((bar) => bar.symbol === options.symbol && bar.timeframe === options.timeframe)
      .filter((bar) => options.startTimeMs === undefined || bar.time * 1000 >= options.startTimeMs)
      .filter((bar) => options.endTimeMs === undefined || bar.time * 1000 <= options.endTimeMs)
      .sort((a, b) => a.time - b.time);
  }

  getLatestClosedBar(symbol: string, timeframe: '1m' | '5m'): SerializedFootprintBar | null {
    let latest: SerializedFootprintBar | null = null;
    for (const bar of this.bars.values()) {
      if (bar.symbol === symbol && bar.timeframe === timeframe && bar.isClosed && (!latest || bar.time > latest.time)) latest = bar;
    }
    return latest;
  }

  getStatus(): { bars: number; oneMinuteBars: number; fiveMinuteBars: number; symbols: string[]; oldestTime: number | null; newestTime: number | null } {
    let oneMinuteBars = 0;
    let fiveMinuteBars = 0;
    let oldestTime = Infinity;
    let newestTime = -Infinity;
    const symbols = new Set<string>();
    for (const bar of this.bars.values()) {
      if (bar.timeframe === '1m') oneMinuteBars++;
      else if (bar.timeframe === '5m') fiveMinuteBars++;
      symbols.add(bar.symbol);
      oldestTime = Math.min(oldestTime, bar.time);
      newestTime = Math.max(newestTime, bar.time);
    }
    return {
      bars: this.bars.size,
      oneMinuteBars,
      fiveMinuteBars,
      symbols: [...symbols].sort(),
      oldestTime: Number.isFinite(oldestTime) ? oldestTime : null,
      newestTime: Number.isFinite(newestTime) ? newestTime : null
    };
  }

  private key(symbol: string, timeframe: CandleTimeframe, time: number): string {
    return `${symbol}:${timeframe}:${time}`;
  }

  private isValidBar(value: unknown): value is SerializedFootprintBar {
    const bar = value as SerializedFootprintBar;
    return !!bar && typeof bar === 'object' && (bar.timeframe === '1m' || bar.timeframe === '5m') &&
      typeof bar.symbol === 'string' && Number.isFinite(bar.time) && Array.isArray(bar.priceLevels);
  }

  private trim(): void {
    if (this.bars.size <= this.maxBars) return;
    const sorted = Array.from(this.bars.values()).sort((a, b) => a.time - b.time).slice(-this.maxBars);
    this.bars.clear();
    for (const bar of sorted) this.bars.set(this.key(bar.symbol, bar.timeframe, bar.time), bar);
    writeFileSync(this.filePath, `${sorted.map((bar) => JSON.stringify(bar)).join('\n')}\n`, 'utf8');
  }

  private lastPruneAt = 0;
  private pruneExpired(now: number, force = false): void {
    if (!force && now - this.lastPruneAt < 60 * 60_000) return;
    this.lastPruneAt = now;
    const cutoff = Math.floor((now - this.retentionMs) / 1000);
    let changed = false;
    for (const [key, bar] of this.bars) {
      if (bar.time < cutoff) { this.bars.delete(key); changed = true; }
    }
    if (changed) writeFileSync(this.filePath, `${Array.from(this.bars.values()).map((bar) => JSON.stringify(bar)).join('\n')}${this.bars.size ? '\n' : ''}`, 'utf8');
  }
}
