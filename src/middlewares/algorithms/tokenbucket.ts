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
// Returns { allowed (1|0), remaining tokens (floored) }.
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

return { allowed, math.floor(tokens) }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: number,
      refillRate: number,
      ttl: number,
    ): Result<[allowed: 0 | 1, remainingTokens: number], Context>;
  }
}

export function defineTokenBucketCommand(redis: Redis): void {
  redis.defineCommand('tokenBucket', {
    numberOfKeys: 1,
    lua: TOKEN_BUCKET_SCRIPT,
  });
}

export async function tokenBucketFunction(
  ip: string,
  redis: Redis,
): Promise<boolean> {
  const [allowed] = await redis.tokenBucket(
    rateLimitIpTemplate + ip,
    TOKEN_BUCKET_SIZE,
    REFILL_RATE,
    TTL,
  );
  return allowed === 1;
}
