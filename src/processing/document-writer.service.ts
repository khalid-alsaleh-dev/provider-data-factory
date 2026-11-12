import { Injectable } from '@nestjs/common';
import { Result, Source } from '../core/contracts';
import { EntitiesRepository } from '../persistence/entities.repository';
import { QuarantineRepository } from '../persistence/quarantine.repository';
import { ReceiptsRepository } from '../persistence/receipts.repository';
import { RunsRepository } from '../persistence/runs.repository';

/**
 * Persists the result of transforming one source document: entities, quarantined issues and run
 * counters, then a receipt. The receipt is written last, so a retry after a crash repeats the
 * (idempotent) entity and issue writes; only the counters may be incremented twice.
 */
@Injectable()
export class DocumentWriter {
  constructor(
    private readonly entities: EntitiesRepository,
    private readonly quarantine: QuarantineRepository,
    private readonly receipts: ReceiptsRepository,
    private readonly runs: RunsRepository,
  ) {}

  async write(
    runId: string,
    batchId: string,
    source: Source,
    sourceId: string,
    result: Result,
  ): Promise<void> {
    const receiptId = ReceiptsRepository.id(runId, source, sourceId);
    if (await this.receipts.exists(receiptId)) return;

    const written = await this.entities.save(result.entities);
    await this.quarantine.save(runId, batchId, source, sourceId, result.issues);
    await this.runs.recordDocument(
      runId,
      {
        read: 1,
        transformed: result.entities.length > 0 ? 1 : 0,
        written,
        skipped: result.duplicates + result.entities.length - written,
        failed: result.issues.length,
      },
      result.issues.map((issue) => ({ sourceId, ...issue })),
    );
    await this.receipts.save(receiptId);
  }
}
