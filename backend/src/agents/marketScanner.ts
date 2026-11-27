import type { AgentSnapshot, Direction } from './orderFlowCouncil.js';

export interface MarketActivityScan {
  regime:
    | 'STRONG_UPTREND'
    | 'STRONG_DOWNTREND'
    | 'BULLISH_PULLBACK'
    | 'BEARISH_PULLBACK'
    | 'STOP_HUNT_REVERSAL'
    | 'ACCUMULATION_RANGE'
    | 'EXHAUSTED_MOVE';
  dominantFlow: 'BULLISH' | 'BEARISH' | 'MIXED';
  range4hPositionPct: number | null;
  range24hPositionPct: number | null;
  cumDelta90m: number;
  cumDelta15m: number;
  structure15m: 'UPTREND_STRUCTURE' | 'DOWNTREND_STRUCTURE' | 'BOUNCE_IN_DOWNTREND' | 'DIP_IN_UPTREND' | 'RANGING';
  roomToRangeExtremePct: number;
  flowConflictWarning: boolean;
  blockedDirection: Direction | null;
  blockReason: string | null;
  narrativeSummary: string;
}

function computeEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function analyze15mContext(
  candles15m: Array<{ high: number; low: number; close: number }>
): {
  structure15m: MarketActivityScan['structure15m'];
  range24hPositionPct: number | null;
  high24h: number | null;
  low24h: number | null;
} {
  if (candles15m.length < 15) {
    return { structure15m: 'RANGING', range24hPositionPct: null, high24h: null, low24h: null };
  }

  const last24h = candles15m.slice(-96);
  const hasFull24hHistory = last24h.length >= 92;
  const high24h = hasFull24hHistory ? Math.max(...last24h.map((c) => c.high)) : null;
  const low24h = hasFull24hHistory ? Math.min(...last24h.map((c) => c.low)) : null;
  const lastClose = last24h[last24h.length - 1].close;
  const span24h = high24h !== null && low24h !== null ? high24h - low24h : 0;
  const range24hPositionPct = span24h > 0 && low24h !== null ? Number((((lastClose - low24h) / span24h) * 100).toFixed(1)) : null;

  const closes = last24h.map((c) => c.close);
  // Fast intraday 15m EMAs (EMA 9 = 2.25h, EMA 21 = 5.25h) — reacts fast to trend reversals!
  const emaFast = computeEma(closes, 9);
  const emaSlow = computeEma(closes, 21);

  const prior3h = last24h.slice(-16, -4);
  const recent1h = last24h.slice(-4);
  const priorHigh = prior3h.length ? Math.max(...prior3h.map((c) => c.high)) : Math.max(...last24h.map((c) => c.high));
  const priorLow = prior3h.length ? Math.min(...prior3h.map((c) => c.low)) : Math.min(...last24h.map((c) => c.low));
  const recentHigh = Math.max(...recent1h.map((c) => c.high));
  const recentLow = Math.min(...recent1h.map((c) => c.low));

  if (emaFast !== null && emaSlow !== null) {
    if (emaFast < emaSlow && lastClose < emaSlow) {
      const isBouncing = recentLow > priorLow && lastClose > emaFast;
      return {
        structure15m: isBouncing ? 'BOUNCE_IN_DOWNTREND' : 'DOWNTREND_STRUCTURE',
        range24hPositionPct,
        high24h,
        low24h
      };
    }
    if (emaFast > emaSlow && lastClose > emaSlow) {
      const isDipping = recentHigh < priorHigh && lastClose < emaFast;
      return {
        structure15m: isDipping ? 'DIP_IN_UPTREND' : 'UPTREND_STRUCTURE',
        range24hPositionPct,
        high24h,
        low24h
      };
    }
  }

  if (recentHigh < priorHigh && lastClose < priorLow) {
    return { structure15m: 'DOWNTREND_STRUCTURE', range24hPositionPct, high24h, low24h };
  }
  if (recentLow > priorLow && lastClose > priorHigh) {
    return { structure15m: 'UPTREND_STRUCTURE', range24hPositionPct, high24h, low24h };
  }

  return { structure15m: 'RANGING', range24hPositionPct, high24h, low24h };
}

export function scanMarketActivity(snapshot: AgentSnapshot): MarketActivityScan {
  const candles1m = snapshot.candles ?? [];
  const candles15m = snapshot.candles15m ?? [];
  const fps1m = (snapshot.footprints ?? []).filter((b) => b.isClosed);
  const fps5m = (snapshot.footprints5m ?? []).filter((b) => b.isClosed);

  const lastPrice = snapshot.latestPrice ?? candles1m[candles1m.length - 1]?.close ?? null;
  const { structure15m, range24hPositionPct, high24h, low24h } = analyze15mContext(candles15m);

  // Require at least 48 closed 5m bars (4 hours) or 240 1m bars for full 4.5h range accuracy
  const hasFull4hRange =
    (snapshot.candles5m !== undefined && snapshot.candles5m.length >= 48) ||
    candles1m.length >= 240;
  const rangeBars = (snapshot.candles5m && snapshot.candles5m.length >= 48)
    ? snapshot.candles5m.slice(-54)
    : candles1m.slice(-270);
  let range4hPositionPct: number | null = null;
  let rangeSpanPct = 0;
  let rHigh4h = lastPrice ?? 0;
  let rLow4h = lastPrice ?? 0;
  if (hasFull4hRange && rangeBars.length >= 48 && lastPrice !== null) {
    rHigh4h = Math.max(...rangeBars.map((c) => c.high));
    rLow4h = Math.min(...rangeBars.map((c) => c.low));
    const span = rHigh4h - rLow4h;
    if (span > 0) {
      range4hPositionPct = Number((((lastPrice - rLow4h) / span) * 100).toFixed(1));
      rangeSpanPct = (span / lastPrice) * 100;
    }
  }

  const cumDelta15m = Number(fps1m.slice(-15).reduce((s, b) => s + b.delta, 0).toFixed(2));
  const cumDelta90m = Number(fps5m.slice(-18).reduce((s, b) => s + b.delta, 0).toFixed(2));

  let dominantFlow: 'BULLISH' | 'BEARISH' | 'MIXED' = 'MIXED';
  if (structure15m === 'DOWNTREND_STRUCTURE' || structure15m === 'BOUNCE_IN_DOWNTREND') {
    dominantFlow = 'BEARISH';
  } else if (structure15m === 'UPTREND_STRUCTURE' || structure15m === 'DIP_IN_UPTREND') {
    dominantFlow = 'BULLISH';
  } else if (cumDelta90m < 0 && cumDelta15m < 0) {
    dominantFlow = 'BEARISH';
  } else if (cumDelta90m > 0 && cumDelta15m > 0) {
    dominantFlow = 'BULLISH';
  }

  let regime: MarketActivityScan['regime'] = 'ACCUMULATION_RANGE';
  if (dominantFlow === 'BEARISH') {
    if (range4hPositionPct !== null && range4hPositionPct < 5 && (rangeSpanPct > 5.0 || cumDelta15m > 0)) {
      regime = 'EXHAUSTED_MOVE';
    } else if (structure15m === 'BOUNCE_IN_DOWNTREND' || cumDelta15m > 0) {
      regime = 'BEARISH_PULLBACK';
    } else {
      regime = 'STRONG_DOWNTREND';
    }
  } else if (dominantFlow === 'BULLISH') {
    if (range4hPositionPct !== null && range4hPositionPct > 95 && (rangeSpanPct > 5.0 || cumDelta15m < 0)) {
      regime = 'EXHAUSTED_MOVE';
    } else if (structure15m === 'DIP_IN_UPTREND' || cumDelta15m < 0) {
      regime = 'BULLISH_PULLBACK';
    } else {
      regime = 'STRONG_UPTREND';
    }
  } else if (
    (range4hPositionPct !== null && range4hPositionPct < 20 && cumDelta15m > 0) ||
    (range4hPositionPct !== null && range4hPositionPct > 80 && cumDelta15m < 0)
  ) {
    regime = 'STOP_HUNT_REVERSAL';
  }

  let blockedDirection: Direction | null = null;
  let blockReason: string | null = null;

  if (dominantFlow === 'BEARISH' && regime === 'STRONG_DOWNTREND' && cumDelta15m < 0) {
    blockedDirection = 'LONG';
    blockReason = `15m/5m Scanner VETO: Active Intraday DOWNTREND (15m:${structure15m}, 15mDelta:${cumDelta15m}). Counter-trend LONG blocked until 15m delta flips positive.`;
  } else if (dominantFlow === 'BULLISH' && regime === 'STRONG_UPTREND' && cumDelta15m > 0) {
    blockedDirection = 'SHORT';
    blockReason = `15m/5m Scanner VETO: Active Intraday UPTREND (15m:${structure15m}, 15mDelta:+${cumDelta15m}). Counter-trend SHORT blocked until 15m delta flips negative.`;
  } else if (regime === 'EXHAUSTED_MOVE') {
    blockedDirection = dominantFlow === 'BULLISH' ? 'LONG' : 'SHORT';
    blockReason = `15m/5m Scanner VETO: Move exhausted at ${range4hPositionPct}% of 4.5h range (${rangeSpanPct.toFixed(2)}% span); chasing extreme blocked.`;
  }

  const flowConflictWarning =
    (dominantFlow === 'BULLISH' && cumDelta90m < 0 && cumDelta15m < 0) ||
    (dominantFlow === 'BEARISH' && cumDelta90m > 0 && cumDelta15m > 0);

  const roomDownPct = lastPrice && (low24h ?? rLow4h) ? Math.max(0, ((lastPrice - Math.min(low24h ?? rLow4h, rLow4h)) / lastPrice) * 100) : 1;
  const roomUpPct = lastPrice && (high24h ?? rHigh4h) ? Math.max(0, ((Math.max(high24h ?? rHigh4h, rHigh4h) - lastPrice) / lastPrice) * 100) : 1;
  const roomToRangeExtremePct = Number((dominantFlow === 'BEARISH' ? roomDownPct : roomUpPct).toFixed(2));

  const narrativeSummary = [
    `Regime=${regime}`,
    `15m=${structure15m}`,
    `Flow=${dominantFlow}${flowConflictWarning ? '(DELTA_CONFLICT)' : ''}`,
    `4.5hPos=${range4hPositionPct ?? 'N/A'}%`,
    `90mDelta=${cumDelta90m}`,
    `15mDelta=${cumDelta15m}`,
    `RoomToRangeExtreme=${roomToRangeExtremePct}%`,
    blockReason ? `VETO=${blockReason}` : 'ScannerClear=YES'
  ].join(' | ');

  return {
    regime,
    dominantFlow,
    range4hPositionPct,
    range24hPositionPct,
    cumDelta90m,
    cumDelta15m,
    structure15m,
    roomToRangeExtremePct,
    flowConflictWarning,
    blockedDirection,
    blockReason,
    narrativeSummary
  };
}