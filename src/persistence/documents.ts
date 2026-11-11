import { Issue, Source } from '../core/contracts';

export type RunStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface Checkpoint {
  /** Highest source _id when the run started; later inserts are not part of the run. */
  upper?: string;
  /** Last source _id that was put in a batch. */
  after?: string;
  count: number;
  done?: boolean;
}

export interface RunCounters {
  read: number;
  transformed: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface ErrorSample {
  sourceId: string;
  path: string;
  reason: string;
}

export interface RunDocument {
  _id: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  dispatchDone: boolean;
  dispatchFailed?: boolean;
  dispatchError?: string;
  limit?: number;
  checkpoints: Partial<Record<Source, Checkpoint>>;
  counters: RunCounters;
  errorSample: ErrorSample[];
}

export type BatchStatus = 'pending' | 'completed' | 'dead';

export interface BatchDocument {
  _id: string;
  runId: string;
  source: Source;
  ids: string[];
  status: BatchStatus;
  finishedAt?: Date;
}

export interface QuarantinedIssueDocument extends Issue {
  _id: string;
  runId: string;
  batchId: string;
  source: Source;
  sourceId: string;
}

export interface ReceiptDocument {
  _id: string;
}
