import { ConfigService } from '@nestjs/config';
import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { EnvironmentVariables } from '../config/environment';
import { BATCHES, QUARANTINE, RECEIPTS, RUNS } from './collections';

/** Owns the MongoDB client. `raw` is read-only provider input; `target` holds output and bookkeeping. */
@Injectable()
export class MongoService implements OnModuleInit, OnApplicationShutdown {
  readonly client: MongoClient;
  readonly raw: Db;
  readonly target: Db;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.client = new MongoClient(config.get('MONGO_URI', { infer: true }), {
      serverSelectionTimeoutMS: 5000,
    });
    this.raw = this.client.db(config.get('RAW_DB', { infer: true }));
    this.target = this.client.db(config.get('TARGET_DB', { infer: true }));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.target.collection('service_areas').createIndex({ locationKey: 1, restaurantKey: 1 }),
      this.target.collection('categories').createIndex({ restaurantKey: 1 }),
      this.target.collection('items').createIndex({ restaurantKey: 1 }),
      this.target.collection('category_items').createIndex({ categoryKey: 1, itemKey: 1 }),
      this.target.collection('category_items').createIndex({ itemKey: 1 }),
      this.target.collection(QUARANTINE).createIndex({ runId: 1, _id: 1 }),
      this.target.collection(BATCHES).createIndex({ runId: 1, status: 1 }),
      this.target.collection(RUNS).createIndex({ status: 1 }),
      this.target.collection(RECEIPTS).createIndex({ runId: 1 }),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
