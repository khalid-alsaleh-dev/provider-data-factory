import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { safeError } from '../common/safe-error';
import { EnvironmentVariables } from '../config/environment';
import { BATCHES_QUEUE, BatchJobData } from '../queues/queue-names';
import { isFinalAttempt } from './attempts';
import { BatchService } from './batch.service';

@Processor(BATCHES_QUEUE)
export class BatchProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(BatchProcessor.name);

  constructor(
    private readonly batches: BatchService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
  }

  async process(job: Job<BatchJobData>): Promise<void> {
    try {
      await this.batches.process(job.data.batchId);
    } catch (error) {
      // Terminal-failure handling runs inside the job, so a crash here leaves the job stalled and
      // BullMQ runs it again, instead of leaving the batch pending forever.
      if (isFinalAttempt(job)) await this.batches.deadLetter(job.data.batchId, safeError(error));
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<BatchJobData> | undefined, error: Error): void {
    this.logger.warn({
      event: 'batch_attempt_failed',
      runId: job?.data.runId,
      jobId: job?.id,
      error: safeError(error),
    });
  }

  /** Lets the active jobs finish before MongoDB and Redis are closed in onApplicationShutdown. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close();
  }
}
