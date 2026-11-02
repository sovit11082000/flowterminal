import { MongoClient } from 'mongodb';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

function loadEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const envPath = candidates.find((c) => existsSync(c));
  if (!envPath) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv();

async function cleanOldCollections() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DATABASE || 'flowterminal';
  if (!uri) {
    console.error('❌ MONGODB_URI not found in .env file!');
    process.exit(1);
  }

  console.log(`[Mongo Cleaner] Connecting to MongoDB Atlas (${dbName})...`);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // 1. Drop bloated raw trades collection
  try {
    await db.collection('trades').drop();
    console.log('✅ Successfully dropped old raw "trades" collection! (Huge storage freed)');
  } catch (err: any) {
    console.log('ℹ️ "trades" collection notice:', err?.message || err);
  }

  // 2. Drop bloated order_books samples collection
  try {
    await db.collection('order_books').drop();
    console.log('✅ Successfully dropped old "order_books" collection! (Storage freed)');
  } catch (err: any) {
    console.log('ℹ️ "order_books" collection notice:', err?.message || err);
  }

  // 3. Report current collections remaining
  const collections = await db.listCollections().toArray();
  console.log('\n📊 Collections currently active in MongoDB Atlas:');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`   • ${col.name}: ${count} documents`);
  }

  await client.close();
  console.log('\n🎉 Cleanup complete! Now MongoDB Atlas will only store:');
  console.log('   1. footprints (1m + 5m bars)');
  console.log('   2. liquidations');
  console.log('   3. agent_decisions');
}

cleanOldCollections().catch(console.error);