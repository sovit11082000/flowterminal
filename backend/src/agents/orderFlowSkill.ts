export type StrategyFamily = 'smc' | 'ict' | 'orderflow';
export type StrategyDirection = 'LONG' | 'SHORT' | 'BOTH';
export interface StrategyRule { id: string; family: StrategyFamily; direction: StrategyDirection; name: string; rule: string; }

/** Compact, auditable research catalog. These are candidate setups, not validated profitable systems. */
export const STRATEGY_CATALOG: readonly StrategyRule[] = [
  { id: 'SMC01', family: 'smc', direction: 'LONG', name: 'Bull BOS pullback', rule: 'Confirmed close above prior confirmed swing high, then pullback holds the broken level.' },
  { id: 'SMC02', family: 'smc', direction: 'SHORT', name: 'Bear BOS pullback', rule: 'Confirmed close below prior confirmed swing low, then retest rejects the broken level.' },
  { id: 'SMC03', family: 'smc', direction: 'LONG', name: 'Bull CHoCH reversal', rule: 'After bearish structure, confirmed close breaks a prior lower high; wait for retest/hold.' },
  { id: 'SMC04', family: 'smc', direction: 'SHORT', name: 'Bear CHoCH reversal', rule: 'After bullish structure, confirmed close breaks a prior higher low; wait for retest/rejection.' },
  { id: 'SMC05', family: 'smc', direction: 'LONG', name: 'EQL sweep reversal', rule: 'At least two confirmed low tests, wick sweeps the pool, candle closes back above it, then bullish confirmation.' },
  { id: 'SMC06', family: 'smc', direction: 'SHORT', name: 'EQH sweep reversal', rule: 'At least two confirmed high tests, wick sweeps the pool, candle closes back below it, then bearish confirmation.' },
  { id: 'SMC07', family: 'smc', direction: 'LONG', name: 'Bull inducement continuation', rule: 'A confirmed internal low/liquidity inducement is swept before bullish displacement and continuation BOS.' },
  { id: 'SMC08', family: 'smc', direction: 'SHORT', name: 'Bear inducement continuation', rule: 'A confirmed internal high/liquidity inducement is swept before bearish displacement and continuation BOS.' },
  { id: 'SMC09', family: 'smc', direction: 'LONG', name: 'Bull order-block retest', rule: 'Retest of the last opposing down candle before confirmed bullish displacement/BOS; zone must remain unmitigated.' },
  { id: 'SMC10', family: 'smc', direction: 'SHORT', name: 'Bear order-block retest', rule: 'Retest of the last opposing up candle before confirmed bearish displacement/BOS; zone must remain unmitigated.' },
  { id: 'SMC11', family: 'smc', direction: 'LONG', name: 'Bull breaker retest', rule: 'Previously valid bearish block is decisively broken upward and then holds as resistance-turned-support.' },
  { id: 'SMC12', family: 'smc', direction: 'SHORT', name: 'Bear breaker retest', rule: 'Previously valid bullish block is decisively broken downward and then rejects as support-turned-resistance.' },
  { id: 'SMC13', family: 'smc', direction: 'BOTH', name: 'FVG continuation', rule: 'Three-candle displacement gap in trend direction; only consider an unfilled retest with confirming close.' },
  { id: 'SMC14', family: 'smc', direction: 'LONG', name: 'Bull OB + FVG overlap', rule: 'Unmitigated bullish order block overlaps a bullish three-candle FVG after confirmed displacement.' },
  { id: 'SMC15', family: 'smc', direction: 'SHORT', name: 'Bear OB + FVG overlap', rule: 'Unmitigated bearish order block overlaps a bearish three-candle FVG after confirmed displacement.' },
  { id: 'SMC16', family: 'smc', direction: 'BOTH', name: 'HTF trend alignment shield', rule: 'Trade strictly in direction of 15m/1h trend. Disallow 1m counter-trend trades unless major HTF liquidity pool (PDH/PDL/PWH/PWL) is swept.' },

  { id: 'ICT01', family: 'ict', direction: 'LONG', name: '2022 model long', rule: 'Confirmed sell-side raid, bullish displacement/MSS, then retracement to supported FVG/OB; session data must be known.' },
  { id: 'ICT02', family: 'ict', direction: 'SHORT', name: '2022 model short', rule: 'Confirmed buy-side raid, bearish displacement/MSS, then retracement to supported FVG/OB; session data must be known.' },
  { id: 'ICT03', family: 'ict', direction: 'LONG', name: 'Silver Bullet long', rule: 'Within the configured Silver Bullet window only: sell-side raid, displacement and bullish FVG retracement.' },
  { id: 'ICT04', family: 'ict', direction: 'SHORT', name: 'Silver Bullet short', rule: 'Within the configured Silver Bullet window only: buy-side raid, displacement and bearish FVG retracement.' },
  { id: 'ICT05', family: 'ict', direction: 'LONG', name: 'Asia low raid', rule: 'Known Asia range low is swept and price confirms bullish displacement/reclaim.' },
  { id: 'ICT06', family: 'ict', direction: 'SHORT', name: 'Asia high raid', rule: 'Known Asia range high is swept and price confirms bearish displacement/rejection.' },
  { id: 'ICT07', family: 'ict', direction: 'LONG', name: 'London Judas long', rule: 'In a timestamp-verified London window, downside false move raids liquidity before bullish displacement.' },
  { id: 'ICT08', family: 'ict', direction: 'SHORT', name: 'London Judas short', rule: 'In a timestamp-verified London window, upside false move raids liquidity before bearish displacement.' },
  { id: 'ICT09', family: 'ict', direction: 'LONG', name: 'New York Judas long', rule: 'In a timestamp-verified New York window, downside false move raids liquidity before bullish displacement.' },
  { id: 'ICT10', family: 'ict', direction: 'SHORT', name: 'New York Judas short', rule: 'In a timestamp-verified New York window, upside false move raids liquidity before bearish displacement.' },
  { id: 'ICT11', family: 'ict', direction: 'LONG', name: 'Bull PO3', rule: 'Observed accumulation, downside manipulation/raid, then confirmed bullish distribution; do not infer phase from clock alone.' },
  { id: 'ICT12', family: 'ict', direction: 'SHORT', name: 'Bear PO3', rule: 'Observed accumulation, upside manipulation/raid, then confirmed bearish distribution; do not infer phase from clock alone.' },
  { id: 'ICT13', family: 'ict', direction: 'LONG', name: 'PDL raid reversal', rule: 'Known previous-day low is swept, reclaimed and followed by bullish displacement.' },
  { id: 'ICT14', family: 'ict', direction: 'SHORT', name: 'PDH raid reversal', rule: 'Known previous-day high is swept, rejected and followed by bearish displacement.' },
  { id: 'ICT15', family: 'ict', direction: 'LONG', name: 'PWL raid reversal', rule: 'Known previous-week low is swept, reclaimed and followed by bullish displacement.' },
  { id: 'ICT16', family: 'ict', direction: 'SHORT', name: 'PWH raid reversal', rule: 'Known previous-week high is swept, rejected and followed by bearish displacement.' },
  { id: 'ICT17', family: 'ict', direction: 'BOTH', name: 'OTE retracement', rule: 'Use only a confirmed dealing range and measured retracement zone; require directional displacement and invalidation.' },
  { id: 'ICT18', family: 'ict', direction: 'BOTH', name: 'Macro expansion alignment', rule: 'Align with higher timeframe session expansion phase; ignore minor retracements that oppose the dominant cycle.' },

  { id: 'OF01', family: 'orderflow', direction: 'LONG', name: 'Bid absorption', rule: 'Repeated aggressive selling at a level with limited downside progress and footprint evidence, followed by reclaim.' },
  { id: 'OF02', family: 'orderflow', direction: 'SHORT', name: 'Ask absorption', rule: 'Repeated aggressive buying at a level with limited upside progress and footprint evidence, followed by rejection.' },
  { id: 'OF03', family: 'orderflow', direction: 'LONG', name: 'Positive delta divergence', rule: 'Price makes a lower low while closed-bar delta improves; require subsequent price reclaim.' },
  { id: 'OF04', family: 'orderflow', direction: 'SHORT', name: 'Negative delta divergence', rule: 'Price makes a higher high while closed-bar delta weakens; require subsequent price rejection.' },
  { id: 'OF05', family: 'orderflow', direction: 'LONG', name: 'Bull CVD divergence', rule: 'Price makes a lower low while supplied CVD forms a higher low; require price confirmation.' },
  { id: 'OF06', family: 'orderflow', direction: 'SHORT', name: 'Bear CVD divergence', rule: 'Price makes a higher high while supplied CVD forms a lower high; require price confirmation.' },
  { id: 'OF07', family: 'orderflow', direction: 'LONG', name: 'Stacked ask imbalance', rule: 'At least three adjacent meaningful-volume ask-side imbalances and acceptance/reclaim above their area.' },
  { id: 'OF08', family: 'orderflow', direction: 'SHORT', name: 'Stacked bid imbalance', rule: 'At least three adjacent meaningful-volume bid-side imbalances and acceptance/reclaim below their area.' },
  { id: 'OF09', family: 'orderflow', direction: 'LONG', name: 'Buy imbalance exhaustion', rule: 'Aggressive buying loses price progress at a tested resistance, then price confirms rejection lower; avoid countertrend guess.' },
  { id: 'OF10', family: 'orderflow', direction: 'SHORT', name: 'Sell imbalance exhaustion', rule: 'Aggressive selling loses price progress at tested support, then price confirms rejection higher; avoid countertrend guess.' },
  { id: 'OF11', family: 'orderflow', direction: 'LONG', name: 'POC reclaim', rule: 'Closed bar reclaims footprint POC and holds/retests it with supportive participation.' },
  { id: 'OF12', family: 'orderflow', direction: 'SHORT', name: 'POC rejection', rule: 'Closed bar rejects footprint POC from below with supportive sell participation.' },
  { id: 'OF13', family: 'orderflow', direction: 'LONG', name: 'VAL rejection', rule: 'Supplied value-area low is tested, rejected and reclaimed with closed-bar confirmation.' },
  { id: 'OF14', family: 'orderflow', direction: 'SHORT', name: 'VAH rejection', rule: 'Supplied value-area high is tested, rejected and lost with closed-bar confirmation.' },
  { id: 'OF15', family: 'orderflow', direction: 'BOTH', name: 'LVN traverse', rule: 'A supplied low-volume node is crossed with acceptance; direction follows confirmed close and participation.' },
  { id: 'OF16', family: 'orderflow', direction: 'BOTH', name: 'HVN rejection', rule: 'Supplied high-volume node rejects price; direction follows confirmed close and footprint response.' },
  { id: 'OF17', family: 'orderflow', direction: 'LONG', name: 'Book imbalance + break', rule: 'Synchronized two-sided DOM imbalance aligns with closed-bar break/reclaim; DOM alone is not a trigger.' },
  { id: 'OF18', family: 'orderflow', direction: 'SHORT', name: 'Book pull + failed break', rule: 'Synchronized book liquidity pulls as an upside break fails and price closes back below the level.' },
  { id: 'OF19', family: 'orderflow', direction: 'BOTH', name: 'Chop & dead zone avoidance', rule: 'When market volume is below baseline or compressed inside Value Area without impulse, force WAIT to avoid chop stop-outs.' },
  { id: 'OF20', family: 'orderflow', direction: 'BOTH', name: 'OI & liquidation exhaustion', rule: 'Distinguish real breakouts from fake liquidation pumps. If price moves into heavy liquidations or OI drops on pump, seek reversal or wait.' }
] as const;

export function strategiesFor(family: StrategyFamily): readonly StrategyRule[] {
  return STRATEGY_CATALOG.filter((strategy) => strategy.family === family);
}

export function strategyById(id: string): StrategyRule | undefined {
  return STRATEGY_CATALOG.find((strategy) => strategy.id === id);
}

/** Shared evidence-quality rules supplied to each specialist and the manager. */
export const ORDER_FLOW_SKILL = `
MARKET ANALYSIS QUALITY RULES

DATA CONTRACT AND QUALITY GATES
- The supplied snapshot (including derivedContext for sessions, HTF trend, market regime, PDH/PDL, PWH/PWL, and dealing range) is the entire evidence set. Never fabricate prices or events outside the snapshot.
- Check timestamps, interval, candle count, closed-bar status, feed status, and empty fields before interpreting direction. A forming bar is provisional; base confirmation on closed bars.
- If feedStatus is DESYNCHRONIZED, use fresh trades, footprints, and candles only. Treat bids/asks as unavailable even if old rows are present.
- Public-trade aggressor Buy is ask-side volume; aggressor Sell is bid-side volume. Delta = ask volume - bid volume. Positive delta alone is not bullish confirmation.
- If fewer than four closed footprints or candles are supplied, report insufficient context and the manager must choose WAIT.

HIGHER TIMEFRAME & REGIME QUALITY GATES (LOSS-REDUCTION RULES)
1. HTF TREND SHIELD (15m/1h Trend): Check derivedContext.htfTrend. If HTF is BEARISH, do NOT approve 1m LONG trades unless a verified HTF liquidity pool (PDL or PWL) was swept with reclaim. If HTF is BULLISH, do NOT take 1m SHORT trades against the trend.
2. CHOP & DEAD ZONE FILTER: If derivedContext.marketRegime is 'CHOP_COMPRESSION' or volume is low (< 40% baseline), specialists must lower strength to 0 or NEUTRAL, and the Manager MUST choose WAIT. Never trade inside dead consolidation.
3. LIQUIDATION & OI EXHAUSTION: If derivedContext.liquidationSignal shows exhaustion or short-covering pump, do NOT buy breakout wicks.

FOOTPRINT AND AUCTION READ
- Compare ask/bid volume on each price row. A 3:1 ratio is a candidate imbalance only when both sides are nonzero and the row has meaningful volume relative to that bar.
- A stacked imbalance requires at least three adjacent qualifying prices on the same side. State the direction, count, and nearby price area when present.
- Relate bar delta and CVD direction to price progress, candle close, wick, and POC. Divergence is a warning to investigate, not a standalone reversal signal.
- POC is the maximum traded-volume price in the supplied footprint or volume profile.
- Acceptance needs repeated closes or sustained trade around a level; rejection needs an observed response away from a level.

TAPE, ABSORPTION, AND LIQUIDITY
- Describe only visible trades and their supplied side, size, price, and timestamp.
- Absorption is a hypothesis when repeated aggressive executions occur at/through a price while price makes limited progress and the supplied footprint supports it.
- DOM is a point-in-time view of displayed resting orders. Compare cumulative visible bid and ask depth only when both sides are present and synchronized.

SETUP AND RISK STANDARD
- Cite the exact supplied prices and values behind every material claim.
- Seek confluence across SMC structure/zones, ICT dealing range/session/raids, and Order Flow footprint/delta/profile response.
- A directional plan (LONG or SHORT) is valid when at least 2 of the 3 specialists agree on the same direction (LONG or SHORT) with strength >= 2 (and the 3rd specialist is either aligned, NEUTRAL, or low-strength dissent <= 1).
- Choose WAIT when fewer than 2 specialists agree on a direction, when specialists strongly conflict (e.g., LONG strength >= 2 vs SHORT strength >= 2), or when data quality fails.
- For directional plans, provide:
  1. Clear summary and concrete reasons explaining WHY this trade should be taken based on SMC, ICT, and Order Flow evidence.
  2. Specific entryTrigger (e.g., POC/Value Area pullback, active Order Block/FVG retest, or structure hold) and numeric entryPrice.
  3. Structural invalidation description and numeric stopPrice beyond the invalidation swing/zone.
  4. Numeric target1Price (1R partial/scale-out level), final targetPrice, and targetR (2 or 3) aligned with the risk distance.
- This is paper/research support, not financial certainty or an exchange order instruction.
`;

export const SPECIALIST_AGENTS = [
  { id: 'smc', name: 'SMC Structure Analyst', focus: 'Own the SMC strategy family only (including SMC16 HTF Trend Shield). Read confirmed swing structure, BOS/CHoCH, EQH/EQL pools, sweeps, inducement, displacement, OB, breaker and FVG from history. Filter out counter-trend setups.' },
  { id: 'ict', name: 'ICT Context Analyst', focus: 'Own the ICT strategy family only (including ICT18 Macro Alignment). Read confirmed dealing range/premium-discount/OTE, PDH/PDL/PWH/PWL raids, verified New York/London/Asia sessions and Silver Bullet windows from derivedContext, displacement, FVG/OB and PO3 sequence.' },
  { id: 'orderflow', name: 'Order Flow Analyst', focus: 'Own the Order Flow strategy family only (including OF19 Chop Avoidance & OF20 Liquidation Exhaustion). Analyze closed footprint rows, delta/CVD, sampled public trades, synchronized DOM and supplied profile. Assess imbalance, absorption hypotheses, POC/VA response, LVN/HVN, and participation.' }
] as const;