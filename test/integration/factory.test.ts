import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { INestApplication } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import { configureApp } from '../../src/app.setup';
import { MongoService } from '../../src/persistence/mongo.service';
import { DocumentWriter } from '../../src/processing/document-writer.service';
import { BATCHES_QUEUE, DEAD_LETTER_QUEUE, DISPATCH_QUEUE } from '../../src/queues/queue-names';
import { SourceRepository } from '../../src/persistence/source.repository';
import { collections } from '../../src/core/contracts';
import { transform } from '../../src/core/pipeline';
import { XbyteAdapter } from '../../src/providers/xbyte/adapter';
import { location, listing, menu } from '../fixtures';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function until<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for factory state');
}

test(
  'real Mongo + Redis: HTTP, idempotency, receipts, recovery and DLQ',
  { timeout: 480000 },
  async (t) => {
    let server: MongoMemoryServer | undefined,
      redisProcess: ChildProcess | undefined,
      app: INestApplication | undefined;
    const previous = { ...process.env };
    try {
      server = await MongoMemoryServer.create();
      const redisPort = await port();
      redisProcess = spawn(
        process.env.REDIS_SERVER_PATH ?? 'redis-server',
        ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
        { windowsHide: true, stdio: 'ignore' },
      );
      let redisError: Error | undefined;
      redisProcess.on('error', (e) => {
        redisError = e;
      });
      await until(async () => {
        if (redisError) throw redisError;
        return new Promise<boolean>((resolve) => {
          const socket = require('node:net').connect(redisPort, '127.0.0.1');
          socket.on('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
        });
      }, Boolean);
      Object.assign(process.env, {
        MONGO_URI: server.getUri(),
        RAW_DB: 'raw_test',
        TARGET_DB: 'domain_test',
        REDIS_URL: `redis://127.0.0.1:${redisPort}`,
        BATCH_SIZE: '2',
        WORKER_CONCURRENCY: '2',
        JOB_ATTEMPTS: '2',
        BACKOFF_MS: '100',
      });
      const boot = async () => {
        // Imported here, after the environment is set: ConfigModule.forRoot() validates it on import.
        const { AppModule } = await import('../../src/app.module');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const instance = configureApp(moduleRef.createNestApplication({ logger: false }));
        await instance.listen(0, '127.0.0.1');
        return instance;
      };
      app = await boot();
      let base = await app.getUrl();
      let mongo = app.get(MongoService),
        batchQueue = app.get<Queue>(getQueueToken(BATCHES_QUEUE));
      const deadLetterQueue = () => app!.get<Queue>(getQueueToken(DEAD_LETTER_QUEUE));
      const postRun = async (body = {}) => {
        const response = await fetch(`${base}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 202);
        return response.json();
      };
      const waitRun = (id: string) =>
        until(
          async () => (await fetch(`${base}/runs/${id}`)).json(),
          (r) => r.status !== 'running',
        );
      const snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            collections.map(async (c) => [
              c,
              await mongo.target.collection(c).find({}).sort({ _id: 1 }).toArray(),
            ]),
          ),
        );
      const restaurantId = new ObjectId();
      await mongo.raw
        .collection('xbyte-raw-locations')
        .insertOne({ _id: new ObjectId(), ...location() });
      await mongo.raw
        .collection('xbyte-raw-restaurants')
        .insertOne({ _id: restaurantId, ...listing() });
      await mongo.raw.collection('xbyte-raw-menus').insertMany([
        { _id: new ObjectId(), ...menu() },
        {
          _id: new ObjectId(),
          domain: 'talabat',
          statusCode: 200,
          payload: { Message: 'This is not restaurant page' },
        },
      ]);
      await t.test(
        'full pipeline through HTTP produces modular model and paginated quarantine',
        async () => {
          assert.equal((await fetch(`${base}/health`)).status, 200);
          assert.equal((await fetch(`${base}/docs-json`)).status, 200);
          assert.equal(
            (
              await fetch(`${base}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"limit":0}',
              })
            ).status,
            400,
          );
          assert.equal((await fetch(`${base}/runs/missing`)).status, 404);
          const run = await waitRun((await postRun())._id);
          assert.equal(run.status, 'completed_with_errors');
          assert.equal(run.counters.read, 4);
          assert.equal(run.counters.failed, 1);
          const errors = await (await fetch(`${base}/runs/${run._id}/errors?limit=1`)).json();
          assert.equal(errors.data.length, 1);
          assert.equal(await mongo.target.collection('items').countDocuments(), 1);
          assert.equal(await mongo.target.collection('category_items').countDocuments(), 2);
          assert.equal(
            (
              await mongo.target
                .collection<any>('restaurants')
                .findOne({ _id: 'xbyte-talabat/restaurants/123' })
            )?.name,
            'Full restaurant',
          );
        },
      );
      await t.test('second run has identical domain state and zero writes', async () => {
        const before = await snapshot();
        const run = await waitRun((await postRun())._id);
        assert.equal(run.counters.written, 0);
        assert.equal(run.counters.read, 4);
        assert.deepEqual(await snapshot(), before);
      });
      await t.test('queued batch + one completed document survives app restart', async () => {
        await batchQueue.pause();
        const run = await postRun({ collections: ['restaurants'] });
        const batch = await until<any>(
          () => mongo.target.collection<any>('batches').findOne({ runId: run._id }),
          Boolean,
        );
        const raw = await mongo.raw
          .collection('xbyte-raw-restaurants')
          .findOne({ _id: restaurantId });
        const result = transform(new XbyteAdapter(), raw, {
          source: 'restaurants',
          sourceId: restaurantId.toHexString(),
        });
        await app!
          .get(DocumentWriter)
          .write(run._id, batch._id, 'restaurants', restaurantId.toHexString(), result);
        await until(
          () => mongo.target.collection<any>('runs').findOne({ _id: run._id }),
          (r) => r.dispatchDone,
        );
        await app!.close();
        app = await boot();
        base = await app.getUrl();
        mongo = app.get(MongoService);
        batchQueue = app.get<Queue>(getQueueToken(BATCHES_QUEUE));
        await batchQueue.resume();
        const finished = await waitRun(run._id);
        assert.equal(finished.counters.read, 1);
        assert.equal(finished.status, 'completed');
        assert.equal(
          await mongo.target
            .collection('receipts')
            .countDocuments({ _id: `${run._id}/restaurants/${restaurantId.toHexString()}` } as any),
          1,
        );
      });
      await t.test(
        'dispatcher retries from its checkpoint and respects the collection limit',
        async (st) => {
          const extraIds = [new ObjectId(), new ObjectId()];
          await mongo.raw
            .collection('xbyte-raw-menus')
            .insertMany(extraIds.map((_id) => ({ _id, ...menu() })));
          const repository = app!.get(SourceRepository);
          const original = repository.page.bind(repository);
          let calls = 0;
          st.mock.method(repository, 'page', async (...args: Parameters<typeof original>) => {
            calls++;
            if (calls === 2) throw new Error('Synthetic read failure after first page');
            return original(...args);
          });
          try {
            const run = await waitRun((await postRun({ collections: ['menus'], limit: 3 }))._id);
            assert.equal(run.status, 'completed_with_errors');
            assert.equal(run.counters.read, 3);
            assert.equal(run.checkpoints.menus.count, 3);
            assert.ok(calls >= 3);
          } finally {
            await mongo.raw.collection('xbyte-raw-menus').deleteMany({ _id: { $in: extraIds } });
          }
        },
      );
      await t.test(
        'shutdown during dispatch parks the job without spending a retry',
        async (st) => {
          const extraIds = [new ObjectId(), new ObjectId(), new ObjectId()];
          await mongo.raw
            .collection('xbyte-raw-menus')
            .insertMany(extraIds.map((_id) => ({ _id, ...menu() })));
          try {
            const repository = app!.get(SourceRepository);
            const original = repository.page.bind(repository);
            let calls = 0;
            st.mock.method(repository, 'page', async (...args: Parameters<typeof original>) => {
              calls++;
              await new Promise((resolve) => setTimeout(resolve, 300));
              return original(...args);
            });
            const run = await postRun({ collections: ['menus'] });
            await until(
              async () => calls,
              (n) => n >= 1,
            );
            await app!.close();
            assert.equal(calls, 1, 'the dispatcher stops after the page in progress');

            app = await boot();
            base = await app.getUrl();
            mongo = app.get(MongoService);
            batchQueue = app.get<Queue>(getQueueToken(BATCHES_QUEUE));
            const finished = await waitRun(run._id);
            assert.equal(finished.status, 'completed_with_errors');
            assert.equal(finished.counters.read, 5);
            assert.equal(finished.dispatchFailed, undefined);
            const job = await app.get<Queue>(getQueueToken(DISPATCH_QUEUE)).getJob(run._id);
            // One successful attempt; the interrupted one was not counted as a failure.
            assert.equal(job?.attemptsMade, 1);
            assert.equal(await job?.getState(), 'completed');
          } finally {
            await mongo.raw.collection('xbyte-raw-menus').deleteMany({ _id: { $in: extraIds } });
          }
        },
      );
      await t.test(
        'source read failure retries, exhausts, and creates a dead letter',
        async (st) => {
          const repository = app!.get(SourceRepository);
          let attempts = 0;
          st.mock.method(repository, 'get', async () => {
            attempts++;
            throw new Error('Synthetic source read outage');
          });
          const run = await waitRun((await postRun({ collections: ['locations'] }))._id);
          assert.equal(run.status, 'failed');
          assert.equal(run.counters.read, 1);
          assert.ok(attempts >= 2);
          await until(
            async () => deadLetterQueue().getWaitingCount(),
            (n) => n >= 1,
          );
          assert.equal(
            await mongo.target
              .collection('batches')
              .countDocuments({ runId: run._id, status: 'dead' }),
            1,
          );
        },
      );
      // Optional real-export smoke test: no source fixtures are committed to Git.
      if (process.env.SAMPLE_DIR)
        await t.test(
          'downloaded samples seed and run twice without domain drift',
          { timeout: 300000 },
          async () => {
            for (const s of ['locations', 'restaurants', 'menus'])
              await mongo.raw.collection(`xbyte-raw-${s}`).deleteMany({});
            const seed = spawn(
              process.execPath,
              ['dist/scripts/seed-raw.js', '--dir', process.env.SAMPLE_DIR!],
              { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let output = '';
            seed.stdout.on('data', (b) => {
              output += b;
            });
            seed.stderr.on('data', (b) => {
              output += b;
            });
            const exit = await new Promise((resolve) => seed.on('exit', resolve));
            assert.equal(exit, 0, output);
            console.log(output.trim());
            const realId = (await postRun())._id;
            const run = await until(
              async () => (await fetch(`${base}/runs/${realId}`)).json(),
              (r) => r.status !== 'running',
              140000,
            );
            console.log('sample run', run.counters);
            const state = await snapshot();
            const secondId = (await postRun())._id;
            const second = await until(
              async () => (await fetch(`${base}/runs/${secondId}`)).json(),
              (r) => r.status !== 'running',
              140000,
            );
            assert.deepEqual(await snapshot(), state);
            assert.equal(second.counters.written, 0);
            assert.equal(run.counters.read, 578);
            assert.equal(
              run.counters.failed,
              157,
              'Only the 155 menu and two listing application-error envelopes should quarantine',
            );
            assert.ok(
              (await mongo.target.collection('items').countDocuments()) > 1000,
              'Real menus must produce items; rejecting every menu is not success',
            );
            assert.equal(await mongo.raw.collection('xbyte-raw-menus').countDocuments(), 500);
          },
        );
    } finally {
      if (app) await app.close();
      redisProcess?.kill();
      if (server) await server.stop();
      process.env = previous;
    }
  },
);
