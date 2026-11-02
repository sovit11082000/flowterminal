import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { runOrderFlowCouncil, analyzeTradeOutcomeWithAI, type AgentSnapshot } from './src/agents/orderFlowCouncil.js';
import { sendTradeEntryAlert, sendTradeOutcomeAlert } from './src/services/telegramService.js';

function loadProjectEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const envPath = candidates.find((c) => existsSync(c));
  if (!envPath) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadBars(): Promise<{ symbol: string; bars: ReplayBar[]; source: string }> {
  const useMongo = process.argv.includes('--mongo') || process.argv.includes('--today');
  if (useMongo) {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/';
    const dbName = process.env.MONGODB_DATABASE || 'flowterminal';
    console.log(`[Replay Engine] Connecting to Local MongoDB at ${mongoUri} (${dbName})...`);
    try {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const db = client.db(dbName);
      const symbol = process.env.DEFAULT_SYMBOL || 'BTCUSDT';
      const docs = await db.collection('footprints').find({ symbol, timeframe: '1m' }).sort({ time: 1 }).toArray();
      await client.close();
      if (docs.length >= 15) {
        console.log(`[Replay Engine] Loaded ${docs.length} bars directly from Local MongoDB!`);
        return { symbol, bars: docs as unknown as ReplayBar[], source: 'Local MongoDB' };
      }
      console.log(`[Replay Engine] Local MongoDB has only ${docs.length} bars; falling back to replay.json...`);
    } catch (err) {
      console.warn(`[Replay Engine] Could not read local MongoDB:`, err instanceof Error ? err.message : err);
    }
  }

  // Load from replay.json
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
    throw new Error('replay.json not found in working directory or Downloads.');
  }

  const rawData = JSON.parse(readFileSync(replayPath, 'utf8'));
  const symbol = rawData.symbol || 'BTCUSDT';
  const rawBars: ReplayBar[] = rawData.bars || [];
  return { symbol, bars: rawBars, source: replayPath };
}

async function runReplayBacktest() {
  console.log('================================================================');
  console.log('   FLOWTERMINAL AI COUNCIL: SELF-LEARNING REPLAY BACKTEST       ');
  console.log('================================================================\n');

  const { symbol, bars: rawBars, source } = await loadBars();

  if (rawBars.length < 15) {
    console.error('[Replay Engine] Need at least 15 bars for backtesting.');
    process.exit(1);
  }
  console.log(`[Replay Engine] Source: ${source}`);
  console.log(`[Replay Engine] Total Bars: ${rawBars.length} for ${symbol}`);
  console.log(`[Rate Limiting Policy]: 2s spacing between AI calls to stay under Groq 30 RPM.\n`);

  const trades: SimulatedTrade[] = [];
  const learnedLessons: string[] = [];

  let i = 15;
  while (i < rawBars.length - 8) {
    const historicalBars = rawBars.slice(0, i + 1);
    const currentBar = rawBars[i];

    // Smart Market Structure Filter:
    // Only invoke AI Council when there is meaningful market activity (extreme test, delta surge, or 5m boundary)
    const recent6 = historicalBars.slice(-6);
    const isLocalExtreme = currentBar.high >= Math.max(...recent6.map((b) => b.high)) ||
                           currentBar.low <= Math.min(...recent6.map((b) => b.low));
    const isDeltaSpike = Math.abs(currentBar.delta) >= 20;
    const isFiveMinBoundary = currentBar.time % 300 === 0;

    if (!isLocalExtreme && !isDeltaSpike && !isFiveMinBoundary) {
      i += 1;
      continue;
    }

    const recentCandles = historicalBars.slice(-25).map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close
    }));

    const snapshot: AgentSnapshot = {
      symbol,
      timeframe: '1m',
      feedStatus: 'LIVE',
      lastTradeAt: Date.now(),
      latestPrice: currentBar.close,
      profile: {
        poc: currentBar.pocPrice,
        vah: Math.max(...historicalBars.slice(-15).map((b) => b.high)),
        val: Math.min(...historicalBars.slice(-15).map((b) => b.low)),
        capturedBars: 15
      },
      candles: recentCandles,
      footprints: historicalBars.slice(-8),
      trades: [],
      bids: [[currentBar.close - 0.5, 1.2]],
      asks: [[currentBar.close + 0.5, 1.2]],
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

    const timeStr = new Date(currentBar.time * (currentBar.time > 1e11 ? 1 : 1000)).toLocaleTimeString('en-US', { hour12: false });
    process.stdout.write(`[Bar ${i}/${rawBars.length}] Time: ${timeStr} | Price: ${currentBar.close} | AI Thinking... `);

    // 2-second rate-limiting pacing to keep Groq well within 30 RPM
    await sleep(2200);

    try {
      const councilResult = await runOrderFlowCouncil(snapshot);
      const plan = councilResult.plan;

      if (plan.decision === 'WAIT') {
        console.log(`[WAIT] -> ${plan.summary.slice(0, 65)}...`);
        i += 2;
        continue;
      }

      console.log(`\n\n🚨 [ACTIVE TRADE TRIGGERED]: ${plan.decision} @ $${plan.entryPrice}`);
      console.log(`   Summary: ${plan.summary}`);
      console.log(`   SL: $${plan.stopPrice} | TP: $${plan.targetPrice} (${plan.targetR}R)`);
      console.log(`   Reasons: ${plan.reasons.slice(0, 2).join(' | ')}`);
      console.log(`   Strategies: ${plan.strategyNames?.join(' + ') || 'N/A'}`);

      // Dispatch real-time Telegram trade alert
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

      // Forward outcome evaluation across next 15 bars
      const forwardBars = rawBars.slice(i + 1, Math.min(i + 16, rawBars.length));
      let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
      let exitPrice = currentBar.close;
      let barsHeld = 0;

      for (let j = 0; j < forwardBars.length; j++) {
        const fb = forwardBars[j];
        barsHeld = j + 1;
        if (plan.decision === 'LONG') {
          if (fb.low <= plan.stopPrice!) {
            outcome = 'LOSS';
            exitPrice = plan.stopPrice!;
            break;
          }
          if (fb.high >= plan.targetPrice!) {
            outcome = 'WIN';
            exitPrice = plan.targetPrice!;
            break;
          }
        } else {
          if (fb.high >= plan.stopPrice!) {
            outcome = 'LOSS';
            exitPrice = plan.stopPrice!;
            break;
          }
          if (fb.low <= plan.targetPrice!) {
            outcome = 'WIN';
            exitPrice = plan.targetPrice!;
            break;
          }
        }
      }

      const risk = Math.abs(plan.entryPrice! - plan.stopPrice!) || 1;
      let pnlR = outcome === 'WIN' ? (plan.targetR || 2) : outcome === 'LOSS' ? -1 : 0;
      if (outcome === 'OPEN') {
        exitPrice = forwardBars[forwardBars.length - 1]?.close ?? currentBar.close;
        const diff = plan.decision === 'LONG' ? exitPrice - plan.entryPrice! : plan.entryPrice! - exitPrice;
        pnlR = Number((diff / risk).toFixed(2));
      }

      console.log(`   Result: ${outcome} (${pnlR > 0 ? '+' : ''}${pnlR}R) after ${barsHeld} bars @ Exit $${exitPrice.toFixed(1)}`);

      // 2-WAY SELF-LEARNING (POST-MORTEM ON LOSS + SUCCESS REINFORCEMENT ON WIN)
      let insightText = '';
      if (outcome === 'LOSS') {
        const forwardContext = `Price moved against trade reaching $${exitPrice.toFixed(1)} within ${barsHeld} bars. Forward volume was ${forwardBars.slice(0, barsHeld).reduce((s, b) => s + b.totalVolume, 0).toFixed(1)} BTC with net delta ${forwardBars.slice(0, barsHeld).reduce((s, b) => s + b.delta, 0).toFixed(1)} BTC.`;
        console.log(`   🧠 [AI Self-Reflection]: Manager analyzing why this ${plan.decision} hit stop loss...`);
        await sleep(1500);
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
            exitReason: 'Hit Stop Loss (-1R)',
            marketContext: forwardContext
          }
        );
        learnedLessons.push(insightText);
        console.log(`   🎓 [Rule Learned & Injected into Memory]: "${insightText}"\n`);
      } else {
        const forwardContext = `Price reached target $${exitPrice.toFixed(1)} within ${barsHeld} bars with strong order-flow continuation.`;
        console.log(`   🌟 [AI Success-Reinforcement]: Manager analyzing what made this winning trade work...`);
        await sleep(1200);
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
            exitReason: 'Hit Target (+2R)',
            marketContext: forwardContext
          }
        );
        console.log(`   ⭐ [Winning Confluence Signature]: "${insightText}"\n`);
      }

      // Dispatch real-time Telegram trade outcome alert (Win / Loss)
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

      i += Math.max(barsHeld, 3);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n[Notice]: ${msg}`);
      console.log(`   ⏳ Pausing 25s for network connection & quota window before next bar...`);
      await sleep(25_000);
      i += 1;
    }
  }

  // Summary Scorecard
  console.log('\n================================================================');
  console.log('                 FINAL BACKTEST & LEARNING REPORT               ');
  console.log('================================================================');
  const wins = trades.filter((t) => t.pnlR > 0).length;
  const losses = trades.filter((t) => t.pnlR < 0).length;
  const netR = trades.reduce((s, t) => s + t.pnlR, 0);
  const winRate = trades.length ? (wins / trades.length * 100).toFixed(1) : '0';

  console.log(`Total Trades Taken : ${trades.length}`);
  console.log(`Wins               : ${wins}`);
  console.log(`Losses             : ${losses}`);
  console.log(`Win Rate           : ${winRate}%`);
  console.log(`Net Performance    : ${netR > 0 ? '+' : ''}${netR.toFixed(2)}R\n`);

  if (learnedLessons.length > 0) {
    console.log('🧠 [KNOWLEDGE BASE ACCUMULATED BY AGENTS (RULES LEARNED)] :');
    learnedLessons.forEach((l, idx) => {
      console.log(`   ${idx + 1}. ${l}`);
    });
    console.log('\nAll learned rules are dynamically injected into future trade decisions!');
  }
}

runReplayBacktest().catch(console.error);