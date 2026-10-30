import { Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { defineTokenBucketCommand } from '../middlewares/algorithms/tokenbucket.js';

export const REDIS = 'redis';

export const RedisProvider: Provider = {
  provide: REDIS,
  useFactory: () => {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    defineTokenBucketCommand(redis);
    return redis;
  },
};
