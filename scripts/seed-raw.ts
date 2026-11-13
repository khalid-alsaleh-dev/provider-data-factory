import 'reflect-metadata';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { BSON, Collection, MongoClient } from 'mongodb';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { safeError } from '../src/common/safe-error';
import { validateEnvironment } from '../src/config/environment';
import { sources } from '../src/core/contracts';
import { XbyteAdapter } from '../src/providers/xbyte/adapter';

const BATCH_SIZE = 100;

type SourceDocument = Record<string, unknown> & { _id: BSON.ObjectId };

async function saveBatch(
  collection: Collection<SourceDocument>,
  documents: SourceDocument[],
): Promise<number> {
  if (documents.length === 0) return 0;

  await collection.bulkWrite(
    documents.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return documents.length;
}

async function seedFile(file: string, collection: Collection<SourceDocument>): Promise<number> {
  let batch: SourceDocument[] = [];
  let count = 0;

  await pipeline(createReadStream(file), parser(), streamArray(), async (records) => {
    for await (const { value } of records as AsyncIterable<{ value: unknown }>) {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Expected an array of Extended JSON documents');
      }
      const doc = BSON.EJSON.deserialize(value) as Record<string, unknown>;
      const id = doc._id;
      if (!(id instanceof BSON.ObjectId)) {
        throw new Error('Source _id must be an Extended JSON ObjectId');
      }

      batch.push({ ...doc, _id: id });
      if (batch.length === BATCH_SIZE) {
        count += await saveBatch(collection, batch);
        batch = [];
      }
    }
    // Flush the final partial batch.
    count += await saveBatch(collection, batch);
  });

  return count;
}

async function main() {
  const config = validateEnvironment(process.env);
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'data' },
      locations: { type: 'string' },
      restaurants: { type: 'string' },
      menus: { type: 'string' },
    },
  });
  const adapter = new XbyteAdapter();
  const client = new MongoClient(config.MONGO_URI);

  try {
    await client.connect();

    for (const source of sources) {
      const file = values[source] ?? resolve(values.dir, `compero-xbyte.xbyte-raw-${source}.json`);
      const collection = client
        .db(config.RAW_DB)
        .collection<SourceDocument>(adapter.sourceCollections[source]);
      const count = await seedFile(file, collection);
      console.log(JSON.stringify({ event: 'seeded', source, count }));
    }
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(`Seed failed: ${safeError(error)}`);
  process.exitCode = 1;
});
