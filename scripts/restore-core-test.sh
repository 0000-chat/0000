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

docker compose --env-file deploy/images.lock.env up -d postgres
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d synapse --clean --if-exists < "$payload/synapse.pgdump"
docker compose --env-file deploy/images.lock.env up -d synapse
docker compose --env-file deploy/images.lock.env exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=5)'
docker compose --env-file deploy/images.lock.env down
trap - EXIT
echo "restore_test=PASS path=$restore_root"
