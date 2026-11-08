---
repo: 0000-chat/0000
status: current
---

# Client acceptance runner

This runbook explains how to collect evidence for ChatGPT Work (#35) and Grok
(#36) against a configured Communicator target. The runner sends the declared
REST and Streamable HTTP MCP requests to the target. It records response
status, response hashes, selected identifiers, exact client and provider
versions, and the configured OAuth resource and account bindings.

The runner does not create credentials, deploy a Worker, link an account, or
invent a pass. A run with missing credentials, missing operations, missing
provider evidence, or an unreachable target records `unverified`. A target
response records `unsupported` only when the operation declares an explicit
capability outcome, status, and scalar capability evidence. An unexpected
response records `implementation_defect`. Only observed responses with every
required case, typed scalar evidence, request contract, and cross-case binding
relation can produce `pass`.

The implementation is in
[`scripts/client_acceptance.py`](../../scripts/client_acceptance.py). The
evidence contract is
[`docs/schemas/client-acceptance-evidence.schema.json`](../schemas/client-acceptance-evidence.schema.json).
The test seam injects a transport; the command line runner uses real HTTP.

## Prepare a run

Copy [`client-acceptance-config.example.json`](client-acceptance-config.example.json)
to protected operator storage. Set `mode` to `live_client` for a ChatGPT Work
or Grok run. Use `controlled` only for an approved controlled backend and keep
that evidence separate from client proof.

Fill every target field from the actual run:

- `target.client` names the exact client surface and version, such as the
  ChatGPT Work connector or Grok web, mobile, or Bot surface.
- `target.provider` names the WhatsApp provider version, adapter version, and
  proof source. A pinned bridge image or provider release must be named.
- `target.resource` is the exact OAuth resource. It must match the protected
  resource metadata returned by the target.
- `target.bindings` records tenant, installation, grant, connected account,
  chat, connection, and identity IDs. Provider-account identity is external
  provider evidence and stays separate from public Communicator responses.
  Empty arrays are valid only before the corresponding administrator step. A
  passing operation must extract the IDs it claims to prove.
- `oauth.access_token_env` or `oauth.access_token_file` points to a protected
  access token source. The token never belongs in the JSON configuration.
  Administrator-only operations may use a separate
  `admin_access_token_env` or `admin_access_token_file`.

Obtain the token through the approved Platform flow described in
[Platform-backed authentication](oauth-remote-mcp.md). Do not bootstrap the
retired Worker-local issuer. No public Communicator MCP address is established
by this runner. The runner can create the authorization URL and exchange the
callback code with PKCE S256:

```sh
python3 scripts/client_acceptance.py oauth-start \
  --config /protected/communicator/chatgpt-work.json \
  --state-file /protected/communicator/chatgpt-work.oauth-state.json

# Open the printed URL in the approved client flow. Then pass its complete
# callback URL to the exchange command.
python3 scripts/client_acceptance.py oauth-exchange \
  --config /protected/communicator/chatgpt-work.json \
  --state-file /protected/communicator/chatgpt-work.oauth-state.json \
  --redirect-url 'https://client.example/callback?code=...&state=...' \
  --output-token /protected/communicator/chatgpt-work.access-token
```

The state and token files are written with mode `0600`. Review the callback
host and resource before opening the authorization URL. The exchange rejects a
state mismatch and does not print the token.

Validate a configuration without network access before running it:

```sh
python3 scripts/client_acceptance.py run \
  --config /protected/communicator/chatgpt-work.json \
  --output /protected/communicator/chatgpt-work.evidence.json \
  --dry-run
```

The dry run reports scenarios that have no declared operations. Add operations
until the plan covers every required scenario. The catalog is in the runner
and contains the full #35 and #36 acceptance scope.

## Declare operations

Each operation names a scenario requirement through `proof.role` and
`proof.case`. Set `proof.observation` when one case needs more than one
response role, such as `disconnect_result` and `history_after_disconnect`.
The operation then names its actor, transport, request, accepted HTTP
statuses, and typed evidence fields. The case contract checks the exact REST
route, method, request headers, JSON body shape, and response pointers, or the
exact MCP tool and its published response pointers. A REST operation uses a
relative path; mutating routes must declare their exact JSON body for the
method and path, and linking disconnect additionally requires an
`Idempotency-Key`. An MCP operation uses a declared tool or the `initialize`
method. Worker-bound mappings include the shared permission, history,
attachment, direct-chat, group, webhook, receipt, and removal schemas listed
below. A tool without a canonical response mapping remains unverified and
cannot pass through an arbitrary successful response. Template values use `${target...}`, `${binding...}`,
`${vars...}`, and validated IDs from earlier passing operations as
`${observed...}`. The runner hashes request bodies and stores only bounded
scalar response fields.

The existing Communicator entrypoints used by the plan include:

| Acceptance area | REST entrypoint examples | MCP entrypoint examples |
| --- | --- | --- |
| Permission inspection and requests | `GET /api/v1/grants`, `GET/POST /api/v1/permission-requests` | `list_grants`, `list_permission_requests`, `request_permissions` |
| Stored read and context | `GET /api/v1/identities/{id}/conversations`, `GET /api/v1/conversations/{id}/messages`, `GET /api/v1/search/messages` | `list_messages` |
| Attachment access | `GET /api/v1/attachments/{id}`, `GET /api/v1/attachments/{id}/download` | `get_attachment`, `download_attachment` |
| Text and direct chat | `POST /api/v1/conversations/{id}/messages`, `POST /api/v1/contacts/resolve`, `POST /api/v1/conversations` | `send_text_reply`, `get_text_reply_status`, `resolve_contact`, `create_direct_chat` |
| Groups | `POST /api/v1/groups`, `PATCH /api/v1/groups/{conversation_id}`, `POST/DELETE /api/v1/groups/{conversation_id}/participants` | `create_group`, `rename_group`, `add_group_participants`, `remove_group_participants` |
| Webhooks | `/api/v1/webhook-subscriptions` and `/api/v1/webhook-deliveries/{id}` | `create_webhook_subscription`, `get_webhook_subscription`, `get_webhook_delivery`, `retry_webhook_delivery`, `cutover_webhook_subscription` |
| Receipts and removals | `POST /api/v1/conversations/{id}/receipts/read`, `/api/v1/receipts`, `/api/v1/removals` | `mark_read`, `record_removal`, `get_removal_status`, `get_restore_authority` |
| Linking | Administrator-only `/api/v1/identities/{id}/link-sessions`, `/api/v1/connections/{id}/relink-sessions`, `/api/v1/connections/{id}/disconnect`, grant, and stored-read routes | Agent MCP has no linking authority |

Use the target's OpenAPI document and current MCP tool schemas to fill request
bodies. Do not copy provider credentials, access tokens, message bodies, or
unbounded upstream URLs into the configuration. For sensitive request values,
the evidence contains only a body hash.

For a successful operation, list every typed field that its declared
observation can provide under `evidence.extract` and repeat those fields under
`evidence.required`. A semantic case may collect evidence from several
passing operations. The runner records the union in `coverage.observed_fields`
and checks every named observation before it combines those observations. For
example, the exact disconnect operation response proves its operation ID,
connection ID, and status while a later stored-message read proves the
identity, account, chat, connection, and history message ID for
`disconnect_preserves_history`. Objects, arrays, credentials, message bodies,
and unbounded content are rejected. A missing required field makes the
operation or combined case `unverified`; one arbitrary successful GET cannot
satisfy another case. Later operations may use an earlier passing scalar ID
with `${observed.operation-id.field}`.

For a capability the provider or client cannot support, set the expected
status, `expect.unsupported_statuses`, `expect.unsupported_evidence` pointers,
and `expect.outcome` to `unsupported`. A bare 404, 405, or 501 remains an
unexpected response. Use `unverified` when the target could not be tested or
the available response does not prove the behavior. The harness does not allow
a configuration to label an unexpected response as a pass.

### Separate metadata from authenticated bytes

`attachment_read` requires `scope`, `metadata`, and `bytes` observations.
`scope` binds the account, chat, and message through a stored-message read.
`metadata` returns the same message ID plus attachment ID, MIME type, SHA-256,
size, and short-lived download authority. It does not retrieve bytes.

On the `bytes` request, set `download_from` to the earlier metadata operation
ID. Use its attachment ID in the REST download path or MCP `attachment_id`
argument. The runner injects the transient grant for the same actor and
transport. It never adds the grant to `${observed...}` or the evidence bundle.
Do not put a grant in the configuration, URL path, or extracted fields.

REST byte evidence hashes the actual response body with `raw_sha256` and
counts it with `raw_size`, both using the empty root pointer. MCP byte
evidence decodes `/result/content/0/resource/blob` with `base64_sha256` and
`base64_size`. Record the results as `sha256` and `attachment_size`. Both must
match metadata. Metadata-only success leaves the case `unverified`; changed
bytes produce `implementation_defect`. Reads remain bounded to 8 MiB before
base64 encoding.

The installed SDK represents MCP bytes as an embedded resource with an opaque
`communicator:attachment/{id}` URI. This is not a public download URL. Local
SDK tests do not establish that ChatGPT Work or any Grok client accepts the
representation. Removed, expired, unavailable, oversized, or unsupported
results must remain explicit rather than being counted as retrieved files.

### Keep receiver and restore proof independent

Webhook subscription creation proves an ID and destination version, not a
receiver observation. Each initial subscription case separates `subscription`,
known-ID `delivery`, and `receiver`. Retry separates `retry_result` from
`receiver`; cutover separates `before`, `cutover_result`, and `cancellation`.
`revision_removal` inspects a delivery, never deletes a subscription as a
substitute for proving content removal. Retry is webhook notification retry,
not message or provider resend, and does not reset the retry deadline.

To discover deliveries, request
`GET /api/v1/webhook-subscriptions/{subscription_id}/deliveries` with an optional
`limit` from 1 to 100 and the previous page's opaque `cursor`. The default is
50. The response contains `items` in ascending delivery-ID order and a nullable
`next_cursor`. Items contain delivery metadata, not payloads or receiver response
bodies. The existing subscription authority and `webhook.manage` ceiling apply.
Each subscription has independent pages and selections in System.

A cursor belongs to one tenant, subscription, principal, membership, and removal
epoch. Malformed or wrong-scope cursors return 400. A changed removal epoch returns
409. Refresh by discarding all pages and the cursor, then requesting the first
page again. Refresh also clears the UI's selected delivery. A cursor does not
grant access or freeze delivery status. Selecting a delivery reads its current
details through the existing delivery-by-ID route.

Discovery does not prove receiver processing. The Worker has no receiver-observation
response contract. Keep receiver observations `unverified` and retain separately
captured receiver evidence for review. The automatic retry deadline remains 24
hours after first pending. An explicit authorized manual retry may occur later
without resetting that deadline. It does not resend a provider message.

`explicit_receipt` maps the real operation status and Matrix, bridge, and
provider stages. Stored reads never imply a provider read receipt.
`active_removal` separates recorded `authority` from suppression evidence.
`restore_anti_resurrection` separates REST `restore-projection`, a `retained`
message read, and stale-work `suppression`. MCP has authority inspection but
no restore mutation tool. An authority record or a retained-message read
alone cannot prove absence of every stale controlled copy. Suppression proof
without a canonical response remains `unverified`; physical purge is not
claimed complete.

Authentication failures use the actual HTTP error envelope. MCP local-scope
denials may instead use HTTP 200 with `isError: true` and a structured error
inside text content. Successful tool results cannot satisfy a denial case.
The error envelope alone does not identify the expired/revoked installation
or account mismatch, so those missing fields remain unverified. Use separate
negative-credential runs and retain the authority test provenance. A mocked
authority response is not cryptographic issuer or external-client proof.

## Cover the ticket scenarios

The configuration must include operations for each scenario below. One run
uses one exact client surface. Run Grok separately for every supported web,
mobile, and Bot surface, then review the bundles together.

| Scenario ID | Ticket | Required proof |
| --- | --- | --- |
| `oauth_connection` | #35, #36 | Protected-resource metadata, authorization-server metadata, PKCE S256, and a real MCP initialize plus scoped tool call with the configured resource and installation. |
| `linking_identity_lifecycle` | #35 | Start unlinked, administrator identity verification and grant, same-identity relink with stable IDs, explicit disconnect preserving history, and a different identity with a new account and no inherited grant. |
| `permission_inspection_request` | #35, #36 | Inspect own grants and permission requests. Request administrator review and observe pending status without acquiring a grant. |
| `history_context_attachment` | #35 | Stored history/context and an authenticated attachment read, with account and chat binding and no provider credential in the response. |
| `text_send_and_route` | #35, #36 | Durable saved text, account-owned route, Matrix/bridge/provider stages, and provider evidence. A saved or HTTP-accepted command alone does not prove WhatsApp delivery. |
| `direct_chat_and_group` | #35 | Contact or phone resolution, direct chat creation, group creation, rename, and member changes with the required provider identifiers and grants. |
| `webhook_subscriptions` | #35 | Two independent subscriptions, receiver IDs, current revision, content-free removal, retry age, manual retry, cutover, and revocation behavior. |
| `receipt_and_restore` | #35 | Explicit receipt status/stages plus active removal and separate restore/suppression evidence showing no stale body, file, command, or delivery resurrection. |
| `authorization_negative_matrix` | #35, #36 | Wrong issuer or resource, expired or revoked installation, missing grant, wrong account/chat, and no silent account failover. |
| `grok_surface_read` | #36 | Exact Grok surface authenticates to MCP and reads only its administrator-granted account/chat scope. |
| `grok_surface_send` | #36 | Exact Grok surface submits text, observes saved/dispatch state, and records distinct provider evidence. |
| `grok_bot_identity` | #36 | Signed-in member and OAuth installation are recorded. A shared Bot connection does not gain invented per-Bot ownership. |
| `grok_failure_matrix` | #36 | Duplicate, timeout/uncertainty, reconnect, and provider rejection cases where that surface exposes them. |
| `surface_outcome_record` | #35, #36 | Exact client and provider versions plus an explicit unsupported or unverified result for every surface that cannot complete the contract. |

The linking operations use the administrator credential and the agent
operations use the OAuth installation credential. A client token must never be
used to start, refresh, complete, relink, or disconnect a provider pairing.

## Run and review evidence

Run the configured plan only after the target, sacrificial account, provider
image, grants, and operator approval are ready:

```sh
python3 scripts/client_acceptance.py run \
  --config /protected/communicator/chatgpt-work.json \
  --output /protected/communicator/chatgpt-work.evidence.json
```

The command returns `0` only when every declared scenario has passing observed
operations. It returns `3` for an incomplete run and still writes the bundle.
It returns `2` for an invalid configuration or evidence file. Validate the
written bundle before review:

```sh
python3 scripts/client_acceptance.py validate-evidence \
  --input /protected/communicator/chatgpt-work.evidence.json
```

Reviewers should confirm that:

1. `run.mode` and every operation's `evidence_class` match the proof being
   claimed. Controlled or fixture results do not establish a client pass.
2. Client surface, client version, provider version, adapter version, OAuth
   resource, installation, grant, account, chat, connection, and identity
   bindings are exact and consistent. Provider-account bindings come from a
   separate provider proof source.
3. A provider delivery claim has provider evidence. HTTP status, saved state,
   Matrix state, and bridge state remain separate observations.
4. Scenario `coverage` lists every named case and `relations` prove stable or
   distinct IDs across the cases; operation count alone is not acceptance.
5. Unsupported, unverified, and implementation-defect results retain their
   reason and response hash. They are escalated without widening the product
   promise.
6. The bundle has no access token, secret, raw message body, provider
   credential, or unbounded upstream URL.

Do not publish the bundle or mark #35 or #36 complete from a runbook or a
controlled fixture. Keep the bundle with the operator review record and obtain
separate approval before any live account linking, real message, group change,
receipt, webhook call, deployment, or source publication.
