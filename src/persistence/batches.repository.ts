import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { Source } from '../core/contracts';
import { digest } from '../core/helpers';
import { BATCHES } from './collections';
import { BatchDocument, BatchStatus } from './documents';
import { MongoService } from './mongo.service';

@Injectable()
export class BatchesRepository {
  private readonly batches: Collection<BatchDocument>;

  constructor(mongo: MongoService) {
    this.batches = mongo.target.collection<BatchDocument>(BATCHES);
  }

  /** Idempotent: the same run, source and ids always produce the same batch. */
  async create(runId: string, source: Source, ids: string[]): Promise<BatchDocument> {
    const batch: BatchDocument = {
      _id: digest([runId, source, ids]),
      runId,
      source,
      ids,
      status: 'pending',
    };
    await this.batches.updateOne({ _id: batch._id }, { $setOnInsert: batch }, { upsert: true });
    return batch;
  }

  async getById(batchId: string): Promise<BatchDocument> {
    const batch = await this.batches.findOne({ _id: batchId });
    if (!batch) throw new Error(`Batch ${batchId} not found`);
    return batch;
  }

  async hasStatus(runId: string, status: BatchStatus): Promise<boolean> {
    return (await this.batches.findOne({ runId, status }, { projection: { _id: 1 } })) !== null;
  }

  /** Moves a pending batch to a final status. A no-op if it already left `pending`. */
  async close(batchId: string, status: Exclude<BatchStatus, 'pending'>): Promise<void> {
    await this.batches.updateOne(
      { _id: batchId, status: 'pending' },
      { $set: { status, finishedAt: new Date() } },
    );
  }
}
