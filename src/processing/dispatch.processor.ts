import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { safeError } from '../common/safe-error';
import { DISPATCH_QUEUE, DispatchJobData } from '../queues/queue-names';
import { isFinalAttempt } from './attempts';
import { DispatcherService } from './dispatcher.service';
import { RunFinalizer } from './run-finalizer.service';

const RESUME_DELAY_MS = 1000;

@Processor(DISPATCH_QUEUE)
export class DispatchProcessor extends WorkerHost implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DispatchProcessor.name);
  private stopping = false;

  constructor(
    private readonly dispatcher: DispatcherService,
    private readonly finalizer: RunFinalizer,
  ) {
    super();
  }

  async process(job: Job<DispatchJobData>, token?: string): Promise<void> {
    let outcome;
    try {
      outcome = await this.dispatcher.dispatch(job.data.runId, () => this.stopping);
    } catch (error) {
      if (isFinalAttempt(job))
        await this.finalizer.dispatchFailed(job.data.runId, safeError(error));
      throw error;
    }

    if (outcome === 'interrupted') {
      // Shutting down: park the job without using up a retry; it resumes from its checkpoint.
      await job.moveToDelayed(Date.now() + RESUME_DELAY_MS, token);
      throw new DelayedError();
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<DispatchJobData> | undefined, error: Error): void {
    this.logger.warn({
      event: 'dispatch_attempt_failed',
      runId: job?.data.runId,
      jobId: job?.id,
      error: safeError(error),
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.worker.close();
  }
}
