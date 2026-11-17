import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { Source } from '../core/contracts';
import { RUNS } from './collections';
import { Checkpoint, ErrorSample, RunCounters, RunDocument, RunStatus } from './documents';
import { MongoService } from './mongo.service';

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

  /** Runs that have not finished, oldest first. */
  findRunning(): AsyncIterable<RunDocument> {
    return this.runs.find({ status: 'running' }).sort({ startedAt: 1 });
  }

  /**
   * Moves a run out of `running` and stores its final counters and error sample.
   * Returns false (and changes nothing) when another worker already finished it.
   */
  async finish(
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    startedAt: Date,
    counters: RunCounters,
    errorSample: ErrorSample[],
  ): Promise<boolean> {
    const finishedAt = new Date();
    const result = await this.runs.updateOne(
      { _id: runId, status: 'running' },
      {
        $set: {
          status,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          counters,
          errorSample,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markFailed(runId: string, reason: string, startedAt: Date): Promise<void> {
    const finishedAt = new Date();
    await this.runs.updateOne(
      { _id: runId, status: 'running' },
      {
        $set: {
          status: 'failed',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          dispatchError: reason,
        },
      },
    );
  }
}
