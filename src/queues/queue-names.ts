import type { Queue } from 'bullmq';

export const DISPATCH_QUEUE = 'factory-dispatch';
export const BATCHES_QUEUE = 'factory-batches';
export const DEAD_LETTER_QUEUE = 'factory-dead-letters';

export interface DispatchJobData {
  runId: string;
}

export interface BatchJobData {
  runId: string;
  batchId: string;
}

export interface DeadLetterJobData {
  runId: string;
  batchId: string;
  source: string;
  sourceIds: string[];
  reason: string;
}

// Job IDs equal the run or batch ID, so enqueueing the same work twice adds nothing while the
// first job is still kept in Redis. Every producer goes through these helpers.

export async function enqueueDispatch(queue: Queue<DispatchJobData>, runId: string): Promise<void> {
  await queue.add('dispatch', { runId }, { jobId: runId });
}

export async function enqueueBatch(
  queue: Queue<BatchJobData>,
  runId: string,
  batchId: string,
): Promise<void> {
  await queue.add('batch', { batchId, runId }, { jobId: batchId });
}
