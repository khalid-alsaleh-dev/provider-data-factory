import { Injectable } from '@nestjs/common';
import { Collection, UpdateFilter } from 'mongodb';
import { Source } from '../core/contracts';
import { RUNS } from './collections';
import { Checkpoint, ErrorSample, RunCounters, RunDocument, RunStatus } from './documents';
import { MongoService } from './mongo.service';

const ERROR_SAMPLE_SIZE = 10;

@Injectable()
export class RunsRepository {
  private readonly runs: Collection<RunDocument>;

  constructor(mongo: MongoService) {
    this.runs = mongo.target.collection<RunDocument>(RUNS);
  }

  async insert(run: RunDocument): Promise<void> {
    await this.runs.insertOne(run);
  }

  findById(id: string): Promise<RunDocument | null> {
    return this.runs.findOne({ _id: id });
  }

  async saveCheckpoint(runId: string, source: Source, checkpoint: Checkpoint): Promise<void> {
    await this.runs.updateOne({ _id: runId }, { $set: { [`checkpoints.${source}`]: checkpoint } });
  }

  async markDispatchDone(runId: string): Promise<void> {
    await this.runs.updateOne({ _id: runId }, { $set: { dispatchDone: true } });
  }

  async markDispatchFailed(runId: string, reason: string): Promise<void> {
    await this.runs.updateOne(
      { _id: runId },
      { $set: { dispatchDone: true, dispatchFailed: true, dispatchError: reason } },
    );
  }

  /** Adds one document's results to the counters and appends to the capped error sample. */
  async recordDocument(runId: string, counters: RunCounters, errors: ErrorSample[]): Promise<void> {
    const update: UpdateFilter<RunDocument> = {
      $inc: {
        'counters.read': counters.read,
        'counters.transformed': counters.transformed,
        'counters.written': counters.written,
        'counters.skipped': counters.skipped,
        'counters.failed': counters.failed,
      },
    };
    if (errors.length > 0) {
      update.$push = {
        errorSample: { $each: errors.slice(0, ERROR_SAMPLE_SIZE), $slice: ERROR_SAMPLE_SIZE },
      };
    }
    await this.runs.updateOne({ _id: runId }, update);
  }

  /** Moves a run out of `running`. A no-op when another worker already finished it. */
  async finish(
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    startedAt: Date,
  ): Promise<void> {
    const finishedAt = new Date();
    await this.runs.updateOne(
      { _id: runId, status: 'running' },
      {
        $set: { status, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() },
      },
    );
  }

  async markFailed(runId: string, reason: string): Promise<void> {
    const finishedAt = new Date();
    await this.runs.updateOne(
      { _id: runId, status: 'running' },
      { $set: { status: 'failed', finishedAt, dispatchError: reason } },
    );
  }
}
