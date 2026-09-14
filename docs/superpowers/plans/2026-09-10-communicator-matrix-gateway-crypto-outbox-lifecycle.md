# Communicator Matrix Gateway Crypto-Outbox Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development`. The orchestrator dispatches implementation, testing, and review through fresh ephemeral `codex exec` sessions using `gpt-5.6-luna`, maximum reasoning effort, and fast service tier. Do not create native subagents. Check off each step as it is completed.

**Goal:** Make an encrypted `/keys/query` outbox row safely selectable, retry-schedulable, response-bearing, accepted, or terminally quarantined without performing a Matrix network call or claiming an SDK acknowledgement that has not happened.

**Architecture:** Extend the closed crypto DTOs and the verified SQLite row codec introduced by commit `893727a`. The store leases a due pending request by durably recording its next retry point before a caller may send it, encrypts an exact bounded response before a caller applies it to the Matrix SDK, records acceptance only after the caller reports SDK acknowledgement, and supports a terminal no-skip quarantine. Every transition authenticates the complete linked inbox chain and the selected crypto row in one `IMMEDIATE` transaction. Restart rebind orchestration, Matrix HTTP, maintenance clearing, and `mark_crypto_drained` remain later child tasks.

**Tech Stack:** Rust stable 1.93.1, `rusqlite` 0.37, `serde_json`, SHA-256, existing XChaCha20-Poly1305 `Keyring`, `SecretBytes`, `ReasonCode`, `SafeError`, and schema version 1.

---

## Status and authority

This is the next executable child plan for Task 4 of
`docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`.
The parent plan and
`docs/superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md`
remain authoritative.

The branch must begin at or after:

```text
893727a feat: record encrypted matrix crypto requests
```

Do not change `SCHEMA_SQL`, `GATEWAY_SCHEMA_VERSION`, the Matrix SDK adapter,
HTTP transport, service loop, Cloudflare ingestion, maintenance state, room
registry, sync-window tables, backfill tables, or purge behavior in this task.

This child task does **not** prove an SDK acknowledgement. It only supplies the
store transition that Task 9 may call after the pinned SDK has acknowledged the
exact response. It does not implement restart rebind or the verified-device-key
fallback.

## File map

```text
services/matrix-gateway/src/crypto_outbox.rs
    Closed PendingMatrixRequest and RawMatrixResponse DTOs.

services/matrix-gateway/src/store.rs
    Complete verified crypto-row codec and exact lifecycle transactions.

services/matrix-gateway/tests/crypto_outbox_lifecycle.rs
    Selection, leasing, response, acceptance, quarantine, corruption, and privacy tests.
```

No other source file changes are authorized.

## Frozen public API

Add:

```rust
pub const MAX_MATRIX_CRYPTO_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

pub struct PendingMatrixRequest {
    // all fields private
}

impl PendingMatrixRequest {
    pub fn row_id(&self) -> &str;
    pub fn request_kind(&self) -> &'static str;
    pub fn sdk_request_id(&self) -> &SecretBytes;
    pub fn request(&self) -> &SecretBytes;
    pub fn request_sha256(&self) -> &[u8; 32];
    pub fn attempt_count(&self) -> u32;
    pub fn next_attempt_at(&self) -> DateTime<Utc>;
}

pub struct RawMatrixResponse {
    // exact bytes and digest private
}

impl RawMatrixResponse {
    pub fn keys_query(exact_body: Vec<u8>) -> Result<Self, SafeError>;
    pub fn sha256(&self) -> &[u8; 32];
}

impl Store {
    pub fn next_pending_crypto_request(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<PendingMatrixRequest>, SafeError>;

    pub fn record_attempt(
        &mut self,
        row: &str,
        expected_attempt_count: u32,
        expected_next_attempt_at: DateTime<Utc>,
        now: DateTime<Utc>,
        next: DateTime<Utc>,
    ) -> Result<(), SafeError>;

    pub fn record_crypto_response(
        &mut self,
        row: &str,
        response: &RawMatrixResponse,
    ) -> Result<(), SafeError>;

    pub fn complete_crypto_request(
        &mut self,
        row: &str,
        accepted_at: DateTime<Utc>,
    ) -> Result<(), SafeError>;

    pub fn quarantine_crypto_request(
        &mut self,
        row: &str,
        code: ReasonCode,
    ) -> Result<(), SafeError>;
}
```

`record_attempt` recognizes only a syntactically valid `crypto_` row ID in this
child task. A later ingestion-outbox child plan extends the same domain method
to `batch_` IDs. Any other row shape returns `STORE_CRYPTO_INVALID` without a
database read. The expected count and timestamp are a compare-and-swap token
taken verbatim from the selected `PendingMatrixRequest`.

## Closed DTO contracts

### PendingMatrixRequest

`PendingMatrixRequest` is constructed only by `Store`; it has no public
constructor. It is not `Clone`, `Copy`, `Serialize`, `Deserialize`, `Deref`, or
`AsRef`. Its `Debug` and `Display` are exactly:

```text
PendingMatrixRequest([REDACTED])
```

The row ID is opaque operational metadata and may be returned only through
`row_id`. The request kind is always the static string `keys_query`. Secret
getters return `&SecretBytes`, never a `String` or copied vector. The DTO owns
the decrypted values and zeroizes them on drop through `SecretBytes`.

`attempt_count` must fit `u32`; persisted negative or larger values are corrupt.
The schema and codec may retain the stricter internal ceiling already present,
but the public conversion must still be checked.

### RawMatrixResponse

`RawMatrixResponse::keys_query` accepts the exact HTTP response body only after
the transport/adapter has established that it is a successful typed Ruma
`/keys/query` response. The store DTO independently requires:

1. nonempty bytes;
2. at most `MAX_MATRIX_CRYPTO_RESPONSE_BYTES`;
3. valid UTF-8;
4. exactly one syntactically valid JSON value with no non-whitespace trailing
   bytes;
5. a top-level JSON object.

Do not canonicalize or rewrite a response. Legal whitespace and key order are
preserved byte-for-byte. Map empty, invalid UTF-8, malformed/trailing JSON, or a
non-object to `STORE_CRYPTO_INVALID`; map an oversized body to
`STORE_CRYPTO_TOO_LARGE`.

The DTO is not `Clone`, `Copy`, `Serialize`, `Deserialize`, `Deref`, or `AsRef`.
Its `Debug` and `Display` are exactly `RawMatrixResponse([REDACTED])`. Expose
only a crate-private `body(&self) -> &SecretBytes` getter and the public digest
getter. Revalidate the DTO defensively inside `record_crypto_response`.

## Stable error mapping

Reuse the existing crypto store errors without adding new codes:

| Condition | Error |
|---|---|
| malformed row ID, timestamp, DTO, or impossible caller input | `STORE_CRYPTO_INVALID` |
| request/response input above a frozen bound | `STORE_CRYPTO_TOO_LARGE` |
| bootstrap/maintenance/lifecycle/order prevents the requested operation | `STORE_CRYPTO_NOT_READY` |
| one verified unresolved row blocks creation/processing of a newer request | `STORE_CRYPTO_UNRESOLVED` |
| retry supplies a different timestamp/body/code than the winning transition | `STORE_CRYPTO_CONFLICT` |
| SQLite, ciphertext, digest, identity, lifecycle, parent, or cardinality is corrupt | `STORE_CRYPTO_CORRUPT` |

Errors remain code-only. Never retain or format a row ID, SDK request ID,
request/response body, digest, timestamp, SQLite message, raw cause, key,
ciphertext, nonce, or URL.

Every store operation in this plan uses the same fail-closed precedence after
validating its caller-owned inputs: authenticate bootstrap and the full inbox
chain; load unresolved rows with `LIMIT 2`; fully decode, decrypt, and validate
both rows and their parents; return `STORE_CRYPTO_CORRUPT` for any malformed row
or two verified unresolved rows; then apply the maintenance gate; then apply
the operation-specific lifecycle/due/idempotency rule. Maintenance or an
expected wrong state must never mask persisted corruption or invalid
cardinality. Exact retries additionally load and verify the addressed terminal
row when it is no longer part of the unresolved query.

## Exact response encryption

Seal the exact response with an independent random nonce. `Keyring::seal`
constructs the canonical AAD by length-framing the exact UTF-8 table, row, and
field strings in that order under its existing AAD version; do not introduce a
second AAD encoder:

| Table | Row ID | Field |
|---|---|---|
| `matrix_crypto_outbox` | exact `crypto_row_id` | exact field string `response` |

Write exactly `response_cipher`, `response_nonce`, `response_key_version`, and
`response_sha256`; schema version 1 has no response timestamp or response byte
count. Store raw SHA-256 of the exact response in `response_sha256`. The request
and response ciphertexts must never share a nonce.

Before allocation, a stored response codec accepts only:

- `response_cipher` as a BLOB of `17..=(64 * 1024 * 1024 + 16)` bytes (one or
  more plaintext bytes plus the existing 16-byte AEAD tag);
- `response_nonce` as a BLOB of exactly 24 bytes;
- `response_key_version` as a SQLite INTEGER in `1..=u32::MAX`;
- `response_sha256` as a BLOB of exactly 32 bytes.

All four columns must be NULL or all four present. Any wrong SQLite type,
length, integer range, or partial set is `STORE_CRYPTO_CORRUPT`. After bounded
allocation, authenticate the exact AAD, require plaintext length
`1..=MAX_MATRIX_CRYPTO_RESPONSE_BYTES`, recompute SHA-256, and re-parse the
bounded JSON object before the row may influence a transition.

## Complete verified lifecycle

Replace the pending-only verified codec with one closed verified codec covering
exactly these states:

| State | Response fields | `accepted_at` | `terminal_code` | Additional rule |
|---|---|---|---|---|
| `pending` | all NULL | NULL | NULL | request verified; attempts `0..=1_000_000` |
| `response_received` | all present and verified | NULL | NULL | attempts at least 1 |
| `accepted` | all present and verified | valid UTC-ms | NULL | attempts at least 1 |
| `quarantined` | either all response fields NULL or all present and verified | NULL | valid `ReasonCode` | no skip/retry transition in this phase |

For every state, verify request kind, request ciphertext, SDK request ID,
request digest, request lookup, deterministic row ID, byte count, timestamps,
and linked inbox. `next_attempt_at` remains a valid UTC-millisecond timestamp in
all states. Partial response columns are always corrupt.

Parent invariants:

- `pending` and `response_received` belong to an `sdk_processed` inbox with
  `crypto_drained=0` and `sdk_processed_at=observed_at`;
- `accepted` belongs to an `sdk_processed`, `prepared`, or `committed` inbox;
- `quarantined` belongs to an `sdk_processed` or `quarantined` inbox and blocks
  all newer source progress;
- no crypto row may belong to `fetched` or have an absent parent;
- the selected row and complete encrypted inbox chain are authenticated before
  every read or write result.

## Selection and lease semantics

`next_pending_crypto_request(now)` is read-only:

1. Reject a non-UTC-millisecond `now` as invalid.
2. Authenticate bootstrap, both tokens, every room-progress row, and the full
   retained inbox chain.
3. Read unresolved crypto rows (`pending`, `response_received`, `quarantined`)
   in row order with `LIMIT 2`, fully verify each and its parent.
4. Validate both rows before applying lifecycle precedence. Any malformed row
   is `STORE_CRYPTO_CORRUPT`; two verified unresolved rows are also
   `STORE_CRYPTO_CORRUPT`. A single verified `response_received` or
   `quarantined` row
   returns `STORE_CRYPTO_NOT_READY`; it never returns `None` and never exposes
   response bytes.
5. No unresolved row returns `Ok(None)`.
6. One pending row whose `next_attempt_at > now` returns `Ok(None)`.
7. One due pending row returns the closed `PendingMatrixRequest`.

Persisted `gateway_state.maintenance_code` is a hard
`STORE_CRYPTO_NOT_READY` gate after corruption/cardinality verification. This
child task does not clear it.

`record_attempt(row, expected_attempt_count, expected_next_attempt_at, now,
next)` is the durable send lease and must be called before each Matrix HTTP
attempt. It:

1. validates inputs and authenticates the full chain plus selected pending row;
2. applies the common unresolved-row precedence above, then requires no
   maintenance and requires that this is the single unresolved row;
3. requires all three timestamp inputs to be UTC-millisecond, requires the
   stored `(attempt_count, next_attempt_at)` to equal the expected pair,
   requires `current next_attempt_at <= now`, and requires `next > now`;
4. increments `attempt_count` exactly once with an SQL compare-and-swap
   predicate over row ID, `state='pending'`, the expected count, and the exact
   expected timestamp; zero affected rows is `STORE_CRYPTO_CONFLICT`;
5. rejects overflow or a count at
   `1_000_000` as `STORE_CRYPTO_NOT_READY`;
6. sets only `attempt_count` and `next_attempt_at` in one `IMMEDIATE`
   transaction.

This is intentionally not a byte-retry idempotency API. The caller obtains the
current count and timestamp from `next_pending_crypto_request`, invokes
`record_attempt` once, and sends only after it returns success. If two callers
race with the same DTO, exactly one compare-and-swap succeeds. The loser gets
`STORE_CRYPTO_CONFLICT` without mutation. A direct attempt to lease a future
row is `STORE_CRYPTO_NOT_READY`. A crash after the lease but before the HTTP
request delays the resend until `next`; it never loses the exact request. An
error return must not be retried blindly. Task 9 owns backoff calculation,
jitter, bounded `Retry-After`, and the terminal-attempt policy.

## Response, acceptance, and quarantine semantics

### record_crypto_response

Prepare the sealed response before mutation, then begin one `IMMEDIATE`
transaction. Apply the common unresolved-row precedence, including full
validation before the maintenance gate, then authenticate the selected row.
Require no maintenance and require the row to be the single unresolved row,
`pending`, leased at least once, and response-free.
Set the four named response columns and `state='response_received'` atomically.
Change no attempt, retry, request, inbox, token, or maintenance field.

An exact retry against `response_received` succeeds without rewriting any
of `response_cipher`, `response_nonce`, `response_key_version`, or
`response_sha256`, and without rewriting attempt count, retry timestamp, or
state, only when decrypted stored bytes match byte-for-byte. The first sealed
response and its key version win even if the active key has rotated. A
different body is `STORE_CRYPTO_CONFLICT`. Accepted or quarantined rows are
`STORE_CRYPTO_NOT_READY`.

### complete_crypto_request

This method is callable only after the adapter has either:

- applied the exact stored response and the pinned SDK acknowledged its current
  request ID; or
- completed the separately specified restart-rebind/device-state proof.

The store cannot infer that external fact. Its transaction applies the common
unresolved-row precedence, authenticates the exact `response_received` row,
requires no maintenance, sets
`state='accepted'` and `accepted_at` together, and changes nothing else. The
timestamp must be UTC-millisecond and not earlier than the parent inbox
`observed_at`.

An exact retry against `accepted` with the same timestamp succeeds without a
rewrite. A different timestamp conflicts. Pending and quarantined rows are not
ready.

### quarantine_crypto_request

Accept only a valid bounded `ReasonCode`. Apply the common unresolved-row
precedence, including full validation before the maintenance gate, then
require no maintenance and authenticate the exact single unresolved row.
Transition only `pending` or `response_received` to `quarantined`, set the
exact terminal code, preserve every request/response and retry field, and leave
`accepted_at=NULL`. Do not advance or quarantine the parent inbox here; the
later service/maintenance child owns the coordinated operator state.

An exact retry of the same quarantined row and code succeeds without rewriting.
A different code conflicts. Accepted rows are not ready. There is deliberately
no unquarantine, retry, delete, skip, force-accept, or force-drain operation.

Quarantine blocks newer source progress through an exact store predicate: the
schema's unresolved unique index retains the quarantined row, and
`record_sdk_processing` must query all unresolved states with `LIMIT 2`, fully
verify them, and return `STORE_CRYPTO_NOT_READY` when the sole row is
quarantined. Two verified rows or any malformed row is
`STORE_CRYPTO_CORRUPT`. The parent inbox is not changed in this child task.
The later service loop additionally treats any quarantined crypto row as a
terminal health condition.

Extending the row codec must not break the prior operation's exact
idempotency. When its target inbox is already `sdk_processed`,
`record_sdk_processing` fully verifies the target's zero-or-one crypto row in
any valid lifecycle state and compares the original SDK request ID and request
bytes. An exact retry succeeds without mutation for `pending`,
`response_received`, `accepted`, or `quarantined`; a missing, extra, or
different request conflicts. When processing a new fetched inbox, one verified
`pending` or `response_received` row returns `STORE_CRYPTO_UNRESOLVED`, one
verified quarantined row returns `STORE_CRYPTO_NOT_READY`, and corruption/two
rows takes precedence as `STORE_CRYPTO_CORRUPT`.

## Task 1: Add closed transport DTOs

**Files:**
- Modify: `services/matrix-gateway/src/crypto_outbox.rs`
- Create: `services/matrix-gateway/tests/crypto_outbox_lifecycle.rs`

- [ ] Write RED tests named:

```text
raw_matrix_response_accepts_exact_bounded_json_object_without_rewriting
raw_matrix_response_rejects_empty_oversized_invalid_utf8_malformed_and_non_object
crypto_transport_dtos_redact_and_forbid_clone_serialize_deref_and_as_ref
```

The exact-bound response fixture must be 64 MiB and valid JSON; the one-over
fixture must be rejected before parsing. Use separate `compile_fail` doctests
for each forbidden trait. Assertion messages identify only canary classes.

- [ ] Run RED:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features raw_matrix_response -- --nocapture
```

Compilation must fail only because the new DTO API is absent.

- [ ] Implement the DTOs and run:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features raw_matrix_response
cargo test -p communicator-matrix-gateway --doc --no-default-features
cargo fmt --all -- --check
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
git diff --check
```

## Task 2: Select and lease one due pending request

**Files:**
- Modify: `services/matrix-gateway/src/crypto_outbox.rs`
- Modify: `services/matrix-gateway/src/store.rs`
- Modify: `services/matrix-gateway/tests/crypto_outbox_lifecycle.rs`

- [ ] Add RED tests named:

```text
next_pending_returns_exact_verified_due_request_and_is_read_only
next_pending_returns_none_for_absent_or_future_request
next_pending_rejects_response_received_quarantined_multiple_or_corrupt_unresolved_rows
next_pending_rejects_maintenance_corrupt_chain_or_parent_mismatch
record_attempt_leases_exact_row_before_send_and_changes_only_retry_fields
record_attempt_compare_and_swap_allows_exactly_one_of_two_stale_leases
record_attempt_rejects_future_invalid_time_wrong_row_wrong_state_maintenance_and_overflow
record_attempt_failure_rolls_back_every_table_and_column
pending_request_plaintext_never_appears_in_debug_display_or_safe_errors
```

For every failure, snapshot raw `gateway_state`, `sync_inbox`, and
`matrix_crypto_outbox` values and assert exact equality. Selection tests must
mutate every protected field, identity, lifecycle field, parent link, and
SQLite type in separate cases or table-driven subcases.

- [ ] Run transaction RED, implement the complete verified codec plus both
operations, and run focused GREEN:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features \
  next_pending -- --nocapture
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features \
  record_attempt -- --nocapture
```

## Task 3: Persist response, acceptance, and terminal quarantine

**Files:**
- Modify: `services/matrix-gateway/src/store.rs`
- Modify: `services/matrix-gateway/tests/crypto_outbox_lifecycle.rs`

- [ ] Add RED tests named:

```text
record_response_encrypts_exact_bytes_and_transitions_atomically
record_response_requires_a_lease_and_exact_retry_never_rewrites
record_response_rejects_conflict_corruption_wrong_state_parent_or_maintenance
complete_request_accepts_only_verified_response_and_is_exactly_idempotent
complete_request_rejects_early_timestamp_conflict_corruption_and_wrong_state
quarantine_preserves_request_response_retry_fields_and_blocks_progress
quarantine_is_exactly_idempotent_and_has_no_recovery_transition
response_plaintext_is_absent_from_database_wal_and_shm_while_open
all_crypto_lifecycle_states_survive_reopen_and_verify_fail_closed
```

The happy path proves independent request/response nonces, exact response AAD,
digest equality, unchanged inbox/tokens, and first-ciphertext-wins behavior.
Corruption tests cover partial response columns, ciphertext, nonce, key version,
digest, malformed JSON, oversized encoded blob, invalid timestamps, attempts,
terminal code, state, row ID, lookup, request, and parent lifecycle.

For each of `record_crypto_response`, `complete_crypto_request`, and
`quarantine_crypto_request`, add a SQLite failure trigger or equivalent
deterministic mid-transaction failure after validation but before commit.
Snapshot every raw column of `gateway_state`, `sync_inbox`, and
`matrix_crypto_outbox` before the call and prove byte-for-byte equality after
the error. Also prove a quarantined head makes `record_sdk_processing` for a
newer fetched inbox return `STORE_CRYPTO_NOT_READY` without mutation, while an
exact retry of the already-processed parent remains idempotent in every valid
crypto lifecycle state.

- [ ] Run RED, implement, and run focused GREEN:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features \
  record_response -- --nocapture
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features \
  complete_request -- --nocapture
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features \
  quarantine -- --nocapture
```

## Task 4: Full validation, independent reviews, and commit

- [ ] Run with the persistent gateway Cargo target and two jobs:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_outbox_lifecycle --no-default-features
cargo test -p communicator-matrix-gateway --doc --no-default-features
cargo test -p communicator-matrix-gateway \
  --no-default-features --all-targets -- \
  --skip aggregate_cap_accepts_exact_256_mib_retry_and_rejects_new_rows
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
cargo fmt --all -- --check
git diff --check
```

The exact 256 MiB sync-inbox test is not rerun because this child does not
change that code path.

- [ ] Run two fresh read-only Luna reviews in parallel:

1. specification trace from every frozen contract to implementation and a
   material assertion;
2. Rust/SQLite/security audit of bounds, encrypted lifecycle, selection,
   leasing, response AAD, retry/idempotency, transaction rollback, corruption,
   and plaintext-storage tests.

Reviewers never edit and never review their own work. Correct every Critical,
Important, or Moderate finding with a separate isolated Luna writer, rerun the
affected focused tests plus full non-slow gate, and obtain targeted re-review.

- [ ] After both reviews return `PASS`, stage only:

```bash
git add services/matrix-gateway/src/crypto_outbox.rs \
        services/matrix-gateway/src/store.rs \
        services/matrix-gateway/tests/crypto_outbox_lifecycle.rs
git diff --cached --check
git commit -m "feat: add crash-safe crypto outbox lifecycle"
```

## Completion evidence

This child plan is complete only when:

- the branch contains one implementation commit after `893727a`;
- the worktree is clean;
- all focused, doc, full non-slow, Clippy, rustfmt, and diff gates pass;
- both independent reviews have no open Critical, Important, or Moderate
  finding;
- tests prove exact encrypted selection, durable pre-send leasing, response
  persistence, SDK-postcondition acceptance, terminal quarantine, exact
  idempotency, full rollback, fail-closed corruption, reopen, and plaintext
  absence;
- no Matrix, Synapse, mautrix, Cloudflare, or other network call is introduced.

The following child plan implements persisted maintenance state, unresolved
response loading for restart, adapter rebind proof inputs, and
`mark_crypto_drained`. Task 9 later wires those store operations to the pinned
Matrix SDK and bounded Matrix HTTP transport.
