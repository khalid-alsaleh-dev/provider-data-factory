import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { BatchesRepository } from './batches.repository';
import { EntitiesRepository } from './entities.repository';
import { QuarantineRepository } from './quarantine.repository';
import { ReceiptsRepository } from './receipts.repository';
import { RunsRepository } from './runs.repository';
import { SourceRepository } from './source.repository';

const repositories = [
  BatchesRepository,
  EntitiesRepository,
  QuarantineRepository,
  ReceiptsRepository,
  RunsRepository,
  SourceRepository,
];

@Module({
  imports: [ProvidersModule],
  providers: repositories,
  exports: repositories,
})
export class PersistenceModule {}
