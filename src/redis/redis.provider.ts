import { Provider } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS = 'redis';

export const RedisProvider: Provider = {
  provide: REDIS,
  useFactory: () => {
    return new Redis('redis://localhost:6379');
  },
};
