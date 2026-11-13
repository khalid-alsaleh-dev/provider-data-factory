import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { QueuesModule } from '../queues/queues.module';
import { HealthController } from './health.controller';
import { InfrastructureHealthIndicator } from './infrastructure.health';

@Module({
  imports: [TerminusModule.forRoot({ logger: false }), QueuesModule],
  controllers: [HealthController],
  providers: [InfrastructureHealthIndicator],
})
export class HealthModule {}
