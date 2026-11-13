import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { safeError } from '../common/safe-error';
import { RunDocument } from '../persistence/documents';
import { QuarantinePage, QuarantineRepository } from '../persistence/quarantine.repository';
import { RunsRepository } from '../persistence/runs.repository';
import { SourceRepository } from '../persistence/source.repository';
import { DISPATCH_QUEUE, DispatchJobData } from '../queues/queue-names';
import { CreateRunDto } from './dto/create-run.dto';
import { ListErrorsQueryDto } from './dto/list-errors-query.dto';

@Injectable()
export class RunsService {
  constructor(
    private readonly runs: RunsRepository,
    private readonly quarantine: QuarantineRepository,
    private readonly source: SourceRepository,
    @InjectQueue(DISPATCH_QUEUE) private readonly dispatchQueue: Queue<DispatchJobData>,
  ) {}

  /** Saves a new run and enqueues its dispatcher job. Processing continues in the background. */
  async create(input: CreateRunDto): Promise<RunDocument> {
    const run: RunDocument = {
      _id: randomUUID(),
      status: 'running',
      startedAt: new Date(),
      dispatchDone: false,
      checkpoints: {},
      counters: { read: 0, transformed: 0, written: 0, skipped: 0, failed: 0 },
      errorSample: [],
      ...(input.limit !== undefined && { limit: input.limit }),
    };
    // Fix the upper bound now, so documents inserted during the run are not picked up.
    for (const collection of input.collections) {
      run.checkpoints[collection] = { upper: await this.source.upper(collection), count: 0 };
    }

    await this.runs.insert(run);
    try {
      await this.dispatchQueue.add('dispatch', { runId: run._id }, { jobId: run._id });
    } catch (error) {
      await this.runs.markFailed(run._id, safeError(error));
      throw error;
    }
    return run;
  }

  async findOne(id: string): Promise<RunDocument> {
    const run = await this.runs.findById(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }

  async listErrors(id: string, query: ListErrorsQueryDto): Promise<QuarantinePage> {
    await this.findOne(id);
    return this.quarantine.page(id, query.after, query.limit);
  }
}
