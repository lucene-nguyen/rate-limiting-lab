import { Redis } from 'ioredis';

// How many buckets do we need? -> it depends on the business requirements
const TOKEN_BUCKET_SIZE = 5;
const REFILL_RATE = 1; // refill token per 1s
const TTL = 10; // 10s

// Redis key
const rateLimitIpTemplate = 'rateLimitIP::::::::';

// todo: combine refill + check + consume into one Redis atomic operation.
export async function tokenBucketFunction(
  ip: string,
  redis: Redis,
): Promise<boolean> {
  console.log(`user ip: ${ip}`);

  const key = rateLimitIpTemplate + ip;
  let isAllow = true;

  // get available tokens or set it if this key doesn't exist
  await redis.set(
    key,
    buildValue(TOKEN_BUCKET_SIZE, Date.now()),
    'EX',
    TTL,
    'NX',
  );
  const bucketData = (await redis.get(key)) as string;
  console.log('bucketData: ', bucketData);
  const [remainTokens, lastRefill] = bucketData.split(':').map(Number);

  // call refiller when new request come into the app
  const { availableTokens, refillTime } = await refiller(
    remainTokens,
    lastRefill,
    key,
    redis,
  );
  console.log('availableTokens: ', availableTokens);

  if (availableTokens > 0) {
    // get 1 token
    const newValue = `${availableTokens - 1}:${refillTime}`;
    await redis.set(key, newValue, 'KEEPTTL');
    isAllow = true;
  } else {
    isAllow = false;
  }

  return isAllow;
}

async function refiller(
  remainTokens: number,
  lastRefill: number,
  key: string,
  redis: Redis,
): Promise<{ availableTokens: number; refillTime: number }> {
  console.log('lastRefill: ', lastRefill);
  const elapsedTime = Math.floor((Date.now() - lastRefill) / 1000); //second
  console.log('elapsedTime: ', elapsedTime);
  const tokensNeedFill = Math.floor(elapsedTime / REFILL_RATE);
  console.log('tokensNeedFill: ', tokensNeedFill);
  let availableTokens = remainTokens;
  let refillTime = lastRefill;
  if (tokensNeedFill > 0) {
    availableTokens =
      remainTokens + tokensNeedFill <= TOKEN_BUCKET_SIZE
        ? remainTokens + tokensNeedFill
        : TOKEN_BUCKET_SIZE;
    refillTime = lastRefill + tokensNeedFill * 1000;
    const newValue = buildValue(availableTokens, refillTime);
    await redis.set(key, newValue, 'KEEPTTL');
  }

  return { availableTokens, refillTime };
}

function buildValue(tokens: number, time: number): string {
  return `${tokens}:${time}`;
}
