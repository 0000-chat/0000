#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
restore_root="$runtime_dir/restore-tests/$(timeout --foreground 30s date -u +%Y%m%dT%H%M%SZ)-$$"
project=communicator-restore-test
gate_script="$repo_dir/scripts/restore-core-gate.py"
restore_tmpdir=${COMMUNICATOR_RESTORE_TMPDIR:-"$repo_dir/node_modules/.cache/restore-tests"}

run_bounded() {
  local duration=$1
  shift
  timeout --foreground "$duration" "$@"
}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
: "${COMMUNICATOR_RESTORE_AUTHORITY_URL:?COMMUNICATOR_RESTORE_AUTHORITY_URL is required}"
: "${COMMUNICATOR_RESTORE_AUTHORITY_TOKEN:?COMMUNICATOR_RESTORE_AUTHORITY_TOKEN is required}"
: "${COMMUNICATOR_RESTORE_TENANT_ID:?COMMUNICATOR_RESTORE_TENANT_ID is required}"
: "${COMMUNICATOR_RESTORE_ACTIVATION_LEASE_URL:?COMMUNICATOR_RESTORE_ACTIVATION_LEASE_URL is required}"

activation_lease_id="restore_lease_$$"
activation_lease_token=""

[[ -f "$gate_script" ]]
if [[ -e "$restore_root" ]]; then
  echo "restore target already exists: $restore_root" >&2
  exit 1
fi

run_bounded 30s install -d -m 0700 "$restore_root" "$restore_tmpdir"
export TMPDIR="$restore_tmpdir"
run_bounded 30s install -d -m 0700 "$restore_root/restore-evidence"
run_bounded 300s python3 "$gate_script" \
  --authority-url "$COMMUNICATOR_RESTORE_AUTHORITY_URL" \
  --authority-token "$COMMUNICATOR_RESTORE_AUTHORITY_TOKEN" \
  --tenant "$COMMUNICATOR_RESTORE_TENANT_ID" \
  --report "$restore_root/restore-evidence/authority-preflight.json" \
  --authority-only

run_bounded 60s restic snapshots --json --latest 1 --tag communicator-core \
  > "$restore_root/restore-evidence/restic-snapshot.json"
restic_snapshot_id=$(run_bounded 30s python3 -c \
  'import json, sys; document=json.load(open(sys.argv[1], encoding="utf-8")); rows=document if isinstance(document, list) else document.get("snapshots", []); ids={row.get("id") for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str) and row.get("id")}; assert len(ids) == 1, "restic snapshot selection was not exact"; print(next(iter(ids)))' \
  "$restore_root/restore-evidence/restic-snapshot.json")
[[ "$restic_snapshot_id" =~ ^[A-Za-z0-9]+$ ]]
run_bounded 300s restic restore "$restic_snapshot_id" --target "$restore_root/restic"

payload=$(run_bounded 30s find "$restore_root/restic" -type f -name synapse.pgdump -printf '%h\n' -quit)
[[ -n "$payload" ]]
run_bounded 900s python3 "$gate_script" \
  --authority-url "$COMMUNICATOR_RESTORE_AUTHORITY_URL" \
  --authority-token "$COMMUNICATOR_RESTORE_AUTHORITY_TOKEN" \
  --tenant "$COMMUNICATOR_RESTORE_TENANT_ID" \
  --payload "$payload" \
  --restic-snapshot-id "$restic_snapshot_id" \
  --report "$restore_root/restore-evidence/restore-gate.json"
[[ -f "$payload/retention/controlled-copy-layout.json" ]]
[[ -f "$payload/whatsapp.pgdump" ]]
[[ -f "$payload/messenger.pgdump" ]]
[[ -f "$payload/telegram.pgdump" ]]

run_bounded 30s install -d -m 0700 \
  "$restore_root/runtime/postgres" \
  "$restore_root/runtime/synapse" \
  "$restore_root/runtime/whatsapp" \
  "$restore_root/runtime/messenger" \
  "$restore_root/runtime/telegram" \
  "$restore_root/runtime/secrets"
run_bounded 300s cp -a "$payload/secrets/." "$restore_root/runtime/secrets/"
run_bounded 300s cp -a "$payload/telegram-secrets/." "$restore_root/runtime/secrets/"
run_bounded 300s cp -a "$payload/synapse-data/." "$restore_root/runtime/synapse/"
run_bounded 300s cp -a "$payload/whatsapp-data/." "$restore_root/runtime/whatsapp/"
run_bounded 300s cp -a "$payload/messenger-data/." "$restore_root/runtime/messenger/"
run_bounded 300s cp -a "$payload/telegram-data/." "$restore_root/runtime/telegram/"
run_bounded 30s mv "$restore_root/runtime/telegram/synapse-registration.yaml" "$restore_root/runtime/synapse/telegram-registration.yaml"
run_bounded 300s chown -R root:root "$restore_root/runtime/secrets"
run_bounded 300s find "$restore_root/runtime/secrets" -type f -exec chmod 0600 {} +
run_bounded 300s chown -R 991:991 "$restore_root/runtime/synapse"
run_bounded 300s chown -R 1337:1337 "$restore_root/runtime/whatsapp"
run_bounded 300s chown -R 1337:1337 "$restore_root/runtime/messenger"
[[ -f "$restore_root/runtime/synapse/messenger-registration.yaml" ]]
[[ -f "$restore_root/runtime/synapse/telegram-registration.yaml" ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/whatsapp/config.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/whatsapp/registration.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/whatsapp-db.password")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/messenger/config.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/messenger/registration.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/messenger-db.password")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/messenger-db.env")" == 600 ]]
run_bounded 300s chown -R 1337:1337 "$restore_root/runtime/telegram"
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/telegram/config.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/telegram/registration.yaml")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/telegram-db.password")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/telegram-db.env")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/telegram-api-id")" == 600 ]]
[[ "$(run_bounded 30s stat -c '%a' "$restore_root/runtime/secrets/telegram-api-hash")" == 600 ]]

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$restore_root/runtime"
export COMPOSE_PROJECT_NAME="$project"

cleanup() {
  cd "$repo_dir"
  run_bounded 120s docker compose --env-file deploy/images.lock.env stop synapse postgres >/dev/null 2>&1 || true
  if [[ -n "$activation_lease_token" ]]; then
    run_bounded 300s python3 "$gate_script" \
      --authority-token "$COMMUNICATOR_RESTORE_AUTHORITY_TOKEN" \
      --tenant "$COMMUNICATOR_RESTORE_TENANT_ID" \
      --report "$restore_root/restore-evidence/activation-lease-release.json" \
      --activation-lease-url "$COMMUNICATOR_RESTORE_ACTIVATION_LEASE_URL" \
      --activation-lease-id "$activation_lease_id" \
      --activation-lease-token "$activation_lease_token" \
      --activation-lease-action release >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_healthy() {
  service=$1
  container_id=$(run_bounded 30s docker compose --env-file deploy/images.lock.env ps -q "$service")
  if [[ -z "$container_id" ]]; then
    echo "isolated container missing: $service" >&2
    run_bounded 30s docker compose --env-file deploy/images.lock.env ps >&2
    exit 1
  fi

  for ((attempt = 1; attempt <= 180; attempt += 1)); do
    container_status=$(run_bounded 30s docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || printf 'missing')
    health_status=$(run_bounded 30s docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || printf 'missing')
    if [[ "$container_status" == running && "$health_status" == healthy ]]; then
      return 0
    fi
    run_bounded 2s sleep 1
  done

  echo "isolated service did not become healthy: $service" >&2
  run_bounded 30s docker compose --env-file deploy/images.lock.env ps >&2
  run_bounded 30s docker inspect --format '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" >&2 2>/dev/null || true
  exit 1
}

run_bounded 300s docker compose --env-file deploy/images.lock.env up -d postgres
wait_for_healthy postgres
run_bounded 300s docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d synapse --clean --if-exists < "$payload/synapse.pgdump"
run_bounded 300s "$repo_dir/scripts/init-whatsapp-db.sh"
run_bounded 300s docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d whatsapp_bridge --clean --if-exists --no-owner < "$payload/whatsapp.pgdump"
whatsapp_table_count=$(run_bounded 60s docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d whatsapp_bridge -c \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")
[[ "$whatsapp_table_count" =~ ^[1-9][0-9]*$ ]]
echo "whatsapp_restore_tables=PASS"
run_bounded 300s "$repo_dir/scripts/init-messenger-db.sh"
run_bounded 300s docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d messenger_bridge --clean --if-exists --no-owner < "$payload/messenger.pgdump"
messenger_table_count=$(run_bounded 60s docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d messenger_bridge -c \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")
[[ "$messenger_table_count" =~ ^[1-9][0-9]*$ ]]
echo "messenger_restore_tables=PASS"

run_bounded 300s "$repo_dir/scripts/init-telegram-db.sh"
run_bounded 300s docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d telegram_bridge --clean --if-exists --no-owner < "$payload/telegram.pgdump"
telegram_table_count=$(run_bounded 60s docker compose --env-file deploy/images.lock.env exec -T postgres \
  psql -At -U synapse -d telegram_bridge -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[[ "$telegram_table_count" =~ ^[1-9][0-9]*$ ]]
echo "telegram_restore_tables=PASS"

run_bounded 30s install -d -o 1337 -g 1337 -m 0700 "$restore_root/validation"
run_bounded 30s install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/whatsapp/config.yaml" "$restore_root/validation/config.yaml"
run_bounded 300s docker run --rm --network none \
  -v "$restore_root/validation:/validation" \
  "$WHATSAPP_IMAGE" /usr/bin/mautrix-whatsapp \
  -c /validation/config.yaml --generate-registration -r /validation/registration.yaml >/dev/null
[[ -s "$restore_root/validation/registration.yaml" ]]
run_bounded 30s rm -rf -- "$restore_root/validation"
echo "whatsapp_config=PASS"

run_bounded 30s install -d -o 1337 -g 1337 -m 0700 "$restore_root/validation"
run_bounded 30s install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/messenger/config.yaml" "$restore_root/validation/config.yaml"
run_bounded 300s docker run --rm --network none \
  --workdir /validation \
  -v "$restore_root/validation:/validation" \
  "$MESSENGER_IMAGE" /usr/bin/mautrix-meta \
  -c /validation/config.yaml --generate-registration >/dev/null
[[ -s "$restore_root/validation/registration.yaml" ]]
run_bounded 30s rm -rf -- "$restore_root/validation"
echo "messenger_config=PASS"

run_bounded 30s install -d -o 1337 -g 1337 -m 0700 "$restore_root/telegram-validation"
run_bounded 30s install -o 1337 -g 1337 -m 0600 \
  "$restore_root/runtime/telegram/config.yaml" "$restore_root/telegram-validation/config.yaml"
run_bounded 300s docker run --rm --network none \
  --entrypoint /usr/bin/mautrix-telegram \
  -v "$restore_root/telegram-validation:/validation" \
  "$TELEGRAM_IMAGE" \
  -c /validation/config.yaml -g -r /validation/registration.yaml >/dev/null
[[ -s "$restore_root/telegram-validation/registration.yaml" ]]
run_bounded 30s rm -rf -- "$restore_root/telegram-validation"
echo "telegram_config=PASS"

run_bounded 300s python3 "$gate_script" \
  --authority-url "$COMMUNICATOR_RESTORE_AUTHORITY_URL" \
  --authority-token "$COMMUNICATOR_RESTORE_AUTHORITY_TOKEN" \
  --tenant "$COMMUNICATOR_RESTORE_TENANT_ID" \
  --activation-report "$restore_root/restore-evidence/restore-gate.json" \
  --report "$restore_root/restore-evidence/activation-authority.json" \
  --activation-lease-url "$COMMUNICATOR_RESTORE_ACTIVATION_LEASE_URL" \
  --activation-lease-id "$activation_lease_id"
activation_lease_token=$(run_bounded 30s python3 -c \
  'import json, sys; document=json.load(open(sys.argv[1], encoding="utf-8")); lease=document.get("activation_lease", {}); token=lease.get("lease_token"); assert isinstance(token, str) and len(token) >= 32, "activation lease token missing"; print(token)' \
  "$restore_root/restore-evidence/activation-authority.json")
[[ ${#activation_lease_token} -ge 32 ]]
run_bounded 300s docker compose --env-file deploy/images.lock.env up -d synapse
wait_for_healthy synapse
run_bounded 60s docker compose --env-file deploy/images.lock.env exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=5)'
run_bounded 300s python3 "$gate_script" \
  --authority-token "$COMMUNICATOR_RESTORE_AUTHORITY_TOKEN" \
  --tenant "$COMMUNICATOR_RESTORE_TENANT_ID" \
  --report "$restore_root/restore-evidence/activation-lease-release.json" \
  --activation-lease-url "$COMMUNICATOR_RESTORE_ACTIVATION_LEASE_URL" \
  --activation-lease-id "$activation_lease_id" \
  --activation-lease-token "$activation_lease_token" \
  --activation-lease-action release
activation_lease_token=""
run_bounded 120s docker compose --env-file deploy/images.lock.env stop synapse postgres
trap - EXIT
echo "restore_test=PASS path=$restore_root"
