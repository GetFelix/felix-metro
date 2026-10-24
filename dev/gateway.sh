#!/usr/bin/env bash
# Stop, start or recreate the gateway container alone: dev/gateway.sh stop|start|recreate. A page open on the stack
# loses its session while it is away and picks up again once it is back. Recreate brings it back at a new address,
# which the web container has to find again, and fails if the address did not change.
set -euo pipefail
cd "$(dirname "$0")"
source ./compose.sh

case "${1:-}" in
  stop | start) "${compose[@]}" "$1" gateway ;;
  recreate)
    # The network and address of the gateway container.
    where() {
      "$engine" inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.IPAddress}}{{end}}' \
        "$("${compose[@]}" ps -q gateway)"
    }
    read -r network before < <(where)
    "${compose[@]}" stop gateway
    "${compose[@]}" rm --force gateway
    # Holds the freed address, so the new container cannot be given it again.
    holder="$("$engine" run --detach --rm --network "$network" docker.io/library/node:24-alpine sleep 300)"
    trap '"$engine" rm --force "$holder" >/dev/null 2>&1 || true' EXIT
    "${compose[@]}" up --detach --no-deps gateway
    read -r _ after < <(where)
    if [[ "$after" == "$before" ]]; then
      echo "the gateway came back at the same address, $before" >&2
      exit 1
    fi
    echo "the gateway moved from $before to $after"
    ;;
  *)
    echo "usage: dev/gateway.sh stop|start|recreate" >&2
    exit 1
    ;;
esac
