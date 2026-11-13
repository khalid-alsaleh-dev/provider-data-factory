import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Source, sources } from '../../core/contracts';

export class CreateRunDto {
  @ApiPropertyOptional({
    enum: sources,
    isArray: true,
    default: sources,
    description: 'Source collections to process. Defaults to all of them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(sources.length)
  @ArrayUnique()
  @IsIn(sources, { each: true })
  collections: Source[] = [...sources];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10_000_000,
    description: 'Maximum number of raw source documents to process per selected collection.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  limit?: number;
}
