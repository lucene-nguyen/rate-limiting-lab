# CLAUDE.md

Instructions for Claude Code working in this repository. Read this before every task.

## Purpose

`rate-limiting-lab` is a learning project: practicing rate limiting **as it behaves in production**.
The goal is understanding backed by evidence, not just working code. Every change must be proven
by a measurement.

- Plan: Jira task **LEARNING-111**, one subtask per phase (1–16). Phases 1–5 are done.
- Lessons: `docs/LESSONS.md`, numbered, grouped by phase.

## Architecture

```text
k6 ──► Nginx :8080 ──► api × 3 (NestJS) ──► Redis
```

| Path | What it is |
|---|---|
| `src/middlewares/rate-limiter.middleware.ts` | Applies the limiter to every route, sets `RateLimit-*` headers, failure policy |
| `src/middlewares/algorithms/tokenbucket.ts` | Token bucket as one atomic Lua script (`redis.tokenBucket`) |
| `src/redis/redis.provider.ts` | ioredis client with fail-fast options; registers the Lua command |
| `docker-compose.yml` | Nginx, 3 API replicas, Redis, k6 (profile `loadtest`) |
| `load-test/` | k6 scripts, outage orchestration, analyzer, `results/` |

Limiter config: capacity 5, refill 1 token/s, TTL 10s. Env: `REDIS_URL`, `TRUST_PROXY_HOPS`,
`RATE_LIMIT_FAILURE_MODE` (`open` default | `closed`).

## Commands

```bash
docker compose up -d --build                                   # start the stack
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps k6 run /scripts/burst.js
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps k6 run /scripts/steady.js
load-test/redis-outage.sh <label>                              # Redis outage experiment (needs Python)
npm run lint && npx tsc --noEmit                               # static checks
npm test                                                       # unit tests (Vitest, *.spec.ts)
npm run test:integration                                       # Lua script vs real Redis (Testcontainers, needs Docker)
npm run test:cov                                               # unit test coverage
docker compose down                                            # stop the stack
```

- The host is Windows. In Git Bash, always prefix k6 commands with `MSYS_NO_PATHCONV=1`,
  otherwise `/scripts/...` becomes a Windows path.
- Always use `--no-deps` with `docker compose run k6`. Without it, compose may recreate the API
  containers with default env vars in the middle of a test and silently invalidate the run.

## Workflow for every phase

Follow these steps in order. Do not skip step 2.

1. **Read** the phase scope given in the prompt and the related Open Issues in `docs/LESSONS.md`.
2. **Measure first (no code changes).** Reproduce the problem with a failing test or a measurement.
   Record the real numbers. If the problem cannot be reproduced, stop and report that.
3. **Fix** in small steps, one logical change per commit.
4. **Prove.** Re-run the same test from step 2. It must now pass.
5. **Regress.** Run every existing check: lint, type-check, unit tests, integration tests, `burst.js`, `steady.js`.
   CI (`.github/workflows/ci.yml`) runs all of them except `steady.js`.
6. **Record lessons.** Add new lessons to `docs/LESSONS.md` under the phase heading: what happened,
   the numbers, and one **Takeaway**. Include wrong predictions and test-harness bugs too.
   Move anything left unsolved to **Open Issues** with the phase that will handle it.
7. **Report back** using the format below.

## Definition of Done

A phase is done only when all of these hold:

- [ ] The problem was reproduced by a failing test or measurement **before** the fix
- [ ] The same test passes after the fix
- [ ] All existing checks still pass
- [ ] `docs/LESSONS.md` is updated with real numbers
- [ ] Everything is committed, one logical change per commit

## Rules

**Do**
- Keep every Redis read-decide-write sequence atomic (one Lua script).
- Use Redis `TIME` inside scripts, never `Date.now()`, for anything that affects a decision or a header.
- Give every dependency on the request path a timeout. Fail fast; never hang.
- Wire every important assertion to a k6 threshold so a failure changes the exit code.
- Explain each non-default library option you set (comment in code + report).
- Verify framework behavior by running it (curl, tests), not by assuming.

**Don't**
- Don't loosen or remove existing k6 thresholds. Adding stricter ones is fine.
- Don't change the limiter config (5 / 1 per s / 10s) unless the phase asks for it.
- Don't enable automatic retries for non-idempotent operations (e.g. the token bucket script).
- Don't log once per request on an error path; rate-limit warnings per instance.
- Don't use per-IP or per-user values as metric labels (cardinality).
- Don't edit Jira; report commit hashes and the reviewer updates it.
- Don't push or force-push unless asked.

## Commits

Conventional commits, small and focused:

```text
test: reproduce <problem>            # step 2, when it adds a test
feat: / fix: <change>                # step 3
docs: add phase N lessons            # step 6
chore: <cleanup>
```

## Report format

End every task with:

1. **Summary**: one or two sentences on the outcome.
2. **Commits**: hash + one line each.
3. **Before / after table** of the key measurements.
4. **Options and decisions**: anything non-default and why.
5. **Things I noticed**: surprises, risks, test-harness issues, anything not in the brief.
6. **State left behind**: is the stack running, which mode, anything uncommitted.
