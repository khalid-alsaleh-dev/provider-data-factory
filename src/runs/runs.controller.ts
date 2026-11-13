import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiKeyGuard } from '../common/api-key.guard';
import { RunDocument } from '../persistence/documents';
import { QuarantinePage } from '../persistence/quarantine.repository';
import { CreateRunDto } from './dto/create-run.dto';
import { ListErrorsQueryDto } from './dto/list-errors-query.dto';
import { CheckpointResponse, RunErrorsPageResponse, RunResponse } from './dto/run.response';
import { RunsService } from './runs.service';

@ApiTags('runs')
@ApiSecurity('api-key')
@ApiExtraModels(CheckpointResponse)
@ApiUnauthorizedResponse({
  description: 'API_KEY is configured and x-api-key is missing or wrong.',
})
@UseGuards(ApiKeyGuard)
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start a run. Processing continues in the background.' })
  @ApiAcceptedResponse({ type: RunResponse })
  @ApiBadRequestResponse({ description: 'Invalid request body.' })
  @ApiTooManyRequestsResponse({ description: 'Too many runs started in the last minute.' })
  create(@Body() body: CreateRunDto): Promise<RunDocument> {
    return this.runs.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status, timing, counters and an error sample of a run.' })
  @ApiOkResponse({ type: RunResponse })
  @ApiNotFoundResponse({ description: 'Unknown run.' })
  findOne(@Param('id') id: string): Promise<RunDocument> {
    return this.runs.findOne(id);
  }

  @Get(':id/errors')
  @ApiOperation({ summary: 'Quarantined issues of a run, paginated by cursor.' })
  @ApiOkResponse({ type: RunErrorsPageResponse })
  @ApiBadRequestResponse({ description: 'Invalid query parameters.' })
  @ApiNotFoundResponse({ description: 'Unknown run.' })
  listErrors(@Param('id') id: string, @Query() query: ListErrorsQueryDto): Promise<QuarantinePage> {
    return this.runs.listErrors(id, query);
  }
}
