import { MongoClient, type Collection, type Document } from 'mongodb';
import type { SerializedFootprintBar, NormalizedTrade, NormalizedLiquidation } from '../types/market.js';
import type { OrderBookSample } from './orderBookHistoryStore.js';

type Stored<T> = T & { _id: string; expiresAt: Date };

/** MongoDB persistence for records captured after the service connects. It never imports local JSONL files. */
export class MongoHistoryStore {
  private readonly client: MongoClient | null;
  private readonly databaseName: string;
  private db: ReturnType<MongoClient['db']> | null = null;
  private readonly collectionNames = {
    footprints: 'footprints', trades: 'trades', orderBooks: 'order_books', liquidations: 'liquidations'
  } as const;
  private lastCapCheckAt = new Map<string, number>();

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
      this.collection('order_books').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('order_books').createIndex({ symbol: 1, time: 1 }),
      this.collection('liquidations').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection('liquidations').createIndex({ symbol: 1, timestamp: 1 })
    ]);
    console.log(`[MongoDB] Connected to database "${this.databaseName}". Existing local files were not imported.`);
  }

  async close(): Promise<void> { await this.client?.close(); this.db = null; }

  async saveFootprint(bar: SerializedFootprintBar): Promise<void> {
    if (!this.db || !bar.isClosed) return;
    const expiresAt = new Date(bar.time * 1000 + 30 * 24 * 60 * 60_000);
    await this.collection('footprints').replaceOne(
      { symbol: bar.symbol, timeframe: bar.timeframe, time: bar.time },
      { ...bar, expiresAt }, { upsert: true }
    );
    await this.enforceCap('footprints', 20_000);
  }

  async saveTrades(trades: NormalizedTrade[]): Promise<void> {
    if (!this.db || !trades.length) return;
    const collection = this.collection('trades');
    await collection.bulkWrite(trades.map((trade) => ({
      updateOne: {
        filter: { symbol: trade.symbol, tradeId: trade.tradeId },
        update: { $setOnInsert: { ...trade, expiresAt: new Date(trade.timestamp + 30 * 24 * 60 * 60_000) } },
        upsert: true
      }
    })), { ordered: false });
    await this.enforceCap('trades', 500_000);
  }

  async saveOrderBook(sample: OrderBookSample): Promise<void> {
    if (!this.db) return;
    await this.collection('order_books').insertOne({
      ...sample, expiresAt: new Date(sample.time + 30 * 24 * 60 * 60_000)
    });
    await this.enforceCap('order_books', 120_000);
  }

  async saveLiquidations(events: NormalizedLiquidation[]): Promise<void> {
    if (!this.db || !events.length) return;
    const collection = this.collection('liquidations');
    await collection.bulkWrite(events.map((event) => ({
      updateOne: {
        filter: { symbol: event.symbol, timestamp: event.timestamp, price: event.price, size: event.size, side: event.side },
        update: { $setOnInsert: { ...event, expiresAt: new Date(event.timestamp + 30 * 24 * 60 * 60_000) } },
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

  async getOrderBooks(options: { symbol: string; startTimeMs?: number; endTimeMs?: number; limit: number }): Promise<OrderBookSample[]> {
    const query = this.timeQuery(options.symbol, 'time', options.startTimeMs, options.endTimeMs);
    const docs = await this.collection('order_books').find(query).sort({ time: -1 }).limit(options.limit).toArray();
    return docs.map((doc) => this.clean<OrderBookSample>(doc)).reverse();
  }

  async getLiquidations(options: { symbol: string; startTimeMs: number; endTimeMs: number; limit: number }): Promise<NormalizedLiquidation[]> {
    const query = this.timeQuery(options.symbol, 'timestamp', options.startTimeMs, options.endTimeMs);
    const docs = await this.collection('liquidations').find(query).sort({ timestamp: -1 }).limit(options.limit).toArray();
    return docs.map((doc) => this.clean<NormalizedLiquidation>(doc)).reverse();
  }

  async getCounts(): Promise<{ footprints: number; trades: number; orderBooks: number; liquidations: number }> {
    const [footprints, trades, orderBooks, liquidations] = await Promise.all([
      this.collection('footprints').countDocuments(), this.collection('trades').countDocuments(),
      this.collection('order_books').countDocuments(), this.collection('liquidations').countDocuments()
    ]);
    return { footprints, trades, orderBooks, liquidations };
  }

  private collection(name: keyof typeof this.collectionNames): Collection<Document> {
    if (!this.db) throw new Error('MongoDB is not connected.');
    return this.db.collection(this.collectionNames[name]);
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

  private async enforceCap(name: keyof typeof this.collectionNames, cap: number): Promise<void> {
    if (!this.db) return;
    const now = Date.now();
    if (now - (this.lastCapCheckAt.get(name) ?? 0) < 60_000) return;
    this.lastCapCheckAt.set(name, now);
    const collection = this.collection(name);
    const count = await collection.countDocuments();
    if (count <= cap) return;
    const excess = count - cap;
    const oldest = await collection.find({}, { projection: { _id: 1 } })
      .sort(name === 'footprints' ? { time: 1 } : name === 'trades' || name === 'liquidations' ? { timestamp: 1 } : { time: 1 })
      .limit(excess).toArray();
    if (oldest.length) await collection.deleteMany({ _id: { $in: oldest.map((doc) => doc._id) } });
  }
}
