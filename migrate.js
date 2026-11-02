// migrate.js
import { MongoClient } from 'mongodb';

const ATLAS_URI = 'mongodb+srv://govtexamsite_db_user:Sovit1108@cluster0.jtdjkot.mongodb.net/';
const LOCAL_URI = 'mongodb://127.0.0.1:27017/';
const DB_NAME = 'flowterminal';

async function migrate() {
  console.log('Connecting to Atlas and Local MongoDB...');
  const atlasClient = new MongoClient(ATLAS_URI);
  const localClient = new MongoClient(LOCAL_URI);

  await atlasClient.connect();
  await localClient.connect();

  const atlasDb = atlasClient.db(DB_NAME);
  const localDb = localClient.db(DB_NAME);

  const collections = ['trades', 'footprints', 'orderBooks', 'liquidations', 'agentDecisions'];

  for (const colName of collections) {
    console.log(`Migrating collection: ${colName}...`);
    const cursor = atlasDb.collection(colName).find({});
    const count = await atlasDb.collection(colName).countDocuments();
    if (count === 0) {
      console.log(`Collection ${colName} is empty, skipping.`);
      continue;
    }

    let batch = [];
    let processed = 0;
    while (await cursor.hasNext()) {
      batch.push(await cursor.next());
      if (batch.length >= 5000) {
        await localDb.collection(colName).insertMany(batch, { ordered: false }).catch(() => {});
        processed += batch.length;
        console.log(`[${colName}] Migrated ${processed}/${count}...`);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await localDb.collection(colName).insertMany(batch, { ordered: false }).catch(() => {});
      processed += batch.length;
    }
    console.log(`Done ${colName}: ${processed} records copied.`);
  }

  await atlasClient.close();
  await localClient.close();
  console.log('Data migration complete!');
}

migrate().catch(console.error);