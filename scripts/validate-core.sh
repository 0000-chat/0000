#!/usr/bin/env bash
set -euo pipefail

matrix=https://matrix.communicator.0000.gold
identity=https://communicator.0000.gold

curl -fsS "$matrix/_matrix/client/versions" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/client" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/server" | python3 -m json.tool >/dev/null

federation_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/federation/v1/version")
key_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/key/v2/server")
[[ "$federation_status" == "404" ]]
[[ "$key_status" == "404" ]]

if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008)$'; then
  echo "PostgreSQL or Synapse is published on the host" >&2
  exit 1
fi

docker compose --env-file deploy/images.lock.env ps --status running --services | sort | diff -u \
  <(printf 'caddy\npostgres\nsynapse\n') -

echo "core_validation=PASS"
