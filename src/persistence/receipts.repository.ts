import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { Source } from '../core/contracts';
import { RECEIPTS } from './collections';
import { emptyCounters, ReceiptDocument, RunCounters } from './documents';
import { MongoService } from './mongo.service';

/**
 * A receipt marks one source document as fully processed within a run, so retries skip it.
 * It also carries that document's counters: run totals are the sum over receipts, so a retried
 * document can never be counted twice.
 */
@Injectable()
export class ReceiptsRepository {
  private readonly receipts: Collection<ReceiptDocument>;

  constructor(mongo: MongoService) {
    this.receipts = mongo.target.collection<ReceiptDocument>(RECEIPTS);
  }

  static id(runId: string, source: Source, sourceId: string): string {
    return `${runId}/${source}/${sourceId}`;
  }

  /** The subset of `ids` that already have a receipt, in one query. */
  async existing(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.receipts
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(rows.map((row) => row._id));
  }

  /** Idempotent: the first save wins, so a repeated save never changes the totals. */
  async save(id: string, runId: string, counters: RunCounters): Promise<void> {
    await this.receipts.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, runId, counters } },
      { upsert: true },
    );
  }

  async totals(runId: string): Promise<RunCounters> {
    const [row] = await this.receipts
      .aggregate<RunCounters>([
        { $match: { runId } },
        {
          $group: {
            _id: null,
            read: { $sum: '$counters.read' },
            transformed: { $sum: '$counters.transformed' },
            written: { $sum: '$counters.written' },
            skipped: { $sum: '$counters.skipped' },
            failed: { $sum: '$counters.failed' },
          },
        },
        { $project: { _id: 0 } },
      ])
      .toArray();
    return row ?? emptyCounters();
  }

  /** Receipts are only needed while a run is active; the finished run keeps a counter snapshot. */
  async deleteForRun(runId: string): Promise<void> {
    await this.receipts.deleteMany({ runId });
  }
}
