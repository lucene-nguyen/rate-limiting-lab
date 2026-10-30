# Lessons Learned

Notes from practicing production-grade rate limiting in this lab.
Each lesson is backed by a measurement from the k6 tests, not by theory.
Phases match the Jira plan (LEARNING-111).

Setup for every experiment: k6 → Nginx → 3 NestJS replicas → 1 shared Redis.
Limiter: token bucket, capacity 5, refill 1 token/s.

---

## Phase 1 — Production-like environment & load testing

### 1. Single-instance tests hide distributed bugs

The original limiter looked fine when run as one process. With 3 replicas sharing one Redis, the same code let 22 of 50 simultaneous requests through a limit of 5 (see lesson 5).

**Takeaway:** test a distributed component in its distributed shape: several replicas, a shared store, a proxy in front.

### 2. Behind a proxy, `req.ip` is the proxy unless you say otherwise

Without `trust proxy`, every request appears to come from Nginx, so all clients share one bucket. With `TRUST_PROXY_HOPS=1`, the host and the k6 container showed up as different IPs (`172.30.0.1` vs `172.30.0.7`) and got separate buckets.

**Takeaway:** configure the exact number of trusted hops, never `trust proxy = true`. Trusting everything lets clients spoof `X-Forwarded-For` (Phase 8).

### 3. Make every response traceable to the instance that served it

An `X-Instance` header showed traffic spread 17/17/16 across replicas, and later that allowed requests came from all three (2/2/2), proving they share one bucket.

**Takeaway:** you can't verify distribution or sharing behavior if you can't see which instance answered.

### 4. A load test must assert, not just report

Each k6 script encodes the correct limit as a threshold (`allowed <= 5`), so a broken limiter makes the run exit non-zero instead of printing numbers someone has to read.

---

## Phase 2 — Atomicity & correctness

### 5. Read-modify-write across round trips is a race, even if each command is atomic

The first version did `SET NX` → `GET` → `SET` as separate calls. Each Redis command is atomic on its own, but the *sequence* is not.

| Test | Limit | Before | After (Lua) |
|---|---|---|---|
| `burst.js` — 50 requests at once | ≤ 5 | **22 allowed** | 5 allowed |

**Takeaway:** when a decision depends on state you just read, the read, decision and write must happen in one atomic unit. In Redis that means a Lua script (or `MULTI` with `WATCH`).

### 6. A TTL you never refresh silently changes your algorithm

The TTL was set once on creation and kept with `KEEPTTL`, so every bucket expired 10s after the client's *first* request and came back full, even under constant traffic.

| Test | Limit | Before | After |
|---|---|---|---|
| `steady.js` — 3 req/s for 30s | ≤ 36 | **38 allowed** | 34 allowed |

**Takeaway:** expiry is part of the algorithm, not just cleanup. Refresh it on every write, and make it at least `capacity / rate` so an active bucket never expires.

### 7. Measure before trusting an estimate — and keep tests sensitive

The TTL effect was much smaller than predicted (~45 expected, 38 measured), partly because the old code refilled in whole-second steps. A test that only exceeds its threshold by 2 is weak and can flake.

**Takeaway:** estimates are hypotheses. Design tests that detect a bug with a clear margin (longer duration, higher rate).

### 8. Use the shared store's clock, not each server's clock

The Lua script takes "now" from Redis `TIME`. With `Date.now()`, replicas whose clocks drift apart would compute different refill amounts for the same bucket.

**Takeaway:** in a distributed limiter, the component that owns the state should also own time.

### 9. Rare races still need a design answer

The crash on a `null` `GET` (key expiring between `SET NX` and `GET`) never happened in the baseline runs because the window is tiny. The Lua script removes it by treating a missing key as a full bucket.

**Takeaway:** "it didn't happen in testing" is not proof a race is impossible. Remove the window instead of hoping.

### 10. Reproduce, then fix, with the same test

Both bugs were reproduced with a failing k6 threshold *before* any code changed, and the same test proved the fix. This turns "I think it's fixed" into "the test went from fail to pass".

---

## Phase 3 — Client contract (headers, 429)

### 11. Derive every number from the same atomic computation

`RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After` are all computed inside the Lua script from the exact fractional token count and Redis `TIME`, then returned as integer milliseconds (Lua truncates numbers on return).

**Takeaway:** recomputing timing in Node would reintroduce the skew that Redis `TIME` removed. Headers must describe the same state the decision was made on.

### 12. A check that can't fail the run is decoration

k6 checks only appear in the summary. Without a threshold such as `checks: ['rate==1']`, a broken header never fails CI.

**Takeaway:** every assertion that matters must be wired to the exit code.

### 13. Status codes are part of the contract

A missing client IP returned 401 Unauthorized, which tells the client to authenticate. It is now 400. The 429 body was also corrected.

**Takeaway:** clients and monitoring act on status codes. A wrong code sends both in the wrong direction.

### 14. Verify framework behavior by running it

- Headers set on `res` before throwing survive NestJS's exception filter. Verified with curl, not assumed.
- k6 normalizes header case (`Ratelimit-Remaining`).
- Git Bash rewrites `/scripts/...` into a Windows path; `MSYS_NO_PATHCONV=1` fixes it.

---

## Phase 4 — Failure modes (Redis outage)

Experiment: 20 req/s for 60s, Redis stopped for ~24s in the middle.

| During outage | Baseline | Fail-open | Fail-closed |
|---|---|---|---|
| Result | 234 connections dropped, rest delayed | all 200 + `degraded` header | all 503 + `Retry-After` |
| p95 latency | **24,217 ms** | 2 ms | 2 ms |
| Max latency | **25,771 ms** | 3 ms | 7 ms |
| Recovery after Redis returns | 1.59 s | 0.63 s | 0.84 s |

### 15. A dependency that hangs is worse than one that fails

By default ioredis queues commands while disconnected. Requests didn't error; they waited up to 26s.

**Takeaway:** fail fast. `enableOfflineQueue: false`, short timeouts and a bounded `retryStrategy` turned a 26s hang into a 7ms decision.

### 16. The protective component can become the outage (cascading failure)

Hung requests held Nginx connections until it logged `512 worker_connections are not enough` and started dropping traffic for *every* route. The limiter, meant to protect the system, took down the proxy.

**Takeaway:** every dependency on the request path needs a timeout. A hang in one place spreads to everything that shares resources with it.

### 17. Automatic retries are dangerous for non-idempotent operations

The default `maxRetriesPerRequest` re-sends commands after reconnecting. Re-running the token bucket script would consume two tokens for one request.

**Takeaway:** before enabling retries, ask whether the operation is safe to run twice.

### 18. Recovery speed is a configuration choice

The baseline logged `connect ETIMEDOUT` waits of 10s (the default `connectTimeout`), which delayed reconnecting. With `connectTimeout: 1000` and `retryStrategy: min(times * 100, 1000)`, recovery dropped to 0.63–0.84 s.

**Takeaway:** reconnect settings decide how long an outage lasts *after* the dependency is back.

### 19. Default behavior changes with outage length

The baseline returned no 500s: queued commands succeeded once Redis returned. According to the ioredis source, a longer outage flushes the queue after ~20 reconnect attempts and then returns errors.

**Takeaway:** test more than one outage duration. A 24s outage and a 5-minute outage can fail in completely different ways.

### 20. Fail-open vs fail-closed is a business decision, so make it explicit

- **Open:** availability wins, but there is no limit at all. One client got 497 requests through in 24s, against ~25 normally.
- **Closed:** protection wins, but every user gets 503s.

**Takeaway:** neither is "correct". Make it configurable (`RATE_LIMIT_FAILURE_MODE`) and choose per endpoint risk (e.g. closed for login, open for read APIs).

### 21. Rate-limit state is disposable — know that you chose it

Restarting Redis (no persistence) emptied every bucket, so all clients started full after the outage. ioredis reloaded the Lua script on the restarted Redis automatically.

**Takeaway:** losing short-lived rate-limit state is usually acceptable. Quota state is not (Phase 12).

### 22. Don't flood logs during an incident

Logging every failed request would produce 20 req/s × 3 instances of identical lines, and ioredis printed `Unhandled error event` on every reconnect until an `error` listener was attached. The limiter now logs one warning per 10s per instance, with a count.

**Takeaway:** during an incident, logs must stay readable. Rate-limit your own logging.

### 23. Test harnesses have their own bugs

- `docker compose run k6` silently recreated the API containers with default env vars mid-test, invalidating a run. Fixed with `--no-deps`.
- k6 couldn't create VUs fast enough to replace hung ones, so requests were dropped client-side. Fixed by pre-allocating VUs.

**Takeaway:** when results look odd, verify the experiment before trusting the system under test.

---

## Open Issues (tracked in Phase 6, LEARNING-117)

- **Script bugs are treated as "Redis down".** In fail-open mode, a broken Lua script would silently disable rate limiting. Connection errors and script errors (`ReplyError`) need different handling.
- **`commandTimeout` is untested.** A stopped container refuses connections; a hung Redis keeps them open. Test with `docker compose pause redis`.
- **Fail-open has no limit at all.** Consider a per-instance in-memory fallback (≈ `limit / replicas`).
- **Startup:** requests before the first Redis connection take the failure path. Add a readiness check.
- **Degraded state is invisible to operators.** A response header isn't monitoring; this needs metrics and alerts (Phase 14).
- **The 400 path for a missing IP is untested** behind Nginx (Phase 5).
