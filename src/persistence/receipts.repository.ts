import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { Source } from '../core/contracts';
import { RECEIPTS } from './collections';
import { ReceiptDocument } from './documents';
import { MongoService } from './mongo.service';

/** A receipt marks one source document as fully processed within a run, so retries skip it. */
@Injectable()
export class ReceiptsRepository {
  private readonly receipts: Collection<ReceiptDocument>;

  constructor(mongo: MongoService) {
    this.receipts = mongo.target.collection<ReceiptDocument>(RECEIPTS);
  }

  static id(runId: string, source: Source, sourceId: string): string {
    return `${runId}/${source}/${sourceId}`;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.receipts.findOne({ _id: id })) !== null;
  }

  async save(id: string): Promise<void> {
    await this.receipts.updateOne({ _id: id }, { $setOnInsert: { _id: id } }, { upsert: true });
  }
}
