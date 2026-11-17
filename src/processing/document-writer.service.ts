import { Injectable } from '@nestjs/common';
import { Result, Source } from '../core/contracts';
import { EntitiesRepository } from '../persistence/entities.repository';
import { QuarantineRepository } from '../persistence/quarantine.repository';
import { ReceiptsRepository } from '../persistence/receipts.repository';

/**
 * Persists the result of transforming one source document: entities and quarantined issues, then
 * a receipt carrying the document's counters. Every write is idempotent and the receipt is written
 * last, so a retry after a crash repeats the entity and issue writes harmlessly and the run totals
 * (summed from receipts) stay exact.
 */
@Injectable()
export class DocumentWriter {
  constructor(
    private readonly entities: EntitiesRepository,
    private readonly quarantine: QuarantineRepository,
    private readonly receipts: ReceiptsRepository,
  ) {}

  /** The source IDs of a batch that do not have a receipt yet, in their original order. */
  async unprocessed(runId: string, source: Source, sourceIds: string[]): Promise<string[]> {
    const done = await this.receipts.existing(
      sourceIds.map((sourceId) => ReceiptsRepository.id(runId, source, sourceId)),
    );
    return sourceIds.filter(
      (sourceId) => !done.has(ReceiptsRepository.id(runId, source, sourceId)),
    );
  }

  async write(
    runId: string,
    batchId: string,
    source: Source,
    sourceId: string,
    result: Result,
  ): Promise<void> {
    const [written] = await Promise.all([
      this.entities.save(result.entities),
      this.quarantine.save(runId, batchId, source, sourceId, result.issues),
    ]);
    await this.receipts.save(ReceiptsRepository.id(runId, source, sourceId), runId, {
      read: 1,
      transformed: result.entities.length > 0 ? 1 : 0,
      written,
      skipped: result.duplicates + result.entities.length - written,
      failed: result.issues.length,
    });
  }
}
