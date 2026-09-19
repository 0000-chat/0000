# T11 Communicator adoption evidence

This report records the Communicator slice of the T11 adoption work. It is an
implementation and verification record; it does not claim a deployment or a
live external provider integration.

## Implemented boundary

Communicator now uses the shared Platform client for human, agent, and service
credential verification. Local `platform_bindings` remain the immutable
association between the Platform tuple and the local tenant, principal,
membership, and identity. Resource and operation grants are checked after
Platform authentication. Service ingestion requires `ingestion.write`, a
service principal, an active local binding, and the exact gateway, connection,
and account route. Provider dispatch claims require `outbound.claim` and the
same local route and account authorization checks. The retired local issuer and
inbound gateway-secret production paths are unavailable when Platform is
configured.

The browser OAuth path uses the shared SDK and the local atomic transaction
store. Redirect cookies are host-only, Secure, HttpOnly, and SameSite=Lax.
Background 401/503 responses preserve the mounted workspace and composer;
changed binding or identity context pauses adoption until the user reviews it.
Realtime live and replay delivery recheck current authority, lease expiry, and
account/chat ACLs, including rebuild reset paths.

The source checkpoint is commit `4b92c03d6929f3ca3af5d14b19c3729ec71c4f45`.
It includes the parent T12 Platform dependency and the Communicator formatter
cleanup. The worktree was clean after the checks below. No Platform or shared
SDK production file was edited in this worker.

## Checks

The following checks passed on the current source or its unchanged affected
baseline:

- Communicator `./scripts/check`: 374 files, exit 0; log
  `/tmp/platform-parent-t11-service-check-fixed.log`.
- Communicator Worker: 84 files and 903 tests, exit 0; log
  `/tmp/platform-parent-t11-worker-fixed.log`.
- UI: 129 tests, exit 0.
- Contracts: typecheck and 140 tests, exit 0.
- Python bridge suite: 192 tests, exit 0.
- Rust source formatting: `cargo fmt --all --check`, exit 0.

The selected Durable Object case also passed with one test and eight skips. It
uses the real TenantProjectionDO and D1 projection, while its authority HTTP
server is an explicitly simulated Hono fixture; that case is kept separate
from the actual Platform authority evidence.

## Issued Rust caller proof

A fresh local Platform Worker was started from the current Platform source at
`http://127.0.0.1:36089`, and a fresh Communicator Worker/D1 state was started
at `http://127.0.0.1:18794`. The Platform service principal, grant, and two
finite credentials were created through the production account endpoints:

- `POST /api/account/service-principals`
- `POST /api/account/service-principals/grants`
- two `POST /api/account/service-principals/credentials` calls

The Communicator D1 fixture contains only the local tenant/binding, route,
connection/account, capability, and outbound acceptance rows. It does not
insert a `platform_credential`; the service credentials used below came from
the Platform issuance path. The simulated GitHub provider was used only to
establish the local Platform account session needed by those account endpoints.

The matrix gateway Rust callers used the same HTTP send code as production with
the explicit loopback test constructors. Production constructors still
require HTTPS. Results:

- `IngestionClient` with the first issued credential returned `Accepted`.
- `AuthorityClaimClient` with the first issued credential returned `Allowed`.
- The first credential was revoked through
  `POST /api/account/service-principals/credentials/revoke`.
- The old ingestion caller returned `Paused` with
  `ingestion_unauthorized`; the old authority caller returned
  `AuthorityClaimFailure::Uncertain` after the 401 boundary.
- The replacement issued credential returned `Accepted` for ingestion and
  `Allowed` for the outbound claim.

Evidence logs (metadata and result classifications only; no credential values)
are:

- `/tmp/platform-t11-issue-service.log`
- `/tmp/platform-t11-revoke-issued-service.log`
- `/tmp/platform-t11-rust-issued-ingestion-before-revocation.log`
- `/tmp/platform-t11-rust-issued-claim-before-revocation.log`
- `/tmp/platform-t11-rust-issued-ingestion-after-revocation.log`
- `/tmp/platform-t11-rust-issued-claim-after-revocation.log`

The corresponding direct Worker status check recorded HTTP 401 for both old
credential routes in `/tmp/platform-t11-rust-old-credential-http-status.log`;
the Rust clients above preserve their own bounded failure classifications.

The reproducible caller harness is checked in at
`services/communicator/services/matrix-gateway/tests/t11_issued_live_http.rs`.
It is an ignored integration test behind the explicit `loopback-test` Cargo
feature; that feature only exposes the loopback constructors used by the
fixture, while the production constructors continue to require HTTPS. Its two
tests preserve the exact positive and post-revocation/replacement sequences
above without printing credential values. The no-run builds for the default
and `loopback-test` configurations both completed successfully.

With the isolated fixtures running, the reproducible commands are:

```sh
cd /home/ubuntu/0000-full/worktrees/platform-communicator-adoption/services/communicator

# Run before the revoke command; this exercises the first issued credential.
CARGO_TARGET_DIR=/home/ubuntu/cargo-target-t11 \
T11_ISSUED_SERVICE_PATH=/tmp/platform-t11-issued-service.json \
T11_RUST_WORKER_BASE_URL=http://127.0.0.1:18794 \
T11_RUST_BATCH_ONE=/tmp/platform-t11-rust-ingestion-1.json \
T11_RUST_BATCH_TWO=/tmp/platform-t11-rust-ingestion-2.json \
T11_RUST_BATCH_THREE=/tmp/platform-t11-rust-ingestion-3.json \
cargo test -p communicator-matrix-gateway --features loopback-test \
  --test t11_issued_live_http issued_platform_credential_reaches_live_ingestion_and_claim \
  -- --ignored --nocapture

# Revoke the first credential through Platform, then run the recovery case.
bun /tmp/platform-t11-revoke-issued-service.mjs
CARGO_TARGET_DIR=/home/ubuntu/cargo-target-t11 \
T11_ISSUED_SERVICE_PATH=/tmp/platform-t11-issued-service.json \
T11_RUST_WORKER_BASE_URL=http://127.0.0.1:18794 \
T11_RUST_BATCH_ONE=/tmp/platform-t11-rust-ingestion-1.json \
T11_RUST_BATCH_TWO=/tmp/platform-t11-rust-ingestion-2.json \
T11_RUST_BATCH_THREE=/tmp/platform-t11-rust-ingestion-3.json \
cargo test -p communicator-matrix-gateway --features loopback-test \
  --test t11_issued_live_http revoked_credential_pauses_and_replacement_credential_recovers_both_callers \
  -- --ignored --nocapture
```

The Platform fixture is started by `/tmp/platform-t11-rust-platform-bridge.mjs`
from the current Platform source, and the Communicator fixture is the local
Wrangler Worker at port `18794` with `/tmp/platform-t11-rust-communicator-issued-seed.sql`
and `/tmp/platform-t11-rust-communicator-issued-more.sql`. The issuance helper
`/tmp/platform-t11-issue-service.mjs` uses the simulated GitHub provider only
to establish a Platform account session, then calls the three production
service-principal/grant/credential endpoint families listed above. The local
Communicator seed creates the binding and resource ACL rows, but never inserts
a Platform credential. Temporary hooks used for the original run were removed;
the checked-in harness and these setup/revoke commands preserve that caller
boundary. Issued metadata, fixture processes, and state directories remain
outside the repository and are local test state only.

## Browser and realtime evidence boundary

The earlier bounded Chromium run exercised the actual Platform social callback,
Platform OAuth selection/consent/token exchange, Communicator login/callback,
protected session reads, revocation 401, matching reauthentication, controlled
503 recovery, changed-context pause, draft preservation, and logout. Its local
Communicator account/binding/ACL and Durable Object rows were SQL fixtures; the
human Platform credential itself was issued through the real Platform OAuth
path. The temporary event log is `/tmp/platform-t11-actual-communicator-browser-v5.log`.

A separate browser/realtime composition worker owns the reproducible checked-in
Chromium harness and the actual Platform-backed websocket revocation and local
ACL proof. The Hono-authority DO test above must not be substituted for that
composition gate.

No claim is made here for live external provider traffic, external OAuth
acceptance issues, production deployment, or publication.
