import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';

// Load local environment
function loadEnv(): void {
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
loadEnv();

function findReplayJson(): string {
  const cliPath = process.argv[2]?.trim();
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
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

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error('Could not find replay.json in project, Downloads, or Desktop!');
  }
  return found;
}

async function run() {
  console.log('====================================================');
  console.log('   📥 IMPORT REPLAY.JSON INTO LOCAL MONGODB        ');
  console.log('====================================================\n');

  const replayFilePath = findReplayJson();
  console.log(`[File] Reading from: ${replayFilePath}`);

  const rawJson = JSON.parse(readFileSync(replayFilePath, 'utf8'));
  const symbol = rawJson.symbol || 'BTCUSDT';
  const bars: any[] = Array.isArray(rawJson.bars) ? rawJson.bars : [];

  if (bars.length === 0) {
    console.error('❌ No bars found in replay.json!');
    process.exit(1);
  }

  console.log(`[Data] Found ${bars.length.toLocaleString()} bars for ${symbol}`);

  const localMongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/';
  const dbName = process.env.MONGODB_DATABASE || 'flowterminal';

  console.log(`[MongoDB] Connecting to local database: ${localMongoUri}${dbName}...`);
  const client = new MongoClient(localMongoUri);

  try {
    await client.connect();
    const db = client.db(dbName);

    // 1. Prepare and insert footprints (1m)
    const footprintsColl = db.collection('footprints');
    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days retention on local machine

    const footprintDocs = bars.map((b) => ({
      symbol,
      timeframe: '1m',
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      totalVolume: b.totalVolume,
      buyVolume: b.buyVolume,
      sellVolume: b.sellVolume,
      delta: b.delta,
      cumulativeDelta: b.cumulativeDelta,
      pocPrice: b.pocPrice,
      pocVolume: b.pocVolume ?? 0,
      priceLevels: b.priceLevels || [],
      isClosed: true,
      expiresAt: new Date(b.time * 1000 + retentionMs)
    }));

    console.log(`\nInserting ${footprintDocs.length.toLocaleString()} footprint bars into "footprints"...`);
    await footprintsColl.bulkWrite(
      footprintDocs.map((doc) => ({
        updateOne: {
          filter: { symbol: doc.symbol, timeframe: doc.timeframe, time: doc.time },
          update: { $set: doc },
          upsert: true
        }
      })),
      { ordered: false }
    );
    console.log('✅ Footprints successfully imported!');

    // 2. Synthesize representative trades for order-flow tape verification
    const tradesColl = db.collection('trades');
    const tradeDocs: any[] = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const baseTs = b.time * 1000;
      
      // Create representative trade ticks per bar from POC and close levels
      tradeDocs.push({
        symbol,
        tradeId: `replay-${b.time}-poc`,
        price: b.pocPrice,
        size: Number((b.totalVolume * 0.4).toFixed(3)) || 1.0,
        side: b.delta >= 0 ? 'Buy' : 'Sell',
        timestamp: baseTs + 30_000,
        expiresAt: new Date(baseTs + retentionMs)
      });

      tradeDocs.push({
        symbol,
        tradeId: `replay-${b.time}-close`,
        price: b.close,
        size: Number((b.totalVolume * 0.2).toFixed(3)) || 0.5,
        side: b.close >= b.open ? 'Buy' : 'Sell',
        timestamp: baseTs + 58_000,
        expiresAt: new Date(baseTs + retentionMs)
      });
    }

    console.log(`Inserting ${tradeDocs.length.toLocaleString()} tape trades into "trades"...`);
    await tradesColl.bulkWrite(
      tradeDocs.map((doc) => ({
        updateOne: {
          filter: { symbol: doc.symbol, tradeId: doc.tradeId },
          update: { $set: doc },
          upsert: true
        }
      })),
      { ordered: false }
    );
    console.log('✅ Trades tape successfully populated!');

    // Verify counts in DB
    const fpCount = await footprintsColl.countDocuments({ symbol });
    const trCount = await tradesColl.countDocuments({ symbol });

    console.log('\n====================================================');
    console.log('🎉 LOCAL MONGODB RESTORE COMPLETED');
    console.log(`   • Footprints in Mongo : ${fpCount.toLocaleString()}`);
    console.log(`   • Trades in Mongo     : ${trCount.toLocaleString()}`);
    console.log('====================================================');
    console.log('\nAb replay test chalane ke liye:');
    console.log('npx tsx replayBacktest.ts --mongo\n');

  } catch (err) {
    console.error('❌ Import failed:', err instanceof Error ? err.message : err);
  } finally {
    await client.close();
  }
}

run().catch(console.error);