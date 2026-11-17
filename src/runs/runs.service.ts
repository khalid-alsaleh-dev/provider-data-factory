import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { safeError } from '../common/safe-error';
import {
  emptyCounters,
  ERROR_SAMPLE_SIZE,
  QuarantinedIssueDocument,
  RunDocument,
} from '../persistence/documents';
import { QuarantineRepository } from '../persistence/quarantine.repository';
import { ReceiptsRepository } from '../persistence/receipts.repository';
import { RunsRepository } from '../persistence/runs.repository';
import { SourceRepository } from '../persistence/source.repository';
import { DISPATCH_QUEUE, DispatchJobData, enqueueDispatch } from '../queues/queue-names';
import { CreateRunDto } from './dto/create-run.dto';
import { ListErrorsQueryDto } from './dto/list-errors-query.dto';
import { QuarantinedIssueResponse, RunErrorsPageResponse, RunResponse } from './dto/run.response';

@Injectable()
export class RunsService {
  constructor(
    private readonly runs: RunsRepository,
    private readonly quarantine: QuarantineRepository,
    private readonly receipts: ReceiptsRepository,
    private readonly source: SourceRepository,
    @InjectQueue(DISPATCH_QUEUE) private readonly dispatchQueue: Queue<DispatchJobData>,
  ) {}

  /** Saves a new run and enqueues its dispatcher job. Processing continues in the background. */
  async create(input: CreateRunDto): Promise<RunResponse> {
    const run: RunDocument = {
      _id: randomUUID(),
      status: 'running',
      startedAt: new Date(),
      dispatchDone: false,
      checkpoints: {},
      counters: emptyCounters(),
      errorSample: [],
      ...(input.limit !== undefined && { limit: input.limit }),
    };
    // Fix the upper bound now, so documents inserted during the run are not picked up.
    for (const collection of input.collections) {
      run.checkpoints[collection] = { upper: await this.source.upper(collection), count: 0 };
    }

    await this.runs.insert(run);
    try {
      await enqueueDispatch(this.dispatchQueue, run._id);
    } catch (error) {
      await this.runs.markFailed(run._id, safeError(error), run.startedAt);
      throw error;
    }
    return toRunResponse(run);
  }

  /** Finished runs return their stored totals; running ones are summed live from receipts. */
  async findOne(id: string): Promise<RunResponse> {
    const run = await this.findRun(id);
    if (run.status === 'running') {
      const [counters, errorSample] = await Promise.all([
        this.receipts.totals(id),
        this.quarantine.sample(id, ERROR_SAMPLE_SIZE),
      ]);
      return toRunResponse({ ...run, counters, errorSample });
    }
    return toRunResponse(run);
  }

  async listErrors(id: string, query: ListErrorsQueryDto): Promise<RunErrorsPageResponse> {
    await this.findRun(id);
    const page = await this.quarantine.page(id, query.after, query.limit);
    return { data: page.data.map(toIssueResponse), next: page.next };
  }

  private async findRun(id: string): Promise<RunDocument> {
    const run = await this.runs.findById(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }
}

// Explicit mapping keeps the HTTP contract independent of how runs are stored.

function toRunResponse(run: RunDocument): RunResponse {
  return {
    _id: run._id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    dispatchDone: run.dispatchDone,
    dispatchFailed: run.dispatchFailed,
    dispatchError: run.dispatchError,
    limit: run.limit,
    checkpoints: run.checkpoints,
    counters: { ...run.counters },
    errorSample: run.errorSample.map(({ sourceId, path, reason }) => ({ sourceId, path, reason })),
  };
}

function toIssueResponse(issue: QuarantinedIssueDocument): QuarantinedIssueResponse {
  const { _id, runId, batchId, source, sourceId, path, reason } = issue;
  return { _id, runId, batchId, source, sourceId, path, reason };
}
