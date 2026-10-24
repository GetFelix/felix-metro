#!/usr/bin/env bash
# Start the development stack from scratch and wait until it serves. The
# control plane keeps its state in memory, so the broker's log is reset with
# it: a log that outlived its control plane would no longer match it.
set -euo pipefail
cd "$(dirname "$0")"
source ./compose.sh

"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf state
mkdir -p state
if ! "${compose[@]}" up --detach --build; then
  "${compose[@]}" logs >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if [[ -f state/seeded && -f state/finalized ]] \
    && curl -fsS http://127.0.0.1:8080/ready >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8787/oidc >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8088/ >/dev/null 2>&1; then
    echo "Felix Metro is up, with cities harbor and pinecrest."
    echo "  web app:  http://127.0.0.1:8088"
    echo "  gateway:  ws://127.0.0.1:8787/ws"
    echo "  speed:    dev/speed.sh harbor 16"
    echo "  sim log:  ${compose[*]} logs -f sim"
    exit 0
  fi
  sleep 2
done

echo "the stack did not come up" >&2
"${compose[@]}" ps --all >&2
"${compose[@]}" logs >&2
exit 1
