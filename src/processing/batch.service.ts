import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Adapter, Result } from '../core/contracts';
import { transform } from '../core/pipeline';
import { BatchesRepository } from '../persistence/batches.repository';
import { SourceRepository } from '../persistence/source.repository';
import { ADAPTER } from '../providers/providers.module';
import { DEAD_LETTER_QUEUE, DeadLetterJobData } from '../queues/queue-names';
import { DocumentWriter } from './document-writer.service';
import { RunFinalizer } from './run-finalizer.service';

const MISSING_DOCUMENT: Result = {
  entities: [],
  duplicates: 0,
  issues: [{ path: '$', reason: 'Source document is missing' }],
};

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(
    private readonly batches: BatchesRepository,
    private readonly source: SourceRepository,
    private readonly writer: DocumentWriter,
    private readonly finalizer: RunFinalizer,
    @Inject(ADAPTER) private readonly adapter: Adapter,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetters: Queue<DeadLetterJobData>,
  ) {}

  /** Transforms and saves every document of a pending batch. Already-processed documents are skipped. */
  async process(batchId: string): Promise<void> {
    const batch = await this.batches.getById(batchId);
    if (batch.status !== 'pending') return;

    // One receipt lookup per batch; documents finished by an earlier attempt are not even read.
    const remaining = await this.writer.unprocessed(batch.runId, batch.source, batch.ids);
    const documents = remaining.length > 0 ? await this.source.get(batch.source, remaining) : [];
    const documentsById = new Map(documents.map((document) => [String(document._id), document]));

    for (const sourceId of remaining) {
      const raw = documentsById.get(sourceId);
      const result = raw
        ? transform(this.adapter, raw, { source: batch.source, sourceId })
        : MISSING_DOCUMENT;
      await this.writer.write(batch.runId, batchId, batch.source, sourceId, result);
      this.logger.debug({ event: 'document_processed', runId: batch.runId, batchId, sourceId });
    }

    await this.batches.close(batchId, 'completed');
    await this.finalizer.finishIfComplete(batch.runId);
  }

  /**
   * Called on the final failed attempt: quarantines documents that were not processed, marks the
   * batch dead and publishes a dead-letter reference. Every step is idempotent, so a crash part-way
   * is repaired when BullMQ re-runs the stalled job.
   */
  async deadLetter(batchId: string, reason: string): Promise<void> {
    const batch = await this.batches.getById(batchId);
    if (batch.status === 'completed') return;

    if (batch.status === 'pending') {
      const failure: Result = {
        entities: [],
        duplicates: 0,
        issues: [{ path: '$', reason: `Retries exhausted: ${reason}` }],
      };
      const remaining = await this.writer.unprocessed(batch.runId, batch.source, batch.ids);
      for (const sourceId of remaining) {
        await this.writer.write(batch.runId, batch._id, batch.source, sourceId, failure);
      }
    }

    await this.deadLetters.add(
      'exhausted',
      {
        runId: batch.runId,
        batchId: batch._id,
        source: batch.source,
        sourceIds: batch.ids,
        reason,
      },
      { jobId: batch._id },
    );
    await this.batches.close(batch._id, 'dead');
    await this.finalizer.finishIfComplete(batch.runId);
  }
}
