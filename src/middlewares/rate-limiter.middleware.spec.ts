import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { TokenBucketResult } from './algorithms/tokenbucket.js';

vi.mock('./algorithms/tokenbucket.js', () => ({
  tokenBucketFunction: vi.fn(),
}));

const redis = {} as Redis;

const allowedResult: TokenBucketResult = {
  allowed: true,
  limit: 5,
  remaining: 4,
  resetSeconds: 1,
  retryAfterSeconds: 1,
};
const rejectedResult: TokenBucketResult = {
  allowed: false,
  limit: 5,
  remaining: 0,
  resetSeconds: 5,
  retryAfterSeconds: 1,
};

// The failure mode is read when the module loads, so every test imports a
// fresh copy of the middleware with the env var it needs.
async function loadLimiter(mode: string | undefined) {
  vi.resetModules();
  vi.stubEnv('RATE_LIMIT_FAILURE_MODE', mode);
  const { RateLimiter } = await import('./rate-limiter.middleware.js');
  const { tokenBucketFunction } = await import('./algorithms/tokenbucket.js');
  return {
    limiter: new RateLimiter(redis),
    tokenBucket: vi.mocked(tokenBucketFunction),
  };
}

function fakeRes() {
  const headers = new Map<string, unknown>();
  return {
    headers,
    setHeader: vi.fn((name: string, value: unknown) =>
      headers.set(name, value),
    ),
  };
}

const req = (ip: string | undefined) => ({ ip }) as Request;

// Resolves to the HTTP status of the exception the middleware threw.
async function statusOf(promise: Promise<unknown>): Promise<number> {
  const err = await promise.then(
    () => {
      throw new Error('expected the middleware to throw');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  return (err as HttpException).getStatus();
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  // The mocked module survives vi.resetModules(), so reset its calls and
  // return values too; restoreAllMocks only undoes the spies.
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('RateLimiter', () => {
  describe('when Redis answers', () => {
    it('calls next() and sets RateLimit-* headers when allowed', async () => {
      const { limiter, tokenBucket } = await loadLimiter('open');
      tokenBucket.mockResolvedValue(allowedResult);
      const res = fakeRes();
      const next = vi.fn();

      await limiter.use(req('1.2.3.4'), res, next);

      expect(tokenBucket).toHaveBeenCalledWith('1.2.3.4', redis);
      expect(next).toHaveBeenCalledExactlyOnceWith();
      expect(Object.fromEntries(res.headers)).toEqual({
        'RateLimit-Limit': 5,
        'RateLimit-Remaining': 4,
        'RateLimit-Reset': 1,
      });
    });

    it('throws 429 with Retry-After and RateLimit-* headers when rejected', async () => {
      const { limiter, tokenBucket } = await loadLimiter('open');
      tokenBucket.mockResolvedValue(rejectedResult);
      const res = fakeRes();
      const next = vi.fn();

      expect(await statusOf(limiter.use(req('1.2.3.4'), res, next))).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(next).not.toHaveBeenCalled();
      expect(Object.fromEntries(res.headers)).toEqual({
        'RateLimit-Limit': 5,
        'RateLimit-Remaining': 0,
        'RateLimit-Reset': 5,
        'Retry-After': 1,
      });
    });

    it('throws 400 without calling the limiter when req.ip is missing', async () => {
      const { limiter, tokenBucket } = await loadLimiter('open');
      const next = vi.fn();

      expect(await statusOf(limiter.use(req(undefined), fakeRes(), next))).toBe(
        HttpStatus.BAD_REQUEST,
      );
      expect(tokenBucket).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('when Redis is unavailable', () => {
    const redisDown = new Error("Stream isn't writeable");

    it.each([
      ['open', 'open'],
      ['unset (defaults to open)', undefined],
    ])(
      'mode %s: allows the request with a degraded header',
      async (_, mode) => {
        const { limiter, tokenBucket } = await loadLimiter(mode);
        tokenBucket.mockRejectedValue(redisDown);
        const res = fakeRes();
        const next = vi.fn();

        await limiter.use(req('1.2.3.4'), res, next);

        expect(next).toHaveBeenCalledExactlyOnceWith();
        expect(Object.fromEntries(res.headers)).toEqual({
          'RateLimit-Policy-Status': 'degraded',
        });
      },
    );

    it('mode closed: throws 503 with Retry-After', async () => {
      const { limiter, tokenBucket } = await loadLimiter('closed');
      tokenBucket.mockRejectedValue(redisDown);
      const res = fakeRes();
      const next = vi.fn();

      expect(await statusOf(limiter.use(req('1.2.3.4'), res, next))).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect(next).not.toHaveBeenCalled();
      expect(Object.fromEntries(res.headers)).toEqual({ 'Retry-After': 1 });
    });

    it('logs at most one warning per 10s, with the number of affected requests', async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const { limiter, tokenBucket } = await loadLimiter('open');
      tokenBucket.mockRejectedValue(redisDown);
      const fail = () => limiter.use(req('1.2.3.4'), fakeRes(), vi.fn());

      for (let i = 0; i < 20; i++) await fail();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining('failing open (1 requests affected'),
      );

      vi.advanceTimersByTime(9_999);
      await fail();
      expect(warn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await fail();
      expect(warn).toHaveBeenCalledTimes(2);
      // 19 suppressed after the first warning, +1 delayed, +1 that warns.
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining('(21 requests affected'),
      );
    });
  });

  it('refuses to load with an unknown failure mode', async () => {
    await expect(loadLimiter('sometimes')).rejects.toThrow(
      'RATE_LIMIT_FAILURE_MODE must be one of open, closed, got "sometimes"',
    );
  });
});
