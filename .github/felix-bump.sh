#!/usr/bin/env bash
# The pin patterns are literal text, not shell expansions.
# shellcheck disable=SC2016
# Moves this repo's Felix pins from one version to another:
#   .github/felix-bump.sh <old> <new>
# The felix-release workflow runs it, then updates .felix-version and the
# lockfiles. Every pin listed here must be found, so a moved or renamed pin
# fails the bump instead of being skipped.
set -euo pipefail
OLD=${1:?usage: felix-bump.sh <old> <new>}
NEW=${2:?usage: felix-bump.sh <old> <new>}
cd "$(dirname "$0")/.."

die() { echo "felix-bump: $*" >&2; exit 1; }

# pin FILE PATTERN: replace PATTERN with {V}=OLD by PATTERN with {V}=NEW.
pin() {
  local file=$1 pattern=$2
  [ -f "$file" ] || die "$file does not exist"
  FROM=${pattern//'{V}'/$OLD} TO=${pattern//'{V}'/$NEW} \
    perl -0777 -pi -e '$n += s/\Q$ENV{FROM}\E/$ENV{TO}/g; END { exit($n ? 0 : 3) }' "$file" \
    || die "$file: expected '${pattern//'{V}'/$OLD}'"
}

# changelog_fragment TEXT: write the bump's changelog bullet as a fixed-name
# fragment, so repeated bumps before a release overwrite one file.
changelog_fragment() {
  mkdir -p changelog.d
  printf -- '- %s\n' "$1" > changelog.d/felix-version.changed.md
}

pin sim/Cargo.toml 'felix-client = "={V}"'
pin sim/Cargo.toml 'felix-wire = "={V}"'
pin dev/compose.yml 'ghcr.io/getfelix/felix-controlplane:{V}'
pin dev/compose.yml 'ghcr.io/getfelix/felix-broker:{V}'
pin sim/ci/compose.yml 'ghcr.io/getfelix/felix-controlplane:{V}'
pin sim/ci/compose.yml 'ghcr.io/getfelix/felix-broker:{V}'
pin README.md 'The compose bundle runs Felix {V}.'
changelog_fragment "Built on Felix $NEW: the sim's \`felix-client\` and \`felix-wire\` pins, the dev stack and CI images."
