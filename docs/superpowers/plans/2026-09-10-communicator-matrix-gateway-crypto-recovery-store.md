# Matrix crypto recovery store implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` while implementing this plan. Execute the tasks in order. The worker receives no conversation history, so this document and the repository are the complete instructions.

**Goal:** Complete the local durable-state boundary required for restart-safe Matrix `/keys/query` recovery by exposing a closed saved-response DTO, persisted maintenance operations, and a source-ordered `mark_crypto_drained` transition.

**Architecture:** This slice stays entirely below the Matrix SDK and network boundary. It extends the authenticated SQLite ledger already implemented in `Store`; every read or mutation validates the singleton, the complete bounded inbox chain, the complete bounded crypto ledger, parent links, row cardinality, encrypted values, and lifecycle invariants before returning data or changing state. The later Matrix adapter may use these operations only after it has independently proved the SDK-side conditions described below.

**Tech stack:** Rust 2024, `rusqlite` transactions, `chrono`, the existing XChaCha20-Poly1305 `Keyring`, `SecretBytes`, and the pinned Matrix SDK types already present in the workspace.

---

## 1. Scope and baseline

Start from commit `f34f589` on branch `codex/matrix-gateway` in:

`/home/ubuntu/communicator/.worktrees/matrix-gateway`

Read these files before editing:

- `docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`, especially Task 4 lines 560-725 and Task 9.
- `docs/superpowers/plans/2026-09-10-communicator-matrix-gateway-crypto-outbox-lifecycle.md`.
- `services/matrix-gateway/src/crypto_outbox.rs`.
- `services/matrix-gateway/src/store.rs`.
- `services/matrix-gateway/src/store_types.rs`.
- `services/matrix-gateway/tests/crypto_outbox_lifecycle.rs`.

This plan may modify only:

- `services/matrix-gateway/src/crypto_outbox.rs`
- `services/matrix-gateway/src/store.rs`
- `services/matrix-gateway/src/lib.rs`, only if a new public type needs an explicit re-export
- `services/matrix-gateway/tests/crypto_recovery_store.rs`

Do not add network calls, Matrix SDK calls, admin commands, service-loop logic, schema migrations, dependencies, logging, metrics, or Cloudflare code. Do not weaken the existing encrypted-store, file-permission, locking, redaction, or fail-closed contracts.

The existing schema is authoritative. Do not add columns or tables. The allowed maintenance codes remain exactly:

```text
crypto_maintenance_required
matrix_crypto_kind_not_allowed
matrix_crypto_ack_unrecoverable
```

Use the existing stable error codes only:

```text
store_crypto_invalid
store_crypto_not_ready
store_crypto_conflict
store_crypto_corrupt
```

Never expose a SQLite error, SQL text, Matrix identifier, access token, request body, response body, or encryption material through an error, `Debug`, `Display`, panic message, or test failure message.

## 2. Frozen public contracts

Add these closed DTOs to `crypto_outbox.rs`. Names and signatures are frozen for this slice:

```rust
pub struct SavedMatrixResponse {
    row_id: String,
    request_sha256: [u8; 32],
    response: SecretBytes,
    response_sha256: [u8; 32],
}

impl SavedMatrixResponse {
    pub fn row_id(&self) -> &str;
    pub fn request_sha256(&self) -> &[u8; 32];
    pub fn response_sha256(&self) -> &[u8; 32];
    pub(crate) fn response(&self) -> &SecretBytes;
    pub(crate) fn from_verified_parts(
        row_id: String,
        request_sha256: [u8; 32],
        response: SecretBytes,
        response_sha256: [u8; 32],
    ) -> Self;
}

pub struct CryptoMaintenanceStatus {
    code: ReasonCode,
    since: DateTime<Utc>,
}

impl CryptoMaintenanceStatus {
    pub fn code(&self) -> &ReasonCode;
    pub fn since(&self) -> &DateTime<Utc>;
    pub(crate) fn from_verified_parts(code: ReasonCode, since: DateTime<Utc>) -> Self;
}
```

Both DTOs must:

- implement content-free `Debug` and `Display` as `SavedMatrixResponse([REDACTED])` and `CryptoMaintenanceStatus([REDACTED])`;
- not implement `Clone`, `Copy`, `Serialize`, `Deserialize`, `AsRef`, or `Deref`;
- keep all fields private;
- expose no response bytes publicly; the later adapter is in the same crate and uses the crate-private accessor;
- own secret bytes through `SecretBytes`, preserving its zeroization behavior.

Add these exact `Store` methods:

```rust
pub fn saved_crypto_response(&self)
    -> Result<Option<SavedMatrixResponse>, SafeError>;

pub fn crypto_maintenance_status(&self)
    -> Result<Option<CryptoMaintenanceStatus>, SafeError>;

pub fn set_crypto_maintenance(
    &mut self,
    code: ReasonCode,
    at: DateTime<Utc>,
) -> Result<(), SafeError>;

pub fn clear_crypto_maintenance(
    &mut self,
    expected: ReasonCode,
) -> Result<(), SafeError>;

pub fn mark_crypto_drained(
    &mut self,
    inbox_id: &str,
) -> Result<(), SafeError>;
```

The store does not claim to prove SDK state. The later adapter must satisfy these external preconditions:

- call `saved_crypto_response` only during the globally serialized crypto lane;
- before `clear_crypto_maintenance`, restore the SDK store without network access and verify that no `KeysUpload` or forbidden outgoing request exists and no crypto row is quarantined;
- before `mark_crypto_drained`, verify that the SDK reports no outstanding outgoing request and has acknowledged the accepted response, if the inbox had a request.

Document those preconditions on the methods. Do not encode a fake boolean or forgeable proof parameter.

## 3. Validation and precedence shared by every operation

All five methods must reuse one verified context loader rather than adding independent partial SQL reads. Refactor the existing internal loader if necessary, without changing behavior of the already-tested lifecycle methods.

The verified context must establish, in this order:

1. The database contains exactly one valid `gateway_state` singleton, or no singleton only where the operation returns `store_crypto_not_ready`.
2. Every stored singleton field has the correct SQLite type, bound, timestamp format, and encryption authentication.
3. The complete inbox chain is contiguous, bounded, authenticated, and consistent with committed and fetch tokens.
4. Every crypto row in the bounded ledger has valid SQLite types and bounds, authenticates under its row/column AAD, has a unique row ID and a unique `(inbox_id, request_lookup)` pair, references exactly one verified parent, and satisfies its lifecycle invariant. The same canonical request digest may appear in different inboxes.
5. At most one global crypto row is unresolved. `pending`, `response_received`, and `quarantined` are unresolved; `accepted` is resolved.
6. Only after corruption and cardinality checks may the operation apply its maintenance, state, source-order, idempotency, or conflict rule.

Corruption always maps to `store_crypto_corrupt`, even when maintenance is set or the addressed row is missing. Invalid caller input is checked before opening a transaction and maps to `store_crypto_invalid`. A valid request that cannot advance because of lifecycle or source order maps to `store_crypto_not_ready`. A valid retry that disagrees with an already recorded value maps to `store_crypto_conflict`.

Do not load unbounded rows. Use the existing inbox bound and a `LIMIT bound + 1` cardinality check. The crypto schema permits at most one row per inbox, so the verified crypto scan must cap at `inbox_count + 1`. Before copying or decrypting each row, use borrowed `ValueRef` values to validate and add its SDK-request-ID, request, and optional response ciphertext lengths to a checked aggregate. Reject the row before copying it if the aggregate would exceed the existing `MAX_RECOVERY_BYTES` bound. Continue using borrowed `ValueRef` validation for large response columns before copying them. This keeps the complete-ledger verifier bounded even when many accepted rows contain large responses.

## Task 1: Add the two closed recovery DTOs

**Files:**

- Modify: `services/matrix-gateway/src/crypto_outbox.rs`
- Test: `services/matrix-gateway/tests/crypto_recovery_store.rs`

- [ ] **Step 1: Write compile and redaction tests first**

Create `crypto_recovery_store.rs`. Add compile-fail doctests beside both DTOs following the exact pattern already used for `PendingMatrixRequest` and `RawMatrixResponse`. Add runtime assertions:

```rust
assert_eq!(format!("{saved:?}"), "SavedMatrixResponse([REDACTED])");
assert_eq!(format!("{saved}"), "SavedMatrixResponse([REDACTED])");
assert_eq!(
    format!("{status:?}"),
    "CryptoMaintenanceStatus([REDACTED])"
);
assert_eq!(
    format!("{status}"),
    "CryptoMaintenanceStatus([REDACTED])"
);
```

Do not add a public constructor just to make the integration test easy. Obtain each value through the store operations implemented by later tasks. The doctests prove the negative trait contracts.

- [ ] **Step 2: Run red**

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/node_modules/.cache/communicator-matrix-gateway-cargo \
CARGO_BUILD_JOBS=2 \
cargo test --manifest-path services/matrix-gateway/Cargo.toml --test crypto_recovery_store
```

Expected: compilation fails because the DTOs and store methods do not exist.

- [ ] **Step 3: Implement the DTOs exactly as frozen**

Use private fields and crate-private constructors. `SavedMatrixResponse::from_verified_parts` must be callable only after the store has authenticated and revalidated the stored response. Do not clone the response during construction. `CryptoMaintenanceStatus` contains no raw secret, but it remains closed so later health and CLI code cannot serialize arbitrary internal state by accident.

- [ ] **Step 4: Run the focused test and doctests**

Run the command from Step 2 and:

```bash
CARGO_TARGET_DIR=/home/ubuntu/communicator/node_modules/.cache/communicator-matrix-gateway-cargo \
CARGO_BUILD_JOBS=2 \
cargo test --manifest-path services/matrix-gateway/Cargo.toml --doc
```

Expected: tests that do not require the later store methods compile; the intentionally negative doctests pass once the DTO contracts exist.

## Task 2: Load one saved response for restart rebind

**Files:**

- Modify: `services/matrix-gateway/src/store.rs`
- Test: `services/matrix-gateway/tests/crypto_recovery_store.rs`

- [ ] **Step 1: Add failing behavioral tests**

Add helpers that create two contiguous fetched inbox rows using public store APIs, record one canonical `/keys/query`, lease it, and record an exact response. Use raw SQLite only to snapshot or deliberately corrupt fixtures after dropping `Store`; never use raw SQL to create the successful path.

Add these tests:

```text
saved_response_is_exact_authenticated_read_only_and_survives_reopen
saved_response_returns_none_when_no_crypto_row_exists
saved_response_returns_none_for_pending_or_accepted_rows
saved_response_rejects_maintenance_quarantine_or_multiple_unresolved_rows
saved_response_rejects_corrupt_gateway_chain_parent_request_or_response
saved_response_rejects_wrong_sqlite_types_and_oversized_response_before_copy
saved_response_does_not_expose_plaintext_in_debug_display_or_errors
```

For the success test, assert the row ID and both SHA-256 digests against independently calculated values. Take a byte-for-byte snapshot of every table and `PRAGMA data_version` before and after the read, including after closing and reopening the store. The operation must write nothing.

For the corruption tests, mutate one invariant at a time: response companion nullability, response nonce length, key version type/range, digest length, ciphertext bound, request digest, parent ID, gateway maintenance timestamp pairing, and a second unresolved row. Every case must return only `store_crypto_corrupt`, except a structurally valid persisted maintenance state or quarantined row, which returns `store_crypto_not_ready`.

- [ ] **Step 2: Run red**

Run only the named test target. Expected: failures because `saved_crypto_response` is absent.

- [ ] **Step 3: Implement `saved_crypto_response`**

The method is read-only and follows this decision table after the complete verified context is loaded:

| Verified state | Result |
|---|---|
| no bootstrap | `store_crypto_not_ready` |
| persisted maintenance | `store_crypto_not_ready` |
| no unresolved row | `Ok(None)` |
| one `pending` row | `Ok(None)` |
| one `response_received` row | `Ok(Some(SavedMatrixResponse))` |
| one `quarantined` row | `store_crypto_not_ready` |
| an `accepted` row appears in the unresolved result | `store_crypto_corrupt` |
| two unresolved rows or any invalid row/parent/chain | `store_crypto_corrupt` |

Construct the DTO by moving, not cloning, the already authenticated response `SecretBytes` out of the verified row. Recompute neither digest after verification. Do not return the original SDK request ID, request body, Matrix room/user IDs, or lifecycle strings.

- [ ] **Step 4: Run green**

Run `crypto_recovery_store`, `crypto_outbox_lifecycle`, and `crypto_request_recording`. Expected: all pass with no existing behavior changes.

## Task 3: Persist, inspect, and verified-clear maintenance

**Files:**

- Modify: `services/matrix-gateway/src/store.rs`
- Test: `services/matrix-gateway/tests/crypto_recovery_store.rs`

- [ ] **Step 1: Add failing maintenance tests**

Add these cases:

```text
maintenance_set_status_and_exact_retry_survive_reopen
maintenance_accepts_exactly_the_three_schema_codes
maintenance_rejects_invalid_code_time_or_unbootstrapped_store_without_writes
maintenance_rejects_conflicting_code_or_timestamp_without_writes
maintenance_corruption_precedes_idempotency_and_state_gates
maintenance_set_rolls_back_every_table_and_column_on_sql_abort
maintenance_clear_requires_expected_code_and_no_unresolved_or_quarantined_row
maintenance_clear_is_idempotent_after_verified_clear
maintenance_clear_rolls_back_every_table_and_column_on_sql_abort
maintenance_status_is_read_only_bounded_and_redacted
```

Use snapshots of every table before each expected failure. Install a temporary SQLite trigger that raises `ABORT` on the target `gateway_state` update to prove the transaction rolls back; drop the trigger before reopening. Assert that database error text and trigger text never appear in `SafeError`, `Debug`, or `Display`.

- [ ] **Step 2: Run red**

Run the focused target. Expected: failures because the three methods are absent.

- [ ] **Step 3: Implement `crypto_maintenance_status`**

This is a read-only operation. It validates the complete context first. Return `Ok(None)` only for a valid bootstrapped singleton with both maintenance fields null. Return the closed DTO only when both fields are valid and paired. No bootstrap returns `store_crypto_not_ready`; any malformed singleton, chain, crypto row, or cardinality returns `store_crypto_corrupt`.

- [ ] **Step 4: Implement `set_crypto_maintenance`**

Validate that `code` is one of the three exact maintenance codes, `at` is UTC with millisecond precision, and `at` is not earlier than `bootstrapped_at` or the current `updated_at`. Then begin an `IMMEDIATE` transaction and validate the complete context.

Apply this state table:

| Current fields | Requested pair | Result |
|---|---|---|
| null/null | valid `(code, at)` | set both fields and set `updated_at = at` |
| exact same pair | same pair | `Ok(())`, no SQL update |
| same code, different time | any | `store_crypto_conflict` |
| different code | any | `store_crypto_conflict` |
| malformed pair | any | `store_crypto_corrupt` |

Use a compare-and-set `UPDATE` with `maintenance_code IS NULL AND maintenance_since IS NULL`. Require exactly one changed row. An unexpected zero-row update maps to `store_crypto_conflict`; SQLite and invariant failures map to `store_crypto_corrupt`. Seal no values and modify no inbox or outbox field.

- [ ] **Step 5: Implement `clear_crypto_maintenance`**

Validate the expected code before opening the transaction. Validate the complete context before applying gates. Require no unresolved crypto row of any state and no quarantined crypto row anywhere in the bounded ledger. This local rule supplements, but does not replace, the adapter's SDK enumeration proof.

Apply this state table:

| Current fields | Expected code | Result |
|---|---|---|
| null/null | any valid expected code | `Ok(())`, no SQL update |
| `(expected, since)` | exact expected code | clear both fields, preserve `updated_at` |
| `(other, since)` | different valid code | `store_crypto_conflict` |
| malformed pair | any | `store_crypto_corrupt` |
| unresolved or quarantined row exists | matching expected | `store_crypto_not_ready` |

Use a compare-and-set `UPDATE` matching the exact stored code and timestamp, and require one changed row. Do not delete or modify any crypto row. There is no force-clear path.

- [ ] **Step 6: Run green**

Run the three focused crypto test targets. Expected: all pass.

## Task 4: Mark source-ordered crypto work drained

**Files:**

- Modify: `services/matrix-gateway/src/store.rs`
- Test: `services/matrix-gateway/tests/crypto_recovery_store.rs`

- [ ] **Step 1: Add failing drain tests**

Add these tests:

```text
drain_succeeds_for_oldest_sdk_processed_inbox_with_no_request
drain_succeeds_only_after_its_single_request_is_accepted
drain_exact_retry_is_read_only_and_survives_reopen
drain_rejects_pending_response_received_or_quarantined_request
drain_rejects_newer_inbox_while_earlier_crypto_is_not_drained
drain_rejects_maintenance_wrong_state_unknown_id_or_invalid_id
drain_rejects_corrupt_gateway_chain_parent_cardinality_or_crypto_row
drain_rolls_back_every_table_and_column_on_sql_abort
drain_changes_only_the_target_crypto_drained_column
```

Use public methods to create all valid states. For the one accepted-request path, assert the stored request and response columns remain byte-for-byte unchanged. For exact retry, snapshot the entire database and prove the second call performs no write. Include a reopened-store case.

- [ ] **Step 2: Run red**

Run the focused target. Expected: failures because `mark_crypto_drained` is absent.

- [ ] **Step 3: Implement the transition**

Validate `inbox_id` before opening an `IMMEDIATE` transaction. Load and authenticate the full context and all crypto rows through the target inbox before applying maintenance or source-order gates.

The target may transition only when:

- the singleton has no maintenance code;
- the target exists and is `sdk_processed`;
- it has no terminal code and no prepared or committed timestamp;
- every earlier inbox is already `crypto_drained = 1` and is in `sdk_processed`, `prepared`, or `committed` state;
- the target has zero crypto rows, or exactly one `accepted` row with a verified response and acceptance timestamp;
- every crypto row attached to an earlier inbox is `accepted`;
- no global `pending`, `response_received`, or `quarantined` crypto row exists.

If the target already has `crypto_drained = 1`, revalidate all applicable invariants and return `Ok(())` without an update. Otherwise execute exactly:

```sql
UPDATE sync_inbox
SET crypto_drained = 1
WHERE inbox_id = ?1
  AND state = 'sdk_processed'
  AND crypto_drained = 0
  AND sdk_processed_at = observed_at
  AND prepared_at IS NULL
  AND committed_at IS NULL
  AND terminal_code IS NULL
```

Require exactly one changed row, commit, and change no other column. A valid but premature transition returns `store_crypto_not_ready`; a compare-and-set race returns `store_crypto_conflict`; malformed authenticated state returns `store_crypto_corrupt`.

- [ ] **Step 4: Run green**

Run all four crypto-related integration targets and doctests. Expected: all pass.

## Task 5: Full validation and handoff evidence

**Files:** No new source files.

- [ ] **Step 1: Run focused tests**

```bash
export CARGO_TARGET_DIR=/home/ubuntu/communicator/node_modules/.cache/communicator-matrix-gateway-cargo
export CARGO_BUILD_JOBS=2
cargo test --manifest-path services/matrix-gateway/Cargo.toml --test crypto_recovery_store
cargo test --manifest-path services/matrix-gateway/Cargo.toml --test crypto_outbox_lifecycle
cargo test --manifest-path services/matrix-gateway/Cargo.toml --test crypto_request_recording
cargo test --manifest-path services/matrix-gateway/Cargo.toml --test sync_inbox_transactions
cargo test --manifest-path services/matrix-gateway/Cargo.toml --doc
```

- [ ] **Step 2: Run the full non-slow gate**

```bash
cargo test --manifest-path services/matrix-gateway/Cargo.toml --all-targets -- \
  --skip aggregate_cap_accepts_exact_256_mib_retry_and_rejects_new_rows
cargo clippy --manifest-path services/matrix-gateway/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path services/matrix-gateway/Cargo.toml --all -- --check
git diff --check
git status --short
```

The test worker must use workspace-write sandboxing with localhost network access because `matrix_sdk_compile` owns local mock-server tests. No external network request is permitted.

- [ ] **Step 3: Independent reviews**

Run two read-only Luna reviewers in parallel:

1. A specification reviewer traces every frozen contract and state-table row in this plan to production code and a named test assertion.
2. A Rust/SQLite/security reviewer checks allocation-before-validation, whole-ledger bounds, AAD and digest authentication, zeroization/redaction, corruption precedence, transaction rollback, compare-and-set races, exact retry behavior, maintenance clearing, and source-order enforcement.

Reviewers do not modify files and do not review their own work. Fix every Critical, Important, or Moderate finding in one consolidated writer pass, rerun affected focused tests, rerun the full gate once, and obtain a targeted independent re-review.

- [ ] **Step 4: Parent inspection and commit**

The parent verifies the Git diff contains only the allowed files, reads every production change, confirms no debug printing or plaintext fixture escaped into source, and verifies the final commands directly from their exit statuses.

Commit only after all gates pass:

```bash
git add \
  services/matrix-gateway/src/crypto_outbox.rs \
  services/matrix-gateway/src/store.rs \
  services/matrix-gateway/src/lib.rs \
  services/matrix-gateway/tests/crypto_recovery_store.rs
git commit -m "feat: add restart-safe crypto recovery state"
```

If `lib.rs` did not change, omit it from `git add`.

## 4. Completion criteria

This slice is complete only when current evidence proves all of the following:

- a saved `response_received` row can be loaded after reopen as exact authenticated bytes plus the stable request digest required for SDK rebind;
- pending, accepted, quarantined, duplicate, corrupt, and maintenance states follow the frozen decision table;
- maintenance set/status/clear persists across reopen and has no force-clear or overwrite path;
- clearing maintenance requires the exact expected code and a locally clean crypto ledger;
- `mark_crypto_drained` advances only the oldest eligible SDK-processed inbox and only after zero requests or one accepted request;
- every exact retry is read-only;
- every failing transaction leaves every table and column unchanged;
- no new plaintext secret is stored or exposed;
- all focused tests, full non-slow tests, doctests, Clippy, formatting, and diff checks pass;
- both independent reviews return `PASS` after any corrections.

The next phase replaces `matrix_spike.rs` with the pinned Matrix SDK adapter and uses this store boundary for direct acknowledgement, restart rebind, device-state verification, and maintenance handling. This plan does not claim that live Matrix ingestion works yet.
