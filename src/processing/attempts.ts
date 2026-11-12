import { Job } from 'bullmq';

/** True while a job runs its last allowed attempt. `attemptsMade` counts earlier failed attempts. */
export function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
