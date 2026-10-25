import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { CandleTimeframe, LiquidationEvent } from '../types/market.js';

export function drawLiquidationBubbles(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
  liquidations: LiquidationEvent[],
  timeframe: CandleTimeframe = '1m'
): void {
  if (!liquidations.length) return;
  const recent = liquidations.slice(-250);
  const maxSize = recent.reduce((max, event) => Math.max(max, event.size), 0);
  for (const event of recent) {
    const intervalSeconds = ({
      '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400
    } as Record<CandleTimeframe, number>)[timeframe];
    // Bybit timestamps events to milliseconds; snap X to that timeframe's
    // candle start. Y is the exchange-reported bankruptcy price, not last price.
    const candleTime = Math.floor(event.timestamp / (intervalSeconds * 1000)) * intervalSeconds;
    const x = chart.timeScale().timeToCoordinate(candleTime as UTCTimestamp);
    const y = candleSeries.priceToCoordinate(event.price);
    if (x === null || y === null) continue;
    const radius = 3 + (maxSize > 0 ? 9 * Math.sqrt(event.size / maxSize) : 0);
    const longLiquidated = event.side === 'Buy';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = longLiquidated ? 'rgba(239, 68, 68, 0.30)' : 'rgba(16, 185, 129, 0.30)';
    ctx.fill();
    ctx.strokeStyle = longLiquidated ? 'rgba(248, 113, 113, 0.95)' : 'rgba(52, 211, 153, 0.95)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}
