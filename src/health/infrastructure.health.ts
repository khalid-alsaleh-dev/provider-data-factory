import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { MongoService } from '../persistence/mongo.service';
import { DISPATCH_QUEUE } from '../queues/queue-names';

const TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Pings MongoDB and Redis. Failure details are not exposed, as they may contain connection URLs. */
@Injectable()
export class InfrastructureHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly mongo: MongoService,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
  ) {}

  async mongodb(): Promise<HealthIndicatorResult<'mongodb'>> {
    const indicator = this.health.check('mongodb');
    try {
      await withTimeout(
        Promise.all([this.mongo.raw.command({ ping: 1 }), this.mongo.target.command({ ping: 1 })]),
      );
      return indicator.up();
    } catch {
      return indicator.down();
    }
  }

  async redis(): Promise<HealthIndicatorResult<'redis'>> {
    const indicator = this.health.check('redis');
    try {
      // A cheap round trip through BullMQ's own connection.
      await withTimeout(this.queue.count());
      return indicator.up();
    } catch {
      return indicator.down();
    }
  }
}
