#!/usr/bin/env bash
set -euo pipefail

runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-communicator}
umask 077

install -d -m 0700 \
  "$runtime_dir/secrets" \
  "$runtime_dir/postgres" \
  "$runtime_dir/synapse" \
  "$runtime_dir/caddy/data" \
  "$runtime_dir/caddy/config" \
  "$runtime_dir/backups" \
  "$runtime_dir/restore-tests" \
  "$runtime_dir/whatsapp" \
  "$runtime_dir/whatsapp-backups" \
  "$runtime_dir/messenger" \
  "$runtime_dir/messenger-backups"

postgres_env="$runtime_dir/secrets/postgres.env"
if [[ ! -e "$postgres_env" ]]; then
  password=$(openssl rand -base64 48 | tr -d '\n')
  printf 'POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=%s\n' "$password" > "$postgres_env"
  chmod 0600 "$postgres_env"
fi

registration_secret="$runtime_dir/secrets/synapse_registration_shared_secret"
if [[ ! -e "$registration_secret" ]]; then
  openssl rand -hex 48 > "$registration_secret"
  chmod 0600 "$registration_secret"
fi

whatsapp_password="$runtime_dir/secrets/whatsapp-db.password"
if [[ ! -e "$whatsapp_password" ]]; then
  openssl rand -base64 48 | tr -d '\n' > "$whatsapp_password"
  printf '\n' >> "$whatsapp_password"
fi
chmod 0600 "$whatsapp_password"

whatsapp_env="$runtime_dir/secrets/whatsapp-db.env"
if [[ ! -e "$whatsapp_env" ]]; then
  temporary_env=$(mktemp "$runtime_dir/secrets/whatsapp-db.env.XXXXXX")
  chmod 0600 "$temporary_env"
  {
    printf 'WHATSAPP_DB_PASSWORD='
    cat "$whatsapp_password"
  } > "$temporary_env"
  mv "$temporary_env" "$whatsapp_env"
fi
chmod 0600 "$whatsapp_env"

messenger_password="$runtime_dir/secrets/messenger-db.password"
if [[ ! -e "$messenger_password" ]]; then
  openssl rand -base64 48 | tr -d '\n' > "$messenger_password"
  printf '\n' >> "$messenger_password"
fi
chmod 0600 "$messenger_password"

messenger_env="$runtime_dir/secrets/messenger-db.env"
if [[ ! -e "$messenger_env" ]]; then
  temporary_env=$(mktemp "$runtime_dir/secrets/messenger-db.env.XXXXXX")
  chmod 0600 "$temporary_env"
  {
    printf 'MESSENGER_DB_PASSWORD='
    cat "$messenger_password"
  } > "$temporary_env"
  mv "$temporary_env" "$messenger_env"
fi
chmod 0600 "$messenger_env"

printf 'runtime initialized at %s\n' "$runtime_dir"
