import {
  OrderBookEntry,
  BybitRawOrderBookPayload,
  BybitRawOrderBookData
} from '../types/market.js';

export interface OrderBookStatus {
  isSynchronized: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  bidDepthCount: number;
  askDepthCount: number;
  lastUpdateId: number;
  lastSeq: number;
}

export class OrderBookState {
  private bids: Map<number, number> = new Map();
  private asks: Map<number, number> = new Map();
  private lastUpdateId: number = 0;
  private lastSeq: number = 0;
  private isSynchronized: boolean = false;
  private symbol: string = '';

  public processSnapshot(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
      this.isSynchronized = false;
      return false;
    }

    const raw = payload as Partial<BybitRawOrderBookPayload>;
    if (raw.type !== 'snapshot' || !raw.data || typeof raw.data !== 'object') {
      this.isSynchronized = false;
      return false;
    }

    const data = raw.data as Partial<BybitRawOrderBookData>;
    const updateId = Number(data.u);
    const seq = Number(data.seq);
    if (!Array.isArray(data.b) || !Array.isArray(data.a) || typeof data.s !== 'string' || !data.s ||
      !Number.isSafeInteger(updateId) || updateId <= 0 || !Number.isSafeInteger(seq) || seq <= 0) {
      this.isSynchronized = false;
      return false;
    }

    this.bids.clear();
    this.asks.clear();
    this.symbol = typeof data.s === 'string' ? data.s : '';

    for (const item of data.b) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const price = Number(item[0]);
      const size = Number(item[1]);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) {
        this.bids.set(price, size);
      }
    }

    for (const item of data.a) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const price = Number(item[0]);
      const size = Number(item[1]);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) {
        this.asks.set(price, size);
      }
    }

    this.lastUpdateId = updateId;
    this.lastSeq = seq;

    // Snapshot is valid only if both sides have depth and book is not crossed
    this.isSynchronized = this.bids.size > 0 && this.asks.size > 0 && this.validateCrossSpread();
    return this.isSynchronized;
  }

  public processDelta(payload: unknown): boolean {
    if (!this.isSynchronized || !payload || typeof payload !== 'object') {
      return false;
    }

    const raw = payload as Partial<BybitRawOrderBookPayload>;
    if (raw.type !== 'delta' || !raw.data || typeof raw.data !== 'object') {
      return false;
    }

    const data = raw.data as Partial<BybitRawOrderBookData>;

    // Bybit V5 `seq` is a cross-sequence, not a per-symbol consecutive counter:
    // gaps are valid. Reject stale/regressed sequence values and update-ID resets,
    // but do not require `seq === lastSeq + 1`.
    const updateId = Number(data.u);
    const seq = Number(data.seq);
    if (!data.s || (this.symbol && data.s !== this.symbol) ||
      !Number.isSafeInteger(updateId) || updateId <= 0 || updateId === 1 || updateId <= this.lastUpdateId ||
      !Number.isSafeInteger(seq) || seq <= this.lastSeq ||
      !Array.isArray(data.b) || !Array.isArray(data.a)) {
      this.isSynchronized = false;
      return false;
    }

    // Validate the entire packet before mutating either side, so a malformed
    // entry cannot leave a partially applied book behind.
    for (const item of [...data.b, ...data.a]) {
      if (!Array.isArray(item) || item.length < 2) { this.isSynchronized = false; return false; }
      const price = Number(item[0]);
      const size = Number(item[1]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
        this.isSynchronized = false;
        return false;
      }
    }

    // Process Bid Deltas
    if (Array.isArray(data.b)) {
      for (const item of data.b) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const price = Number(item[0]);
        const size = Number(item[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
          continue;
        }

        if (size === 0) {
          this.bids.delete(price);
        } else {
          this.bids.set(price, size);
        }
      }
    }

    // Process Ask Deltas
    if (Array.isArray(data.a)) {
      for (const item of data.a) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const price = Number(item[0]);
        const size = Number(item[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
          continue;
        }

        if (size === 0) {
          this.asks.delete(price);
        } else {
          this.asks.set(price, size);
        }
      }
    }

    this.lastUpdateId = updateId;
    this.lastSeq = seq;

    if (!this.validateCrossSpread()) {
      this.isSynchronized = false;
      return false;
    }

    return true;
  }

  public validateCrossSpread(): boolean {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
      return false;
    }
    return true;
  }

  public getBestBid(): number | null {
    if (this.bids.size === 0) return null;
    let max = -Infinity;
    for (const price of this.bids.keys()) {
      if (price > max) max = price;
    }
    return max === -Infinity ? null : max;
  }

  public getBestAsk(): number | null {
    if (this.asks.size === 0) return null;
    let min = Infinity;
    for (const price of this.asks.keys()) {
      if (price < min) min = price;
    }
    return min === Infinity ? null : min;
  }

  public getSortedBids(limit: number = 50): OrderBookEntry[] {
    return Array.from(this.bids.entries())
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit);
  }

  public getSortedAsks(limit: number = 50): OrderBookEntry[] {
    return Array.from(this.asks.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(0, limit);
  }

  public getStatus(): OrderBookStatus {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    const spread = bestBid !== null && bestAsk !== null ? Number((bestAsk - bestBid).toFixed(4)) : null;

    return {
      isSynchronized: this.isSynchronized,
      bestBid,
      bestAsk,
      spread,
      bidDepthCount: this.bids.size,
      askDepthCount: this.asks.size,
      lastUpdateId: this.lastUpdateId,
      lastSeq: this.lastSeq
    };
  }

  public reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = 0;
    this.lastSeq = 0;
    this.isSynchronized = false;
    this.symbol = '';
  }
}
