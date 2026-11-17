import { Injectable } from '@nestjs/common';
import { BatchesRepository } from '../persistence/batches.repository';
import { ERROR_SAMPLE_SIZE, RunStatus } from '../persistence/documents';
import { QuarantineRepository } from '../persistence/quarantine.repository';
import { ReceiptsRepository } from '../persistence/receipts.repository';
import { RunsRepository } from '../persistence/runs.repository';

/** Decides when a run is over and with which status. Safe to call any number of times. */
@Injectable()
export class RunFinalizer {
  constructor(
    private readonly runs: RunsRepository,
    private readonly batches: BatchesRepository,
    private readonly receipts: ReceiptsRepository,
    private readonly quarantine: QuarantineRepository,
  ) {}

  async finishIfComplete(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run || run.status !== 'running' || !run.dispatchDone) return;
    if (await this.batches.hasStatus(runId, 'pending')) return;

    // Read the totals only now. A batch closes after all its receipts are saved, so with dispatch
    // done and no pending batch the totals are final, whichever worker gets here first.
    const [counters, errorSample, hasDeadBatch] = await Promise.all([
      this.receipts.totals(runId),
      this.quarantine.sample(runId, ERROR_SAMPLE_SIZE),
      this.batches.hasStatus(runId, 'dead'),
    ]);

    let status: Exclude<RunStatus, 'running'> = 'completed';
    if (counters.failed > 0) status = 'completed_with_errors';
    if (run.dispatchFailed || hasDeadBatch) status = 'failed';

    if (await this.runs.finish(runId, status, run.startedAt, counters, errorSample)) {
      await this.receipts.deleteForRun(runId);
    }
  }

  async dispatchFailed(runId: string, reason: string): Promise<void> {
    await this.runs.markDispatchFailed(runId, reason);
    await this.finishIfComplete(runId);
  }
}
