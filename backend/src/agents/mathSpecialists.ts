/**
 * Rule-based (no LLM) specialists. Each one turns the market snapshot into the same SpecialistReport
 * the council already understands, using only arithmetic on candles, footprints, DOM and derived context.
 */
import type { AgentSnapshot, DerivedMarketContext, SpecialistReport } from './orderFlowCouncil.js';
import { SPECIALIST_AGENTS } from './orderFlowSkill.js';

type Dir = 'LONG' | 'SHORT';
type Candle = AgentSnapshot['candles'][number];
type AgentId = SpecialistReport['agentId'];

interface Evidence {
  pts: number;
  text: string;
  strategy?: string;
  category: 'STRUCTURE' | 'LIQUIDITY' | 'POI' | 'FLOW' | 'MOMENTUM' | 'TIMING';
}
interface Cap { when: boolean; cap: number; concern: string }

const f = (value: number): string => String(Number(value.toFixed(Math.abs(value) >= 1000 ? 1 : Math.abs(value) >= 10 ? 2 : 4)));
const open = (c: Candle): number => c.open ?? c.close;
const emptyEvidence = (): Record<Dir, Evidence[]> => ({ LONG: [], SHORT: [] });
const agentName = (id: AgentId): string => SPECIALIST_AGENTS.find((a) => a.id === id)?.name ?? id;

interface FinalizeInput {
  agentId: AgentId;
  evidence: Record<Dir, Evidence[]>;
  derived: DerivedMarketContext;
  concerns?: string[];
  missing?: string[];
  caps?: Record<Dir, Cap[]>;
  emptyNote: string;
}

function scoreIndependentEvidence(items: Evidence[]): number {
  // Prevent correlated momentum signals (BOS + Displacement + Delta Impulse on the same bar)
  // from inflating strength to 3 without independent structural/liquidity/POI confirmation.
  let momentumPts = 0;
  let corePts = 0;
  for (const item of items) {
    if (item.category === 'MOMENTUM' || item.category === 'TIMING') {
      momentumPts += item.pts;
    } else {
      corePts += item.pts;
    }
  }
  return corePts + Math.min(1, momentumPts);
}

function finalize(input: FinalizeInput): SpecialistReport {
  const { agentId, evidence, derived } = input;
  const concerns = [...(input.concerns ?? [])];
  const longPts = scoreIndependentEvidence(evidence.LONG);
  const shortPts = scoreIndependentEvidence(evidence.SHORT);
  const dir: Dir | null = longPts > shortPts ? 'LONG' : shortPts > longPts ? 'SHORT' : null;
  let strength = dir ? Math.min(3, Math.abs(longPts - shortPts)) : 0;

  if (dir && Math.min(longPts, shortPts) >= 2) concerns.push(`Conflicting evidence: LONG ${longPts} pts vs SHORT ${shortPts} pts.`);
  if (!dir && (longPts > 0 || shortPts > 0)) concerns.push(`Evidence is balanced (LONG ${longPts} vs SHORT ${shortPts}).`);

  const hasSweepOrAbsorptionEvidence = dir
    ? evidence[dir].some((e) =>
        ['SMC05', 'SMC06', 'SMC07', 'SMC08', 'ICT05', 'ICT06', 'ICT13', 'ICT14', 'ICT15', 'ICT16', 'OF01', 'OF02', 'OF21', 'OF23', 'OF24', 'OF25'].includes(e.strategy ?? '') ||
        e.category === 'LIQUIDITY' ||
        /swept|absorption|iceberg|raid|turtle soup/i.test(e.text)
      )
    : false;

  if (dir) {
    const htf = derived.htfTrend; // Intraday 15m/5m trend
    const macro4h = derived.macro4hTrend; // 4H Macro Trend
    const sweptLevels = derived.sweepReclaim?.levels ?? [];

    // Institutional-grade sweep: only PDL/PWL/PDH/PWH level sweeps count for counter-trend permission
    // Micro swing sweeps (SMC05 alone) in a trending market are NOT enough to allow counter-trend trades
    const institutionalSweepOk = dir === 'LONG'
      ? (Boolean(derived.sweepReclaim?.long) || sweptLevels.some((l) => l === 'PDL' || l === 'PWL'))
      : (Boolean(derived.sweepReclaim?.short) || sweptLevels.some((l) => l === 'PDH' || l === 'PWH'));

    // For general alignment check, micro sweeps + absorption still count
    const sweepOk = institutionalSweepOk || hasSweepOrAbsorptionEvidence;

    const aligned = (dir === 'LONG' && htf === 'BULLISH') || (dir === 'SHORT' && htf === 'BEARISH');
    const counter = (dir === 'LONG' && htf === 'BEARISH') || (dir === 'SHORT' && htf === 'BULLISH');

    // 4H Macro Trend override: if 4H is strongly against us, neutralize unless institutional-level sweep exists
    const counter4h = (dir === 'LONG' && macro4h === 'BEARISH') || (dir === 'SHORT' && macro4h === 'BULLISH');
    if (counter4h && !institutionalSweepOk) {
      strength = Math.min(strength, 1);
      concerns.push(`${dir} capped at 1: Counter 4H macro trend (${macro4h}) without PDL/PDH/PWL/PWH institutional sweep.`);
    }

    // Counter-trend against 15m/5m:
    // - Without ANY sweep → neutralized (strength 0)
    // - With micro sweep ONLY (no institutional sweep) in a 4H downtrend → still neutralized
    // - With institutional PDL/PWL sweep → capped at strength 2
    if (counter && !sweepOk) {
      strength = 0;
      concerns.push(`${dir} is strictly counter-trend against 15m/5m ${htf} without sweep/reclaim; neutralized.`);
    } else if (counter && sweepOk && !institutionalSweepOk) {
      // Micro swing sweep in counter-trend — cap at 1, not 2
      strength = Math.min(strength, 1);
      concerns.push(`${dir} counter-trend: only micro swing swept (no PDL/PWL/PDH/PWH); capped at strength 1.`);
    } else if (counter && institutionalSweepOk) {
      strength = Math.min(strength, 2);
      concerns.push(`${dir} counter-trend institutional sweep confirmed: capped at strength 2.`);
    }

    if (strength === 3 && !(aligned || institutionalSweepOk)) {
      strength = 2;
      concerns.push('Strength 3 requires 15m/5m alignment or confirmed institutional sweep (PDL/PWL/PDH/PWH); capped at 2.');
    }
    for (const cap of input.caps?.[dir] ?? []) {
      if (cap.when && strength > cap.cap) {
        strength = cap.cap;
        concerns.push(cap.concern);
      }
    }
  }

  // P0 Fix: Strictly stand aside in CHOP_COMPRESSION / low-volume sideways markets
  if (derived.marketRegime === 'CHOP_COMPRESSION' || derived.isLowVolumeChop) {
    if (strength > 0) concerns.push('Sideways/Chop regime detected: standing aside completely.');
    strength = 0;
  }

  const bias: SpecialistReport['bias'] = dir && strength > 0 ? dir : 'NEUTRAL';
  const shown = bias !== 'NEUTRAL'
    ? evidence[bias]
    : [...evidence.LONG.map((e) => ({ ...e, text: `(LONG) ${e.text}` })), ...evidence.SHORT.map((e) => ({ ...e, text: `(SHORT) ${e.text}` }))];
  const findings = shown.map((e) => e.text).slice(0, 5);
  if (!findings.length) findings.push(input.emptyNote);
  const strategyCandidates = bias === 'NEUTRAL'
    ? []
    : [...new Set(evidence[bias].map((e) => e.strategy).filter((s): s is string => !!s))].slice(0, 3);

  return {
    agentId,
    name: agentName(agentId),
    bias,
    strength,
    findings,
    strategyCandidates,
    concerns: concerns.slice(0, 4),
    missingData: (input.missing ?? []).slice(0, 4)
  };
}

function insufficient(agentId: AgentId, reason: string): SpecialistReport {
  return { agentId, name: agentName(agentId), bias: 'NEUTRAL', strength: 0, findings: [], strategyCandidates: [], concerns: [reason], missingData: [reason] };
}

function validateSnapshotData(snapshot: AgentSnapshot): string | null {
  if (snapshot.feedStatus !== 'LIVE') {
    return `Feed status is ${snapshot.feedStatus || 'UNKNOWN'} (requires LIVE).`;
  }
  if (snapshot.lastTradeAt === null || !Number.isFinite(snapshot.lastTradeAt)) {
    return 'Missing lastTradeAt market timestamp.';
  }
  if (Date.now() - snapshot.lastTradeAt > 120_000) {
    return `Market feed stale (${Math.round((Date.now() - snapshot.lastTradeAt) / 1000)}s old).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared price-action helpers
// ---------------------------------------------------------------------------
interface Pivot { index: number; price: number }

export function findPivots(candles: Candle[], k = 2): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const currentK = (i < k || i >= candles.length - k) ? 1 : k;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= currentK; j++) {
      if (!(candles[i].high > candles[i - j].high && candles[i].high >= candles[i + j].high)) isHigh = false;
      if (!(candles[i].low < candles[i - j].low && candles[i].low <= candles[i + j].low)) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

const meanBody = (candles: Candle[]): number => {
  const slice = candles.slice(-14);
  return slice.length ? slice.reduce((s, c) => s + Math.abs(c.close - open(c)), 0) / slice.length : 0;
};

function findDisplacement(candles: Candle[], dir: Dir, avgBody: number, lookback = 4): { index: number; body: number } | null {
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - lookback); i--) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = c.close - open(c);
    if (dir === 'LONG' && body >= avgBody * 1.35 && (c.close - c.low) / range >= 0.65) return { index: i, body };
    if (dir === 'SHORT' && -body >= avgBody * 1.35 && (c.high - c.close) / range >= 0.65) return { index: i, body: -body };
  }
  return null;
}

function aggregateCandles(candles: Candle[], bucketSec: number): Candle[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const buckets = new Map<number, Candle>();
  for (const c of sorted) {
    if (!Number.isFinite(c.time) || c.time <= 0) continue;
    const slot = Math.floor(c.time / bucketSec) * bucketSec;
    const existing = buckets.get(slot);
    if (!existing) {
      buckets.set(slot, { time: slot, open: open(c), high: c.high, low: c.low, close: c.close });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// SMC Specialist (Structure, Liquidity Sweeps, Fresh OB, IFVG, Breaker, 3-Step MTF)
// ---------------------------------------------------------------------------
export function smcMathReport(snapshot: AgentSnapshot, derived: DerivedMarketContext): SpecialistReport {
  const staleErr = validateSnapshotData(snapshot);
  if (staleErr) return insufficient('smc', staleErr);

  const candles = (snapshot.candles5m && snapshot.candles5m.length >= 20) ? snapshot.candles5m : snapshot.candles;
  const n = candles.length;
  if (n < 12) return insufficient('smc', `Only ${n} candles supplied (need 12).`);

  const last = candles[n - 1];
  const price = snapshot.latestPrice ?? last.close;
  const atr = derived.atr ?? 0;
  const avgBody = meanBody(candles);
  const { highs, lows } = findPivots(candles, 2);
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  const structure: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN' = lastHigh && prevHigh && lastLow && prevLow
    ? (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price ? 'BULLISH'
      : lastHigh.price < prevHigh.price && lastLow.price < prevLow.price ? 'BEARISH' : 'MIXED')
    : 'UNKNOWN';

  const evidence = emptyEvidence();

  // 1) Body-Close Confirmed BOS / CHoCH (rejects wick-only fake breakouts)
  // Cap raised to 0.4% (was 0.25%) — BTC can close 0.3-0.5% above a swing on a real BOS;
  // the old 0.25% cap silently dropped valid crypto breakouts.
  if (lastHigh && lastHigh.index <= n - 2 && last.close > lastHigh.price && last.close > open(last)) {
    const breakoutDistance = (last.close - lastHigh.price) / lastHigh.price;
    if (breakoutDistance <= 0.004) {
      const choch = structure === 'BEARISH';
      evidence.LONG.push({
        pts: 1,
        category: choch ? 'STRUCTURE' : 'MOMENTUM',
        strategy: choch ? 'SMC03' : 'SMC01',
        text: `${choch ? 'Bullish CHoCH' : 'Bullish BOS'}: candle body closed ${f(last.close)} above swing high ${f(lastHigh.price)}.`
      });
    }
  }
  if (lastLow && lastLow.index <= n - 2 && last.close < lastLow.price && last.close < open(last)) {
    const breakdownDistance = (lastLow.price - last.close) / lastLow.price;
    if (breakdownDistance <= 0.004) {
      const choch = structure === 'BULLISH';
      evidence.SHORT.push({
        pts: 1,
        category: choch ? 'STRUCTURE' : 'MOMENTUM',
        strategy: choch ? 'SMC04' : 'SMC02',
        text: `${choch ? 'Bearish CHoCH' : 'Bearish BOS'}: candle body closed ${f(last.close)} below swing low ${f(lastLow.price)}.`
      });
    }
  }

  // 2) Liquidity Sweep with Reclaim Close (EQH/EQL, PDH/PDL, PWH/PWL, Swing)
  const tol = atr > 0 ? atr * 0.15 : price * 0.0002;
  const window = candles.slice(-5);
  const lowLevels = [...lows.filter((p) => p.index <= n - 2).map((p) => ({ price: p.price, label: 'swing low' })),
    ...(derived.pdl !== null ? [{ price: derived.pdl, label: 'PDL' }] : []), ...(derived.pwl !== null ? [{ price: derived.pwl, label: 'PWL' }] : [])];
  const highLevels = [...highs.filter((p) => p.index <= n - 2).map((p) => ({ price: p.price, label: 'swing high' })),
    ...(derived.pdh !== null ? [{ price: derived.pdh, label: 'PDH' }] : []), ...(derived.pwh !== null ? [{ price: derived.pwh, label: 'PWH' }] : [])];

  const sweptLows = lowLevels.filter((lvl) => window.some((c) => c.low < lvl.price) && last.close > lvl.price);
  const sweptLow = sweptLows.sort((a, b) => a.price - b.price)[0];
  if (sweptLow) {
    const wick = Math.min(...window.map((c) => c.low));
    const equal = lows.filter((p) => p.index <= n - 2 && Math.abs(p.price - sweptLow.price) <= tol).length >= 2;
    evidence.LONG.push({
      pts: 1,
      category: 'LIQUIDITY',
      strategy: equal ? 'SMC05' : undefined,
      text: `Sell-side liquidity (${equal ? 'equal lows' : sweptLow.label}) at ${f(sweptLow.price)} swept to ${f(wick)} and reclaimed; close ${f(last.close)}.`
    });
  }
  const sweptHighs = highLevels.filter((lvl) => window.some((c) => c.high > lvl.price) && last.close < lvl.price);
  const sweptHigh = sweptHighs.sort((a, b) => b.price - a.price)[0];
  if (sweptHigh) {
    const wick = Math.max(...window.map((c) => c.high));
    const equal = highs.filter((p) => p.index <= n - 2 && Math.abs(p.price - sweptHigh.price) <= tol).length >= 2;
    evidence.SHORT.push({
      pts: 1,
      category: 'LIQUIDITY',
      strategy: equal ? 'SMC06' : undefined,
      text: `Buy-side liquidity (${equal ? 'equal highs' : sweptHigh.label}) at ${f(sweptHigh.price)} swept to ${f(wick)} and rejected; close ${f(last.close)}.`
    });
  }

  // 2.1) Inducement (IDM) Sweep & Trend Continuation (SMC07 / SMC08)
  const { highs: microHighs, lows: microLows } = findPivots(candles.slice(-18), 1);
  if (structure === 'BULLISH' && microLows.length >= 2) {
    const idmLow = microLows[microLows.length - 1];
    const majorLow = microLows[0];
    if (idmLow.price > majorLow.price && window.some((c) => c.low < idmLow.price) && last.close > idmLow.price && last.low > majorLow.price) {
      evidence.LONG.push({ pts: 1, category: 'LIQUIDITY', strategy: 'SMC07', text: `Bullish Inducement (IDM) swept at ${f(idmLow.price)} while protecting major low ${f(majorLow.price)}.` });
    }
  }
  if (structure === 'BEARISH' && microHighs.length >= 2) {
    const idmHigh = microHighs[microHighs.length - 1];
    const majorHigh = microHighs[0];
    if (idmHigh.price < majorHigh.price && window.some((c) => c.high > idmHigh.price) && last.close < idmHigh.price && last.high < majorHigh.price) {
      evidence.SHORT.push({ pts: 1, category: 'LIQUIDITY', strategy: 'SMC08', text: `Bearish Inducement (IDM) swept at ${f(idmHigh.price)} while protecting major high ${f(majorHigh.price)}.` });
    }
  }

  // 3) Displacement
  const dispLong = avgBody > 0 ? findDisplacement(candles, 'LONG', avgBody) : null;
  const dispShort = avgBody > 0 ? findDisplacement(candles, 'SHORT', avgBody) : null;
  if (dispLong) evidence.LONG.push({ pts: 1, category: 'MOMENTUM', text: `Bullish displacement: body ${f(dispLong.body)} closing near high.` });
  if (dispShort) evidence.SHORT.push({ pts: 1, category: 'MOMENTUM', text: `Bearish displacement: body ${f(dispShort.body)} closing near low.` });

  // 3.1) Dedicated Fresh Order Block (OB) Retest (SMC09 / SMC10)
  if (avgBody > 0) {
    for (let i = n - 4; i >= Math.max(2, n - 20); i--) {
      const obCandle = candles[i];
      const impulse = candles[i + 1];
      if (!impulse) continue;
      // Bullish OB: bearish candle followed by strong bullish displacement candle
      if (obCandle.close < open(obCandle) && (impulse.close - open(impulse)) >= avgBody * 1.4 && impulse.close > obCandle.high) {
        const prior = candles.slice(i + 2, n - 1);
        const alreadyMitigated = prior.some((b) => b.low <= obCandle.high);
        if (!alreadyMitigated && last.low <= obCandle.high && last.close >= obCandle.low) {
          evidence.LONG.push({ pts: 1, category: 'POI', strategy: 'SMC09', text: `Fresh Bullish Order Block ${f(obCandle.low)}-${f(obCandle.high)} tapped and holding.` });
          break;
        }
      }
      // Bearish OB: bullish candle followed by strong bearish displacement candle
      if (obCandle.close > open(obCandle) && (open(impulse) - impulse.close) >= avgBody * 1.4 && impulse.close < obCandle.low) {
        const prior = candles.slice(i + 2, n - 1);
        const alreadyMitigated = prior.some((b) => b.high >= obCandle.low);
        if (!alreadyMitigated && last.high >= obCandle.low && last.close <= obCandle.high) {
          evidence.SHORT.push({ pts: 1, category: 'POI', strategy: 'SMC10', text: `Fresh Bearish Order Block ${f(obCandle.low)}-${f(obCandle.high)} tapped and rejecting.` });
          break;
        }
      }
    }
  }

  // 3.2) Inverse Fair Value Gap (IFVG) Inversion Flip
  for (let i = n - 4; i >= Math.max(2, n - 14); i--) {
    // Bearish FVG inverted into Bullish Support
    const bearBot = candles[i].high;
    const bearTop = candles[i - 2].low;
    if (bearBot < bearTop && last.close > bearTop && candles[n - 2]?.close <= bearTop) {
      evidence.LONG.push({ pts: 1, category: 'POI', strategy: 'SMC17', text: `Bullish IFVG: Bearish FVG ${f(bearBot)}-${f(bearTop)} inverted upward at ${f(last.close)}.` });
      break;
    }
    // Bullish FVG inverted into Bearish Resistance
    const bullBot = candles[i - 2].high;
    const bullTop = candles[i].low;
    if (bullBot < bullTop && last.close < bullBot && candles[n - 2]?.close >= bullBot) {
      evidence.SHORT.push({ pts: 1, category: 'POI', strategy: 'SMC17', text: `Bearish IFVG: Bullish FVG ${f(bullBot)}-${f(bullTop)} inverted downward at ${f(last.close)}.` });
      break;
    }
  }

  // 4) 3-STEP TOP-DOWN INSTITUTIONAL MTF ALIGNMENT (15m POI & Liquidity -> 5m CHoCH+FVG -> 1m Tap)
  const candles5m = snapshot.candles5m?.length ? snapshot.candles5m : aggregateCandles(candles, 300);
  const candles15m = snapshot.candles15m?.length ? snapshot.candles15m : aggregateCandles(candles, 900);

  // Build 15m structure to gate MTF LONG setups in bearish environments
  const { highs: h15gate, lows: l15gate } = findPivots(candles15m.length >= 6 ? candles15m : candles15m, 2);
  const lastH15gate = h15gate[h15gate.length - 1];
  const prevH15gate = h15gate[h15gate.length - 2];
  const lastL15gate = l15gate[l15gate.length - 1];
  const prevL15gate = l15gate[l15gate.length - 2];
  const structure15m: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN' = lastH15gate && prevH15gate && lastL15gate && prevL15gate
    ? (lastH15gate.price > prevH15gate.price && lastL15gate.price > prevL15gate.price ? 'BULLISH'
      : lastH15gate.price < prevH15gate.price && lastL15gate.price < prevL15gate.price ? 'BEARISH' : 'MIXED')
    : 'UNKNOWN';

  const checkStep1HtfPoiOrLiquidity = (dir: Dir): { ok: boolean; label: string } => {
    const recent1mWindow = candles.slice(-20);
    const recentLow = Math.min(...recent1mWindow.map((c) => c.low));
    const recentHigh = Math.max(...recent1mWindow.map((c) => c.high));

    for (const [tfName, tfData] of [['15m', candles15m], ['5m', candles5m]] as const) {
      if (tfData.length < 8) continue;
      const { highs: htfH, lows: htfL } = findPivots(tfData.slice(0, -1), 2);
      const tfTol = price * (tfName === '15m' ? 0.0012 : 0.0008);

      if (dir === 'LONG') {
        // In 15m BEARISH structure, only Equal Lows (institutional SSL pools) count as valid Step 1
        // Single swing low sweeps in a downtrend are dead-cat traps, NOT reversals
        for (let idx = htfL.length - 1; idx >= Math.max(0, htfL.length - 6); idx--) {
          const lvl = htfL[idx].price;
          const isEqualLows = htfL.filter((p) => Math.abs(p.price - lvl) <= tfTol).length >= 2;
          if (recentLow <= lvl && last.close > lvl) {
            // In bearish 15m structure: only EQL (institutional pool) qualifies, not regular swing low
            if (structure15m === 'BEARISH' && !isEqualLows) continue;
            return { ok: true, label: `[Step 1: ${tfName} ${isEqualLows ? 'Equal Lows SSL Pool' : 'Swing Low'} ${f(lvl)} Swept & Reclaimed]` };
          }
        }
        // FVG retest for LONG — only valid if 15m structure is BULLISH or MIXED (not BEARISH)
        if (structure15m !== 'BEARISH') {
          const tfAvg = meanBody(tfData);
          for (let i = tfData.length - 2; i >= Math.max(2, tfData.length - 14); i--) {
            if (tfAvg > 0 && Math.abs(tfData[i - 1].close - open(tfData[i - 1])) < tfAvg * 1.2) continue;
            const bot = tfData[i - 2].high;
            const top = tfData[i].low;
            if (bot < top && recentLow <= top && last.close >= bot) {
              return { ok: true, label: `[Step 1: ${tfName} Bullish FVG POI ${f(bot)}-${f(top)} Tapped]` };
            }
          }
        }
      } else {
        for (let idx = htfH.length - 1; idx >= Math.max(0, htfH.length - 6); idx--) {
          const lvl = htfH[idx].price;
          const isEqualHighs = htfH.filter((p) => Math.abs(p.price - lvl) <= tfTol).length >= 2;
          if (recentHigh >= lvl && last.close < lvl) {
            return { ok: true, label: `[Step 1: ${tfName} ${isEqualHighs ? 'Equal Highs SL Pool' : 'Swing High'} ${f(lvl)} Swept & Rejected]` };
          }
        }
        const tfAvg = meanBody(tfData);
        for (let i = tfData.length - 2; i >= Math.max(2, tfData.length - 14); i--) {
          if (tfAvg > 0 && Math.abs(tfData[i - 1].close - open(tfData[i - 1])) < tfAvg * 1.2) continue;
          const bot = tfData[i].high;
          const top = tfData[i - 2].low;
          if (bot < top && recentHigh >= bot && last.close <= top) {
            return { ok: true, label: `[Step 1: ${tfName} Bearish FVG POI ${f(bot)}-${f(top)} Tapped]` };
          }
        }
      }
    }
    if (dir === 'LONG' && derived.sweepReclaim?.long) return { ok: true, label: `[Step 1: ${derived.sweepReclaim.levels.join('/')} Liquidity Swept]` };
    if (dir === 'SHORT' && derived.sweepReclaim?.short) return { ok: true, label: `[Step 1: ${derived.sweepReclaim.levels.join('/')} Liquidity Swept]` };
    return { ok: false, label: '' };
  };

  const evaluateMtfSequence = (dir: Dir): Evidence | null => {
    const step1 = checkStep1HtfPoiOrLiquidity(dir);
    if (!step1.ok || candles5m.length < 10) return null;

    const recent5mWindow = candles5m.slice(-24, -1);
    const { highs: h5, lows: l5 } = findPivots(recent5mWindow, 2);
    const recent5m = candles5m.slice(-5);
    let has5mChoch = false;

    if (dir === 'LONG' && h5.length >= 2) {
      const lowerHigh = h5[h5.length - 1];
      const prevHigh = h5[h5.length - 2];
      if (lowerHigh.price < prevHigh.price && recent5m.some((c) => c.close > lowerHigh.price)) {
        has5mChoch = true;
      }
    } else if (dir === 'SHORT' && l5.length >= 2) {
      const higherLow = l5[l5.length - 1];
      const prevLow = l5[l5.length - 2];
      if (higherLow.price > prevLow.price && recent5m.some((c) => c.close < higherLow.price)) {
        has5mChoch = true;
      }
    }

    let fvgHit = '';
    for (const [label, tfArr] of [['5m', candles5m], ['1m', candles]] as const) {
      const m = tfArr.length;
      for (let i = m - 2; i >= Math.max(2, m - 10); i--) {
        const bot = dir === 'LONG' ? tfArr[i - 2].high : tfArr[i].high;
        const top = dir === 'LONG' ? tfArr[i].low : tfArr[i - 2].low;
        if (!(bot < top)) continue;
        const mid = (bot + top) / 2;
        const prior = tfArr.slice(i + 1, m - 1);
        const mitigatedBefore = dir === 'LONG' ? prior.some((c) => c.low <= mid) : prior.some((c) => c.high >= mid);
        const tappedNow = dir === 'LONG' ? last.low <= top && last.close >= bot : last.high >= bot && last.close <= top;
        if (!mitigatedBefore && tappedNow) {
          fvgHit = `${label} FVG (${f(bot)}-${f(top)})`;
          break;
        }
      }
      if (fvgHit) break;
    }

    if (has5mChoch && fvgHit) {
      return {
        pts: 3,
        category: 'POI',
        strategy: dir === 'LONG' ? 'SMC14' : 'SMC15',
        text: `${step1.label} -> [Step 2: 5m CHoCH Confirmed] -> [Step 3: ${fvgHit} Mitigated at ${f(last.close)}].`
      };
    }
    if (has5mChoch) {
      return {
        pts: 2,
        category: 'STRUCTURE',
        strategy: dir === 'LONG' ? 'SMC03' : 'SMC04',
        text: `${step1.label} -> [Step 2: 5m CHoCH Shift Confirmed at ${f(last.close)}].`
      };
    }
    if (fvgHit) {
      return {
        pts: 1,
        category: 'POI',
        strategy: 'SMC13',
        text: `${step1.label} -> [Step 3: ${fvgHit} Retested at ${f(last.close)}].`
      };
    }
    return null;
  };

  const mtfLong = evaluateMtfSequence('LONG');
  const mtfShort = evaluateMtfSequence('SHORT');
  if (mtfLong) evidence.LONG.push(mtfLong);
  if (mtfShort) evidence.SHORT.push(mtfShort);

  // 5) Breaker Block Retest (SMC11 / SMC12 - Failed OB Flip)
  for (let i = n - 8; i >= Math.max(2, n - 18); i--) {
    const c = candles[i];
    const next = candles[i + 1];
    if (c.close < open(c) && next && next.close < c.low) {
      const brokenUp = candles.slice(i + 2, n - 1).some((b) => b.close > c.high);
      if (brokenUp && last.low <= c.high && last.close >= c.low) {
        evidence.LONG.push({ pts: 1, category: 'POI', strategy: 'SMC11', text: `Bullish Breaker Block ${f(c.low)}-${f(c.high)} holding as flipped support.` });
        break;
      }
    }
    if (c.close > open(c) && next && next.close > c.high) {
      const brokenDown = candles.slice(i + 2, n - 1).some((b) => b.close < c.low);
      if (brokenDown && last.high >= c.low && last.close <= c.high) {
        evidence.SHORT.push({ pts: 1, category: 'POI', strategy: 'SMC12', text: `Bearish Breaker Block ${f(c.low)}-${f(c.high)} rejecting as flipped resistance.` });
        break;
      }
    }
  }

  const missing: string[] = [];
  if (derived.pdh === null && derived.pdl === null) missing.push('Prior-day levels (PDH/PDL)');

  return finalize({
    agentId: 'smc', evidence, derived, missing,
    concerns: structure === 'MIXED' ? ['Swing structure is mixed.'] : [],
    emptyNote: `No confirmed MTF liquidity sweep + 5m CHoCH + OB/FVG setup (structure ${structure}).`
  });
}

// ---------------------------------------------------------------------------
// ICT Specialist (PDH/PDL Raids, OTE, Judas Swing, Silver Bullet Sequence, 2022 Model, PO3)
// ---------------------------------------------------------------------------
export function ictMathReport(snapshot: AgentSnapshot, derived: DerivedMarketContext): SpecialistReport {
  const staleErr = validateSnapshotData(snapshot);
  if (staleErr) return insufficient('ict', staleErr);

  const candles = (snapshot.candles5m && snapshot.candles5m.length >= 20) ? snapshot.candles5m : snapshot.candles;
  const n = candles.length;
  if (n < 12) return insufficient('ict', `Only ${n} candles supplied (need 12).`);
  const last = candles[n - 1];
  const price = snapshot.latestPrice ?? last.close;
  const evidence = emptyEvidence();
  const sweep = derived.sweepReclaim;

  // 1) Daily / Weekly Liquidity Raids
  if (sweep?.long) {
    const levels = sweep.levels.filter((l) => l === 'PDL' || l === 'PWL');
    if (levels.length) {
      evidence.LONG.push({ pts: 1, category: 'LIQUIDITY', strategy: levels.includes('PDL') ? 'ICT13' : 'ICT15', text: `Raid of ${levels.join(', ')} swept and reclaimed.` });
    }
  }
  if (sweep?.short) {
    const levels = sweep.levels.filter((l) => l === 'PDH' || l === 'PWH');
    if (levels.length) {
      evidence.SHORT.push({ pts: 1, category: 'LIQUIDITY', strategy: levels.includes('PDH') ? 'ICT14' : 'ICT16', text: `Raid of ${levels.join(', ')} swept and rejected.` });
    }
  }

  // 2) Judas Swing / Turtle Soup False Breakout Reclaim
  if (n >= 24) {
    const priorRange = candles.slice(-24, -4);
    const rangeHigh = Math.max(...priorRange.map((c) => c.high));
    const rangeLow = Math.min(...priorRange.map((c) => c.low));
    const recent3 = candles.slice(-4, -1);
    if (recent3.some((c) => c.low < rangeLow) && last.close > rangeLow && last.close > open(last)) {
      evidence.LONG.push({ pts: 1, category: 'LIQUIDITY', strategy: 'ICT19', text: `Turtle Soup / Judas Swing Long: false breakdown below ${f(rangeLow)} reclaimed at ${f(last.close)}.` });
    }
    if (recent3.some((c) => c.high > rangeHigh) && last.close < rangeHigh && last.close < open(last)) {
      evidence.SHORT.push({ pts: 1, category: 'LIQUIDITY', strategy: 'ICT19', text: `Turtle Soup / Judas Swing Short: false breakout above ${f(rangeHigh)} rejected at ${f(last.close)}.` });
    }
  }

  // 3) Exact OTE (62% - 79% Fib Retracement Zone) & Premium/Discount Guards
  const range = derived.dealingRange;
  const caps: Record<Dir, Cap[]> = { LONG: [], SHORT: [] };
  if (range) {
    const [l1, l2] = range.oteLongZone;
    const [s1, s2] = range.oteShortZone;
    if (range.zone === 'DISCOUNT' && price >= Math.min(l1, l2) && price <= Math.max(l1, l2)) {
      evidence.LONG.push({ pts: 1, category: 'POI', strategy: 'ICT17', text: `Price inside exact Discount OTE (62-79% Fib) ${f(Math.min(l1, l2))}-${f(Math.max(l1, l2))}.` });
    }
    if (range.zone === 'PREMIUM' && price >= Math.min(s1, s2) && price <= Math.max(s1, s2)) {
      evidence.SHORT.push({ pts: 1, category: 'POI', strategy: 'ICT17', text: `Price inside exact Premium OTE (62-79% Fib) ${f(Math.min(s1, s2))}-${f(Math.max(s1, s2))}.` });
    }
    caps.LONG.push({ when: range.zone === 'PREMIUM', cap: 1, concern: `Longing from PREMIUM: strength capped at 1.` });
    caps.SHORT.push({ when: range.zone === 'DISCOUNT', cap: 1, concern: `Shorting from DISCOUNT: strength capped at 1.` });
  }

  // 4) ICT 2022 Model (Liquidity Sweep + Displacement Shift inside Discount/Premium)
  const avgBody = meanBody(candles);
  const dispLong = avgBody > 0 ? findDisplacement(candles, 'LONG', avgBody, 6) : null;
  const dispShort = avgBody > 0 ? findDisplacement(candles, 'SHORT', avgBody, 6) : null;
  if (dispLong && range?.zone === 'DISCOUNT' && last.close > open(last)) {
    evidence.LONG.push({ pts: 1, category: 'STRUCTURE', strategy: 'ICT01', text: `ICT 2022 Long Model: Discount displacement shift with bullish close ${f(last.close)}.` });
  }
  if (dispShort && range?.zone === 'PREMIUM' && last.close < open(last)) {
    evidence.SHORT.push({ pts: 1, category: 'STRUCTURE', strategy: 'ICT02', text: `ICT 2022 Short Model: Premium displacement shift with bearish close ${f(last.close)}.` });
  }

  // 5) Power of 3 (AMD: Accumulation -> Manipulation -> Distribution)
  if (n >= 16) {
    const accumSlice = candles.slice(-14, -4);
    const manipSlice = candles.slice(-4, -1);
    const accumHigh = Math.max(...accumSlice.map((c) => c.high));
    const accumLow = Math.min(...accumSlice.map((c) => c.low));
    const accumSpan = accumHigh - accumLow;
    if (accumSpan > 0) {
      const manipBelow = Math.min(...manipSlice.map((c) => c.low)) < accumLow;
      const manipAbove = Math.max(...manipSlice.map((c) => c.high)) > accumHigh;
      if (manipBelow && last.close > (accumHigh + accumLow) / 2 && last.close > open(last)) {
        evidence.LONG.push({ pts: 1, category: 'STRUCTURE', strategy: 'ICT11', text: `Bull PO3 (AMD): Accumulation (${f(accumLow)}-${f(accumHigh)}) manipulated below low, distributing higher.` });
      }
      if (manipAbove && last.close < (accumHigh + accumLow) / 2 && last.close < open(last)) {
        evidence.SHORT.push({ pts: 1, category: 'STRUCTURE', strategy: 'ICT12', text: `Bear PO3 (AMD): Accumulation (${f(accumLow)}-${f(accumHigh)}) manipulated above high, distributing lower.` });
      }
    }
  }

  // 6) Expansion Breakout
  const prior = candles.slice(-5, -1);
  const lastClose = last.close;
  if (derived.marketRegime === 'EXPANSION' && derived.htfTrend === 'BULLISH' && lastClose > Math.max(...prior.map((c) => c.high))) {
    evidence.LONG.push({ pts: 1, category: 'MOMENTUM', strategy: 'ICT18', text: `Expansion: bullish breakout above prior highs.` });
  }
  if (derived.marketRegime === 'EXPANSION' && derived.htfTrend === 'BEARISH' && lastClose < Math.min(...prior.map((c) => c.low))) {
    evidence.SHORT.push({ pts: 1, category: 'MOMENTUM', strategy: 'ICT18', text: `Expansion: bearish breakdown below prior lows.` });
  }

  // 7) Strict Silver Bullet Validation: Only award point when active window coincides with an actual raid/OTE/2022 setup
  const longPts = evidence.LONG.length;
  const shortPts = evidence.SHORT.length;
  if (derived.silverBulletWindow !== 'NONE' && longPts !== shortPts && Math.max(longPts, shortPts) >= 1) {
    const lead: Dir = longPts > shortPts ? 'LONG' : 'SHORT';
    const hasSetupProof = evidence[lead].some((e) => e.category === 'LIQUIDITY' || e.category === 'POI' || e.category === 'STRUCTURE');
    if (hasSetupProof) {
      evidence[lead].push({ pts: 1, category: 'TIMING', strategy: lead === 'LONG' ? 'ICT03' : 'ICT04', text: `Confirmed ${derived.silverBulletWindow} Silver Bullet setup.` });
    }
  }

  return finalize({
    agentId: 'ict', evidence, derived, caps,
    emptyNote: `No ICT raid, Judas swing, PO3, 2022 model or OTE location setup (zone ${range?.zone ?? 'n/a'}).`
  });
}

// ---------------------------------------------------------------------------
// Order Flow Specialist (Absorption, DOM Imbalance, Whales, 4-Step CVD Div, POC/VA)
// ---------------------------------------------------------------------------
export function orderFlowMathReport(snapshot: AgentSnapshot, derived: DerivedMarketContext): SpecialistReport {
  const staleErr = validateSnapshotData(snapshot);
  if (staleErr) return insufficient('orderflow', staleErr);

  const closed = snapshot.footprints.filter((bar) => bar.isClosed);
  const micro = derived.orderFlowSummary;
  if (closed.length < 3 || !micro) return insufficient('orderflow', `Only ${closed.length} closed footprints supplied (need 3).`);

  const latest = closed[closed.length - 1];
  const ref = closed[Math.max(0, closed.length - 3)];
  const priceProgress = latest.close - ref.close;
  const range = latest.high - latest.low;
  const evidence = emptyEvidence();
  const concerns: string[] = [];
  const syn = micro.synthetic5mSummary ?? null;

  // DOM Bid/Ask Liquidity Imbalance Ratio (Top 5 Levels — only read when feedStatus is LIVE)
  const isDomLive = snapshot.feedStatus === 'LIVE';
  const bidVolTop5 = isDomLive ? (snapshot.bids ?? []).slice(0, 5).reduce((s, [, qty]) => s + (Number(qty) || 0), 0) : 0;
  const askVolTop5 = isDomLive ? (snapshot.asks ?? []).slice(0, 5).reduce((s, [, qty]) => s + (Number(qty) || 0), 0) : 0;
  const domBidDominant = bidVolTop5 > 0 && askVolTop5 > 0 && bidVolTop5 >= askVolTop5 * 1.75;
  const domAskDominant = bidVolTop5 > 0 && askVolTop5 > 0 && askVolTop5 >= bidVolTop5 * 1.75;

  // 1) Key-Level Institutional Absorption + Price Response Confirmation
  // nearKeyLevel proximity widened to 0.4% (was 0.25%) — matches BOS cap change.
  // Also include swing highs/lows from derived context as key levels.
  const keyLevels = [
    snapshot.profile?.vah, snapshot.profile?.val,
    derived.pdh, derived.pdl,
    derived.sessionHigh, derived.sessionLow,
    derived.recentSwingHigh, derived.recentSwingLow,
    derived.pwh, derived.pwl
  ].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const nearKeyLevel = keyLevels.some((lvl) => Math.abs(latest.close - lvl) / latest.close <= 0.004);

  if (micro.absorptionSignal === 'BULLISH_ABSORPTION' && nearKeyLevel && latest.close > open(latest)) {
    evidence.LONG.push({
      pts: 2,
      category: 'LIQUIDITY',
      strategy: 'OF01',
      text: `Key-level Bid absorption: heavy selling delta ${f(micro.latestBarDelta)} absorbed at support with bullish close ${f(latest.close)}.`
    });
  }
  if (micro.absorptionSignal === 'BEARISH_ABSORPTION' && nearKeyLevel && latest.close < open(latest)) {
    evidence.SHORT.push({
      pts: 2,
      category: 'LIQUIDITY',
      strategy: 'OF02',
      text: `Key-level Ask absorption: heavy buying delta ${f(micro.latestBarDelta)} absorbed at resistance with bearish close ${f(latest.close)}.`
    });
  }

  // 1.1) 4-Step Setup (OF23: Double Test Absorption + CVD Divergence + Aggressive Trigger)
  if (closed.length >= 6 && nearKeyLevel) {
    const prev4 = closed.slice(-6, -1);
    const firstHalf = prev4.slice(0, 2);
    const secondHalf = prev4.slice(2);

    const h1 = Math.max(...firstHalf.map((b) => b.high));
    const cvd1High = Math.max(...firstHalf.map((b) => b.cumulativeDelta));
    const h2 = Math.max(...secondHalf.map((b) => b.high));
    const cvd2High = Math.max(...secondHalf.map((b) => b.cumulativeDelta));

    const l1 = Math.min(...firstHalf.map((b) => b.low));
    const cvd1Low = Math.min(...firstHalf.map((b) => b.cumulativeDelta));
    const l2 = Math.min(...secondHalf.map((b) => b.low));
    const cvd2Low = Math.min(...secondHalf.map((b) => b.cumulativeDelta));

    if (h2 <= h1 * 1.0005 && cvd2High > cvd1High && latest.delta < -Math.abs(latest.totalVolume) * 0.20 && latest.close < latest.pocPrice && latest.close < open(latest)) {
      evidence.SHORT.push({
        pts: 2,
        category: 'LIQUIDITY',
        strategy: 'OF23',
        text: `4-Step Ceiling Absorption + CVD Divergence Breakdown: 2nd test rejected (${f(h2)} <= ${f(h1)}) while CVD made higher high, followed by aggressive sell trigger (${f(latest.delta)}).`
      });
    }

    if (l2 >= l1 * 0.9995 && cvd2Low < cvd1Low && latest.delta > Math.abs(latest.totalVolume) * 0.20 && latest.close > latest.pocPrice && latest.close > open(latest)) {
      evidence.LONG.push({
        pts: 2,
        category: 'LIQUIDITY',
        strategy: 'OF23',
        text: `4-Step Floor Absorption + CVD Divergence Reclaim: 2nd test held (${f(l2)} >= ${f(l1)}) while CVD made lower low, followed by aggressive buy trigger (+${f(latest.delta)}).`
      });
    }
  }

  // 1.2) Deribit Options Gamma (GEX) Institutional Confluence
  const gamma = snapshot.gammaContext;
  if (gamma && latest.close > 0) {
    if (gamma.putWall !== null && Math.abs(latest.close - gamma.putWall) / latest.close <= 0.005) {
      if (latest.close > open(latest) || (micro.latestBarDelta > 0 && micro.cvdTrend === 'RISING')) {
        evidence.LONG.push({
          pts: 2,
          category: 'POI',
          strategy: 'OF10',
          text: `Deribit Put Wall Support bounce ($${gamma.putWall}): institutional options floor defended with buying response.`
        });
      }
    }
    if (gamma.callWall !== null && Math.abs(latest.close - gamma.callWall) / latest.close <= 0.005) {
      if (latest.close < open(latest) || (micro.latestBarDelta < 0 && micro.cvdTrend === 'FALLING')) {
        evidence.SHORT.push({
          pts: 2,
          category: 'POI',
          strategy: 'OF11',
          text: `Deribit Call Wall Resistance rejection ($${gamma.callWall}): institutional options ceiling pinned/rejected with selling response.`
        });
      }
    }
    if (gamma.regime === 'NEGATIVE_GAMMA' && gamma.gammaFlip !== null) {
      if (latest.close < gamma.gammaFlip && micro.cvdTrend === 'FALLING' && micro.latestBarDelta < 0) {
        evidence.SHORT.push({
          pts: 1,
          category: 'MOMENTUM',
          strategy: 'OF12',
          text: `Negative Gamma Acceleration: price below Gamma Flip ($${gamma.gammaFlip}) with negative delta expansion.`
        });
      } else if (latest.close > gamma.gammaFlip && micro.cvdTrend === 'RISING' && micro.latestBarDelta > 0) {
        evidence.LONG.push({
          pts: 1,
          category: 'MOMENTUM',
          strategy: 'OF13',
          text: `Gamma Flip Reclaim: price trading above Gamma Flip ($${gamma.gammaFlip}) with positive delta momentum.`
        });
      }
    }
  }

  // 2) Stacked Imbalances (3+ adjacent levels per catalogue OF07/OF08)
  if (micro.stackedBuyImbalances.length >= 3 && latest.close >= latest.open) {
    evidence.LONG.push({
      pts: 1,
      category: 'FLOW',
      strategy: 'OF07',
      text: `${micro.stackedBuyImbalances.length} stacked buy imbalances with bullish close${domBidDominant ? ' + strong DOM bid wall' : ''}.`
    });
  }
  if (micro.stackedSellImbalances.length >= 3 && latest.close <= latest.open) {
    evidence.SHORT.push({
      pts: 1,
      category: 'FLOW',
      strategy: 'OF08',
      text: `${micro.stackedSellImbalances.length} stacked sell imbalances with bearish close${domAskDominant ? ' + strong DOM ask wall' : ''}.`
    });
  }

  // 2.1) Institutional Passive Defense (Large Volume + Delta Absorption + DOM Confirmation)
  const prevBars = closed.slice(-6, -1);
  const avgVol = prevBars.length ? prevBars.reduce((sum, b) => sum + b.totalVolume, 0) / prevBars.length : (micro.latestBarVolume || 1);
  const avgDelta = prevBars.length ? prevBars.reduce((sum, b) => sum + Math.abs(b.delta), 0) / prevBars.length : (Math.abs(micro.latestBarDelta) || 1);

  const currentVol = micro.latestBarVolume || latest.totalVolume;
  const isWhaleActivity = currentVol >= avgVol * 1.8 && Math.abs(micro.latestBarDelta) >= avgDelta * 1.8;
  if (isWhaleActivity) {
    const mid = (latest.high + latest.low) / 2;
    if (micro.latestBarDelta < 0 && latest.close >= mid && latest.close > open(latest)) {
      evidence.LONG.push({
        pts: 2,
        category: 'LIQUIDITY',
        strategy: 'OF21',
        text: `Institutional Bid Defense: Heavy selling delta (${f(micro.latestBarDelta)}) absorbed by passive buyer; closed bullish above mid (${f(latest.close)}).`
      });
    }
    if (micro.latestBarDelta > 0 && latest.close <= mid && latest.close < open(latest)) {
      evidence.SHORT.push({
        pts: 2,
        category: 'LIQUIDITY',
        strategy: 'OF21',
        text: `Institutional Ask Defense: Heavy buying delta (+${f(micro.latestBarDelta)}) absorbed by passive seller; closed bearish below mid (${f(latest.close)}).`
      });
    }
  }

  // 2.2) True Iceberg Order Refill Detection (OF24 / OF25)
  // NOTE: bidIcebergPrice / askIcebergPrice are optional extension fields populated by
  // OrderFlowAggregator when iceberg detection is enabled. They default to null until
  // that feature is wired up — the guard below keeps the code safe and ready.
  const bidIceberg = (latest as { bidIcebergPrice?: number | null }).bidIcebergPrice ?? null;
  const askIceberg = (latest as { askIcebergPrice?: number | null }).askIcebergPrice ?? null;
  if (bidIceberg !== null && latest.close > open(latest)) {
    evidence.LONG.push({
      pts: 2,
      category: 'LIQUIDITY',
      strategy: 'OF24',
      text: `True Bid Iceberg Refill: repeated passive limit refills soaked sell sweeps at ${f(bidIceberg)}; closed bullish at ${f(latest.close)}.`
    });
  }
  if (askIceberg !== null && latest.close < open(latest)) {
    evidence.SHORT.push({
      pts: 2,
      category: 'LIQUIDITY',
      strategy: 'OF25',
      text: `True Ask Iceberg Refill: repeated passive limit refills soaked buy sweeps at ${f(askIceberg)}; closed bearish at ${f(latest.close)}.`
    });
  }

  // 2.3) Whale Tape Sweeps — approximate from raw trade list (OF26 / OF27)
  // Since whaleBuyVolume is not yet a first-class field on SerializedFootprintBar,
  // we derive a proxy from snapshot.trades: sum trades >= 8× median size in this bar's window.
  const barTrades = snapshot.trades.filter(
    (t) => t.timestamp >= latest.time * 1000 && t.timestamp < (latest.time + 60) * 1000
  );
  let whaleBuyVol = 0, whaleSellVol = 0, whaleBuyCount = 0, whaleSellCount = 0;
  if (barTrades.length >= 5) {
    const sizes = barTrades.map((t) => t.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const threshold = median * 8;
    for (const t of barTrades) {
      if (t.size < threshold) continue;
      if (t.side === 'Buy') { whaleBuyVol += t.size; whaleBuyCount++; }
      else { whaleSellVol += t.size; whaleSellCount++; }
    }
  }
  if (latest.totalVolume > 0) {
    if (whaleBuyVol >= latest.totalVolume * 0.18 && whaleBuyVol > whaleSellVol * 1.5 && latest.close > open(latest)) {
      evidence.LONG.push({
        pts: 1,
        category: 'FLOW',
        strategy: 'OF26',
        text: `Whale Tape Sweep (Buy): ${whaleBuyCount} big institutional prints (${f(whaleBuyVol)} vol) swept asks with bullish close.`
      });
    }
    if (whaleSellVol >= latest.totalVolume * 0.18 && whaleSellVol > whaleBuyVol * 1.5 && latest.close < open(latest)) {
      evidence.SHORT.push({
        pts: 1,
        category: 'FLOW',
        strategy: 'OF27',
        text: `Whale Tape Sweep (Sell): ${whaleSellCount} big institutional prints (${f(whaleSellVol)} vol) hit bids with bearish close.`
      });
    }
  }

  // 3) CVD / Delta Trend & Divergence
  const cvdUp = micro.cvdTrend === 'RISING' && micro.cvdChange3Bar > 0;
  const cvdDown = micro.cvdTrend === 'FALLING' && micro.cvdChange3Bar < 0;

  if ((cvdUp && priceProgress >= 0) || micro.deltaBreakoutSignal === 'BULLISH_DELTA_IMPULSE') {
    evidence.LONG.push({ pts: 1, category: 'MOMENTUM', text: `CVD Bullish Confirmation (+${f(micro.cvdChange3Bar)}), Delta Impulse.` });
  } else if (cvdUp && priceProgress < 0 && latest.close > latest.open) {
    evidence.LONG.push({ pts: 1, category: 'FLOW', strategy: 'OF05', text: `Bullish CVD Divergence (CVD +${f(micro.cvdChange3Bar)}, Price -${f(Math.abs(priceProgress))}).` });
  }

  if ((cvdDown && priceProgress <= 0) || micro.deltaBreakoutSignal === 'BEARISH_DELTA_BREAKDOWN') {
    evidence.SHORT.push({ pts: 1, category: 'MOMENTUM', text: `CVD Bearish Confirmation (${f(micro.cvdChange3Bar)}), Delta Breakdown.` });
  } else if (cvdDown && priceProgress > 0 && latest.close < latest.open) {
    evidence.SHORT.push({ pts: 1, category: 'FLOW', strategy: 'OF06', text: `Bearish CVD Divergence (CVD ${f(micro.cvdChange3Bar)}, Price +${f(priceProgress)}).` });
  }

  // 4) POC Acceptance
  if (micro.latestPocPosition === 'POC_SUPPORT_UNDERFOOT' && micro.latestBarDelta > 0) {
    evidence.LONG.push({ pts: 1, category: 'FLOW', strategy: 'OF11', text: `POC support underfoot (${f(latest.pocPrice)}) with positive delta.` });
  }
  if (micro.latestPocPosition === 'POC_TRAPPED_OVERHEAD' && micro.latestBarDelta < 0) {
    evidence.SHORT.push({ pts: 1, category: 'FLOW', strategy: 'OF12', text: `POC overhead trapped (${f(latest.pocPrice)}) with negative delta.` });
  }

  // 5) Value Area Rejection
  const profile = snapshot.profile;
  if (profile && profile.vah > profile.val && range > 0) {
    const band = (profile.vah - profile.val) * 0.12;
    if (latest.low <= profile.val + band && latest.close > profile.val) {
      evidence.LONG.push({ pts: 1, category: 'POI', strategy: 'OF13', text: `Value Area Low (VAL) rejected at ${f(profile.val)}.` });
    }
    if (latest.high >= profile.vah - band && latest.close < profile.vah) {
      evidence.SHORT.push({ pts: 1, category: 'POI', strategy: 'OF14', text: `Value Area High (VAH) rejected at ${f(profile.vah)}.` });
    }
  }

  // 6) 5-MINUTE FOOTPRINT MACRO ANALYSIS & DIRECTIONAL CONFLUENCE
  // 5m Footprint establishes institutional order flow: 5m Delta, 5m CVD trend, 5m POC position
  const syn5mBullish = syn ? (syn.delta > 0 && (syn.close >= syn.open || syn.pocPosition === 'POC_SUPPORT_UNDERFOOT')) : false;
  const syn5mBearish = syn ? (syn.delta < 0 && (syn.close <= syn.open || syn.pocPosition === 'POC_TRAPPED_OVERHEAD')) : false;

  if (syn) {
    if (syn5mBullish) {
      evidence.LONG.push({
        pts: 2,
        category: 'FLOW',
        strategy: 'OF_5M_MACRO',
        text: `5m Footprint Institutional Accumulation: 5m Delta (+${f(syn.delta)}), CVD ${syn.cvdTrend ?? 'RISING'}, 5m POC support underfoot (${f(syn.pocPrice)}).`
      });
    }
    if (syn.signal === 'BULLISH_SELLER_ABSORPTION_UNDERFOOT_POC' || syn.signal === 'BULLISH_5M_DELTA_IMPULSE') {
      evidence.LONG.push({
        pts: 1,
        category: 'LIQUIDITY',
        strategy: 'OF_5M_SIG',
        text: `5m Institutional Footprint Signal: ${syn.signal}.`
      });
    }

    if (syn5mBearish) {
      evidence.SHORT.push({
        pts: 2,
        category: 'FLOW',
        strategy: 'OF_5M_MACRO',
        text: `5m Footprint Institutional Distribution: 5m Delta (${f(syn.delta)}), CVD ${syn.cvdTrend ?? 'FALLING'}, 5m POC trapped overhead (${f(syn.pocPrice)}).`
      });
    }
    if (syn.signal === 'BEARISH_TRAPPED_BUYERS_OVERHEAD_POC' || syn.signal === 'BEARISH_5M_DELTA_BREAKDOWN') {
      evidence.SHORT.push({
        pts: 1,
        category: 'LIQUIDITY',
        strategy: 'OF_5M_SIG',
        text: `5m Institutional Footprint Signal: ${syn.signal}.`
      });
    }
  }

  // 7) 1-MINUTE SNIPER ENTRY TRIGGER & RE-TEST CONFIRMATION
  // The entry is planned and triggered on the 1m candle close once 5m macro flow aligns
  const is1m = snapshot.timeframe === '1m';
  if (is1m) {
    // 1m Bullish Entry Trigger
    if (latest.close > open(latest) && latest.delta > 0) {
      evidence.LONG.push({
        pts: 1,
        category: 'MOMENTUM',
        strategy: 'OF_1M_TRIGGER',
        text: `1m Sniper Entry Trigger: Closed bullish (${f(latest.close)}) with positive delta (+${f(latest.delta)}).`
      });
    }
    // 1m Retest of 5m POC as dynamic support
    if (syn && Math.abs(latest.low - syn.pocPrice) / syn.pocPrice <= 0.003 && latest.close >= syn.pocPrice) {
      evidence.LONG.push({
        pts: 1,
        category: 'POI',
        strategy: 'OF_5M_POC_RETEST',
        text: `1m Pullback & Bounce off 5m POC (${f(syn.pocPrice)}) held as dynamic support.`
      });
    }

    // 1m Bearish Entry Trigger
    if (latest.close < open(latest) && latest.delta < 0) {
      evidence.SHORT.push({
        pts: 1,
        category: 'MOMENTUM',
        strategy: 'OF_1M_TRIGGER',
        text: `1m Sniper Entry Trigger: Closed bearish (${f(latest.close)}) with negative delta (${f(latest.delta)}).`
      });
    }
    // 1m Retest of 5m POC as dynamic resistance
    if (syn && Math.abs(latest.high - syn.pocPrice) / syn.pocPrice <= 0.003 && latest.close <= syn.pocPrice) {
      evidence.SHORT.push({
        pts: 1,
        category: 'POI',
        strategy: 'OF_5M_POC_RETEST',
        text: `1m Pullback & Rejection from 5m POC (${f(syn.pocPrice)}) held as dynamic ceiling.`
      });
    }
  }

  const hasInstitutionalLong = evidence.LONG.some((e) => ['OF01', 'OF21', 'OF23', 'OF24', 'OF26', 'OF_5M_MACRO'].includes(e.strategy ?? ''));
  const hasInstitutionalShort = evidence.SHORT.some((e) => ['OF02', 'OF21', 'OF23', 'OF25', 'OF27', 'OF_5M_MACRO'].includes(e.strategy ?? ''));

  const caps: Record<Dir, Cap[]> = {
    LONG: [
      { when: syn?.pocPosition === 'POC_TRAPPED_OVERHEAD' && latest.close < (syn.pocPrice * 0.9985), cap: 1, concern: 'Long capped: 5m high-volume POC is trapped overhead.' },
      { when: Boolean(syn) && syn!.delta < 0 && syn!.cvdTrend === 'FALLING', cap: 1, concern: 'Long capped: 5m footprint delta is negative and 5m CVD is falling.' },
      { when: is1m && latest.close < open(latest) && latest.delta < 0 && !hasInstitutionalLong, cap: 1, concern: 'Long capped: 1m trigger candle closed bearish with negative delta.' }
    ],
    SHORT: [
      { when: syn?.pocPosition === 'POC_SUPPORT_UNDERFOOT' && latest.close > (syn.pocPrice * 1.0015), cap: 1, concern: 'Short capped: 5m high-volume POC is acting as support underfoot.' },
      { when: Boolean(syn) && syn!.delta > 0 && syn!.cvdTrend === 'RISING', cap: 1, concern: 'Short capped: 5m footprint delta is positive and 5m CVD is rising.' },
      { when: is1m && latest.close > open(latest) && latest.delta > 0 && !hasInstitutionalShort, cap: 1, concern: 'Short capped: 1m trigger candle closed bullish with positive delta.' }
    ]
  };

  return finalize({
    agentId: 'orderflow', evidence, derived, concerns, caps,
    emptyNote: `No decisive order flow confluence (CVD ${micro.cvdTrend}, POC ${micro.latestPocPosition}).`
  });
}

export function computeMathReports(snapshot: AgentSnapshot, derived: DerivedMarketContext): SpecialistReport[] {
  return [smcMathReport(snapshot, derived), ictMathReport(snapshot, derived), orderFlowMathReport(snapshot, derived)];
}