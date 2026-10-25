import {
  NormalizedTrade,
  BybitRawTradeItem,
  BybitRawTradePayload,
  AggressorSide
} from '../types/market.js';

/**
 * Validates and normalizes an individual Bybit trade record.
 * Rejects invalid, non-finite, zero, or negative numeric fields.
 */
export function normalizeTrade(raw: unknown): NormalizedTrade | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Partial<BybitRawTradeItem>;

  // 1. Symbol Validation
  const symbol = typeof item.s === 'string' ? item.s.trim() : '';
  if (!symbol) return null;

  // 2. Timestamp Validation (Epoch milliseconds)
  const timestamp = typeof item.T === 'number' ? item.T : Number(item.T);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  // 3. Price Validation
  const price = typeof item.p === 'number' ? item.p : Number(item.p);
  if (!Number.isFinite(price) || price <= 0) return null;

  // 4. Size / Quantity Validation
  const size = typeof item.v === 'number' ? item.v : Number(item.v);
  if (!Number.isFinite(size) || size <= 0) return null;

  // 5. Aggressor Side Mapping (S == "Buy" -> Aggressive Buy, S == "Sell" -> Aggressive Sell)
  let side: AggressorSide;
  if (item.S === 'Buy') {
    side = 'Buy';
  } else if (item.S === 'Sell') {
    side = 'Sell';
  } else {
    return null; // Reject undocumented or missing side
  }

  // 6. Trade ID Validation
  const tradeId = typeof item.i === 'string' ? item.i.trim() : String(item.i || '').trim();
  if (!tradeId) return null;

  return {
    symbol,
    timestamp,
    price,
    size,
    side,
    tradeId,
    isBlockTrade: Boolean(item.BT)
  };
}

/**
 * Parses and validates an entire Bybit publicTrade topic payload.
 * Safely preserves multiple trades executing within the same millisecond.
 */
export function parsePublicTradePayload(payload: unknown): NormalizedTrade[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const msg = payload as Partial<BybitRawTradePayload>;

  // Verify that the payload belongs to a publicTrade stream and has an array of data
  if (typeof msg.topic !== 'string' || !msg.topic.startsWith('publicTrade.') || !Array.isArray(msg.data)) {
    return [];
  }

  const normalizedTrades: NormalizedTrade[] = [];

  for (const rawItem of msg.data) {
    const trade = normalizeTrade(rawItem);
    if (trade !== null) {
      normalizedTrades.push(trade);
    }
  }

  return normalizedTrades;
}