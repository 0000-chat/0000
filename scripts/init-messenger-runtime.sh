#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
messenger_dir="${runtime_dir}/messenger"
registration="${messenger_dir}/registration.yaml"
config="${messenger_dir}/config.yaml"
synapse_registration="${runtime_dir}/synapse/messenger-registration.yaml"

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
[[ "$project" == communicator ]]
[[ "$MESSENGER_IMAGE" == dock.mau.dev/mautrix/meta:v26.08@sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8 ]]
install -d -m 0700 "$messenger_dir"

if [[ ! -f "$config" ]]; then
  docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps messenger >/dev/null 2>&1
fi
if [[ ! -f "$registration" ]]; then
  python3 scripts/render-messenger-config.py \
    --db-password-file "$runtime_dir/secrets/messenger-db.password" \
    --output "$config" >/dev/null
  docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps messenger >/dev/null 2>&1
fi
[[ -f "$registration" ]]
python3 scripts/render-messenger-config.py \
  --db-password-file "$runtime_dir/secrets/messenger-db.password" \
  --registration "$registration" \
  --output "$config" >/dev/null

chown 1337:1337 "$config" "$registration" "$messenger_dir"
chmod 0600 "$config" "$registration"
install -o 991 -g 991 -m 0600 "$registration" "$synapse_registration"
echo "messenger_runtime=PASS"
