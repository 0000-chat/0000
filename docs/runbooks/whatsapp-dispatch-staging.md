# WhatsApp text dispatch staging proof

This runbook has two separate proof paths. The controlled fixture path proves
the Worker adapter contract without a provider account. The staging path below
is the only path that may be used to test a real linked account, and it sends
one approved text through the existing account, grant, Matrix room, and
gateway binding.

Neither path may claim WhatsApp delivery from a saved command, Matrix
acceptance, or bridge acceptance. Provider evidence must be returned by the
gateway and inspected through the administrator evidence view.

## Controlled fixture proof

These are controlled fixtures, not a live account or provider send. Run them
from the control-plane package with the repository's test double:

```sh
cd apps/control-plane
WRANGLER_HOME="$PWD/../../node_modules/.cache/worker21-test-tmp/wrangler" \
TMPDIR="$PWD/../../node_modules/.cache/worker21-test-tmp" \
node_modules/.bin/vitest run --config vitest.worker.config.ts \
  worker/test/outbound/whatsapp-adapter.test.ts
```

The fixture must return explicit Matrix, bridge, and provider evidence. An
`accepted` or `delivered` outcome without stage evidence is recorded as
uncertain. Replaying a fixture request uses the same transaction and the same
`outbound-<transaction_id>` gateway idempotency key.

## Approved staging proof

Do not run the send command until the operator has separately approved one
sacrificial linked account, one conversation, and one message body. Set
`APPROVED_STAGING_SEND=1` only for that approved run. The commands below are
templates; replace every angle-bracket placeholder with the values from the
same staging tenant and keep the bearer tokens outside shell history.

Before this proof, complete the protected secret procedure in the OAuth
deployment runbook. The Worker secret `CONNECTION_GATEWAY_TOKEN` must match the
value in the gateway's `provisioning.gateway_shared_secret_file`. Keep
`LINKING_IDENTITY_HMAC_SECRET` independently managed and never reuse the
gateway secret for it.

```sh
export STAGING_BASE_URL='https://<staging-worker-host>'
export STAGING_TOKEN='<agent-or-human-bearer-token>'
export STAGING_ADMIN_TOKEN='<owner-or-admin-bearer-token>'
export TENANT_ID='<tenant_id>'
export IDENTITY_ID='<identity_id>'
export MEMBERSHIP_ID='<membership_id>'
export ACCOUNT_ID='<account_id>'
export CONNECTION_ID='<connection_id>'
export CONVERSATION_ID='<conversation_id>'
export APPROVED_STAGING_SEND=0
export STAGING_IDEMPOTENCY_KEY='staging-whatsapp-proof-<change-id>'
```

The linked account must be the selected `whatsapp` account and its status must
be `connected`, `syncing`, or `ready`. Confirm the account and conversation
with the existing read routes before changing any grant or sending:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${STAGING_TOKEN}" \
  "${STAGING_BASE_URL}/api/v1/accounts?identity_id=${IDENTITY_ID}&limit=100"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${STAGING_TOKEN}" \
  "${STAGING_BASE_URL}/api/v1/identities/${IDENTITY_ID}/conversations?account_id=${ACCOUNT_ID}&limit=100"
```

An owner or administrator can create or restore the exact account/chat
`message.send` grant with the real grant schema. Reuse the same mutation key
if the request must be retried:

```sh
curl --fail-with-body --silent --show-error \
  -X POST "${STAGING_BASE_URL}/api/v1/grants" \
  -H "Authorization: Bearer ${STAGING_ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data @- <<JSON
{
  "membership_id": "${MEMBERSHIP_ID}",
  "identity_id": "${IDENTITY_ID}",
  "account_id": "${ACCOUNT_ID}",
  "operation_scope": "message.send",
  "chat_scope": "selected_chats",
  "chat_ids": ["${CONVERSATION_ID}"],
  "idempotency_key": "staging-grant-${ACCOUNT_ID}-${CONVERSATION_ID}"
}
JSON

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${STAGING_ADMIN_TOKEN}" \
  "${STAGING_BASE_URL}/api/v1/grants?identity_id=${IDENTITY_ID}&account_id=${ACCOUNT_ID}&status=active&limit=100"
```

The protected gateway registry must contain the same immutable account and
conversation binding. The authoritative session generation is
`connections.updated_at`; it is not the time at which the registry file is
written and must not be invented by the operator. Read the complete route and
generation from the staging D1 row immediately before creating the protected
binding. This is the same join and generation read used by the Worker adapter:

```sh
pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB \
  --env staging --remote \
  --command "SELECT c.tenant_id, c.identity_id, c.id AS connection_id, c.provider, ca.account_id, c.status, c.updated_at AS session_generation, cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id, cr.matrix_room_namespace, EXISTS (SELECT 1 FROM connection_capabilities AS cc WHERE cc.tenant_id = c.tenant_id AND cc.connection_id = c.id AND cc.capability = 'message.send') AS has_send_capability, EXISTS (SELECT 1 FROM connection_provider_identities AS pi WHERE pi.tenant_id = c.tenant_id AND pi.connection_id = c.id AND pi.provider = c.provider) AS has_provider_identity FROM connections AS c JOIN connection_accounts AS ca ON ca.connection_id = c.id AND ca.status = 'active' JOIN connection_routes AS cr ON cr.connection_id = c.id WHERE c.tenant_id = '${TENANT_ID}' AND c.id = '${CONNECTION_ID}' AND c.identity_id = '${IDENTITY_ID}' AND ca.account_id = '${ACCOUNT_ID}' LIMIT 1;"
```

Require one row with `provider = 'whatsapp'`, a usable status, both capability
flags equal to `1`, and the exact route values expected by the gateway. Write
those values, including the exact `session_generation` string, to a protected
operator file outside Git:

```json
{
  "schema_version": 1,
  "matrix_room_id": "<matrix_room_id>",
  "tenant_id": "<tenant_id>",
  "identity_id": "<identity_id>",
  "connection_id": "<connection_id>",
  "account_id": "<account_id>",
  "platform": "whatsapp",
  "gateway_route_id": "<gateway_route_id>",
  "conversation_id": "<conversation_id>",
  "owner_matrix_user_id": "<matrix_user_id>",
  "session_generation": "<exact_connections.updated_at>"
}
```

Install the file through the existing protected registry command. The command
returns only a synthetic binding ID; retain that ID and the D1 query output in
the staging evidence record. The registry payload and state key remain
protected operator files:

```sh
/usr/local/bin/communicator-matrix-gateway registry add \
  --state-db '/<protected-state-dir>/gateway.sqlite3' \
  --state-key-file '/<protected-secret-dir>/state-key' \
  --input '/<protected-staging-dir>/whatsapp-room-binding.json'

/usr/local/bin/communicator-matrix-gateway registry list-summary \
  --state-db '/<protected-state-dir>/gateway.sqlite3' \
  --state-key-file '/<protected-secret-dir>/state-key'
```

If the account is relinked or `connections.updated_at` changes, retire the old
binding and create a new one from a fresh authoritative query. Do not update a
stale binding by guessing a timestamp, and do not select another account as a
fallback.

Only after the account, grant, route, and protected binding have been checked
may the approved REST send be run:

```sh
test "${APPROVED_STAGING_SEND}" = 1 || {
  echo 'Set APPROVED_STAGING_SEND=1 only after explicit staging-send approval' >&2
  exit 2
}

curl --fail-with-body --silent --show-error \
  -X POST "${STAGING_BASE_URL}/api/v1/conversations/${CONVERSATION_ID}/messages" \
  -H "Authorization: Bearer ${STAGING_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: ${STAGING_IDEMPOTENCY_KEY}" \
  --data @- <<JSON | tee '/<protected-evidence-dir>/whatsapp-dispatch-command.json'
{
  "identity_id": "${IDENTITY_ID}",
  "body": "<one approved staging message>",
  "delivery_mode": "direct"
}
JSON
```

The server resolves the conversation owner and returns a command containing
the durable `command.id` and `transaction_id`. If the request times out or its
response is lost, retry the identical body with the identical
`STAGING_IDEMPOTENCY_KEY`; never create a new key or a new message to recover
an unknown result. A replay must retain the original transaction and gateway
idempotency key.

Use the returned command ID with the command status endpoint, then inspect the
durable evidence endpoint with an owner or administrator token:

```sh
export COMMAND_ID='<command.id from whatsapp-dispatch-command.json>'

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${STAGING_TOKEN}" \
  "${STAGING_BASE_URL}/api/v1/commands/${COMMAND_ID}" \
  | tee '/<protected-evidence-dir>/whatsapp-dispatch-command-status.json'

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${STAGING_ADMIN_TOKEN}" \
  "${STAGING_BASE_URL}/api/v1/commands/${COMMAND_ID}/evidence" \
  | tee '/<protected-evidence-dir>/whatsapp-dispatch-command-evidence.json'
```

Record the HTTP status, command ID, transaction ID, request digest, selected
account and connection, every evidence source/status/identifier, and the
observed timestamps. `matrix` evidence can establish Matrix confirmation;
`bridge` evidence can establish bridge acceptance; only explicit `provider`
evidence may establish a provider outcome. If any stage is missing or the
gateway returns an uncertain result, leave the command uncertain and follow
the reconciliation procedure. Do not write “WhatsApp delivered” based on the
HTTP response, a Matrix event, or a bridge acknowledgement alone.
