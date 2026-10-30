import { Logger, Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { defineTokenBucketCommand } from '../middlewares/algorithms/tokenbucket.js';

export const REDIS = 'redis';

const logger = new Logger('Redis');

export const RedisProvider: Provider = {
  provide: REDIS,
  useFactory: () => {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      // The limiter sits on the request path, so a Redis call must fail fast
      // instead of waiting for Redis to come back.

      // Reject commands while disconnected instead of queueing them until
      // reconnect (the default), which made requests hang for the whole outage.
      enableOfflineQueue: false,
      // Reject in-flight commands as soon as the connection drops instead of
      // re-sending them after up to 20 reconnects. Also avoids re-running the
      // token bucket script, which isn't idempotent (it would consume twice).
      maxRetriesPerRequest: 0,
      // Covers a Redis that is connected but not answering (paused, overloaded,
      // packets dropped). Normal calls take ~2ms.
      commandTimeout: 200,
      // A connect attempt to an unreachable host otherwise waits 10s, which
      // delays reconnection after Redis returns.
      connectTimeout: 1000,
      // Keep reconnecting forever (never return null), backing off to at most
      // 1s so the limiter recovers within ~1s of Redis coming back.
      retryStrategy: (times) => Math.min(times * 100, 1000),
    });

    // Without a listener ioredis prints "Unhandled error event" on every
    // reconnect attempt. The limiter reports outages itself, throttled.
    redis.on('error', () => {});
    redis.on('ready', () => logger.log('connected'));

    defineTokenBucketCommand(redis);
    return redis;
  },
};
