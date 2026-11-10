import type { RedisOptions } from 'ioredis';

/** Turns REDIS_URL into ioredis options so BullMQ owns (and closes) its own connections. */
export function redisConnection(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: db ? Number(db) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ workers, which use blocking commands.
    maxRetriesPerRequest: null,
  };
}
