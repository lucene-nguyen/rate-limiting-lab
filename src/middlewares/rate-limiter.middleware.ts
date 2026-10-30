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

    const isAllow = await tokenBucketFunction(ip, this.redis);
    if (!isAllow)
      throw new HttpException(
        'Too many requests, please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    next();
  }
}
