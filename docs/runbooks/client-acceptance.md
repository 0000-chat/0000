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
  chat, connection, provider-account, and identity IDs. Empty arrays are
  valid only before the corresponding administrator step. A passing operation
  must extract the IDs it claims to prove.
- `oauth.access_token_env` or `oauth.access_token_file` points to a protected
  access token source. The token never belongs in the JSON configuration.
  Administrator-only operations may use a separate
  `admin_access_token_env` or `admin_access_token_file`.

The operator must obtain the token through the documented OAuth authorization
code flow. The runner can create the authorization URL and exchange the
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
statuses, and typed evidence fields. The case contract also checks the REST
method and stable route words or the MCP tool. A REST operation uses a
relative path. An MCP operation uses a declared tool or the `initialize`
method. Template values use `${target...}`, `${binding...}`, `${vars...}`, and
validated IDs from earlier passing operations as `${observed...}`. The runner
hashes request bodies and stores only bounded scalar response fields.

The existing Communicator entrypoints used by the plan include:

| Acceptance area | REST entrypoint examples | MCP entrypoint examples |
| --- | --- | --- |
| Stored read and context | `GET /api/v1/identities/{id}/conversations`, `GET /api/v1/conversations/{id}/messages`, `GET /api/v1/search/messages` | `list_identities`, `list_conversations`, `list_messages`, `search_messages` |
| Attachment access | `GET /api/v1/attachments/{id}`, `GET /api/v1/attachments/{id}/download` | Use the documented attachment read tool when the target exposes it |
| Text and direct chat | `POST /api/v1/conversations/{id}/messages`, `POST /api/v1/contacts/resolve`, `POST /api/v1/conversations` | `send_text_reply`, `resolve_contact`, `create_direct_chat` |
| Groups | `POST /api/v1/groups`, `PATCH /api/v1/groups/{conversation_id}`, `POST/DELETE /api/v1/groups/{conversation_id}/participants` | `create_group`, `rename_group`, `add_group_participants`, `remove_group_participants` |
| Webhooks | `/api/v1/webhook-subscriptions` and `/api/v1/webhook-deliveries/{id}` | `create_webhook_subscription`, `update_webhook_subscription`, `cutover_webhook_subscription`, `retry_webhook_delivery` |
| Receipts and removals | `POST /api/v1/conversations/{id}/receipts/read`, `/api/v1/receipts`, `/api/v1/removals` | `mark_read`, `get_read_receipt`, `record_removal`, `get_removal_status` |
| Linking | Administrator-only `/api/v1/identities/{id}/link-sessions`, `/api/v1/link-sessions/{id}`, grant, connection, and stored-read routes | Agent MCP has no linking authority |

Use the target's OpenAPI document and current MCP tool schemas to fill request
bodies. Do not copy provider credentials, access tokens, message bodies, or
unbounded upstream URLs into the configuration. For sensitive request values,
the evidence contains only a body hash.

For a successful operation, list every typed field that its declared
observation can provide under `evidence.extract` and repeat those fields under
`evidence.required`. A semantic case may collect evidence from several
passing operations. The runner records the union in `coverage.observed_fields`
and checks the complete case contract only after it has combined those
observations. For example, a link-session response can prove identity,
account, connection, and lifecycle status while a later stored-message read
proves the chat and history message ID for
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

## Cover the ticket scenarios

The configuration must include operations for each scenario below. One run
uses one exact client surface. Run Grok separately for every supported web,
mobile, and Bot surface, then review the bundles together.

| Scenario ID | Ticket | Required proof |
| --- | --- | --- |
| `oauth_connection` | #35, #36 | Protected-resource metadata, authorization-server metadata, PKCE S256, and a real MCP initialize plus scoped tool call with the configured resource and installation. |
| `linking_identity_lifecycle` | #35 | Start unlinked, administrator identity verification and grant, same-identity relink with stable IDs, explicit disconnect preserving history, and a different identity with a new account and no inherited grant. |
| `history_context_attachment` | #35 | Stored history/context and an authenticated attachment read, with account and chat binding and no provider credential in the response. |
| `text_send_and_route` | #35, #36 | Durable saved text, account-owned route, Matrix/bridge/provider stages, and provider evidence. A saved or HTTP-accepted command alone does not prove WhatsApp delivery. |
| `direct_chat_and_group` | #35 | Contact or phone resolution, direct chat creation, group creation, rename, and member changes with the required provider identifiers and grants. |
| `webhook_subscriptions` | #35 | Two independent subscriptions, receiver IDs, current revision, content-free removal, retry age, manual retry, cutover, and revocation behavior. |
| `receipt_and_restore` | #35 | Explicit receipt result class plus active removal and restore evidence showing no stale body, file, command, or delivery resurrection. |
| `authorization_negative_matrix` | #35, #36 | Wrong resource, expired or revoked installation, missing grant, wrong account/chat, and no silent account failover. |
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
   resource, installation, grant, account, chat, connection, and provider
   account bindings are exact and consistent.
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
