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
