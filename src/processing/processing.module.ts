import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { ProvidersModule } from '../providers/providers.module';
import { QueuesModule } from '../queues/queues.module';
import { BatchProcessor } from './batch.processor';
import { BatchService } from './batch.service';
import { DispatchProcessor } from './dispatch.processor';
import { DispatcherService } from './dispatcher.service';
import { DocumentWriter } from './document-writer.service';
import { RecoveryService } from './recovery.service';
import { RunFinalizer } from './run-finalizer.service';

/** Background workers: the dispatcher splits a run into batches, the batch processor transforms them. */
@Module({
  imports: [PersistenceModule, ProvidersModule, QueuesModule],
  providers: [
    BatchProcessor,
    BatchService,
    DispatchProcessor,
    DispatcherService,
    DocumentWriter,
    RecoveryService,
    RunFinalizer,
  ],
})
export class ProcessingModule {}
