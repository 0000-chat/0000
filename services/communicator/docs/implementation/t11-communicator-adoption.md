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

- Communicator `./scripts/check`: 385 files, exit 0.
  `/tmp/platform-t11-rust-composition-service-check.log`.
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
classifications in `/tmp/platform-t11-rust-composition-lifecycle-final.log`; its
SHA256 is `fb7aa0d51060135ac8817eda34edd9d6fc6d4fe6672142b988c3daa1a2541d10`.
It
does not contain credential values, OAuth callback values, or claim bodies. The
runner exits nonzero if either exact Cargo test is absent, times out, or does
not produce every expected status; assertion counts are derived from observed
stage output rather than hardcoded into a failed run.

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
`/tmp/platform-t11-rust-composition-lifecycle-final.log`: the runner exited 0, with two
assertions in the pre-revocation stage and six in the revocation/replacement
stage. It recorded ingestion `Accepted`, claim `Allowed`, Platform revoke
HTTP 200, direct revoked claim HTTP 401, old ingestion `Paused` with
`ingestion_unauthorized`, old Rust claim `Uncertain`, and replacement ingestion
`Accepted`/claim `Allowed`. The runner's safe log contains statuses and counts
only; issued metadata and fixture state were removed by the runner's bounded
default cleanup and are not repository files.

The hardened runner was also exercised against bounded failure paths. These
checks use isolated temporary state and leave only the safe logs listed below:

- `T11_STARTUP_TIMEOUT_MS=1500 T11_PLATFORM_PORT=36089 node
  scripts/platform-rust-composition/run.mjs` exited 1 after the startup
  deadline; no Rust stage ran, the owned Platform group stopped, and state was
  removed (`/tmp/platform-t11-rust-composition-startup-failure.log`, SHA256
  `fa52580cd9332e36376fde90cbd855fd1bb9514dde743678a4406043be7455a2`).
- An adversarial `cargo` wrapper that spawned a 60-second child was run with
  `T11_STAGE_TIMEOUT_MS=30000`. The `before` stage reported
  `timedOut:true`, cleanup verified every group stopped, and the descendant
  PID was no longer alive (`/tmp/platform-t11-rust-composition-stage-timeout.log`,
  SHA256 `5c52250c81eebe9689787e45a81be58a0ad6434aac42b59d9792ef4f4ecd8c3f`).
- The same hanging stage was interrupted with `SIGINT`; the runner exited 1,
  stopped the detached descendant group, and retained state only because
  `T11_KEEP_STATE=1` was requested
  (`/tmp/platform-t11-rust-composition-interrupted.log`, SHA256
  `8a255c94e7d516393d03434a05eb1adbb65f86bb641b52df1ccd1f165534c090`).
- A post-patch startup interruption produced `interruptedBy:"SIGINT"` in the
  runner's JSON summary, stopped every group already started, and removed its
  state (`/tmp/platform-t11-rust-composition-interrupted-summary.log`, SHA256
  `63c34ea45f26123ecce6d7e012cbd8de87035c53296143defaa4be2f54eec677`).
- A wrapper that caused both exact Cargo filters to match zero tests exited 1
  with `ran:false`, null observations, and null assertion counts while all
  started groups stopped and state was removed
  (`/tmp/platform-t11-rust-composition-zero-test.log`, SHA256
  `3d7e6ef48ed87b5f40e673e6fce62a3cf9429358f026fb303efdee5a33a6b139`).
- `node --test scripts/platform-rust-composition/health.test.mjs` passed its
  one regression: a response that sends headers and stalls its body is aborted
  by the five-second health request deadline (the test uses a 100 ms bound).
- `node --test scripts/platform-rust-composition/runner.test.mjs` passed both
  lifecycle regressions: a missing background `pnpm` produced a bounded
  `spawn pnpm ENOENT` result with all owned groups stopped, and an issuance
  child that exited 0 after TERM was rejected because its stage was timed out.
  The test ran two cases in 36.3 seconds.
- The corresponding safe manual logs are
  `/tmp/platform-t11-rust-composition-missing-pnpm.log` (SHA256
  `f60c1a94ae44e67a49a82d1bdf2cdd8fdb02fbe542add31c5d4e432528a0a263`) and
  `/tmp/platform-t11-rust-composition-setup-timeout-exit0.log` (SHA256
  `acd9d18b966f4d54fe95ebe56ca8b5052a85ae75d761552848db1ca8b58f9939`).
- The post-fix happy-path run above exited 0 with `interruptedBy:null`,
  `allStopped:true`, and `stateRemoved:true` (`/tmp/platform-t11-rust-composition-lifecycle-final.log`,
  SHA256 `fb7aa0d51060135ac8817eda34edd9d6fc6d4fe6672142b988c3daa1a2541d10`).

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
