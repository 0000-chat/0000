# Communicator Matrix Gateway Service Loop Implementation Plan

> **Executor:** Implement this plan with ephemeral `codex exec` workers using
> `gpt-5.6-luna`, maximum reasoning, and the fast service tier. Every worker is
> given a self-contained prompt, works in an isolated Git worktree, follows
> test-driven development, and may touch only its task's file allowlist.
> Test-only workers use workspace-write. Independent reviewers use read-only,
> never edit, and never review their own work. The parent verifies the Git diff
> after every worker wave and owns all integration decisions.

**Goal:** Turn the already-implemented Matrix adapter and encrypted SQLite
ledgers into a crash-safe long-running gateway that moves live Matrix events to
the Cloudflare ingestion endpoint without losing, skipping, duplicating, or
cross-routing tenant data.

**End-to-end outcome:** A real WhatsApp message bridged into Synapse is fetched
from Matrix, durably journaled, processed by the restored Matrix SDK, normalized
under a verified room binding, partitioned into deterministic tenant batches,
accepted by R2 and Queue through the ingestion API, committed locally in source
order, projected into the tenant Durable Object, and delivered to the API/UI
WebSocket. Restarting or terminating the gateway at any durable boundary must
resume the same work safely.

**Architecture:** The service is a deterministic coordinator over four existing
boundaries: `Store`, `MatrixTransport`, `MatrixProcessor`, and `BatchSink`. One
`tick()` performs at most one durable action. SQLite decides what work is next;
memory is never authoritative. The SDK token may be used only for startup
reconciliation and never as the next network `/sync` token. Health is a separate
read-only SQLite observer and never calls Matrix or Cloudflare.

**Technology:** Rust, Tokio, async-trait, matrix-sdk-base, reqwest, rusqlite,
chrono, serde/serde_json, SHA-256, existing encrypted store and canonical batch
modules.

---

## 1. Authority and baseline

Implement from this worktree baseline, not from an older Task 10 branch:

```bash
cd /home/ubuntu/communicator/.worktrees/matrix-live-ingestion
git status --short --branch
git rev-parse HEAD
```

The expected pre-plan code baseline is `41f2e93`. Before starting a writer,
replace that value with the commit containing this plan and verify the writer's
worktree begins at that exact commit.

Authoritative requirements, in descending order:

1. `docs/PROPOSAL.md`
2. `docs/superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md`
3. Task 10 of
   `docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`
4. This detailed execution plan
5. Existing tested public contracts on the baseline

This plan elaborates Task 10. It does not weaken or replace any invariant in
the proposal or design specification.

### Already implemented; reuse rather than duplicate

- Strict configuration and protected secret loading in `config.rs`.
- Matrix bootstrap/restore, bounded raw HTTP transport, saved-sync processing,
  crypto request classification, and restart response rebinding in `matrix.rs`
  and `matrix_http.rs`.
- Canonical normalization and deterministic batch construction in
  `normalize.rs` and `batch.rs`.
- OAuth and idempotent ingestion delivery in `ingestion.rs`.
- Encrypted, authenticated SQLite state including raw inbox, Matrix crypto
  outbox, live windows, backfill/gap jobs, ingestion outbox, pressure reporting,
  retry, checkpoint commit, and seven-day prefix purge in `store.rs` and
  `store/*.rs`.
- Room-to-tenant/identity/connection/route ownership in the protected registry.

Run this baseline gate before editing:

```bash
export CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target
cargo test -p communicator-matrix-gateway --all-targets
cargo clippy -p communicator-matrix-gateway --all-targets -- -D warnings
cargo fmt --all -- --check
git diff --check
```

Expected baseline evidence: 493 passed, zero failed, one ignored privileged
cross-owner integration test; Clippy, formatting, and diff checks pass. If the
counts change because new tests have landed, zero failures and an explained
ignored-test inventory are authoritative.

---

## 2. Frozen invariants and non-goals

### Source and durability invariants

- The application fetch token is the only token used for `/sync` requests.
  Only `Store::append_fetched_sync` advances it.
- The application committed token is the only source-progress checkpoint.
  It advances only when the head inbox row has drained all Matrix crypto work
  and every ingestion batch for its window is accepted.
- Never choose a network position from the SDK token.
- Persist exact raw sync bytes before giving them to the SDK.
- Persist exact SDK crypto request bytes before attempting the request.
- Persist exact crypto response bytes before acknowledging them to the SDK.
- Persist exact ingestion request bytes before attempting R2/Queue delivery.
- A retry sends byte-for-byte the already-persisted request. It never rebuilds
  a request from current state.
- Every restart derives the next action from authenticated SQLite rows.
- Later inbox responses used for missing-key recovery may be processed but may
  never prepare or commit ahead of the blocked head.
- One `tick()` performs zero or one top-level state-machine action. A delivery
  action may contain the existing required ordered writes around one bounded
  network call: persist its attempt/retry timestamp, send exact stored bytes,
  then persist the response or acceptance. Tests inject a crash at every write
  and I/O boundary. No second unrelated action may run in the same tick.

### Isolation and privacy invariants

- Tenant/identity/connection/route authority comes only from the active
  protected room binding, never from Matrix event content.
- Unknown, invited, left, retired, or mismatched rooms never emit a canonical
  event and never create an empty successful window that advances a token.
- No protected Matrix token, access token, OAuth token, event JSON, message
  body, room ID, user ID, request/response body, or secret path may appear in
  logs, errors, Debug/Display output, health output, or admin status output.
- Health and status return bounded codes, counts, timestamps, and opaque local
  row IDs only.

### E2EE invariants

- The crypto lane is globally serialized.
- While any `pending` or `response_received` crypto row exists, do not apply a
  new saved sync and do not enumerate outgoing SDK requests again.
- The sole exception is one restart-rebind enumeration for the existing
  `response_received` row.
- `KeysQuery` is the only automatically delivered SDK crypto request.
- `KeysUpload` sets `crypto_maintenance_required` and halts before checkpoint
  commit; the daemon never sends it.
- Any other outgoing crypto kind is terminal and quarantined.
- No admin command can skip, tombstone, delete, force-accept, or force-advance
  a live window or crypto row.

### Frozen limits

- Missing-key recovery: at most 16 later contiguous responses and ten minutes.
- Pending request rows: 2,000 combined crypto and ingestion rows.
- Protected recovery/inbox bytes: 256 MiB combined.
- Oldest pending age: 24 hours.
- Accepted live prefix retention: seven days.
- Existing canonical event, batch, raw response, and identifier bounds remain
  unchanged.

### Explicit non-goals

- No automatic Matrix login or account creation during daemon startup.
- No public Matrix federation changes.
- No outbound user mutations, typing simulation, read receipts, agent
  automation, or provider account linking in this phase.
- No Task 11 operator-triggered 90-day backfill implementation beyond safely
  delivering already-persisted backfill outbox rows through the common sink.
- No room-key request, `get_missing_sessions`, automatic `KeysUpload`, or
  encryption recovery that changes the approved receive-only policy.
- No R2 Data Catalog, Pipelines, Brain integration, or attachment media upload.
- No production deployment until the phase-wide review and local validation
  gates pass.

---

## 3. File map and ownership

Create:

- `services/matrix-gateway/src/service.rs`
- `services/matrix-gateway/src/health.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs`
- `services/matrix-gateway/tests/healthcheck.rs`

Modify only when the named task authorizes it:

- `services/matrix-gateway/src/lib.rs`
- `services/matrix-gateway/src/main.rs`
- `services/matrix-gateway/src/admin.rs`
- `services/matrix-gateway/src/matrix.rs`
- `services/matrix-gateway/src/store.rs`
- `services/matrix-gateway/tests/binary_behavior.rs`
- `services/matrix-gateway/Cargo.toml`
- `Cargo.lock`

Do not modify normalization, canonical schemas, batch identity, ledger schema,
bridge deployment, Cloudflare Worker, or UI files in this phase. A newly found
need to change one of those boundaries is an architecture finding: stop that
writer and return evidence to the parent.

Writers must never overlap files concurrently. The recommended sequence is one
service writer for Tasks 1–5, a health writer for Task 6 after the service
commit is integrated, and a CLI writer for Task 7 after both are integrated.
`store.rs` may gain only bounded read/query contracts proven necessary by a RED
service or admin test; ledger mutations and schema remain outside this phase.

---

## 4. Production contracts to add

Names may be adjusted only to match Rust conventions or an existing public
type, but the behavior and information boundary are fixed.

### Deterministic runtime seams in `service.rs`

```rust
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub trait JitterSource: Send {
    /// Return a value in 0..=inclusive_max_ms.
    fn sample_ms(&mut self, inclusive_max_ms: u64) -> u64;
}

pub trait Shutdown: Send + Sync {
    fn requested(&self) -> bool;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceAction {
    FetchedSync,
    ReboundCryptoResponse,
    ProcessedInbox,
    PersistedCryptoRequests,
    AttemptedCryptoDelivery,
    CompletedCryptoRequest,
    MarkedCryptoDrained,
    PreparedLiveWindow,
    AttemptedIngestionDelivery,
    AcceptedIngestionBatch,
    CommittedEmptyWindow,
    PurgedCommittedPrefix,
    Wait,
    Shutdown,
}
```

`ServiceAction` is content-free. It must not contain IDs, tokens, URLs, or
payloads. `tick()` returns it so deterministic tests can prove that one call
performs only one durable action.

Use a concrete `GatewayService` owning one exclusive `Store`, one
`MatrixProcessor`, a Matrix transport, one ingestion sink, clock, jitter, and
shutdown signal. Constructor validation must be synchronous and make invalid
retry limits or missing bootstrap state fail closed. Provide:

```rust
impl GatewayService {
    pub async fn reconcile_startup(&mut self) -> Result<(), SafeError>;
    pub async fn tick(&mut self) -> Result<ServiceAction, SafeError>;
    pub async fn run(&mut self) -> Result<(), SafeError>;
}
```

Production construction may use generics or boxed trait objects. Tests must be
able to supply deterministic fakes without network, DNS, wall-clock sleeps, or
environment variables. Do not add public getters for protected bytes merely to
support tests.

### Test construction boundary

Integration tests require safe constructors for opaque inbound values. If
necessary, make these existing constructors public after preserving all current
validation and redacted formatting:

- `FetchedMatrixSync::from_parts`
- `ObservedRoomEvent::new`
- `LimitedTimelineGap::new`
- `ProcessedSync::new`
- `CryptoAckProof::new`

Do not expose byte getters that are currently crate-private. Prefer public
constructors accepting `SecretBytes` over a `cfg(test)` production API. Add
compile-fail assertions or ordinary tests proving the values still do not
implement `Clone`, `Serialize`, `AsRef<[u8]>`, or `Deref`.

### Retry policy

One pure helper computes capped exponential full jitter:

```text
cap = min(max_delay, base_delay * 2^min(attempt_count, exponent_cap))
delay = jitter.sample_ms(cap_in_milliseconds)
next_attempt_at = now + delay
```

Use checked arithmetic and millisecond UTC timestamps. Persist the chosen next
attempt before making the network call via the existing compare-and-swap store
methods. Then persist the exact Matrix response or ingestion acceptance before
returning from that same top-level delivery action. A crash after upstream
acceptance but before the local post-I/O write therefore retries the exact
request and relies on the upstream idempotency key. Do not begin another row or
state-machine branch in that tick.

### Health contract in `health.rs`

Provide a read-only observer that opens SQLite with read-only flags and does
not acquire the daemon's exclusive writer lock, initialize/migrate schema,
write WAL state, read secret files, decrypt protected values, or contact a
network endpoint.

Healthy output is exactly one compact JSON line with these keys and no others:

```json
{"schema_version":1,"status":"healthy","session":"present","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}
```

Blocked output keeps the same shape. Allowed values are:

- `status`: `healthy` or `blocked`
- `session`: `present` or `missing`
- `inbox_state`: `within_limits`, `rows_exceeded`, `bytes_exceeded`,
  `age_exceeded`, or `corrupt`
- `outbox_state`: the same five values
- `maintenance_code`: null or a validated bounded reason code
- `terminal_quarantine`: boolean

Maintenance, a terminal crypto row, a quarantined live window, corrupt
required tables/columns, a missing session, or any exceeded bound is blocked
and exits nonzero. A busy database is blocked with a stable content-free error;
it must not wait indefinitely. Timestamps and byte/count values are validated
before comparison. Do not trust malformed SQLite dynamic types.

---

## 5. Exact service priority and state transitions

After `reconcile_startup`, every `tick()` evaluates the following priority
order and stops after the first selected action.

1. If shutdown is requested, return `Shutdown` without beginning new I/O.
2. If global maintenance or any terminal crypto quarantine is present, return
   a stable blocked error without changing state.
3. Recover one persisted `response_received` crypto row by calling
   `rebind_saved_crypto_response`; on proof, complete exactly that row; on an
   unrecoverable result, quarantine it and set maintenance.
4. Select one eligible pending crypto row. Persist its next attempt timestamp,
   send its exact bytes, and durably record the exact response or classified
   retry/terminal result. Never enumerate or apply another sync in this branch.
5. If the oldest SDK-processed inbox has no unresolved crypto rows, mark its
   crypto set drained.
6. If an oldest unprepared raw inbox exists:
   - reconcile SDK position against the authenticated contiguous inbox chain;
   - apply it normally when the SDK is at its request token;
   - use receive-only recovery when the SDK is already at its next/later
     contiguous token;
   - enumerate outgoing requests once and persist the complete allowed set in
     the same `record_sdk_processing` transition;
   - for `KeysUpload`, set maintenance and stop before preparation;
   - for a forbidden kind, persist terminal quarantine and maintenance;
   - if decryption is still missing, enter/continue the bounded recovery mode
     described below;
   - otherwise retain the processed result in memory only for the current tick
     and make the single durable `record_sdk_processing` transition.
7. If the head processed inbox is crypto-drained and has no prepared window,
   deterministically rebuild its processed observation from the saved raw
   response, resolve only active room bindings, normalize events, build a live
   window from its saved `next_batch`, and persist exactly one of:
   - finalized nonempty live window and its outbox batches;
   - an empty window committed by `commit_empty_live_window` only when all
     source observations were legitimately ignored and no unknown room,
     invitation/leave, undecryptable event, source gap, or quarantine exists;
   - one live-gap job linked to the collecting window;
   - terminal quarantine with a bounded reason.
8. Select the globally oldest eligible ingestion batch, including live and
   already-persisted backfill batches. Persist the chosen next attempt, send
   exact stored bytes through `BatchSink`, and persist the classified result
   before returning. Success calls the appropriate existing live/backfill
   accept-and-maybe-commit method; retryable failure leaves the pre-recorded
   next attempt; terminal failure quarantines the owning source. A delayed
   tenant must not prevent an independently eligible row for
   another tenant from being selected, while siblings within one source window
   retain their deterministic order.
9. If the oldest finalized live window has zero batches, atomically commit it
    through `commit_empty_live_window` under the restrictions above.
10. Purge at most one eligible contiguous committed prefix older than seven
    days, using the reconciled SDK token digest. Preserve the newest committed
    row and every row required to explain the SDK position.
11. If backpressure permits and no older blocked source work exists, fetch one
    `/sync` from the application fetch token and append the exact response.
12. Otherwise return `Wait`. `run()` waits only until the earliest persisted
    retry/sync deadline or a shutdown notification, then calls `tick()` again.

If existing store selectors cannot distinguish a successful network result
from an eligible pending row without a new state, do not invent an in-memory
acceptance flag. Add the smallest authenticated persisted lifecycle state and a
migration only after returning the mismatch to the parent for review. The
preferred implementation is to use existing delivery return types and atomic
store methods without schema changes.

---

## 6. Startup reconciliation

`reconcile_startup()` is mandatory before `tick()` or `run()`.

1. Open and validate the encrypted application store under its exclusive lock.
2. Restore the Matrix SDK store offline using the saved session. Never log in.
3. Read `sdk_token_digest()` once.
4. Call `Store::reconcile_sdk_position` and accept only:
   - SDK at the committed application token;
   - SDK at a token belonging to the authenticated contiguous retained inbox.
5. Reject absent SDK token after bootstrap, unknown token, discontinuous inbox,
   corrupt store, missing session, or conflicting crypto rows with stable
   content-free codes.
6. If a saved crypto response exists, do not enumerate a new request set.
   Schedule restart rebinding as the first tick action.
7. If maintenance is set, restore enough local state to serve health/admin but
   do not make Matrix or Cloudflare calls.
8. Record no synthetic progress. Startup reconciliation is read-only; any
   repair is an explicit later tick/admin action.

Calling `reconcile_startup()` twice must be idempotent and make no network call.

---

## 7. Bounded missing-key recovery

The head inbox row remains the only committable source row.

1. The first processed head observation containing an unable-to-decrypt
   timeline event establishes a recovery frontier from its persisted
   `observed_at`; do not use process-start time.
2. If a pending crypto row exists, finish it before any recovery fetch.
3. If fewer than 16 later contiguous responses have been saved and the elapsed
   window is at most ten minutes, fetch one later response using the current
   application fetch token and append it durably.
4. Apply the later saved response to the SDK to receive naturally delivered
   to-device keys, persisting and draining its allowed KeysQuery work under the
   same global serialization rule.
5. Preserve all later room, receipt, typing, and timeline data in its encrypted
   inbox row. Do not prepare it.
6. After each later SDK application and crypto drain, call
   `recover_saved_sync` for the head.
7. When the head decrypts, prepare and deliver the head, then each later inbox
   in source order using their already-saved bytes.
8. When either bound is exceeded and the head remains undecryptable, quarantine
   the head with `matrix_key_recovery_exhausted`; do not skip or commit it.

The recovery count and age must be reconstructed from persisted inbox rows on
restart. No in-memory counter may determine whether another fetch is allowed.

---

## 8. Graceful shutdown

- Register SIGTERM and SIGINT once in the production runner.
- A signal prevents the next action from starting.
- An already-started bounded HTTP request may finish, and its result must be
  durably recorded before exit when the corresponding store transition is
  available.
- Never cancel between SDK mutation and the matching SQLite transition. Shield
  that critical section, finish it, then exit.
- Waiting is interruptible immediately; tests use a fake signal and no sleep.
- Exit zero after a clean shutdown. Configuration, corruption, maintenance, and
  terminal quarantine remain nonzero with stable codes.

---

## 9. Task-by-task execution

### Task 1 — Freeze deterministic service contracts and test harness

**Writer allowlist:**

- Create `services/matrix-gateway/src/service.rs`
- Create `services/matrix-gateway/tests/service_failure_matrix.rs`
- Modify `services/matrix-gateway/src/lib.rs`
- Modify `services/matrix-gateway/src/matrix.rs` only for safe constructors
- Modify `services/matrix-gateway/src/store.rs` only for bounded authenticated
  selectors/pressure summaries required by a failing test
- Modify `services/matrix-gateway/Cargo.toml` and `Cargo.lock` only to enable
  explicit Tokio `time`, `signal`, and test-time features already used by this
  package

**RED tests:** Build manual clock, deterministic jitter, fake shutdown, fake
Matrix transport, fake processor, fake ingestion sink, and real temporary
encrypted `Store` fixtures. Add tests that initially fail because no service
coordinator exists:

- one tick exposes only one `ServiceAction`;
- startup accepts committed and contiguous-inbox SDK positions;
- startup rejects an unknown SDK position;
- fetched bytes are appended before processor invocation;
- retry timestamp is deterministic and persisted before send;
- all public/debug output remains content-free.

Run:

```bash
export CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target
cargo test -p communicator-matrix-gateway --test service_failure_matrix --no-fail-fast
```

Capture the named failures. Implement only contracts, fixture seams, startup
reconciliation, retry calculation, and enough tick skeleton to turn unrelated
compile failures into the expected behavioral failures. Do not implement the
full happy path yet.

**Commit:** `test: define gateway service failure matrix`

### Task 2 — Implement inbox-first processing and serialized crypto lane

**Writer allowlist:**

- `services/matrix-gateway/src/service.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs`
- `services/matrix-gateway/src/matrix.rs` only if a proof accessor must become
  crate-visible; do not expose protected bytes
- `services/matrix-gateway/src/store.rs` only for a bounded authenticated
  selector that the RED test proves cannot be expressed by existing methods

Add RED tests for every durability boundary:

- crash before raw inbox commit causes no SDK call;
- crash after inbox commit reuses the saved exact bytes;
- crash after SDK crypto-store mutation but before application processing
  record reconciles from the saved response;
- pending KeysQuery is persisted before delivery;
- `response_received` is persisted before SDK acknowledgement;
- crash after response persistence follows both restart branches:
  replacement request ID with matching canonical query digest, and verified
  already-applied device state;
- unresolved crypto blocks later SDK response application and request
  enumeration globally;
- Matrix 429, 5xx, network failure, and response loss leave exact bytes
  retryable with persisted jitter;
- `KeysUpload` is never sent and sets `crypto_maintenance_required`;
- forbidden crypto kind is terminal;
- crypto drain occurs only after the complete persisted set is accepted.

Implement the priority branches 2–6. Preserve the existing store compare-and-
swap expectations. Inject failure hooks only through test fakes at external
call boundaries; do not add production crash flags.

**Focused gate:**

```bash
cargo test -p communicator-matrix-gateway --test service_failure_matrix crypto -- --nocapture
cargo test -p communicator-matrix-gateway --test matrix_adapter
cargo test -p communicator-matrix-gateway --test store_live_recovery
```

**Commit:** `feat: orchestrate crash-safe matrix crypto`

### Task 3 — Implement normalization and source-ordered live preparation

**Writer allowlist:**

- `services/matrix-gateway/src/service.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs`
- `services/matrix-gateway/src/store.rs` only for bounded authenticated
  pressure/selection reads required by a RED test

Add RED tests for:

- one WhatsApp-origin Matrix text message becomes exactly one canonical event;
- duplicate and reordered Matrix events produce deterministic idempotent batch
  identities and no duplicate checkpoint movement;
- two tenants are partitioned into separate batches with verified room-binding
  authority;
- unknown/retired/invited/left room cannot advance the token;
- legitimate unsupported event is counted as ignored;
- empty response commits only when every observation is safely ignorable;
- limited timeline creates one persistent gap job and blocks the live window;
- terminal sibling quarantine prevents the window commit;
- typing replacement and expiry use saved event time/manual clock;
- crash after window preparation reuses stored exact batch bytes.

Production conversion must parse the bounded exact JSON emitted by
`MatrixProcessor` into the existing `normalize::ObservedMatrixEvent` variants,
resolve the active room binding using its keyed lookup, call `normalize`, wrap
successful events as `RoutedEvent`, and call `build_window`. Reject unknown JSON
fields where the existing Matrix/Ruma type does; never trust tenant IDs in event
content. Keep known relation state derived from authenticated room progress and
the current source window only.

**Focused gate:**

```bash
cargo test -p communicator-matrix-gateway --test service_failure_matrix projection -- --nocapture
cargo test -p communicator-matrix-gateway --test normalization
cargo test -p communicator-matrix-gateway --test batching
cargo test -p communicator-matrix-gateway --test room_registry
```

**Commit:** `feat: prepare source-ordered matrix windows`

### Task 4 — Implement delivery, acceptance, purge, and backpressure

**Writer allowlist:**

- `services/matrix-gateway/src/service.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs`
- `services/matrix-gateway/src/store.rs` only for bounded authenticated
  pressure/selection reads required by a RED test

Add RED tests for:

- one-message full success;
- crash after R2/Queue acceptance but before local acceptance resends exact
  bytes and accepts the idempotent duplicate response;
- accepted siblings remain accepted during quarantine retry;
- checkpoint moves only after all siblings are accepted;
- delayed tenant A does not block independently eligible tenant B;
- corrupt live or backfill outbox fails closed;
- pending batch count, combined protected byte, and oldest age backpressure each
  stop fetching without stopping eligible drain work;
- seven-day purge removes only an eligible committed prefix and preserves the
  SDK reconciliation row/newest committed row;
- network/OAuth/401/429/5xx/response-loss classes persist the correct retry or
  terminal result;
- no branch sends reconstructed bytes.

Implement priority branches 8–12. Use `ledger_pressure` plus authenticated
inbox/crypto pressure; if one aggregate is not yet exposed, add a read-only
bounded store summary in `store.rs` only after a RED test proves the missing
contract. Do not change schema for a convenience counter.

**Focused gate:**

```bash
cargo test -p communicator-matrix-gateway --test service_failure_matrix delivery -- --nocapture
cargo test -p communicator-matrix-gateway --test store_live_delivery
cargo test -p communicator-matrix-gateway --test store_backfill_delivery
cargo test -p communicator-matrix-gateway --test ingestion_delivery
```

**Commit:** `feat: deliver and commit matrix windows`

### Task 5 — Implement bounded key recovery and graceful runner

**Writer allowlist:**

- `services/matrix-gateway/src/service.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs`
- `services/matrix-gateway/Cargo.toml` and `Cargo.lock` only for Tokio signal,
  time, or test-util features identified in Task 1

Add RED tests for:

- later key-only and event-bearing syncs unlock the head;
- later durable events remain preserved and later commit in source order;
- the 16-response and ten-minute bounds are inclusive and reconstructed after
  restart;
- exhaustion quarantines rather than commits or skips;
- KeysQuery enumeration/ack remains globally serialized during recovery;
- replacement request ID after restart remains digest-bound;
- shutdown before fetch, while fetching, while processing, during crypto
  delivery, during ingestion delivery, and while idle;
- a started critical transition finishes durably, while the next action does
  not start;
- `run()` uses deterministic deadlines and never busy-spins.

Implement Section 7 and Section 8 exactly. The integration test must complete
under paused Tokio time or a manual sleeper; no wall-clock multi-second waits.

**Focused gate:**

```bash
cargo test -p communicator-matrix-gateway --test service_failure_matrix recovery -- --nocapture
cargo test -p communicator-matrix-gateway --test service_failure_matrix shutdown -- --nocapture
```

Then run the whole service matrix:

```bash
cargo test -p communicator-matrix-gateway --test service_failure_matrix --no-fail-fast
```

**Commit:** `feat: recover and stop matrix gateway safely`

### Task 6 — Add read-only health inspection

Start only after Tasks 1–5 are integrated. This task may run independently of
Task 7 only if Task 7 has not started and no files overlap.

**Writer allowlist:**

- Create `services/matrix-gateway/src/health.rs`
- Create `services/matrix-gateway/tests/healthcheck.rs`
- Modify `services/matrix-gateway/src/lib.rs`
- Modify `services/matrix-gateway/Cargo.toml` and `Cargo.lock` only if an
  already-approved direct dependency is required

RED then GREEN tests must prove exact JSON/key order, healthy state, missing
session, every pressure code, maintenance persistence across reopen, terminal
window/crypto quarantine, corrupt types/schema, busy database timeout, and zero
network/secret-file access. Open the live database concurrently with the
exclusive daemon `Store` in the test to prove the observer is non-mutating and
non-blocking.

Run:

```bash
cargo test -p communicator-matrix-gateway --test healthcheck --no-fail-fast
```

**Commit:** `feat: report local matrix gateway health`

### Task 7 — Wire production binary and offline admin controls

Start only after Tasks 1–6 are integrated.

**Writer allowlist:**

- `services/matrix-gateway/src/main.rs`
- `services/matrix-gateway/src/admin.rs`
- `services/matrix-gateway/src/store.rs` only for bounded authenticated admin
  status selectors; no mutation or schema change
- `services/matrix-gateway/tests/binary_behavior.rs`
- `services/matrix-gateway/tests/service_failure_matrix.rs` only for runner
  construction coverage; do not rewrite state-machine cases
- `services/matrix-gateway/Cargo.toml` and `Cargo.lock` only if Task 1 did not
  already enable the required Tokio signal/time features

Keep existing registry commands compatible. Add exact top-level commands:

```text
communicator-matrix-gateway run --config /absolute/path.json
communicator-matrix-gateway healthcheck --state-db /absolute/path.sqlite3
communicator-matrix-gateway quarantine status --state-db ... --state-key-file ...
communicator-matrix-gateway quarantine retry --window-id window_<64hex> --state-db ... --state-key-file ...
communicator-matrix-gateway crypto status --state-db ... --state-key-file ...
communicator-matrix-gateway crypto verify-clear-maintenance --config /absolute/path.json
```

- Parse bounded arguments without shell interpretation.
- `run` loads config and protected files through existing strict helpers,
  restores the SDK, constructs production transports/sink/service, reconciles,
  installs signals, and runs.
- `healthcheck` invokes only `health.rs`, prints exactly one JSON line, and uses
  success/nonzero status as specified.
- Status commands acquire the existing exclusive store lock, emit one compact
  bounded JSON document, and never print decrypted fields.
- Retry calls `retry_quarantined_window` at a validated current timestamp and
  preserves accepted siblings.
- Verified clear requires daemon exclusion, restores SDK offline, enumerates
  current requests, and clears maintenance only when there is no KeysUpload,
  forbidden request, unresolved request, or quarantined crypto row. It never
  sends, retries, skips, acknowledges, or deletes anything.
- Preserve exit 64/74/78-style stable behavior already tested by the binary.

RED then GREEN binary tests cover all valid commands, malformed/duplicate
options, relative paths, oversized input, lock conflict, output write failure,
maintenance refusal, and absence of protected values in stdout/stderr.

Run:

```bash
cargo test -p communicator-matrix-gateway --test binary_behavior --no-fail-fast
cargo test -p communicator-matrix-gateway --test healthcheck --no-fail-fast
cargo test -p communicator-matrix-gateway --test service_failure_matrix --no-fail-fast
```

**Commit:** `feat: run and administer matrix gateway daemon`

### Task 8 — Documentation and deployment contract

This task begins only after the code contracts are stable. It is a separate
writer and may touch documentation/deployment files only. Derive exact paths
and commands from the final binary; do not invent flags.

Required outcomes:

- systemd or Compose launches `run --config ...` with existing protected-file
  mounts and restart policy;
- local healthcheck uses the new command;
- runbook covers bounded status, quarantine retry, verified crypto maintenance
  clear, SIGTERM behavior, recovery exhaustion, and rollback;
- no secrets enter images, Compose interpolation, Git, logs, or process
  arguments;
- deployment is not activated until local review is complete.

The parent must create a separate detailed deployment task after reviewing the
final CLI. Do not guess deployment edits during Tasks 1–7.

---

## 10. Failure-matrix acceptance inventory

The final `service_failure_matrix` test names must make every item searchable.
At minimum, prove:

1. one-message success;
2. crash before raw inbox commit;
3. crash after inbox commit before SDK processing;
4. crash after SDK crypto-store commit before application record;
5. crash after SDK processing before window preparation;
6. crash after crypto response record before SDK acknowledgement;
7. crash after SDK acknowledgement before local completion, rebound branch;
8. same crash, already-applied branch;
9. crash after window preparation;
10. crash after ingestion acceptance before local acceptance;
11. unknown SDK token;
12. corrupt inbox;
13. two tenants with one delayed;
14. terminal sibling quarantine;
15. duplicate/reordered events;
16. legitimate empty window;
17. unsafe empty window refusal;
18. Matrix network outage;
19. OAuth outage;
20. ingestion 401 refresh;
21. Matrix/ingestion 429;
22. Matrix/ingestion 5xx;
23. response loss;
24. missing-key recovery with later saved syncs;
25. recovery response-count bound;
26. recovery age bound;
27. replacement KeysQuery SDK request ID;
28. global KeysQuery serialization during recovery;
29. limited-timeline source gap;
30. corrupt live and backfill outboxes;
31. pending-row backpressure;
32. combined-byte backpressure;
33. pending-age backpressure;
34. graceful shutdown before/while fetch;
35. graceful shutdown while processing;
36. graceful shutdown while crypto delivery;
37. graceful shutdown while ingestion delivery;
38. graceful shutdown while idle;
39. seven-day committed-prefix purge;
40. typing replacement/expiry;
41. healthy, pressured, maintenance, quarantine, corrupt health transitions;
42. admin retry preserves accepted siblings and exact bytes;
43. verified maintenance clear refuses every unsafe state.

No single broad happy-path test substitutes for a named crash boundary.

---

## 11. Independent review gates

After Tasks 1–7, commit all writer changes, verify the combined diff, then run
two reviewers in parallel because their scopes are independent:

### Reviewer A — State-machine correctness (read-only)

Review the design spec, Task 10, this plan, and the complete diff. Trace every
failure-matrix item and every source/crypto/ingestion transition. Report only
actionable High/Medium findings with exact file/line evidence, or `PASS`.

### Reviewer B — Security/privacy/operations (read-only)

Review secret handling, exact-byte retries, tenant authority, read-only health,
admin powers, shutdown, bounds, logs/errors, and dependency changes. Report
only actionable High/Medium findings with exact file/line evidence, or `PASS`.

Reviewers may not modify files and may not be the writers. A timeout, partial
analysis, or absence of findings without an explicit verdict is not PASS.

Every accepted finding receives a fresh isolated fix worktree, a focused RED
regression, a minimal fix, focused GREEN evidence, a commit, cherry-pick into
the integration branch, and re-review by a different read-only worker.

---

## 12. Final local validation gate

Use the shared target directory and run once after all reviews are closed:

```bash
export CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target

cargo test -p communicator-matrix-gateway --all-targets --no-fail-fast
cargo clippy -p communicator-matrix-gateway --all-targets -- -D warnings
cargo fmt --all -- --check
git diff --check
git status --short --branch
```

Additionally scan the phase diff:

```bash
git diff --check <phase-base>..HEAD
git diff --name-only <phase-base>..HEAD
rg -n 'TODO|FIXME|todo!\(|unimplemented!\(|panic!\(|placeholder|not implemented' \
  services/matrix-gateway/src/service.rs \
  services/matrix-gateway/src/health.rs \
  services/matrix-gateway/tests/service_failure_matrix.rs \
  services/matrix-gateway/tests/healthcheck.rs
```

Every match must be absent or explicitly justified as a test assertion against
legacy behavior. Confirm no files outside the phase allowlists changed.

---

## 13. PR, merge, deploy, and live proof

Only after Section 12 passes:

1. Rebase or merge current `origin/main` into the integration branch without
   dropping user changes.
2. Rerun Section 12 on the exact PR head.
3. Push `codex/matrix-live-ingestion` and open one PR describing the durability
   model, failure matrix, security review, and test totals.
4. Wait for required GitHub checks. Fix failures through reviewed commits.
5. Merge only when the diff and checks match the reviewed head.
6. Produce and review the exact deployment delta from Task 8.
7. Deploy to the Contabo pilot with a reversible release and no secret output.
8. Prove locally on the server: daemon healthy, Synapse healthy, no maintenance,
   no terminal quarantine, and restart persistence.
9. Prove live end to end with a newly sent WhatsApp message and opaque evidence
   at each hop: Matrix event ID digest, raw-inbox row ID, batch ID, R2 archive
   key, Queue/ingestion acceptance ID, tenant projection sequence, API result,
   and WebSocket update. Do not print message content or credentials.
10. Prove idempotency by replaying the same Matrix event and observing no new
    tenant event or sequence advance.
11. Prove isolation by confirming the other identity cannot query or subscribe
    to the message.

This phase is complete only when the merged commit is deployed and those live
proofs pass. Local tests alone do not establish the end-to-end outcome.
