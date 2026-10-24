#!/usr/bin/env bash
# Start a city the sim holds back: dev/city.sh <name> (the stack starts with lakeside held back). The city
# is listed in the registry as it starts, so a page that is already open shows it in its city list.
# The speed endpoint answers loopback only, so this runs curl inside the sim's container.
set -euo pipefail
cd "$(dirname "$0")"
source ./compose.sh

city="${1:?usage: dev/city.sh <city>}"
"${compose[@]}" exec -T sim curl -fsS -X POST "http://127.0.0.1:8090/cities/$city/start"
