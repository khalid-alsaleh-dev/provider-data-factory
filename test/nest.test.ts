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
import { RunDocument } from '../src/persistence/documents';
import { QuarantineRepository } from '../src/persistence/quarantine.repository';
import { RunsRepository } from '../src/persistence/runs.repository';
import { SourceRepository } from '../src/persistence/source.repository';
import { isFinalAttempt } from '../src/processing/attempts';
import { RunFinalizer } from '../src/processing/run-finalizer.service';
import { DISPATCH_QUEUE } from '../src/queues/queue-names';
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

test('RunFinalizer waits for dispatch and pending batches, then picks the status', async () => {
  const cases: { run: RunDocument; pending: boolean; dead: boolean; expected?: string }[] = [
    { run: run({ dispatchDone: false }), pending: false, dead: false },
    { run: run(), pending: true, dead: false },
    { run: run({ status: 'completed' }), pending: false, dead: false },
    { run: run(), pending: false, dead: false, expected: 'completed' },
    {
      run: run({ counters: { read: 1, transformed: 0, written: 0, skipped: 0, failed: 2 } }),
      pending: false,
      dead: false,
      expected: 'completed_with_errors',
    },
    { run: run(), pending: false, dead: true, expected: 'failed' },
    { run: run({ dispatchFailed: true }), pending: false, dead: false, expected: 'failed' },
  ];
  for (const { run: current, pending, dead, expected } of cases) {
    const finished: string[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        RunFinalizer,
        {
          provide: RunsRepository,
          useValue: {
            findById: async () => current,
            finish: async (_id: string, status: string) => finished.push(status),
          },
        },
        {
          provide: BatchesRepository,
          useValue: {
            hasStatus: async (_id: string, status: string) =>
              status === 'pending' ? pending : dead,
          },
        },
      ],
    }).compile();
    await moduleRef.get(RunFinalizer).finishIfComplete(current._id);
    assert.deepEqual(finished, expected ? [expected] : []);
  }
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
