# Sourced by up.sh and speed.sh: sets `compose` to the command that runs
# dev/compose.yml. CONTAINER_ENGINE=docker or podman picks the engine; else
# Docker when its daemon answers, else Podman, through `podman compose` or
# `podman-compose`.
engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if docker info >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1; then
    engine=podman
  elif command -v podman-compose >/dev/null 2>&1; then
    engine=podman-compose
  else
    echo "no container engine: start Docker, or install Podman (and run podman machine start on macOS)" >&2
    exit 1
  fi
fi
case "$engine" in
  docker) compose=(docker compose) ;;
  podman)
    if podman compose version >/dev/null 2>&1; then
      compose=(podman compose)
    elif command -v podman-compose >/dev/null 2>&1; then
      compose=(podman-compose)
    else
      echo "podman has no compose: install podman-compose or Docker Compose" >&2
      exit 1
    fi
    ;;
  podman-compose) compose=(podman-compose) ;;
  *)
    echo "CONTAINER_ENGINE must be docker or podman, not $engine" >&2
    exit 1
    ;;
esac
compose+=(-f "$(dirname "${BASH_SOURCE[0]}")/compose.yml")
