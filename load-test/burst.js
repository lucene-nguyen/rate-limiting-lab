// Bug #1 — race condition.
// 50 requests from the same client fire at the same instant.
// Bucket capacity is 5, so a correct limiter lets through at most 5.
// Run: docker compose run --rm k6 run /scripts/burst.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CAPACITY = Number(__ENV.CAPACITY || 5);

const allowed = new Counter('allowed');
const rejected = new Counter('rejected');

export const options = {
  scenarios: {
    burst: { executor: 'per-vu-iterations', vus: 50, iterations: 1 },
  },
  thresholds: {
    // Fails the run (non-zero exit) when the limiter lets too much through.
    allowed: [`count<=${CAPACITY}`],
    // Any failed check (status, Retry-After, RateLimit-Remaining) fails the run.
    checks: ['rate==1'],
  },
};

export function setup() {
  // Wait for any previous bucket to expire so every run starts clean.
  sleep(11);
}

export default function () {
  const res = http.get(`${BASE_URL}/`);
  if (res.status === 200) allowed.add(1);
  else if (res.status === 429) rejected.add(1);

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    '429 has Retry-After': (r) =>
      r.status !== 429 || Number(r.headers['Retry-After']) >= 1,
    'RateLimit-Remaining is 0..5': (r) => {
      const remaining = r.headers['Ratelimit-Remaining'];
      return (
        remaining !== undefined &&
        Number(remaining) >= 0 &&
        Number(remaining) <= CAPACITY
      );
    },
    [`served by ${res.headers['X-Instance'] || 'unknown'}`]: () => true,
  });
}
