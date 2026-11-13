import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { EnvironmentVariables, validateEnvironment } from './config/environment';
import { redisConnection } from './config/redis-connection';
import { HealthModule } from './health/health.module';
import { MongoModule } from './persistence/mongo.module';
import { ProcessingModule } from './processing/processing.module';
import { RunsModule } from './runs/runs.module';

const HOUR_SECONDS = 60 * 60;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        connection: redisConnection(config.get('REDIS_URL', { infer: true })),
        defaultJobOptions: {
          attempts: config.get('JOB_ATTEMPTS', { infer: true }),
          backoff: { type: 'exponential', delay: config.get('BACKOFF_MS', { infer: true }) },
          // Finished jobs are kept long enough for job-ID deduplication of dispatcher retries,
          // then removed so Redis does not grow without bound.
          removeOnComplete: { age: 24 * HOUR_SECONDS },
          removeOnFail: { age: 7 * 24 * HOUR_SECONDS },
        },
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    MongoModule,
    RunsModule,
    ProcessingModule,
    HealthModule,
  ],
})
export class AppModule {}
