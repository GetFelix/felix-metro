#!/usr/bin/env bash
# Stop or start the gateway container alone: dev/gateway.sh stop|start. A page open on the stack loses its
# session while it is stopped and picks up again once it is back.
set -euo pipefail
cd "$(dirname "$0")"
source ./compose.sh

case "${1:-}" in
  stop | start) "${compose[@]}" "$1" gateway ;;
  *)
    echo "usage: dev/gateway.sh stop|start" >&2
    exit 1
    ;;
esac
