# Communicator Matrix Gateway Sync Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bootstrap-state and encrypted raw-sync ledger operations that let the Matrix gateway durably journal an exact `/sync` response before any Matrix SDK or application processing.

**Architecture:** Keep SQLite private behind `Store` domain operations. Add small validated DTOs in `store_types.rs`; keep protected bytes owned by non-`Clone` `SecretBytes`; encrypt every session, token, anchor, and response value with the existing `Keyring`. Bootstrap initializes singleton state and room anchors once. Each later sync response extends one verified token/predecessor chain and advances only the fetch token until a future live-window transaction commits it.

**Tech Stack:** Rust stable 1.93.1, `rusqlite` 0.37 with bundled SQLite, `chrono`, `sha2`, XChaCha20-Poly1305 through the existing `Keyring`, existing `SecretBytes` and `SafeError` boundaries.

---

## Status and authority

This is the executable child plan for the bootstrap and raw-sync portion of Task 4 in `2026-09-09-communicator-matrix-gateway-implementation.md`. The parent plan and design remain authoritative. This plan resolves four omissions without changing schema version 1:

1. Task 9 needs a domain operation to seed `gateway_state` and initial room anchors. Add `initialize_bootstrap_state`; it is the only first-write operation for that state.
2. `NewRawSyncInbox` receives an already-frozen `observed_at` from the service immediately after the bounded HTTP response finishes. `append_fetched_sync` persists that same instant as both `observed_at` and `created_at`; retries retain the first stored instant.
3. Returned protected bytes are newly decrypted into owned `SecretBytes`. No protected DTO or byte wrapper gains `Clone`, `Deref`, `AsRef`, `Serialize`, or revealing formatting.
4. SHA-256 token digests are 32-byte operational values. They may be compared and copied, but raw tokens remain encrypted and redacted.

Do not modify `SCHEMA_SQL`, `GATEWAY_SCHEMA_VERSION`, the registry contract, canonical-event types, or Matrix SDK code in these tasks.

## File map

```text
services/matrix-gateway/src/store_types.rs        validated sync-ledger DTOs and enums
services/matrix-gateway/src/store.rs              bootstrap and raw-sync transactions
services/matrix-gateway/src/lib.rs                export store_types
services/matrix-gateway/tests/sync_inbox_transactions.rs
                                                   transaction, recovery, and privacy tests
```

## Frozen common contracts

### Stable safe error codes

Add these constants in `store.rs`; every `SafeError` `Display` and `Debug` path remains code-only:

```rust
pub const STORE_NOT_BOOTSTRAPPED: &str = "store_not_bootstrapped";
pub const STORE_ALREADY_BOOTSTRAPPED: &str = "store_already_bootstrapped";
pub const STORE_BOOTSTRAP_INVALID: &str = "store_bootstrap_invalid";
pub const STORE_SYNC_INVALID: &str = "store_sync_invalid";
pub const STORE_SYNC_TOO_LARGE: &str = "store_sync_too_large";
pub const STORE_SYNC_TOKEN_MISMATCH: &str = "store_sync_token_mismatch";
pub const STORE_SYNC_CONFLICT: &str = "store_sync_conflict";
pub const STORE_SYNC_CORRUPT: &str = "store_sync_corrupt";
pub const STORE_SDK_POSITION_UNJOURNALED: &str = "matrix_sdk_position_unjournaled";
```

Never attach a token, response, room lookup, event ID, SQL error, ciphertext, path, or raw cause to these errors.

### Exact bounds and identifiers

```rust
pub const MAX_SYNC_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SYNC_TOKEN_BYTES: usize = 64 * 1024;
pub const MAX_BOOTSTRAP_SESSION_BYTES: usize = 1024 * 1024;
pub const MAX_BOOTSTRAP_ROOM_ANCHORS: usize = 100_000;
```

- Tokens, response bytes, session bytes, and anchor event bytes must be nonempty.
- An anchor event value is at most 64 KiB.
- `InboxId` is exactly `inbox_` plus 64 lowercase hexadecimal characters.
- All timestamps must serialize as valid UTC RFC 3339 instants with no sub-millisecond precision and must satisfy the existing `model::valid_timestamp` range.
- All digest inputs and stored digests are exactly 32 bytes.

### Exact cryptographic contexts

Use the existing `Keyring::seal/open(table, row_id, field, bytes)` API:

| Table | Row ID passed to AAD | Field |
|---|---|---|
| `gateway_state` | `"1"` | `session` |
| `gateway_state` | `"1"` | `committed_token` |
| `gateway_state` | `"1"` | `fetch_token` |
| `room_progress` | `room_` + lowercase hex of `room_lookup` | `anchor_event` |
| `sync_inbox` | exact `inbox_id` | `request_token` |
| `sync_inbox` | exact `inbox_id` | `next_token` |
| `sync_inbox` | exact `inbox_id` | `response` |

Use raw SHA-256 for `request_token_digest`, `next_token_digest`, and `response_sha256`. Derive `inbox_id` as:

```text
"inbox_" + lowercase_hex(SHA256(
  frame("matrix-sync-inbox-v1") ||
  frame(request_token_digest) ||
  frame(next_token_digest) ||
  frame(response_sha256)
))
```

`frame(bytes)` is `u32::to_be_bytes(bytes.len()) || bytes`. The timestamp is deliberately excluded so a byte-identical retry derives the same ID and retains the original observation instant.

## Task 1: Freeze sync-ledger DTOs and initialize bootstrap state

**Files:**
- Create: `services/matrix-gateway/src/store_types.rs`
- Modify: `services/matrix-gateway/src/lib.rs`
- Modify: `services/matrix-gateway/src/store.rs`
- Create: `services/matrix-gateway/tests/sync_inbox_transactions.rs`

- [ ] **Step 1: Write failing DTO and bootstrap transaction tests**

Create `sync_inbox_transactions.rs` with secure mode-0700 temporary directories and the same test-keyring pattern used by `store_transactions.rs`. Write these tests before production changes:

```text
validated_sync_ledger_dtos_are_redacted_and_bounded
bootstrap_initializes_exact_singleton_and_room_anchors_atomically
bootstrap_rejects_duplicate_initialization_without_rewriting_state
bootstrap_rejects_duplicate_room_lookups_and_rolls_back
bootstrap_rejects_invalid_timestamp_empty_or_oversized_protected_values
bootstrap_ciphertext_round_trips_after_reopen
bootstrap_plaintext_is_absent_from_database_wal_and_shm
bootstrap_corruption_fails_closed_without_secret_formatting
```

The atomic happy-path test must verify:

- exactly one `gateway_state` row with `singleton=1`;
- `maintenance_code` and `maintenance_since` are `NULL`;
- `bootstrapped_at` and `updated_at` equal the input instant;
- committed and fetch ciphertext decrypt to the same exact initial token;
- every supplied room lookup has one `room_progress` row and its anchor decrypts exactly;
- a failure on the second anchor leaves zero `gateway_state` and zero `room_progress` rows.

The privacy test must scan the database and any present `-wal` and `-shm` sidecars while `Store` remains open. Search for distinct canaries in the session, initial token, and every anchor value. Failure messages must name only the canary class, never print the canary value.

- [ ] **Step 2: Run RED and record the expected reason**

Run:

```bash
cargo test -p communicator-matrix-gateway --test sync_inbox_transactions --no-default-features
```

Expected: compilation fails because `store_types` and `Store::initialize_bootstrap_state` do not exist. A syntax, fixture, permission, or unrelated failure is not an acceptable RED.

- [ ] **Step 3: Add exact DTOs with private fields**

Create `store_types.rs` with these public shapes and private fields:

```rust
pub struct RoomAnchor {
    room_lookup: [u8; 32],
    anchor_event: SecretBytes,
}

pub struct NewBootstrapState {
    session: SecretBytes,
    initial_token: SecretBytes,
    anchors: Vec<RoomAnchor>,
    bootstrapped_at: DateTime<Utc>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct InboxId(String);

#[derive(Clone, Eq, PartialEq)]
pub struct ReasonCode(String);

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyncInboxState {
    Fetched,
    SdkProcessed,
    Prepared,
    Committed,
    Quarantined,
}

pub struct NewRawSyncInbox {
    request_token: SecretBytes,
    next_token: SecretBytes,
    response: SecretBytes,
    observed_at: DateTime<Utc>,
}

pub struct RawSyncInbox {
    inbox_id: InboxId,
    predecessor_id: Option<InboxId>,
    request_token: SecretBytes,
    request_token_digest: [u8; 32],
    next_token: SecretBytes,
    next_token_digest: [u8; 32],
    response: SecretBytes,
    response_sha256: [u8; 32],
    byte_count: usize,
    state: SyncInboxState,
    crypto_drained: bool,
    observed_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    sdk_processed_at: Option<DateTime<Utc>>,
    prepared_at: Option<DateTime<Utc>>,
    committed_at: Option<DateTime<Utc>>,
    terminal_code: Option<ReasonCode>,
}

#[derive(Clone, Eq, PartialEq)]
pub enum SdkInboxPosition {
    Committed,
    Journaled { inbox_id: InboxId },
}
```

Required constructors and accessors:

```rust
impl RoomAnchor {
    pub fn new(room_lookup: [u8; 32], anchor_event: Vec<u8>)
        -> Result<Self, SafeError>;
    pub fn room_lookup(&self) -> &[u8; 32];
    pub fn anchor_event(&self) -> &SecretBytes;
}

impl NewBootstrapState {
    pub fn new(session: Vec<u8>, initial_token: Vec<u8>,
               anchors: Vec<RoomAnchor>, bootstrapped_at: DateTime<Utc>)
        -> Result<Self, SafeError>;
    // crate-private borrowing getters only
}

impl InboxId {
    pub(crate) fn new(value: String) -> Result<Self, SafeError>;
    pub fn as_str(&self) -> &str;
}

impl ReasonCode {
    pub fn new(value: impl Into<String>) -> Result<Self, SafeError>;
    pub fn as_str(&self) -> &str;
}

impl NewRawSyncInbox {
    pub fn new(request_token: Vec<u8>, next_token: Vec<u8>,
               response: Vec<u8>, observed_at: DateTime<Utc>)
        -> Result<Self, SafeError>;
    // crate-private borrowing getters only
}

impl RawSyncInbox {
    // public read-only getters for every field; protected getters return
    // &SecretBytes. Construction remains crate-private and validates all
    // hashes, lengths, state/timestamp combinations, and predecessor IDs.
}

impl SdkInboxPosition {
    pub fn journaled_inbox_id(&self) -> Option<&InboxId>;
}
```

All protected DTOs (`RoomAnchor`, `NewBootstrapState`, `NewRawSyncInbox`, `RawSyncInbox`) must omit `Clone`, `Serialize`, `Deref`, and `AsRef`. Their `Debug` and `Display` output is exactly `TypeName([REDACTED])`. Constructors accept owned `Vec<u8>` and immediately wrap it in crate-private `SecretBytes`; do not make a general public `SecretBytes` constructor. `InboxId`, `ReasonCode`, `SyncInboxState`, and `SdkInboxPosition` may expose only synthetic state and IDs. `ReasonCode` is 3–64 ASCII bytes, starts with `a`–`z`, contains only lowercase letters, digits, and single underscores, and ends in a lowercase letter or digit. Every constructor and every crate-private persistence serializer must revalidate.

Export with `pub mod store_types;` in `lib.rs`.

- [ ] **Step 4: Implement one-shot bootstrap transaction**

Add:

```rust
pub fn initialize_bootstrap_state(
    &mut self,
    state: NewBootstrapState,
) -> Result<(), SafeError>;

pub fn matrix_session(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn room_anchor(&self, room_lookup: &[u8])
    -> Result<Option<SecretBytes>, SafeError>;
```

Algorithm, in this exact order:

1. Revalidate `state`, unique room lookups, all bounds, and timestamp before opening a transaction.
2. Seal session, committed token, fetch token, and every anchor using the frozen AAD table above. Do not format plaintext on error.
3. Begin `TransactionBehavior::Immediate`.
4. Require both `gateway_state` and `room_progress` to be empty. Any existing row returns `store_already_bootstrapped` and writes nothing.
5. Insert the singleton row with identical committed/fetch token ciphertext values produced by separate `seal` calls. Nonces must therefore be independent even though plaintext is equal.
6. Insert each `room_progress` row. Use the anchor's lookup BLOB as the key and the frozen `room_<hex>` AAD row ID.
7. Commit once. Map every SQL/encryption/validation failure to a stable code-only error. Rust transaction drop must roll back all partial inserts.

`matrix_session` returns `Ok(None)` before bootstrap and otherwise decrypts and
authenticates the singleton session into a new owned `SecretBytes`.
`room_anchor` requires a 32-byte lookup, returns `Ok(None)` when no row exists,
and otherwise authenticates the anchor using the frozen `room_<hex>` AAD. Both
methods fail closed on partial singleton rows, malformed metadata, wrong nonce
or key version, duplicate rows, or corrupt ciphertext. These are the only Task
9 read paths for the saved session and durable-room anchor; no raw connection
is exposed.

Do not add an update, replace, force, reset, or delete path.

- [ ] **Step 5: Run GREEN and static gates**

Run:

```bash
cargo test -p communicator-matrix-gateway --test sync_inbox_transactions --no-default-features
cargo test -p communicator-matrix-gateway --test store_transactions --no-default-features
cargo test -p communicator-matrix-gateway --lib --no-default-features
cargo fmt --all -- --check
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
git diff --check
```

Expected: all exit 0. Preserve the intentionally ignored privileged ownership test; do not add blanket lint allowances.

- [ ] **Step 6: Two-stage review and commit**

Specification review must confirm exact DTO privacy, bounds, one-shot initialization, independent nonces, AAD contexts, all-or-nothing anchors, and raw-file canary absence. Code-quality review must check drop order, zeroizing ownership, transaction rollback, error redaction, and false-positive tests.

After both reviews pass and corrections are re-reviewed:

```bash
git add services/matrix-gateway/src/lib.rs \
        services/matrix-gateway/src/store.rs \
        services/matrix-gateway/src/store_types.rs \
        services/matrix-gateway/tests/sync_inbox_transactions.rs
git commit -m "feat: initialize encrypted gateway state"
```

## Task 2: Append, verify, and reconcile the raw sync inbox

**Files:**
- Modify: `services/matrix-gateway/src/store.rs`
- Modify: `services/matrix-gateway/src/store_types.rs`
- Modify: `services/matrix-gateway/tests/sync_inbox_transactions.rs`

- [ ] **Step 1: Write failing transaction and recovery tests**

Add these tests before production changes:

```text
append_journals_exact_raw_response_before_any_later_state
append_advances_only_fetch_token_and_links_verified_predecessor
append_rejects_empty_and_over_64_mib_response_without_mutation
append_rejects_oversized_or_empty_tokens_without_mutation
byte_identical_retry_returns_existing_id_and_retains_first_timestamp
same_request_token_with_different_successor_or_body_fails_closed
wrong_request_token_fails_without_extending_chain
oldest_uncommitted_follows_chain_not_lexical_id_or_timestamp_order
sdk_position_accepts_committed_and_each_contiguous_journaled_token
sdk_position_rejects_unknown_digest_or_broken_chain
token_reads_and_raw_inbox_survive_reopen_with_exact_bytes
corrupt_token_response_hash_nonce_key_version_state_or_lifecycle_fails_closed
sync_plaintext_is_absent_from_database_wal_and_shm_while_open
```

For every rejected mutation, snapshot row counts and the encrypted fetch-token columns before the call and assert exact equality afterward. For exact journaling, use response bytes containing significant whitespace and non-ASCII JSON text; compare bytes, not parsed JSON. The 64 MiB test must accept exactly 67,108,864 bytes and reject 67,108,865 bytes.

- [ ] **Step 2: Run RED and record the expected missing APIs**

Run:

```bash
cargo test -p communicator-matrix-gateway --test sync_inbox_transactions --no-default-features
```

Expected: compilation fails only because the five Task 2 Store operations are absent.

- [ ] **Step 3: Implement verified row codec helpers**

Add private helpers in `store.rs`; no helper may expose a raw connection or plaintext in an error:

```rust
fn sha256(bytes: &[u8]) -> [u8; 32];
fn lowercase_hex(bytes: &[u8]) -> String;
fn derive_inbox_id(request: &[u8; 32], next: &[u8; 32],
                   response: &[u8; 32]) -> Result<InboxId, SafeError>;
fn load_verified_gateway_token(connection: &Connection, keyring: &Keyring,
                               field: GatewayTokenField)
    -> Result<SecretBytes, SafeError>;
fn read_and_verify_inbox_row(
    row: StoredSyncInboxRow,
    keyring: &Keyring,
) -> Result<RawSyncInbox, SafeError>;
```

`read_and_verify_inbox_row` must authenticate all three ciphertexts with the exact row ID and field AAD, recompute every digest and byte count, validate the ID derivation, validate predecessor ID shape, validate exact timestamp precision, parse exact state, and enforce lifecycle combinations:

```text
fetched       => no sdk_processed/prepared/committed/terminal timestamp/code
sdk_processed => sdk_processed_at set; prepared/committed/terminal unset
prepared      => sdk_processed_at and prepared_at set; committed/terminal unset
committed     => sdk_processed_at, prepared_at, committed_at set; terminal unset
quarantined   => terminal_code set; committed_at unset
```

Do not require `crypto_drained=true` for `fetched`; later crypto/window tasks own that transition.

- [ ] **Step 4: Implement exact append idempotency before fetch-token comparison**

Add:

```rust
pub fn append_fetched_sync(
    &mut self,
    response: NewRawSyncInbox,
) -> Result<InboxId, SafeError>;
```

Execute in this exact order:

1. Revalidate input; compute three hashes and deterministic `InboxId`; seal all three values before beginning SQLite mutation.
2. Begin an IMMEDIATE transaction and require exactly one valid bootstrap singleton.
3. Query any row with candidate `next_token_digest`, candidate `request_token_digest`, or candidate `inbox_id`. Fully decrypt and verify every match.
4. If one verified row has exact request token, next token, and response bytes, return its existing ID after rolling back the otherwise-empty transaction. Ignore the retry's new `observed_at`; the first stored timestamp wins.
5. If any matching row differs in any of those exact bytes, return `store_sync_conflict` without mutation.
6. Decrypt the current fetch token and require byte equality with the candidate request token. Digest equality alone is insufficient. Mismatch returns `store_sync_token_mismatch`.
7. Determine predecessor: no inbox rows means `NULL`; otherwise require exactly one tail whose verified next token equals the request token, and use its ID. Reject disconnected, multiple-tail, or corrupt chains.
8. Require the new `observed_at` not to precede the predecessor's `observed_at`.
9. Insert one `fetched` row with `crypto_drained=0`, input time in both timestamp columns, and no later lifecycle values.
10. Update only the singleton's fetch-token ciphertext/nonce/version and `updated_at`. Do not change committed-token or session columns.
11. Commit once, then return the ID.

The SQL unique constraints are a final race guard; do not treat a generic unique-constraint failure as successful idempotency.

- [ ] **Step 5: Implement verified token and chain reads**

Add the parent-plan signatures exactly:

```rust
pub fn reconcile_sdk_position(
    &self,
    sdk_token_digest: &[u8],
) -> Result<SdkInboxPosition, SafeError>;

pub fn committed_sync_token(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn fetch_sync_token(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn oldest_uncommitted_inbox(&self) -> Result<Option<RawSyncInbox>, SafeError>;
```

Rules:

- Before bootstrap, the two token getters return `Ok(None)`; after any malformed partial singleton they fail closed.
- After bootstrap, getters decrypt from `gateway_state` and return fresh owned `SecretBytes`.
- `reconcile_sdk_position` requires exactly 32 input bytes and a valid singleton. It hashes the decrypted committed token; equality returns `Committed`.
- Otherwise, load and fully verify the entire retained inbox chain. Before any inbox has committed, the root row has `predecessor_id=NULL` and its request token equals the committed bootstrap token. After commits and retention purge, the root may instead be a retained committed row with `predecessor_id=NULL`; the decrypted next token of the last contiguous committed row must equal the current committed token. Every later row's `predecessor_id`, request token, and request-token digest must equal the previous row's ID, next token, and next-token digest. The final row's next token must equal the current fetch token. A cycle, fork, gap, duplicate digest, corrupt row, disconnected row, committed row after an uncommitted row, or committed-token boundary mismatch fails closed.
- Return `Journaled { inbox_id }` for the unique row whose verified next-token digest equals the supplied SDK digest. Unknown digest returns `matrix_sdk_position_unjournaled`.
- `oldest_uncommitted_inbox` verifies the same full chain, skips only a contiguous committed prefix, and returns the first remaining row. A committed row after an uncommitted row is corruption. Return `Ok(None)` only when all rows are committed or the bootstrapped chain is empty.

- [ ] **Step 6: Run GREEN, full regression, and static gates**

Run:

```bash
cargo test -p communicator-matrix-gateway --test sync_inbox_transactions --no-default-features
cargo test -p communicator-matrix-gateway --test store_transactions --no-default-features
cargo test -p communicator-matrix-gateway --no-default-features --quiet
cargo fmt --all -- --check
cargo clippy -p communicator-matrix-gateway --tests --no-default-features -- -D warnings
git diff --check
```

The full package suite needs permission to bind local loopback ports for its mock Matrix server. One pre-existing privileged ownership test may remain intentionally ignored. Every other test must pass.

- [ ] **Step 7: Two-stage review and commit**

Specification review must trace every requirement above to code and a material assertion. Code-quality/security review must independently inspect ciphertext AAD, exact-byte idempotency ordering, full-chain verification, timestamp monotonicity, rollback behavior, memory ownership, bounded allocation, and test false positives.

After both gates pass and any fixes are re-reviewed:

```bash
git add services/matrix-gateway/src/store.rs \
        services/matrix-gateway/src/store_types.rs \
        services/matrix-gateway/tests/sync_inbox_transactions.rs
git commit -m "feat: add crash-safe sync inbox"
```

## Completion evidence

This child plan is complete only when both commits exist, the branch is clean, the two-stage review for each task has no open Critical/Important/Moderate finding, the complete matrix-gateway package suite exits 0 with loopback enabled, clippy runs with warnings denied, formatting and `git diff --check` pass, and tests prove no protected bootstrap/token/response plaintext exists in SQLite database, WAL, or SHM bytes.
