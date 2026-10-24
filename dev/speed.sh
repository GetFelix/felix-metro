#!/usr/bin/env bash
# Show or set a city's speed: dev/speed.sh <city> [0|4|8|16]. The sim's speed
# endpoint answers loopback only, so this runs curl inside the sim's container.
set -euo pipefail
cd "$(dirname "$0")"
source ./compose.sh

city="${1:?usage: dev/speed.sh <city> [0|4|8|16]}"
url="http://127.0.0.1:8090/cities/$city/speed"
if [[ $# -ge 2 ]]; then
  "${compose[@]}" exec -T sim curl -fsS -X PUT -d "$2" "$url"
else
  "${compose[@]}" exec -T sim curl -fsS "$url"
fi
echo
