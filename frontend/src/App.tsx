import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { apiUrl, gatewayWebSocketUrl } from './lib/api.js';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  UTCTimestamp,
  Time,
  MouseEventParams
} from 'lightweight-charts';
import { loadCandlesFromDB, saveCandlesToDB, CachedCandle } from './storage/db.js';
import { drawVolumeProfile, VolumeProfileMode, VolumeProfileViewMode } from './components/VolumeProfileOverlay.js';
import DOMLadder, { BookLevel } from './components/DOMLadder.js';
import DerivativesPanel, { type DerivativesPayload } from './components/DerivativesPanel.js';
import OrderBookHeatmap, { type BookSample, type TradeDot } from './components/OrderBookHeatmap.js';
import { drawOrderBookLiquidityOverlay } from './components/OrderBookChartOverlay.js';
import RecorderStatus from './components/RecorderStatus.js';
import AlertManager from './components/AlertManager.js';
import ChartDrawingLayer from './components/ChartDrawingLayer.js';
import IcebergSignals from './components/IcebergSignals.js';
import EntryExitSignals from './components/EntryExitSignals.js';
import AgentCouncilPanel from './components/AgentCouncilPanel.js';
import GammaLevelsPanel, { type Snapshot as GammaSnapshot } from './components/GammaLevelsPanel.js';
import { analyzeSmartMoney, drawSmartMoneyOverlay, type SmartMoneyAnalysis, type SmartMoneyFeatures } from './components/SmartMoneyOverlay.js';
import { backtestOrderFlow, drawBacktestMarkers, type BacktestCostAssumptions, type BacktestTrade, type OIHistoryPoint, type TradeSetup } from './components/EntryExitSignalEngine.js';
import { calculateVolumeProfile } from './components/VolumeProfileCalculator.js';
import {
  Trade,
  NormalizedCandle,
  SerializedFootprintBar,
  CandleTimeframe,
  ConnectionStatus
} from './types/market.js';

interface CrosshairBarInfo {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;
  pocPrice?: number;
}

type ChartDisplayMode = 'Candles' | 'Footprint' | 'Combined';
interface LiveTicker { symbol: string; lastPrice: number | null; markPrice: number | null; indexPrice: number | null; timestamp: number; }
const TIMEFRAMES: CandleTimeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const TIMEFRAME_SECONDS: Record<CandleTimeframe, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400
};
const toChartDate = (time: Time): Date => {
  if (typeof time === 'number') return new Date(time * 1000);
  if (typeof time === 'string') return new Date(time);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
};
const formatIndiaTime = (time: Time): string => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(toChartDate(time));
const formatIndiaCrosshairTime = (time: Time): string => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(toChartDate(time));
const buildCandleChartData = (candles: CachedCandle[], _timeframe: CandleTimeframe) => {
  // Do not insert WhitespaceData for missing timestamps. It creates visible
  // empty candle slots and makes healthy bars look like a broken feed. Keep
  // real exchange timestamps; the time labels will naturally skip missing data.
  const candleData: CandlestickData<UTCTimestamp>[] = [];
  const volumeData: HistogramData<UTCTimestamp>[] = [];

  candles.forEach((candle) => {
    candleData.push({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    });
    volumeData.push({
      time: candle.time as UTCTimestamp,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
    });
  });

  return { candleData, volumeData };
};

interface CandleRepairRange { startSec: number; endSec: number; }
const findCandleRepairRanges = (candles: CachedCandle[], timeframe: CandleTimeframe, nowMs: number): CandleRepairRange[] => {
  const intervalSec = TIMEFRAME_SECONDS[timeframe];
  const intervalMs = intervalSec * 1000;
  const latestSec = Math.floor(nowMs / intervalMs) * intervalSec;
  const earliestSec = Math.ceil((nowMs - 30 * 24 * 60 * 60 * 1000) / intervalMs) * intervalSec;
  const present = new Set(candles.map((candle) => candle.time));
  const ranges: CandleRepairRange[] = [];
  let active: CandleRepairRange | null = null;
  for (let time = earliestSec; time <= latestSec; time += intervalSec) {
    // Always refresh the current and previous two bars, because the latest
    // exchange candle may have changed while this browser was closed.
    const needsRepair = !present.has(time) || time >= latestSec - intervalSec * 2;
    if (needsRepair) {
      if (active && time === active.endSec + intervalSec) active.endSec = time;
      else {
        if (active) ranges.push(active);
        active = { startSec: time, endSec: time };
      }
    } else if (active) {
      ranges.push(active);
      active = null;
    }
  }
  if (active) ranges.push(active);
  // Repair the newest bars first so a short catch-up request updates the live
  // edge before older holes are filled.
  return ranges.sort((a, b) => b.startSec - a.startSec);
};
const MARKETS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin' }, { symbol: 'ETHUSDT', name: 'Ethereum' },
  { symbol: 'SOLUSDT', name: 'Solana' }, { symbol: 'XRPUSDT', name: 'XRP' },
  { symbol: 'BNBUSDT', name: 'BNB' }, { symbol: 'DOGEUSDT', name: 'Dogecoin' },
  { symbol: 'ADAUSDT', name: 'Cardano' }, { symbol: 'LINKUSDT', name: 'Chainlink' },
  { symbol: 'AVAXUSDT', name: 'Avalanche' }, { symbol: 'XAUTUSDT', name: 'Gold (XAUT)' }
] as const;

const BACKTEST_COSTS_KEY = 'flowterminal_backtest_costs_v1';
function loadBacktestCosts(): BacktestCostAssumptions {
  try {
    const saved = JSON.parse(localStorage.getItem(BACKTEST_COSTS_KEY) ?? 'null') as Partial<BacktestCostAssumptions> | null;
    if (saved && Number.isFinite(saved.feeBpsPerSide) && Number.isFinite(saved.slippageBpsPerSide)) {
      return { feeBpsPerSide: Math.max(0, saved.feeBpsPerSide!), slippageBpsPerSide: Math.max(0, saved.slippageBpsPerSide!) };
    }
  } catch { /* use the visible baseline assumptions below */ }
  return { feeBpsPerSide: 5.5, slippageBpsPerSide: 2 };
}

export default function App() {
  const [gatewayConnected, setGatewayConnected] = useState<boolean>(false);
  const [marketStatus, setMarketStatus] = useState<ConnectionStatus>('DISCONNECTED');
  const [bestBid, setBestBid] = useState<number | null>(null);
  const [bestAsk, setBestAsk] = useState<number | null>(null);
  const [orderBookBids, setOrderBookBids] = useState<BookLevel[]>([]);
  const [orderBookAsks, setOrderBookAsks] = useState<BookLevel[]>([]);
  const [liveTicker, setLiveTicker] = useState<LiveTicker | null>(null);
  const [lastUpdateTs, setLastUpdateTs] = useState<number | null>(null);
  const [lastTradeAt, setLastTradeAt] = useState<number | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [heatmapSnapshot, setHeatmapSnapshot] = useState<{ samples: BookSample[]; trades: TradeDot[] }>({ samples: [], trades: [] });
  const [tradeReplayBars, setTradeReplayBars] = useState<SerializedFootprintBar[]>([]);
  const [tradeReplayInfo, setTradeReplayInfo] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; sourceTradeCount: number; windowHours: number }>({ status: 'idle', sourceTradeCount: 0, windowHours: 48 });
  const [derivativesSnapshot, setDerivativesSnapshot] = useState<DerivativesPayload | null>(null);
  const [historicalOI, setHistoricalOI] = useState<OIHistoryPoint[]>([]);
  const [historicalOIStatus, setHistoricalOIStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [backtestCosts, setBacktestCosts] = useState<BacktestCostAssumptions>(loadBacktestCosts);
  const [gammaSnapshot, setGammaSnapshot] = useState<GammaSnapshot | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [selectedTimeframe, setSelectedTimeframe] = useState<CandleTimeframe>('1m');
  const supportsFootprint = selectedTimeframe === '1m' || selectedTimeframe === '5m';
  const [displayMode, setDisplayMode] = useState<ChartDisplayMode>('Candles');
  const [profileMode, setProfileMode] = useState<VolumeProfileMode>('Off');
  const [profileViewMode, setProfileViewMode] = useState<VolumeProfileViewMode>('Total Volume');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [heatmapEnabled, setHeatmapEnabled] = useState(true);
  const [smcMenuOpen, setSmcMenuOpen] = useState(false);
  const [smcFeatures, setSmcFeatures] = useState<SmartMoneyFeatures>({ structure: false, liquidity: false, zones: false });
  const smcFeaturesRef = useRef(smcFeatures);
  smcFeaturesRef.current = smcFeatures;
  const smcAnalysisRef = useRef<SmartMoneyAnalysis | null>(null);
  const smcCandlesRef = useRef<CachedCandle[]>([]);
  const gammaSnapshotRef = useRef(gammaSnapshot);
  gammaSnapshotRef.current = gammaSnapshot;
  const heatmapSnapshotRef = useRef(heatmapSnapshot);
  heatmapSnapshotRef.current = heatmapSnapshot;
  const heatmapEnabledRef = useRef(heatmapEnabled);
  heatmapEnabledRef.current = heatmapEnabled;
  const orderBookBidsRef = useRef(orderBookBids);
  orderBookBidsRef.current = orderBookBids;
  const orderBookAsksRef = useRef(orderBookAsks);
  orderBookAsksRef.current = orderBookAsks;
  const backtestTradesRef = useRef<BacktestTrade[]>([]);
  const liveSetupRef = useRef<TradeSetup | null>(null);
  const [fixedProfileRange, setFixedProfileRange] = useState<[number, number] | null>(null);
  const [profileRangeStart, setProfileRangeStart] = useState<number | null>(null);
  const [profileShelfX, setProfileShelfX] = useState(8);
  const profileShelfXRef = useRef(profileShelfX);
  profileShelfXRef.current = profileShelfX;
  const fixedProfileRangeRef = useRef(fixedProfileRange);
  fixedProfileRangeRef.current = fixedProfileRange;
  const profileRangeStartRef = useRef<number | null>(null);
  const profileRangeSelectingRef = useRef(false);
  const profileRangeClickOrderRef = useRef<[number, number] | null>(null);
  const profileDragOffsetRef = useRef<number | null>(null);

  const chooseProfileMode = (mode: VolumeProfileMode) => {
    setProfileMode(mode);
    setProfileMenuOpen(false);
    setProfileShelfX(8);
    profileShelfXRef.current = 8;
    if (mode === 'Range') {
      fixedProfileRangeRef.current = null;
      setFixedProfileRange(null);
      profileRangeStartRef.current = null;
      profileRangeClickOrderRef.current = null;
      setProfileRangeStart(null);
      profileRangeSelectingRef.current = true;
    } else {
      profileRangeSelectingRef.current = false;
    }
  };

  // Persistence & Coverage States
  const [historySyncStatus, setHistorySyncStatus] = useState<'IDLE' | 'SYNCING' | 'SYNCED' | 'FAILED'>('IDLE');
  const [totalCandlesCount, setTotalCandlesCount] = useState<number>(0);
  const [historyRangeText, setHistoryRangeText] = useState<string>('Checking storage...');
  const [latestCandleTime, setLatestCandleTime] = useState<number | null>(null);
  const [isDataDesynced, setIsDataDesynced] = useState<boolean>(false);
  const [zoomWarning, setZoomWarning] = useState<boolean>(false);

  // Jump to Date/Time state
  const [targetDateTime, setTargetDateTime] = useState<string>('');

  // HUD / Crosshair State
  const [crosshairInfo, setCrosshairInfo] = useState<CrosshairBarInfo | null>(null);
  const [isAutoScale, setIsAutoScale] = useState<boolean>(true);
  const [drawingChartApi, setDrawingChartApi] = useState<IChartApi | null>(null);
  const [drawingCandleSeriesApi, setDrawingCandleSeriesApi] = useState<ISeriesApi<'Candlestick'> | null>(null);
  const lastTickerUiUpdateRef = useRef(0);
  const lastBookUiUpdateRef = useRef(0);
  const gatewaySocketRef = useRef<WebSocket | null>(null);

  // Main Chart References
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartWrapperRef = useRef<HTMLDivElement>(null);
  const canvasOverlayRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  // Dedicated Delta Sub-Pane References
  const deltaContainerRef = useRef<HTMLDivElement>(null);
  const deltaChartRef = useRef<IChartApi | null>(null);
  const deltaSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const selectedTimeframeRef = useRef<CandleTimeframe>('1m');
  selectedTimeframeRef.current = selectedTimeframe;
  const selectedSymbolRef = useRef(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;
  useEffect(() => {
    if (gatewaySocketRef.current?.readyState === WebSocket.OPEN) {
      gatewaySocketRef.current.send(JSON.stringify({ type: 'SELECT_SYMBOL', symbol: selectedSymbol }));
    }
  }, [selectedSymbol]);
  const loadedSymbolRef = useRef(selectedSymbol);
  const latestCandleTimeRef = useRef<number | null>(null);

  const displayModeRef = useRef<ChartDisplayMode>('Candles');
  displayModeRef.current = displayMode;
  const profileModeRef = useRef(profileMode);
  profileModeRef.current = profileMode;
  const profileViewModeRef = useRef(profileViewMode);
  profileViewModeRef.current = profileViewMode;

  const candlesCacheRef = useRef<Record<CandleTimeframe, Map<number, CachedCandle>>>(Object.fromEntries(TIMEFRAMES.map((tf) => [tf, new Map()])) as Record<CandleTimeframe, Map<number, CachedCandle>>);

  const footprintBarsRef = useRef<Record<CandleTimeframe, Map<number, SerializedFootprintBar>>>(Object.fromEntries(TIMEFRAMES.map((tf) => [tf, new Map()])) as Record<CandleTimeframe, Map<number, SerializedFootprintBar>>);

  const latestLiveCandleRef = useRef<Record<CandleTimeframe, CachedCandle | null>>(Object.fromEntries(TIMEFRAMES.map((tf) => [tf, null])) as Record<CandleTimeframe, CachedCandle | null>);
  const animationFrameIdRef = useRef<number | null>(null);

  // 1. Footprint Overlay Canvas Renderer
  const renderFootprintOverlay = useCallback(() => {
    const canvas = canvasOverlayRef.current;
    const chart = chartInstanceRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!canvas || !chart || !candleSeries) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const currentMode = displayModeRef.current;
    const currentTimeframe = selectedTimeframeRef.current;

    const dpr = window.devicePixelRatio || 1;
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
      canvas.width = displayWidth * dpr;
      canvas.height = displayHeight * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    // Mark the selected fixed-profile candle range directly on the chart.
    // The connector joins the close of the first clicked candle to the second.
    const selectionTimes = profileRangeClickOrderRef.current;
    const pendingStart = selectionTimes ? null : profileRangeStartRef.current;
    if (profileModeRef.current === 'Range' && (selectionTimes || pendingStart !== null)) {
      const timeScale = chart.timeScale();
      const times = selectionTimes ?? [pendingStart!, pendingStart!];
      const x1 = timeScale.timeToCoordinate(times[0] as Time);
      const rawX2 = timeScale.timeToCoordinate(times[1] as Time);
      const x2 = rawX2 !== null && rawX2 === x1 ? rawX2 + 8 : rawX2;
      if (x1 !== null && x2 !== null) {
        ctx.save();
        if (selectionTimes) {
          const left = Math.min(x1, x2);
          const right = Math.max(x1, x2);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.07)';
          ctx.fillRect(left, 0, Math.max(1, right - left), displayHeight);
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
          ctx.setLineDash([5, 4]);
          for (const x of [x1, x2]) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, displayHeight); ctx.stroke();
          }
          ctx.setLineDash([]);
          const firstCandle = candlesCacheRef.current[currentTimeframe].get(times[0]);
          const secondCandle = candlesCacheRef.current[currentTimeframe].get(times[1]);
          const firstPrice = firstCandle?.close ?? footprintBarsRef.current[currentTimeframe].get(times[0])?.close;
          const secondPrice = secondCandle?.close ?? footprintBarsRef.current[currentTimeframe].get(times[1])?.close;
          const y1 = firstPrice === undefined ? null : candleSeries.priceToCoordinate(firstPrice);
          const y2 = secondPrice === undefined ? null : candleSeries.priceToCoordinate(secondPrice);
          if (y1 !== null && y1 !== undefined && y2 !== null && y2 !== undefined) {
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
            for (const [x, y] of [[x1, y1], [x2, y2]]) {
              ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
              ctx.fillStyle = '#0b0e14'; ctx.fill(); ctx.strokeStyle = '#38bdf8'; ctx.stroke();
            }
          }
        } else {
          ctx.strokeStyle = '#38bdf8';
          ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, displayHeight); ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawVolumeProfile({
      ctx,
      chart,
      candleSeries,
      width: displayWidth,
      height: displayHeight,
      mode: profileModeRef.current,
      viewMode: profileViewModeRef.current,
      symbol: selectedSymbolRef.current,
      bars: footprintBarsRef.current[currentTimeframe === '5m' ? '5m' : '1m'].values(),
      candleTimes: candlesCacheRef.current[currentTimeframe].keys(),
      latestTime: latestCandleTimeRef.current,
      fixedRange: fixedProfileRangeRef.current,
      shelfX: profileShelfXRef.current
    });

    const timeScale = chart.timeScale();

    const smc = smcFeaturesRef.current;
    if (smc.structure || smc.liquidity || smc.zones) {
      drawSmartMoneyOverlay({ ctx, chart, series: candleSeries, width: displayWidth, height: displayHeight, candles: smcCandlesRef.current, features: smc, footprints: footprintBarsRef.current[currentTimeframe], analysis: smcAnalysisRef.current ?? undefined });
    }

    if (heatmapEnabledRef.current) {
      drawOrderBookLiquidityOverlay({ ctx, chart, series: candleSeries, width: displayWidth, height: displayHeight, samples: heatmapSnapshotRef.current.samples, timeframeSeconds: TIMEFRAME_SECONDS[currentTimeframe], liveBids: orderBookBidsRef.current, liveAsks: orderBookAsksRef.current, currentCandleTime: latestCandleTimeRef.current });
    }

    drawBacktestMarkers({ ctx, chart, series: candleSeries, width: displayWidth, height: displayHeight, trades: backtestTradesRef.current, liveSetup: liveSetupRef.current });

    const gamma = gammaSnapshotRef.current;
      if (gamma && gamma.baseCoin === selectedSymbolRef.current.replace(/USDT$/, '')) {
        const byStrike = new Map<number, { calls: number; puts: number; grossGamma: number }>();
        for (const row of gamma.rows) {
          const value = byStrike.get(row.strike) ?? { calls: 0, puts: 0, grossGamma: 0 };
          if (row.optionType === 'CALL') value.calls += row.openInterest;
          else value.puts += row.openInterest;
          if (row.gamma !== null) value.grossGamma += row.gamma * row.openInterest;
          byStrike.set(row.strike, value);
        }
        const levels = [...byStrike.entries()];
        const callWall = levels.reduce<[number, number] | null>((best, [strike, value]) => !best || value.calls > best[1] ? [strike, value.calls] : best, null);
        const putWall = levels.reduce<[number, number] | null>((best, [strike, value]) => !best || value.puts > best[1] ? [strike, value.puts] : best, null);
        const gammaWall = levels.reduce<[number, number] | null>((best, [strike, value]) => !best || value.grossGamma > best[1] ? [strike, value.grossGamma] : best, null);
        const drawOptionLevel = (entry: [number, number] | null, label: string, color: string) => {
          if (!entry || entry[1] <= 0) return;
          const y = candleSeries.priceToCoordinate(entry[0]);
          if (y === null || y < 0 || y > displayHeight) return;
          ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(displayWidth - 4, Math.round(y) + 0.5); ctx.stroke();
          ctx.setLineDash([]); ctx.font = '10px monospace'; ctx.textAlign = 'right';
          ctx.fillText(`${label} ${entry[0].toLocaleString()} · ${gamma.source.split(' ')[0]}`, displayWidth - 8, Math.max(11, y - 3)); ctx.restore();
        };
        drawOptionLevel(callWall, 'CALL OI WALL', '#34d399');
        drawOptionLevel(putWall, 'PUT OI WALL', '#fb7185');
        drawOptionLevel(gammaWall, 'MAX Γ×OI', '#fbbf24');
      }

    if (currentMode === 'Candles') {
      setZoomWarning(false);
      ctx.restore();
      return;
    }

    const currentFootprints = footprintBarsRef.current[currentTimeframe];
    if (currentFootprints.size === 0) {
      ctx.restore();
      return;
    }

    const visibleRange = timeScale.getVisibleLogicalRange();
    if (!visibleRange) {
      ctx.restore();
      return;
    }

    const cachedBars = Array.from(candlesCacheRef.current[currentTimeframe].values()).sort((a, b) => a.time - b.time);
    let barSpacing: number | null = null;

    if (cachedBars.length >= 2) {
      const lastIdx = cachedBars.length - 1;
      const xA = timeScale.timeToCoordinate(cachedBars[lastIdx].time as UTCTimestamp);
      const xB = timeScale.timeToCoordinate(cachedBars[lastIdx - 1].time as UTCTimestamp);
      if (xA !== null && xB !== null) {
        barSpacing = Math.abs(xA - xB);
      }
    }

    if (barSpacing === null) {
      const barsCount = Math.max(visibleRange.to - visibleRange.from, 1);
      barSpacing = displayWidth / barsCount;
    }

    if (barSpacing < 10) {
      setZoomWarning(true);
      if (currentMode === 'Footprint') {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Zoom in (mouse wheel) to inspect Footprint clusters', displayWidth / 2, 40);
      }
      ctx.restore();
      return;
    }

    setZoomWarning(false);
    ctx.font = '10px monospace';

    const renderNumbers = barSpacing >= 28;

    for (const bar of currentFootprints.values()) {
      const xCoord = timeScale.timeToCoordinate(bar.time as UTCTimestamp);
      if (xCoord === null || xCoord < -80 || xCoord > displayWidth + 80) continue;

      const clusterWidth = Math.min(Math.max(barSpacing * 0.90, 20), 160);
      const leftX = xCoord - clusterWidth / 2;
      const colWidth = clusterWidth / 2;

      const openY = candleSeries.priceToCoordinate(bar.open);
      const closeY = candleSeries.priceToCoordinate(bar.close);
      const highY = candleSeries.priceToCoordinate(bar.high);
      const topY = (highY !== null ? highY : Math.min(openY ?? 100, closeY ?? 100)) - 16;

      if (topY > 20 && topY < displayHeight - 40) {
        ctx.fillStyle = bar.delta >= 0 ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(leftX, topY, clusterWidth, 13);
        ctx.fillStyle = bar.delta >= 0 ? '#10b981' : '#ef4444';
        ctx.textAlign = 'center';
        ctx.fillText(`Δ ${bar.delta > 0 ? '+' : ''}${bar.delta.toFixed(1)}`, xCoord, topY + 10);
      }

      // At wide price ranges many 0.1-tick levels map to the same pixels. Combine
      // them into screen-sized rows so volumes stay legible instead of painting
      // thousands of fixed-height rectangles over one another.
      const rowHeight = Math.max(7, Math.min(18, Math.floor(barSpacing * 0.55)));
      const grouped = new Map<number, { y: number; bid: number; ask: number; hasPoc: boolean }>();
      for (const level of bar.priceLevels) {
        const y = candleSeries.priceToCoordinate(level.price);
        if (y === null) continue;
        const row = Math.floor(y / rowHeight);
        const group = grouped.get(row) ?? { y: row * rowHeight + rowHeight / 2, bid: 0, ask: 0, hasPoc: false };
        group.bid += level.bidVolume;
        group.ask += level.askVolume;
        group.hasPoc ||= level.price === bar.pocPrice;
        grouped.set(row, group);
      }

      const rows = Array.from(grouped.values()).sort((a, b) => a.y - b.y);
      const imbalanceRows = rows.map((row) => ({
        bid: row.bid > 0 && row.bid >= row.ask * 3,
        ask: row.ask > 0 && row.ask >= row.bid * 3
      }));
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const rowTop = row.y - rowHeight / 2;
        if (row.y < 8 || row.y > displayHeight - 40) continue;

        ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
        ctx.fillRect(leftX, rowTop, colWidth - 0.5, rowHeight);
        ctx.fillStyle = 'rgba(16, 185, 129, 0.3)';
        ctx.fillRect(xCoord + 0.5, rowTop, colWidth - 0.5, rowHeight);
        ctx.fillStyle = '#334155';
        ctx.fillRect(xCoord - 0.5, rowTop, 1, rowHeight);

        if (row.bid > 0 && imbalanceRows[index].bid) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
          ctx.fillRect(leftX, rowTop, colWidth - 0.5, rowHeight);
        }
        if (row.ask > 0 && imbalanceRows[index].ask) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
          ctx.fillRect(xCoord + 0.5, rowTop, colWidth - 0.5, rowHeight);
        }

        const stackedBid = index >= 2 && imbalanceRows.slice(index - 2, index + 1).every((item) => item.bid);
        const stackedAsk = index >= 2 && imbalanceRows.slice(index - 2, index + 1).every((item) => item.ask);
        if (stackedBid || stackedAsk) {
          ctx.strokeStyle = stackedBid ? '#f87171' : '#4ade80';
          ctx.lineWidth = 1;
          ctx.strokeRect(stackedBid ? leftX : xCoord + 0.5, rowTop, colWidth - 0.5, rowHeight);
        }
        if (row.hasPoc) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX, rowTop, clusterWidth, rowHeight);
        }
        if (renderNumbers && rowHeight >= 9) {
          ctx.fillStyle = '#fee2e2';
          ctx.textAlign = 'center';
          ctx.fillText(row.bid > 0 ? row.bid.toFixed(2) : '0', leftX + colWidth / 2, row.y + 3.5);
          ctx.fillStyle = '#dcfce7';
          ctx.fillText(row.ask > 0 ? row.ask.toFixed(2) : '0', xCoord + colWidth / 2, row.y + 3.5);
        }
      }
    }

    ctx.restore();
  }, []);

  const scheduleOverlayRedraw = useCallback(() => {
    if (animationFrameIdRef.current !== null) {
      cancelAnimationFrame(animationFrameIdRef.current);
    }
    animationFrameIdRef.current = requestAnimationFrame(() => {
      renderFootprintOverlay();
      animationFrameIdRef.current = null;
    });
  }, [renderFootprintOverlay]);

  useEffect(() => {
    scheduleOverlayRedraw();
  }, [profileMode, profileViewMode, selectedSymbol, selectedTimeframe, profileShelfX, fixedProfileRange, smcFeatures, gammaSnapshot, heatmapEnabled, heatmapSnapshot, orderBookBids, orderBookAsks, latestCandleTime, scheduleOverlayRedraw]);

  // 2. Main Chart Initialization
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 420,
      layout: {
        background: { color: '#0b0e14' },
        textColor: '#94a3b8',
        attributionLogo: false
      },
      localization: {
        locale: 'en-IN',
        timeFormatter: formatIndiaCrosshairTime
      },
      grid: {
        vertLines: { color: '#171c26' },
        horzLines: { color: '#171c26' }
      },
      crosshair: {
        vertLine: { color: '#475569', labelBackgroundColor: '#1e293b' },
        horzLine: { color: '#475569', labelBackgroundColor: '#1e293b' }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#1e293b',
        rightOffset: 12,
        barSpacing: 6,
        tickMarkFormatter: formatIndiaTime
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        autoScale: true
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceScaleId: 'right'
    });

    chart.priceScale('right').applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.25
      }
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume'
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0
      }
    });

    chartInstanceRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    setDrawingChartApi(chart);
    setDrawingCandleSeriesApi(candleSeries);

    chart.timeScale().subscribeVisibleTimeRangeChange(() => scheduleOverlayRedraw());
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => scheduleOverlayRedraw());
    chart.subscribeClick((param) => {
      if (!profileRangeSelectingRef.current || typeof param.time !== 'number') return;
      const clickedTime = param.time as number;
      const firstTime = profileRangeStartRef.current;
      if (firstTime === null) {
        profileRangeStartRef.current = clickedTime;
        profileRangeClickOrderRef.current = null;
        setProfileRangeStart(clickedTime);
      } else {
        const selectedRange: [number, number] = [
          Math.min(firstTime, clickedTime),
          Math.max(firstTime, clickedTime) + TIMEFRAME_SECONDS[selectedTimeframeRef.current] - 1
        ];
        profileRangeClickOrderRef.current = [firstTime, clickedTime];
        fixedProfileRangeRef.current = selectedRange;
        setFixedProfileRange(selectedRange);
        profileRangeSelectingRef.current = false;
        profileRangeStartRef.current = null;
        setProfileRangeStart(null);
      }
      scheduleOverlayRedraw();
    });

    const redrawDuringChartGestures = () => scheduleOverlayRedraw();
    chartContainerRef.current.addEventListener('pointermove', redrawDuringChartGestures);
    chartContainerRef.current.addEventListener('pointerup', redrawDuringChartGestures);
    chartContainerRef.current.addEventListener('wheel', redrawDuringChartGestures, { passive: true });
    const chartResizeObserver = new ResizeObserver(redrawDuringChartGestures);
    chartResizeObserver.observe(chartContainerRef.current);

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (!param.time || !param.seriesData || !candleSeriesRef.current) {
        setCrosshairInfo(null);
        return;
      }

      const barData = param.seriesData.get(candleSeriesRef.current) as {
        open?: number;
        high?: number;
        low?: number;
        close?: number;
      } | undefined;

      const volData = volumeSeriesRef.current
        ? (param.seriesData.get(volumeSeriesRef.current) as { value?: number } | undefined)
        : undefined;

      const fpData = footprintBarsRef.current[selectedTimeframeRef.current].get(param.time as number);

      if (barData && barData.open !== undefined && barData.close !== undefined) {
        const dateObj = new Date((param.time as number) * 1000);
        setCrosshairInfo({
          time: dateObj.toLocaleString(),
          open: barData.open,
          high: barData.high ?? barData.open,
          low: barData.low ?? barData.open,
          close: barData.close,
          volume: volData?.value ?? 0,
          delta: fpData?.delta,
          pocPrice: fpData?.pocPrice
        });
      }
    });

    const handleResize = () => {
      if (chartContainerRef.current && chartInstanceRef.current && canvasOverlayRef.current) {
        const width = chartContainerRef.current.clientWidth;
        chartInstanceRef.current.applyOptions({ width });
        canvasOverlayRef.current.width = width;
        scheduleOverlayRedraw();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chartResizeObserver.disconnect();
      chartContainerRef.current?.removeEventListener('pointermove', redrawDuringChartGestures);
      chartContainerRef.current?.removeEventListener('pointerup', redrawDuringChartGestures);
      chartContainerRef.current?.removeEventListener('wheel', redrawDuringChartGestures);
      chart.remove();
      chartInstanceRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      setDrawingChartApi(null);
      setDrawingCandleSeriesApi(null);
      if (animationFrameIdRef.current !== null) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [scheduleOverlayRedraw]);

  // 3. Dedicated Delta Sub-Pane Initialization
  useEffect(() => {
    if (!deltaContainerRef.current) return;

    const deltaChart = createChart(deltaContainerRef.current, {
      width: deltaContainerRef.current.clientWidth,
      height: 140,
      layout: {
        background: { color: '#0b0e14' },
        textColor: '#94a3b8',
        attributionLogo: false
      },
      localization: {
        locale: 'en-IN',
        timeFormatter: formatIndiaCrosshairTime
      },
      grid: {
        vertLines: { color: '#171c26' },
        horzLines: { color: '#171c26' }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#1e293b',
        rightOffset: 12,
        barSpacing: 6,
        tickMarkFormatter: formatIndiaTime
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        autoScale: true
      }
    });

    const deltaSeries = deltaChart.addHistogramSeries({
      color: '#10b981',
      priceFormat: {
        type: 'volume'
      }
    });
    const cvdSeries = deltaChart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 2,
      priceScaleId: 'cvd',
      lastValueVisible: true,
      priceLineVisible: false,
      title: 'CVD'
    });
    deltaChart.priceScale('cvd').applyOptions({
      scaleMargins: { top: 0.08, bottom: 0.08 },
      borderColor: '#1e293b'
    });

    deltaChartRef.current = deltaChart;
    deltaSeriesRef.current = deltaSeries;
    cvdSeriesRef.current = cvdSeries;

    const handleResize = () => {
      if (deltaContainerRef.current && deltaChartRef.current) {
        deltaChartRef.current.applyOptions({
          width: deltaContainerRef.current.clientWidth
        });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      deltaChart.remove();
      deltaChartRef.current = null;
      deltaSeriesRef.current = null;
      cvdSeriesRef.current = null;
    };
  }, []);

  // 4. Visual Mode Toggle
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    if (displayMode === 'Footprint') {
      candleSeriesRef.current.applyOptions({
        upColor: 'rgba(16, 185, 129, 0.08)',
        downColor: 'rgba(239, 68, 68, 0.08)',
        wickUpColor: 'rgba(16, 185, 129, 0.20)',
        wickDownColor: 'rgba(239, 68, 68, 0.20)'
      });
    } else {
      candleSeriesRef.current.applyOptions({
        upColor: '#10b981',
        downColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444'
      });
    }
    scheduleOverlayRedraw();
  }, [displayMode, scheduleOverlayRedraw]);

  // ANCHOR: Automatically scroll to live edge (Rightmost end) without wall-clock drift
  const scrollToLiveEdge = (totalBars: number) => {
    const latestTime = latestCandleTimeRef.current;
    if (!chartInstanceRef.current || totalBars === 0 || latestTime === null) return;
    const windowSize = displayModeRef.current === 'Footprint' ? 22 : 90;
    // Logical indexes count actual candles and keep the initial view consistent
    // even when the exchange history has missing timestamps.
    chartInstanceRef.current.timeScale().setVisibleLogicalRange({
      from: Math.max(0, totalBars - windowSize),
      to: totalBars + 8
    });
  };

  // 5. Load Cached Candles and Sync with REST History
  useEffect(() => {
    let isCancelled = false;

    async function loadAndSync() {
      const timeframe = selectedTimeframe;
      const symbol = selectedSymbol;
      if (loadedSymbolRef.current !== symbol) {
        loadedSymbolRef.current = symbol;
        for (const tf of TIMEFRAMES) {
          candlesCacheRef.current[tf].clear();
          footprintBarsRef.current[tf].clear();
        }
        latestLiveCandleRef.current = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, null])) as Record<CandleTimeframe, CachedCandle | null>;
        latestCandleTimeRef.current = null;
        setLatestCandleTime(null);
        setBestBid(null);
        setBestAsk(null);
        setLiveTicker(null);
        setOrderBookBids([]);
        setOrderBookAsks([]);
        setTrades([]);
        setLastTradeAt(null);
        setCrosshairInfo(null);
        candleSeriesRef.current?.setData([]);
        volumeSeriesRef.current?.setData([]);
        deltaSeriesRef.current?.setData([]);
        cvdSeriesRef.current?.setData([]);
      }
      setHistorySyncStatus('SYNCING');

      // Step A: Load from IndexedDB
      const cached = await loadCandlesFromDB(symbol, timeframe);
      if (!isCancelled && cached.length > 0) {
        for (const c of cached) {
          candlesCacheRef.current[timeframe].set(c.time, c);
        }

        const sorted = Array.from(candlesCacheRef.current[timeframe].values()).sort((a, b) => a.time - b.time);
        latestCandleTimeRef.current = sorted[sorted.length - 1]?.time ?? null;
        setLatestCandleTime(latestCandleTimeRef.current);
        if (candleSeriesRef.current && volumeSeriesRef.current) {
          const chartData = buildCandleChartData(sorted, timeframe);
          candleSeriesRef.current.setData(chartData.candleData);
          volumeSeriesRef.current.setData(chartData.volumeData);

          setTotalCandlesCount(sorted.length);
          requestAnimationFrame(() => scrollToLiveEdge(sorted.length));

          const startStr = new Date(sorted[0].time * 1000).toLocaleDateString();
          const endStr = new Date(sorted[sorted.length - 1].time * 1000).toLocaleDateString();
          setHistoryRangeText(`${startStr} → ${endStr} (${sorted.length.toLocaleString()} cached price candles)`);
          scheduleOverlayRedraw();
        }
      }

      // Step B: REST Historical Fetch
      try {
        // Load captured trade-derived footprints independently of Bybit's candle service.
        try {
          const profileFootprintTimeframe = timeframe === '5m' ? '5m' : '1m';
          const footprintResponse = await fetch(apiUrl(`/api/footprint/history?symbol=${symbol}&timeframe=${profileFootprintTimeframe}`));
          if (footprintResponse?.ok) {
            const footprintPayload = await footprintResponse.json();
            if (Array.isArray(footprintPayload.bars)) {
              const targetStore = footprintBarsRef.current[profileFootprintTimeframe];
              for (const bar of footprintPayload.bars as SerializedFootprintBar[]) {
                if (typeof bar.time === 'number' && Array.isArray(bar.priceLevels)) targetStore.set(bar.time, bar);
              }
              const restored = Array.from(targetStore.values()).sort((a, b) => a.time - b.time);
              if (deltaSeriesRef.current && profileFootprintTimeframe === selectedTimeframeRef.current) {
                deltaSeriesRef.current.setData(restored.map((bar) => ({
                  time: bar.time as UTCTimestamp,
                  value: bar.delta,
                  color: bar.delta >= 0 ? '#10b981' : '#ef4444'
                })));
                cvdSeriesRef.current?.setData(restored.map((bar) => ({
                  time: bar.time as UTCTimestamp,
                  value: bar.cumulativeDelta
                })));
              }
              scheduleOverlayRedraw();
            }
          }
        } catch (footprintError) {
          console.warn('[Sync] Failed to fetch captured footprint history:', footprintError);
        }

        const repairRanges = findCandleRepairRanges(
          Array.from(candlesCacheRef.current[timeframe].values()), timeframe, Date.now()
        );
        let successfulRanges = 0;
        for (const range of repairRanges) {
          if (isCancelled) return;
          const query = new URLSearchParams({
            symbol,
            timeframe,
            start: String(range.startSec * 1000),
            end: String((range.endSec + TIMEFRAME_SECONDS[timeframe]) * 1000 - 1)
          });
          try {
            const response = await fetch(apiUrl(`/api/history?${query.toString()}`));
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const payload = await response.json();
            if (isCancelled) return;
            const freshCandles: CachedCandle[] = Array.isArray(payload.candles) ? payload.candles.map((c: any) => ({
              time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
            })) : [];
            for (const candle of freshCandles) {
              const liveCandle = latestLiveCandleRef.current[timeframe];
              if (!liveCandle || candle.time < liveCandle.time) {
                candlesCacheRef.current[timeframe].set(candle.time, candle);
              } else if (candle.time === liveCandle.time) {
                candlesCacheRef.current[timeframe].set(candle.time, {
                  ...candle,
                  high: Math.max(candle.high, liveCandle.high),
                  low: Math.min(candle.low, liveCandle.low),
                  close: liveCandle.close,
                  volume: Math.max(candle.volume, liveCandle.volume)
                });
              }
            }
            if (freshCandles.length) await saveCandlesToDB(symbol, timeframe, freshCandles);
            successfulRanges++;

            // Paint after each range. Since ranges are newest-first, live bars
            // appear as soon as their small repair request completes.
            const liveCandle = latestLiveCandleRef.current[timeframe];
            if (liveCandle) candlesCacheRef.current[timeframe].set(liveCandle.time, liveCandle);
            const mergedSorted = Array.from(candlesCacheRef.current[timeframe].values()).sort((a, b) => a.time - b.time);
            latestCandleTimeRef.current = Math.max(mergedSorted[mergedSorted.length - 1]?.time ?? 0, liveCandle?.time ?? 0) || null;
            setLatestCandleTime(latestCandleTimeRef.current);
            if (candleSeriesRef.current && volumeSeriesRef.current && mergedSorted.length) {
              const chartData = buildCandleChartData(mergedSorted, timeframe);
              candleSeriesRef.current.setData(chartData.candleData);
              volumeSeriesRef.current.setData(chartData.volumeData);
              if (cached.length === 0) scrollToLiveEdge(mergedSorted.length);
              setTotalCandlesCount(mergedSorted.length);
              const startStr = new Date(mergedSorted[0].time * 1000).toLocaleDateString();
              const endStr = new Date(mergedSorted[mergedSorted.length - 1].time * 1000).toLocaleDateString();
              setHistoryRangeText(`${startStr} → ${endStr} (${mergedSorted.length} verified bars)`);
              setTimeout(() => scheduleOverlayRedraw(), 50);
            }
          } catch (rangeError) {
            console.warn('[Sync] Failed to repair candle range:', range, rangeError);
          }
        }
        if (isCancelled) return;
        setHistorySyncStatus(successfulRanges === repairRanges.length ? 'SYNCED' : (cached.length ? 'SYNCED' : 'FAILED'));
      } catch (err) {
        console.warn('[Sync] Failed to fetch historical REST candles:', err);
        if (!isCancelled) {
          setHistorySyncStatus(cached.length > 0 ? 'SYNCED' : 'FAILED');
          if (cached.length === 0) {
            setHistoryRangeText('Unable to reach Bybit REST. Waiting for feed...');
          }
        }
      }
    }

    loadAndSync();

    return () => {
      isCancelled = true;
    };
  }, [selectedTimeframe, selectedSymbol, scheduleOverlayRedraw]);

  // 6. Live WebSocket Client Ingestion
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let activeSocket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      setMarketStatus('RECONNECTING');
      const ws = new WebSocket(gatewayWebSocketUrl());
      activeSocket = ws;
      gatewaySocketRef.current = ws;

      ws.onopen = () => {
        if (disposed || activeSocket !== ws) return;
        reconnectAttempt = 0;
        setGatewayConnected(true);
        ws.send(JSON.stringify({ type: 'SELECT_SYMBOL', symbol: selectedSymbolRef.current }));
      };
      ws.onclose = () => {
        if (disposed || activeSocket !== ws) return;
        if (gatewaySocketRef.current === ws) gatewaySocketRef.current = null;
        activeSocket = null;
        setGatewayConnected(false);
        setMarketStatus('RECONNECTING');
        setLastTradeAt(null);
        setLiveTicker(null);
        setBestBid(null);
        setBestAsk(null);
        const delayMs = Math.min(1_000 * (2 ** Math.min(reconnectAttempt, 5)), 30_000);
        reconnectAttempt++;
        reconnectTimer = window.setTimeout(connect, delayMs);
      };
      ws.onerror = () => {
        setGatewayConnected(false);
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      };

      ws.onmessage = (event) => {
      if (disposed || activeSocket !== ws) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'STATUS') {
          if (msg.symbol && msg.symbol !== selectedSymbolRef.current) return;
          setMarketStatus(msg.status);
          if ((msg.status === 'DISCONNECTED' || msg.status === 'DESYNCHRONIZED') &&
            (!msg.symbol || msg.symbol === selectedSymbolRef.current)) {
            setBestBid(null);
            setBestAsk(null);
          }
        } else if (msg.type === 'TICKER') {
          if (msg.data?.symbol === selectedSymbolRef.current && Date.now() - lastTickerUiUpdateRef.current >= 500) {
            lastTickerUiUpdateRef.current = Date.now();
            setLiveTicker({ ...msg.data, timestamp: msg.timestamp });
          }
        } else if (msg.type === 'TRADE') {
          const selectedTrades = (msg.data as Trade[]).filter((trade) => trade.symbol === selectedSymbolRef.current);
          if (selectedTrades.length) {
            setLastUpdateTs(msg.timestamp);
            // Show exchange event time, not local message arrival time. A delayed
            // feed must not look live merely because an old packet just arrived.
            const newestExchangeTrade = Math.max(...selectedTrades.map((trade) => trade.timestamp));
            setLastTradeAt((previous) => previous === null ? newestExchangeTrade : Math.max(previous, newestExchangeTrade));
            setTrades((prev) => [...selectedTrades, ...prev].slice(0, 100));
          }
        } else if (msg.type === 'LIQUIDATION') {
          // Liquidation events remain available from the backend API, but they
          // are not shown as execution bubbles: their reported price is bankruptcy price.
        } else if (msg.type === 'ORDERBOOK_SNAPSHOT' || msg.type === 'ORDERBOOK_DELTA') {
          if (msg.data.symbol !== selectedSymbolRef.current) return;
          const shouldUpdateBookUi = Date.now() - lastBookUiUpdateRef.current >= 100;
          if (shouldUpdateBookUi) lastBookUiUpdateRef.current = Date.now();
          if (shouldUpdateBookUi) setLastUpdateTs(msg.timestamp);
          if (shouldUpdateBookUi && msg.data.bestBid !== undefined) setBestBid(msg.data.bestBid);
          if (shouldUpdateBookUi && msg.data.bestAsk !== undefined) setBestAsk(msg.data.bestAsk);
          if (shouldUpdateBookUi && Array.isArray(msg.data.bids)) setOrderBookBids(msg.data.bids as BookLevel[]);
          if (shouldUpdateBookUi && Array.isArray(msg.data.asks)) setOrderBookAsks(msg.data.asks as BookLevel[]);

          const latestLiveCandle = latestLiveCandleRef.current[selectedTimeframeRef.current];
          if (latestLiveCandle && msg.data.bestBid && msg.data.bestAsk) {
            const midpoint = (msg.data.bestBid + msg.data.bestAsk) / 2;
            const diffPct = Math.abs(latestLiveCandle.close - midpoint) / midpoint;
            setIsDataDesynced(diffPct > 0.015);
          }
        } else if (msg.type === 'CANDLE') {
          const c: NormalizedCandle = msg.data;
          if (c.symbol !== selectedSymbolRef.current) return;
          setLastUpdateTs(msg.timestamp);
          void saveCandlesToDB(c.symbol, c.timeframe, [{
            time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
          }]);

          const updatedCandle: CachedCandle = {
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          };
          const previousChartTime = latestCandleTimeRef.current;

          const previousLatest = latestLiveCandleRef.current[c.timeframe];
          if (!previousLatest || c.time >= previousLatest.time) {
            latestLiveCandleRef.current[c.timeframe] = updatedCandle;
          }

          const activeCache = candlesCacheRef.current[c.timeframe];
          activeCache.set(c.time, updatedCandle);
          if (c.timeframe === selectedTimeframeRef.current &&
            (latestCandleTimeRef.current === null || c.time >= latestCandleTimeRef.current)) {
            latestCandleTimeRef.current = c.time;
            setLatestCandleTime(c.time);
          }

          if (c.timeframe === selectedTimeframeRef.current) {
            if (candleSeriesRef.current) {
              if (previousChartTime !== null && c.time < previousChartTime) {
                const sorted = Array.from(activeCache.values()).sort((a, b) => a.time - b.time);
                const chartData = buildCandleChartData(sorted, c.timeframe);
                candleSeriesRef.current.setData(chartData.candleData);
                volumeSeriesRef.current?.setData(chartData.volumeData);
              } else {
                candleSeriesRef.current.update({
                  time: c.time as UTCTimestamp,
                  open: c.open,
                  high: c.high,
                  low: c.low,
                  close: c.close
                });
              }
            }
            if (volumeSeriesRef.current && (previousChartTime === null || c.time >= previousChartTime)) {
              volumeSeriesRef.current.update({
                time: c.time as UTCTimestamp,
                value: c.volume,
                color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
              });
            }
            // The chart already shifts when a new bar arrives. Reapplying a
            // time range for every trade made the live chart visibly jump and
            // repeatedly reset the user's zoom.
          }

        } else if (msg.type === 'FOOTPRINT_BAR') {
          setLastUpdateTs(msg.timestamp);
          const rawTf: unknown = msg.timeframe;

          if (TIMEFRAMES.includes(rawTf as CandleTimeframe)) {
            const tf = rawTf as CandleTimeframe;
            const fp = msg.data as SerializedFootprintBar;
            if (!fp || fp.symbol !== selectedSymbolRef.current) return;
            if (typeof fp.time === 'number' && Array.isArray(fp.priceLevels)) {
              const targetStore = footprintBarsRef.current[tf];
              targetStore.set(fp.time, fp);

              if (targetStore.size > 20_000) {
                const oldestKey = targetStore.keys().next().value;
                if (oldestKey !== undefined) {
                  targetStore.delete(oldestKey);
                }
              }

              if (tf === selectedTimeframeRef.current && deltaSeriesRef.current) {
                const previousDeltaTime = Array.from(targetStore.keys()).reduce((latest, time) => Math.max(latest, time), 0);
                if (fp.time < previousDeltaTime) {
                  const ordered = Array.from(targetStore.values()).sort((a, b) => a.time - b.time);
                  deltaSeriesRef.current.setData(ordered.map((bar) => ({
                    time: bar.time as UTCTimestamp,
                    value: bar.delta,
                    color: bar.delta >= 0 ? '#10b981' : '#ef4444'
                  })));
                  cvdSeriesRef.current?.setData(ordered.map((bar) => ({
                    time: bar.time as UTCTimestamp,
                    value: bar.cumulativeDelta
                  })));
                } else {
                  deltaSeriesRef.current.update({
                    time: fp.time as UTCTimestamp,
                    value: fp.delta,
                    color: fp.delta >= 0 ? '#10b981' : '#ef4444'
                  });
                  cvdSeriesRef.current?.update({
                    time: fp.time as UTCTimestamp,
                    value: fp.cumulativeDelta
                  });
                }
              }
              if (tf === (selectedTimeframeRef.current === '5m' ? '5m' : '1m')) scheduleOverlayRedraw();
            }
          }
        }
      } catch (err) {
        console.error('Failed to parse gateway message:', err);
      }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (gatewaySocketRef.current === activeSocket) gatewaySocketRef.current = null;
      activeSocket?.close();
    };
  }, [scheduleOverlayRedraw]);

  // Jump To Specific Historical Date & Time Action
  const handleJumpToDateTime = () => {
    if (!targetDateTime || !chartInstanceRef.current) return;
    const targetTimestampSec = Math.floor(new Date(targetDateTime).getTime() / 1000);
    const sorted = Array.from(candlesCacheRef.current[selectedTimeframe].values()).sort((a, b) => a.time - b.time);

    const targetIdx = sorted.findIndex((c) => c.time >= targetTimestampSec);
    if (targetIdx !== -1) {
      const windowSize = displayMode === 'Footprint' ? 22 : 80;
      const range = {
        from: Math.max(0, targetIdx - Math.floor(windowSize / 2)),
        to: Math.min(sorted.length, targetIdx + Math.floor(windowSize / 2))
      };
      chartInstanceRef.current.timeScale().setVisibleLogicalRange(range);
      scheduleOverlayRedraw();
    } else {
      alert('Selected date is outside the current 30-day chart history.');
    }
  };

  const handleSelectMode = (mode: ChartDisplayMode) => {
    setDisplayMode(mode);
    if (mode === 'Footprint' && chartInstanceRef.current) {
      const cache = candlesCacheRef.current[selectedTimeframe];
      const totalBars = cache.size;
      if (totalBars > 0) {
        const from = Math.max(0, totalBars - 20);
        const to = totalBars + 4;
        chartInstanceRef.current.timeScale().setVisibleLogicalRange({ from, to });
        setTimeout(() => scheduleOverlayRedraw(), 50);
      }
    } else {
      scheduleOverlayRedraw();
    }
  };

  const handleGoToLive = () => {
    const cache = candlesCacheRef.current[selectedTimeframe];
    scrollToLiveEdge(cache.size);
    scheduleOverlayRedraw();
  };

  const handleToggleAutoScale = () => {
    if (!chartInstanceRef.current) return;
    const nextState = !isAutoScale;
    chartInstanceRef.current.priceScale('right').applyOptions({
      autoScale: nextState
    });
    setIsAutoScale(nextState);
  };

  const handleToggleFullscreen = () => {
    if (!chartWrapperRef.current) return;
    if (!document.fullscreenElement) {
      chartWrapperRef.current.requestFullscreen().catch((err) => console.warn(err));
    } else {
      document.exitFullscreen().catch((err) => console.warn(err));
    }
  };

  const getStatusColor = () => {
    if (marketStatus === 'LIVE') return '#059669';
    if (marketStatus === 'CONNECTING' || marketStatus === 'RECONNECTING') return '#d97706';
    return '#dc2626';
  };

  const activeLatestBar = latestLiveCandleRef.current[selectedTimeframe];
  const tickerForSelected = liveTicker?.symbol === selectedSymbol ? liveTicker : null;
  const baseAsset = selectedSymbol.replace(/USDT$/, '');
  const activeLatestFp = activeLatestBar
    ? footprintBarsRef.current[selectedTimeframe].get(activeLatestBar.time)
    : undefined;
  const onHeatmapSnapshot = useCallback((snapshot: { samples: BookSample[]; trades: TradeDot[] }) => setHeatmapSnapshot(snapshot), []);
  const onDerivativesSnapshot = useCallback((snapshot: DerivativesPayload | null) => setDerivativesSnapshot(snapshot), []);
  const onGammaSnapshot = useCallback((snapshot: GammaSnapshot | null) => setGammaSnapshot(snapshot), []);
  const selectedProfile = useMemo(() => fixedProfileRange
    ? calculateVolumeProfile(footprintBarsRef.current[selectedTimeframe].values(), selectedSymbol, Math.min(...fixedProfileRange), Math.max(...fixedProfileRange))
    : null, [fixedProfileRange, selectedTimeframe, selectedSymbol, lastUpdateTs]);
  const signalCandles = useMemo(() => Array.from(candlesCacheRef.current[selectedTimeframe].values())
    .sort((a, b) => a.time - b.time)
    .map(({ time, open, high, low, close }) => ({ time, open, high, low, close })),
  [selectedTimeframe, selectedSymbol, totalCandlesCount, latestCandleTime]);
  const signalFootprints = useMemo(() => {
    const byTime = new Map<number, SerializedFootprintBar>();
    for (const bar of tradeReplayBars) if (bar.symbol === selectedSymbol && bar.timeframe === selectedTimeframe) byTime.set(bar.time, bar);
    // Exchange-captured persistent bars replace reconstructed values where
    // both sources overlap; the reconstructed raw-trade history fills older gaps.
    for (const bar of footprintBarsRef.current[selectedTimeframe].values()) byTime.set(bar.time, bar);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [tradeReplayBars, selectedTimeframe, selectedSymbol, totalCandlesCount, latestCandleTime]);
  const replayOIHistory = useMemo(() => {
    const points = new Map<string, OIHistoryPoint>();
    for (const point of historicalOI) points.set(String(point.timestamp), point);
    if (derivativesSnapshot?.symbol === selectedSymbol) {
      for (const point of derivativesSnapshot.openInterest) points.set(String(point.timestamp), point);
    }
    return [...points.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [historicalOI, derivativesSnapshot, selectedSymbol]);
  const replayDerivativesSnapshot = useMemo(() => derivativesSnapshot?.symbol === selectedSymbol
    ? { ...derivativesSnapshot, openInterest: replayOIHistory }
    : replayOIHistory.length
      ? { symbol: selectedSymbol, ticker: null, openInterest: replayOIHistory, fundingHistory: [], fetchedAt: Date.now() }
      : null, [derivativesSnapshot, replayOIHistory, selectedSymbol]);
  useEffect(() => {
    if (!supportsFootprint) { setHistoricalOIStatus('idle'); return; }
    let cancelled = false;
    const load = async () => {
      setHistoricalOIStatus('loading');
      try {
            const response = await fetch(apiUrl(`/api/derivatives/history?symbol=${encodeURIComponent(selectedSymbol)}`));
        if (!response.ok) throw new Error('Historical OI unavailable');
        const payload = await response.json() as { symbol: string; openInterest?: OIHistoryPoint[] };
        if (!cancelled && payload.symbol === selectedSymbol && Array.isArray(payload.openInterest)) {
          setHistoricalOI(payload.openInterest);
          setHistoricalOIStatus('ready');
        }
      } catch {
        if (!cancelled) setHistoricalOIStatus('error');
      }
    };
    setHistoricalOI([]);
    void load();
    // A full 30-day cursor scan is intentionally one-shot per symbol. The
    // minute derivatives snapshot is merged above for the freshest points.
    return () => { cancelled = true; };
  }, [selectedSymbol, supportsFootprint]);
  useEffect(() => {
    if (!supportsFootprint) {
      setTradeReplayBars([]);
      setTradeReplayInfo({ status: 'idle', sourceTradeCount: 0, windowHours: 48 });
      return;
    }
    let cancelled = false;
    const timeframe = selectedTimeframe as '1m' | '5m';
    setTradeReplayBars([]);
    setTradeReplayInfo({ status: 'loading', sourceTradeCount: 0, windowHours: 48 });
    void fetch(apiUrl(`/api/footprint/replay?symbol=${encodeURIComponent(selectedSymbol)}&timeframe=${timeframe}&hours=48`))
      .then(async (response) => {
        if (!response.ok) throw new Error('Mongo raw-trade replay unavailable');
        return await response.json() as { symbol: string; timeframe: string; windowHours: number; sourceTradeCount: number; bars: SerializedFootprintBar[] };
      })
      .then((payload) => {
        if (cancelled || payload.symbol !== selectedSymbol || payload.timeframe !== timeframe) return;
        setTradeReplayBars(Array.isArray(payload.bars) ? payload.bars : []);
        setTradeReplayInfo({ status: 'ready', sourceTradeCount: Number(payload.sourceTradeCount) || 0, windowHours: payload.windowHours });
      })
      .catch(() => { if (!cancelled) setTradeReplayInfo({ status: 'error', sourceTradeCount: 0, windowHours: 48 }); });
    return () => { cancelled = true; };
  }, [selectedSymbol, selectedTimeframe, supportsFootprint]);
  const structureCandles = useMemo(() => {
    const interval = TIMEFRAME_SECONDS[selectedTimeframe];
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    return Array.from(candlesCacheRef.current[selectedTimeframe].values())
      .filter((candle) => candle.time >= cutoff && candle.time + interval <= Math.floor(Date.now() / 1000))
      .sort((a, b) => a.time - b.time);
  }, [selectedTimeframe, selectedSymbol, totalCandlesCount, latestCandleTime]);
  smcCandlesRef.current = structureCandles;
  const smartMoneyAnalysis = useMemo(() => analyzeSmartMoney(structureCandles), [structureCandles]);
  smcAnalysisRef.current = smartMoneyAnalysis;
  const publishActivePaperSetup = useCallback((setup: TradeSetup | null) => {
    liveSetupRef.current = setup;
    scheduleOverlayRedraw();
  }, [scheduleOverlayRedraw]);
  const backtestTrades = useMemo(() => supportsFootprint
    ? backtestOrderFlow(signalCandles, signalFootprints, replayOIHistory, selectedSymbol, TIMEFRAME_SECONDS[selectedTimeframe], 1, 43_200, backtestCosts)
    : [], [supportsFootprint, signalCandles, signalFootprints, replayOIHistory, selectedSymbol, selectedTimeframe, backtestCosts]);
  useEffect(() => { localStorage.setItem(BACKTEST_COSTS_KEY, JSON.stringify(backtestCosts)); }, [backtestCosts]);
  backtestTradesRef.current = backtestTrades;
  useEffect(() => { scheduleOverlayRedraw(); }, [backtestTrades, scheduleOverlayRedraw]);
  useEffect(() => { scheduleOverlayRedraw(); }, [smartMoneyAnalysis, scheduleOverlayRedraw]);

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace', maxWidth: '1240px', margin: '0 auto', color: '#e2e8f0' }}>
      {/* Top Header */}
      <header style={{ borderBottom: '1px solid #1e293b', paddingBottom: '12px', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>FlowTerminal — Professional Market Terminal</h2>
        <div style={{ display: 'flex', gap: '20px', marginTop: '8px', fontSize: '13px', alignItems: 'center' }}>
          <div>Local Gateway: <strong>{gatewayConnected ? 'CONNECTED' : 'DISCONNECTED'}</strong></div>
          <div>Contract: <strong>{selectedSymbol} · {MARKETS.find((market) => market.symbol === selectedSymbol)?.name} (Bybit Linear Perp)</strong></div>
          <div>
            Market Status:{' '}
            <span style={{ backgroundColor: getStatusColor(), padding: '2px 8px', borderRadius: '4px', fontWeight: 'bold' }}>
              {marketStatus}
            </span>
          </div>
          <div>
            History Sync:{' '}
            <span style={{ color: historySyncStatus === 'SYNCED' ? '#10b981' : historySyncStatus === 'SYNCING' ? '#38bdf8' : '#f59e0b', fontWeight: 'bold' }}>
              {historySyncStatus}
            </span>
          </div>
          {isDataDesynced && (
            <div style={{ background: '#78350f', color: '#fef3c7', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>
              WARN: DESYNC DRIFT
            </div>
          )}
        </div>
      </header>

      <RecorderStatus />

      {/* Depth & Coverage Metric Cards */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '16px' }}>
        <div style={{ background: '#111827', padding: '12px', borderRadius: '6px', border: '1px solid #1f2937' }}>
          <div style={{ color: '#94a3b8', fontSize: '11px' }}>BEST BID</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981', marginTop: '2px' }}>
            {bestBid !== null ? bestBid.toFixed(2) : '-'}
          </div>
        </div>
        <div style={{ background: '#111827', padding: '12px', borderRadius: '6px', border: '1px solid #1f2937' }}>
          <div style={{ color: '#94a3b8', fontSize: '11px' }}>BEST ASK</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444', marginTop: '2px' }}>
            {bestAsk !== null ? bestAsk.toFixed(2) : '-'}
          </div>
        </div>
        <div style={{ background: '#111827', padding: '12px', borderRadius: '6px', border: '1px solid #1f2937' }}>
          <div style={{ color: '#94a3b8', fontSize: '11px' }}>SPREAD</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#f1f5f9', marginTop: '2px' }}>
            {bestBid !== null && bestAsk !== null ? (bestAsk - bestBid).toFixed(2) : '-'}
          </div>
        </div>
        <div style={{ background: '#111827', padding: '12px', borderRadius: '6px', border: '1px solid #1f2937' }}>
          <div style={{ color: '#94a3b8', fontSize: '11px' }}>CANDLE HISTORY</div>
          <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#38bdf8', marginTop: '4px' }}>
            {totalCandlesCount} Bars
          </div>
        </div>
      </section>

      {/* Main Professional Chart Section */}
      <section
        ref={chartWrapperRef}
        style={{ background: '#0b0e14', border: '1px solid #1e293b', borderRadius: '6px', padding: '14px', marginBottom: '20px', position: 'relative' }}
      >
        {/* Navigation & Mode Selection Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#94a3b8' }}>Interval:</span>
            {TIMEFRAMES.map((timeframe) => (
              <button key={timeframe} onClick={() => {
                setSelectedTimeframe(timeframe);
                if (timeframe !== '1m' && timeframe !== '5m') handleSelectMode('Candles');
              }} style={{
                background: selectedTimeframe === timeframe ? '#2563eb' : '#1e293b', color: '#fff', border: 'none',
                padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
                fontWeight: 'bold', fontSize: '12px'
              }}>{timeframe}</button>
            ))}

            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#94a3b8', marginLeft: '12px' }}>Mode:</span>
            <button
              onClick={() => handleSelectMode('Candles')}
              style={{
                background: displayMode === 'Candles' ? '#0284c7' : '#1e293b',
                color: '#fff',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Candles
            </button>
            <button
              disabled={!supportsFootprint}
              onClick={() => handleSelectMode('Footprint')}
              style={{
                background: displayMode === 'Footprint' ? '#0284c7' : '#1e293b',
                color: '#fff',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '4px',
                cursor: supportsFootprint ? 'pointer' : 'not-allowed', opacity: supportsFootprint ? 1 : 0.45,
                fontWeight: 'bold',
                fontSize: '12px'
              }}
            >
              Footprint
            </button>
            <button
              disabled={!supportsFootprint}
              onClick={() => handleSelectMode('Combined')}
              style={{
                background: displayMode === 'Combined' ? '#0284c7' : '#1e293b',
                color: '#fff',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '4px',
                cursor: supportsFootprint ? 'pointer' : 'not-allowed', opacity: supportsFootprint ? 1 : 0.45,
                fontSize: '12px'
              }}
            >
              Combined
            </button>
            <button
              onClick={() => setHeatmapEnabled((enabled) => !enabled)}
              style={{
                background: heatmapEnabled ? '#0f766e' : '#1e293b',
                color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px',
                cursor: 'pointer', fontSize: '12px', marginLeft: '4px'
              }}
              title="Show bid/ask liquidity bands and persistent walls directly on the candle chart"
            >
              Heatmap {heatmapEnabled ? 'ON' : 'OFF'}
            </button>
            {heatmapEnabled && <span style={{ fontSize: 9, color: '#64748b' }}><span style={{ color: '#22d3ee' }}>■ BID</span> · <span style={{ color: '#c084fc' }}>■ ASK</span> · dotted = persistent wall</span>}

            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                aria-expanded={smcMenuOpen}
                onClick={() => setSmcMenuOpen((open) => !open)}
                style={{ background: smcFeatures.structure || smcFeatures.liquidity || smcFeatures.zones ? '#0f766e' : '#1e293b', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >SMC / ICT ▾</button>
              {smcMenuOpen && <div style={{ position: 'absolute', left: 0, top: 30, width: 244, zIndex: 20, padding: 9, background: 'rgba(11,14,20,.98)', border: '1px solid #334155', borderRadius: 6, boxShadow: '0 8px 28px #000a', color: '#cbd5e1' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, margin: '2px 2px 7px' }}>CHART STUDIES</div>
                {([
                  ['structure', 'BOS · CHoCH · MSS'],
                  ['liquidity', 'Equal highs/lows · sweeps'],
                  ['zones', 'Fair value gaps · order blocks']
                ] as const).map(([key, label]) => <label key={key} style={{ display: 'flex', gap: 7, alignItems: 'center', margin: '8px 2px', fontSize: 10, cursor: 'pointer' }}>
                  <input type="checkbox" checked={smcFeatures[key]} onChange={(event) => setSmcFeatures((current) => ({ ...current, [key]: event.target.checked }))} />{label}
                </label>)}
                <div style={{ margin: '8px 2px 1px', fontSize: 9, lineHeight: 1.6 }}>
                  <div><span style={{ color: '#60a5fa' }}>BOS</span> · <span style={{ color: '#fbbf24' }}>CHoCH</span> · <span style={{ color: '#c084fc' }}>MSS</span></div>
                  <div><span style={{ color: '#f97316' }}>Inducement</span> · <span style={{ color: '#22d3ee' }}>FVG</span> · <span style={{ color: '#a855f7' }}>Order block</span></div>
                  <div><span style={{ color: '#fbbf24' }}>PDH / PDL</span> · prior-day range; midpoint separates premium and discount</div>
                  <div><span style={{ color: '#cbd5e1' }}>PO3 ACC</span> → <span style={{ color: '#f97316' }}>MANIP</span> → <span style={{ color: '#34d399' }}>DIST</span> only after sequence confirms</div>
                  <div style={{ color: '#64748b', marginTop: 4 }}>BOS/CHoCH lines run from the confirmed swing to the break candle. EQH/EQL needs 2+ confirmed touches and a pullback. Structure is closed-candle only; inducement is labeled after its confirming break.</div>
                </div>
              </div>}
            </div>

            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => !open)}
                style={{ background: profileMode === 'Off' ? '#1e293b' : '#4c1d95', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >Volume Profile ▾{profileMode !== 'Off' ? ` · ${profileMode}` : ''}</button>
              {profileMenuOpen && <div style={{ position: 'absolute', left: 0, top: 30, width: 220, zIndex: 20, maxHeight: '66vh', overflowY: 'auto', padding: 9, background: 'rgba(11,14,20,.98)', border: '1px solid #334155', borderRadius: 6, boxShadow: '0 8px 28px #000a', color: '#cbd5e1' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, margin: '2px 2px 6px' }}>MANUAL PROFILE</div>
                {(['Off', 'Range'] as const).map((mode) => (
                  <button key={mode} onClick={() => chooseProfileMode(mode)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, padding: '6px 8px', background: profileMode === mode ? '#4c1d95' : '#172033', border: '1px solid #334155', borderRadius: 4, color: '#e2e8f0', cursor: 'pointer', fontSize: 11 }}>
                    {mode === 'Range' ? 'Select candle range' : 'Off · hide profile'}
                  </button>
                ))}
                {profileMode === 'Range' && <div style={{ margin: '4px 2px 10px', color: '#c4b5fd', fontSize: 10, lineHeight: 1.5 }}>
                  {profileRangeStart !== null ? 'Step 2/2 · click the ending candle. Click the same candle again for its full profile.' : fixedProfileRange ? 'Range selected · choose Select candle range again to change it.' : 'Click the starting candle, then the ending candle. For one candle, click it twice.'}
                </div>}
                {profileMode !== 'Off' && <>
                  <label style={{ display: 'block', fontSize: 10, color: '#94a3b8', fontWeight: 700, margin: '8px 2px 5px' }}>PROFILE DISPLAY</label>
                  <select value={profileViewMode} onChange={(event) => setProfileViewMode(event.target.value as VolumeProfileViewMode)} style={{ width: '100%', padding: 6, color: '#e2e8f0', background: '#172033', border: '1px solid #475569', borderRadius: 4, fontSize: 11 }}>
                    <option value="Total Volume">Volume · classic</option>
                    <option value="Bid x Ask Split">Bid × Ask · red / green</option>
                    <option value="Net Delta">Net delta · red / green</option>
                  </select>
                </>}
                <div style={{ margin: '8px 2px 1px', color: '#64748b', fontSize: 9, lineHeight: 1.45 }}>Works on every chart interval. Profile uses locally recorded trades; a range with missing recording will be marked partial.</div>
              </div>}
            </div>

            <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '6px' }}>
              Coverage: {historyRangeText}
            </span>
            <span style={{ fontSize: '11px', color: '#38bdf8', marginLeft: '6px' }}>
              Latest candle: {latestCandleTime !== null ? new Date(latestCandleTime * 1000).toLocaleString() : 'waiting for data'}
            </span>
            <span style={{ fontSize: '11px', color: '#a5b4fc', marginLeft: '6px' }}>
              Bybit last: {tickerForSelected?.lastPrice?.toFixed(2) ?? '—'}
              {tickerForSelected?.markPrice ? ` · Mark: ${tickerForSelected.markPrice.toFixed(2)}` : ''}
              {activeLatestBar && tickerForSelected?.lastPrice ? ` · chart diff: ${(activeLatestBar.close - tickerForSelected.lastPrice).toFixed(2)}` : ''}
              {tickerForSelected ? ` · ${Math.max(0, Math.round((Date.now() - tickerForSelected.timestamp) / 1000))}s` : ' · waiting for Bybit ticker'}
              {` · trades ${lastTradeAt === null ? 'waiting' : `${Math.max(0, Math.round((Date.now() - lastTradeAt) / 1000))}s ago`}`}
            </span>

            {zoomWarning && displayMode !== 'Candles' && (
              <span style={{ fontSize: '11px', color: '#f59e0b', marginLeft: '8px' }}>
                [Zoom in to inspect numbers]
              </span>
            )}
          </div>

          {/* Jump to Date & Scale Action Buttons */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="datetime-local"
              value={targetDateTime}
              onChange={(e) => setTargetDateTime(e.target.value)}
              style={{
                background: '#111827',
                color: '#94a3b8',
                border: '1px solid #334155',
                padding: '3px 6px',
                borderRadius: '4px',
                fontSize: '11px',
                fontFamily: 'monospace'
              }}
            />
            <button
              onClick={handleJumpToDateTime}
              style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              Jump
            </button>

            <button
              onClick={handleGoToLive}
              style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #334155', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
            >
              Go to Live
            </button>
            <button
              onClick={handleToggleAutoScale}
              style={{ background: isAutoScale ? '#1e293b' : '#374151', color: isAutoScale ? '#10b981' : '#9ca3af', border: '1px solid #334155', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              Auto-Scale: {isAutoScale ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={handleToggleFullscreen}
              style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              ⛶
            </button>
          </div>
        </div>

        <div aria-label="Select market for candle chart and heatmap" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, margin: '0 0 8px', padding: '6px 8px', border: '1px solid #1f2937', borderRadius: 4, background: '#0a1019' }}>
          <span style={{ marginRight: 4, color: '#94a3b8', fontSize: 10, fontWeight: 700 }}>CHART + HEATMAP</span>
          {MARKETS.map((market) => <button
            key={market.symbol}
            aria-pressed={selectedSymbol === market.symbol}
            title={`${market.name} · ${market.symbol}`}
            onClick={() => setSelectedSymbol(market.symbol)}
            style={{ background: selectedSymbol === market.symbol ? '#1d4ed8' : '#172033', color: selectedSymbol === market.symbol ? '#fff' : '#cbd5e1', border: `1px solid ${selectedSymbol === market.symbol ? '#3b82f6' : '#334155'}`, borderRadius: 4, padding: '4px 7px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 10, fontWeight: selectedSymbol === market.symbol ? 800 : 600 }}
          >{market.symbol}</button>)}
        </div>

        {/* OHLCV & Footprint Delta HUD Strip */}
        <div style={{ background: '#111827', padding: '6px 12px', borderRadius: '4px', marginBottom: '8px', fontSize: '12px', display: 'flex', gap: '14px', flexWrap: 'wrap', border: '1px solid #1f2937' }}>
          <div>
            Time: <span style={{ color: '#f1f5f9' }}>{crosshairInfo ? crosshairInfo.time : activeLatestBar ? new Date(activeLatestBar.time * 1000).toLocaleTimeString() : '-'}</span>
          </div>
          <div>
            O: <span style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{crosshairInfo ? crosshairInfo.open.toFixed(2) : activeLatestBar ? activeLatestBar.open.toFixed(2) : '-'}</span>
          </div>
          <div>
            H: <span style={{ color: '#10b981', fontWeight: 'bold' }}>{crosshairInfo ? crosshairInfo.high.toFixed(2) : activeLatestBar ? activeLatestBar.high.toFixed(2) : '-'}</span>
          </div>
          <div>
            L: <span style={{ color: '#ef4444', fontWeight: 'bold' }}>{crosshairInfo ? crosshairInfo.low.toFixed(2) : activeLatestBar ? activeLatestBar.low.toFixed(2) : '-'}</span>
          </div>
          <div>
            C: <span style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{crosshairInfo ? crosshairInfo.close.toFixed(2) : activeLatestBar ? activeLatestBar.close.toFixed(2) : '-'}</span>
          </div>
          <div>
            Vol: <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{crosshairInfo ? crosshairInfo.volume.toFixed(3) : activeLatestBar ? activeLatestBar.volume.toFixed(3) : '-'} {baseAsset}</span>
          </div>
          <div>
            Bar Delta:{' '}
            <span
              style={{
                color: (crosshairInfo?.delta ?? activeLatestFp?.delta ?? 0) >= 0 ? '#10b981' : '#ef4444',
                fontWeight: 'bold'
              }}
            >
              {crosshairInfo?.delta !== undefined
                ? `${crosshairInfo.delta > 0 ? '+' : ''}${crosshairInfo.delta.toFixed(3)}`
                : activeLatestFp?.delta !== undefined
                ? `${activeLatestFp.delta > 0 ? '+' : ''}${activeLatestFp.delta.toFixed(3)}`
                : '-'}
            </span>
          </div>
          <div>
            POC:{' '}
            <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>
              {crosshairInfo?.pocPrice ?? activeLatestFp?.pocPrice ?? '-'}
            </span>
          </div>
          <div style={{ marginLeft: 'auto', color: '#64748b', fontSize: '11px' }}>
            {lastUpdateTs ? `Tick: ${new Date(lastUpdateTs).toLocaleTimeString()}` : ''}
          </div>
        </div>

        {/* 1. Main Candlestick + Footprint Overlay Container */}
        <div style={{ position: 'relative', width: '100%', height: '420px', borderBottom: '1px solid #1e293b' }}>
          <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
          <canvas
            ref={canvasOverlayRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              zIndex: 2
            }}
          />
          {profileMode !== 'Off' && (
            <div
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                profileDragOffsetRef.current = event.clientX - rect.left;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (profileDragOffsetRef.current === null || !chartContainerRef.current) return;
                const chartRect = chartContainerRef.current.getBoundingClientRect();
                const nextX = Math.max(4, Math.min(chartRect.width - 210, event.clientX - chartRect.left - profileDragOffsetRef.current));
                profileShelfXRef.current = nextX;
                setProfileShelfX(nextX);
                scheduleOverlayRedraw();
              }}
              onPointerUp={() => { profileDragOffsetRef.current = null; }}
              onPointerCancel={() => { profileDragOffsetRef.current = null; }}
              style={{
                position: 'absolute', top: 4, left: profileShelfX, zIndex: 5,
                padding: '3px 7px', borderRadius: 4, border: '1px solid #475569',
                background: 'rgba(15,23,42,.92)', color: '#cbd5e1', fontSize: 10,
                cursor: 'grab', touchAction: 'none', userSelect: 'none'
              }}
              title="Drag to move the volume profile"
            >
              ⠿ Profile · drag
            </div>
          )}
          <ChartDrawingLayer
            chart={drawingChartApi}
            candleSeries={drawingCandleSeriesApi}
            symbol={selectedSymbol}
            timeframe={selectedTimeframe}
            candleCache={candlesCacheRef.current[selectedTimeframe]}
            latestTime={latestCandleTime}
            footprints={footprintBarsRef.current[selectedTimeframe]}
          />
        </div>

        {/* Order-flow pane is backed by captured trade clusters for 1m/5m only. */}
        {supportsFootprint ? <div style={{ marginTop: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', fontSize: '11px', color: '#94a3b8' }}>
            <span style={{ fontWeight: 'bold' }}>DELTA BARS + CVD</span>
            <span>Delta: green = buyers, red = sellers · Book liquidity is overlaid on candles when Heatmap is ON</span>
          </div>
          <div ref={deltaContainerRef} style={{ width: '100%', height: '140px' }} />
        </div> : <div style={{ marginTop: 8, color: '#64748b', fontSize: 11 }}>
          Delta, CVD and footprint data are available on 1m and 5m intervals.
        </div>}
      </section>

      <OrderBookHeatmap symbol={selectedSymbol} enabled={heatmapEnabled} renderPanel={false} onSnapshot={onHeatmapSnapshot} />

      <AlertManager symbol={selectedSymbol} price={activeLatestBar?.close ?? null} delta={activeLatestFp?.delta ?? null} />
      {supportsFootprint && <AgentCouncilPanel
        symbol={selectedSymbol}
        timeframe={selectedTimeframe === '5m' ? '5m' : '1m'}
        feedStatus={marketStatus}
        lastTradeAt={lastTradeAt}
        price={tickerForSelected?.lastPrice ?? activeLatestBar?.close ?? null}
        candles={signalCandles}
        footprints={signalFootprints}
        trades={trades}
        bids={orderBookBids}
        asks={orderBookAsks}
        analysis={smartMoneyAnalysis}
      />}
      <EntryExitSignals
        symbol={selectedSymbol}
        timeframe={selectedTimeframe}
        candles={signalCandles}
        footprints={signalFootprints}
        bids={orderBookBids}
        asks={orderBookAsks}
        price={tickerForSelected?.lastPrice ?? activeLatestBar?.close ?? null}
        feedStatus={marketStatus}
        lastTradeAt={lastTradeAt}
        context={{ profile: selectedProfile, heatmap: heatmapSnapshot, derivatives: replayDerivativesSnapshot, gamma: gammaSnapshot?.baseCoin === selectedSymbol.replace(/USDT$/, '') ? gammaSnapshot : null }}
        backtestTrades={backtestTrades}
        costs={backtestCosts}
        onCostsChange={setBacktestCosts}
        tradeReplayInfo={{ ...tradeReplayInfo, barsCount: tradeReplayBars.length }}
        historicalOIStatus={historicalOIStatus}
        onLiveSetupChange={publishActivePaperSetup}
      />

      <section style={{ marginTop: 16 }}>
        <DOMLadder symbol={selectedSymbol} bids={orderBookBids} asks={orderBookAsks} />
        <IcebergSignals symbol={selectedSymbol} trades={trades} bids={orderBookBids} asks={orderBookAsks} />
      </section>
      <DerivativesPanel symbol={selectedSymbol} onSnapshot={onDerivativesSnapshot} />
      <GammaLevelsPanel symbol={selectedSymbol} onSnapshot={onGammaSnapshot} />

      {/* Verified Trades Stream Table */}
      <section>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Verified Public Trades Stream</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
              <th style={{ padding: '6px' }}>Time</th>
              <th style={{ padding: '6px' }}>Side</th>
              <th style={{ padding: '6px' }}>Price (USDT)</th>
              <th style={{ padding: '6px' }}>Size ({baseAsset})</th>
              <th style={{ padding: '6px' }}>Trade ID</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
                  No trades received yet.
                </td>
              </tr>
            ) : (
              trades.slice(0, 15).map((t, idx) => (
                <tr key={`${t.tradeId}-${idx}`} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '4px 6px' }}>{new Date(t.timestamp).toLocaleTimeString()}</td>
                  <td style={{ padding: '4px 6px', color: t.side === 'Buy' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                    {t.side}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{t.price.toFixed(2)}</td>
                  <td style={{ padding: '4px 6px' }}>{t.size.toFixed(3)}</td>
                  <td style={{ padding: '4px 6px', color: '#64748b', fontSize: '11px' }}>{t.tradeId}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
