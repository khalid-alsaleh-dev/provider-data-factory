import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { sources } from '../../core/contracts';
import { RunStatus } from '../../persistence/documents';

// Response shapes for the OpenAPI document. The service returns the stored documents, which match them.

export class CheckpointResponse {
  @ApiPropertyOptional({ description: 'Highest source id included in the run.' })
  upper?: string;

  @ApiPropertyOptional({ description: 'Last source id that was put in a batch.' })
  after?: string;

  @ApiProperty({ description: 'Source documents put in batches so far.' })
  count!: number;

  @ApiPropertyOptional()
  done?: boolean;
}

export class RunCountersResponse {
  @ApiProperty({ description: 'Source documents processed.' })
  read!: number;

  @ApiProperty({ description: 'Source documents that produced at least one entity.' })
  transformed!: number;

  @ApiProperty({ description: 'Entities inserted or replaced.' })
  written!: number;

  @ApiProperty({ description: 'Entities that were duplicates, unchanged or older than stored.' })
  skipped!: number;

  @ApiProperty({ description: 'Quarantined issues.' })
  failed!: number;
}

export class ErrorSampleResponse {
  @ApiProperty()
  sourceId!: string;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  reason!: string;
}

export class RunResponse {
  @ApiProperty({ format: 'uuid' })
  _id!: string;

  @ApiProperty({ enum: ['running', 'completed', 'completed_with_errors', 'failed'] })
  status!: RunStatus;

  @ApiProperty()
  startedAt!: Date;

  @ApiPropertyOptional()
  finishedAt?: Date;

  @ApiPropertyOptional()
  durationMs?: number;

  @ApiProperty({ description: 'All batches have been enqueued.' })
  dispatchDone!: boolean;

  @ApiPropertyOptional()
  dispatchFailed?: boolean;

  @ApiPropertyOptional()
  dispatchError?: string;

  @ApiPropertyOptional()
  limit?: number;

  @ApiProperty({
    type: 'object',
    description: `Progress per selected collection (${sources.join(', ')}).`,
    additionalProperties: { $ref: '#/components/schemas/CheckpointResponse' },
  })
  checkpoints!: Record<string, CheckpointResponse>;

  @ApiProperty()
  counters!: RunCountersResponse;

  @ApiProperty({ type: [ErrorSampleResponse] })
  errorSample!: ErrorSampleResponse[];
}

export class QuarantinedIssueResponse {
  @ApiProperty()
  _id!: string;

  @ApiProperty()
  runId!: string;

  @ApiProperty()
  batchId!: string;

  @ApiProperty({ enum: sources })
  source!: string;

  @ApiProperty()
  sourceId!: string;

  @ApiProperty({ description: 'Location of the problem inside the source document.' })
  path!: string;

  @ApiProperty()
  reason!: string;
}

export class RunErrorsPageResponse {
  @ApiProperty({ type: [QuarantinedIssueResponse] })
  data!: QuarantinedIssueResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page.' })
  next!: string | null;
}
