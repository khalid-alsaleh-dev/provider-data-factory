import { plainToInstance } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

const DATABASE_NAME = /^[\w-]+$/;

/** Validated process environment. Defaults apply when a variable is not set. */
export class EnvironmentVariables {
  @Matches(/^mongodb(?:\+srv)?:\/\/\S+$/, { message: 'MONGO_URI must be a MongoDB URI' })
  MONGO_URI: string = 'mongodb://localhost:27017';

  @Matches(DATABASE_NAME)
  RAW_DB: string = 'provider_raw';

  @Matches(DATABASE_NAME)
  TARGET_DB: string = 'provider_domain';

  @Matches(/^rediss?:\/\/\S+$/, { message: 'REDIS_URL must be a redis:// or rediss:// URL' })
  REDIS_URL: string = 'redis://localhost:6379';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsInt()
  @Min(1)
  @Max(100)
  BATCH_SIZE: number = 5;

  @IsInt()
  @Min(1)
  @Max(32)
  WORKER_CONCURRENCY: number = 2;

  @IsInt()
  @Min(1)
  @Max(20)
  JOB_ATTEMPTS: number = 3;

  @IsInt()
  @Min(1)
  @Max(60000)
  BACKOFF_MS: number = 1000;

  /** When set, every /runs request must send it in the `x-api-key` header. */
  @IsOptional()
  @IsString()
  @MinLength(16)
  API_KEY?: string;
}

export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  // Unset and empty variables fall back to the class defaults.
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ''),
  );
  const config = plainToInstance(EnvironmentVariables, present, {
    enableImplicitConversion: true,
    excludeExtraneousValues: false,
  });
  const messages = validateSync(config, { skipMissingProperties: false }).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
  if (config.RAW_DB === config.TARGET_DB) {
    messages.push('RAW_DB and TARGET_DB must be different databases');
  }
  if (messages.length > 0) {
    throw new Error(`Invalid environment: ${messages.join('; ')}`);
  }
  return config;
}
