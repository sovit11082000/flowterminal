import type { MongoHistoryStore, LiveTradeJournalRecord, SystemAuditLogRecord } from './mongoHistoryStore.js';
import { runNightlyBatchAuditWithAI, cleanLesson, type AuditTradeInput } from '../agents/orderFlowCouncil.js';
import { sendTelegramMessage } from './telegramService.js';

function getIstDateString(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export async function runNightlyAuditCycle(
  mongoHistory: MongoHistoryStore,
  options?: { forceAllRecent?: boolean; silentIfEmpty?: boolean; onNewRule?: (rule: string) => void }
): Promise<{ auditedCount: number; findings: SystemAuditLogRecord[]; newRules: string[] }> {
  if (!mongoHistory.connected) {
    if (!options?.silentIfEmpty) console.warn('[Rolling Audit] MongoDB disconnected; skipping audit.');
    return { auditedCount: 0, findings: [], newRules: [] };
  }



  // Always require at least 65 minutes after trade exit so full 1h post-trade follow-through is finalized
  const cutoffMs = Date.now() - 65 * 60_000;
  const rawTrades = await mongoHistory.getUnauditedTrades(cutoffMs);

  // Double-lock: Check existing audit logs so an already-audited tradeId is NEVER re-audited
  const existingLogs = await mongoHistory.getSystemAuditLogs(500);
  const alreadyAuditedIds = new Set(existingLogs.map((l) => l.tradeId));

  const staleFlagIds = rawTrades.filter((t) => alreadyAuditedIds.has(t.tradeId)).map((t) => t.tradeId);
  if (staleFlagIds.length) {
    await mongoHistory.markTradesAudited(staleFlagIds);
  }

  const trades = rawTrades.filter((t) => !alreadyAuditedIds.has(t.tradeId));
  if (!trades.length) {
    if (!options?.silentIfEmpty) console.log('[Rolling Audit] No new unaudited trades ready for review.');
    return { auditedCount: 0, findings: [], newRules: [] };
  }

  console.log(`[Rolling Audit] Starting 1h post-trade deep audit of ${trades.length} trades...`);
  const auditInputs: AuditTradeInput[] = [];

  for (const t of trades) {
    // 1. Fetch 4.5 hours pre-trade 1m footprints
    const preStartMs = t.enteredAt - 270 * 60_000;
    const preBars = await mongoHistory.getFootprints({
      symbol: t.symbol,
      timeframe: '1m',
      startTimeMs: preStartMs,
      endTimeMs: t.enteredAt
    });

    let preTradeSummary = 'Pre-trade 4.5h footprint history unavailable.';
    if (preBars.length >= 10) {
      const high4h = Math.max(...preBars.map((b) => b.high));
      const low4h = Math.min(...preBars.map((b) => b.low));
      const netDelta = preBars.reduce((s, b) => s + b.delta, 0);
      const span = Math.max(high4h - low4h, 1e-6);
      const posPct = (((t.entryPrice - low4h) / span) * 100).toFixed(0);
      const slPct = ((t.initialRisk / t.entryPrice) * 100).toFixed(2);
      preTradeSummary = `4.5h Range: $${low4h.toFixed(2)} - $${high4h.toFixed(2)} | Entry at ${posPct}% of range | 4.5h Net Delta: ${netDelta.toFixed(1)} | SL Width: ${slPct}%`;
    }

    // 2. Fetch 1 hour post-trade 1m footprints
    const postEndMs = t.resolvedAt + 60 * 60_000;
    const postBars = await mongoHistory.getFootprints({
      symbol: t.symbol,
      timeframe: '1m',
      startTimeMs: t.resolvedAt,
      endTimeMs: postEndMs
    });

    let postTrade1hSummary = 'Post-trade 1h bars still forming.';
    if (postBars.length >= 3) {
      const postHigh = Math.max(...postBars.map((b) => b.high));
      const postLow = Math.min(...postBars.map((b) => b.low));
      const postClose = postBars[postBars.length - 1].close;
      const hitOriginalTp = t.side === 'LONG' ? postHigh >= t.targetPrice : postLow <= t.targetPrice;
      const hitOriginalSl = t.side === 'LONG' ? postLow <= t.stopPrice : postHigh >= t.stopPrice;
      postTrade1hSummary = `Next 1h (${postBars.length} bars): High $${postHigh.toFixed(2)}, Low $${postLow.toFixed(2)}, Close $${postClose.toFixed(2)} | Reached Original TP: ${hitOriginalTp ? 'YES' : 'NO'} | Reached Original SL: ${hitOriginalSl ? 'YES' : 'NO'}`;
    }

    auditInputs.push({
      tradeId: t.tradeId,
      symbol: t.symbol,
      side: t.side,
      entryPrice: t.entryPrice,
      stopPrice: t.stopPrice,
      targetPrice: t.targetPrice,
      exitPrice: t.exitPrice,
      outcome: t.outcome,
      exitKind: t.exitKind,
      pnlR: t.pnlR,
      barsHeld: t.barsHeld,
      macro1hTrend: t.macro1hTrend,
      macro4hTrend: t.macro4hTrend,
      strategies: t.strategies,
      reasons: t.reasons,
      preTradeSummary,
      postTrade1hSummary
    });
  }

  const auditDateIst = getIstDateString();
  const savedLogs: SystemAuditLogRecord[] = [];
  const newRules: string[] = [];
  let newRulesCount = 0;

  for (let i = 0; i < auditInputs.length; i++) {
    const singleTrade = auditInputs[i];
    console.log(`[Nightly Audit] Auditing trade ${i + 1}/${auditInputs.length}: ${singleTrade.tradeId} (${singleTrade.symbol})...`);

    let singleFindings = [];
    try {
      singleFindings = await runNightlyBatchAuditWithAI([singleTrade]);
    } catch (err) {
      console.warn(`[Nightly Audit] Failed on ${singleTrade.tradeId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    for (const item of singleFindings) {
      if (!item?.tradeId || !item?.category) continue;
      const logRecord: SystemAuditLogRecord = {
        auditDateIst,
        tradeId: item.tradeId,
        symbol: item.symbol,
        category: item.category,
        problemDetected: item.problemDetected,
        rootCause: item.rootCause,
        recommendedFix: item.recommendedFix
      };

      await mongoHistory.saveSystemAuditLogs([logRecord]);
      await mongoHistory.markTradesAudited([singleTrade.tradeId]);
      savedLogs.push(logRecord);

      // Keep audit purely diagnostic so LLM-generated rules never block valid live setups
      if (item.category === 'STRATEGY_FAILURE' && item.verifiedRuleToSave) {
        const clean = cleanLesson(item.verifiedRuleToSave);
        if (clean) {
          newRules.push(clean);
          newRulesCount += 1;
        }
      }
    }
  }

  // Send concise Telegram summary
  const tightSlCount = savedLogs.filter((l) => l.category === 'SL_TOO_TIGHT').length;
  const stratFailCount = savedLogs.filter((l) => l.category === 'STRATEGY_FAILURE').length;
  const earlySavedCount = savedLogs.filter((l) => l.category === 'EARLY_EXIT_SAVED').length;
  const winCount = savedLogs.filter((l) => l.category === 'WINNING_PATTERN').length;

  const topHighlights = savedLogs
    .slice(0, 4)
    .map((l) => `• <b>[${l.tradeId}] ${l.category}:</b> ${l.problemDetected}\n  <i>Fix:</i> ${l.recommendedFix}`)
    .join('\n');

  const tgMsg = `🧠 <b>FLOWTERMINAL NIGHTLY AUDIT (${auditDateIst})</b>
━━━━━━━━━━━━━━━━━━━━
📊 <b>Trades Audited:</b> ${trades.length}
✅ <b>Winning Setups:</b> ${winCount} | 🛡️ <b>Early Exits Saved:</b> ${earlySavedCount}
⚠️ <b>Tight SL Wick-Outs:</b> ${tightSlCount} <i>(Strategy memory protected)</i>
❌ <b>Strategy Failures:</b> ${stratFailCount} <i>(${newRulesCount} verified rules saved)</i>

🔍 <b>Key Findings & Fixes:</b>
${topHighlights || 'No issues detected.'}

🌐 <i>Full report: http://localhost:4000/audit-report</i>
━━━━━━━━━━━━━━━━━━━━`;

  await sendTelegramMessage(tgMsg).catch(() => {});
  console.log(`[Rolling Audit] Completed 1h post-trade audit for ${trades.length} trades. Saved ${savedLogs.length} logs & ${newRulesCount} verified rules (sent directly to Manager).`);
  return { auditedCount: trades.length, findings: savedLogs, newRules };
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAuditDashboardHtml(logs: SystemAuditLogRecord[]): string {
  const badgeColor: Record<string, string> = {
    SL_TOO_TIGHT: '#f59e0b',
    STRATEGY_FAILURE: '#ef4444',
    EARLY_EXIT_SAVED: '#10b981',
    EARLY_EXIT_PREMATURE: '#3b82f6',
    WINNING_PATTERN: '#22c55e',
    SYSTEM_ISSUE: '#a855f7'
  };

  const cardsHtml = logs.length
    ? logs.map((log) => {
        const color = badgeColor[log.category] ?? '#64748b';
        const timeStr = log.createdAt ? new Date(log.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : log.auditDateIst;
        return `
        <div class="card" style="border-left: 4px solid ${color};">
          <div class="card-header">
            <span class="badge" style="background:${color}22; color:${color}; border:1px solid ${color};">${escapeHtml(log.category)}</span>
            <span class="trade-id">${escapeHtml(log.tradeId)} • ${escapeHtml(log.symbol)}</span>
            <span class="date">${escapeHtml(timeStr)} IST</span>
          </div>
          <div class="row"><strong>⚠️ Problem Detected:</strong> ${escapeHtml(log.problemDetected)}</div>
          <div class="row"><strong>🔍 Root Cause (1H/4H + Pre/Post):</strong> ${escapeHtml(log.rootCause)}</div>
          <div class="row fix"><strong>🛠️ Recommended Fix:</strong> ${escapeHtml(log.recommendedFix)}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Abhi tak koi audit log nahi hai. Raat 1:30 AM IST par automatic audit chalega, ya upar "Run Audit Now" dabayein.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>FlowTerminal — Nightly AI Audit & Diagnostics</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #e2e8f0; margin: 0; padding: 24px; }
    .container { max-width: 960px; margin: 0 auto; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid #1e293b; padding-bottom: 16px; }
    h1 { font-size: 22px; margin: 0; color: #f8fafc; }
    .sub { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
    .card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .badge { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; letter-spacing: 0.5px; }
    .trade-id { font-weight: 700; color: #f1f5f9; font-size: 15px; }
    .date { margin-left: auto; font-size: 12px; color: #64748b; }
    .row { font-size: 14px; line-height: 1.5; margin-bottom: 8px; color: #cbd5e1; }
    .fix { background: #0f172a; padding: 10px 12px; border-radius: 6px; border: 1px solid #1e293b; color: #86efac; margin-top: 10px; margin-bottom: 0; }
    .empty { text-align: center; padding: 48px; background: #111827; border-radius: 10px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div>
        <h1>🧠 FlowTerminal Nightly Audit & Problem Diagnostics</h1>
        <div class="sub">Auto-runs daily at 1:30 AM IST • Separates Tight SL Wick-Outs from Strategy Failures</div>
      </div>
      <button id="runBtn" onclick="runAudit()">▶ Run Audit Now</button>
    </div>
    ${cardsHtml}
  </div>
  <script>
    async function runAudit() {
      const btn = document.getElementById('runBtn');
      btn.disabled = true;
      btn.textContent = 'Auditing trades...';
      try {
        const res = await fetch('/api/agents/run-audit', { method: 'POST' });
        const data = await res.json();
        alert('Audit complete! Audited trades: ' + (data.auditedCount ?? 0));
        location.reload();
      } catch (e) {
        alert('Audit error: ' + e.message);
        btn.disabled = false;
        btn.textContent = '▶ Run Audit Now';
      }
    }
  </script>
</body>
</html>`;
}