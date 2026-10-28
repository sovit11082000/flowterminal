import { MongoClient, type Collection, type Document } from 'mongodb';
import type { NormalizedCandle, SerializedFootprintBar, NormalizedTrade, NormalizedLiquidation } from '../types/market.js';
import type { OrderBookSample } from './orderBookHistoryStore.js';
import type { CouncilResult, AgentSnapshot } from '../agents/orderFlowCouncil.js';

type Stored<T> = T & { _id: string; expiresAt: Date };
const FOOTPRINT_RETENTION_MS = 24 * 60 * 60 * 1000;
const OTHER_DATA_RETENTION_MS = 48 * 60 * 60 * 1000;
const ORDER_BOOK_RETENTION_MS = 24 * 60 * 60 * 1000;
const ORDER_BOOK_PERSIST_INTERVAL_MS = 15_000;
const ORDER_BOOK_LEVELS_PER_SIDE = 5;
const RETENTION_POLICY_ID = 'retention-policy-1d-footprints-1d-orderbook-48h-other-v3';
const PREVIOUS_RETENTION_POLICY_IDS = [
  'retention-policy-1d-footprints-48h-other-v2',
  'retention-policy-5d-footprints-48h-other-v1'
];
export interface AgentPaperPerformance {
  resolved: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number | null;
  averageR: number | null;
  recent: Array<{ side: 'LONG' | 'SHORT'; outcome: 'WIN' | 'LOSS'; pnlR: number }>;
}

/** MongoDB persistence for records captured after the service connects. It never imports local JSONL files. */
export class MongoHistoryStore {
  private readonly client: MongoClient | null;
  private readonly databaseName: string;
  private db: ReturnType<MongoClient['db']> | null = null;
  private readonly collectionNames = {
    footprints: 'footprints', trades: 'trades', orderBooks: 'order_books', liquidations: 'liquidations'
  } as const;
  private lastCapCheckAt = new Map<string, number>();
  private readonly lastOrderBookSavedAt = new Map<string, number>();

  constructor(uri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DATABASE || 'flowterminal') {
    this.client = uri ? new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 5 }) : null;
    this.databaseName = databaseName;
  }

  get enabled(): boolean { return this.client !== null; }
  get connected(): boolean { return this.db !== null; }

  async connect(): Promise<void> {
    if (!this.client) {
      console.warn('[MongoDB] MONGODB_URI is not set; recording will remain local only.');
      return;
    }
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    await Promise.all([
      this.collection('footprints').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('footprints').createIndex({ symbol: 1, timeframe: 1, time: 1 }, { unique: true }),
      this.collection('trades').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('trades').createIndex({ symbol: 1, timestamp: 1 }),
      this.collection('trades').createIndex({ symbol: 1, tradeId: 1 }, { unique: true }),
      this.collection('orderBooks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('orderBooks').createIndex({ symbol: 1, time: 1 }),
      this.collection('liquidations').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('liquidations').createIndex({ symbol: 1, timestamp: 1 }),
      this.collection('agent_decisions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('agent_decisions').createIndex({ symbol: 1, timeframe: 1, status: 1, generatedAt: 1 })
    ]);
    try {
      await this.applyRetentionPolicy();
    } catch (error) {
      console.warn('[MongoDB] Could not apply retention cleanup; new footprints will still expire after 24 hours:', error);
    }
    console.log(`[MongoDB] Connected to database "${this.databaseName}". Existing local files were not imported.`);
  }

  async close(): Promise<void> { await this.client?.close(); this.db = null; }

  async saveFootprint(bar: SerializedFootprintBar): Promise<void> {
    if (!this.db || !bar.isClosed) return;
    const expiresAt = new Date(bar.time * 1000 + FOOTPRINT_RETENTION_MS);
    await this.collection('footprints').replaceOne(
      { symbol: bar.symbol, timeframe: bar.timeframe, time: bar.time },
      { ...bar, expiresAt }, { upsert: true }
    );
    await this.enforceCap('footprints', 100_000);
  }

  async saveTrades(trades: NormalizedTrade[]): Promise<void> {
    if (!this.db || !trades.length) return;
    const collection = this.collection('trades');
    await collection.bulkWrite(trades.map((trade) => ({
      updateOne: {
        filter: { symbol: trade.symbol, tradeId: trade.tradeId },
        update: { $setOnInsert: { ...trade, expiresAt: new Date(trade.timestamp + OTHER_DATA_RETENTION_MS) } },
        upsert: true
      }
    })), { ordered: false });
    await this.enforceCap('trades', 500_000);
  }

  async saveOrderBook(sample: OrderBookSample): Promise<void> {
    if (!this.db) return;
    const lastSaved = this.lastOrderBookSavedAt.get(sample.symbol) ?? 0;
    if (sample.time - lastSaved < ORDER_BOOK_PERSIST_INTERVAL_MS) return;
    this.lastOrderBookSavedAt.set(sample.symbol, sample.time);
    await this.collection('orderBooks').insertOne({
      ...sample,
      bids: sample.bids.slice(0, ORDER_BOOK_LEVELS_PER_SIDE),
      asks: sample.asks.slice(0, ORDER_BOOK_LEVELS_PER_SIDE),
      expiresAt: new Date(sample.time + ORDER_BOOK_RETENTION_MS)
    });
    await this.enforceCap('orderBooks', 60_000);
  }

  async saveLiquidations(events: NormalizedLiquidation[]): Promise<void> {
    if (!this.db || !events.length) return;
    const collection = this.collection('liquidations');
    await collection.bulkWrite(events.map((event) => ({
      updateOne: {
        filter: { symbol: event.symbol, timestamp: event.timestamp, price: event.price, size: event.size, side: event.side },
        update: { $setOnInsert: { ...event, expiresAt: new Date(event.timestamp + OTHER_DATA_RETENTION_MS) } },
        upsert: true
      }
    })), { ordered: false });
    await this.enforceCap('liquidations', 100_000);
  }

  async getFootprints(options: { symbol: string; timeframe: string; startTimeMs?: number; endTimeMs?: number }): Promise<SerializedFootprintBar[]> {
    const query: Document = { symbol: options.symbol, timeframe: options.timeframe };
    const time: Document = {};
    if (options.startTimeMs !== undefined) time.$gte = Math.floor(options.startTimeMs / 1000);
    if (options.endTimeMs !== undefined) time.$lte = Math.floor(options.endTimeMs / 1000);
    if (Object.keys(time).length) query.time = time;
    const docs = await this.collection('footprints').find(query).sort({ time: 1 }).limit(20_000).toArray();
    return docs.map((doc) => this.clean<SerializedFootprintBar>(doc));
  }

  async getTrades(options: { symbol: string; startTimeMs?: number; endTimeMs?: number; limit: number }): Promise<NormalizedTrade[]> {
    const query = this.timeQuery(options.symbol, 'timestamp', options.startTimeMs, options.endTimeMs);
    const docs = await this.collection('trades').find(query).sort({ timestamp: -1 }).limit(options.limit).toArray();
    return docs.map((doc) => this.clean<NormalizedTrade>(doc)).reverse();
  }

  /** Rebuild bounded 1m/5m footprints from retained raw fills without loading ticks into Node memory. */
  async reconstructFootprintsFromTrades(options: { symbol: string; timeframe: '1m' | '5m'; startTimeMs: number; endTimeMs: number; tickSize: number }): Promise<{ bars: SerializedFootprintBar[]; trades: number }> {
    const intervalSeconds = options.timeframe === '1m' ? 60 : 300;
    const intervalMs = intervalSeconds * 1000;
    const match = { symbol: options.symbol, timestamp: { $gte: options.startTimeMs, $lte: options.endTimeMs } };
    const trades = await this.collection('trades').countDocuments(match);
    if (!trades) return { bars: [], trades: 0 };
    const bucket = { $multiply: [{ $floor: { $divide: ['$timestamp', intervalMs] } }, intervalSeconds] };
    const [ohlcRows, levelRows] = await Promise.all([
      this.collection('trades').aggregate([
        { $match: match }, { $sort: { timestamp: 1 } }, { $addFields: { bucket: bucket } },
        { $group: { _id: '$bucket', open: { $first: '$price' }, close: { $last: '$price' }, high: { $max: '$price' }, low: { $min: '$price' }, totalVolume: { $sum: '$size' }, buyVolume: { $sum: { $cond: [{ $eq: ['$side', 'Buy'] }, '$size', 0] } }, sellVolume: { $sum: { $cond: [{ $eq: ['$side', 'Sell'] }, '$size', 0] } }, tradesCount: { $sum: 1 } } },
        { $sort: { _id: 1 } }, { $limit: 3000 }
      ], { allowDiskUse: true }).toArray(),
      this.collection('trades').aggregate([
        { $match: match },
        { $addFields: { bucket: bucket, levelPrice: { $multiply: [{ $round: [{ $divide: ['$price', options.tickSize] }, 0] }, options.tickSize] } } },
        { $group: { _id: { time: '$bucket', price: '$levelPrice' }, bidVolume: { $sum: { $cond: [{ $eq: ['$side', 'Sell'] }, '$size', 0] } }, askVolume: { $sum: { $cond: [{ $eq: ['$side', 'Buy'] }, '$size', 0] } }, tradesCount: { $sum: 1 } } },
        { $sort: { '_id.time': 1, '_id.price': 1 } }, { $limit: 500_000 }
      ], { allowDiskUse: true }).toArray()
    ]);
    const levelsByTime = new Map<number, SerializedFootprintBar['priceLevels']>();
    for (const row of levelRows) {
      const time = Number(row._id.time);
      const bidVolume = Number(row.bidVolume);
      const askVolume = Number(row.askVolume);
      const totalVolume = bidVolume + askVolume;
      if (!Number.isFinite(time) || totalVolume <= 0) continue;
      const levels = levelsByTime.get(time) ?? [];
      levels.push({ price: Number(row._id.price), bidVolume, askVolume, totalVolume, delta: askVolume - bidVolume, tradesCount: Number(row.tradesCount) });
      levelsByTime.set(time, levels);
    }
    let cumulativeDelta = 0;
    const bars = ohlcRows.map((row) => {
      const time = Number(row._id);
      const priceLevels = levelsByTime.get(time) ?? [];
      const totalVolume = Number(row.totalVolume);
      const buyVolume = Number(row.buyVolume);
      const sellVolume = Number(row.sellVolume);
      const delta = buyVolume - sellVolume;
      cumulativeDelta += delta;
      const poc = priceLevels.reduce((best, level) => level.totalVolume > best.totalVolume ? level : best, priceLevels[0] ?? { price: Number(row.close), totalVolume: 0 });
      return {
        symbol: options.symbol, timeframe: options.timeframe, time,
        open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
        totalVolume, buyVolume, sellVolume, delta, cumulativeDelta,
        pocPrice: poc.price, pocVolume: poc.totalVolume, tradesCount: Number(row.tradesCount), priceLevels,
        isClosed: (time + intervalSeconds) * 1000 <= options.endTimeMs
      } satisfies SerializedFootprintBar;
    });
    return { bars, trades };
  }

  async getOrderBooks(options: { symbol: string; startTimeMs?: number; endTimeMs?: number; limit: number }): Promise<OrderBookSample[]> {
    const query = this.timeQuery(options.symbol, 'time', options.startTimeMs, options.endTimeMs);
    const docs = await this.collection('orderBooks').find(query).sort({ time: -1 }).limit(options.limit).toArray();
    return docs.map((doc) => this.clean<OrderBookSample>(doc)).reverse();
  }

  async getLiquidations(options: { symbol: string; startTimeMs: number; endTimeMs: number; limit: number }): Promise<NormalizedLiquidation[]> {
    const query = this.timeQuery(options.symbol, 'timestamp', options.startTimeMs, options.endTimeMs);
    const docs = await this.collection('liquidations').find(query).sort({ timestamp: -1 }).limit(options.limit).toArray();
    return docs.map((doc) => this.clean<NormalizedLiquidation>(doc)).reverse();
  }

  async getCounts(): Promise<{ footprints: number; footprints1m: number; footprints5m: number; latestFootprintTime: number | null; trades: number; orderBooks: number; liquidations: number }> {
    const [footprints, footprints1m, footprints5m, latestFootprint, trades, orderBooks, liquidations] = await Promise.all([
      this.collection('footprints').estimatedDocumentCount(),
      this.collection('footprints').countDocuments({ timeframe: '1m' }),
      this.collection('footprints').countDocuments({ timeframe: '5m' }),
      this.collection('footprints').find({}, { projection: { time: 1 } }).sort({ time: -1 }).limit(1).next(),
      this.collection('trades').estimatedDocumentCount(),
      this.collection('orderBooks').estimatedDocumentCount(),
      this.collection('liquidations').estimatedDocumentCount()
    ]);
    return { footprints, footprints1m, footprints5m, latestFootprintTime: latestFootprint?.time ?? null, trades, orderBooks, liquidations };
  }

  async saveAgentDecision(snapshot: AgentSnapshot, result: CouncilResult): Promise<boolean> {
    if (!this.db || (result.plan.decision !== 'LONG' && result.plan.decision !== 'SHORT') ||
      result.plan.entryPrice === null || result.plan.stopPrice === null || result.plan.targetPrice === null || result.plan.targetR === null) return false;
    const { plan } = result;
    await this.collection('agent_decisions').insertOne({
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      generatedAt: result.generatedAt,
      side: plan.decision,
      entry: plan.entryPrice,
      stop: plan.stopPrice,
      target: plan.targetPrice,
      targetR: plan.targetR,
      summary: plan.summary,
      strategyIds: plan.strategyIds,
      reports: result.reports.map(({ agentId, bias, strength, strategyCandidates }) => ({ agentId, bias, strength, strategyCandidates })),
      status: 'PENDING',
      filledAt: null,
      resolvedAt: null,
      pnlR: null,
      expiresAt: new Date(result.generatedAt + OTHER_DATA_RETENTION_MS)
    });
    await this.enforceCap('agent_decisions', 10_000);
    return true;
  }

  async settleAgentDecisions(candle: NormalizedCandle): Promise<void> {
    if (!this.db || !candle.isClosed) return;
    const collection = this.collection('agent_decisions');
    const candleTimeMs = candle.time * 1000;
    const pending = await collection.find({
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      status: { $in: ['PENDING', 'OPEN'] },
      generatedAt: { $lt: candleTimeMs },
      expiresAt: { $gt: new Date() }
    }).sort({ generatedAt: 1 }).limit(200).toArray();
    const intervalSeconds = candle.timeframe === '1m' ? 60 : candle.timeframe === '3m' ? 180 : candle.timeframe === '5m' ? 300 : candle.timeframe === '15m' ? 900 : candle.timeframe === '30m' ? 1800 : candle.timeframe === '1h' ? 3600 : candle.timeframe === '4h' ? 14400 : 86400;
    for (const record of pending) {
      const side = record.side as 'LONG' | 'SHORT';
      const entry = Number(record.entry), stop = Number(record.stop), target = Number(record.target);
      const maxWaitMs = 30 * intervalSeconds * 1000;
      if (record.status === 'PENDING') {
        const entryTouched = candle.low <= entry && candle.high >= entry &&
          (side === 'LONG' ? candle.close >= entry : candle.close <= entry);
        if (!entryTouched) {
          if (candleTimeMs - Number(record.generatedAt) >= maxWaitMs) {
            await collection.updateOne({ _id: record._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', resolvedAt: candleTimeMs } });
          }
          continue;
        }
        const stopHit = side === 'LONG' ? candle.low <= stop : candle.high >= stop;
        const targetHit = side === 'LONG' ? candle.high >= target : candle.low <= target;
        if (stopHit) {
          await collection.updateOne({ _id: record._id, status: 'PENDING' }, { $set: { status: 'LOSS', filledAt: candleTimeMs, resolvedAt: candleTimeMs, pnlR: -1 } });
        } else if (targetHit) {
          await collection.updateOne({ _id: record._id, status: 'PENDING' }, { $set: { status: 'WIN', filledAt: candleTimeMs, resolvedAt: candleTimeMs, pnlR: Number(record.targetR) } });
        } else {
          await collection.updateOne({ _id: record._id, status: 'PENDING' }, { $set: { status: 'OPEN', filledAt: candleTimeMs } });
        }
        continue;
      }
      const stopHit = side === 'LONG' ? candle.low <= stop : candle.high >= stop;
      const targetHit = side === 'LONG' ? candle.high >= target : candle.low <= target;
      // OHLC cannot establish which level traded first; score the stop first.
      if (stopHit) await collection.updateOne({ _id: record._id, status: 'OPEN' }, { $set: { status: 'LOSS', resolvedAt: candleTimeMs, pnlR: -1 } });
      else if (targetHit) await collection.updateOne({ _id: record._id, status: 'OPEN' }, { $set: { status: 'WIN', resolvedAt: candleTimeMs, pnlR: Number(record.targetR) } });
    }
  }

  async getAgentPaperPerformance(symbol: string, timeframe: string, limit = 30): Promise<AgentPaperPerformance> {
    const resolved = await this.collection('agent_decisions').find({
      symbol, timeframe, status: { $in: ['WIN', 'LOSS', 'EXPIRED'] }
    }).sort({ resolvedAt: -1 }).limit(limit).toArray();
    const wins = resolved.filter((row) => row.status === 'WIN').length;
    const losses = resolved.filter((row) => row.status === 'LOSS').length;
    const scored = resolved.filter((row) => typeof row.pnlR === 'number');
    return {
      resolved: resolved.length,
      wins,
      losses,
      expired: resolved.filter((row) => row.status === 'EXPIRED').length,
      winRate: wins + losses ? wins / (wins + losses) : null,
      averageR: scored.length ? scored.reduce((sum, row) => sum + Number(row.pnlR), 0) / scored.length : null,
      recent: resolved.filter((row) => row.status === 'WIN' || row.status === 'LOSS').slice(0, 5).map((row) => ({
        side: row.side as 'LONG' | 'SHORT', outcome: row.status as 'WIN' | 'LOSS', pnlR: Number(row.pnlR)
      }))
    };
  }

  private collection(name: keyof typeof this.collectionNames | 'agent_decisions'): Collection<Document> {
    if (!this.db) throw new Error('MongoDB is not connected.');
    return this.db.collection(name === 'agent_decisions' ? name : this.collectionNames[name]);
  }

  private timeQuery(symbol: string, field: string, start?: number, end?: number): Document {
    const query: Document = { symbol };
    const bounds: Document = {};
    if (start !== undefined) bounds.$gte = start;
    if (end !== undefined) bounds.$lte = end;
    if (Object.keys(bounds).length) query[field] = bounds;
    return query;
  }

  private clean<T>(doc: Document): T {
    const { _id: _ignoredId, expiresAt: _ignoredExpiry, ...record } = doc;
    return record as T;
  }

  /** Convert existing TTL dates once, then let MongoDB's TTL monitor prune them. */
  private async applyRetentionPolicy(): Promise<void> {
    if (!this.db) return;
    const settings = this.db.collection<{ _id: string; appliedAt?: Date }>('settings');
    if (await settings.findOne({ _id: RETENTION_POLICY_ID })) return;

    const previousPolicy = await settings.findOne({ _id: { $in: PREVIOUS_RETENTION_POLICY_IDS } });
    if (previousPolicy) {
      // Prior policies already assigned 48-hour TTLs to trades and decisions.
      // Shorten footprints and order-book snapshots; delete expired rows first
      // to reclaim space before refreshing the TTL dates of retained rows.
      const now = Date.now();
      const footprintCutoff = Math.floor((now - FOOTPRINT_RETENTION_MS) / 1000);
      const orderBookCutoff = now - ORDER_BOOK_RETENTION_MS;
      await Promise.all([
        this.collection('footprints').deleteMany({ time: { $lte: footprintCutoff } }),
        this.collection('orderBooks').deleteMany({ time: { $lte: orderBookCutoff } })
      ]);
      await this.collection('footprints').updateMany({}, [{ $set: { expiresAt: { $toDate: { $add: [{ $multiply: ['$time', 1000] }, FOOTPRINT_RETENTION_MS] } } } }]);
      await this.collection('orderBooks').updateMany({}, [{ $set: {
        expiresAt: { $toDate: { $add: ['$time', ORDER_BOOK_RETENTION_MS] } },
        bids: { $slice: ['$bids', ORDER_BOOK_LEVELS_PER_SIDE] },
        asks: { $slice: ['$asks', ORDER_BOOK_LEVELS_PER_SIDE] }
      } }]);
      await settings.updateOne({ _id: RETENTION_POLICY_ID }, { $set: { appliedAt: new Date() } }, { upsert: true });
      return;
    }

    const migrations = [
      this.collection('footprints').updateMany({}, [{ $set: { expiresAt: { $toDate: { $add: [{ $multiply: ['$time', 1000] }, FOOTPRINT_RETENTION_MS] } } } }]),
      this.collection('trades').updateMany({}, [{ $set: { expiresAt: { $toDate: { $add: ['$timestamp', OTHER_DATA_RETENTION_MS] } } } }]),
      this.collection('orderBooks').updateMany({}, [{ $set: {
        expiresAt: { $toDate: { $add: ['$time', ORDER_BOOK_RETENTION_MS] } },
        bids: { $slice: ['$bids', ORDER_BOOK_LEVELS_PER_SIDE] },
        asks: { $slice: ['$asks', ORDER_BOOK_LEVELS_PER_SIDE] }
      } }]),
      this.collection('liquidations').updateMany({}, [{ $set: { expiresAt: { $toDate: { $add: ['$timestamp', OTHER_DATA_RETENTION_MS] } } } }]),
      this.collection('agent_decisions').updateMany({}, [{ $set: { expiresAt: { $toDate: { $add: ['$generatedAt', OTHER_DATA_RETENTION_MS] } } } }])
    ];
    await Promise.all(migrations);
    const expired = new Date();
    await Promise.all([
      this.collection('footprints').deleteMany({ expiresAt: { $lte: expired } }),
      this.collection('trades').deleteMany({ expiresAt: { $lte: expired } }),
      this.collection('orderBooks').deleteMany({ expiresAt: { $lte: expired } }),
      this.collection('liquidations').deleteMany({ expiresAt: { $lte: expired } }),
      this.collection('agent_decisions').deleteMany({ expiresAt: { $lte: expired } })
    ]);
    await settings.updateOne({ _id: RETENTION_POLICY_ID }, { $set: { appliedAt: expired } }, { upsert: true });
  }

  private async enforceCap(name: keyof typeof this.collectionNames | 'agent_decisions', cap: number): Promise<void> {
    if (!this.db) return;
    const now = Date.now();
    if (now - (this.lastCapCheckAt.get(name) ?? 0) < 60_000) return;
    this.lastCapCheckAt.set(name, now);
    const collection = this.collection(name);
    const count = await collection.countDocuments();
    if (count <= cap) return;
    const excess = count - cap;
    const oldest = await collection.find({}, { projection: { _id: 1 } })
      .sort(name === 'footprints' ? { time: 1 } : name === 'trades' || name === 'liquidations' ? { timestamp: 1 } : name === 'agent_decisions' ? { generatedAt: 1 } : { time: 1 })
      .limit(excess).toArray();
    if (oldest.length) await collection.deleteMany({ _id: { $in: oldest.map((doc) => doc._id) } });
  }
}
