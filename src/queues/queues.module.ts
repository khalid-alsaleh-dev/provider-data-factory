import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BATCHES_QUEUE, DEAD_LETTER_QUEUE, DISPATCH_QUEUE } from './queue-names';

/** Registers the BullMQ queues once and shares them with every module that enqueues jobs. */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: DISPATCH_QUEUE },
      { name: BATCHES_QUEUE },
      // Dead letters are kept until someone replays or deletes them.
      {
        name: DEAD_LETTER_QUEUE,
        defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
