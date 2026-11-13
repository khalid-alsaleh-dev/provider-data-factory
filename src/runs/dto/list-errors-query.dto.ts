import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class ListErrorsQueryDto {
  @ApiPropertyOptional({ description: 'Cursor: the `next` value of the previous page.' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/, { message: 'after must be a cursor returned by a previous page' })
  after?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}
