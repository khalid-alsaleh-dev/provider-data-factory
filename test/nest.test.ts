import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArgumentMetadata,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { ApiKeyGuard } from '../src/common/api-key.guard';
import { BatchesRepository } from '../src/persistence/batches.repository';
import { RunCounters, RunDocument } from '../src/persistence/documents';
import { QuarantineRepository } from '../src/persistence/quarantine.repository';
import { ReceiptsRepository } from '../src/persistence/receipts.repository';
import { RunsRepository } from '../src/persistence/runs.repository';
import { SourceRepository } from '../src/persistence/source.repository';
import { isFinalAttempt } from '../src/processing/attempts';
import { RecoveryService } from '../src/processing/recovery.service';
import { RunFinalizer } from '../src/processing/run-finalizer.service';
import { BATCHES_QUEUE, DISPATCH_QUEUE } from '../src/queues/queue-names';
import { CreateRunDto } from '../src/runs/dto/create-run.dto';
import { ListErrorsQueryDto } from '../src/runs/dto/list-errors-query.dto';
import { RunsService } from '../src/runs/runs.service';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});
const query = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'query',
  metatype,
});

function run(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    _id: 'run-1',
    status: 'running',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    dispatchDone: true,
    checkpoints: {},
    counters: { read: 1, transformed: 1, written: 1, skipped: 0, failed: 0 },
    errorSample: [],
    ...overrides,
  };
}

test('CreateRunDto applies defaults and rejects invalid bodies', async () => {
  const defaults: CreateRunDto = await pipe.transform({}, body(CreateRunDto));
  assert.deepEqual(defaults.collections, ['locations', 'restaurants', 'menus']);
  assert.equal(defaults.limit, undefined);

  const slice: CreateRunDto = await pipe.transform(
    { collections: ['menus'], limit: 10 },
    body(CreateRunDto),
  );
  assert.deepEqual(slice.collections, ['menus']);
  assert.equal(slice.limit, 10);

  for (const invalid of [
    { limit: 0 },
    { limit: 1.5 },
    { limit: '10' },
    { collections: [] },
    { collections: ['unknown'] },
    { collections: ['menus', 'menus'] },
    { unexpected: true },
  ]) {
    await assert.rejects(
      pipe.transform(invalid, body(CreateRunDto)),
      `accepted ${JSON.stringify(invalid)}`,
    );
  }
});

test('ListErrorsQueryDto converts the limit and validates the cursor', async () => {
  const parsed: ListErrorsQueryDto = await pipe.transform(
    { limit: '5' },
    query(ListErrorsQueryDto),
  );
  assert.equal(parsed.limit, 5);
  assert.equal((await pipe.transform({}, query(ListErrorsQueryDto))).limit, 25);
  await assert.rejects(pipe.transform({ limit: '101' }, query(ListErrorsQueryDto)));
  await assert.rejects(pipe.transform({ after: 'not-a-cursor' }, query(ListErrorsQueryDto)));
  await assert.rejects(pipe.transform({ other: '1' }, query(ListErrorsQueryDto)));
});

test('RunsService saves the run, fixes upper bounds and enqueues one dispatch job', async () => {
  const inserted: RunDocument[] = [];
  const jobs: unknown[][] = [];
  const failed: string[] = [];
  const moduleRef = await Test.createTestingModule({
    providers: [
      RunsService,
      {
        provide: RunsRepository,
        useValue: {
          insert: async (r: RunDocument) => inserted.push(r),
          markFailed: async (id: string) => failed.push(id),
          findById: async () => null,
        },
      },
      { provide: QuarantineRepository, useValue: {} },
      { provide: ReceiptsRepository, useValue: {} },
      {
        provide: SourceRepository,
        useValue: { upper: async (source: string) => `${source}-upper` },
      },
      {
        provide: getQueueToken(DISPATCH_QUEUE),
        useValue: { add: async (...args: unknown[]) => jobs.push(args) },
      },
    ],
  }).compile();
  const service = moduleRef.get(RunsService);

  const created = await service.create(
    Object.assign(new CreateRunDto(), { collections: ['menus'], limit: 3 }),
  );
  assert.equal(inserted.length, 1);
  assert.deepEqual(created.checkpoints, { menus: { upper: 'menus-upper', count: 0 } });
  assert.equal(created.limit, 3);
  assert.deepEqual(jobs, [['dispatch', { runId: created._id }, { jobId: created._id }]]);
  await assert.rejects(service.findOne('missing'), NotFoundException);

  // A failed enqueue marks the run failed instead of leaving it running forever.
  const broken = await Test.createTestingModule({
    providers: [
      RunsService,
      {
        provide: RunsRepository,
        useValue: {
          insert: async () => undefined,
          markFailed: async (id: string) => failed.push(id),
        },
      },
      { provide: QuarantineRepository, useValue: {} },
      { provide: ReceiptsRepository, useValue: {} },
      { provide: SourceRepository, useValue: { upper: async () => undefined } },
      {
        provide: getQueueToken(DISPATCH_QUEUE),
        useValue: {
          add: async () => {
            throw new Error('redis down');
          },
        },
      },
    ],
  }).compile();
  await assert.rejects(broken.get(RunsService).create(new CreateRunDto()), /redis down/);
  assert.equal(failed.length, 1);
});

const totals = (overrides: Partial<RunCounters> = {}): RunCounters => ({
  read: 1,
  transformed: 1,
  written: 1,
  skipped: 0,
  failed: 0,
  ...overrides,
});

async function finalizer(options: {
  run: RunDocument;
  pending?: boolean;
  dead?: boolean;
  counters?: RunCounters;
  calls?: string[];
  finished?: { status: string; counters: RunCounters }[];
  finishWins?: boolean;
}) {
  const calls = options.calls ?? [];
  const finished = options.finished ?? [];
  const moduleRef = await Test.createTestingModule({
    providers: [
      RunFinalizer,
      {
        provide: RunsRepository,
        useValue: {
          findById: async () => options.run,
          finish: async (_id: string, status: string, _start: Date, counters: RunCounters) => {
            finished.push({ status, counters });
            return options.finishWins ?? true;
          },
        },
      },
      {
        provide: BatchesRepository,
        useValue: {
          hasStatus: async (_id: string, status: string) => {
            calls.push(`hasStatus:${status}`);
            return status === 'pending' ? !!options.pending : !!options.dead;
          },
        },
      },
      {
        provide: ReceiptsRepository,
        useValue: {
          totals: async () => {
            calls.push('totals');
            return options.counters ?? totals();
          },
          deleteForRun: async () => calls.push('deleteReceipts'),
        },
      },
      { provide: QuarantineRepository, useValue: { sample: async () => [] } },
    ],
  }).compile();
  return moduleRef.get(RunFinalizer);
}

test('RunFinalizer waits for dispatch and pending batches, then picks the status', async () => {
  const cases: {
    run: RunDocument;
    pending?: boolean;
    dead?: boolean;
    counters?: RunCounters;
    expected?: string;
  }[] = [
    { run: run({ dispatchDone: false }) },
    { run: run(), pending: true },
    { run: run({ status: 'completed' }) },
    { run: run(), expected: 'completed' },
    { run: run(), counters: totals({ failed: 2 }), expected: 'completed_with_errors' },
    { run: run(), dead: true, expected: 'failed' },
    { run: run({ dispatchFailed: true }), expected: 'failed' },
  ];
  for (const options of cases) {
    const finished: { status: string; counters: RunCounters }[] = [];
    await (await finalizer({ ...options, finished })).finishIfComplete(options.run._id);
    assert.deepEqual(
      finished.map((f) => f.status),
      options.expected ? [options.expected] : [],
    );
  }
});

test('RunFinalizer reads totals only after no batch is pending, and stores them on finish', async () => {
  const calls: string[] = [];
  const finished: { status: string; counters: RunCounters }[] = [];
  const counters = totals({ read: 7, failed: 3 });
  await (await finalizer({ run: run(), counters, calls, finished })).finishIfComplete('run-1');
  // Regression: totals read before the pending check could be stale and pick the wrong status.
  assert.ok(calls.indexOf('hasStatus:pending') < calls.indexOf('totals'));
  assert.deepEqual(finished, [{ status: 'completed_with_errors', counters }]);
  assert.equal(calls.at(-1), 'deleteReceipts');

  // A worker that loses the race to finish the run leaves the receipts alone.
  const loser: string[] = [];
  await (
    await finalizer({ run: run(), calls: loser, finishWins: false })
  ).finishIfComplete('run-1');
  assert.ok(!loser.includes('deleteReceipts'));
});

test('RecoveryService re-enqueues unfinished dispatch and pending batches with stable job IDs', async () => {
  const dispatchJobs: unknown[][] = [];
  const batchJobs: unknown[][] = [];
  const finalized: string[] = [];
  async function* iterate<T>(items: T[]) {
    yield* items;
  }
  const moduleRef = await Test.createTestingModule({
    providers: [
      RecoveryService,
      {
        provide: RunsRepository,
        useValue: {
          findRunning: () =>
            iterate([
              run({ _id: 'undispatched', dispatchDone: false }),
              run({ _id: 'dispatched' }),
            ]),
        },
      },
      {
        provide: BatchesRepository,
        useValue: {
          findPending: (runId: string) => iterate(runId === 'dispatched' ? [{ _id: 'b1' }] : []),
        },
      },
      {
        provide: RunFinalizer,
        useValue: { finishIfComplete: async (id: string) => finalized.push(id) },
      },
      {
        provide: getQueueToken(DISPATCH_QUEUE),
        useValue: { add: async (...args: unknown[]) => dispatchJobs.push(args) },
      },
      {
        provide: getQueueToken(BATCHES_QUEUE),
        useValue: { add: async (...args: unknown[]) => batchJobs.push(args) },
      },
    ],
  }).compile();

  assert.equal(await moduleRef.get(RecoveryService).recover(), 2);
  assert.deepEqual(dispatchJobs, [
    ['dispatch', { runId: 'undispatched' }, { jobId: 'undispatched' }],
  ]);
  assert.deepEqual(batchJobs, [['batch', { batchId: 'b1', runId: 'dispatched' }, { jobId: 'b1' }]]);
  assert.deepEqual(finalized, ['dispatched']);
});

test('ApiKeyGuard is open without API_KEY and checks the header when configured', () => {
  const context = (header?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }),
    }) as unknown as ExecutionContext;
  const guard = (key?: string) =>
    new ApiKeyGuard({ get: () => key } as unknown as ConfigService<never, true>);

  assert.equal(guard().canActivate(context()), true);
  const secured = guard('0123456789abcdef');
  assert.equal(secured.canActivate(context('0123456789abcdef')), true);
  assert.throws(() => secured.canActivate(context()), UnauthorizedException);
  assert.throws(() => secured.canActivate(context('0123456789abcdeX')), UnauthorizedException);
});

test('isFinalAttempt counts earlier failed attempts', () => {
  const job = (attemptsMade: number, attempts?: number) =>
    ({ attemptsMade, opts: { attempts } }) as Job;
  assert.equal(isFinalAttempt(job(0, 3)), false);
  assert.equal(isFinalAttempt(job(2, 3)), true);
  assert.equal(isFinalAttempt(job(0)), true);
});
