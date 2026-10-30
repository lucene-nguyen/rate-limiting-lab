"""Summarise a redis-outage.js run.

Usage: python analyze-outage.py <k6 --out json file> <events file>

Requests are bucketed by the time they were sent relative to the Redis
stop/start times. Both clocks come from the Docker VM (k6 container and
docker inspect), so they are comparable.
"""

import json
import sys
from collections import Counter
from datetime import datetime, timezone

OK = {"200", "429"}


def parse_time(s: str) -> float:
    # RFC3339 with up to ns precision; Python only takes µs.
    s = s.replace("Z", "+00:00")
    head, _, tz = s.partition("+")
    if "." in head:
        base, frac = head.split(".")
        head = f"{base}.{frac[:6].ljust(6, '0')}"
    return datetime.fromisoformat(f"{head}+{tz or '00:00'}").timestamp()


def pct(values, p):
    if not values:
        return float("nan")
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def main(json_path, events_path):
    events = dict(line.split(maxsplit=1) for line in open(events_path) if line.strip())
    stopped, started = parse_time(events["stopped"].strip()), parse_time(events["started"].strip())

    reqs, dropped = [], 0
    for line in open(json_path):
        row = json.loads(line)
        if row.get("type") != "Point":
            continue
        if row["metric"] == "dropped_iterations":
            dropped += row["data"]["value"]
        if row["metric"] != "outage_req":
            continue
        end = parse_time(row["data"]["time"])
        dur = row["data"]["value"] / 1000
        tags = row["data"]["tags"]
        # "200d" = allowed without rate limiting (fail-open, Redis unavailable)
        status = tags["status"] + ("d" if tags.get("degraded") == "true" else "")
        reqs.append({"start": end - dur, "end": end, "dur": dur, "status": status})

    phases = {
        "before": [r for r in reqs if r["start"] < stopped],
        "outage": [r for r in reqs if stopped <= r["start"] < started],
        "after": [r for r in reqs if r["start"] >= started],
    }
    print(f"outage window: {started - stopped:.1f}s, requests: {len(reqs)}, dropped iterations: {int(dropped)}")
    print(f"{'phase':<8} {'n':>5}  {'statuses':<34} {'p50':>8} {'p95':>8} {'max':>8}")
    for name, rs in phases.items():
        durs = [r["dur"] * 1000 for r in rs]
        statuses = ", ".join(f"{k}:{v}" for k, v in sorted(Counter(r["status"] for r in rs).items()))
        print(f"{name:<8} {len(rs):>5}  {statuses:<34} {pct(durs, 50):>6.0f}ms {pct(durs, 95):>6.0f}ms {max(durs, default=0):>6.0f}ms")

    # Recovery, measured from Redis start (OK = rate-limited 200/429):
    #  - first OK: first OK response completing after the restart
    #  - last error: last non-OK (error, 503, degraded 200) completing after it
    #  - normal latency: first moment after which every request is OK and < 100ms
    after_start = sorted((r for r in reqs if r["end"] >= started), key=lambda r: r["end"])
    first_ok = next((r["end"] - started for r in after_start if r["status"] in OK), None)
    errors = [r["end"] - started for r in after_start if r["status"] not in OK]
    bad = [r["end"] - started for r in after_start if r["status"] not in OK or r["dur"] > 0.1]
    fmt = lambda v: "n/a" if v is None else f"{v:.2f}s"
    print(f"recovery: first OK {fmt(first_ok)}, last error {fmt(max(errors) if errors else None)}, "
          f"normal after {fmt(max(bad) if bad else 0.0)}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
