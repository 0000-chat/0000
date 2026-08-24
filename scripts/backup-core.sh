#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
staging=$(mktemp -d "$runtime_dir/backups/core.XXXXXX")

cleanup() {
  rm -rf -- "$staging"
  docker compose --env-file "$repo_dir/deploy/images.lock.env" start synapse >/dev/null 2>&1 || true
}
trap cleanup EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env stop synapse
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d synapse --format=custom > "$staging/synapse.pgdump"

install -d -m 0700 "$staging/synapse-data" "$staging/secrets"
cp -a "$runtime_dir/synapse/homeserver.yaml" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/log.config" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/communicator.0000.gold.signing.key" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/media_store" "$staging/synapse-data/"
cp -a "$runtime_dir/secrets/postgres.env" "$staging/secrets/"
cp -a "$runtime_dir/secrets/synapse_registration_shared_secret" "$staging/secrets/"

restic backup "$staging" --tag communicator-core
restic check
docker compose --env-file deploy/images.lock.env start synapse
trap - EXIT
rm -rf -- "$staging"
echo "backup=PASS"
