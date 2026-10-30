// Bug #2 — TTL is never refreshed, so the bucket resets to full every 10s.
// A client sends a steady 3 req/s for 30s. With capacity 5 and refill 1/s,
// a correct limiter allows at most 5 + 1 * 30 = 35 requests.
// Run: docker compose run --rm k6 run /scripts/steady.js
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CAPACITY = Number(__ENV.CAPACITY || 5);
const REFILL_PER_SEC = Number(__ENV.REFILL_PER_SEC || 1);
const DURATION_SEC = 30;
const MAX_ALLOWED = CAPACITY + REFILL_PER_SEC * DURATION_SEC;

const allowed = new Counter('allowed');
const rejected = new Counter('rejected');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: `${DURATION_SEC}s`,
      preAllocatedVUs: 5,
    },
  },
  thresholds: {
    // +1 margin for request timing at the edges of the window.
    allowed: [`count<=${MAX_ALLOWED + 1}`],
  },
};

export function setup() {
  sleep(11);
}

export default function () {
  const res = http.get(`${BASE_URL}/`);
  if (res.status === 200) allowed.add(1);
  else if (res.status === 429) rejected.add(1);
}
