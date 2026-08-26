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
[[ -f "$payload/whatsapp.pgdump" ]]
[[ -f "$payload/messenger.pgdump" ]]
[[ -f "$payload/telegram.pgdump" ]]

install -d -m 0700 \
  "$restore_root/runtime/postgres" \
  "$restore_root/runtime/synapse" \
  "$restore_root/runtime/whatsapp" \
  "$restore_root/runtime/messenger" \
  "$restore_root/runtime/telegram" \
  "$restore_root/runtime/secrets"
cp -a "$payload/secrets/." "$restore_root/runtime/secrets/"
cp -a "$payload/telegram-secrets/." "$restore_root/runtime/secrets/"
cp -a "$payload/synapse-data/." "$restore_root/runtime/synapse/"
cp -a "$payload/whatsapp-data/." "$restore_root/runtime/whatsapp/"
cp -a "$payload/messenger-data/." "$restore_root/runtime/messenger/"
cp -a "$payload/telegram-data/." "$restore_root/runtime/telegram/"
mv "$restore_root/runtime/telegram/synapse-registration.yaml" "$restore_root/runtime/synapse/telegram-registration.yaml"
chown -R root:root "$restore_root/runtime/secrets"
find "$restore_root/runtime/secrets" -type f -exec chmod 0600 {} +
chown -R 991:991 "$restore_root/runtime/synapse"
chown -R 1337:1337 "$restore_root/runtime/whatsapp"
chown -R 1337:1337 "$restore_root/runtime/messenger"
[[ -f "$restore_root/runtime/synapse/messenger-registration.yaml" ]]
[[ -f "$restore_root/runtime/synapse/telegram-registration.yaml" ]]
[[ "$(stat -c '%a' "$restore_root/runtime/whatsapp/config.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/whatsapp/registration.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/whatsapp-db.password")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/messenger/config.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/messenger/registration.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/messenger-db.password")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/messenger-db.env")" == 600 ]]
chown -R 1337:1337 "$restore_root/runtime/telegram"
[[ "$(stat -c '%a' "$restore_root/runtime/telegram/config.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/telegram/registration.yaml")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/telegram-db.password")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/telegram-db.env")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/telegram-api-id")" == 600 ]]
[[ "$(stat -c '%a' "$restore_root/runtime/secrets/telegram-api-hash")" == 600 ]]

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$restore_root/runtime"
export COMPOSE_PROJECT_NAME="$project"

cleanup() {
  cd "$repo_dir"
  docker compose --env-file deploy/images.lock.env stop synapse postgres >/dev/null 2>&1 || true
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
./scripts/init-whatsapp-db.sh
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d whatsapp_bridge --clean --if-exists --no-owner < "$payload/whatsapp.pgdump"
whatsapp_table_count=$(docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d whatsapp_bridge -c \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")
[[ "$whatsapp_table_count" =~ ^[1-9][0-9]*$ ]]
echo "whatsapp_restore_tables=PASS"
./scripts/init-messenger-db.sh
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d messenger_bridge --clean --if-exists --no-owner < "$payload/messenger.pgdump"
messenger_table_count=$(docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d messenger_bridge -c \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")
[[ "$messenger_table_count" =~ ^[1-9][0-9]*$ ]]
echo "messenger_restore_tables=PASS"

./scripts/init-telegram-db.sh
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d telegram_bridge --clean --if-exists --no-owner < "$payload/telegram.pgdump"
telegram_table_count=$(docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d telegram_bridge -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[[ "$telegram_table_count" =~ ^[1-9][0-9]*$ ]]
echo "telegram_restore_tables=PASS"

install -d -o 1337 -g 1337 -m 0700 "$restore_root/validation"
install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/whatsapp/config.yaml" "$restore_root/validation/config.yaml"
docker run --rm --network none \
  -v "$restore_root/validation:/validation" \
  "$WHATSAPP_IMAGE" /usr/bin/mautrix-whatsapp \
  -c /validation/config.yaml --generate-registration -r /validation/registration.yaml >/dev/null
[[ -s "$restore_root/validation/registration.yaml" ]]
rm -rf -- "$restore_root/validation"
echo "whatsapp_config=PASS"

install -d -o 1337 -g 1337 -m 0700 "$restore_root/validation"
install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/messenger/config.yaml" "$restore_root/validation/config.yaml"
docker run --rm --network none \
  --workdir /validation \
  -v "$restore_root/validation:/validation" \
  "$MESSENGER_IMAGE" /usr/bin/mautrix-meta \
  -c /validation/config.yaml --generate-registration >/dev/null
[[ -s "$restore_root/validation/registration.yaml" ]]
rm -rf -- "$restore_root/validation"
echo "messenger_config=PASS"

install -d -o 1337 -g 1337 -m 0700 "$restore_root/telegram-validation"
install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/telegram/config.yaml" "$restore_root/telegram-validation/config.yaml"
docker run --rm --network none \
  --entrypoint /usr/bin/mautrix-telegram \
  -v "$restore_root/telegram-validation:/validation" \
  "$TELEGRAM_IMAGE" \
  -c /validation/config.yaml -g -r /validation/registration.yaml >/dev/null
[[ -s "$restore_root/telegram-validation/registration.yaml" ]]
rm -rf -- "$restore_root/telegram-validation"
echo "telegram_config=PASS"

docker compose --env-file deploy/images.lock.env up -d synapse
wait_for_healthy synapse
docker compose --env-file deploy/images.lock.env exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=5)'
docker compose --env-file deploy/images.lock.env stop synapse postgres
trap - EXIT
echo "restore_test=PASS path=$restore_root"
