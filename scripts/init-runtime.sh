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
  "$runtime_dir/restore-tests"

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

printf 'runtime initialized at %s\n' "$runtime_dir"
