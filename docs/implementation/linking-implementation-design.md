# T24 / #14 WhatsApp linking implementation design

Status: read-only preparation, 2026-09-13. No source files, phone/account,
secret, deployment, or issue tracker were changed. This design uses the
approved aggregate at `/tmp/communicator-implementation/aggregate/0000-communicator`
and its [pinned bridge contract](https://github.com/0000-chat/0000-communicator/blob/main/docs/implementation/pinned-whatsapp-linking-contract.md).
Implementation remains gated on the #12 merge and T24's stated dependencies.

## Placement decisions

Use the approved data-plane split:

```text
administrator browser
  -> authenticated control-plane Worker
  -> LinkSessionDO (state/expiry/owner guard)
  -> private Connection Gateway
  -> mautrix-whatsapp provisioning API
  -> bridge-owned WhatsApp session
```

The Worker owns product authorization, attempt state, duplicate detection, and
the D1 directory transaction. The private gateway owns bridge routing, the
bridge shared secret, bridge process/transaction IDs, and ephemeral challenge
bytes. A new account is created only after a complete provider result has been
verified. Account grants remain T01 authority.

This follows the approved Cloudflare design: the D1 Control Directory is
authoritative for non-secret tenant/identity/connection metadata, a short-lived
`LinkSessionDO` binds principal, tenant, target identity, provider, expiry, and
action, and QR/challenge data is excluded from DO storage, logs, traces, R2,
and evidence ([data-plane design, lifecycle and secret rules](https://github.com/0000-chat/0000-communicator/blob/main/docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md#connection-and-link-session-lifecycle)).

The current `services/matrix-gateway` is an ingestion/Matrix daemon with CLI
entrypoints only (`src/main.rs` dispatches `run`, `healthcheck`, and registry
commands). It is not a private HTTP provisioning gateway. `compose.yaml` also
contains `whatsapp` on the internal `core` network but no Connection Gateway or
Matrix Gateway service. T24 should therefore add a private Connection Gateway
surface (a companion service or separately exposed gateway binary), while
leaving #9's Matrix ingestion path unchanged. Reuse the existing gateway's
bounded HTTP/client and secret patterns in
`services/matrix-gateway/src/matrix_http.rs`, `src/ingestion.rs`,
`src/secret.rs`, and `src/config.rs`; do not route provisioning through
`src/service.rs` or the public Caddy listener.

## Existing seams and proposed files

| Concern | Current seam | T24 preparation |
| --- | --- | --- |
| Worker entry/auth | `apps/control-plane/worker/app.ts`, `worker/auth/middleware.ts` | Register link routes behind product auth, then require owner/admin role, `connection.manage` on the target identity, and a human/operator principal. Explicitly reject agent/service principals. |
| Directory | `apps/control-plane/migrations/0001_control_directory.sql`, `0002_ingestion_routing.sql`, `worker/control-directory/repository.ts` | Add a focused linking repository and a migration for privacy-safe provider identity keys. Reuse `audit_events`, `directory_mutations`, `connections`, `connection_routes`, and `connection_accounts`; no grant insert. |
| Attempt state | `wrangler.jsonc` currently binds only `TenantProjectionDO` | Add `LinkSessionDO` and its versioned storage migration. Keep only non-secret state and an opaque gateway reference. Do not use the tenant projection DO or R2. |
| Public contract | `packages/contracts/src/index.ts`, `src/connection.ts` | Add `src/linking.ts` schemas for states, actions, redacted status, and ephemeral display; export it from the package. Keep provider-specific process/step/transaction IDs out of the schema. |
| Worker routes | `worker/routes/read.ts`, `worker/read/*` are read-only today | Add a separate `worker/linking/{routes,handlers,authorization,repository,gateway-client}.ts`; do not broaden read handlers. Suggested routes are below. |
| Admin UI | `src/features/connections/{connections-page,connection-card}.tsx`, route `src/routes/connections.tsx` | Replace simulation-only buttons with an administrator-only link-session dialog. Add API/query seams in `src/lib/api/client.ts` and `query-keys.ts`; preserve explicit identity selection and show the target identity through the whole flow. |
| Deterministic UI | `src/mocks/{handlers,store}.ts`, `connections-page.test.tsx` | Add a fake provider lifecycle with QR, rotation, expiry, cancellation, provider error, duplicate, and success fixtures. Do not persist QR in localStorage or test artifacts. |
| Private gateway | No callable HTTP implementation exists; `services/matrix-gateway/src/main.rs` is CLI/daemon only | Create the private gateway HTTP/adapter seam and tests. Its WhatsApp adapter is the only component that knows the pinned mautrix routes, shared secret, and bridge process IDs. |

## Provider-neutral contract

The public API should match the approved account-linking endpoints:

```http
POST   /api/v1/identities/{identity_id}/link-sessions
GET    /api/v1/link-sessions/{link_session_id}
POST   /api/v1/link-sessions/{link_session_id}/actions
DELETE /api/v1/link-sessions/{link_session_id}
```

Every mutation requires `Idempotency-Key`. The start body is limited to
`provider: "whatsapp"`, an allowlisted `method: "qr"`, and an explicit
confirmation of the target identity. The server takes tenant and actor from
the authenticated session; a caller-supplied tenant, owner, Matrix user, or
bridge route is never authority.

Suggested internal shapes (names are implementation guidance, not a frozen
public schema):

```ts
type LinkSession = {
  id: string;
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  target_identity_id: string;
  provider: "whatsapp";
  generation: number;
  status:
    | "created" | "awaiting_user" | "authenticating" | "connected"
    | "expired" | "failed" | "cancelled" | "relink_required"
    | "reconciliation_required";
  expires_at: string;
  action: "scan_qr" | "enter_phone" | "enter_code" | "wait" | "none";
  action_expires_at: string | null;
  error_code?: string;
};

interface LinkProvider {
  start(input: StartLink): Promise<ProviderChallenge>;
  continue(input: ContinueLink): Promise<ProviderChallenge | ProviderIdentity>;
  cancel(input: CancelLink): Promise<void>;
}
```

`ProviderChallenge` may contain an ephemeral QR/code in the response path, but
the DO persistence function must strip it. `ProviderIdentity` must contain a
stable provider identity, a privacy-safe label, and non-secret route metadata;
it must not contain a bridge credential or reusable session token. A future
device-code/OAuth provider can implement the same `start/continue/cancel`
port without changing the product endpoints.

The action endpoint accepts only `poll` (for a current display-and-wait step)
or a provider-specific allowlisted user input such as an international phone
number. The browser never submits mautrix step IDs, transaction IDs, cookies,
passwords, or a bridge process ID. WhatsApp T24 should expose QR first; phone
pairing can remain a provider capability until separately accepted.

## Attempt state and lifecycle

`LinkSessionDO` stores this immutable owner tuple on creation:

```text
(session_id, tenant_id, actor_principal_id, membership_id,
 target_identity_id, provider)
```

It also stores `generation`, status, server-created expiry, action metadata,
selected bridge instance, bounded redacted error code, timestamps, and an
opaque gateway reference. It does not store QR data, pairing codes, provider
credentials, raw bridge process IDs, Matrix tokens, or phone numbers. The
gateway may retain process/transaction IDs only in its own short-lived,
server-side session store; a restart makes the session unavailable and must
produce a visible retry state.

Each action rechecks the full owner tuple, current membership/role/scope, and
the expected generation inside the DO's serialized transition. A mismatched
tenant, actor, identity, provider, or generation returns a safe conflict and
does not call the provider. Refresh/cancel/expiry invalidates the old
generation before any gateway cleanup call. A late provider result must match
the session ID, full owner tuple, current generation, and non-terminal state;
otherwise it is ignored and recorded only as `stale_callback` metadata.

Recommended lifecycle:

1. `POST link-sessions` checks `owner|admin` membership, `connection.manage`
   for the selected identity, and a human/operator principal. The UI's
   confirmation names the provider and target identity. The DO writes
   generation 1, then the gateway starts a QR process.
2. The gateway returns a provider-neutral `scan_qr` action. The Worker returns
   the QR only to the authenticated administrator response. The payload is
   never put in D1, DO SQLite, audit metadata, logs, analytics, or an agent
   response.
3. `POST actions {action:"poll", generation:1}` maps to the bridge's
   `display_and_wait` step. The Worker/DO returns the current QR, the next QR,
   a terminal completion, or a redacted error. It never forwards raw provider
   errors as diagnostics.
4. A refresh atomically invalidates generation 1, asks the gateway to cancel
   it, increments to generation 2, and starts a new process. No old callback
   can activate the new session. If cancellation fails, the old process stays
   cleanup-pending but is still unauthorized locally.
5. The DO alarm expires the product session and invalidates its generation;
   cleanup is retried through the gateway. The product expiry is configured
   below the bridge's generic 30-minute process timeout; it must not depend on
   that timeout. QR rotation/timeout is mapped to `expired` or retryable
   `failed` according to the provider result.
6. `DELETE link-sessions/{id}` performs the same generation invalidation and
   sends bridge cancel. It is idempotent for an already terminal session.
7. On completion the gateway verifies the stable identity, then the Worker
   performs duplicate detection and the D1 directory transaction below. A
   successful bridge login with a failed D1 write becomes
   `reconciliation_required`; retrying by starting a second QR is unsafe.

## Pinned WhatsApp adapter mapping

The research contract verifies these source-level routes for mautrix-go
`v0.30.0` and mautrix-whatsapp `v0.2608.0`:

| Provider operation | Exact bridge operation |
| --- | --- |
| Capability/start method | `GET /_matrix/provision/v3/login/flows`; pinned connector advertises `qr` and `phone`. |
| Start QR | `POST /_matrix/provision/v3/login/start/qr`; response has process `login_id`, QR `display_and_wait`, step ID, and transaction ID. |
| Poll/rotate QR | `POST /_matrix/provision/v3/login/step/{process_id}/fi.mau.whatsapp.login.qr/display_and_wait?txn_id={txn_id}` with no body. There is no bridge-native poll/refresh endpoint. |
| Cancel | `POST /_matrix/provision/v3/login/cancel/{process_id}`. |
| Completion evidence | Parse `complete.user_login_id`; optionally verify it appears in `GET /_matrix/provision/v3/logins` for the same bridge Matrix user before the Worker commits. |
| Phone fallback (if enabled) | Start `phone`, then `POST /.../login/step/{process_id}/fi.mau.whatsapp.login.phone/user_input?txn_id=...` with an allowlisted `phone_number`; never accept this raw field from an agent. |

The adapter maintains the process/step/transaction mapping privately and maps
bridge responses to `scan_qr`, `wait`, `connected`, `failed`, or `expired`.
The QR cadence in the pinned connector is one minute followed by five
twenty-second intervals; after the final QR it cancels with
`FI.MAU.WHATSAPP.LOGIN_TIMEOUT`. The generic mautrix process has a 30-minute
context timeout. These are provider facts, not product expiry policy.

Sources: [mautrix-go provisioning routes](https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L110-L179), [login-step behavior](https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioninglogin.go#L72-L200), [provisioning schema](https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.yaml#L768-L812), and [pinned WhatsApp login connector](https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1180-L1214).

## Backend-only auth and transport

The bridge must be enabled only for the trusted gateway with a random shared
secret of at least 16 characters and `allow_matrix_auth: false`. The gateway
sends `Authorization: Bearer <shared-secret>` and the target bridge Matrix
`user_id` query parameter. The bridge then requires that user's `Login`
permission. The shared secret belongs in the gateway's protected secret file;
it must never enter `LinkSessionDO`, D1, the browser, API/MCP responses, logs,
or a test fixture.

The current renderer hardcodes `provisioning.shared_secret: disable` and
`allow_matrix_auth: false` at
`scripts/render-whatsapp-config.py:50-54`, and current validation reports
`whatsapp_provisioning=DISABLED`. The bridge supports enabling the API with a
non-disabled secret according to the pinned mautrix-go auth code, but the
renderer currently has no secret-file input. Treat enabling it as a separate
controlled configuration seam; do not claim that the checked-in deployment
can link until that seam and private route are implemented and verified.

Cloudflare-to-gateway calls need a dedicated service identity, authenticated
transport, bounded timeout, request ID, and idempotency key. The gateway must
authorize every request against the supplied session ID, tenant, identity,
provider, generation, and selected bridge instance. A private network location
alone is insufficient. The public Caddy configuration must not proxy either
the bridge provisioning base path or the gateway admin path.

## Identity verification and directory commit

The pinned WhatsApp connector creates `UserLogin` from
`waid.MakeUserLoginID(PairSuccess.ID)`. The source maps the default-server JID
user (phone account key) to `user_login_id`; whatsmeow also reports a LID and
device ID. Use the returned `user_login_id`/phone JID as identity evidence, and
treat LID/device metadata as supporting evidence only. Do not infer identity
from the QR, display name, or a browser-supplied value.

Before account creation, normalize the provider identity in the gateway, have
the Worker derive a keyed digest such as
`HMAC-SHA-256(provider + "\\0" + normalized_user_login_id)`, and compare it
within the authenticated tenant. A new D1 table such as
`connection_provider_identities` should make
`(tenant_id, provider, identity_key)` unique and preserve the connection
ownership tuple. Keep the raw phone/JID out of the control directory unless a
later approved privacy decision requires it; `connection_accounts.account_id`
remains a Communicator account ID, not a provider phone number.

If the key already exists on any active or historical connection, finish the
link session as `relink_required` and do not insert a connection, route,
account, grant, or logout. Relink/disconnect is T25. A new identity commits in
one D1 batch, after validating the gateway route, in this order:

```text
connections (status = syncing or connected)
connection_routes (immutable tenant/identity/provider route)
connection_accounts (new Communicator account ID)
connection_provider_identities (unique HMAC key)
audit_events + control_event_outbox
```

Use the existing foreign keys/triggers in migrations `0001` and `0002` to
prevent tenant/identity/provider reassignment. The batch must not insert
`identity_grants`; T01 remains the only grant authority. If the provider
identity, route, or owner tuple cannot be proven, commit no partial account and
return a redacted `identity_mismatch` or `reconciliation_required` status.

## Human and agent boundaries

The UI must require an explicit confirmation after showing the selected tenant,
target identity, provider risk, expected QR flow, and expiry. The target
identity is repeated while scanning. The link session is owned by the actor
who started it; a different administrator cannot guess or take it over through
the public ID. A future controlled recovery path may be added separately.

No MCP tool or agent OAuth operation calls these routes. Even if an agent or
service principal has a broad grant, the link guard rejects its principal type
and requires a human/operator administrator plus `connection.manage`. Linking
does not create an OAuth installation or expand an agent grant. The QR is
returned only by the administrator UI route and is never included in agent
calls, message records, or activity diagnostics.

## Minimum deterministic verification

Worker/DO tests should use a fake `ConnectionGateway` and a controllable clock:

- owner/admin with `connection.manage` can start; member without it, wrong
  identity, agent/service principal, revoked membership, wrong tenant, and
  wrong actor are denied before provider I/O;
- start idempotency returns one session; current owner tuple and generation are
  checked on every poll, refresh, and cancel;
- fake QR is returned to the admin response but is absent from DO storage,
  D1/audit/outbox rows, serialized errors, logs, and API/MCP agent fixtures;
- QR rotation, configured expiry, provider timeout, provider 4xx/5xx, cancel,
  refresh, duplicate poll, and gateway restart produce deterministic terminal
  or retryable states;
- refresh/expiry/cancel invalidates the old generation; a late completion,
  wrong process handle, or wrong tenant/identity cannot create or reactivate a
  connection;
- completion with identity A creates one connection/account/route and no
  grant; the same provider identity returns `relink_required`; identity B
  creates a separate ungranted account; a D1 failure after bridge success
  enters reconciliation without starting a second provider login;
- the fake provider contract asserts the exact QR start, display-and-wait,
  cancel paths, query encoding, bearer header isolation, and no browser-visible
  bridge IDs.

Gateway tests should use a bounded fake HTTP server (the existing Rust
Wiremock pattern) to assert exact JSON/path/status mapping, redaction, bounded
body sizes, timeout classification, and private-secret handling. UI tests in
`connections-page.test.tsx` should cover confirmation, QR display/expiry,
refresh/cancel, provider failure/retry, `relink_required`, and identity
switching; use MSW only with deterministic non-secret QR fixtures. A pinned
adapter fixture test proves the route contract, but it is not live-account
proof.

## Verified facts, unknowns, and recovery triggers

Verified from the aggregate and primary sources:

- `deploy/images.lock.env:4` pins
  `dock.mau.dev/mautrix/whatsapp:v26.08@sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002`;
  the release maps `v26.08` to tag `v0.2608.0`, but the OCI config has no
  source label, so digest-to-Git-commit equivalence is not cryptographically
  proven;
- the exact bridgev2 QR/start/step/cancel routes and auth mechanism above are
  source-backed for the pinned dependency versions;
- `PostLoginStep` and `PostLoginCancel` do not repeat an authenticated owner
  check, so Communicator's owner/tenant/generation guard is mandatory;
- the current renderer disables provisioning and the current UI is simulation
  only;
- current D1 schemas have immutable connection ownership triggers and an
  append-only account/route history, but no provider identity key or link
  session storage.

Remain unverified until the bounded capability experiment is explicitly
approved and run against a sacrificial account:

- whether the pinned image digest's running code exactly equals the Git tag;
- actual `flows -> start/qr -> display_and_wait` responses and QR timeout;
- complete `user_login_id` versus `GET /logins` identity agreement;
- duplicate/same-account/different-account relink behavior and logout effects;
- private gateway reachability, route-to-Matrix-user mapping, and enabled
  provisioning configuration.

Recovery must stop and preserve redacted evidence when any of these occurs:

| Trigger | Safe evidence and action |
| --- | --- |
| `provisioning_disabled`, 401, or 403 | Record provider/status/error code, bridge pin, session/generation, and config-validation marker; do not retry QR or expose the secret. Enable only through the protected configuration procedure. |
| Gateway route/health/timeout or process handle lost | Mark `provider_unavailable` or `reconciliation_required`; retain no QR/process credential; require a fresh generation or operator cleanup. |
| Owner/tenant/identity/generation mismatch | Return conflict, record `stale_callback` with internal session/generation only, and never call the bridge or mutate D1. |
| Complete identity absent, malformed, or disagrees with scoped `GET /logins` | Mark `identity_mismatch`; create no account or route. Preserve only redacted response classification. |
| Duplicate provider identity | Mark `relink_required`; do not auto-logout, overwrite, transfer history, or grant an agent. Escalate to T25. |
| Bridge success followed by D1 failure | Mark `reconciliation_required`; do not start another login. Reconcile the same gateway session or perform explicit operator cleanup. |

This design is ready for a post-#12 implementation pass, but T24 cannot claim
the pinned real adapter or live identity semantics until the private gateway,
secure provisioning configuration, and sacrificial-account experiment exist.
