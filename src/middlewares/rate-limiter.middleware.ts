import {
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';
import { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.provider.js';
import {
  TokenBucketResult,
  tokenBucketFunction,
} from './algorithms/tokenbucket.js';

// What to do when Redis is unavailable:
// - open (default): allow the request without rate limiting
// - closed: reject it with 503
const FAILURE_MODES = ['open', 'closed'] as const;
type FailureMode = (typeof FAILURE_MODES)[number];
const FAILURE_MODE = (process.env.RATE_LIMIT_FAILURE_MODE ??
  'open') as FailureMode;
if (!FAILURE_MODES.includes(FAILURE_MODE)) {
  throw new Error(
    `RATE_LIMIT_FAILURE_MODE must be one of ${FAILURE_MODES.join(', ')}, got "${FAILURE_MODE}"`,
  );
}

const UNAVAILABLE_RETRY_AFTER_SECONDS = 1; // ~ioredis reconnect backoff cap
const WARN_INTERVAL_MS = 10_000; // at most one warning per 10s per instance

@Injectable()
export class RateLimiter implements NestMiddleware {
  private readonly logger = new Logger(RateLimiter.name);
  private lastWarnAt = 0;
  private failuresSinceWarn = 0;

  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
  ) {}
  async use(req: Request, res: any, next: (error?: any) => void) {
    const ip = req.ip as string;
    if (!ip) throw new BadRequestException('Unable to determine client IP');

    let result: TokenBucketResult;
    try {
      result = await tokenBucketFunction(ip, this.redis);
    } catch (err) {
      this.warnUnavailable(err);
      if (FAILURE_MODE === 'closed') {
        res.setHeader('Retry-After', UNAVAILABLE_RETRY_AFTER_SECONDS);
        throw new ServiceUnavailableException(
          'Rate limiter unavailable, please try again later.',
        );
      }
      res.setHeader('RateLimit-Policy-Status', 'degraded');
      return next();
    }

    res.setHeader('RateLimit-Limit', result.limit);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', result.resetSeconds);

    // Headers set on res survive Nest's exception filter, which only sets
    // the status and body.
    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      throw new HttpException(
        'Too many requests, please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    next();
  }

  private warnUnavailable(err: unknown) {
    this.failuresSinceWarn++;
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;

    const reason = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `Redis unavailable, failing ${FAILURE_MODE} (${this.failuresSinceWarn} requests affected since last warning): ${reason}`,
    );
    this.lastWarnAt = now;
    this.failuresSinceWarn = 0;
  }
}
