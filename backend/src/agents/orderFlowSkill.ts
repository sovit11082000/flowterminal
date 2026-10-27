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
  { id: 'OF18', family: 'orderflow', direction: 'SHORT', name: 'Book pull + failed break', rule: 'Synchronized book liquidity pulls as an upside break fails and price closes back below the level.' }
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
- The supplied snapshot is the entire evidence set. Never infer a missing candle, trade, footprint level, session, funding value, news item, or exchange fact.
- Check timestamps, interval, candle count, closed-bar status, feed status, and empty fields before interpreting direction. A forming bar is provisional; base confirmation on closed bars.
- If feedStatus is DESYNCHRONIZED, use fresh trades and candles only. Treat bids/asks as unavailable even if old rows are present. Do not infer a wall or DOM imbalance.
- Public-trade aggressor Buy is ask-side volume; aggressor Sell is bid-side volume. Delta = ask volume - bid volume. Positive delta alone is not bullish confirmation.
- A missing field is unknown, never zero. If fewer than four closed footprints or candles are supplied, report insufficient context and the manager must choose WAIT.

FOOTPRINT AND AUCTION READ
- Compare ask/bid volume on each price row. A 3:1 ratio is a candidate imbalance only when both sides are nonzero and the row has meaningful volume relative to that bar; isolated ratios on tiny volume are noise.
- A stacked imbalance requires at least three adjacent qualifying prices on the same side. State the direction, count, and nearby price area only when those rows are actually present.
- Relate bar delta and CVD direction to price progress, candle close, wick, and POC. Divergence is a warning to investigate, not a reversal call by itself.
- POC is the maximum traded-volume price in the supplied footprint. It is not the TPO/Market Profile POC. Do not call a partial/local capture a full-session profile.
- Acceptance needs repeated closes or sustained trade around a level; a single touch is not acceptance. Rejection needs an observed response away from a level.

TAPE, ABSORPTION, AND LIQUIDITY
- Describe only visible trades and their supplied side, size, price, and timestamp. The trade list may be sampled/truncated; do not claim it is the full tape or calculate full-session totals from it.
- Absorption is a hypothesis only when repeated aggressive executions occur at/through a price while price makes limited progress and the supplied footprint supports it. One large print is not absorption.
- Iceberg detection cannot be proven by this snapshot. Never label a hidden order as confirmed.
- DOM is a point-in-time view of displayed resting orders. Compare cumulative visible bid and ask depth only when both sides are present and synchronized. Orders can cancel; a wall is not guaranteed support/resistance and spoofing cannot be concluded from one snapshot.

SETUP AND RISK STANDARD
- Separate observation, interpretation, and uncertainty. Cite the exact supplied values behind every material claim.
- Seek confluence across independent evidence (price response, footprint/delta, tape, synchronized DOM, and profile context); repeated versions of the same delta signal are not independent votes.
- Explain the opposing case and the condition that invalidates the idea. Do not turn an analyst bias into an entry instruction.
- The manager must choose WAIT when data quality fails, evidence conflicts, context is thin, DOM is desynchronized, a risk boundary cannot be described, or there is no clear trigger.
- A directional plan requires unanimous LONG or SHORT specialist bias with strength at least 2 from all three specialists. Any neutral, dissent, or failed specialist forces WAIT.
- For directional plans, return a conditional POC/VA pullback trigger and numeric entry, structural stop, target, and targetR. targetR must be exactly 2 or 3, the target must be on the correct side and before the nearest supplied unswept opposing liquidity, and the numeric levels must match the stated R multiple. If the snapshot lacks the needed levels or profile context, choose WAIT and use null numeric levels.
- These levels are conditional paper-study prices derived only from the supplied snapshot; never claim certainty and never send an exchange order.
- This is research support, not a validated profitable strategy, financial certainty, or a broker instruction.
`;

export const SPECIALIST_AGENTS = [
  { id: 'smc', name: 'SMC Structure Analyst', focus: 'Own the SMC strategy family only. Read confirmed swing structure, BOS/CHoCH, EQH/EQL pools, sweeps, inducement, displacement, OB, breaker and FVG from the provided history. Audit annotations against candles; distinguish historical confirmation from active unfilled zones.' },
  { id: 'ict', name: 'ICT Context Analyst', focus: 'Own the ICT strategy family only. Read confirmed dealing range/premium-discount, PDH/PDL/PWH/PWL raids, verified sessions, displacement, FVG/OB and PO3 sequence. Timestamp/session data must be supplied; otherwise mark session strategies unavailable.' },
  { id: 'orderflow', name: 'Order Flow Analyst', focus: 'Own the Order Flow strategy family only. Analyze closed footprint rows, delta/CVD, sampled public trades, synchronized DOM and supplied profile. Assess imbalance, absorption hypotheses, POC/VA response, LVN/HVN, and participation; do not treat repeated delta measures as independent confirmation.' }
] as const;
