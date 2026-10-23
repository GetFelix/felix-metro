#!/usr/bin/env bash
# Start the test broker from scratch and wait until it is ready. The control
# plane keeps its state in memory, so the broker's log is reset with it.
set -euo pipefail
cd "$(dirname "$0")"

engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if docker info >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1; then
    engine=podman
  else
    echo "no container engine: start Docker, or install Podman" >&2
    exit 1
  fi
fi
compose=("$engine" compose -f compose.yml)

"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf state
mkdir -p state
if ! "${compose[@]}" up --detach; then
  "${compose[@]}" logs >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if [[ -f state/seeded ]] && curl -fsS http://127.0.0.1:8080/ready >/dev/null 2>&1; then
    echo "Felix is ready: broker 127.0.0.1:5000, CA state/broker-cert.pem, token state/sim.token"
    exit 0
  fi
  sleep 2
done

echo "the broker did not become ready" >&2
"${compose[@]}" ps --all >&2
"${compose[@]}" logs >&2
exit 1
