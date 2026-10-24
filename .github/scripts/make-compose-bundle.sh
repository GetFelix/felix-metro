#!/usr/bin/env bash
# Build the compose bundle from dev/: the same stack, with the sim and the web
# app pulled as published images instead of built. Usage:
#   make-compose-bundle.sh <version> <dest-dir>
# The bundle unpacks to <dest-dir>/felix-metro-compose-<version>/.
set -euo pipefail
version="${1:?usage: make-compose-bundle.sh <version> <dest-dir>}"
dest="${2:?usage: make-compose-bundle.sh <version> <dest-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="felix-metro-compose-${version}"
out="${dest}/${name}"

rm -rf "$out"
mkdir -p "$out"
# The Dockerfiles and the nginx template are inside the images.
for f in "$root"/dev/*; do
  case "$(basename "$f")" in
    *.Dockerfile | nginx.conf.template | state) ;;
    *) cp -a "$f" "$out/" ;;
  esac
done

python3 - "$out" "$version" <<'PY'
import re
import sys
from pathlib import Path

out, version = Path(sys.argv[1]), sys.argv[2]

compose = (out / "compose.yml").read_text()
for service, image in (("sim", "felix-metro-sim"), ("web", "felix-metro-web")):
    pattern = re.compile(
        rf"(  {service}:\n)    build:\n      context: \.\.\n      dockerfile: dev/{service}\.Dockerfile\n"
    )
    compose, n = pattern.subn(
        rf"\1    image: ghcr.io/getfelix/{image}:${{METRO_VERSION:-{version}}}\n", compose
    )
    if n != 1:
        sys.exit(f"compose.yml: no build block for {service}")
compose = compose.replace("`dev/up.sh`", "`./up.sh`")
(out / "compose.yml").write_text(compose)

# Nothing to build, and the scripts sit at the top of the bundle.
up = (out / "up.sh").read_text()
if " --build" not in up:
    sys.exit("up.sh: no --build to drop")
up = up.replace("up --detach --build", "up --detach").replace("dev/speed.sh", "./speed.sh")
(out / "up.sh").write_text(up)
for script in out.glob("*.sh"):
    text = script.read_text()
    text = text.replace("dev/speed.sh", "./speed.sh").replace("dev/city.sh", "./city.sh")
    text = text.replace("dev/gateway.sh", "./gateway.sh").replace("dev/up.sh", "./up.sh")
    script.write_text(text)
PY
chmod +x "$out"/*.sh
