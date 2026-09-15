# Matrix Gateway SQLite ledger completion plan

> **Execution requirement:** The primary session plans, orchestrates, reviews,
> commits, opens the pull request, and merges. Implementation and test execution
> use ephemeral `codex exec` workers with model `gpt-5.6-luna`, reasoning effort
> `max`, service tier `fast`, and self-contained prompts. Every writer works in
> an isolated task worktree and may edit only its assigned files. Test workers
> use `workspace-write`; static reviewers use `read-only`; reviewers never edit
> or review their own work. Give each worker a 15-minute wall-clock limit. Stop
> and split any task that exceeds the limit. Verify the Git diff after every
> worker wave.

> **For implementation workers:** Use test-driven development. Write the named
> failing tests first, run the focused RED command, implement only the specified
> contract, then run the GREEN command. Do not commit, push, deploy, access the
> network, change the version-1 SQLite schema, or edit files outside the task's
> allowlist.

> **Execution waves:** Task 1 is the shared contract and module-boundary task.
> After Task 1 is accepted and integrated, Tasks 2 and 5 may run in parallel:
> Task 2 owns the live-ledger module and tests, while Task 5 owns the backfill
> module and tests. Tasks 3 and 4 continue sequentially on the Task 2 branch.
> Integrate the completed Task 2-4 branch and Task 5 branch, then run Task 6
> from that combined commit because it extends the shared batch selector. Run
> Task 7 once after Task 6.
> During a task, run only its focused test binary. Run the gateway package gate
> after each integration wave. The repository-wide gate remains part of the
> later Matrix Gateway phase gate, not this repair phase.

**Goal:** Complete the crash-safe SQLite transaction API that the approved
Matrix Gateway plan requires for live ingestion, ingestion delivery, recovery,
retention, and explicit backfill.

**Architecture:** The existing version-1 SQLite schema remains authoritative.
New public DTOs provide a closed, validated boundary. Two child modules of
`store` implement inherent `Store` methods while retaining access to the
private SQLite connection and encryption helpers. Live `/sync` work is an
ordered ledger: raw inbox row, collecting window, exact encrypted outbox rows,
accepted batches, then one atomic checkpoint commit. Explicit backfill uses a
separate job ledger and never moves the live `/sync` token or room anchors.

**Tech stack:** Rust 2024, rusqlite with explicit transactions, chrono,
zeroize-backed protected values, the existing `Keyring`, canonical batch types,
and the existing version-1 SQLite schema.

---

## 1. Position in the approved delivery sequence

This plan repairs an incomplete part of Task 4 in
`docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`.
The schema tables already exist, but the promised live-window, ingestion-outbox,
purge, and backfill transaction methods do not.

Already implemented and reused:

- exclusive store locking and exact version-1 schema validation;
- `WAL`, `synchronous=FULL`, foreign keys, and five-second busy timeout;
- encrypted bootstrap state, raw sync inbox, and ordered token chain;
- durable Matrix crypto outbox and fail-closed SDK reconciliation;
- protected room registry;
- canonical event normalization and deterministic batch construction; and
- authenticated exact-byte ingestion transport.

This phase must finish before the Matrix service loop is implemented. An
in-memory substitute is forbidden because it would acknowledge source progress
without a crash-safe outbox.

## 2. Simple outcome

After this phase, the gateway can safely remember:

1. which raw Matrix response it is processing;
2. the exact encrypted ingestion requests that still need delivery;
3. which requests have been accepted;
4. when the Matrix checkpoint may advance;
5. how an operator retries a quarantined live window; and
6. where a bounded historical backfill can resume after a restart.

A crash at any point causes either an exact retry or no progress. It must never
silently skip a message, send reconstructed bytes, or advance the Matrix token
before all live batches are accepted.

## 3. Locked boundaries and invariants

### 3.1 Source-of-truth boundaries

- Synapse remains the operational messaging record.
- R2 becomes authoritative only after the ingestion Worker returns `202` for
  the exact request bytes.
- This SQLite ledger is protected host-local delivery and recovery state.
- Durable Object SQLite is not involved in this host-side transaction layer.

### 3.2 Live ordering

For each live inbox row the only valid state path is:

```text
sync_inbox.sdk_processed
  -> sync_windows.collecting
  -> sync_windows.pending + encrypted outbox rows
  -> each outbox row accepted
  -> sync_inbox.committed + sync_windows.committed + gateway token advanced
```

The oldest uncommitted inbox row is the only live window allowed to finalize,
deliver, quarantine, retry, or commit. A newer row remains blocked. A live gap
job is part of its linked live window and never owns an outbox row.

### 3.3 Exact-byte and identifier rules

- A stored request is exactly `BuiltBatch::exact_request_bytes()`.
- `batch_row_id` equals the validated canonical request `batch_id`.
- `request_sha256` is 32 raw SHA-256 bytes over the exact request bytes.
- Every retry decrypts and verifies those exact bytes and digest. It never
  rebuilds JSON from typed fields.
- Ordinals are zero-based, contiguous, unique, and match slice order.
- A live finalization rejects mixed checkpoint kinds, tenants, routes,
  duplicate batch IDs, empty request bytes, non-canonical request bytes,
  digest mismatches, or counts outside the frozen bounds.
- Repeating a complete operation with identical immutable bytes may return the
  existing outcome. Reusing an ID with different bytes returns a conflict.
- `window_id` is exactly `window_` followed by 64 lowercase hexadecimal
  characters. Derive it from the keyed digest of the immutable inbox ID rather
  than randomness. `batch_row_id` retains the existing exact `batch_` followed
  by 64 lowercase hexadecimal characters.

### 3.4 Frozen bounds

Reuse existing package constants where present. Add only these ledger bounds to
`ledger.rs`:

```rust
pub const MAX_WINDOW_BATCHES: usize = 10_000;
pub const MAX_WINDOW_ROOM_CANDIDATES: usize = 100_000;
pub const MAX_BACKFILL_PAGE_BATCHES: usize = 10_000;
pub const MAX_BACKFILL_PARAMETERS_BYTES: usize = 64 * 1024;
pub const MAX_BACKFILL_PAGINATION_BYTES: usize = 64 * 1024;
pub const MAX_LEDGER_ID_BYTES: usize = 160;
```

Check row counts and byte lengths before cloning, allocating proportional
buffers, encrypting, or opening a write transaction. Convert integer widths
with checked conversions. Reject overflow.

### 3.5 Encryption contexts

All protected columns use the existing `Keyring`; its AAD prefix already binds
the encryption-format version. Pass these exact `(table, row_id, column)`
contexts to `Keyring::seal` and `Keyring::open`:

```text
(outbox_batches, batch_row_id, request)
(window_room_anchors, window_id + ":" + lowercase_hex(room_lookup), anchor_event)
(window_room_ephemeral, window_id + ":" + lowercase_hex(room_lookup), typing_set)
(backfill_jobs, job_id, parameters)
(backfill_jobs, job_id, pagination)
```

`backfill_jobs.key_version` applies to both protected columns. When a page is
checkpointed under a newer active key, first open the existing parameters and
pagination, then reseal both the parameters and new pagination under the same
active key and update the single key version atomically. Never leave those two
columns encrypted under different versions.

Before any transition that depends on protected content, decrypt it, verify its
AAD, bounds, digest, and typed structure. Any authentication, digest, structure,
or linkage failure returns a fixed corruption code and rolls back.

### 3.6 Logging and error contract

No DTO containing protected bytes implements derived `Debug`. Manual `Debug`
prints only its type and safe counters/state. Errors retain no IDs, SQL, URLs,
tokens, request bodies, or provider data.

Add these fixed codes in `ledger.rs`:

```rust
pub const STORE_LEDGER_INVALID: &str = "store_ledger_invalid";
pub const STORE_LEDGER_TOO_LARGE: &str = "store_ledger_too_large";
pub const STORE_LEDGER_CONFLICT: &str = "store_ledger_conflict";
pub const STORE_LEDGER_NOT_READY: &str = "store_ledger_not_ready";
pub const STORE_LEDGER_CAS_MISMATCH: &str = "store_ledger_cas_mismatch";
pub const STORE_LEDGER_CORRUPT: &str = "store_ledger_corrupt";
pub const STORE_BACKFILL_INVALID: &str = "store_backfill_invalid";
pub const STORE_BACKFILL_CONFLICT: &str = "store_backfill_conflict";
pub const STORE_BACKFILL_NOT_READY: &str = "store_backfill_not_ready";
pub const STORE_BACKFILL_CORRUPT: &str = "store_backfill_corrupt";
```

## 4. Closed public contract

Task 1 must implement these validated types. Constructors validate IDs,
timestamps, non-empty protected data, and bounds; fields remain private.

```rust
pub struct NewLiveWindow {
    window_id: String,
    created_at: DateTime<Utc>,
    ignored_count: u64,
}

pub struct RoomAnchorCandidate {
    room_lookup: Vec<u8>,
    anchor_event: SecretBytes,
}

pub struct RoomEphemeralCandidate {
    room_lookup: Vec<u8>,
    typing_set: SecretBytes,
    typing_expires_at: DateTime<Utc>,
}

pub struct PendingIngestionBatch {
    row_id: String,
    batch: ingestion::PendingBatch,
    attempt_count: u32,
    next_attempt_at: DateTime<Utc>,
}

pub enum FinalizeOutcome {
    Prepared { batch_count: u32 },
    AlreadyPrepared { batch_count: u32 },
}

pub enum LiveCommitOutcome {
    BatchAccepted { accepted_count: u32, batch_count: u32 },
    WindowCommitted,
    AlreadyCommitted,
}

pub struct NewBackfillJob {
    job: batch::BackfillJob,
    parameters: SecretBytes,
    created_at: DateTime<Utc>,
}

pub struct NewLiveGapJob {
    job_id: String,
    live_window_id: String,
    parameters: SecretBytes,
    created_at: DateTime<Utc>,
}

pub struct StoredBackfillJob {
    job: batch::BackfillJob,
    state: BackfillState,
    parameters: SecretBytes,
    pagination: Option<SecretBytes>,
    accepted_events: u64,
}

pub struct StoredLiveGapJob {
    job_id: String,
    live_window_id: String,
    state: BackfillState,
    parameters: SecretBytes,
    accepted_events: u64,
}

pub enum BackfillState { Pending, Running, Completed, Cancelled, Quarantined }

pub enum BackfillCommitOutcome {
    BatchAccepted { accepted_events: u64 },
    JobCompleted { accepted_events: u64 },
    AlreadyCompleted { accepted_events: u64 },
}

pub struct PurgeOutcome {
    inbox_rows: u64,
    windows: u64,
    crypto_rows: u64,
    ingestion_rows: u64,
    live_gap_jobs: u64,
}

pub struct LedgerPressure {
    pending_batches: u64,
    pending_bytes: u64,
    quarantined_windows: u64,
    oldest_pending_at: Option<DateTime<Utc>>,
}
```

Required getters return borrowed values or safe scalars. `PendingIngestionBatch`
exposes `row_id`, `attempt_count`, `next_attempt_at`, and a borrowed
`ingestion::PendingBatch`. `StoredBackfillJob` exposes the job and protected
pagination only through protected wrapper references. `StoredLiveGapJob`
exposes only its opaque IDs, state, protected parameters, and safe count. No
constructor accepts a raw state string.

The completed `Store` surface is:

```rust
pub fn create_collecting_live_window(
    &mut self, inbox_id: &str, window: NewLiveWindow,
) -> Result<(), SafeError>;

pub fn finalize_live_window(
    &mut self,
    inbox_id: &str,
    window_id: &str,
    window: &BatchWindow,
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<FinalizeOutcome, SafeError>;

pub fn complete_live_gap_and_finalize_window(
    &mut self,
    gap_job_id: &str,
    window: &BatchWindow,
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<FinalizeOutcome, SafeError>;

pub fn create_live_gap_job(&mut self, job: NewLiveGapJob)
    -> Result<(), SafeError>;
pub fn begin_or_resume_live_gap_job(&mut self, job_id: &str)
    -> Result<StoredLiveGapJob, SafeError>;

pub fn commit_empty_live_window(
    &mut self,
    inbox_id: &str,
    window_id: &str,
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
    committed_at: DateTime<Utc>,
) -> Result<(), SafeError>;

pub fn next_pending_ingestion_batch(
    &self, now: DateTime<Utc>,
) -> Result<Option<PendingIngestionBatch>, SafeError>;

pub fn record_ingestion_attempt(
    &mut self,
    row_id: &str,
    expected_attempt_count: u32,
    expected_next_attempt_at: DateTime<Utc>,
    attempted_at: DateTime<Utc>,
    next_attempt_at: DateTime<Utc>,
) -> Result<(), SafeError>;

pub fn accept_live_batch_and_maybe_commit_window(
    &mut self, row_id: &str, accepted_at: DateTime<Utc>,
) -> Result<LiveCommitOutcome, SafeError>;

pub fn quarantine_live_batch(
    &mut self, row_id: &str, terminal_code: ReasonCode,
) -> Result<(), SafeError>;

pub fn retry_quarantined_window(
    &mut self, window_id: &str, retry_at: DateTime<Utc>,
) -> Result<(), SafeError>;

pub fn ledger_pressure(&self) -> Result<LedgerPressure, SafeError>;

pub fn purge_committed_prefix(
    &mut self, cutoff: DateTime<Utc>, sdk_token_digest: &[u8],
) -> Result<PurgeOutcome, SafeError>;

pub fn create_backfill_job(&mut self, job: NewBackfillJob)
    -> Result<(), SafeError>;
pub fn begin_or_resume_backfill_job(&mut self, job_id: &str)
    -> Result<StoredBackfillJob, SafeError>;
pub fn checkpoint_backfill_page(
    &mut self,
    job_id: &str,
    pagination: Option<&SecretBytes>,
    window: &BatchWindow,
    accepted_events: u64,
) -> Result<(), SafeError>;
pub fn accept_backfill_batch_and_maybe_complete_job(
    &mut self, row_id: &str, accepted_at: DateTime<Utc>,
) -> Result<BackfillCommitOutcome, SafeError>;
pub fn complete_backfill_job(
    &mut self, job_id: &str, completed_at: DateTime<Utc>,
) -> Result<(), SafeError>;
pub fn cancel_backfill_job(
    &mut self, job_id: &str, cancelled_at: DateTime<Utc>,
) -> Result<(), SafeError>;
```

## 5. Task 1: Add closed ledger types and module boundaries

**Files:**

- Create `services/matrix-gateway/src/ledger.rs`.
- Create empty `services/matrix-gateway/src/store/live_ledger.rs`.
- Create empty `services/matrix-gateway/src/store/backfill_ledger.rs`.
- Modify `services/matrix-gateway/src/lib.rs`.
- Modify `services/matrix-gateway/src/store.rs` only to declare the two private
  child modules.
- Create `services/matrix-gateway/tests/ledger_contract.rs`.

### RED

Write compile-time and runtime tests for every constructor, getter, bound,
timestamp normalization, ID validation, protected `Debug`, and error code.

Run:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test ledger_contract
```

Expected RED: `ledger` and its types do not exist.

### GREEN

Implement the exact types in section 4. Reuse `model` validation rules,
`SecretBytes`, `BackfillJob`, and `ingestion::PendingBatch`. Do not duplicate a
canonical message or ingestion request type. Add manual redacted `Debug`.
Declare `mod live_ledger;` and `mod backfill_ledger;` in `store.rs`; both files
remain empty until their owning tasks.

Run the RED command again, then:

```bash
cargo fmt --all --check
cargo clippy -p communicator-matrix-gateway --all-targets -- -D warnings
git diff --check
```

## 6. Task 2: Implement atomic live-window preparation

**Files:**

- Modify `services/matrix-gateway/src/store/live_ledger.rs`.
- Create `services/matrix-gateway/tests/store_live_prepare.rs`.

Do not modify `store.rs`, `ledger.rs`, schema SQL, batch construction, or crypto
outbox code.

### Required tests

Test all of the following through public `Store` methods, inspecting SQLite only
after calls or after reopening the database:

- only the oldest `sdk_processed` inbox row with `crypto_drained=1` can create
  one collecting window;
- duplicate identical creation is idempotent; changed identity conflicts;
- finalization atomically changes inbox to `prepared`, window to `pending`, and
  inserts every encrypted exact outbox row and staged room candidate;
- stored request bytes, anchors, and typing sets never occur in the database,
  WAL, or SHM plaintext;
- zero batches are rejected by finalization and handled only by the explicit
  empty commit API;
- outbox ordinals and IDs are deterministic and contiguous;
- mixed source, duplicate batch ID, wrong live checkpoint, wrong window,
  oversized counts/bytes, duplicate room candidates, and malformed timestamps
  roll back with no partial rows;
- an exact repeated finalization returns `AlreadyPrepared`; changed bytes or
  candidates return `STORE_LEDGER_CONFLICT`;
- creating a live-gap job requires that exact collecting window, inserts
  `kind='live_gap'`, and is idempotent only for identical protected parameters;
- beginning or resuming a live-gap job returns only its protected closed DTO
  and never inserts a backfill-owned outbox row;
- tampered request ciphertext, nonce, key version, digest, byte count, source
  linkage, count, or window state returns `STORE_LEDGER_CORRUPT` before mutation;
- a simulated transaction error leaves inbox, window, outbox, and staged rows
  unchanged after reopen.

### Transaction order

1. Validate all caller-owned counts and bytes outside the transaction.
2. Begin an immediate transaction.
3. Load and validate the gateway singleton, oldest uncommitted inbox, requested
   inbox, crypto state, and existing window.
4. For idempotency, decrypt and compare every existing immutable row.
5. Seal requests and candidates with distinct AAD owners.
6. Insert all rows.
7. Set exact counts and transition window/inbox using state-qualified updates.
8. Require every expected affected-row count.
9. Commit.

`complete_live_gap_and_finalize_window` requires a running live-gap job linked
to the oldest collecting live window. It validates that the supplied
`BatchWindow` has a live checkpoint for that inbox, inserts only live-window
outbox rows, stages the candidates, marks the gap job completed, and moves the
window and inbox to `pending` and `prepared` in one transaction. It never
creates a backfill-owned outbox row. If the process crashes before this
transaction commits, the runner restarts gap traversal from the durable room
anchor.

Run RED and GREEN with:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test store_live_prepare
```

Then run fmt, package clippy, and `git diff --check`.

## 7. Task 3: Implement delivery scheduling and live commit

**Files:**

- Modify `services/matrix-gateway/src/store/live_ledger.rs`.
- Create `services/matrix-gateway/tests/store_live_delivery.rs`.

### Required behavior

`next_pending_ingestion_batch` selects exactly one eligible row from the oldest
uncommitted live window before any explicit backfill row. Within an owner it
orders by ordinal. It returns nothing when the window is collecting,
quarantined, newer than another uncommitted window, not yet due, or has
undrained crypto. It decrypts and validates exact bytes, digest, canonical
request, batch ID, tenant, linkage, counts, and state before returning.

`record_ingestion_attempt` is a compare-and-swap update. It requires a pending
row, exact expected attempt count and next-attempt timestamp, `attempted_at >=
expected_next_attempt_at`, and `next_attempt_at > attempted_at`. It increments
once and stores the supplied next time. A duplicate/stale worker gets
`STORE_LEDGER_CAS_MISMATCH` and changes nothing.

`accept_live_batch_and_maybe_commit_window`:

1. validates and decrypts the target row and all linked protected rows;
2. marks that pending row accepted exactly once;
3. recomputes accepted count from accepted rows rather than trusting a caller;
4. returns `BatchAccepted` if siblings remain;
5. if all siblings are accepted, verifies oldest-inbox ordering and drained
   crypto, applies staged anchors and typing state, copies the exact inbox next
   token into the committed token, marks inbox and window committed, and returns
   `WindowCommitted`, all in the same transaction;
6. an exact retry after commit returns `AlreadyCommitted`; and
7. never updates the fetch token.

`commit_empty_live_window` applies the same ordering, crypto, anchors,
ephemeral state, and checkpoint rules for a collecting window with no outbox
rows. It commits atomically and is idempotent only for identical staged values.

### Required tests

Cover selection order, due time, exact-byte identity across retries, CAS races,
partial acceptance, final acceptance, empty commit, duplicate `202`, crash
reopen after each boundary, staged anchor/typing visibility only at commit,
committed versus fetch token behavior, and corruption rollback for every
protected column.

Run:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test store_live_delivery
```

Then run both live-ledger tests, fmt, package clippy, and `git diff --check`.

## 8. Task 4: Implement quarantine, retry, pressure, and retention

**Files:**

- Modify `services/matrix-gateway/src/store/live_ledger.rs`.
- Create `services/matrix-gateway/tests/store_live_recovery.rs`.

### Quarantine and retry

- `quarantine_live_batch` accepts only a pending live row and a bounded
  allowlisted `ReasonCode`; it sets the row and owner window to quarantined in
  one transaction, preserves accepted siblings, and never moves a token.
- Repeating the same reason is idempotent. A different reason conflicts.
- `retry_quarantined_window` is the only recovery transition. It requires at
  least one quarantined row, resets only quarantined rows to pending, keeps
  accepted rows accepted, clears terminal codes, sets the supplied due time,
  and returns the window to pending atomically.
- There is no skip, delete, force-accept, force-commit, or tombstone operation.

### Pressure snapshot

`ledger_pressure` uses bounded aggregate SQL and reports only safe counts,
bytes, and the oldest pending time. It includes both live and backfill pending
rows but never decrypts or returns identifiers or payloads.

### Seven-day purge

`purge_committed_prefix(cutoff, sdk_token_digest)` considers only committed
inbox rows with `committed_at < cutoff`. It purges a contiguous oldest prefix,
never the newest committed inbox row, never the row matching the supplied SDK
token digest, and never a row whose window, crypto row, ingestion row, or
linked live-gap job is non-terminal.

Within one transaction it:

1. validates and decrypts every selected inbox, window, crypto, outbox,
   candidate, and linked live-gap row;
2. changes the oldest retained inbox row predecessor to `NULL`;
3. deletes staged anchor and ephemeral rows;
4. deletes accepted live outbox rows;
5. deletes linked terminal live-gap jobs;
6. deletes committed windows and accepted crypto rows;
7. deletes the selected inbox rows; and
8. runs a foreign-key check before commit.

An empty eligible prefix returns zero counts. Any corrupt, non-contiguous, too
new, referenced, or non-terminal candidate stops at that boundary. It must not
skip over the boundary to delete newer rows.

### Required tests

Cover quarantine idempotency/conflict, sibling preservation, retry ordering,
pressure counts/bytes, exact seven-day boundary, newest-row retention, SDK row
retention, contiguous-prefix stopping, linked live-gap cleanup, reopen, foreign
key validity, and rollback on tampered protected state.

Run:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test store_live_recovery
```

Then run all three live-ledger tests, fmt, package clippy, and diff check.

## 9. Task 5: Implement explicit backfill creation and page checkpointing

**Files:**

- Modify `services/matrix-gateway/src/store/backfill_ledger.rs`.
- Create `services/matrix-gateway/tests/store_backfill_prepare.rs`.

Do not modify live-ledger files. This task may run in parallel with Task 2 after
Task 1 is integrated.

### Required behavior

- `create_backfill_job` accepts only a validated explicit `BackfillJob`, seals
  the exact operator parameters, writes `pending`, and is idempotent only for
  identical immutable job fields and bytes.
- `begin_or_resume_backfill_job` atomically changes `pending` to `running`, or
  returns an already-running job after decrypting and validating parameters and
  pagination. Completed, cancelled, quarantined, malformed, and live-gap jobs
  do not begin.
- `checkpoint_backfill_page` accepts only a running explicit job. The supplied
  `BatchWindow` must contain only backfill checkpoints for that same immutable
  job and a contiguous ordinal sequence beginning after existing rows.
- It validates `accepted_events` monotonically against the job limit before any
  allocation or mutation, seals the next pagination token, inserts the exact
  encrypted batch requests, updates accepted event progress and pagination in
  one transaction, and is idempotent for an exact page replay.
- `pagination=None` records an exhausted source but does not declare completion
  while page batches remain pending. Persist exhaustion as the encrypted exact
  sentinel `{"schema_version":1,"state":"exhausted"}`. SQL `NULL` means no
  page checkpoint has been recorded yet; these states remain distinct after a
  crash and reopen.
- `accepted_events` is the cumulative count of accepted source events already
  incorporated into durable pages. Page checkpointing updates it monotonically;
  delivery acknowledgement never recomputes or changes it.
- Because the table has one key version for parameters and pagination, a
  checkpoint under a rotated active key atomically reseals the unchanged
  parameters and the new pagination or sentinel under that same version.
- Backfill rows never reference a live window and never modify `gateway_state`,
  `sync_inbox`, `sync_windows`, `room_progress`, or ephemeral room state.

### Required tests

Cover exact creation/replay/conflict, protected storage, begin/resume, job
identity validation, contiguous ordinals, multi-page checkpoints, pagination
replacement, accepted-event monotonicity/limit/overflow, exact page retry,
mixed source/job rejection, corruption, transaction rollback, and reopen.
Include a rotated-key checkpoint test and a crash/reopen test distinguishing
never-checkpointed SQL `NULL` from the encrypted exhaustion sentinel.

Run:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test store_backfill_prepare
```

Then run fmt, package clippy, and diff check.

## 10. Task 6: Complete backfill delivery and lifecycle

**Files:**

- Modify `services/matrix-gateway/src/store/backfill_ledger.rs`.
- Modify `services/matrix-gateway/src/store/live_ledger.rs` only to extend the
  already-integrated public selection method from live-only to
  live-before-backfill selection.
- Create `services/matrix-gateway/tests/store_backfill_delivery.rs`.

### Required behavior

- When no eligible live batch exists, `next_pending_ingestion_batch` may select
  the oldest running explicit-backfill pending row by job creation time and
  ordinal. Implement the shared selection helper in `backfill_ledger.rs`; make
  the live method call it without duplicating decryption logic.
- The same exact-byte validation and CAS attempt API applies to backfill rows.
- `accept_backfill_batch_and_maybe_complete_job` accepts only an explicit job,
  marks the exact row once, and preserves the durable `accepted_events` source
  count recorded by page checkpoints.
  It never changes a Matrix token, inbox/window, anchor, or typing row.
- It returns `BatchAccepted` while any job batch remains. If pagination is
  exhausted and all durable job rows are accepted, it atomically marks the job
  completed and returns `JobCompleted`. A retry returns `AlreadyCompleted`.
- `complete_backfill_job` succeeds only for a running explicit job with no
  pending/quarantined row and exhausted pagination. It is an idempotent terminal
  transition with the same completion timestamp.
- `cancel_backfill_job` changes pending or running explicit jobs to cancelled,
  retains all job and batch ciphertext for audit/recovery, and is idempotent
  with the same timestamp. It never deletes accepted or pending rows.
- Completed and cancelled jobs cannot resume, checkpoint, accept new rows, or
  change terminal timestamps.

### Required tests

Cover live-before-backfill scheduling, exact backfill retries, partial/final
acceptance, multi-page non-premature completion, explicit completion,
cancellation without deletion, terminal idempotency/conflicts, no live-state
mutation, corruption rollback, and restart recovery.

Run:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target \
  CARGO_BUILD_JOBS=2 cargo test -p communicator-matrix-gateway \
  --test store_backfill_delivery
```

Then run both backfill tests, fmt, package clippy, and diff check.

## 11. Task 7: Integration gate and independent review

**Files:** No source edits in the first pass. A corrective worker receives an
exact allowlist only if review or tests find a concrete defect.

### Package validation worker

Run in `workspace-write` with localhost enabled only if a named test requires
it:

```bash
export CARGO_TARGET_DIR=/home/ubuntu/communicator/.worktrees/matrix-wave1-security-fix/target
export CARGO_BUILD_JOBS=2
cargo fmt --all --check
cargo clippy -p communicator-matrix-gateway --all-targets -- -D warnings
cargo test -p communicator-matrix-gateway --test ledger_contract
cargo test -p communicator-matrix-gateway --test store_live_prepare
cargo test -p communicator-matrix-gateway --test store_live_delivery
cargo test -p communicator-matrix-gateway --test store_live_recovery
cargo test -p communicator-matrix-gateway --test store_backfill_prepare
cargo test -p communicator-matrix-gateway --test store_backfill_delivery
cargo test -p communicator-matrix-gateway
git diff --check
```

Report exact passed, failed, and ignored counts. Do not summarize a truncated
log as success.

### Independent static review

Run a separate read-only Luna worker against the complete diff from the Task 1
base. It must inspect:

- atomicity and state-qualified updates;
- oldest-inbox and live-before-backfill ordering;
- exact-byte retries and deterministic identifiers;
- idempotency versus conflict behavior;
- bounded reads, allocations, integer conversions, and SQL scans;
- ciphertext/AAD/digest verification before transitions;
- crash points and reopen behavior;
- token advancement only after complete live acceptance;
- backfill isolation from live state;
- quarantine recovery and absence of unsafe skip paths;
- seven-day contiguous-prefix retention and foreign keys;
- secret-safe errors, `Debug`, tests, and diagnostics; and
- whether tests prove behavior through public APIs rather than duplicating
  implementation assumptions.

The reviewer returns severity-ordered findings with file and line references,
or `PASS`. It does not edit files.

### Acceptance gate

This repair phase is complete only when:

- all six focused test binaries pass;
- the full matrix-gateway package passes;
- fmt, clippy with denied warnings, and diff check pass;
- the independent reviewer reports `PASS` after any fixes;
- the integration branch contains no uncommitted source change; and
- the later Task 10 service worker can use the public Store API without an
  in-memory ledger or direct SQLite access.

## 12. Explicit non-goals

Do not implement any of the following in this repair phase:

- the long-running `/sync` service loop or systemd process;
- HTTP delivery orchestration beyond the existing ingestion client;
- historical Matrix pagination calls;
- R2, Queue, Durable Object, or Worker changes;
- outbound sending, typing, reactions, or read receipts;
- a schema version bump or migration;
- unsafe force-commit, skip, reset, or delete commands; or
- deployment to the Contabo VPS.

Those remain in the subsequent Matrix Gateway tasks after this ledger is
integrated and proven.
