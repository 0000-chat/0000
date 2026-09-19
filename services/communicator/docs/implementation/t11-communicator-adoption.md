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
inbound gateway-secret production paths are unavailable.

The browser OAuth path uses the shared SDK and the local atomic transaction
store. Redirect cookies are host-only, Secure, HttpOnly, and SameSite=Lax.
Background 401/503 responses preserve the mounted workspace and composer;
changed binding or identity context pauses adoption until the user reviews it.
Realtime live and replay delivery recheck current authority, lease expiry, and
account/chat ACLs, including rebuild reset paths.

The source checkpoint includes the parent T12 Platform dependency and the
Communicator formatter cleanup. No Platform or shared SDK production file was
edited in this worker.

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

A fresh local Platform Worker was started from the current Platform source, and
a fresh Communicator Worker/D1 state was started from the current Communicator
source. The Platform service principal, grant, and two finite credentials were
created through the production account endpoints:

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

The completed checked-in runner recorded safe metadata and result
classifications in `/tmp/platform-t11-rust-composition-final.log`; it does not
contain credential values, OAuth callback values, or claim bodies. The earlier
temporary-hook logs remain available as historical evidence, but the acceptance
run described here is the checked-in runner execution.

The complete reproducible fixture runner is checked in at
`services/communicator/scripts/platform-rust-composition/run.mjs`. Its bridge,
issuer, revoker, D1 seed template, and three ingestion batches are all in that
directory. It starts a fresh Platform Worker from the current
`services/platform/src`, uses the simulated GitHub responses only to establish
the Platform account session, calls the public issuance routes above, seeds
only the local Communicator binding/resource rows, runs both ignored Rust
stages, asserts the direct revoked-claim HTTP 401, and stops/removes its local
processes and state by default:

```sh
cd /home/ubuntu/0000-full/worktrees/platform-communicator-adoption/services/communicator
CARGO_TARGET_DIR=/home/ubuntu/cargo-target-t11 \
  node scripts/platform-rust-composition/run.mjs
```

The checked-in Rust test is an ignored integration test behind the explicit
`loopback-test` Cargo feature; that feature only exposes the loopback
constructors used by the fixture, while production constructors continue to
require HTTPS. A completed default-cleanup runner log is
`/tmp/platform-t11-rust-composition-final.log`: the runner exited 0, with two
assertions in the pre-revocation stage and six in the revocation/replacement
stage. It recorded ingestion `Accepted`, claim `Allowed`, Platform revoke
HTTP 200, direct revoked claim HTTP 401, old ingestion `Paused` with
`ingestion_unauthorized`, old Rust claim `Uncertain`, and replacement ingestion
`Accepted`/claim `Allowed`. The runner's safe log contains statuses and counts
only; issued metadata and fixture state were removed by the runner's bounded
default cleanup and are not repository files.

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
