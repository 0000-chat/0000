# Communicator Matrix Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a crash-safe, E2EE-capable Matrix Gateway on the Contabo VPS that turns explicitly mapped Synapse events into the existing one-tenant archive-first Cloudflare ingestion batches.

**Architecture:** A single Rust process owns persistent Matrix SDK SQLite stores and an application SQLite database. Bootstrap uses the high-level SDK client. The daemon uses a bounded raw Ruma HTTP transport and a public `BaseClient`; it never calls high-level `sync_once`. It encrypts and fsyncs each exact `/sync` response before SDK processing, reconstructs interrupted processing from that inbox, normalizes supported events, and retries exact Matrix-crypto and Cloudflare requests. The service never reads Synapse or mautrix databases, never exposes a host port, and never advances the application checkpoint past an unaccepted batch.

**Tech Stack:** Rust 2024 edition, `matrix-sdk` 0.18 with `e2e-encryption` and bundled SQLite, Tokio, rusqlite, serde/serde_json, XChaCha20-Poly1305, SHA-256/HMAC, reqwest/rustls, Docker Compose, existing TypeScript canonical contracts, Python repository contract tests.

---

## Mandatory worker protocol

Every task below is implemented by a fresh `gpt-5.6-luna` worker with
`reasoning_effort=max` and `fork_turns=none`. The worker must:

1. Work only in `/home/ubuntu/communicator/.worktrees/matrix-gateway`.
2. Read `/home/ubuntu/communicator/AGENTS.md`, the gateway design, the task text
   supplied by the orchestrator, and the exact repository source/tests/package
   manifests named in that task. Do not perform an unrelated repository audit.
3. Use test-driven development: red test, minimal implementation, green test.
4. Run the exact task checks and inspect `git diff --check`.
5. Commit only the task files with the specified commit message.
6. Report `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`, the
   commit SHA, checks run, and files changed.

After each implementation commit, the orchestrator dispatches a fresh Luna/max
spec reviewer and then a fresh Luna/max code-quality reviewer. Open findings go
back to the same implementer and are re-reviewed before the next task starts.
No worker deploys, changes DNS, accesses live Matrix credentials, or mutates
Cloudflare unless an operational task explicitly authorizes it.

## Fixed cross-task contracts

Use these constants and names everywhere; do not rename them locally:

```rust
pub const GATEWAY_SCHEMA_VERSION: i64 = 1;
pub const CANONICAL_SCHEMA_VERSION: u8 = 1;
pub const MAX_BATCH_EVENTS: usize = 500;
pub const MAX_BATCH_CANONICAL_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_EVENT_CANONICAL_BYTES: usize = 1024 * 1024;
pub const MAX_SYNC_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_KEY_RECOVERY_WINDOWS: u64 = 16;
pub const MAX_KEY_RECOVERY_AGE_SECS: u64 = 10 * 60;
pub const MAX_PENDING_REQUEST_ROWS: u64 = 2_000;
pub const MAX_RECOVERY_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PENDING_AGE_SECS: u64 = 24 * 60 * 60;
pub const ACCEPTED_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;
pub const INGESTION_PATH: &str = "/internal/v1/ingestion/batches";
pub const PRODUCER_VERSION: &str = concat!("matrix-gateway/", env!("CARGO_PKG_VERSION"));
```

Protected values never appear in `Debug`, `Display`, tracing fields, CLI error
chains, or health output. Protected values include message bodies, room/event/
user IDs, endpoint URLs, Matrix/OAuth tokens, passwords, request bytes,
checkpoints, mapping payloads, encryption keys, and upstream exception text.

## Planned file map

```text
Cargo.toml                                  Rust workspace and shared profiles
Cargo.lock                                  exact transitive dependency lock
rust-toolchain.toml                         pinned stable toolchain
services/matrix-gateway/Cargo.toml          exact dependency/features
services/matrix-gateway/src/main.rs         CLI entry and signal handling
services/matrix-gateway/src/lib.rs          public module boundary
services/matrix-gateway/src/matrix_spike.rs Task 1 raw-sync/recovery spike, replaced in Task 9
services/matrix-gateway/src/config.rs       strict protected config parsing
services/matrix-gateway/src/secret.rs       exact bounded mode-0600 reads
services/matrix-gateway/src/protected.rs    redacted wrappers/errors/log fields
services/matrix-gateway/src/crypto.rs       XChaCha/HMAC/key-version operations
services/matrix-gateway/src/model.rs        canonical and Matrix-neutral structs
services/matrix-gateway/src/canonical.rs    canonical JSON, IDs, batch identity
services/matrix-gateway/src/store.rs        SQLite transactions and migrations
services/matrix-gateway/src/store_types.rs  validated ledger DTOs and lifecycle enums
services/matrix-gateway/src/registry.rs     append-only room ownership registry
services/matrix-gateway/src/normalize.rs    Matrix-neutral event normalization
services/matrix-gateway/src/ingestion.rs    OAuth and exact HTTP delivery
services/matrix-gateway/src/matrix.rs       SDK bootstrap/BaseClient processing adapter
services/matrix-gateway/src/matrix_http.rs  bounded raw Ruma HTTP transport
services/matrix-gateway/src/service.rs      sync-window/outbox state machine
services/matrix-gateway/src/health.rs       content-free local health probe
services/matrix-gateway/src/admin.rs        bootstrap/registry/backfill commands
services/matrix-gateway/tests/*.rs          focused and failure-matrix tests
services/matrix-gateway/testdata/*.json     golden cross-language fixtures
apps/control-plane/worker/test/ingestion/gateway-vector.test.ts cross-language guard
services/matrix-gateway/Dockerfile          pinned reproducible multi-stage build
scripts/init-matrix-gateway-runtime.sh      root-provisioned gateway-owned state/secrets
scripts/validate-matrix-gateway.sh          safe local/remote validation
scripts/backup-core.sh                      include gateway state and secrets
scripts/restore-core-test.sh                offline restored-store verification
compose.yaml                                private gateway service
deploy/images.lock.env                      pinned gateway image reference
docs/runbooks/matrix-gateway-operations.md  bootstrap, mapping, recovery, backfill
docs/runbooks/matrix-gateway-local-acceptance.md final local evidence procedure
tests/test_matrix_gateway_contract.py       repository/runtime safety assertions
package.json                                Rust quality-gate wrappers
README.md                                   operator entrypoint
```

### Task 1: Freeze toolchain, SDK APIs, and cross-language contract vectors

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `services/matrix-gateway/Cargo.toml`
- Create: `services/matrix-gateway/src/main.rs`
- Create: `services/matrix-gateway/src/lib.rs`
- Create: `services/matrix-gateway/src/matrix_spike.rs`
- Create: `services/matrix-gateway/tests/matrix_sdk_compile.rs`
- Create: `services/matrix-gateway/testdata/ingestion-contract-v1.json`
- Create: `apps/control-plane/worker/test/ingestion/gateway-vector.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the failing cross-language fixture test**

Create a committed fixture containing a complete valid `message.created` event,
the sorted canonical JSONL text, `canonical_sha256`, checkpoint digest,
`archived_at`, `producer_version`, and expected `batch_id`. Add a Vitest that
loads the fixture and proves the existing `encodeCanonicalEventBatch` and
`recomputeIngestionBatchId` reproduce every expected byte and digest.

```ts
const encoded = await encodeCanonicalEventBatch({
  tenantId: fixture.request.tenant_id,
  events: fixture.request.events,
});
expect(new TextDecoder().decode(encoded.canonicalJsonl)).toBe(fixture.canonical_jsonl);
expect(encoded.canonicalSha256).toBe(fixture.canonical_sha256);
expect(await recomputeIngestionBatchId(fixture.request, encoded.canonicalSha256))
  .toBe(fixture.request.batch_id);
```

- [ ] **Step 2: Run the fixture test red**

Run: `pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/gateway-vector.test.ts`
Expected: FAIL because the fixture and test integration do not yet exist.

- [ ] **Step 3: Add the Rust workspace and prove the recovery boundary**

Pin Rust `1.93.0` in `rust-toolchain.toml` (matrix-sdk 0.18's declared minimum).
Use edition 2024, resolver 2, deny unsafe code, strip release binaries, and
commit `Cargo.lock`. Pin `matrix-sdk = "=0.18.0"` with
`default-features = false` and exact features
`["e2e-encryption", "sqlite", "bundled-sqlite"]`. The published 0.18.0
`matrix-sdk` crate has no TLS feature flag: on non-Wasm targets it already
depends on reqwest with its `rustls` feature, so do not copy the separate
`matrix-sdk-ffi` crate's `rustls-aws-lc-rs` forwarding feature. Add matching
pins for the public `matrix-sdk-base`, `matrix-sdk-sqlite`, `matrix-sdk-crypto`,
`matrix-sdk-common`, and `matrix-sdk-test` crates used by the daemon and offline
tests.

The compile spike must prove these exact boundaries:

```rust
let state = matrix_sdk_sqlite::SqliteStateStore::open(state_path, Some(passphrase)).await?;
let crypto = matrix_sdk_sqlite::SqliteCryptoStore::open(crypto_path, Some(passphrase)).await?;
let base = matrix_sdk_base::BaseClient::new(
    matrix_sdk_base::store::StoreConfig::new(
        matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::SingleProcess,
    )
        .state_store(state)
        .crypto_store(crypto),
    matrix_sdk_base::ThreadingSupport::Disabled,
    matrix_sdk_base::DmRoomDefinition::default(),
);
base.activate(session_meta, RoomLoadSettings::default(), None).await?;
let processed = base.receive_sync_response(typed_response).await?;
let olm = base.olm_machine().await;
```

Also compile Ruma `OutgoingRequest::try_into_http_request` for a v3 sync request
and `IncomingResponse::try_from_http_response` for its response. The production
transport must be able to keep the untouched bounded response body before it
constructs the typed response.

The tests prove `SessionTokens` and `MatrixSession` can be serialized and
restored without printing them. They also pin the reason the daemon must not
use high-level sync: process a response, reopen the same SDK store, ask a
high-level client for the old token, and assert that the SDK suppresses the
already-stored response rather than exposing the event twice.

Add one no-network E2EE recovery test using the upstream Matrix test fixtures.
Process a to-device room key and encrypted room event with `BaseClient`, verify
the plaintext, drop every client handle, reopen the same passphrase SQLite
stores and session, and decrypt the original saved raw encrypted timeline event
directly through the restored `OlmMachine`. Assert the same event ID, sender,
room ID, type, and body. Simulate the internal partial-commit case by applying
the crypto changes while leaving the state-store sync token old, then reapply
the saved response. Assert that this produces the same decrypted event and
finishes at the expected SDK token.

Pin the daemon's crypto-request policy with negative tests. Prove that
`KeysUpload` can receive a fresh SDK request ID across enumeration/reopen and
that `KeysClaim` is not safe to recreate after response loss. Also prove that a
second SDK 0.18 KeysQuery enumeration can replace the prior in-memory request
ID. The receive-only daemon must never generate `KeysClaim`, `ToDevice`,
verification, room-message, signing-key, signature, or backup requests. It
handles one KeysQuery at a time through the encrypted
response-acknowledgement state machine and matches a post-restart replacement
by canonical body digest. It treats `KeysUpload` as an explicit maintenance
condition and never sends it inside the source checkpoint loop. Any other
request kind fails closed with `matrix_crypto_kind_not_allowed`.

This is a mandatory go/no gate. If direct decryption, partial-store replay, or
the request-kind classification cannot be proven, stop Task 1 with `BLOCKED`. Report the exact evidence so the
orchestrator can replace this design with isolated SDK-store generations. Do
not weaken the assertions, use high-level replay, or patch an upstream crate.
The application-wide exclusive lock in Task 4 remains mandatory.

Create `src/main.rs` in this task as a minimal, no-network binary that prints
only the static message `gateway configuration not implemented` to stderr and
exits with code 78. It must not read environment variables, open stores, or
contact any service. Task 5 replaces this compile-only entry with the admin CLI;
Tasks 9 and 10 add daemon startup and the service loop.

- [ ] **Step 4: Add repository commands**

Add these exact root scripts:

```json
{
  "check:rust": "cargo fmt --all --check && cargo clippy --workspace --all-targets --all-features -- -D warnings",
  "test:rust": "cargo test --workspace --all-features"
}
```

Extend `check` and `test` without removing existing package checks.

- [ ] **Step 5: Run green checks**

Run:

```bash
cargo test -p communicator-matrix-gateway --test matrix_sdk_compile
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/gateway-vector.test.ts
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: all four commands PASS; `Cargo.lock` is present; all Matrix tests use
offline upstream fixtures and no DNS or Matrix login occurs.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock rust-toolchain.toml package.json \
  services/matrix-gateway apps/control-plane/worker/test/ingestion/gateway-vector.test.ts
git commit -m "build: freeze matrix gateway sdk contract"
```

### Task 2: Strict configuration, protected values, and secret loading

**Files:**
- Create: `services/matrix-gateway/src/config.rs`
- Create: `services/matrix-gateway/src/secret.rs`
- Create: `services/matrix-gateway/src/protected.rs`
- Create: `services/matrix-gateway/tests/config_security.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write red tests for fail-closed configuration**

Test unknown JSON keys, relative paths, non-HTTPS public endpoints, a homeserver
URL outside `http://synapse:8008`, missing secret files, symlinks, world/group
readable files, embedded NUL, trailing whitespace, oversized files, invalid
base64 keys, and accidental `Debug`/`Display` output. Use canaries and assert no
error string contains them.

```rust
assert_eq!(format!("{:?}", Protected::new("body-canary")), "[REDACTED]");
assert_eq!(format!("{}", Protected::new("token-canary")), "[REDACTED]");
assert_eq!(load_secret(&path, SecretKind::StateKey).unwrap_err().code(),
           "secret_invalid");
```

- [ ] **Step 2: Run the focused tests red**

Run: `cargo test -p communicator-matrix-gateway --test config_security`
Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement strict types and bounded reads**

Define `GatewayConfig` with `#[serde(deny_unknown_fields)]` and only these
fields: `homeserver_url`, `matrix_user_id`, `matrix_store_dir`,
`state_db_path`, `ingestion_base_url`, `oauth_token_url`, `oauth_client_id`,
`oauth_client_auth_method` (`client_secret_basic` or `client_secret_post`),
`matrix_password_file`, `matrix_store_passphrase_file`, `state_key_file`,
`oauth_client_secret_file`, `request_timeout_secs`, `sync_timeout_secs`, and
the fixed backpressure/retention limits. `load_secret` must use `openat`-style
no-follow semantics where available, verify a regular file owned by the
effective gateway UID with mode exactly 0600, cap reads before allocation, remove one final
newline only for text secrets, and zeroize buffers on drop.

```rust
pub enum SecretKind { Text { max_bytes: usize }, StateKey }
pub fn load_secret(path: &Path, kind: SecretKind) -> Result<SecretBytes, SafeError>;

#[derive(Clone)]
pub struct SafeError { code: &'static str }
```

- [ ] **Step 4: Run green and adversarial checks**

Run:

```bash
cargo test -p communicator-matrix-gateway --test config_security
cargo clippy -p communicator-matrix-gateway --all-targets --all-features -- -D warnings
```

Expected: PASS; source scan finds no `unwrap`, `expect`, or derived `Debug` on
secret/session/request/checkpoint types outside tests.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/config_security.rs
git commit -m "feat: add fail-closed gateway configuration"
```

### Task 3: Versioned encryption and deterministic identifiers

**Files:**
- Create: `services/matrix-gateway/src/crypto.rs`
- Create: `services/matrix-gateway/src/model.rs`
- Create: `services/matrix-gateway/src/canonical.rs`
- Create: `services/matrix-gateway/tests/crypto_and_canonical.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write failing crypto and canonical-vector tests**

Cover random nonces, modified ciphertext/tag/AAD/key-version rejection,
zero-length rejection, key separation, deterministic lookup digests,
length-prefixed ID collision resistance, every exact ID tuple from the design,
recursive ECMAScript UTF-16 code-unit key sorting, canonical
newline rules, event ordering `(observed_at, occurred_at, event_id)`, the 1 MiB
event and 4 MiB/500-event limits, and exact agreement with Task 1's fixture.

```rust
let sealed = keyring.seal("room_binding", row_id, plaintext)?;
assert_ne!(sealed.nonce, keyring.seal("room_binding", row_id, plaintext)?.nonce);
assert_eq!(keyring.open("room_binding", row_id, &sealed)?, plaintext);
assert_eq!(batch.request.batch_id, fixture.request.batch_id);
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test crypto_and_canonical`
Expected: FAIL because crypto/canonical modules are absent.

- [ ] **Step 3: Implement the exact primitives**

Use XChaCha20-Poly1305 with a fresh 24-byte OS-random nonce. Derive independent
AEAD and lookup keys from the 32-byte master key with HKDF-SHA256 and domain
labels. Associated data is:

```text
communicator-matrix-gateway\0v1\0<table>\0<row-id>\0<column>\0<key-version>
```

IDs hash a versioned sequence of `u32 big-endian length || UTF-8 bytes`, never
string concatenation. Define `CanonicalEvent`, the 17 exact event type strings,
six source strings, and typed payload enums with `serde(deny_unknown_fields)`.
Use `serde_json::Value` only at the canonical serializer boundary. Sort object
keys by ECMAScript UTF-16 code units, exactly matching JavaScript `.sort()`;
Rust's UTF-8 byte/Unicode-scalar ordering is not equivalent for non-BMP keys.
The gateway's 17 typed projection payloads contain no floating-point fields, so
the Rust boundary rejects floats before serialization; this is a deliberately
narrow valid-input subset of the Worker's generic canonical JSON serializer,
not a different encoding for any projection-valid gateway event.

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p communicator-matrix-gateway --test crypto_and_canonical
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/gateway-vector.test.ts
```

Expected: PASS with byte-identical fixture outputs in both languages.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/crypto_and_canonical.rs
git commit -m "feat: add encrypted gateway primitives"
```

### Task 4: Crash-safe SQLite inbox, registry, outboxes, and checkpoints

**Files:**
- Create: `services/matrix-gateway/src/store.rs`
- Create: `services/matrix-gateway/src/registry.rs`
- Create: `services/matrix-gateway/tests/store_transactions.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write red migration and transaction tests**

Test new/open/current schema, rejected downgrade, exclusive process lock,
append-only mapping history, duplicate active room rejection, cross-tenant
account mutation rejection, encrypted-column canary absence in raw DB bytes,
exact raw-response journaling before any later state, 64 MiB response rejection,
inbox predecessor and token contiguity, SDK-ahead reconciliation, atomic
inbox-to-window/outbox preparation, crypto-outbox replay, partial batch
acceptance, all-batches checkpoint commit with per-room anchor advancement,
zero-event checkpoint commit, corrupt ciphertext fail-closed behavior,
quarantine/retry preserving accepted siblings, registry lifecycle transactions,
explicit/live-gap backfill job lifecycle and page-checkpoint atomicity,
cancellation without row deletion, and accepted-row purge only after seven
days. Include one-unresolved-KeysQuery enforcement, persisted maintenance state
across reopen, verified-only maintenance clearing, terminal crypto quarantine,
and the exact foreign-key-safe purge order with a retained successor.

Use this schema exactly, with CHECK constraints and foreign keys enabled:

```sql
CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version = 1));
CREATE TABLE gateway_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  session_cipher BLOB, session_nonce BLOB, session_key_version INTEGER,
  committed_token_cipher BLOB, committed_token_nonce BLOB,
  committed_token_key_version INTEGER,
  fetch_token_cipher BLOB, fetch_token_nonce BLOB,
  fetch_token_key_version INTEGER,
  maintenance_code TEXT, maintenance_since TEXT,
  bootstrapped_at TEXT, updated_at TEXT NOT NULL,
  CHECK((maintenance_code IS NULL AND maintenance_since IS NULL)
     OR (maintenance_code IN ('crypto_maintenance_required',
                              'matrix_crypto_kind_not_allowed',
                              'matrix_crypto_ack_unrecoverable')
         AND maintenance_since IS NOT NULL))
);
CREATE TABLE room_bindings(
  binding_id TEXT PRIMARY KEY,
  room_lookup BLOB NOT NULL,
  account_lookup BLOB NOT NULL,
  payload_cipher BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, retired_at TEXT,
  CHECK(status IN ('active','retired')),
  CHECK((status='active' AND retired_at IS NULL) OR
        (status='retired' AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_room ON room_bindings(room_lookup)
  WHERE status='active';
CREATE TABLE room_progress(
  room_lookup BLOB PRIMARY KEY,
  anchor_event_cipher BLOB NOT NULL, anchor_event_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE room_ephemeral_state(
  room_lookup BLOB PRIMARY KEY,
  typing_set_cipher BLOB NOT NULL, typing_set_nonce BLOB NOT NULL,
  typing_key_version INTEGER NOT NULL, typing_expires_at TEXT NOT NULL,
  last_committed_inbox_digest BLOB NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sync_inbox(
  inbox_id TEXT PRIMARY KEY, predecessor_id TEXT,
  request_token_cipher BLOB NOT NULL, request_token_nonce BLOB NOT NULL,
  request_token_key_version INTEGER NOT NULL,
  request_token_digest BLOB NOT NULL,
  next_token_cipher BLOB NOT NULL, next_token_nonce BLOB NOT NULL,
  next_token_key_version INTEGER NOT NULL, next_token_digest BLOB NOT NULL,
  response_cipher BLOB NOT NULL, response_nonce BLOB NOT NULL,
  response_key_version INTEGER NOT NULL, response_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 67108864),
  state TEXT NOT NULL, crypto_drained INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL, created_at TEXT NOT NULL,
  sdk_processed_at TEXT, prepared_at TEXT,
  committed_at TEXT, terminal_code TEXT,
  FOREIGN KEY(predecessor_id) REFERENCES sync_inbox(inbox_id),
  CHECK(state IN ('fetched','sdk_processed','prepared','committed','quarantined')),
  CHECK(crypto_drained IN (0,1)),
  UNIQUE(predecessor_id), UNIQUE(next_token_digest)
);
CREATE TABLE sync_windows(
  window_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  batch_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0,
  ignored_count INTEGER NOT NULL, created_at TEXT NOT NULL,
  committed_at TEXT, terminal_code TEXT,
  FOREIGN KEY(inbox_id) REFERENCES sync_inbox(inbox_id),
  CHECK(state IN ('collecting','pending','committed','quarantined'))
);
CREATE TABLE window_room_anchors(
  window_id TEXT NOT NULL, room_lookup BLOB NOT NULL,
  anchor_event_cipher BLOB NOT NULL, anchor_event_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  PRIMARY KEY(window_id, room_lookup),
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id)
);
CREATE TABLE window_room_ephemeral(
  window_id TEXT NOT NULL, room_lookup BLOB NOT NULL,
  typing_set_cipher BLOB NOT NULL, typing_set_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, typing_expires_at TEXT NOT NULL,
  PRIMARY KEY(window_id, room_lookup),
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id)
);
CREATE TABLE backfill_jobs(
  job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, live_window_id TEXT,
  state TEXT NOT NULL,
  parameters_cipher BLOB NOT NULL, parameters_nonce BLOB NOT NULL,
  pagination_cipher BLOB, pagination_nonce BLOB,
  key_version INTEGER NOT NULL, accepted_events INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT,
  terminal_code TEXT,
  FOREIGN KEY(live_window_id) REFERENCES sync_windows(window_id),
  CHECK(kind IN ('explicit','live_gap')),
  CHECK((kind='explicit' AND live_window_id IS NULL)
     OR (kind='live_gap' AND live_window_id IS NOT NULL)),
  CHECK(state IN ('pending','running','completed','cancelled','quarantined'))
);
CREATE TABLE outbox_batches(
  batch_row_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL,
  window_id TEXT, backfill_job_id TEXT,
  ordinal INTEGER NOT NULL, state TEXT NOT NULL,
  request_cipher BLOB NOT NULL, request_nonce BLOB NOT NULL,
  request_key_version INTEGER NOT NULL, request_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, accepted_at TEXT, terminal_code TEXT,
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id),
  FOREIGN KEY(backfill_job_id) REFERENCES backfill_jobs(job_id),
  CHECK(source_kind IN ('live','backfill')),
  CHECK((source_kind='live' AND window_id IS NOT NULL AND backfill_job_id IS NULL)
     OR (source_kind='backfill' AND window_id IS NULL AND backfill_job_id IS NOT NULL)),
  CHECK(state IN ('pending','accepted','quarantined')),
  UNIQUE(window_id, ordinal), UNIQUE(backfill_job_id, ordinal)
);
CREATE TABLE matrix_crypto_outbox(
  crypto_row_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL,
  request_lookup BLOB NOT NULL, request_kind TEXT NOT NULL,
  sdk_request_id_cipher BLOB NOT NULL, sdk_request_id_nonce BLOB NOT NULL,
  sdk_request_id_key_version INTEGER NOT NULL,
  request_cipher BLOB NOT NULL, request_nonce BLOB NOT NULL,
  request_key_version INTEGER NOT NULL, request_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK(byte_count > 0),
  response_cipher BLOB, response_nonce BLOB, response_key_version INTEGER,
  response_sha256 BLOB,
  state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, accepted_at TEXT, terminal_code TEXT,
  FOREIGN KEY(inbox_id) REFERENCES sync_inbox(inbox_id),
  CHECK(request_kind='keys_query'),
  CHECK(state IN ('pending','response_received','accepted','quarantined')),
  CHECK((response_cipher IS NULL AND response_nonce IS NULL
         AND response_key_version IS NULL AND response_sha256 IS NULL)
     OR (response_cipher IS NOT NULL AND response_nonce IS NOT NULL
         AND response_key_version IS NOT NULL AND response_sha256 IS NOT NULL)),
  CHECK((state='pending' AND response_cipher IS NULL AND accepted_at IS NULL)
     OR (state='response_received' AND response_cipher IS NOT NULL AND accepted_at IS NULL)
     OR (state='accepted' AND response_cipher IS NOT NULL AND accepted_at IS NOT NULL)
     OR (state='quarantined' AND terminal_code IS NOT NULL AND accepted_at IS NULL)),
  UNIQUE(inbox_id, request_lookup)
);
CREATE UNIQUE INDEX one_unresolved_crypto_request
  ON matrix_crypto_outbox((1))
  WHERE state IN ('pending','response_received','quarantined');
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test store_transactions`
Expected: FAIL because the store is absent.

- [ ] **Step 3: Implement transaction APIs**

Expose only domain operations; no caller receives a raw connection:

```rust
pub fn initialize_bootstrap_state(&mut self, state: NewBootstrapState)
    -> Result<(), SafeError>;
pub fn matrix_session(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn room_anchor(&self, room_lookup: &[u8])
    -> Result<Option<SecretBytes>, SafeError>;
pub fn append_fetched_sync(&mut self, response: NewRawSyncInbox)
    -> Result<InboxId, SafeError>;
pub fn reconcile_sdk_position(&self, sdk_token_digest: &[u8])
    -> Result<SdkInboxPosition, SafeError>;
pub fn record_sdk_processing(&mut self, inbox_id: &str,
                             requests: &[ExactMatrixRequest])
    -> Result<(), SafeError>;
pub fn next_pending_crypto_request(&self, now: DateTime<Utc>)
    -> Result<Option<PendingMatrixRequest>, SafeError>;
pub fn record_crypto_response(&mut self, row: &str, response: &RawMatrixResponse)
    -> Result<(), SafeError>;
pub fn complete_crypto_request(&mut self, row: &str, accepted_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn quarantine_crypto_request(&mut self, row: &str, code: ReasonCode)
    -> Result<(), SafeError>;
pub fn set_crypto_maintenance(&mut self, code: ReasonCode, at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn clear_crypto_maintenance(&mut self, expected: ReasonCode)
    -> Result<(), SafeError>;
pub fn mark_crypto_drained(&mut self, inbox_id: &str) -> Result<(), SafeError>;
pub fn create_collecting_live_window(&mut self, inbox_id: &str, window: NewWindow)
    -> Result<(), SafeError>;
pub fn finalize_live_window(&mut self, inbox_id: &str, window_id: &str,
                            batches: &[ExactBatch], anchors: &[RoomAnchor],
                            ephemeral: &[RoomEphemeralCandidate])
    -> Result<FinalizeOutcome, SafeError>;
pub fn complete_live_gap_and_finalize_window(
    &mut self, gap_job_id: &str, batches: &[ExactBatch], anchors: &[RoomAnchor]
) -> Result<FinalizeOutcome, SafeError>;
pub fn commit_empty_live_window(&mut self, inbox_id: &str, window_id: &str,
                                anchors: &[RoomAnchor],
                                ephemeral: &[RoomEphemeralCandidate],
                                committed_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn next_pending_batch(&self, now: DateTime<Utc>)
    -> Result<Option<PendingBatch>, SafeError>;
pub fn record_attempt(&mut self, row: &str, next: DateTime<Utc>) -> Result<(), SafeError>;
pub fn accept_live_batch_and_maybe_commit_window(
    &mut self, row: &str, accepted_at: DateTime<Utc>
) -> Result<CommitOutcome, SafeError>;
pub fn accept_backfill_batch_and_maybe_complete_job(
    &mut self, row: &str, accepted_at: DateTime<Utc>
) -> Result<BackfillCommitOutcome, SafeError>;
pub fn quarantine_live_batch(&mut self, row: &str, terminal_code: ReasonCode)
    -> Result<(), SafeError>;
pub fn retry_quarantined_window(&mut self, window_id: &str, retry_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn append_room_binding(&mut self, binding: NewRoomBinding)
    -> Result<(), SafeError>;
pub fn retire_room_binding(&mut self, binding_id: &str, retired_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn active_room_binding(&self, room_lookup: &[u8])
    -> Result<Option<RoomBinding>, SafeError>;
pub fn create_backfill_job(&mut self, job: NewBackfillJob)
    -> Result<(), SafeError>;
pub fn begin_or_resume_backfill_job(&mut self, job_id: &str)
    -> Result<BackfillJob, SafeError>;
pub fn checkpoint_backfill_page(&mut self, job_id: &str,
                                pagination: Option<&SecretBytes>,
                                batches: &[ExactBatch], accepted_events: u64)
    -> Result<(), SafeError>;
pub fn complete_backfill_job(&mut self, job_id: &str, completed_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn cancel_backfill_job(&mut self, job_id: &str, cancelled_at: DateTime<Utc>)
    -> Result<(), SafeError>;
pub fn committed_sync_token(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn fetch_sync_token(&self) -> Result<Option<SecretBytes>, SafeError>;
pub fn oldest_uncommitted_inbox(&self) -> Result<Option<RawSyncInbox>, SafeError>;
pub fn purge_committed_prefix(&mut self, cutoff: DateTime<Utc>,
                              sdk_token_digest: &[u8])
    -> Result<PurgeOutcome, SafeError>;
```

`initialize_bootstrap_state` is the one-shot bridge between Task 9 bootstrap
and the version-1 ledger. It atomically stores the encrypted Matrix session,
the same initial token in both committed and fetch positions, and every
encrypted joined-room anchor. It rejects any existing singleton or anchor and
has no replace, reset, or force path. The detailed DTO, encryption-context,
idempotency, and chain contracts for this operation and `append_fetched_sync`
are frozen in `2026-09-09-communicator-matrix-gateway-sync-inbox.md`.

For registry rows, derive `room_lookup` as the keyed lookup digest over
`room-binding-room-v1, matrix_room_id`. Derive `account_lookup` over
`room-binding-account-v1, platform, account_id`; it deliberately excludes the
claimed tenant authority so an attempt to attach the same provider account to
a different tenant can be detected. The encrypted `payload` contains exactly
the full protected mapping from the design: `matrix_room_id`, `tenant_id`,
`identity_id`, `connection_id`, `account_id`, `platform`, `gateway_route_id`,
`conversation_id`, and `owner_matrix_user_id`, plus `schema_version: 1`.
Before appending a row, decrypt and verify every existing row with the same
`account_lookup`; its immutable `(tenant_id, identity_id, connection_id,
account_id, platform)` authority tuple must match. `binding_id` is a synthetic
`binding_`-prefixed lowercase hexadecimal ID supplied by the administrative
layer. Retirement addresses that exact `binding_id`, changes only an active row
to `retired`, and never deletes or rewrites its protected payload.

`append_fetched_sync` is the first state mutation after an HTTP response. It
verifies that the request token equals the current fetch token, freezes one
UTC-millisecond `observed_at`, encrypts the untouched response bytes and both tokens, links the prior tail row, advances
only the fetch token, and returns only after its `synchronous=FULL` transaction
commits durably. A duplicate exact response returns its
existing row. A different successor for the same request token fails closed.

`reconcile_sdk_position` accepts only the committed token digest or a token in
the contiguous inbox chain. `record_sdk_processing` marks one row processed and
stores at most one allowlisted `/keys/query` request in the same transaction.
Never call `OlmMachine::outgoing_requests` to create or persist a new request
while a non-accepted crypto row exists. The only exception is the restart
rebind below for an already saved `response_received` row. During missing-key
recovery, fully record, send, apply, and acknowledge that query before applying
the next saved sync response. Derive
`request_lookup` from HMAC over the request kind and canonical request body, not
the SDK request ID. Authorization is attached only in memory and is never part
of stored request bytes. A `/keys/upload` request changes health to
`crypto_maintenance_required` without sending it. `/keys/claim`, to-device,
verification, signing, room-message, and backup requests fail closed with
`matrix_crypto_kind_not_allowed`; this receive-only phase never calls APIs that
generate them.
After Matrix returns a valid bounded crypto response, `record_crypto_response`
encrypts the exact response before the adapter applies it to the SDK store.
`complete_crypto_request` runs after the SDK marks the request sent. On restart,
a `pending` row is resent from its exact saved bytes without enumerating the SDK
queue. Startup marks every loaded `pending` or `response_received` row as
needing SDK rebind in process memory. That flag remains set if a resent pending
row transitions to `response_received`. Before acknowledging any
`response_received` row whose flag is set, perform one rebind enumeration. For
a row created and answered in the current process, use the SDK request ID
already held in memory and do not rebind. Rebind occurs before any other SDK
application or enumeration and does not persist a new application row. If the
current query has the same canonical body digest, apply the saved typed response
using that current SDK request ID. This is safe even if SDK 0.18 recreated the
query with a new ID. A crash during rebind may repeat this one rebind on the next
process start. If no matching query remains, the adapter may
complete the row only after it verifies every device key and signature in the
saved response against the restored crypto store. Otherwise it quarantines the
row with `matrix_crypto_ack_unrecoverable`, persists the same code in
`gateway_state`, and stops all source progress. A quarantined crypto row is a
terminal operator condition in this phase; the CLI reports it but offers no
unsafe resend, skip, or force-ack command. It never treats an absent request ID
as acknowledgement. Task 1 and Task 9 prove every branch for the pinned SDK.
`mark_crypto_drained` succeeds only when the SDK reports no outstanding request
and every crypto-outbox row through that inbox is accepted.

`complete_live_gap_and_finalize_window` verifies the job is `kind='live_gap'`,
stores the combined current+gap batches as `source_kind='live'` rows owned by
the linked `sync_window`, stages its anchor candidates, marks the gap job
complete, and moves the live window from `collecting` to `pending` in one
transaction. A live-gap job never owns an `outbox_batches` row.

`quarantine_live_batch` records a bounded reason code on both the batch and its
window without altering accepted siblings or the committed token.
`retry_quarantined_window` is the only recovery transition: it changes that
window atomically from `quarantined` to `pending`, changes its quarantined
batches back to `pending`, clears the window and batch terminal codes, and
leaves already accepted batches untouched. The transaction must reject a
window with no quarantined batch and tests must prove newer sync windows become
eligible only after this atomic transition. There is deliberately no
tombstone, skip, delete, or force-commit API. Registry writes and every
backfill lifecycle/checkpoint transition above are transactions implemented in
this task; Tasks 5 and 11 own their validation and command orchestration.

The live acceptance transaction verifies that this is the oldest uncommitted
inbox row, every crypto row is drained, and every ingestion batch is accepted.
It then applies `window_room_anchors` to `room_progress`, applies staged typing
sets and expiries to `room_ephemeral_state`, copies the inbox next token to the
committed token, and marks the inbox and window committed in one transaction.
The backfill acceptance transaction accepts only
`kind='explicit'`, updates only that explicit job, and never touches
`gateway_state`, `sync_inbox`, or `room_progress`. `commit_empty_live_window`
applies the same ordered inbox, token, crypto, and anchor rules without a
nonexistent ingestion batch row.

Acquire an exclusive OS advisory lock file before opening SQLite; use WAL,
`synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5s`, and explicit
transactions. Verify ciphertext before every state transition. Keep committed
inbox, crypto-outbox, and ingestion-outbox ciphertext for seven days. Purge
only a committed contiguous prefix and never purge a row referenced by the SDK
token. `purge_committed_prefix` first verifies that every selected inbox and
window is committed, every selected crypto and ingestion row is accepted, and
every linked live-gap job is terminal. In one transaction it sets the oldest
retained inbox row's `predecessor_id` to `NULL`, then deletes selected
`window_room_anchors`, `window_room_ephemeral`, live `outbox_batches`, linked
terminal live-gap `backfill_jobs`, `sync_windows`, `matrix_crypto_outbox`, and
finally `sync_inbox` rows newest-to-oldest in that order. The transaction never
uses an unordered bulk delete for the self-referencing inbox rows. It rolls back
on any unexpected child row. It never deletes the newest committed inbox row. Tests cover a retained
successor, linked live-gap rows, and foreign-key validation after reopen.

- [ ] **Step 4: Run green**

Run: `cargo test -p communicator-matrix-gateway --test store_transactions`
Expected: PASS, including kill/reopen simulations and raw-file canary scans.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/store_transactions.rs
git commit -m "feat: add gateway recovery ledger"
```

### Task 5: Room mapping administration and tenant isolation

**Files:**
- Create: `services/matrix-gateway/src/admin.rs`
- Create: `services/matrix-gateway/tests/registry_admin.rs`
- Create: `services/matrix-gateway/testdata/room-binding-valid.json`
- Modify: `services/matrix-gateway/src/main.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write failing CLI contract tests**

Test `registry add`, `registry retire`, and `registry list-summary` with strict
stdin/file JSON. Reject unknown fields, invalid Matrix/Communicator IDs,
unsupported platform, reused active room, account ownership drift, symlinks,
stdin on a TTY, and secret values in stdout/stderr. The add document is exactly:

```json
{
  "schema_version": 1,
  "matrix_room_id": "!portal:communicator.0000.gold",
  "tenant_id": "tenant_personal",
  "identity_id": "identity_human",
  "connection_id": "connection_human_whatsapp",
  "account_id": "account_human_whatsapp",
  "platform": "whatsapp",
  "gateway_route_id": "gateway_route_contabo",
  "conversation_id": "conversation_human_whatsapp_family",
  "owner_matrix_user_id": "@human:communicator.0000.gold"
}
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test registry_admin`
Expected: FAIL because the commands are absent.

- [ ] **Step 3: Implement offline-only administration**

The service must refuse registry mutation while the daemon lock is held.
`list-summary` returns only counts by provider/status, never room/account IDs.
Retirement accepts the binding's synthetic `binding_id` from a protected input
file and a bounded reason code; it never deletes mapping history.

- [ ] **Step 4: Run green and privacy scan**

Run:

```bash
cargo test -p communicator-matrix-gateway --test registry_admin
rg -n 'println!|eprintln!|tracing::(trace|debug|info|warn|error)!' \
  services/matrix-gateway/src
```

Expected: PASS; every logging call contains only allowlisted fields.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/registry_admin.rs \
  services/matrix-gateway/testdata/room-binding-valid.json
git commit -m "feat: add protected room registry"
```

### Task 6: Matrix-neutral normalization for messages, relations, and metadata

**Files:**
- Create: `services/matrix-gateway/src/normalize.rs`
- Create: `services/matrix-gateway/tests/normalization.rs`
- Create: `services/matrix-gateway/testdata/matrix-events/*.json`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Add failing table-driven fixture tests**

Fixtures cover inbound/outbound text, notice, emote, HTML fallback to plain
body, replies, edits, redactions, reaction add/remove, image/file/audio/video
metadata, room name/topic changes, membership/profile changes, read receipts,
typing replacement/start/stop/replay/expiry, unknown room, unknown sender, encrypted undecryptable event,
limited timeline, unsupported message type, missing relation target, oversized
body, invalid timestamp, duplicate Matrix event, and mixed tenants.

```rust
let outcome = normalize(input, &binding, &known_relations, observed_at);
assert_eq!(outcome.events, expected.events);
assert_eq!(outcome.reason_code, expected.reason_code);
assert!(!format!("{outcome:?}").contains("message-canary"));
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test normalization`
Expected: FAIL because normalization is absent.

- [ ] **Step 3: Implement a Matrix-neutral input boundary**

Define a closed enum so SDK version details remain in `matrix.rs`:

```rust
pub enum ObservedMatrixEvent {
    Message(MatrixMessage),
    Redaction(MatrixRedaction),
    Reaction(MatrixReaction),
    Receipt(MatrixReceipt),
    Typing(MatrixTyping),
    RoomState(MatrixRoomState),
    Membership(MatrixMembership),
    UnableToDecrypt(MatrixUnableToDecrypt),
    Unsupported { reason_code: &'static str },
}

pub struct MatrixUnableToDecrypt {
    pub protected_retry_material: ProtectedBytes,
    pub reason_code: &'static str,
}

pub enum NormalizeOutcome {
    Events(Vec<ProjectionEventEnvelope>),
    RetryWindow { reason_code: &'static str },
    SourceGap { protected_prev_batch: ProtectedBytes },
    Ignored { reason_code: &'static str },
}
```

Normalization returns the shared `NormalizeOutcome` and performs no I/O.
Generate deterministic resource IDs from Task 3. Never derive an ID from body,
display name, or timestamp. Emit `message.created` before its
`attachment.observed` siblings, then let canonical batch sorting establish the
wire order. `UnableToDecrypt` returns
`RetryWindow { reason_code: "matrix_unable_to_decrypt" }`; a limited timeline
returns `SourceGap` with only protected pagination material. Neither outcome
may create an empty successful window or advance the source checkpoint.

Treat a receipt or typing payload as one ephemeral replacement snapshot from a
specific saved inbox response. A receipt uses its deterministic target, sender,
and type identity. Typing compares the new member set with the encrypted prior
committed set for that room, emits only deterministic starts and stops, and
sets expiry to the inbox row's frozen `observed_at` plus 30 seconds. Store the
candidate set and expiry with the window, then apply them only in the final
inbox commit transaction. A `typing.started` payload carries `expires_at`; the
projection and UI treat a past expiry as not typing even if no later stop
snapshot arrives. Replaying the same inbox response uses the same
`observed_at`, prior state, IDs, and expiry. Tests and documentation must state
that Matrix cannot recover an ephemeral state that Synapse never included in a
sync response.

- [ ] **Step 4: Run green and TypeScript validation**

Write every Rust fixture output to an in-memory JSON value and validate the
same committed expected output through `ProjectionEventEnvelopeSchema` in the
Task 1 Vitest. Run:

```bash
cargo test -p communicator-matrix-gateway --test normalization
pnpm --filter @communicator/control-plane test:worker -- gateway-vector.test.ts
```

Expected: PASS; all emitted event families satisfy the current TS schema.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/normalization.rs \
  services/matrix-gateway/testdata/matrix-events
git commit -m "feat: normalize matrix events"
```

### Task 7: Deterministic partitioning and exact batch construction

**Files:**
- Create: `services/matrix-gateway/src/batch.rs`
- Create: `services/matrix-gateway/tests/batching.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write failing batching tests**

Cover empty windows, tenant+route partitioning, stable UTF-8 partition order,
event ordering by `(observed_at, occurred_at, generated ASCII event_id)`,
500-event split, just-below/at/above 4 MiB split, one oversized
event quarantine, pre-request duplicate event collapse only when canonical bytes
match, duplicate-ID conflict quarantine before encoding, deterministic `archived_at`, checkpoint
digest, exact request bytes, and re-run identity.

```rust
let first = build_window(sync.clone(), fixed_clock, &events)?;
let second = build_window(sync, fixed_clock, &events)?;
assert_eq!(first.exact_request_bytes(), second.exact_request_bytes());
assert!(first.batches.iter().all(|b| b.one_tenant_and_route()));
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test batching`
Expected: FAIL because the batch builder is absent.

- [ ] **Step 3: Implement the frozen identity algorithm**

Canonical JSONL is canonical-event JSON plus LF for each sorted event. Compute
`canonical_sha256`, then canonicalize this exact object with recursively sorted
keys and compact JSON:

```json
{
  "archived_at":"<RFC3339 milliseconds UTC>",
  "canonical_sha256":"<64 lowercase hex>",
  "gateway_route_id":"<route>",
  "producer_version":"matrix-gateway/<version>",
  "schema_version":1,
  "source_checkpoint":{"kind":"<checkpoint-kind>","value":"sha256:<digest>"},
  "tenant_id":"<tenant>"
}
```

`batch_id = "batch_" + sha256(identity_bytes)`. Then construct and compactly
serialize the strict request object. Reparse it into the typed Rust request and
verify its ID before it can enter the outbox. The final request always contains
unique event IDs; duplicate collapse is a gateway preprocessing rule and does
not relax the Worker's reject-all-duplicates contract.

For live windows and live gap-fill, `checkpoint-kind` is exactly
`matrix_sync_token_sha256` and the digest is over the raw next-batch token. For
an explicit backfill it is exactly `matrix_backfill_run_sha256`; its digest is
SHA-256 over the length-prefixed tuple
`matrix-backfill-checkpoint-v1, job-id, room-id, start-at-rfc3339-ms,
end-at-rfc3339-ms, max-events-decimal, batch-ordinal-decimal`. The job ID is a
new UUIDv7 for each operator-requested run and is reused on crash/resume. Thus a
resumed job reproduces byte-identical batch identities, while a separately
requested overlapping run creates a distinct immutable R2 batch whose event
IDs still converge in the tenant projection. Neither raw pagination nor raw
sync tokens enter the request.

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p communicator-matrix-gateway --test batching
pnpm --filter @communicator/control-plane test:worker -- gateway-vector.test.ts
```

Expected: PASS, including exact cross-language bytes/digests.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/batching.rs
git commit -m "feat: build deterministic ingestion batches"
```

### Task 8: OAuth client credentials and byte-exact ingestion delivery

**Files:**
- Create: `services/matrix-gateway/src/ingestion.rs`
- Create: `services/matrix-gateway/tests/ingestion_client.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write failing HTTP-state tests with an in-process fake**

Test client-credentials form encoding, Basic versus body authentication as one
explicit config enum, token caching only in memory, refresh skew, token type,
bounded response body, redirect rejection, TLS-only URLs, request headers,
identical retry bytes, matching 202 response, `created` and
`already_committed`, mismatched tenant/batch, 400/404/409/413 terminal, one 401
refresh, repeated 401 pause, bounded 429 `Retry-After`, 5xx/network/timeout
retry, and canary-free logs/errors.

```rust
assert_eq!(captured[0].body, captured[1].body);
assert_eq!(captured[0].headers.content_encoding, "identity");
assert_eq!(client.deliver(batch).await?, Delivery::Accepted);
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test ingestion_client`
Expected: FAIL because the client is absent.

- [ ] **Step 3: Implement narrow interfaces**

```rust
#[async_trait]
pub trait TokenProvider: Send + Sync {
    async fn bearer(&self, force_refresh: bool) -> Result<SecretString, SafeError>;
}

#[async_trait]
pub trait BatchSink: Send + Sync {
    async fn deliver(&self, batch: &PendingBatch) -> Result<Delivery, DeliveryError>;
}
```

Disable redirects, cap token and ingestion response bodies at 64 KiB, set total
request timeouts, accept only `application/json`, parse strict response fields,
and discard upstream error bodies. Never reconstruct a pending request from
parsed events; send the decrypted outbox bytes unchanged.

- [ ] **Step 4: Run green**

Run: `cargo test -p communicator-matrix-gateway --test ingestion_client`
Expected: PASS; response-loss test captures byte-identical retries.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/ingestion_client.rs
git commit -m "feat: deliver gateway batches safely"
```

### Task 9: Persistent Matrix E2EE bootstrap and raw-sync adapter

**Files:**
- Replace: `services/matrix-gateway/src/matrix_spike.rs`
- Create: `services/matrix-gateway/src/matrix.rs`
- Create: `services/matrix-gateway/src/matrix_http.rs`
- Create: `services/matrix-gateway/tests/matrix_adapter.rs`
- Modify: `services/matrix-gateway/src/admin.rs`
- Modify: `services/matrix-gateway/src/lib.rs`
- Modify: `services/matrix-gateway/src/main.rs`

- [ ] **Step 1: Write failing adapter tests around transport and processor fakes**

Test no-session startup failure, bootstrap creates exactly one device/session,
bootstrap discards initial history while storing the same token as committed and
fetch positions, restoration uses the same user/device/stores, wrong store
passphrase fails closed, no automatic re-login, raw sync uses only the gateway
fetch token, 64 MiB body cap, redirect rejection, response bytes remain exact,
response persistence occurs before the processor fake is called, joined-room
event extraction, invited/left room rejection, and limited-timeline gap
handling.

Test the recovery cases separately: SDK at the request token processes the
saved response; SDK at that response's next token uses direct raw extraction
and restored-Olm decryption; SDK at a later token is accepted only when every
intervening inbox row is contiguous; an unknown SDK token fails closed. Test a
missing-key head response that journals later key-only and event-bearing
responses, decrypts the head after a naturally delivered key arrives,
and prepares and commits every window in source order. Prove an invited room,
unknown room, or unable-to-decrypt event cannot create an empty successful
window or advance the committed token.

```rust
#[async_trait]
pub trait MatrixTransport: Send + Sync {
    async fn fetch_sync(&self, since: &SecretBytes) -> Result<RawSync, SafeError>;
    async fn send_crypto(&self, request: &PendingMatrixRequest)
        -> Result<RawMatrixResponse, SafeError>;
    async fn backfill_page(&self, request: BackfillPageRequest)
        -> Result<RawBackfillPage, SafeError>;
}

#[async_trait]
pub trait MatrixProcessor: Send {
    fn sdk_token_digest(&self) -> Result<Option<TokenDigest>, SafeError>;
    async fn apply_saved_sync(&mut self, response: &RawSyncInbox)
        -> Result<ProcessedSync, SafeError>;
    async fn recover_saved_sync(&mut self, response: &RawSyncInbox)
        -> Result<ProcessedSync, SafeError>;
    async fn pending_crypto_requests(&self)
        -> Result<Vec<ExactMatrixRequest>, SafeError>;
    async fn apply_crypto_response(&mut self, request: &PendingMatrixRequest,
                                   response: &RawMatrixResponse)
        -> Result<CryptoAckProof, SafeError>;
}
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test matrix_adapter`
Expected: FAIL because the production adapter is absent.

- [ ] **Step 3: Implement bootstrap, bounded raw transport, and BaseClient**

Bootstrap alone builds a high-level `Client` with
`.sqlite_store(path, Some(passphrase))`. It logs in with one fixed display name,
stores the encrypted `MatrixSession`, performs one bounded initial sync, writes
the same `next_batch` to the committed and fetch token fields, stores encrypted
last-event room anchors through `Store::initialize_bootstrap_state`, and closes
the client. Normal daemon startup never
constructs a high-level sync loop. It opens `SqliteStateStore` and
`SqliteCryptoStore`, activates a public `BaseClient` with the saved session
metadata, and maps restoration errors to stable codes without falling back to
login.

Implement sync and history requests with Ruma request types and
`OutgoingRequest::try_into_http_request`. Send them through a reqwest client
with redirects disabled, fixed connect/total timeouts, TLS-only configured
homeserver URLs, and a streaming 64 MiB response limit. Keep Authorization in
memory. Return the untouched response bytes plus a separately parsed typed
response. The service, not this adapter, must call `append_fetched_sync` and
receive its committed result before it calls `apply_saved_sync`.

`apply_saved_sync` parses the saved bytes and calls
`BaseClient::receive_sync_response`, which processes to-device events and
device-list changes before room timelines. It converts the processed response
into the closed `ObservedMatrixEvent` enum and enumerates every
`OlmMachine::outgoing_requests` item. Accept only `KeysQuery`, serialize it
through Ruma, and preserve both its current SDK request ID and a stable
canonical-body digest. Treat `KeysUpload` as maintenance-required and reject
every other request kind. `recover_saved_sync` parses plaintext,
state, receipt, and typing envelopes from the raw response and decrypts saved
encrypted timeline events directly through the restored `OlmMachine`. It does
not call `receive_sync_response` for a token the SDK has already applied.

The adapter never takes its fetch position from the SDK store. Before work, it
calls `reconcile_sdk_position`. The accepted positions are the application
committed token or any next token in the contiguous encrypted inbox. No digest
match means `matrix_sdk_position_unjournaled` and no network call.

If the oldest response still has an unable-to-decrypt event, the service may
fetch and journal up to 16 later responses or ten minutes of responses,
whichever comes first. Apply each to the SDK in order to receive naturally
delivered to-device keys, but retain all durable and ephemeral raw events in
their inbox rows. This phase does not request room keys and never calls
`get_missing_sessions`. Retry direct decryption of the oldest response after
each key update. Exhaustion quarantines the head with
`matrix_key_recovery_exhausted`; it never skips or commits it.

For a limited joined-room timeline, use a raw Ruma messages request paginated
backward from `prev_batch` until the stored room anchor appears. Do not treat an
empty chunk as completion when an `end` token exists. Persist pagination after
each page, cap the combined gap at 90 days or 100,000 source events, and return
a source-gap terminal state when the anchor is not found.

- [ ] **Step 4: Run green and offline guarantee**

Run:

```bash
cargo test -p communicator-matrix-gateway --test matrix_adapter
cargo test -p communicator-matrix-gateway --all-features
```

Expected: PASS using fakes and upstream fixtures only; tests make no DNS or
external network request.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/matrix_adapter.rs
git commit -m "feat: add recoverable matrix e2ee adapter"
```

### Task 10: Service loop, retries, checkpoint advancement, and backpressure

**Files:**
- Create: `services/matrix-gateway/src/service.rs`
- Create: `services/matrix-gateway/src/health.rs`
- Create: `services/matrix-gateway/tests/service_failure_matrix.rs`
- Modify: `services/matrix-gateway/src/main.rs`
- Modify: `services/matrix-gateway/src/lib.rs`

- [ ] **Step 1: Write failing state-machine tests**

Cover: one message success; crash before raw-inbox commit; crash after inbox
commit but before SDK processing; crash after crypto-store commit but before
the SDK state-store token commit; crash after full SDK processing but before
application preparation; crash after a crypto response is durably recorded but
before SDK acknowledgement; crash after SDK acknowledgement but before local
crypto-row completion, with both the matching-query and verified-device-state
recovery branches; crash after window preparation; crash after R2/Queue acceptance but
before local acceptance; unknown SDK token; corrupt inbox; two tenants where
one is delayed; terminal sibling quarantine; duplicate/reordered Matrix events;
empty window; network outage; OAuth outage; 401 refresh; 429; 5xx; response
loss; missing-key recovery through later journaled syncs; recovery-window bound;
replacement of a KeysQuery SDK request ID after restart; global serialization
of KeysQuery enumeration and acknowledgement during missing-key recovery;
limited-timeline source gap; corrupt outboxes; inbox/outbox batch, byte, and age
backpressure; graceful SIGTERM while fetching, processing, delivering, and
idle; seven-day committed-prefix purge; ephemeral replacement/expiry; and
health transitions. Use a manual clock and deterministic jitter source.

```rust
assert_eq!(store.committed_token()?, token_before);
service.tick().await?;
assert_eq!(sink.requests(), vec![exact.clone(), exact]);
assert_eq!(store.committed_token()?, token_after);
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test service_failure_matrix`
Expected: FAIL because orchestration is absent.

- [ ] **Step 3: Implement inbox-first, source-ordered orchestration**

On startup, open and verify both stores, restore the Matrix session, and compare
the SDK token digest with the committed token and contiguous inbox chain. Fail
closed if it matches neither. Each loop iteration performs one durable action:
append a fetched raw response; apply or recover the oldest unprepared inbox;
persist one SDK crypto request; deliver the eligible crypto request; mark a
crypto set drained; prepare one source-ordered ingestion window; deliver its
oldest eligible batch; commit its accepted head window; purge an eligible
seven-day-old committed prefix; or wait until the next retry/sync deadline.

Normal operation does not fetch a new Matrix response while an older response
is unprepared, pending, or quarantined. The only exception is bounded E2EE key
recovery. While the head has an unable-to-decrypt event, the service may append
and SDK-process a contiguous chain of at most 16 later responses over at most
ten minutes. It preserves all their room and ephemeral events in the encrypted
inbox and cannot prepare or commit them ahead of the head. After each later
response, it retries direct decryption of the head. Backpressure applies to the
combined inbox and both outboxes.

Serialize the crypto lane globally. Before applying another saved sync
response, finish any existing `pending` or `response_received` KeysQuery row.
Do not enumerate SDK outgoing requests again until that row is accepted or the
gateway has entered its terminal maintenance state. The only permitted call
while a saved row exists is the one restart-rebind enumeration for a
`response_received` row described in Task 4. This rule also applies to each
later response used for bounded missing-key recovery.

Use the application fetch token for raw HTTP. Update it only inside
`append_fetched_sync`. Use the application committed token for source progress.
Update it only when the oldest inbox has drained crypto requests and accepted
all ingestion batches. Never read an SDK token to choose a network position.
If the SDK exposes `KeysUpload`, pause before checkpoint commit with
`crypto_maintenance_required`; never send that non-idempotent request in the
daemon. Any forbidden crypto kind creates a terminal quarantine. The operations
runbook documents fail-closed diagnosis and escalation for this condition. This
phase does not add an automatic upload-recovery command. Activation tests must
begin with no pending upload.
Compute capped exponential delay with full jitter, persist the selected next
attempt time, and make every transition idempotent.

Add `quarantine status`, `quarantine retry --window-id <id>`, `crypto status`,
and `crypto verify-clear-maintenance` admin commands.
`status` prints only opaque local window/batch row IDs, bounded reason codes,
counts, and timestamps. `retry` calls `retry_quarantined_window` after the
operator has fixed the external cause. Tests must prove that retry preserves
accepted siblings, resends exact encrypted Matrix and ingestion request bytes,
and advances the checkpoint only after both outboxes are accepted. `crypto
status` prints the persisted maintenance code plus opaque unresolved crypto row
IDs and states. `crypto verify-clear-maintenance` requires the daemon to be
stopped and the exclusive lock to be held. It restores the SDK store without a
network call and clears `crypto_maintenance_required` only if no KeysUpload or
forbidden request is pending and no crypto row is quarantined. It does not send,
retry, skip, or acknowledge anything. No CLI command may tombstone, skip,
delete, or force-advance a live window or crypto request.

Health output is one JSON line with only:

```json
{"schema_version":1,"status":"healthy","session":"present",
 "inbox_state":"within_limits","outbox_state":"within_limits",
 "maintenance_code":null,"terminal_quarantine":false}
```

`healthcheck` opens local state read-only and never contacts Matrix/Cloudflare.
When `gateway_state.maintenance_code` is set, it returns `status="blocked"`,
copies only that bounded code into `maintenance_code`, sets
`terminal_quarantine=true`, and exits nonzero. The value survives daemon
restart until the verified clear condition above succeeds.

- [ ] **Step 4: Run green**

Run: `cargo test -p communicator-matrix-gateway --test service_failure_matrix`
Expected: PASS for every crash/retry/backpressure case.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/service_failure_matrix.rs
git commit -m "feat: run crash-safe gateway service"
```

### Task 11: Explicit resumable 90-day backfill

**Files:**
- Modify: `services/matrix-gateway/src/admin.rs`
- Modify: `services/matrix-gateway/src/matrix.rs`
- Modify: `services/matrix-gateway/src/service.rs`
- Create: `services/matrix-gateway/tests/backfill.rs`

- [ ] **Step 1: Write failing backfill tests**

Test strict UTC start/end, start before end, maximum 90-day interval, maximum
100,000 accepted source events, one active job, exact active room mapping,
backward page traversal, forward deterministic output, live checkpoint
independence, encrypted pagination checkpoint, crash/resume, overlap/re-run
convergence, end-boundary inclusion/exclusion, relation targets on adjacent
pages, live gap-fill reaching the encrypted room anchor, gap bound exhaustion,
terminal undecryptable page, cancellation that preserves committed batches,
stable `matrix_backfill_run_sha256` identities across crash/resume, and distinct
batch identities for two separately requested overlapping jobs whose canonical
event IDs remain equal.

The live-gap test must assert that reaching the room anchor calls
`complete_live_gap_and_finalize_window`, creates only live-window-owned outbox
rows, and cannot advance the global token until those rows are accepted.

```rust
assert_eq!(store.live_committed_token()?, live_before);
runner.resume(job_id).await?;
assert_eq!(store.live_committed_token()?, live_before);
assert_eq!(sink.event_sources(), vec!["backfill"]);
```

- [ ] **Step 2: Run red**

Run: `cargo test -p communicator-matrix-gateway --test backfill`
Expected: FAIL because the command is absent.

- [ ] **Step 3: Implement `backfill start|resume|status|cancel`**

Input is a protected strict JSON file with `matrix_room_id`, `start_at`,
`end_at`, and `max_events`. Resolve the active registry mapping before creating
the encrypted job. Paginate backward with the SDK room messages API, persist
the next pagination token after each page is incorporated into a durable
window, reverse accepted events into canonical forward order, and use the same
batch/outbox/sink path with `event_source=backfill`. Never modify
`gateway_state.committed_token_*`.

Use the Task 4 job lifecycle APIs. `start` allocates one UUIDv7 job ID and
freezes the validated interval/max-event parameters; `resume` must reuse those
stored values and that same ID. Each durable page transaction calls
`checkpoint_backfill_page`, which encrypts pagination and inserts exact
backfill-owned outbox rows atomically. `cancel` prevents further pagination but
does not remove accepted or pending immutable batches.

- [ ] **Step 4: Run green**

Run: `cargo test -p communicator-matrix-gateway --test backfill`
Expected: PASS, including crash/resume and overlap convergence.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/src services/matrix-gateway/tests/backfill.rs
git commit -m "feat: add controlled matrix backfill"
```

### Task 12: Container, runtime initialization, Compose, and safe validation

**Files:**
- Create: `services/matrix-gateway/Dockerfile`
- Create: `scripts/init-matrix-gateway-runtime.sh`
- Create: `scripts/validate-matrix-gateway.sh`
- Modify: `compose.yaml`
- Modify: `deploy/images.lock.env`
- Create: `tests/test_matrix_gateway_contract.py`

- [ ] **Step 1: Write failing repository/runtime contract tests**

Assert digest-pinned builder/runtime images, non-root runtime user, read-only
root filesystem, dropped capabilities, `no-new-privileges`, bounded memory/CPU,
private `core` network only, no `ports`, fixed healthcheck, exact bind mounts,
mode-0700 data directories, mode-0600 secrets, no secret env values, explicit
service dependency, and init-script idempotency.

- [ ] **Step 2: Run red**

Run: `python3 -m unittest tests.test_matrix_gateway_contract -v`
Expected: FAIL because runtime integration is absent.

- [ ] **Step 3: Implement the hardened runtime**

The runtime container contains only the gateway binary and required CA/timezone
data, runs as a fixed numeric UID/GID, has `/tmp` as bounded tmpfs, mounts
`matrix-store` and `state` read-write, mounts config/secrets read-only, and has
no Docker socket or host namespace access. Compose starts it only after Synapse
is healthy. `validate-matrix-gateway.sh` checks local health, one running
container, no published ports, mounts, ownership, and restart count without
printing paths that contain protected identifiers. It has two explicit modes:
`--offline` validates configuration, permissions, image metadata, and rendered
Compose policy without starting services; `--runtime` validates the single live
container and is used only after a bootstrapped store exists.

- [ ] **Step 4: Run green Compose checks**

Run:

```bash
python3 -m unittest tests.test_matrix_gateway_contract -v
test_runtime=$(mktemp -d /tmp/communicator-gateway-runtime.XXXXXX)
trap 'rm -rf -- "$test_runtime"' EXIT
COMMUNICATOR_RUNTIME_DIR="$test_runtime" ./scripts/init-matrix-gateway-runtime.sh
COMMUNICATOR_RUNTIME_DIR="$test_runtime" \
  ./scripts/validate-matrix-gateway.sh --offline
COMMUNICATOR_RUNTIME_DIR="$test_runtime" \
  docker compose --env-file deploy/images.lock.env config --quiet
docker build --pull=false -f services/matrix-gateway/Dockerfile \
  -t communicator-matrix-gateway:test .
docker image inspect communicator-matrix-gateway:test \
  --format '{{.Config.User}} {{json .Config.Healthcheck.Test}}'
```

Expected: all commands PASS without contacting live services; the inspect line
shows the fixed non-root UID:GID and the gateway's local healthcheck command.
The Python test itself creates a complete synthetic protected config and secret
set beneath its temporary runtime root, invokes both init and offline
validation, asserts directories are 0700/files are gateway-owned 0600, and
always removes the temporary root in `addCleanup`.

- [ ] **Step 5: Commit**

```bash
git add services/matrix-gateway/Dockerfile scripts/init-matrix-gateway-runtime.sh \
  scripts/validate-matrix-gateway.sh compose.yaml deploy/images.lock.env \
  tests/test_matrix_gateway_contract.py
git commit -m "build: containerize matrix gateway"
```

### Task 13: Backup, isolated restore, and operations runbook

**Files:**
- Modify: `scripts/backup-core.sh`
- Modify: `scripts/restore-core-test.sh`
- Modify: `tests/test_backup_core.py`
- Modify: `tests/test_restore_core.py`
- Create: `docs/runbooks/matrix-gateway-operations.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing backup/restore tests**

Require backup staging to stop the gateway before copying the SDK SQLite stores
and the gateway database containing the encrypted raw inbox and both outboxes,
copy the exact protected configuration and secret files, restart all prior
services on every exit path, and remove plaintext staging on success, failure,
signal, and early validation exit. Require isolated restore to use a new runtime
path/project name, mode-correct every restored file, run
`gateway verify-store --offline`, and make zero Matrix/Cloudflare connections.
The restore script must execute the verification binary using the pinned
gateway image with `--network none`; it must never start the restored gateway
service.

- [ ] **Step 2: Run red**

Run:

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
```

Expected: FAIL on missing gateway coverage.

- [ ] **Step 3: Implement backup/restore and the complete runbook**

Document, with exact commands and expected safe outputs: runtime init; secret
creation without shell history; dedicated Matrix user creation; bootstrap;
device verification; registry add/retire; daemon start/stop/health; pending and
quarantine summaries; `crypto_maintenance_required` diagnosis, upload
verification, the exact stopped-daemon `crypto verify-clear-maintenance`
preconditions, and fail-closed escalation; one-batch retry; key rotation; 90-day backfill;
backup/restore; credential revocation; lost-store response; and rollback. State
that deleting the E2EE store/key can permanently remove decryption ability and
requires explicit operator confirmation.

- [ ] **Step 4: Run green documentation and restore checks**

Run:

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
bash -n scripts/backup-core.sh scripts/restore-core-test.sh \
  scripts/init-matrix-gateway-runtime.sh scripts/validate-matrix-gateway.sh
if rg -n 'PLACEHOLDER_MARKER|INCOMPLETE_MARKER|fill in|example-secret|Bearer ' \
  docs/runbooks/matrix-gateway-operations.md README.md; then exit 1; fi
```

Expected: tests and syntax PASS; the final conditional exits 0 because no
unsafe incomplete marker or credential example is present.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup-core.sh scripts/restore-core-test.sh \
  tests/test_backup_core.py tests/test_restore_core.py \
  docs/runbooks/matrix-gateway-operations.md README.md
git commit -m "docs: operationalize matrix gateway"
```

### Task 14: Full local acceptance, security review, and merge-ready evidence

**Files:**
- Create: `services/matrix-gateway/tests/end_to_end.rs`
- Create: `docs/runbooks/matrix-gateway-local-acceptance.md`
- Modify: implementation only when a failing acceptance test proves a defect

- [ ] **Step 1: Add one deterministic end-to-end harness**

Use fake Matrix and OAuth/ingestion servers plus real encrypted gateway and SDK
SQLite stores. The test must run this exact sequence: bootstrap-now; add two
room mappings for two tenants; fetch an exact response containing encrypted
fixture events; persist and fsync its raw bytes; crash after SDK processing but
before application preparation; restart and decrypt the saved ciphertext with
the restored `OlmMachine`; normalize; prepare separate tenant batches; lose the
first ingestion response; restart; resend identical bytes; accept both; advance
the checkpoint; query zero pending rows; verify response, event, token, and
request canaries absent from logs and raw SQLite; receive a missing room key
through a later journaled response without committing out of order; run a
bounded overlapping backfill; prove the live checkpoint unchanged; and run
offline store verification.

- [ ] **Step 2: Run the end-to-end test red, then green**

Run: `cargo test -p communicator-matrix-gateway --test end_to_end -- --nocapture`
Expected first: FAIL at the earliest missing integration. Fix only demonstrated
integration defects. Repeat until PASS.

- [ ] **Step 3: Run every repository quality gate from a clean dependency state**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:python
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
git diff --check
git status --short
```

Expected: every check exits 0; generated bindings do not drift; status contains
only the intended uncommitted Task 14 files before its commit.

- [ ] **Step 4: Run independent reviews in order**

Dispatch four fresh Luna/max read-only reviewers:

1. gateway design/plan compliance;
2. Rust/code quality and unsafe/dependency audit;
3. security/privacy/tenant-isolation/failure-recovery audit;
4. final phase verification against proposal + Cloudflare ingestion contract.

Every finding is fixed by the responsible implementation worker and re-reviewed
until each reviewer returns `PASS` with no findings.

- [ ] **Step 5: Commit final acceptance evidence**

```bash
git add services/matrix-gateway/tests/end_to_end.rs \
  docs/runbooks/matrix-gateway-local-acceptance.md
git commit -m "test: verify matrix gateway end to end"
```

- [ ] **Step 6: Create the pull request; do not deploy yet**

Push `codex/matrix-gateway`, create a PR against `main`, and include exact test
counts and review results. The PR must state these external gates remain closed:
real OIDC issuer/client provisioning, Worker staging deploy/migrations, gateway
Matrix credentials, Contabo activation, and live provider data.

## External activation is deliberately a separate plan

This implementation plan ends at a reviewed, merged, locally proven gateway.
It does not authorize a Worker deploy, D1 migration, OIDC provisioning, Matrix
login, Contabo activation, synthetic live event, or production backfill.

After this PR is merged, the orchestrator must first inspect then-current
Cloudflare and Contabo state and write
`docs/superpowers/plans/2026-09-09-communicator-gateway-staging-activation.md`.
That plan must contain the resolved Worker name, route, D1/R2/Queue resource
IDs, migration list, OIDC issuer/audience/client mechanism, Contabo release SHA,
gateway Matrix user/device flow, protected-file paths and ownership, exact
Executor/SSH commands, rollback commands, and credential-free expected outputs.
It must require: empty-resource prechecks; ingress-disabled deploy first; one
synthetic non-provider Matrix event; R2 pair/Queue drain/one-DO/checkpoint/DLQ
evidence; restart persistence; and a `--network none` isolated restore.

Deleting/replacing the Matrix E2EE store, rotating away the last usable
decryption key, purging R2, destroying D1, deleting a Queue, or
retiring/reassigning immutable ownership remains an irreversible approval gate.
No implementation worker may infer permission for those actions from this
document.

## Plan self-review checklist

- [ ] Every gateway design requirement maps to a numbered task.
- [ ] All identifiers, constants, paths, commands, state enums, and interfaces
      are consistent across tasks.
- [ ] No task reads Synapse/mautrix private database schemas.
- [ ] No task logs or stores protected values in plaintext.
- [ ] No live action occurs before local tests and independent reviews pass.
- [ ] No incomplete implementation marker or vague cross-task substitution remains.
- [ ] The final local and post-merge gates distinguish code completeness from
      live operational activation.
