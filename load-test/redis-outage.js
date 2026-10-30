// Redis outage — what does the limiter do when Redis disappears?
// A client sends a constant 20 req/s for 60s while redis-outage.sh stops
// Redis at ~20s and starts it again at ~40s. This script only measures;
// it has no thresholds. Per-request timings go to --out json and are
// summarised by analyze-outage.py.
// Run: load-test/redis-outage.sh <label>
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// Duration of every request, tagged with what the limiter did, so the
// analysis can tell a fail-open 200 from a rate-limited 200.
const outageReq = new Trend('outage_req', true);

export const options = {
  scenarios: {
    outage: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '60s',
      // Pre-allocate enough VUs for 30s of hung requests: k6 adds VUs slowly
      // mid-test, and would otherwise drop iterations instead of sending them.
      preAllocatedVUs: 600,
      maxVUs: 1500,
      // Let in-flight requests finish so we see how long they really hang.
      gracefulStop: '60s',
    },
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/`, { timeout: '60s' });
  outageReq.add(res.timings.duration, {
    status: String(res.status),
    degraded: String(res.headers['Ratelimit-Policy-Status'] === 'degraded'),
  });
}
