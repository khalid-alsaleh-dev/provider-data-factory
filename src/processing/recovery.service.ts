import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { safeError } from '../common/safe-error';
import { BatchesRepository } from '../persistence/batches.repository';
import { RunsRepository } from '../persistence/runs.repository';
import {
  BATCHES_QUEUE,
  BatchJobData,
  DISPATCH_QUEUE,
  DispatchJobData,
  enqueueBatch,
  enqueueDispatch,
} from '../queues/queue-names';
import { RunFinalizer } from './run-finalizer.service';

/**
 * On startup, re-enqueues the work of every unfinished run: its dispatcher job while dispatch is
 * not done, otherwise one job per pending batch. Job IDs make this a no-op for jobs Redis still
 * holds, so it only repairs work lost between saving a run and enqueueing it, or lost by Redis.
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly runs: RunsRepository,
    private readonly batches: BatchesRepository,
    private readonly finalizer: RunFinalizer,
    @InjectQueue(DISPATCH_QUEUE) private readonly dispatchQueue: Queue<DispatchJobData>,
    @InjectQueue(BATCHES_QUEUE) private readonly batchQueue: Queue<BatchJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const runs = await this.recover();
      if (runs > 0) this.logger.log({ event: 'recovery_done', runs });
    } catch (error) {
      // Recovery is best effort; the API and workers must still start.
      this.logger.error({ event: 'recovery_failed', error: safeError(error) });
    }
  }

  /** Returns the number of unfinished runs that were checked. */
  async recover(): Promise<number> {
    let count = 0;
    for await (const run of this.runs.findRunning()) {
      count++;
      if (!run.dispatchDone) {
        await enqueueDispatch(this.dispatchQueue, run._id);
        continue;
      }
      for await (const batch of this.batches.findPending(run._id)) {
        await enqueueBatch(this.batchQueue, run._id, batch._id);
      }
      // Dispatch and all batches may have finished before the run was marked finished.
      await this.finalizer.finishIfComplete(run._id);
    }
    return count;
  }
}
