/**
 * FlowTerminal - Client-Side IndexedDB Storage
 * Scope: Persistence for Historical and Live Candlesticks across page refreshes
 */

export interface CachedCandle {
  time: number; // Unix timestamp in seconds (Key)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const DB_NAME = 'flowterminal_db';
const DB_VERSION = 2;
const STORE_NAME = 'candles';
const DRAWINGS_STORE = 'drawings';
const CANDLE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type DrawingTool = 'horizontal' | 'trendline' | 'rectangle' | 'vertical' | 'text' | 'measure' | 'long' | 'short' | 'fib';
export interface DrawingPoint { time: number; price: number; }
export interface StoredChartDrawing {
  id: string;
  symbol: string;
  timeframe: string;
  type: DrawingTool;
  points: DrawingPoint[];
  color: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  locked?: boolean;
  hidden?: boolean;
  text?: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Compound Key: `${symbol}_${timeframe}_${time}`
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DRAWINGS_STORE)) db.createObjectStore(DRAWINGS_STORE, { keyPath: 'id' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDrawingsFromDB(symbol: string, timeframe: string): Promise<StoredChartDrawing[]> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DRAWINGS_STORE, 'readonly').objectStore(DRAWINGS_STORE).getAll();
      request.onsuccess = () => resolve((request.result as StoredChartDrawing[]).filter((drawing) =>
        drawing.symbol === symbol && drawing.timeframe === timeframe));
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('[IndexedDB] Failed to load chart drawings:', error);
    return [];
  }
}

export async function saveDrawingsToDB(symbol: string, timeframe: string, drawings: StoredChartDrawing[]): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DRAWINGS_STORE, 'readwrite');
      const store = transaction.objectStore(DRAWINGS_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        for (const drawing of request.result as StoredChartDrawing[]) {
          if (drawing.symbol === symbol && drawing.timeframe === timeframe) store.delete(drawing.id);
        }
        for (const drawing of drawings) store.put(drawing);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn('[IndexedDB] Failed to save chart drawings:', error);
  }
}

export async function saveCandlesToDB(
  symbol: string,
  timeframe: string,
  candles: CachedCandle[]
): Promise<void> {
  if (candles.length === 0) return;

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      for (const c of candles) {
        store.put({
          id: `${symbol}_${timeframe}_${c.time}`,
          symbol,
          timeframe,
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume
        });
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (err) {
    console.warn('[IndexedDB] Failed to save candles:', err);
  }
}

export async function loadCandlesFromDB(
  symbol: string,
  timeframe: string
): Promise<CachedCandle[]> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      const cutoff = Math.floor(Date.now() / 1000) - CANDLE_RETENTION_SECONDS;

      request.onsuccess = () => {
        const records = request.result as Array<{
          symbol: string;
          timeframe: string;
          time: number;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
        }>;

        const filtered = records
          .filter((r) => {
            if (r.time < cutoff) { store.delete(`${r.symbol}_${r.timeframe}_${r.time}`); return false; }
            return r.symbol === symbol && r.timeframe === timeframe;
          })
          .map((r) => ({
            time: r.time,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume
          }))
          .sort((a, b) => a.time - b.time);

        resolve(filtered);
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IndexedDB] Failed to load candles from storage:', err);
    return [];
  }
}
