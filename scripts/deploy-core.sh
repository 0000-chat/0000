#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir"
export COMPOSE_PROJECT_NAME="$project"

./scripts/init-runtime.sh

docker compose --env-file deploy/images.lock.env config --quiet
docker compose --env-file deploy/images.lock.env pull

if [[ ! -f "$runtime_dir/synapse/communicator.0000.gold.signing.key" ]]; then
  docker run --rm \
    -e SYNAPSE_SERVER_NAME=communicator.0000.gold \
    -e SYNAPSE_REPORT_STATS=no \
    -v "$runtime_dir/synapse:/data" \
    "$SYNAPSE_IMAGE" generate
fi

cp deploy/synapse/log.config "$runtime_dir/synapse/log.config"
chmod 0600 "$runtime_dir/synapse/log.config"
chown --reference="$runtime_dir/synapse/homeserver.yaml" "$runtime_dir/synapse/log.config"

docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 postgres
./scripts/init-whatsapp-db.sh
./scripts/init-messenger-db.sh
./scripts/init-whatsapp-runtime.sh
./scripts/init-messenger-runtime.sh
python3 scripts/render-synapse-config.py \
  --postgres-env "$runtime_dir/secrets/postgres.env" \
  --registration-secret "$runtime_dir/secrets/synapse_registration_shared_secret" \
  --whatsapp-registration "$runtime_dir/synapse/whatsapp-registration.yaml" \
  --messenger-registration "$runtime_dir/synapse/messenger-registration.yaml" \
  --output "$runtime_dir/synapse/homeserver.yaml"
docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 postgres
docker compose --env-file deploy/images.lock.env up -d --no-deps --force-recreate --wait --wait-timeout 180 synapse
docker compose --env-file deploy/images.lock.env up -d --no-deps --force-recreate --wait --wait-timeout 180 caddy
docker compose --env-file deploy/images.lock.env up -d --no-deps --force-recreate --wait --wait-timeout 180 whatsapp
docker compose --env-file deploy/images.lock.env up -d --no-deps --force-recreate --wait --wait-timeout 180 messenger
docker compose --env-file deploy/images.lock.env ps
