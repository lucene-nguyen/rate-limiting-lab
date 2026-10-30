import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  defineTokenBucketCommand,
  tokenBucketFunction,
} from './tokenbucket.js';

// Runs the token bucket Lua script against a real Redis (same image as
// docker-compose.yml). Needs Docker. Run: npm run test:integration

let container: StartedRedisContainer;
let redis: Redis;

function connect(): Redis {
  const client = new Redis(container.getConnectionUrl());
  defineTokenBucketCommand(client);
  return client;
}

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = connect();
});

afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

// Raw script call: [allowed, remaining, resetMs, retryAfterMs]
const take = (key: string, capacity: number, rate: number, ttl = 10) =>
  redis.tokenBucket(key, capacity, rate, ttl);

async function drain(key: string, capacity: number, rate: number) {
  for (let i = 0; i < capacity; i++) {
    expect((await take(key, capacity, rate))[0]).toBe(1);
  }
}

describe('token bucket Lua script', () => {
  it('treats a missing key as a full bucket', async () => {
    expect(await take('fresh', 7, 1)).toEqual([1, 6, 1000, 0]);
    expect(await redis.hgetall('fresh')).toMatchObject({ tokens: '6' });
  });

  it('starts full again after the key disappears (expired mid-life)', async () => {
    await drain('gone', 5, 1);
    expect((await take('gone', 5, 1))[0]).toBe(0);

    await redis.del('gone');

    expect(await take('gone', 5, 1)).toEqual([1, 4, 1000, 0]);
  });

  it('allows exactly capacity requests, then rejects', async () => {
    const replies = [];
    for (let i = 0; i < 7; i++) replies.push(await take('cap', 5, 1));

    expect(replies.map(([allowed]) => allowed)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(replies.map(([, remaining]) => remaining)).toEqual([
      4, 3, 2, 1, 0, 0, 0,
    ]);
  });

  it('refills continuously over time', async () => {
    await drain('refill', 5, 100);
    expect((await take('refill', 5, 100))[0]).toBe(0);

    await sleep(30); // >= 3 tokens at 100 tokens/s

    for (let i = 0; i < 3; i++) {
      expect((await take('refill', 5, 100))[0]).toBe(1);
    }
  });

  it('never refills above capacity', async () => {
    await drain('capped', 5, 100);

    await sleep(200); // 20 tokens' worth at 100 tokens/s

    expect((await take('capped', 5, 100))[1]).toBe(4);
  });

  it('refreshes the TTL on every call, allowed or rejected', async () => {
    await take('ttl', 1, 1, 10);
    await redis.expire('ttl', 3);
    await take('ttl', 1, 1, 10); // rejected: the bucket is empty

    expect(await redis.ttl('ttl')).toBe(10);
  });

  describe('header values', () => {
    it('reports remaining, reset and retry-after as the bucket drains', async () => {
      // 1 token/s, so values move by at most a few ms during the test.
      expect(await take('hdr', 5, 1)).toEqual([1, 4, 1000, 0]);
      for (let i = 0; i < 4; i++) await take('hdr', 5, 1);

      const [allowed, remaining, resetMs, retryAfterMs] = await take(
        'hdr',
        5,
        1,
      );
      expect(allowed).toBe(0);
      expect(remaining).toBe(0);
      expect(resetMs).toBeGreaterThan(4900);
      expect(resetMs).toBeLessThanOrEqual(5000);
      expect(retryAfterMs).toBeGreaterThan(900);
      expect(retryAfterMs).toBeLessThanOrEqual(1000);
    });

    it('computes retry-after from the fractional token count', async () => {
      await take('frac', 1, 10); // 0 tokens left, 10 tokens/s
      await sleep(50); // ~0.5 token: still not enough

      const [allowed, , , retryAfterMs] = await take('frac', 1, 10);

      // From exactly 0 tokens it would be 100ms; the partial token counts.
      expect(allowed).toBe(0);
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(50);
    });

    it('converts to whole seconds for the HTTP headers', async () => {
      for (let i = 0; i < 5; i++) await tokenBucketFunction('9.9.9.9', redis);

      expect(await tokenBucketFunction('9.9.9.9', redis)).toEqual({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetSeconds: 5,
        retryAfterSeconds: 1,
      });
      expect(await redis.exists('rateLimitIP:9.9.9.9')).toBe(1);
    });
  });

  it('allows exactly capacity requests out of 50 concurrent ones from 10 connections', async () => {
    // 10 connections stand in for several API replicas sharing one Redis.
    const clients = Array.from({ length: 10 }, connect);
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          tokenBucketFunction('7.7.7.7', clients[i % clients.length]),
        ),
      );

      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});
