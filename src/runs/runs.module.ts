import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueuesModule } from '../queues/queues.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [PersistenceModule, QueuesModule],
  controllers: [RunsController],
  providers: [RunsService, ApiKeyGuard],
})
export class RunsModule {}
