#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
restore_root="$runtime_dir/restore-tests/$(date -u +%Y%m%dT%H%M%SZ)-$$"
project=communicator-restore-test

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

if [[ -e "$restore_root" ]]; then
  echo "restore target already exists: $restore_root" >&2
  exit 1
fi

install -d -m 0700 "$restore_root"
restic restore latest --tag communicator-core --target "$restore_root/restic"

payload=$(find "$restore_root/restic" -type f -name synapse.pgdump -printf '%h\n' -quit)
[[ -n "$payload" ]]

install -d -m 0700 "$restore_root/runtime/postgres" "$restore_root/runtime/synapse" "$restore_root/runtime/secrets"
cp -a "$payload/secrets/." "$restore_root/runtime/secrets/"
cp -a "$payload/synapse-data/." "$restore_root/runtime/synapse/"
chown -R 991:991 "$restore_root/runtime/synapse"

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$restore_root/runtime"
export COMPOSE_PROJECT_NAME="$project"

cleanup() {
  cd "$repo_dir"
  docker compose --env-file deploy/images.lock.env down >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_healthy() {
  service=$1
  container_id=$(docker compose --env-file deploy/images.lock.env ps -q "$service")
  if [[ -z "$container_id" ]]; then
    echo "isolated container missing: $service" >&2
    docker compose --env-file deploy/images.lock.env ps >&2
    exit 1
  fi

  for _ in $(seq 1 180); do
    container_status=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || printf 'missing')
    health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || printf 'missing')
    if [[ "$container_status" == running && "$health_status" == healthy ]]; then
      return 0
    fi
    sleep 1
  done

  echo "isolated service did not become healthy: $service" >&2
  docker compose --env-file deploy/images.lock.env ps >&2
  docker inspect --format '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" >&2 2>/dev/null || true
  exit 1
}

docker compose --env-file deploy/images.lock.env up -d postgres
wait_for_healthy postgres
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d synapse --clean --if-exists < "$payload/synapse.pgdump"
docker compose --env-file deploy/images.lock.env up -d synapse
wait_for_healthy synapse
docker compose --env-file deploy/images.lock.env exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=5)'
docker compose --env-file deploy/images.lock.env down
trap - EXIT
echo "restore_test=PASS path=$restore_root"
