![1791361557259](image/README/1791361557259.png)

# Redis Rate Limiter

A hands-on project for learning **Rate Limiting with Redis** using the **Token Bucket algorithm**.

## What I Implemented

- Token Bucket rate limiting
- Redis for storing bucket state
- Token refill based on elapsed time
- Per-IP rate limiting
- Redis key expiration with TTL
- Redis `SET NX` for bucket initialization
- Redis `KEEPTTL` for preserving key expiration when updating the bucket

## Token Bucket Configuration

```text
Bucket capacity: 5 tokens
Refill rate:     1 token / second
Key TTL:         10 seconds
```

Each IP has its own bucket:

```text
rateLimitIP:{ip}
```

The bucket state is stored as:

```text
tokens:lastRefillTime
```

Example:

```text
4:1791359589828
```

## How It Works

```text
Request
   │
   ▼
Get or initialize bucket
   │
   ▼
Calculate elapsed time
   │
   ▼
Refill tokens
   │
   ▼
Is a token available?
   │
 ┌─┴─────────┐
 │           │
Yes          No
 │           │
 ▼           ▼
Consume     Reject
1 token
 │
 ▼
Allow
```

## Redis Operations

### Initialize Bucket

```text
SET key value EX 10 NX
```

`NX` initializes the bucket only when the key does not already exist.

### Read Bucket

```text
GET key
```

The stored value contains the remaining tokens and the last refill timestamp.

### Update Bucket

```text
SET key value KEEPTTL
```

`KEEPTTL` keeps the existing expiration time when the bucket value is updated.

## Example

Initial bucket:

```text
5 tokens
```

After one request:

```text
4 tokens
```

After 2 seconds:

```text
4 + 2 = 5 tokens
```

The bucket is capped at its maximum capacity:

```text
min(currentTokens + tokensToRefill, 5)
```

Then one token is consumed for the current request.

## Tech Stack

- Node.js
- NestJS
- TypeScript
- Redis
- ioredis

## Purpose

This project is a practical exercise to understand how **Token Bucket rate limiting works with Redis**, including token refill, bucket expiration, and Redis key operations.

## Production-like Environment

```text
k6 ──► Nginx :8080 ──► api × 3 (NestJS) ──► Redis
```

Three API replicas sit behind Nginx and share one Redis, the same shape as a real deployment. `TRUST_PROXY_HOPS=1` makes `req.ip` the real client IP instead of Nginx's. Every response carries an `X-Instance` header naming the replica that served it.

```bash
docker compose up -d --build
curl -i http://localhost:8080/        # check X-Instance and the 200/429
```

## Load Tests

| Script | What it checks | Correct limiter |
| --- | --- | --- |
| `load-test/burst.js` | 50 simultaneous requests (race condition) | ≤ 5 allowed |
| `load-test/steady.js` | 3 req/s for 30s (TTL reset) | ≤ 35 allowed |

```bash
docker compose run --rm k6 run /scripts/burst.js
docker compose run --rm k6 run /scripts/steady.js
```

A script exits non-zero (threshold failed) when the limiter lets more requests through than it should. Each script waits 11s first so the previous bucket has expired.
