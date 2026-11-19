import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { runOrderFlowCouncil, analyzeTradeOutcomeWithAI, type AgentSnapshot } from './src/agents/orderFlowCouncil.js';
import { sendTradeEntryAlert, sendTradeOutcomeAlert } from './src/services/telegramService.js';

function loadProjectEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '.env'),
    resolve(process.cwd(), 'backend', '.env')
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)$/);
        if (!match) continue;
        const key = match[1];
        let val = match[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore
    }
  }
}
loadProjectEnv();

interface ReplayBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeDelta: number;
  pocPrice: number;
  pocVolume?: number;
  priceLevels: Array<{ price: number; bidVolume: number; askVolume: number; totalVolume: number }>;
  isClosed: boolean;
}

interface SimulatedTrade {
  timeStr: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  targetR: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  pnlR: number;
  barsHeld: number;
  summary: string;
  lessonLearned?: string;
}

// Pacing exists only for Groq rate limits; math-only mode (COUNCIL_MANAGER=off) makes no API calls, so skip it.
const sleep = (ms: number) => (process.env.COUNCIL_MANAGER?.trim().toLowerCase() === 'off' ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

async function loadBars(): Promise<{ symbol: string; bars: ReplayBar[]; source: string }> {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/';
  const dbName = process.env.MONGODB_DATABASE || 'flowterminal';
  const symbol = process.env.DEFAULT_SYMBOL || 'BTCUSDT';

  console.log(`[Replay Engine] Connecting to Local MongoDB at ${mongoUri}${dbName}...`);
  try {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(dbName);

    const docs = await db.collection('footprints')
      .find({ symbol, timeframe: '1m' })
      .sort({ time: 1 })
      .toArray();

    await client.close();

    if (docs.length >= 15) {
      console.log(`✅ Loaded ${docs.length.toLocaleString()} 1-minute footprint bars directly from Local MongoDB!`);
      return { symbol, bars: docs as unknown as ReplayBar[], source: `Local MongoDB (${dbName})` };
    }
    console.log(`[Replay Engine] Local MongoDB has only ${docs.length} bars; falling back to replay.json...`);
  } catch (err) {
    console.warn(`[Replay Engine] Local MongoDB read warning:`, err instanceof Error ? err.message : err);
  }

  // Fallback to replay.json if DB unavailable
  const cliPath = process.argv[2]?.trim();
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const fileCandidates = [
    cliPath && !cliPath.startsWith('--') ? resolve(process.cwd(), cliPath) : '',
    resolve(process.cwd(), 'replay.json'),
    resolve(process.cwd(), '..', 'replay.json'),
    resolve(process.cwd(), 'data', 'replay.json'),
    resolve(userHome, 'Downloads', 'replay.json'),
    resolve(userHome, 'Desktop', 'replay.json'),
    resolve(userHome, 'OneDrive', 'Desktop', 'replay.json'),
    resolve(userHome, 'OneDrive', 'Desktop', 'Claude Access', 'flowterminal', 'replay.json'),
    resolve(userHome, 'OneDrive', 'Desktop', 'Claude Access', 'flowterminal', 'backend', 'replay.json')
  ].filter(Boolean);

  const replayPath = fileCandidates.find((c) => existsSync(c));
  if (!replayPath) {
    throw new Error('Neither Local MongoDB bars nor replay.json were found.');
  }

  const rawData = JSON.parse(readFileSync(replayPath, 'utf8'));
  const rawBars: ReplayBar[] = rawData.bars || [];
  return { symbol: rawData.symbol || symbol, bars: rawBars, source: replayPath };
}

async function runReplayBacktest() {
  console.log('================================================================');
  console.log('   FLOWTERMINAL AI COUNCIL: LOCAL DB REPLAY BACKTEST           ');
  console.log('================================================================\n');

  const { symbol, bars: rawBars, source } = await loadBars();

  if (rawBars.length < 15) {
    console.error('[Replay Engine] Need at least 15 bars for backtesting.');
    process.exit(1);
  }

  console.log(`[Replay Engine] Source: ${source}`);
  console.log(`[Replay Engine] Total Bars: ${rawBars.length.toLocaleString()} for ${symbol}`);
  console.log(`[Rate Limiting Policy]: 20s spacing between AI calls to completely protect Groq RPM.\n`);

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/';
  const dbName = process.env.MONGODB_DATABASE || 'flowterminal';
  const isFreshBlindRun = process.argv.includes('--fresh');
  const learnedLessons: string[] = [];

  // Ingest existing learned rules from local MongoDB (skip if --fresh blind out-of-sample test)
  if (!isFreshBlindRun) {
    try {
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const [lossRules, winRules] = await Promise.all([
      client.db(dbName).collection('learned_rules').find({ outcome: 'LOSS' }).sort({ createdAt: -1 }).limit(4).toArray(),
      client.db(dbName).collection('learned_rules').find({ outcome: 'WIN' }).sort({ createdAt: -1 }).limit(4).toArray()
    ]);
    await client.close();

    for (const r of winRules) {
      if (r.lesson) learnedLessons.push(`[PROVEN WINNER] ${String(r.lesson)}`);
    }
    for (const r of lossRules) {
      if (r.lesson) learnedLessons.push(`[AVOID LOSS] ${String(r.lesson)}`);
    }
    if (learnedLessons.length > 0) {
      console.log(`🧠 Injected ${learnedLessons.length} historical rules from MongoDB into AI memory.\n`);
    }
  } catch {
    // Continue if DB rule read is silent
  }
  } else {
    console.log(`🧪 [Blind Out-of-Sample Mode]: Starting with ZERO prior rules (100% unseen market test).\n`);
  }

  const trades: SimulatedTrade[] = [];
  let lastTradeEntryPrice = 0;
  let lastTradeBarIndex = -999;

  // Start from a random slice of the DB history (unless --start=20 is passed) so every run tests fresh market conditions
  const startArg = process.argv.find((a) => a.startsWith('--start='));
  const maxStart = Math.max(20, rawBars.length - 600);
  let i = startArg ? Math.max(20, Number(startArg.split('=')[1]) || 20) : (20 + Math.floor(Math.random() * maxStart));
  console.log(`⚡ [Speed Engine] Starting blind scan from Bar ${i}/${rawBars.length} (Diverse Market Window)...\n`);

  while (i < rawBars.length - 8) {
    const historicalBars = rawBars.slice(0, i + 1);
    const currentBar = rawBars[i];

    // Prevent taking the exact same trade/price zone twice within 45 bars
    const isSamePriceZone = lastTradeEntryPrice > 0 &&
      (i - lastTradeBarIndex) < 45 &&
      Math.abs(currentBar.close - lastTradeEntryPrice) / lastTradeEntryPrice < 0.003;
    if (isSamePriceZone) { i += 3; continue; }

    // High-Resolution Sniper Trigger (Expanded for rich trade discovery)
    const recent15 = historicalBars.slice(-15);
    const avgVol = recent15.reduce((s, b) => s + b.totalVolume, 0) / recent15.length;

    const highest15 = Math.max(...recent15.slice(0, -1).map((b) => b.high));
    const lowest15 = Math.min(...recent15.slice(0, -1).map((b) => b.low));

    // Thoda dynamic banaya taaki FVG retests aur absorption bars bhi scan ho sakein
    const isHighSweep = currentBar.high >= highest15 * 0.9998 && currentBar.close < currentBar.open;
    const isLowSweep = currentBar.low <= lowest15 * 1.0002 && currentBar.close > currentBar.open;
    const isDeltaImpulse = Math.abs(currentBar.delta) >= avgVol * 0.20;
    const isVolumeExpansion = currentBar.totalVolume >= avgVol * 1.1;

    // Har valid liquidity / volume candle ko evaluate karega
    if (!isHighSweep && !isLowSweep && !isDeltaImpulse && !isVolumeExpansion) {
      i += 1;
      continue;
    }

    const recentCandles = historicalBars.slice(-270).map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close
    }));

    // Realistic OrderBook reconstruction from current price levels
    const sortedLevels = [...(currentBar.priceLevels || [])].sort((a, b) => b.price - a.price);
    const bids: Array<[number, number]> = sortedLevels
      .filter((lvl) => lvl.price <= currentBar.close)
      .slice(0, 5)
      .map((lvl) => [lvl.price, lvl.bidVolume || 1.0]);
    const asks: Array<[number, number]> = sortedLevels
      .filter((lvl) => lvl.price >= currentBar.close)
      .slice(-5)
      .map((lvl) => [lvl.price, lvl.askVolume || 1.0]);

    if (!bids.length) bids.push([currentBar.close - 0.5, 1.2]);
    if (!asks.length) asks.push([currentBar.close + 0.5, 1.2]);

    const snapshot: AgentSnapshot = {
      symbol,
      timeframe: '1m',
      feedStatus: 'LIVE',
      lastTradeAt: Date.now(),
      latestPrice: currentBar.close,
      profile: {
        poc: currentBar.pocPrice,
        vah: Math.max(...historicalBars.slice(-20).map((b) => b.high)),
        val: Math.min(...historicalBars.slice(-20).map((b) => b.low)),
        capturedBars: 20
      },
      candles: recentCandles,
      footprints: historicalBars.slice(-60),
      trades: [
        { timestamp: currentBar.time * 1000 - 15000, side: currentBar.delta >= 0 ? 'Buy' : 'Sell', price: currentBar.pocPrice, size: Number((currentBar.totalVolume * 0.35).toFixed(3)) || 1.0 },
        { timestamp: currentBar.time * 1000 - 2000, side: currentBar.close >= currentBar.open ? 'Buy' : 'Sell', price: currentBar.close, size: Number((currentBar.totalVolume * 0.20).toFixed(3)) || 0.5 }
      ],
      bids,
      asks,
      paperPerformance: {
        resolved: trades.filter((t) => t.outcome !== 'OPEN').length,
        wins: trades.filter((t) => t.outcome === 'WIN').length,
        losses: trades.filter((t) => t.outcome === 'LOSS').length,
        expired: 0,
        winRate: trades.length ? Number((trades.filter((t) => t.outcome === 'WIN').length / trades.length * 100).toFixed(1)) : null,
        averageR: trades.length ? Number((trades.reduce((s, t) => s + t.pnlR, 0) / trades.length).toFixed(2)) : null,
        recent: trades.slice(-5).map((t) => ({ side: t.side, outcome: t.outcome as 'WIN' | 'LOSS', pnlR: t.pnlR })),
        learnedLessons: [...learnedLessons]
      }
    };

    const timeSec = currentBar.time > 1e11 ? Math.floor(currentBar.time / 1000) : currentBar.time;
    const timeStr = new Date(timeSec * 1000).toLocaleTimeString('en-IN');
    const triggerType = isHighSweep ? '🔥 [High Sweep Rejection]' : isLowSweep ? '💎 [Low Sweep Rejection]' : '⚡ [Delta Spike]';
    process.stdout.write(`\n🎯 [Event Detected at Bar ${i}/${rawBars.length}] ${timeStr} | $${currentBar.close} | ${triggerType}\n   AI Council Deliberating... `);

    // =========================================================================
    // 20-SECOND PACING DELAY BEFORE API CALL
    // =========================================================================
    await sleep(20_000);

    try {
      const councilResult = await runOrderFlowCouncil(snapshot);
      const plan = councilResult.plan;

      if (plan.decision === 'WAIT') {
        console.log(`[WAIT] -> ${plan.summary.slice(0, 60)}...`);
        // Step forward 3 bars so we do not evaluate the exact same local micro-price
        i += 3;
        continue;
      }

      console.log(`\n\n🚨 [ACTIVE TRADE TRIGGERED]: ${plan.decision} @ $${plan.entryPrice}`);
      console.log(`   Summary: ${plan.summary}`);
      console.log(`   SL: $${plan.stopPrice} | TP: $${plan.targetPrice} (${plan.targetR}R)`);
      console.log(`   Reasons: ${plan.reasons.slice(0, 2).join(' | ')}`);
      console.log(`   Strategies: ${plan.strategyNames?.join(' + ') || 'N/A'}`);

      // Dispatch Telegram Entry Alert
      void sendTradeEntryAlert({
        symbol,
        decision: plan.decision,
        entryPrice: plan.entryPrice!,
        stopPrice: plan.stopPrice!,
        targetPrice: plan.targetPrice!,
        targetR: plan.targetR || 2,
        reasons: plan.reasons,
        strategies: plan.strategyNames || [],
        summary: plan.summary
      }).catch((e) => console.warn('[Telegram Error]:', e instanceof Error ? e.message : e));

      // Forward outcome evaluation: Allow up to 60 bars (1 hour) with Breakeven Trail
      const MAX_HOLD_BARS = 60;
      const forwardBars = rawBars.slice(i + 1, Math.min(i + 1 + MAX_HOLD_BARS, rawBars.length));
      let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
      let exitPrice = currentBar.close;
      let barsHeld = 0;
      let currentStop = plan.stopPrice!;
      const risk = Math.max(Math.abs(plan.entryPrice! - plan.stopPrice!), 0.5);

      for (let j = 0; j < forwardBars.length; j++) {
        const fb = forwardBars[j];
        barsHeld = j + 1;

        if (plan.decision === 'LONG') {
          // +1.25R Hit: Lock partial profit & move SL to entry
          if (fb.high >= plan.entryPrice! + risk * 1.25 && currentStop < plan.entryPrice!) {
            currentStop = plan.entryPrice!;
          }

          if (fb.low <= currentStop) {
            outcome = currentStop === plan.entryPrice! ? 'OPEN' : 'LOSS';
            exitPrice = currentStop;
            break;
          }
          if (fb.high >= plan.targetPrice!) {
            outcome = 'WIN';
            exitPrice = plan.targetPrice!;
            break;
          }
        } else {
          // Short Side: +1.25R Hit lock & move SL to entry
          if (fb.low <= plan.entryPrice! - risk * 1.25 && currentStop > plan.entryPrice!) {
            currentStop = plan.entryPrice!;
          }

          if (fb.high >= currentStop) {
            outcome = currentStop === plan.entryPrice! ? 'OPEN' : 'LOSS';
            exitPrice = currentStop;
            break;
          }
          if (fb.low <= plan.targetPrice!) {
            outcome = 'WIN';
            exitPrice = plan.targetPrice!;
            break;
          }
        }
      }

      let pnlR = 0;
      if (outcome === 'WIN') {
        pnlR = plan.targetR || 1.8;
      } else if (outcome === 'LOSS') {
        pnlR = -1;
      } else {
        // Breakeven ya Timeout
        const isBreakevenTrailed = currentStop === plan.entryPrice!;
        if (isBreakevenTrailed) {
          // Trade ne +1R touch kiya tha aur SL entry par shift hua tha (50% partial profit booked)
          exitPrice = plan.entryPrice!;
          pnlR = 0.5;
        } else {
          // Pure 60-bar timeout bina stop ya 1R touch kiye
          exitPrice = forwardBars[forwardBars.length - 1]?.close ?? currentBar.close;
          const diff = plan.decision === 'LONG' ? exitPrice - plan.entryPrice! : plan.entryPrice! - exitPrice;
          pnlR = Number((diff / risk).toFixed(2));
        }
      }

      console.log(`   Result: ${outcome} (${pnlR > 0 ? '+' : ''}${pnlR}R) after ${barsHeld} bars @ Exit $${exitPrice.toFixed(1)}`);

      // 2-Hour Pre-Trade + 1-Hour Post-Trade Deep X-Ray Context
      const pre2hBars = rawBars.slice(Math.max(0, i - 120), i + 1);
      const preHigh = Math.max(...pre2hBars.map((b) => b.high));
      const preLow = Math.min(...pre2hBars.map((b) => b.low));
      const prePosPct = preHigh > preLow ? (((plan.entryPrice! - preLow) / (preHigh - preLow)) * 100).toFixed(0) : '50';
      const preNetDelta = pre2hBars.reduce((s, b) => s + b.delta, 0).toFixed(1);

      const post1hBars = rawBars.slice(i + 1, Math.min(rawBars.length, i + 61));
      const post1hHigh = post1hBars.length ? Math.max(...post1hBars.map((b) => b.high)) : exitPrice;
      const post1hLow = post1hBars.length ? Math.min(...post1hBars.map((b) => b.low)) : exitPrice;
      const wouldHaveHitTpIn1h = plan.decision === 'LONG'
        ? post1hHigh >= plan.targetPrice!
        : post1hLow <= plan.targetPrice!;
      const slTooTight = outcome === 'LOSS' && wouldHaveHitTpIn1h;

      const xRayContext = [
        `Pre-2H Context (120m): Range $${preLow.toFixed(1)}-$${preHigh.toFixed(1)}, Entry at ${prePosPct}% of 2h range, 2h Net Delta=${preNetDelta}.`,
        `Post-1H Action (60m): High $${post1hHigh.toFixed(1)}, Low $${post1hLow.toFixed(1)}.`,
        slTooTight
          ? `DIAGNOSIS: SL_TOO_TIGHT — Price wicked SL at $${exitPrice.toFixed(1)} in ${barsHeld}m, then reversed and hit TP $${plan.targetPrice!.toFixed(1)} within 1 hour! Setup was VALID.`
          : outcome === 'LOSS'
            ? `DIAGNOSIS: STRATEGY_FAILURE — Price continued against ${plan.decision} after SL hit without reaching TP in 1 hour.`
            : `DIAGNOSIS: VALID_CONTINUATION — Trade held structure and delivered ${pnlR}R.`
      ].join(' ');

      // 2-Way Self-Learning
      let insightText = '';
      if (outcome === 'LOSS') {
        console.log(`   🧠 [2H+1H Deep X-Ray]: ${slTooTight ? 'SL_TOO_TIGHT detected (hit TP later in 1h)!' : 'Analyzing strategy failure...'}`);
        await sleep(5000);
        insightText = await analyzeTradeOutcomeWithAI(
          {
            decision: plan.decision,
            entryPrice: plan.entryPrice!,
            stopPrice: plan.stopPrice!,
            targetPrice: plan.targetPrice!,
            reasons: plan.reasons,
            summary: plan.summary
          },
          {
            outcome: 'LOSS',
            exitPrice,
            exitReason: slTooTight ? 'SL_TOO_TIGHT (Wicked out before 1h TP)' : 'Hit Stop Loss (-1R)',
            marketContext: xRayContext
          }
        );
        if (!slTooTight) {
          learnedLessons.push(`[AVOID LOSS] ${insightText}`);
          console.log(`   🎓 [Filter Rule Learned]: "${insightText}"\n`);
        } else {
          console.log(`   🛡️ [Strategy Protected — Not Saved as Loss Filter]: "${insightText}"\n`);
        }
      } else {
        console.log(`   🌟 [2H+1H Deep X-Ray]: Reinforcing winning signature...`);
        await sleep(5000);
        insightText = await analyzeTradeOutcomeWithAI(
          {
            decision: plan.decision,
            entryPrice: plan.entryPrice!,
            stopPrice: plan.stopPrice!,
            targetPrice: plan.targetPrice!,
            reasons: plan.reasons,
            summary: plan.summary
          },
          {
            outcome: 'WIN',
            exitPrice,
            exitReason: 'Hit Target',
            marketContext: xRayContext
          }
        );
        learnedLessons.push(`[PROVEN WINNER] ${insightText}`);
        console.log(`   ⭐ [Winning Signature Saved]: "${insightText}"\n`);
      }

      // Persist rule into Local MongoDB (Skip saving negative filter when SL was merely too tight)
      if (!slTooTight) {
        try {
          const client = new MongoClient(mongoUri);
          await client.connect();
          await client.db(dbName).collection('learned_rules').insertOne({
            symbol,
            outcome: outcome === 'WIN' ? 'WIN' : 'LOSS',
            lesson: insightText,
            source: 'BACKTEST',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
          });
          await client.close();
        } catch {
          // ignore
        }
      }

      // Dispatch Telegram Outcome Alert
      void sendTradeOutcomeAlert({
        symbol,
        decision: plan.decision,
        outcome: outcome as any,
        entryPrice: plan.entryPrice!,
        exitPrice,
        pnlR,
        barsHeld,
        lessonLearned: insightText
      }).catch((e) => console.warn('[Telegram Error]:', e instanceof Error ? e.message : e));

      trades.push({
        timeStr,
        side: plan.decision,
        entryPrice: plan.entryPrice!,
        stopPrice: plan.stopPrice!,
        targetPrice: plan.targetPrice!,
        targetR: plan.targetR || 2,
        outcome,
        pnlR,
        barsHeld,
        summary: plan.summary,
        lessonLearned: insightText || undefined
      });
      lastTradeEntryPrice = plan.entryPrice!;
      lastTradeBarIndex = i;

      // Jump forward past bars held to prevent repeat trigger inside same candle wave
      i += Math.max(barsHeld, 4);
      // Extra 15-second rest after completed trade analysis
      await sleep(15_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n[Notice]: ${msg}`);
      console.log(`   ⏳ Pausing 20s for network cooldown before next check...`);
      await sleep(20_000);
      i += 3;
    }
  }

  // Summary Scorecard
  console.log('\n================================================================');
  console.log('                 FINAL BACKTEST & LEARNING REPORT               ');
  console.log('================================================================');
  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const expired = trades.filter((t) => t.outcome === 'OPEN').length;
  const netR = trades.reduce((s, t) => s + t.pnlR, 0);
  const resolved = wins + losses;
  const winRate = resolved > 0 ? ((wins / resolved) * 100).toFixed(1) : '0';

  console.log(`Total Trades Taken : ${trades.length}`);
  console.log(`Target Hit (Wins)  : ${wins}`);
  console.log(`Stop Hit (Losses)  : ${losses}`);
  console.log(`Breakeven / Open   : ${expired}`);
  console.log(`True Win Rate      : ${winRate}%`);
  console.log(`Net Performance    : ${netR > 0 ? '+' : ''}${netR.toFixed(2)}R\n`);

  if (learnedLessons.length > 0) {
    console.log('🧠 [KNOWLEDGE BASE ACCUMULATED BY AGENTS (RULES LEARNED)] :');
    learnedLessons.forEach((l, idx) => {
      console.log(`   ${idx + 1}. ${l}`);
    });
    console.log('\nAll learned rules are permanently stored in MongoDB!');
  }
}

runReplayBacktest().catch(console.error);