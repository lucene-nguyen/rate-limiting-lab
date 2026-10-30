#!/usr/bin/env bash
# Runs redis-outage.js while stopping Redis at ~20s and starting it at ~40s,
# then prints a summary. Results go to load-test/results/<label>.*
# Usage: load-test/redis-outage.sh <label>
set -euo pipefail
export MSYS_NO_PATHCONV=1 # keep /scripts/... intact in Git Bash

label=${1:-run}
cd "$(dirname "$0")/.."
results=load-test/results
mkdir -p "$results"
container=k6-outage-$label
docker rm -f "$container" >/dev/null 2>&1 || true

# --no-deps: never recreate the running stack (e.g. with another failure mode).
docker compose run --no-deps --name "$container" k6 run --quiet \
  --out json=/tmp/out.json /scripts/redis-outage.js >"$results/$label.k6.txt" 2>&1 &
k6_pid=$!

redis_id=$(docker compose ps -q redis)

sleep 20
docker compose stop redis >/dev/null
stopped_at=$(docker inspect -f '{{.State.FinishedAt}}' "$redis_id")
echo "redis stopped at $stopped_at"

sleep 20
docker compose start redis >/dev/null
started_at=$(docker inspect -f '{{.State.StartedAt}}' "$redis_id")
echo "redis started at $started_at"

wait "$k6_pid" || true
docker cp "$container:/tmp/out.json" "$results/$label.json" >/dev/null
docker rm "$container" >/dev/null

printf 'stopped %s\nstarted %s\n' "$stopped_at" "$started_at" >"$results/$label.events"
python load-test/analyze-outage.py "$results/$label.json" "$results/$label.events"
