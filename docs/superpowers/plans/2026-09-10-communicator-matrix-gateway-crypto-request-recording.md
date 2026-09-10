# Communicator Matrix Gateway Crypto Request Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development` to implement this plan. The orchestrator dispatches each implementation, test, and review step through a fresh ephemeral `codex exec` session using `gpt-5.6-luna`, maximum reasoning effort, and fast service tier. Do not create native subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically mark one encrypted sync inbox response as SDK-processed and, when present, persist its single allowlisted Matrix `/keys/query` request before any network send.

**Architecture:** Add a closed protected DTO for an exact canonical KeysQuery request, while keeping all SQLite access inside `Store`. `record_sdk_processing` verifies the complete encrypted sync chain, enforces source order and the global one-unresolved-request rule, encrypts the SDK request ID and exact request bytes, and changes the inbox lifecycle in one `IMMEDIATE` transaction. This plan deliberately stops before delivery, response persistence, acknowledgement, retry scheduling, maintenance clearing, or `crypto_drained`; those form the next independently reviewable child task.

**Tech Stack:** Rust stable 1.93.1, `rusqlite` 0.37, `serde_json`, SHA-256, the existing XChaCha20-Poly1305 `Keyring`, `SecretBytes`, `SafeError`, and SQLite schema version 1.

---

## Status and authority

This is the next executable child plan for Task 4 in
`docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`.
The parent plan and
`docs/superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md`
remain authoritative.

The branch must begin at or after:

```text
d30fbe9 feat: add crash-safe sync inbox
```

Do not change `SCHEMA_SQL`, `GATEWAY_SCHEMA_VERSION`, the Matrix SDK adapter,
Cloudflare ingestion code, room registry behavior, sync-window tables, backfill
tables, or service orchestration in this task.

## File map

```text
services/matrix-gateway/src/crypto_outbox.rs
    Closed protected DTOs and deterministic request/row identity helpers.

services/matrix-gateway/src/store.rs
    Atomic record_sdk_processing domain transaction and verified stored-row codec.

services/matrix-gateway/src/lib.rs
    Public module export only.

services/matrix-gateway/tests/crypto_request_recording.rs
    Transaction, idempotency, ordering, corruption, capacity, and privacy tests.
```

## Frozen contracts

### Public API added by this plan

```rust
pub struct CryptoRowId(String);

pub struct ExactMatrixRequest {
    sdk_request_id: SecretBytes,
    request: SecretBytes,
    request_sha256: [u8; 32],
}

impl ExactMatrixRequest {
    pub fn keys_query(
        sdk_request_id: Vec<u8>,
        canonical_request: Vec<u8>,
    ) -> Result<Self, SafeError>;

    pub fn request_sha256(&self) -> &[u8; 32];
}

impl Store {
    pub fn record_sdk_processing(
        &mut self,
        inbox_id: &str,
        requests: &[ExactMatrixRequest],
    ) -> Result<(), SafeError>;
}
```

`ExactMatrixRequest` is intentionally not `Clone`, `Copy`, `Serialize`,
`Deserialize`, `Deref`, or `AsRef`. Its `Debug` and `Display` output is exactly
`ExactMatrixRequest([REDACTED])`. Its SDK request ID and request bytes are never
returned as `String` and never appear in an error.

`CryptoRowId` is opaque operational metadata. It is `Clone + Eq + PartialEq`,
validates its exact shape at construction, and may print only its synthetic ID.
It is exactly `crypto_` followed by 64 lowercase hexadecimal characters.

### Stable safe errors

Add these public constants in `store.rs`:

```rust
pub const STORE_CRYPTO_INVALID: &str = "store_crypto_invalid";
pub const STORE_CRYPTO_TOO_LARGE: &str = "store_crypto_too_large";
pub const STORE_CRYPTO_NOT_READY: &str = "store_crypto_not_ready";
pub const STORE_CRYPTO_UNRESOLVED: &str = "store_crypto_unresolved";
pub const STORE_CRYPTO_CONFLICT: &str = "store_crypto_conflict";
pub const STORE_CRYPTO_CORRUPT: &str = "store_crypto_corrupt";
```

Every `SafeError` `Display` and `Debug` path stays code-only. Never attach an
inbox ID, crypto row ID, SDK request ID, body, digest, SQLite error, ciphertext,
timestamp, URL, or raw cause.

### Exact request bounds and canonical form

Add in `crypto_outbox.rs`:

```rust
pub const MAX_SDK_REQUEST_ID_BYTES: usize = 64 * 1024;
pub const MAX_MATRIX_CRYPTO_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const MATRIX_CRYPTO_REQUEST_KIND: &str = "keys_query";
```

The SDK request ID and request body must be nonempty. The body must:

1. be valid UTF-8;
2. parse as one JSON object;
3. pass the existing bounded canonical JSON encoder;
4. exactly equal the bytes returned by `canonical::canonical_json_bytes`.

Whitespace variants, duplicate/noncanonical key ordering, non-object JSON,
trailing bytes, bodies above 4 MiB, and invalid UTF-8 fail before persistence.
The adapter in Task 9 remains responsible for proving that the typed outgoing
request is actually a Ruma `KeysQuery`; this closed constructor ensures no
other request kind can enter this store operation.

Map an empty value, invalid UTF-8, JSON parse failure, non-object JSON, or
noncanonical bytes to `STORE_CRYPTO_INVALID`. Map either length above its
frozen maximum to `STORE_CRYPTO_TOO_LARGE`. The constructor never retains or
formats the rejected bytes.

### Deterministic lookup and row identity

Compute `request_lookup` with the active `Keyring`:

```rust
keyring.lookup_digest(
    "matrix-crypto-request-v1",
    &["keys_query", canonical_request_utf8],
)
```

Derive `crypto_row_id` as:

```text
"crypto_" + lowercase_hex(SHA256(
  frame("matrix-crypto-row-v1") ||
  frame(inbox_id UTF-8) ||
  frame(request_lookup)
))
```

`frame(bytes)` is `u32::to_be_bytes(bytes.len()) || bytes`. The SDK request ID
is deliberately excluded: SDK 0.18 may replace it after restart, while the
canonical KeysQuery body remains the stable application identity.

Use raw SHA-256 for `request_sha256`.

### Exact cryptographic contexts

Use the existing `Keyring::seal/open(table, row_id, field, bytes)` API:

| Table | Row ID passed to AAD | Field |
|---|---|---|
| `matrix_crypto_outbox` | exact `crypto_row_id` | `sdk_request_id` |
| `matrix_crypto_outbox` | exact `crypto_row_id` | `request` |

Every seal uses an independent random nonce. A row read authenticates both
fields, validates nonce/key-version/type/encoded length before allocation,
recomputes the request SHA-256, request lookup, row ID, and byte count, and
validates its complete lifecycle before it can influence a transition.

### Frozen lifecycle for this child task

This task creates only `pending` crypto rows:

```text
request_kind       = "keys_query"
state              = "pending"
attempt_count      = 0
next_attempt_at    = parent inbox observed_at
accepted_at        = NULL
terminal_code      = NULL
all response fields = NULL
```

It changes the target `sync_inbox` row only from:

```text
state = fetched
crypto_drained = 0
all later lifecycle fields = NULL
```

to:

```text
state = sdk_processed
crypto_drained = 0
sdk_processed_at = observed_at
prepared_at = committed_at = terminal_code = NULL
```

Using the already-frozen inbox `observed_at` makes crash replay deterministic
without adding a clock to `Store`. This operation never sets
`crypto_drained=1`; the next child task owns that transition after the SDK and
all persisted requests agree that nothing remains outstanding.

### Source ordering and unresolved-request rule

`record_sdk_processing` may target only the first retained row whose state is
`fetched`. Every predecessor must already be `sdk_processed`, `prepared`, or
`committed`; a quarantined predecessor blocks progress. This permits bounded
later-response key recovery while preventing an SDK-processing gap.

Before a new target is changed, verify that no row in
`matrix_crypto_outbox` is `pending`, `response_received`, or `quarantined`.
Return `STORE_CRYPTO_UNRESOLVED` without mutation when one exists. More than one
unresolved row, an invalid state, or malformed/corrupt protected data is
`STORE_CRYPTO_CORRUPT`, even if SQLite's partial unique index was removed or
bypassed by a corruption fixture.

### Exact idempotency

An exact retry after the target is already `sdk_processed` succeeds without
rewriting either table only when:

- zero supplied requests matches zero rows for that inbox; or
- one supplied request matches the existing verified row's canonical request
  bytes and SDK request ID byte-for-byte.

The first stored ciphertext, nonces, timestamps, and row ID win. Any missing,
extra, or byte-different request on retry returns `STORE_CRYPTO_CONFLICT` and
leaves both tables unchanged. Later Task 9 restart rebind updates the in-memory
SDK request ID; this operation does not implement a persistent rebind rewrite.

## Task 1: Freeze protected crypto-request DTOs

**Files:**
- Create: `services/matrix-gateway/src/crypto_outbox.rs`
- Modify: `services/matrix-gateway/src/lib.rs`
- Test: `services/matrix-gateway/tests/crypto_request_recording.rs`

- [ ] **Step 1: Write failing DTO contract tests**

Create `crypto_request_recording.rs` using the existing mode-0700 temporary
directory and fixed test-keyring patterns. Add these tests first:

```text
keys_query_dto_accepts_only_exact_bounded_canonical_json_object
keys_query_dto_rejects_empty_oversized_invalid_utf8_and_non_object_bodies
keys_query_dto_rejects_noncanonical_or_trailing_json_bytes
keys_query_dto_is_non_clone_and_redacts_debug_and_display
crypto_row_id_accepts_only_crypto_prefix_and_64_lowercase_hex
```

Use canonical bytes with nested objects and non-ASCII text. Test one body at
exactly 4 MiB and one at 4 MiB plus one byte without printing either body.
Put `compile_fail` doctests on `ExactMatrixRequest` that attempt each forbidden
bound without adding a new test dependency. Use separate blocks so a single
failure cannot hide another:

```rust
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<ExactMatrixRequest>();
/// ```
```

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_request_recording --no-default-features \
  keys_query_dto -- --nocapture
```

Expected: compilation fails only because `crypto_outbox` and its DTOs do not
exist. Fixture, syntax, dependency, or environment failures are not acceptable
RED evidence.

- [ ] **Step 3: Implement the exact DTO module**

Implement the shapes and constructors frozen above. Reuse
`canonical::canonical_json_bytes`; do not create a competing JSON canonicalizer.
Parse into `serde_json::Value`, require `Value::Object`, canonicalize, compare
exact bytes, and then move the validated vectors into `SecretBytes`.

Expose only read-only crate-private byte getters needed by `Store`:

```rust
pub(crate) fn sdk_request_id(&self) -> &SecretBytes;
pub(crate) fn request(&self) -> &SecretBytes;
pub fn request_sha256(&self) -> &[u8; 32];
```

`CryptoRowId::new` remains `pub(crate)`; callers receive IDs only from Store
operations in later tasks.

- [ ] **Step 4: Run DTO GREEN and static checks**

Run:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_request_recording --no-default-features \
  keys_query_dto -- --nocapture
cargo test -p communicator-matrix-gateway --doc --no-default-features
cargo fmt --all -- --check
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
git diff --check
```

Expected: all commands exit 0, no secret-bearing assertion includes raw bytes,
and `git status --short` lists only the three files in this task.

## Task 2: Record SDK processing and one encrypted pending KeysQuery atomically

**Files:**
- Modify: `services/matrix-gateway/src/store.rs`
- Modify: `services/matrix-gateway/src/crypto_outbox.rs`
- Modify: `services/matrix-gateway/tests/crypto_request_recording.rs`

- [ ] **Step 1: Write failing transaction tests**

Add these tests before production changes:

```text
sdk_processing_without_request_marks_only_first_fetched_inbox_processed
sdk_processing_with_keys_query_encrypts_exact_request_in_same_transaction
sdk_processing_retry_is_exact_and_never_rewrites_ciphertext_or_timestamps
sdk_processing_retry_with_missing_extra_or_different_request_conflicts
sdk_processing_rejects_second_request_and_rolls_back_every_column
sdk_processing_rejects_out_of_order_inbox_or_quarantined_predecessor
sdk_processing_blocks_while_any_unresolved_crypto_row_exists
sdk_processing_detects_multiple_unresolved_rows_if_unique_index_is_bypassed
sdk_processing_rejects_unknown_corrupt_or_wrong_lifecycle_inbox
sdk_processing_rejects_corrupt_crypto_cipher_nonce_key_digest_id_or_lifecycle
sdk_processing_plaintext_is_absent_from_database_wal_and_shm_while_open
sdk_processing_survives_reopen_with_first_ciphertext_and_timestamp_intact
```

For every rejection, snapshot every raw SQLite value from `gateway_state`,
`sync_inbox`, and `matrix_crypto_outbox` before the call and assert exact
equality afterward. The privacy test keeps `Store` open while scanning the
database plus present WAL/SHM sidecars for distinct SDK-ID and request-body
canaries. Assertion messages identify only the canary class.

The atomic happy path must prove:

- one target row moves from `fetched` to `sdk_processed`;
- `sdk_processed_at` exactly equals its existing `observed_at`;
- `crypto_drained` remains zero;
- no committed/fetch token or other inbox row changes;
- the crypto row owns the exact target inbox ID;
- the request kind, state, attempts, retry time, null response fields,
  accepted time, and terminal code match the frozen lifecycle;
- both ciphertexts decrypt using only their exact frozen AAD;
- the decrypted bytes equal the input byte-for-byte;
- request SHA-256, request lookup, byte count, and crypto row ID recompute to
  their stored values;
- SDK request ID and request use distinct nonces.

- [ ] **Step 2: Run transaction RED**

Run:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_request_recording --no-default-features \
  sdk_processing -- --nocapture
```

Expected: compilation fails because `Store::record_sdk_processing` and its
private row-codec helpers are absent. DTO failures must already be green.

- [ ] **Step 3: Add verified stored-row helpers**

Add private bounded helpers in `store.rs`; no helper exposes a raw connection
or secret-bearing error:

```rust
fn matrix_request_lookup(
    keyring: &Keyring,
    canonical_request: &[u8],
) -> Result<[u8; 32], SafeError>;

fn derive_crypto_row_id(
    inbox_id: &InboxId,
    request_lookup: &[u8; 32],
) -> Result<CryptoRowId, SafeError>;

fn read_and_verify_pending_crypto_row(
    stored: StoredCryptoRow,
    keyring: &Keyring,
) -> Result<VerifiedPendingCryptoRow, SafeError>;
```

Decode SQLite columns with `ValueRef` and validate type and encoded length
before `to_vec` or `to_owned`. For this child task, the verified codec accepts
only the frozen `pending` lifecycle. A response-bearing, accepted, quarantined,
unknown, partially null, or otherwise inconsistent row returns
`STORE_CRYPTO_CORRUPT`; the next child plan will extend the closed codec before
creating those states.

Every crypto-row query uses `LIMIT 2`. This task never materializes an
unbounded collection. A global unresolved query must detect a bypassed partial
unique index by observing the second row.

- [ ] **Step 4: Implement the exact transaction order**

Implement `record_sdk_processing` in this order:

1. Validate `inbox_id` and require zero or one request. Validate the request
   again defensively.
2. For one request, compute request SHA-256, keyed lookup, deterministic row ID,
   and two independent sealed values before SQLite mutation.
3. Begin `TransactionBehavior::Immediate`.
4. Require and authenticate the bootstrap singleton and every room-progress
   row; load committed/fetch tokens and call the existing full
   `verify_inbox_chain`.
5. Find exactly one target in that verified chain. Missing is invalid. A
   quarantined target or predecessor is `STORE_CRYPTO_NOT_READY`.
6. If the target is already `sdk_processed`, load at most two crypto rows for
   that inbox, fully verify them, apply exact idempotency, explicitly roll back
   the empty transaction, and return.
7. Otherwise require that the target is the first `fetched` row and has
   `crypto_drained=false` with no later lifecycle values.
8. Query unresolved crypto rows globally with `LIMIT 2`, fully verify any row,
   and require zero. One valid unresolved row returns
   `STORE_CRYPTO_UNRESOLVED`; two or malformed rows return
   `STORE_CRYPTO_CORRUPT`.
9. With one request, insert exactly one `pending` row using the frozen columns,
   AAD, identity, and parent `observed_at`.
10. Update exactly one inbox row from `fetched` to `sdk_processed`, set
    `sdk_processed_at=observed_at`, and leave every other column unchanged. A
    zero affected-row count is a conflict/corruption, never silent success.
11. Commit once and return `Ok(())`.

Map a uniqueness race to `STORE_CRYPTO_CONFLICT`; do not treat an arbitrary
SQLite constraint error as idempotent success. Never update gateway tokens,
room progress, registry rows, or another inbox row.

This transaction does not implement the service-wide 256 MiB backpressure
calculation. Task 10 already owns the combined retained inbox, Matrix-crypto
outbox, and ingestion-outbox health/backpressure gate. This child operation
must remain able to durably record the bounded SDK request produced while
processing an already-journaled response; it never fetches another response or
sends the request.

- [ ] **Step 5: Run transaction GREEN and full non-slow regression**

Use the persistent gateway Cargo target and two compiler jobs. Run:

```bash
cargo test -p communicator-matrix-gateway \
  --test crypto_request_recording --no-default-features
cargo test -p communicator-matrix-gateway \
  --no-default-features --all-targets -- \
  --skip aggregate_cap_accepts_exact_256_mib_retry_and_rejects_new_rows
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
cargo fmt --all -- --check
git diff --check
```

Expected: every new test and all non-slow existing tests pass. The previously
verified 256 MiB sync-inbox test is not rerun because this task does not change
its code path.

- [ ] **Step 6: Independent review and commit**

Run two fresh read-only Luna reviews in parallel after tests are green:

1. Specification review traces every frozen contract and transaction step to
   implementation plus a material assertion.
2. Rust/SQLite/security review inspects allocation bounds, canonical-body
   equality, request/row identity, AAD, nonce independence, transaction
   rollback, idempotency false positives, lifecycle/source ordering, and raw
   storage canary tests.

Reviewers do not modify source and do not review their own work. Correct every
Critical, Important, or Moderate finding with one isolated Luna writer; rerun
only affected focused tests plus the non-slow full package gate, then obtain a
targeted fresh re-review.

After both reviews return `PASS`, stage only:

```bash
git add services/matrix-gateway/src/crypto_outbox.rs \
        services/matrix-gateway/src/lib.rs \
        services/matrix-gateway/src/store.rs \
        services/matrix-gateway/tests/crypto_request_recording.rs
git diff --cached --check
git commit -m "feat: record encrypted matrix crypto requests"
```

## Completion evidence

This child plan is complete only when:

- the branch contains one implementation commit after `d30fbe9`;
- the worktree is clean;
- the DTO, focused transaction, non-slow package, Clippy, rustfmt, and diff
  gates exit zero;
- both independent reviews have no open Critical, Important, or Moderate
  finding;
- tests prove exact atomic inbox/request persistence, source ordering, global
  unresolved serialization, exact idempotency, corruption fail-closed behavior,
  and absence of protected request plaintext from SQLite/WAL/SHM bytes;
- no Matrix or Cloudflare network call is introduced.

The next child plan starts from that commit and implements pending-request
selection, retry scheduling, exact response persistence, SDK acknowledgement,
terminal crypto quarantine, maintenance state, and `mark_crypto_drained`.
