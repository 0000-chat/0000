#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
cd "$repo_dir"
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir" COMPOSE_PROJECT_NAME="$project"
[[ "$runtime_dir" == /srv/communicator ]]
[[ "$project" == communicator ]]

matrix=https://matrix.communicator.0000.gold
identity=https://communicator.0000.gold

curl -fsS "$matrix/_matrix/client/versions" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/client" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/server" | python3 -m json.tool >/dev/null

federation_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/federation/v1/version")
key_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/key/v2/server")
[[ "$federation_status" == "404" ]]
[[ "$key_status" == "404" ]]

if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29318|29319|2019)$'; then
  echo "private service port is published on the host" >&2
  exit 1
fi

docker compose --env-file deploy/images.lock.env --project-name "$project" ps --status running --services | sort | diff -u \
  <(printf 'caddy\nmessenger\npostgres\nsynapse\nwhatsapp\n') -

echo "core_validation=PASS"
