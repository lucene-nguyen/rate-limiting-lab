import type { Redis } from 'ioredis';
import { tokenBucketFunction } from './tokenbucket.js';

// The Lua script itself is covered by tokenbucket.int-spec.ts against a real
// Redis. This only checks how its reply is turned into a result object.
function redisReplying(reply: [number, number, number, number]) {
  return { tokenBucket: vi.fn().mockResolvedValue(reply) } as unknown as Redis;
}

describe('tokenBucketFunction', () => {
  it('uses the rateLimitIP:{ip} key and the configured limits', async () => {
    const redis = redisReplying([1, 4, 1000, 0]);

    await tokenBucketFunction('1.2.3.4', redis);

    expect(redis.tokenBucket).toHaveBeenCalledWith(
      'rateLimitIP:1.2.3.4',
      5,
      1,
      10,
    );
  });

  it('converts an allowed reply, with Retry-After never below 1s', async () => {
    const result = await tokenBucketFunction(
      'ip',
      redisReplying([1, 4, 1000, 0]),
    );

    expect(result).toEqual({
      allowed: true,
      limit: 5,
      remaining: 4,
      resetSeconds: 1,
      retryAfterSeconds: 1,
    });
  });

  it('rounds milliseconds up to whole seconds on a rejected reply', async () => {
    const result = await tokenBucketFunction(
      'ip',
      redisReplying([0, 0, 4001, 1]),
    );

    expect(result).toEqual({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetSeconds: 5,
      retryAfterSeconds: 1,
    });
  });
});
