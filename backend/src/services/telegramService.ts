export interface TelegramTradeAlert {
  tradeId?: string;
  symbol: string;
  decision: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  targetR: number;
  reasons: string[];
  strategies: string[];
  summary: string;
}

export interface TelegramOutcomeAlert {
  tradeId?: string;
  symbol: string;
  decision: 'LONG' | 'SHORT';
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  entryPrice: number;
  exitPrice: number;
  pnlR: number;
  barsHeld: number;
  lessonLearned?: string;
  sessionStats?: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netR: number;
  };
}

/** Telegram HTML parsing ke liye reserved characters (<, >, &) ko safe banata hai */
function escapeHtml(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatISTDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date) + ' IST';
}

function formatPrice(symbol: string, price: number): string {
  if (/^(EURUSD|GBPUSD)$/i.test(symbol)) return price.toFixed(5);
  if (/^XAUUSD$/i.test(symbol)) return price.toFixed(2);
  return price.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '8898376506:AAFUMygBLbqTBxAhXBSi9cIfoFV7rGJCuyk';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '7316417360';
  const apiBase = (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');

  if (!token || token.includes('PASTE') || token === 'xxx') {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN not configured; skipping alert.');
    return false;
  }

  const url = `${apiBase}/bot${token}/sendMessage`;
  const safeText = text.slice(0, 4000);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: chatId,
          text: safeText,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });

      if (res.ok) return true;

      const errBody = await res.text();
      // If HTML tag caused 400 Bad Request, immediately retry without parse_mode
      if (res.status === 400 && errBody.includes('parse entities')) {
        const plainRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: safeText.replace(/<[^>]*>/g, ''),
            disable_web_page_preview: true
          })
        });
        if (plainRes.ok) return true;
      }

      console.warn(`[Telegram] Attempt ${attempt}/3 failed (HTTP ${res.status}):`, errBody);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ? `${cause.code} (${cause.message || ''})` : (error instanceof Error ? error.message : String(error));
      console.warn(`[Telegram] Attempt ${attempt}/3 network error:`, detail);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }

  return false;
}

export async function sendTradeEntryAlert(trade: TelegramTradeAlert): Promise<void> {
  const isLong = trade.decision === 'LONG';
  const icon = isLong ? '🟢' : '🔴';
  const formattedTime = formatISTDate();
  const tradeTag = trade.tradeId ? `<code>${escapeHtml(trade.tradeId)}</code>` : `#TRADE-${trade.symbol}`;

  const strategiesList = trade.strategies.length
    ? trade.strategies.map((s) => `• ${escapeHtml(s)}`).join('\n')
    : '• Multi-Agent Confluence';

  const reasonsList = trade.reasons.length
    ? trade.reasons.slice(0, 2).map((r) => `• ${escapeHtml(r)}`).join('\n')
    : '• High confluence confirmation';

  const message = `🚨 <b>NEW A+ TRADE ENTRY</b> | ${tradeTag}
━━━━━━━━━━━━━━━━━━━━
⚡ <b>Direction:</b> ${icon} <b>${trade.decision} ${trade.symbol}</b>
🏁 <b>Entry:</b> $${formatPrice(trade.symbol, trade.entryPrice)}
🎯 <b>Target (TP):</b> $${formatPrice(trade.symbol, trade.targetPrice)} (<b>+${trade.targetR}R</b>)
🛑 <b>Stop Loss (SL):</b> $${formatPrice(trade.symbol, trade.stopPrice)} (<b>-1R</b>)
📅 <b>Entry Time:</b> ${formattedTime}

📊 <b>Confluence Strategies:</b>
${strategiesList}

💡 <b>Analysis:</b>
${escapeHtml(trade.summary)}

🔍 <b>Why This Trade:</b>
${reasonsList}
━━━━━━━━━━━━━━━━━━━━`;

  await sendTelegramMessage(message);
}

export async function sendTradeOutcomeAlert(outcome: TelegramOutcomeAlert): Promise<void> {
  const isBreakeven = Math.abs(outcome.pnlR) <= 0.05;
  const isTimeout = Boolean(outcome.lessonLearned?.includes('1:30 AM IST')) && outcome.pnlR > 0.05 && outcome.pnlR < 1.4;
  const isWin = outcome.outcome === 'WIN' && !isBreakeven && !isTimeout;
  const isOpen = outcome.outcome === 'OPEN' || isBreakeven || isTimeout;
  const headerIcon = isWin ? '🎯' : isBreakeven ? '⚖️' : isOpen ? '⏱️' : '🛑';
  const title = isWin
    ? 'TARGET REACHED (WIN)'
    : isBreakeven
      ? 'BREAKEVEN / TRAIL EXIT (0R)'
      : isOpen
        ? 'TIME EXPIRED / TRAIL'
        : 'STOP LOSS HIT (LOSS)';
  const pnlSign = outcome.pnlR > 0 ? '+' : '';
  const formattedTime = formatISTDate();
  const tradeTag = outcome.tradeId ? `<code>${escapeHtml(outcome.tradeId)}</code>` : `#TRADE-${outcome.symbol}`;

  let body = `${headerIcon} <b>TRADE RESOLVED: ${title}</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Trade ID:</b> ${tradeTag}
📈 <b>Pair & Side:</b> ${outcome.decision} ${outcome.symbol}
💰 <b>Trade PnL:</b> <b>${pnlSign}${outcome.pnlR.toFixed(2)}R</b>
🏁 <b>Entry:</b> $${formatPrice(outcome.symbol, outcome.entryPrice)} ➔ <b>Exit:</b> $${formatPrice(outcome.symbol, outcome.exitPrice)}
⏱️ <b>Duration:</b> ${outcome.barsHeld} Minutes
📅 <b>Exit Time:</b> ${formattedTime}\n`;

  if (outcome.sessionStats) {
    const s = outcome.sessionStats;
    const netSign = s.netR > 0 ? '+' : '';
    body += `\n📊 <b>CURRENT SESSION PERFORMANCE:</b>
• Total Trades: <b>${s.totalTrades}</b>
• Wins: <b>${s.wins}</b> | Losses: <b>${s.losses}</b>
• Win Rate: <b>${s.winRate.toFixed(1)}%</b>
• Total Net Profit: <b>${netSign}${s.netR.toFixed(2)}R</b>\n`;
  }

  if (isWin) {
    const pattern = outcome.lessonLearned || 'Confluence setup delivered full expansion target.';
    body += `\n⭐ <b>Winning Signature:</b>\n<i>"${escapeHtml(pattern)}"</i>\n━━━━━━━━━━━━━━━━━━━━`;
  } else if (isOpen) {
    body += `\nℹ️ <i>Closed on time expiration at market price.</i>\n━━━━━━━━━━━━━━━━━━━━`;
  } else {
    const lesson = outcome.lessonLearned || 'Respect multi-timeframe structure and stop invalidation.';
    body += `\n🧠 <b>AI Learned Rule:</b>\n<i>"${escapeHtml(lesson)}"</i>\n━━━━━━━━━━━━━━━━━━━━`;
  }

  await sendTelegramMessage(body);
}

export async function sendOrEditLiveStatusMessage(htmlText: string, existingMessageId?: number | null): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '8898376506:AAFUMygBLbqTBxAhXBSi9cIfoFV7rGJCuyk';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '7316417360';
  const apiBase = (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');
  if (!token || !chatId) return null;

  try {
    if (existingMessageId) {
      const editRes = await fetch(`${apiBase}/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: existingMessageId,
          text: htmlText,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const editJson = (await editRes.json()) as { ok?: boolean; description?: string };
      if (editJson.ok || editJson.description?.includes('message is not modified')) {
        return existingMessageId;
      }
    }

    const sendRes = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_notification: true,
        disable_web_page_preview: true
      })
    });
    const sendJson = (await sendRes.json()) as { ok?: boolean; result?: { message_id?: number } };
    return sendJson.ok && sendJson.result?.message_id ? sendJson.result.message_id : null;
  } catch {
    return existingMessageId ?? null;
  }
} 