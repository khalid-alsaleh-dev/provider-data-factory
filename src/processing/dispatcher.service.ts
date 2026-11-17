import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EnvironmentVariables } from '../config/environment';
import { Source, sources } from '../core/contracts';
import { BatchesRepository } from '../persistence/batches.repository';
import { Checkpoint, RunDocument } from '../persistence/documents';
import { RunsRepository } from '../persistence/runs.repository';
import { SourceRepository } from '../persistence/source.repository';
import { BATCHES_QUEUE, BatchJobData, enqueueBatch } from '../queues/queue-names';
import { RunFinalizer } from './run-finalizer.service';

export type DispatchOutcome = 'done' | 'interrupted';

/** Pages through the selected source collections and enqueues one job per batch. */
@Injectable()
export class DispatcherService {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly source: SourceRepository,
    private readonly batches: BatchesRepository,
    private readonly runs: RunsRepository,
    private readonly finalizer: RunFinalizer,
    @InjectQueue(BATCHES_QUEUE) private readonly batchQueue: Queue<BatchJobData>,
  ) {}

  /**
   * Resumes from the saved checkpoints. Returns 'interrupted' when `shouldStop` turns true, so the
   * caller can reschedule the job without spending a retry attempt.
   */
  async dispatch(runId: string, shouldStop: () => boolean): Promise<DispatchOutcome> {
    const run = await this.runs.findById(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== 'running') return 'done';
    if (run.dispatchDone) {
      // A repeated job (e.g. re-queued by recovery) may find a run whose last step was lost.
      await this.finalizer.finishIfComplete(runId);
      return 'done';
    }

    for (const collection of sources) {
      const checkpoint = run.checkpoints[collection];
      if (!checkpoint) continue; // This collection was not selected.
      const outcome = await this.dispatchCollection(run, collection, checkpoint, shouldStop);
      if (outcome === 'interrupted') return outcome;
    }

    await this.runs.markDispatchDone(runId);
    await this.finalizer.finishIfComplete(runId);
    return 'done';
  }

  private async dispatchCollection(
    run: RunDocument,
    collection: Source,
    checkpoint: Checkpoint,
    shouldStop: () => boolean,
  ): Promise<DispatchOutcome> {
    if (checkpoint.done || !checkpoint.upper) return 'done';

    let batchSize = this.batchSize(run, checkpoint);
    while (batchSize > 0) {
      if (shouldStop()) return 'interrupted';

      const ids = await this.source.page(collection, checkpoint.after, checkpoint.upper, batchSize);
      if (ids.length === 0) break;

      const batch = await this.batches.create(run._id, collection, ids);
      await enqueueBatch(this.batchQueue, run._id, batch._id);

      // Save progress after enqueueing. A retry re-reads the same page, producing the same
      // batch and job ID, so nothing is enqueued twice.
      checkpoint.after = ids[ids.length - 1];
      checkpoint.count += ids.length;
      await this.runs.saveCheckpoint(run._id, collection, checkpoint);
      batchSize = this.batchSize(run, checkpoint);
    }

    checkpoint.done = true;
    await this.runs.saveCheckpoint(run._id, collection, checkpoint);
    return 'done';
  }

  /** The configured batch size, reduced so the run's per-collection limit is not exceeded. */
  private batchSize(run: RunDocument, checkpoint: Checkpoint): number {
    const size = this.config.get('BATCH_SIZE', { infer: true });
    if (run.limit === undefined) return size;
    return Math.min(size, run.limit - checkpoint.count);
  }
}
