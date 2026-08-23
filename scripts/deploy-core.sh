#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir"

./scripts/init-runtime.sh

if [[ ! -f "$runtime_dir/synapse/communicator.0000.gold.signing.key" ]]; then
  docker run --rm \
    -e SYNAPSE_SERVER_NAME=communicator.0000.gold \
    -e SYNAPSE_REPORT_STATS=no \
    -v "$runtime_dir/synapse:/data" \
    "$SYNAPSE_IMAGE" generate
fi

cp deploy/synapse/log.config "$runtime_dir/synapse/log.config"
chmod 0600 "$runtime_dir/synapse/log.config"

python3 scripts/render-synapse-config.py \
  --postgres-env "$runtime_dir/secrets/postgres.env" \
  --registration-secret "$runtime_dir/secrets/synapse_registration_shared_secret" \
  --output "$runtime_dir/synapse/homeserver.yaml"

docker compose --env-file deploy/images.lock.env config --quiet
docker compose --env-file deploy/images.lock.env pull
docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 postgres synapse caddy
docker compose --env-file deploy/images.lock.env ps
