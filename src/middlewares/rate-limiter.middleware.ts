import {
  Inject,
  Injectable,
  NestMiddleware,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.provider.js';
import { tokenBucketFunction } from './algorithms/tokenbucket.js';

@Injectable()
export class RateLimiter implements NestMiddleware {
  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
  ) {}
  async use(req: Request, res: any, next: (error?: any) => void) {
    const ip = req.ip as string;
    if (!ip) throw new BadRequestException('Unable to determine client IP');

    const result = await tokenBucketFunction(ip, this.redis);
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
}
