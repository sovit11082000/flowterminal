import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDerivedContext,
  buildOrderFlowMicrostructureSummary,
  cleanLesson,
  computeConsensus,
  detectSweepReclaim,
  evaluateGates,
  normalizeLessons,
  parseObject,
  resolveTradeLevels,
  runOrderFlowCouncil,
  sanitizePlan,
  sanitizeReport,
  type AgentSnapshot,
  type CouncilPlan,
  type SpecialistReport
} from '../src/agents/orderFlowCouncil.js';
import { SPECIALIST_AGENTS, strategyById, strategiesFor } from '../src/agents/orderFlowSkill.js';
import { computeMathReports, findPivots } from '../src/agents/mathSpecialists.js';
import { scenarioSnapshot, px } from './helpers/mathScenarios.js';

type Candle = AgentSnapshot['candles'][number];
type Footprint = AgentSnapshot['footprints'][number];

function makeCandles(count: number, direction: 'up' | 'down', start = 70000, step = 2): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = direction === 'up' ? start + i * step : start - i * step;
    const open = direction === 'up' ? close - step * 0.5 : close + step * 0.5;
    return { time: 1_800_000_000 + i * 60, open, high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close };
  });
}

function makeFootprints(candles: Candle[], opts: { volume?: number; lastVolume?: number; tight?: boolean; closed?: boolean } = {}): Footprint[] {
  const { volume = 100, lastVolume = volume, tight = false, closed = true } = opts;
  return candles.slice(-8).map((c, i, arr) => {
    const vol = i >= arr.length - 3 ? lastVolume : volume;
    return {
      time: c.time, open: c.open ?? c.close, high: tight ? c.close + 2 : c.high, low: tight ? c.close - 2 : c.low, close: c.close,
      totalVolume: vol, buyVolume: vol * 0.6, sellVolume: vol * 0.4, delta: vol * 0.2, cumulativeDelta: (i + 1) * 20,
      pocPrice: c.close, isClosed: closed,
      priceLevels: [
        { price: c.close - 1, bidVolume: 10, askVolume: 12, totalVolume: 22 },
        { price: c.close, bidVolume: 14, askVolume: 15, totalVolume: 29 },
        { price: c.close + 1, bidVolume: 9, askVolume: 11, totalVolume: 20 }
      ]
    };
  });
}

function makeSnapshot(direction: 'up' | 'down' = 'up', opts: Parameters<typeof makeFootprints>[1] = {}): AgentSnapshot {
  const candles = makeCandles(40, direction);
  const price = candles[candles.length - 1].close;
  const snapshot: AgentSnapshot = {
    symbol: 'BTCUSDT', timeframe: '1m', feedStatus: 'LIVE', lastTradeAt: Date.now(), latestPrice: price,
    candles, footprints: makeFootprints(candles, opts),
    trades: [{ timestamp: Date.now(), side: 'Buy', price, size: 1.5 }, { timestamp: Date.now(), side: 'Sell', price, size: 0.5 }],
    bids: [[price - 0.5, 4], [price - 1, 3]], asks: [[price + 0.5, 2], [price + 1, 2]]
  };
  snapshot.derivedContext = buildDerivedContext(snapshot);
  return snapshot;
}

function report(agentId: 'smc' | 'ict' | 'orderflow', bias: SpecialistReport['bias'], strength: number, strategyCandidates: string[] = []): SpecialistReport {
  const agent = SPECIALIST_AGENTS.find((a) => a.id === agentId)!;
  return { agentId, name: agent.name, bias, strength, findings: [`${agentId} finding`], strategyCandidates, concerns: [], missingData: [] };
}

function plan(overrides: Partial<CouncilPlan> = {}): CouncilPlan {
  return {
    decision: 'LONG', summary: 'Clean long after sweep.', reasons: ['reason a', 'reason b'], entryTrigger: 'retest', entryPrice: null,
    invalidation: 'below swing', stopPrice: null, target1Price: null, targetPrice: null, targetR: null, exitPlan: 'partials',
    agreeingAgents: [], dissent: [], strategyIds: ['SMC01'], strategyNames: [], ...overrides
  };
}

describe('catalog', () => {
  it('OF09/OF10 exhaustion directions are consistent with their rules', () => {
    expect(strategyById('OF09')?.direction).toBe('SHORT');
    expect(strategyById('OF10')?.direction).toBe('LONG');
  });
});

describe('computeConsensus', () => {
  it('requires 2 aligned specialists, one at strength >= 2', () => {
    expect(computeConsensus([report('smc', 'LONG', 2), report('ict', 'LONG', 1), report('orderflow', 'NEUTRAL', 0)]).bias).toBe('LONG');
    expect(computeConsensus([report('smc', 'SHORT', 3), report('ict', 'NEUTRAL', 0), report('orderflow', 'SHORT', 1)]).bias).toBe('SHORT');
  });
  it('rejects a lone specialist, weak agreement and strong opposition', () => {
    expect(computeConsensus([report('smc', 'LONG', 3), report('ict', 'NEUTRAL', 0), report('orderflow', 'NEUTRAL', 0)]).bias).toBeNull();
    expect(computeConsensus([report('smc', 'LONG', 1), report('ict', 'LONG', 1), report('orderflow', 'NEUTRAL', 0)]).bias).toBeNull();
    expect(computeConsensus([report('smc', 'LONG', 2), report('ict', 'LONG', 1), report('orderflow', 'SHORT', 2)]).bias).toBeNull();
  });
});

describe('sanitizeReport', () => {
  const smc = SPECIALIST_AGENTS[0];
  const orderflow = SPECIALIST_AGENTS[2];
  it('keeps bias and strength consistent', () => {
    expect(sanitizeReport(report('smc', 'LONG', 0), smc)).toMatchObject({ bias: 'NEUTRAL', strength: 0 });
    expect(sanitizeReport(report('smc', 'NEUTRAL', 3), smc)).toMatchObject({ bias: 'NEUTRAL', strength: 0 });
    expect(sanitizeReport(report('smc', 'LONG', 9), smc).strength).toBe(3);
  });
  it('filters strategy ids by family and direction', () => {
    expect(sanitizeReport(report('orderflow', 'SHORT', 2, ['OF09', 'OF10', 'SMC01']), orderflow).strategyCandidates).toEqual(['OF09']);
    expect(strategiesFor('orderflow').length).toBeGreaterThan(10);
  });
});

describe('resolveTradeLevels', () => {
  const snap = makeSnapshot('up');
  const price = snap.latestPrice as number;
  it('accepts a coherent long and reports the true R', () => {
    const r = resolveTradeLevels('LONG', snap, { entry: price, stop: price - 60, target: price + 150 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetR).toBe(2.5);
      expect(r.target1Price).toBe(price + 60);
    }
  });
  it('ignores a target on the wrong side and falls back to the draw on liquidity', () => {
    const far = makeSnapshot('up');
    far.derivedContext!.drawOnLiquidity.nextBullishTarget = price + 300;
    const r = resolveTradeLevels('LONG', far, { entry: price, stop: price - 60, target: price - 200 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetPrice).toBe(price + 300);
      expect(r.targetR).toBe(5);
    }
  });
  it('rejects the trade when the next liquidity is too close to pay for the risk', () => {
    const r = resolveTradeLevels('LONG', snap, { entry: price, stop: price - 60, target: null }); // DOL is only a few points away
    expect(r.ok).toBe(false);
  });
  it('rejects setups with too little reward-to-risk', () => {
    const r = resolveTradeLevels('LONG', snap, { entry: price, stop: price - 100, target: price + 120 });
    expect(r.ok).toBe(false);
  });
  it('rejects stops that are too wide for the timeframe', () => {
    const r = resolveTradeLevels('LONG', snap, { entry: price, stop: price - 1000, target: price + 3000 });
    expect(r.ok).toBe(false);
  });
  it('snaps an entry that drifted far from price and fixes a wrong-side stop', () => {
    const r = resolveTradeLevels('SHORT', snap, { entry: price * 1.02, stop: price - 50, target: price - 400 });
    if (r.ok) {
      expect(r.entryPrice).toBe(price);
      expect(r.stopPrice).toBeGreaterThan(price);
    } else {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
  it('caps absurd targets at the configured max R', () => {
    const r = resolveTradeLevels('LONG', snap, { entry: price, stop: price - 60, target: price + 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetR).toBe(6);
  });
});

describe('gates', () => {
  it('blocks every direction in chop compression', () => {
    const candles = makeCandles(40, 'up', 70000, 0.2);
    const snapshot: AgentSnapshot = { ...makeSnapshot('up'), candles, footprints: makeFootprints(candles, { volume: 100, lastVolume: 10, tight: true }) };
    snapshot.derivedContext = buildDerivedContext(snapshot);
    expect(snapshot.derivedContext.marketRegime).toBe('CHOP_COMPRESSION');
    expect(evaluateGates(snapshot).blocked).toMatch(/CHOP/);
  });
  it('blocks counter-trend trades without sweep + reclaim', () => {
    const gates = evaluateGates(makeSnapshot('down'));
    expect(gates.permitted).toEqual(['SHORT']);
    expect(gates.denied.LONG).toMatch(/BEARISH/);
  });
  it('uses supplied daily ranges: a PDL sweep + reclaim unlocks a counter-trend long', () => {
    const snapshot = makeSnapshot('down');
    const lowestRecent = Math.min(...snapshot.candles.slice(-10).map((c) => c.low));
    const price = snapshot.latestPrice as number;
    // PDL sits just below the latest close but above the recent lows: swept earlier, reclaimed by the last close.
    const pdl = (lowestRecent + price) / 2 > lowestRecent ? lowestRecent + (price - lowestRecent) / 2 : price - 1;
    snapshot.technicalContext = {
      smc: { bias: 'UNAVAILABLE', events: [], zones: [], liquidity: [] },
      ict: { po3: [], dailyRanges: [{ day: 1, high: price + 500, low: pdl - 400 }, { day: 2, high: price + 400, low: pdl }, { day: 3, high: price + 100, low: price - 100 }] }
    };
    snapshot.derivedContext = buildDerivedContext(snapshot);
    expect(snapshot.derivedContext.pdl).toBe(pdl);
    expect(snapshot.derivedContext.sweepReclaim?.long).toBe(true);
    expect(evaluateGates(snapshot).permitted).toContain('LONG');
  });
  it('reports insufficient context when fewer than 4 closed footprints exist', () => {
    const snapshot = makeSnapshot('up');
    snapshot.footprints = snapshot.footprints.slice(0, 3);
    expect(evaluateGates(snapshot).blocked).toMatch(/Insufficient/);
  });
  it('detectSweepReclaim needs both the wick through the level and a reclaim close', () => {
    const candles: Candle[] = [
      { time: 1, open: 100, high: 101, low: 99, close: 100 },
      { time: 2, open: 100, high: 100, low: 94, close: 95 },
      { time: 3, open: 95, high: 99, low: 94, close: 98 }
    ];
    expect(detectSweepReclaim(candles, { pdh: null, pdl: 96, pwh: null, pwl: null }).long).toBe(true);
    expect(detectSweepReclaim(candles, { pdh: null, pdl: 99, pwh: null, pwl: null }).long).toBe(false);
  });
});

describe('sanitizePlan', () => {
  const longReports = [report('smc', 'LONG', 3, ['SMC01']), report('ict', 'LONG', 1), report('orderflow', 'NEUTRAL', 0)];

  it('does not veto a valid trade just because the summary says "rejection" or "compression"', () => {
    const snap = makeSnapshot('up');
    const price = snap.latestPrice as number;
    const p = sanitizePlan(
      plan({ summary: 'Rejection of the lows after compression, absorption confirmed.', entryPrice: price, stopPrice: price - 60, targetPrice: price + 150 }),
      longReports, snap
    );
    expect(p.decision).toBe('LONG');
    expect(p.entryPrice).not.toBeNull();
    expect(p.targetR).toBeGreaterThanOrEqual(1.5);
    expect(p.stopPrice as number).toBeLessThan(p.entryPrice as number);
  });
  it('respects an explicit WAIT-style manager summary', () => {
    const p = sanitizePlan(plan({ summary: 'WAIT: choppy tape.' }), longReports, makeSnapshot('up'));
    expect(p.decision).toBe('WAIT');
  });
  it('forces WAIT against the HTF trend', () => {
    const p = sanitizePlan(plan(), longReports, makeSnapshot('down'));
    expect(p.decision).toBe('WAIT');
    expect(p.summary).toMatch(/BEARISH/);
  });
  it('forces WAIT when the manager contradicts the consensus', () => {
    const p = sanitizePlan(plan({ decision: 'SHORT' }), longReports, makeSnapshot('up'));
    expect(p.decision).toBe('WAIT');
  });
  it('turns a plan with no room to target into WAIT', () => {
    const snap = makeSnapshot('up');
    const price = snap.latestPrice as number;
    const p = sanitizePlan(plan({ entryPrice: price, stopPrice: price - 100, targetPrice: price + 110 }), longReports, snap);
    expect(p.decision).toBe('WAIT');
    expect(p.summary).toMatch(/Reward-to-risk/);
  });
});

describe('order flow microstructure', () => {
  it('does not crash when no bar is closed yet', () => {
    const snap = makeSnapshot('up', { closed: false });
    expect(() => buildOrderFlowMicrostructureSummary(snap)).not.toThrow();
  });
  it('only reports stacked imbalances for 3+ adjacent rows', () => {
    const snap = makeSnapshot('up');
    const last = snap.footprints[snap.footprints.length - 1];
    const base = last.close;
    last.priceLevels = [
      { price: base, bidVolume: 1, askVolume: 9, totalVolume: 10 },
      { price: base + 1, bidVolume: 1, askVolume: 9, totalVolume: 10 },
      { price: base + 2, bidVolume: 1, askVolume: 9, totalVolume: 10 },
      { price: base + 5, bidVolume: 1, askVolume: 9, totalVolume: 10 }
    ];
    const micro = buildOrderFlowMicrostructureSummary(snap)!;
    expect(micro.stackedBuyImbalances).toEqual([base, base + 1, base + 2]);
    expect(micro.buyImbalanceLevels).toContain(base + 5);
  });
});

describe('helpers', () => {
  it('normalizeLessons dedupes, trims and caps', () => {
    const many = Array.from({ length: 20 }, (_, i) => `rule ${i}`);
    const out = normalizeLessons([...many, 'Rule 3', '  ', 'x'.repeat(500)], 6);
    expect(out.length).toBe(6);
    expect(out.every((l) => l.length <= 220)).toBe(true);
    expect(new Set(out.map((l) => l.toLowerCase())).size).toBe(out.length);
  });
  it('parseObject tolerates fences and surrounding prose', () => {
    expect(parseObject<{ a: number }>('```json\n{"a":1}\n```').a).toBe(1);
    expect(parseObject<{ a: number }>('Here you go: {"a":2} Hope it helps').a).toBe(2);
    expect(() => parseObject('no json here')).toThrow();
  });
  it('cleanLesson strips hard-coded prices and quotes', () => {
    expect(cleanLesson('"Avoid long at 77,551.6 when HTF bearish"')).toBe('Avoid long at the level when HTF bearish');
  });
});

describe('math specialists', () => {
  it('bullish scenario: SMC, ICT and Order Flow all lean long and cite real numbers', () => {
    const snap = scenarioSnapshot('LONG');
    const reports = computeMathReports(snap, snap.derivedContext!);
    const [smc, ict, flow] = reports;
    expect(smc.bias).toBe('LONG');
    expect(smc.strength).toBeGreaterThanOrEqual(2);
    expect(smc.findings.join(' ')).toContain(String(px(98)));        // the swept swing low
    expect(smc.findings.join(' ')).toMatch(/displacement/i);
    expect(ict.bias).toBe('LONG');
    expect(ict.findings.join(' ')).toContain(`PDL ${px(98)}`);        // names the level that was really raided
    expect(ict.strength).toBeLessThanOrEqual(1);                      // long from premium is capped
    expect(ict.concerns.join(' ')).toMatch(/PREMIUM/);
    expect(flow.bias).toBe('LONG');
    expect(flow.strength).toBeGreaterThanOrEqual(2);
    expect(flow.strategyCandidates).toContain('OF07');
    expect(computeConsensus(reports.map((r, i) => sanitizeReport(r, SPECIALIST_AGENTS[i]))).bias).toBe('LONG');
  });

  it('bearish scenario is the exact mirror', () => {
    const snap = scenarioSnapshot('SHORT');
    const reports = computeMathReports(snap, snap.derivedContext!);
    expect(reports.map((r) => r.bias)).toEqual(['SHORT', 'SHORT', 'SHORT']);
    expect(computeConsensus(reports).bias).toBe('SHORT');
  });

  it('stays out when there is no sweep, structure break or displacement', () => {
    const snap = makeSnapshot('up');
    const reports = computeMathReports(snap, snap.derivedContext!);
    expect(computeConsensus(reports).bias).toBeNull();
  });

  it('caps a signal that fights the 15m trend unless a sweep-and-reclaim backs it', () => {
    const snap = scenarioSnapshot('LONG', false);
    const derived = { ...snap.derivedContext!, htfTrend: 'BEARISH' as const, sweepReclaim: { long: false, short: false, levels: [] } };
    const smc = computeMathReports(snap, derived)[0];
    expect(smc.strength).toBeLessThanOrEqual(1);
    expect(smc.concerns.join(' ')).toMatch(/against the 15m BEARISH trend/);
  });

  it('goes neutral in chop and reports missing data instead of guessing', () => {
    const snap = scenarioSnapshot('LONG');
    const chop = computeMathReports(snap, { ...snap.derivedContext!, marketRegime: 'CHOP_COMPRESSION' });
    expect(chop.every((r) => r.bias === 'NEUTRAL' && r.strength === 0)).toBe(true);
    const short = { ...snap, candles: snap.candles.slice(0, 5), footprints: snap.footprints.slice(0, 2) };
    const thin = computeMathReports(short, snap.derivedContext!);
    expect(thin.every((r) => r.bias === 'NEUTRAL')).toBe(true);
    expect(thin[0].missingData.join(' ')).toMatch(/candles/);
    expect(thin[2].missingData.join(' ')).toMatch(/footprints/);
  });

  it('ignores a pivot that price already traded through before the sweep', () => {
    const snap = scenarioSnapshot('LONG', false);
    // The older pivot low near px(99.5) was already broken by the slide to 98.0, so only the intact 98.0 low can be "swept".
    const smc = computeMathReports(snap, snap.derivedContext!)[0];
    expect(smc.findings.join(' ')).not.toContain(String(px(99.5)));
  });

  it('findPivots only returns confirmed swing points', () => {
    const { highs, lows } = findPivots(scenarioSnapshot('LONG').candles, 2);
    expect(highs.some((p) => p.price === px(100.6))).toBe(true);
    expect(lows.some((p) => p.price === px(98.0))).toBe(true);
    expect(highs.every((p) => p.index <= 37) && lows.every((p) => p.index <= 37)).toBe(true);
  });
});

describe('runOrderFlowCouncil (math specialists + one Groq manager)', () => {
  const calls: Array<{ body: any }> = [];
  let managerReply: unknown;

  beforeEach(() => {
    calls.length = 0;
    delete process.env.COUNCIL_MANAGER;
    process.env.GROQ_MANAGER_API_KEY = `gsk_mgr_${Math.random()}`;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(managerReply) }, finish_reason: 'stop' }], usage: { total_tokens: 321 } }), { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.COUNCIL_MANAGER; });

  it('makes no LLM call when the specialists find no consensus', async () => {
    const result = await runOrderFlowCouncil(makeSnapshot('up'));
    expect(calls.length).toBe(0);
    expect(result.plan.decision).toBe('WAIT');
    expect(result.model).toContain('math:smc+ict+orderflow');
    expect(result.diagnostics?.llmCalls).toBe(0);
  });

  it('makes no LLM call when a hard gate forces WAIT (chop)', async () => {
    const candles = makeCandles(40, 'up', 70000, 0.2);
    const snapshot: AgentSnapshot = { ...makeSnapshot('up'), candles, footprints: makeFootprints(candles, { volume: 100, lastVolume: 10, tight: true }) };
    const result = await runOrderFlowCouncil(snapshot);
    expect(calls.length).toBe(0);
    expect(result.plan.decision).toBe('WAIT');
    expect(result.diagnostics?.gateBlocked).toMatch(/CHOP/);
  });

  it('calls the manager exactly once on a qualifying consensus and validates the levels it returns', async () => {
    const snap = scenarioSnapshot('LONG');
    const price = snap.latestPrice as number;
    managerReply = plan({ entryPrice: price, stopPrice: price - 80, targetPrice: price + 220, strategyIds: ['OF07'], summary: 'Long after sweep, rejection confirmed.' });
    const result = await runOrderFlowCouncil(snap);

    expect(calls.length).toBe(1);
    const system: string = calls[0].body.messages[0].content;
    expect(system).toContain('TRADE PLAN MANAGER');
    expect(system).toContain('rule-based');
    expect(calls[0].body.reasoning_effort).toBe('medium');
    const payload = JSON.parse(String(calls[0].body.messages[1].content).replace(/^MARKET_DATA:\n/, ''));
    expect(payload.reports.map((r: { name: string }) => r.name)).toHaveLength(3);
    expect(payload.reports[0].findings.length).toBeGreaterThan(0);

    expect(result.plan.decision).toBe('LONG');
    expect(result.plan.stopPrice as number).toBeLessThan(price);
    expect(result.plan.targetR as number).toBeGreaterThanOrEqual(1.5);
    expect(result.plan.strategyNames).toContain('Stacked ask imbalance');
    expect(result.model).toContain('math:smc+ict+orderflow');
    expect(result.model).toContain('manager:groq/');
    expect(result.diagnostics).toMatchObject({ llmCalls: 1, totalTokens: 321 });
  });

  it('lets the manager veto a qualifying consensus', async () => {
    managerReply = plan({ decision: 'WAIT', summary: 'WAIT: price is stretched after the displacement.' });
    const result = await runOrderFlowCouncil(scenarioSnapshot('LONG'));
    expect(calls.length).toBe(1);
    expect(result.plan.decision).toBe('WAIT');
  });

  it('math-only mode (COUNCIL_MANAGER=off) needs no key, makes no request and refuses a stretched entry', async () => {
    delete process.env.GROQ_MANAGER_API_KEY;
    process.env.COUNCIL_MANAGER = 'off';
    const result = await runOrderFlowCouncil(scenarioSnapshot('LONG'));
    expect(calls.length).toBe(0);
    expect(result.model).toContain('manager:math');
    // Price already ran 138 points off the sweep and the next liquidity (PDH) is only 108 away vs a 278 stop: reward-to-risk 0.39R.
    expect(result.plan.decision).toBe('WAIT');
    expect(result.plan.summary).toMatch(/Reward-to-risk 0\.\d+R/);
  });

  it('math-only mode returns a fully validated plan when the next liquidity is far enough away', async () => {
    delete process.env.GROQ_MANAGER_API_KEY;
    process.env.COUNCIL_MANAGER = 'off';
    const snap = scenarioSnapshot('LONG');
    snap.technicalContext!.ict.dailyRanges[1].high = px(112); // prior-day high far above price
    const result = await runOrderFlowCouncil(snap);
    const p = result.plan;
    expect(calls.length).toBe(0);
    expect(p.decision).toBe('LONG');
    expect(p.entryPrice).toBe(snap.latestPrice);
    expect(p.stopPrice as number).toBeLessThan(p.entryPrice as number);
    expect(p.targetPrice as number).toBeGreaterThan(p.entryPrice as number);
    const rr = ((p.targetPrice as number) - (p.entryPrice as number)) / ((p.entryPrice as number) - (p.stopPrice as number));
    expect(rr).toBeGreaterThanOrEqual(1.5);
    expect(Math.abs(rr - (p.targetR as number))).toBeLessThan(0.02); // reported R is the real R
    expect(p.agreeingAgents.length).toBe(3);
    expect(p.reasons.length).toBeGreaterThan(0);
    expect(p.strategyIds.length).toBeGreaterThan(0);
  });

  it('asks for a manager key instead of silently doing nothing', async () => {
    delete process.env.GROQ_MANAGER_API_KEY;
    await expect(runOrderFlowCouncil(scenarioSnapshot('LONG'))).rejects.toThrow(/No Groq provider configured/);
  });
});

describe('manager key failures', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const plansWait = plan({ decision: 'WAIT', summary: 'WAIT: test.' });

  it('pauses a manager key that returns 401 so later runs do not retry it first', async () => {
    const badKey = `gsk_bad_${Math.random()}`;
    const goodKey = `gsk_good_${Math.random()}`;
    process.env.GROQ_MANAGER_API_KEY = `${badKey},${goodKey}`;
    let badKeyCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      if (init.headers.Authorization === `Bearer ${badKey}`) {
        badKeyCalls += 1;
        return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plansWait) }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }), { status: 200 });
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOrderFlowCouncil(scenarioSnapshot('LONG'));
    await runOrderFlowCouncil(scenarioSnapshot('LONG'));
    await runOrderFlowCouncil(scenarioSnapshot('LONG'));
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(badKeyCalls).toBe(1);
    expect(logged).toContain('Invalid API Key');
  });

  it('stops calling Groq after "Organization has been restricted" and then fails fast', async () => {
    process.env.GROQ_MANAGER_API_KEY = `gsk_r1_${Math.random()},gsk_r2_${Math.random()}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Organization has been restricted. Please reach out to support' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];

    await expect(runOrderFlowCouncil(scenarioSnapshot('LONG'))).rejects.toThrow(/restricted/);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // both manager keys tried once
    const started = Date.now();
    await expect(runOrderFlowCouncil(scenarioSnapshot('LONG'))).rejects.toThrow(/paused/);
    const elapsed = Date.now() - started;
    quiet.forEach((spy) => spy.mockRestore());

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no further requests while paused
    expect(elapsed).toBeLessThan(1000);
  });
});
