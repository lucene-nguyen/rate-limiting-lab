import { Redis, Result } from 'ioredis';

// How many buckets do we need? -> it depends on the business requirements
const TOKEN_BUCKET_SIZE = 5;
const REFILL_RATE = 1; // refill token per 1s
const TTL = 10; // 10s

// Redis key
const rateLimitIpTemplate = 'rateLimitIP:';

// Refill + check + consume in one atomic step, so concurrent requests from
// any replica can't read the same token count.
// KEYS[1] = bucket key, ARGV = capacity, refill rate (tokens/s), ttl (s)
// Returns { allowed (1|0), remaining tokens (floored), ms until the bucket is
// full, ms until 1 token is available (0 if one already is) }.
// Lua truncates numbers to integers on return, hence integer ms.
const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

-- Redis clock, so every replica agrees on "now" regardless of host drift
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('EXPIRE', KEYS[1], ttl)

local resetMs = math.ceil((capacity - tokens) * 1000 / rate)
local retryAfterMs = 0
if tokens < 1 then
  retryAfterMs = math.ceil((1 - tokens) * 1000 / rate)
end

return { allowed, math.floor(tokens), resetMs, retryAfterMs }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: number,
      refillRate: number,
      ttl: number,
    ): Result<
      [
        allowed: 0 | 1,
        remainingTokens: number,
        resetMs: number,
        retryAfterMs: number,
      ],
      Context
    >;
  }
}

export function defineTokenBucketCommand(redis: Redis): void {
  redis.defineCommand('tokenBucket', {
    numberOfKeys: 1,
    lua: TOKEN_BUCKET_SCRIPT,
  });
}

export interface TokenBucketResult {
  allowed: boolean;
  limit: number; // bucket capacity
  remaining: number; // tokens left after this request, floored
  resetSeconds: number; // until the bucket is full again
  retryAfterSeconds: number; // until at least 1 token is available, min 1
}

export async function tokenBucketFunction(
  ip: string,
  redis: Redis,
): Promise<TokenBucketResult> {
  const [allowed, remaining, resetMs, retryAfterMs] = await redis.tokenBucket(
    rateLimitIpTemplate + ip,
    TOKEN_BUCKET_SIZE,
    REFILL_RATE,
    TTL,
  );
  return {
    allowed: allowed === 1,
    limit: TOKEN_BUCKET_SIZE,
    remaining,
    resetSeconds: Math.ceil(resetMs / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}
