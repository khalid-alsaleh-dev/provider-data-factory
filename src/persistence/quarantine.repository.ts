import { Injectable } from '@nestjs/common';
import { AnyBulkWriteOperation, Collection, Filter } from 'mongodb';
import { Issue, Source } from '../core/contracts';
import { digest } from '../core/helpers';
import { QUARANTINE } from './collections';
import { ErrorSample, QuarantinedIssueDocument } from './documents';
import { MongoService } from './mongo.service';

export interface QuarantinePage {
  data: QuarantinedIssueDocument[];
  next: string | null;
}

@Injectable()
export class QuarantineRepository {
  private readonly quarantine: Collection<QuarantinedIssueDocument>;

  constructor(mongo: MongoService) {
    this.quarantine = mongo.target.collection<QuarantinedIssueDocument>(QUARANTINE);
  }

  /** Idempotent: an issue's id is derived from its content and position. */
  async save(
    runId: string,
    batchId: string,
    source: Source,
    sourceId: string,
    issues: Issue[],
  ): Promise<void> {
    if (issues.length === 0) return;
    const operations: AnyBulkWriteOperation<QuarantinedIssueDocument>[] = issues.map(
      (issue, index) => ({
        updateOne: {
          filter: { _id: digest([runId, source, sourceId, index, issue]) },
          update: { $setOnInsert: { runId, batchId, source, sourceId, ...issue } },
          upsert: true,
        },
      }),
    );
    await this.quarantine.bulkWrite(operations, { ordered: false });
  }

  /** The first `size` issues of a run (in cursor order), for the run summary. */
  async sample(runId: string, size: number): Promise<ErrorSample[]> {
    return this.quarantine
      .find({ runId }, { projection: { _id: 0, sourceId: 1, path: 1, reason: 1 } })
      .sort({ _id: 1 })
      .limit(size)
      .map(({ sourceId, path, reason }) => ({ sourceId, path, reason }))
      .toArray();
  }

  /** Keyset pagination by _id. `next` is the cursor for the following page, or null. */
  async page(runId: string, after: string | undefined, limit: number): Promise<QuarantinePage> {
    const filter: Filter<QuarantinedIssueDocument> = { runId };
    if (after) filter._id = { $gt: after };
    const rows = await this.quarantine
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();
    const data = rows.slice(0, limit);
    return { data, next: rows.length > limit ? data[data.length - 1]._id : null };
  }
}
