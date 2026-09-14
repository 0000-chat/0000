#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]] || [[ "$2" != "user" && "$2" != "admin" ]]; then
  echo "usage: $0 <localpart> <user|admin>" >&2
  exit 2
fi

localpart=$1
role=$2
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
admin_flag=--no-admin
[[ "$role" == "admin" ]] && admin_flag=--admin

read -rsp "Password for @${localpart}:communicator.0000.gold: " password
echo

docker compose --env-file deploy/images.lock.env exec -T synapse \
  register_new_matrix_user \
  --user "$localpart" \
  --password "$password" \
  "$admin_flag" \
  --config /data/homeserver.yaml \
  http://localhost:8008
unset password
