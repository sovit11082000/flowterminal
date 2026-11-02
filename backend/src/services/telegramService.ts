export interface TelegramTradeAlert {
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
  symbol: string;
  decision: 'LONG' | 'SHORT';
  outcome: 'WIN' | 'LOSS';
  entryPrice: number;
  exitPrice: number;
  pnlR: number;
  barsHeld: number;
  lessonLearned?: string;
}

function formatISTDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date) + ' IST';
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '8898376506:AAFUMygBLbqTBxAhXBSi9cIfoFV7rGJCuyk';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '7316417360';

  if (!token || token.includes('PASTE') || token === 'xxx') {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN not configured; skipping alert.');
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[Telegram] Failed to send message:', err);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[Telegram] Network error sending alert:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendTradeEntryAlert(trade: TelegramTradeAlert): Promise<void> {
  const isLong = trade.decision === 'LONG';
  const icon = isLong ? '🟢' : '🔴';
  const formattedTime = formatISTDate();

  const strategiesList = trade.strategies.length
    ? trade.strategies.map((s) => `• ${s}`).join('\n')
    : '• Confluence Setup';

  const reasonsList = trade.reasons.length
    ? trade.reasons.slice(0, 2).map((r) => `• ${r}`).join('\n')
    : '• High confluence confirmation';

  const message = `🚨 <b>FLOWTERMINAL AI COUNCIL: NEW TRADE</b>
━━━━━━━━━━━━━━━━━━━━
⚡ <b>Direction:</b> ${icon} <b>${trade.decision}</b> @ $${trade.entryPrice.toLocaleString()}
🎯 <b>Target (TP):</b> $${trade.targetPrice.toLocaleString()} (<b>+${trade.targetR}R</b>)
🛑 <b>Stop Loss (SL):</b> $${trade.stopPrice.toLocaleString()} (<b>-1R</b>)
📅 <b>Time:</b> ${formattedTime}
💎 <b>Symbol:</b> <code>${trade.symbol}</code>

📊 <b>Strategies:</b>
${strategiesList}

💡 <b>Analysis:</b>
${trade.summary}

🔍 <b>Key Confluence:</b>
${reasonsList}
━━━━━━━━━━━━━━━━━━━━`;

  await sendTelegramMessage(message);
}

export async function sendTradeOutcomeAlert(outcome: TelegramOutcomeAlert): Promise<void> {
  const isWin = outcome.outcome === 'WIN';
  const headerIcon = isWin ? '🎯' : '🛑';
  const title = isWin ? 'TARGET HIT (WIN)' : 'STOP LOSS HIT (LOSS)';
  const pnlSign = outcome.pnlR > 0 ? '+' : '';
  const formattedTime = formatISTDate();

  let body = `${headerIcon} <b>TRADE RESOLVED: ${title}</b>
━━━━━━━━━━━━━━━━━━━━
💰 <b>PnL:</b> <b>${pnlSign}${outcome.pnlR.toFixed(2)}R</b>
📈 <b>Setup:</b> ${outcome.decision} ${outcome.symbol}
🏁 <b>Entry:</b> $${outcome.entryPrice.toLocaleString()} ➔ <b>Exit:</b> $${outcome.exitPrice.toLocaleString()}
⏱️ <b>Bars Held:</b> ${outcome.barsHeld} Minutes (1m bars)
📅 <b>Time:</b> ${formattedTime}\n`;

  if (isWin) {
    const pattern = outcome.lessonLearned || 'High confluence alignment between HTF trend, POC support, and stacked imbalances.';
    body += `\n⭐ <b>Winning Confluence Signature:</b>\n<i>"${pattern}"</i>\n\n✅ <i>Trade successfully completed confluence target!</i>\n━━━━━━━━━━━━━━━━━━━━`;
  } else {
    const lesson = outcome.lessonLearned || 'Respect multi-timeframe structure and POC invalidation.';
    body += `\n🧠 <b>AI Post-Mortem Rule Learned:</b>\n<i>"${lesson}"</i>\n\n🔒 <i>Rule injected into Council memory to prevent repetition!</i>\n━━━━━━━━━━━━━━━━━━━━`;
  }

  await sendTelegramMessage(body);
}