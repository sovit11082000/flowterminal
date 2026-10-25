/** Shared market-reading rules supplied to every specialist and the manager. */
export const ORDER_FLOW_SKILL = `
ORDER-FLOW RESEARCH PLAYBOOK

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

SMC STRUCTURE READ (SMC SPECIALIST)
- Review technicalContext.smc when present as a month-history map, then audit its recent claims against the supplied candle history. The map is a candidate annotation set, not unquestionable truth. Use only confirmed swing points and candle closes. A BOS is a close through the prior confirmed swing in the prevailing direction; CHoCH is a confirmed break against that direction. Do not label a wick-only breach as a break.
- Treat equal highs/lows as a liquidity pool only when at least two confirmed swing tests cluster within a tight tolerance and price reacts away between tests. A sweep requires a wick through the pool and a close back across it.
- Call an order block only when a prior opposing candle is followed by a confirmed displacement/break; call an FVG only for a three-candle gap. Mark them as zones of interest, never as guaranteed reversal points.

ICT READ (ICT SPECIALIST)
- Review technicalContext.ict when present as a month-history map, then audit the recent claims against supplied bars. Assess premium/discount only against an explicitly supplied confirmed dealing range. Read PDH/PDL, liquidity raids, displacement, and FVG/OB confluence only when supported by evidence.
- PO3 is a possible accumulation → manipulation → distribution sequence, not a clock-based certainty. State which phase is confirmed, which remains unconfirmed, and what price action would invalidate the interpretation.
- Do not invent session boundaries, news, higher-timeframe levels, or future confirmation. Historical labels must be knowable from bars up to their timestamp.

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
  { id: 'smc', name: 'SMC Structure Analyst', focus: 'Independently analyze the supplied 30-day SMC context and recent candle history: confirmed swing structure, BOS/CHoCH, equal highs/lows, liquidity sweeps, displacement, order blocks, and fair value gaps. Audit context markers against candles when possible. Separate confirmed past events from active unconfirmed zones; cite candle times and price levels.' },
  { id: 'ict', name: 'ICT Context Analyst', focus: 'Independently analyze the supplied 30-day ICT context and recent candle history: confirmed dealing range and premium/discount, prior-day levels, liquidity raids, displacement, FVG, and cautious PO3 sequence. Audit context against available bars. State what is confirmed versus pending; never invent sessions or future events.' },
  { id: 'orderflow', name: 'Order Flow Analyst', focus: 'Analyze only supplied closed footprints, row-level bid/ask, delta/CVD, public trade sample, synchronized DOM, and volume profile. Assess imbalance, absorption hypotheses, acceptance/rejection, and participation. Flag missing evidence; do not treat repeated delta measures as independent confirmation.' }
] as const;
