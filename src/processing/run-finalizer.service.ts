import { Injectable } from '@nestjs/common';
import { BatchesRepository } from '../persistence/batches.repository';
import { RunStatus } from '../persistence/documents';
import { RunsRepository } from '../persistence/runs.repository';

/** Decides when a run is over and with which status. Safe to call any number of times. */
@Injectable()
export class RunFinalizer {
  constructor(
    private readonly runs: RunsRepository,
    private readonly batches: BatchesRepository,
  ) {}

  async finishIfComplete(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run || run.status !== 'running' || !run.dispatchDone) return;
    if (await this.batches.hasStatus(runId, 'pending')) return;

    let status: Exclude<RunStatus, 'running'> = 'completed';
    if (run.counters.failed > 0) status = 'completed_with_errors';
    if (run.dispatchFailed || (await this.batches.hasStatus(runId, 'dead'))) status = 'failed';
    await this.runs.finish(runId, status, run.startedAt);
  }

  async dispatchFailed(runId: string, reason: string): Promise<void> {
    await this.runs.markDispatchFailed(runId, reason);
    await this.finishIfComplete(runId);
  }
}
