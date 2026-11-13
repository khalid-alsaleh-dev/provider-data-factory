import { ConfigService } from '@nestjs/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { EnvironmentVariables } from '../config/environment';

export const API_KEY_HEADER = 'x-api-key';

/** Requires the `x-api-key` header when API_KEY is configured; open otherwise (local development). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected?: Buffer;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const key = config.get('API_KEY', { infer: true });
    this.expected = key ? Buffer.from(key) : undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return true;
    const header = context.switchToHttp().getRequest<Request>().header(API_KEY_HEADER);
    const provided = Buffer.from(header ?? '');
    if (provided.length !== this.expected.length || !timingSafeEqual(provided, this.expected)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
