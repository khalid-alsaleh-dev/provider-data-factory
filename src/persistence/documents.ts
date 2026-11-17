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

/** How many quarantined issues a run summary shows. */
export const ERROR_SAMPLE_SIZE = 10;

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
  /** Final totals, stored when the run finishes. While it runs, totals are summed from receipts. */
  counters: RunCounters;
  /** First quarantined issues, stored when the run finishes. */
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

/** Marks one source document as processed within a run and holds its share of the run counters. */
export interface ReceiptDocument {
  _id: string;
  runId: string;
  counters: RunCounters;
}

export function emptyCounters(): RunCounters {
  return { read: 0, transformed: 0, written: 0, skipped: 0, failed: 0 };
}
