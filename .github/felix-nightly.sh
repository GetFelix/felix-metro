#!/usr/bin/env bash
# The nightly run against Felix main: starts the test stack and the dev stack
# from the Felix images tagged $FELIX_IMAGE_TAG (default: nightly) and runs the
# checks that CI runs against them, except the ones that drive a browser. The
# felix-nightly workflow calls this after pointing Cargo.toml at the same Felix
# commit.
#
# It rewrites the image tags in the compose files, so run it from a throwaway
# checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

tag=${FELIX_IMAGE_TAG:-nightly}
images=(dev/compose.yml sim/ci/compose.yml)
TAG=$tag perl -pi -e 's{(ghcr\.io/getfelix/felix-(?:broker|controlplane)):[^\s"\x27]+}{$1:$ENV{TAG}}' "${images[@]}"
# A pattern that stopped matching would leave the pinned release running.
if ! grep -hq "ghcr\.io/getfelix/felix-broker:$tag" "${images[@]}" ||
  grep -h 'ghcr\.io/getfelix/felix-\(broker\|controlplane\)' "${images[@]}" | grep -qv ":${tag}[[:space:]]*\$"; then
  echo "the compose files do not all use the $tag images" >&2
  exit 1
fi

logs() {
  [ $? -eq 0 ] || for f in sim/ci/compose.yml dev/compose.yml; do
    docker compose -f "$f" logs --no-color || true
  done
}
trap logs EXIT

echo "::group::A city runs a day"
cargo test -p felix-metro-sim --test day --no-run
sim/ci/up.sh
METRO_TEST_CA_FILE="$PWD/sim/ci/state/broker-cert.pem" \
METRO_TEST_TOKEN_FILE="$PWD/sim/ci/state/sim.token" \
  cargo test -p felix-metro-sim --test day -- --ignored --nocapture
docker compose -f sim/ci/compose.yml down --volumes
echo "::endgroup::"

echo "::group::Dev stack"
dev/up.sh
docker compose -f dev/compose.yml logs --no-color sim | grep -E "warming up|warm-up done"
node dev/check-ticks.mjs harbor pinecrest
dev/speed.sh harbor 16
[[ "$(dev/speed.sh harbor)" == "16" ]]
dev/speed.sh harbor 4
node dev/check-commands.mjs pinecrest
node dev/builder-bot.mjs pinecrest --interval 1 --count 12 --demolish-after 1 --json bot-log.ndjson
node dev/check-builder-bot.mjs bot-log.ndjson --min 10
echo "::endgroup::"
