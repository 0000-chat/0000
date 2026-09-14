#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
staging=$(mktemp -d "$runtime_dir/backups/core.XXXXXX")
restic_result=$(mktemp "$runtime_dir/backups/core-result.XXXXXX")

restart_core() {
  docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp messenger telegram
}

cleanup() {
  rm -rf -- "$staging"
  rm -f -- "$restic_result"
  cd "$repo_dir"
  restart_core >/dev/null 2>&1 || true
}
trap cleanup EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env stop telegram messenger whatsapp synapse
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d synapse --format=custom > "$staging/synapse.pgdump"
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d whatsapp_bridge --format=custom > "$staging/whatsapp.pgdump"
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d telegram_bridge --format=custom > "$staging/telegram.pgdump"
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d messenger_bridge --format=custom > "$staging/messenger.pgdump"

install -d -m 0700 \
  "$staging/synapse-data" \
  "$staging/whatsapp-data" \
  "$staging/messenger-data" \
  "$staging/telegram-data" \
  "$staging/telegram-secrets" \
  "$staging/secrets"
cp -a "$runtime_dir/synapse/homeserver.yaml" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/log.config" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/communicator.0000.gold.signing.key" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/whatsapp-registration.yaml" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/media_store" "$staging/synapse-data/"
cp -a "$runtime_dir/whatsapp/config.yaml" "$staging/whatsapp-data/"
cp -a "$runtime_dir/whatsapp/registration.yaml" "$staging/whatsapp-data/"
cp -a "$runtime_dir/messenger/config.yaml" "$staging/messenger-data/"
cp -a "$runtime_dir/messenger/registration.yaml" "$staging/messenger-data/"
cp -a "$runtime_dir/synapse/messenger-registration.yaml" "$staging/synapse-data/"
cp -a "$runtime_dir/telegram/config.yaml" "$staging/telegram-data/"
cp -a "$runtime_dir/telegram/registration.yaml" "$staging/telegram-data/"
cp -a "$runtime_dir/synapse/telegram-registration.yaml" "$staging/telegram-data/synapse-registration.yaml"
cp -a "$runtime_dir/secrets/postgres.env" "$staging/secrets/"
cp -a "$runtime_dir/secrets/synapse_registration_shared_secret" "$staging/secrets/"
cp -a "$runtime_dir/secrets/whatsapp-db.password" "$staging/secrets/"
cp -a "$runtime_dir/secrets/whatsapp-db.env" "$staging/secrets/"
cp -a "$runtime_dir/secrets/messenger-db.password" "$staging/secrets/"
cp -a "$runtime_dir/secrets/messenger-db.env" "$staging/secrets/"
cp -a "$runtime_dir/secrets/telegram-db.password" "$staging/telegram-secrets/"
cp -a "$runtime_dir/secrets/telegram-db.env" "$staging/telegram-secrets/"
cp -a "$runtime_dir/secrets/telegram-api-id" "$staging/telegram-secrets/"
cp -a "$runtime_dir/secrets/telegram-api-hash" "$staging/telegram-secrets/"

# Keep a non-secret inventory record inside the snapshot. The core backup is
# intentionally mixed: database dumps, media, bridge state, and session/account
# credentials share one restic snapshot. Its in-snapshot marker is descriptive;
# the sidecar written after restic returns is authoritative because only restic
# can assign the actual snapshot id.
backup_id=$(basename "$staging")
backup_created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
install -d -m 0700 "$staging/retention"
cat > "$staging/retention/controlled-copy-manifest.json" <<EOF
{
  "version": 1,
  "stores": {
    "restic_snapshot": {
      "enumeration_complete": true,
      "copies": [
        {
          "reference": "restic:${backup_id}",
          "resource_id": "*",
          "content_generation": "*",
          "copy_created_at": "${backup_created_at}",
          "content_classes": ["message", "session_credential", "account_key"]
        }
      ]
    }
  }
}
EOF

restic backup --json --tag communicator-core "$staging" > "$restic_result"
install -d -m 0700 "$runtime_dir/retention"
python3 "$repo_dir/scripts/merge-controlled-copy-manifest.py" \
  "$restic_result" \
  "$runtime_dir/retention/controlled-copy-manifest.json" \
  "$backup_created_at"
restic check
restart_core
trap - EXIT
rm -rf -- "$staging"
echo "backup=PASS"
