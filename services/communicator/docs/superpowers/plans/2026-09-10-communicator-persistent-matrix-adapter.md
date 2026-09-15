# Persistent Matrix adapter implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development`. Execute only the task batch assigned by the parent. This plan and the repository are the full context; do not assume access to prior conversation.

**Goal:** Replace the Matrix compile spike with a production adapter that bootstraps one service account, restores its persistent E2EE stores without logging in again, performs bounded raw Matrix HTTP operations, applies or recovers journaled sync responses, extracts joined-room events, and safely acknowledges the single permitted `/keys/query` crypto request.

**Architecture:** The adapter never owns source checkpoints. Raw HTTP returns a closed exact-byte DTO, the caller persists it through `Store::append_fetched_sync`, and only then may `MatrixSdkProcessor` apply it. The SDK token is used only for reconciliation; network `since` always comes from the application store. Crypto enumeration, sending, durable response persistence, SDK acknowledgement, and local completion remain separate steps so the later service loop can recover every crash boundary.

**Tech stack:** Rust 2024, Matrix SDK/Base/Crypto/SQLite `0.18.0`, Ruma `0.16.0`, Reqwest `0.13.4` with Rustls and streaming, Tokio `1.53.1`, `async-trait 0.1.92`, `futures-util 0.3.34`, Wiremock, and the existing encrypted SQLite ledger.

---

## 1. Baseline, ownership, and exclusions

Start from commit `0a5e67a` in:

`/home/ubuntu/communicator/.worktrees/matrix-gateway`

Read before editing:

- `docs/superpowers/plans/2026-09-09-communicator-matrix-gateway-implementation.md`, Task 9 and its Task 10 crypto-lane rules.
- `docs/superpowers/plans/2026-09-10-communicator-matrix-gateway-crypto-outbox-lifecycle.md`.
- `docs/superpowers/plans/2026-09-10-communicator-matrix-gateway-crypto-recovery-store.md`.
- `services/matrix-gateway/src/matrix_spike.rs`.
- `services/matrix-gateway/tests/matrix_sdk_compile.rs`.
- `services/matrix-gateway/tests/matrix_error_redaction.rs`.

Allowed phase files:

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`, only through Cargo resolution
- Modify: `services/matrix-gateway/Cargo.toml`
- Delete: `services/matrix-gateway/src/matrix_spike.rs`
- Create: `services/matrix-gateway/src/matrix.rs`
- Create: `services/matrix-gateway/src/matrix_http.rs`
- Modify: `services/matrix-gateway/src/lib.rs`
- Modify: `services/matrix-gateway/src/secret.rs`, only to add the crate-private
  ownership-transfer method specified below
- Modify: `services/matrix-gateway/src/store.rs`, only to add the crate-private
  keyed room-lookup method specified below; do not change schema or transactions
- Replace: `services/matrix-gateway/tests/matrix_sdk_compile.rs` with `services/matrix-gateway/tests/matrix_adapter.rs`
- Modify: `services/matrix-gateway/tests/matrix_error_redaction.rs`
- Modify: `services/matrix-gateway/tests/crypto_request_policy.rs`, only for the
  module import migration
- Modify: `services/matrix-gateway/tests/secret_security.rs`, only for the
  ownership-transfer regression
- Create only if required for a focused fake: `services/matrix-gateway/tests/fixtures/matrix/`

Do not modify the store schema, store transaction semantics, canonical event schema, configuration schema, main binary, deployment files, UI, Cloudflare code, or bridge configuration. Do not perform live login or contact the production Synapse server during tests. Bootstrap is a callable API in this phase; the later admin/service phase wires it to the binary.

## 2. Dependency contract

Add exact workspace dependencies already present in `Cargo.lock`:

```toml
async-trait = "=0.1.92"
futures-util = "=0.3.34"
reqwest = { version = "=0.13.4", default-features = false, features = ["rustls", "stream"] }
```

Reference them from `services/matrix-gateway/Cargo.toml` with `.workspace = true`. Do not enable native TLS, cookies, proxies, compression, JSON convenience, multipart, HTTP/3, or system-proxy support. Response decompression is disabled so the 64 MiB limit applies to the exact transferred body. Keep the existing pinned Matrix and Ruma versions.

## 3. Stable errors and closed values

Every adapter error is `SafeError` with one of these exact content-free codes:

```text
matrix_session_invalid
matrix_session_not_ready
matrix_transport_invalid
matrix_transport_failed
matrix_response_empty
matrix_response_too_large
matrix_response_invalid
matrix_sdk_failed
matrix_sdk_position_unjournaled
matrix_room_membership_invalid
matrix_crypto_maintenance_required
matrix_crypto_kind_not_allowed
matrix_crypto_ack_unrecoverable
```

Discard upstream error values. Never attach an HTTP body, URL, token, Matrix identifier, filesystem path, SDK error, serde error, or reqwest error as a source or formatted field.

These types are closed, non-`Clone`, non-serializable, redacted, and own secret-bearing bytes through `SecretBytes` or explicit zeroizing buffers:

```rust
pub struct FetchedMatrixSync {
    request_token: SecretBytes,
    next_token: SecretBytes,
    exact_body: SecretBytes,
}

impl FetchedMatrixSync {
    pub fn request_token_sha256(&self) -> [u8; 32];
    pub fn next_token_sha256(&self) -> [u8; 32];
    pub fn byte_count(&self) -> usize;
    pub fn into_store_input(self, observed_at: DateTime<Utc>)
        -> Result<NewRawSyncInbox, SafeError>;
}

pub enum ObservedMatrixEvent {
    Timeline(ObservedRoomEvent),
    State(ObservedRoomEvent),
    Receipt(ObservedRoomEvent),
    Typing(ObservedRoomEvent),
}

pub struct ObservedRoomEvent {
    room_id: SecretBytes,
    exact_json: SecretBytes,
    unable_to_decrypt: bool,
}

pub struct LimitedTimelineGap {
    room_id: SecretBytes,
    prev_batch: SecretBytes,
}

pub struct ProcessedSync {
    events: Vec<ObservedMatrixEvent>,
    gaps: Vec<LimitedTimelineGap>,
}

pub struct CryptoAckProof {
    row_id: String,
    response_sha256: [u8; 32],
}

pub enum RestartCryptoAck {
    Rebound(CryptoAckProof),
    AlreadyApplied(CryptoAckProof),
    Unrecoverable(ReasonCode),
}
```

All fields remain private. Add only these public non-secret observations: event/gap counts, `has_undecryptable_events`, request/next digests, byte count, and the stable enum discriminant. Raw room IDs, event JSON, tokens, and crypto responses have crate-private getters for the later normalizer/service. `Debug` and `Display` return only `TypeName([REDACTED])`. Add compile-fail doctests proving no `Clone`, `Serialize`, `AsRef`, or `Deref` for every secret-bearing DTO.

`FetchedMatrixSync::into_store_input` must move all three byte buffers into
`NewRawSyncInbox` without cloning a 64 MiB response. Add exactly one
crate-private `SecretBytes::into_vec(mut self) -> Vec<u8>` method, implemented
with `mem::take(&mut self.bytes)`, so `Drop` still zeroizes any remaining
buffer. Do not make it public and do not add any other general secret-extraction
API. Add a focused regression proving the moved bytes are exact.

## 4. Frozen ports

Create these exact traits in `matrix.rs`:

```rust
#[async_trait]
pub trait MatrixTransport: Send + Sync {
    async fn fetch_sync(
        &self,
        since: &SecretBytes,
    ) -> Result<FetchedMatrixSync, SafeError>;

    async fn send_crypto(
        &self,
        request: &PendingMatrixRequest,
    ) -> Result<RawMatrixResponse, SafeError>;
}

#[async_trait]
pub trait MatrixProcessor: Send {
    async fn sdk_token_digest(&self) -> Result<Option<[u8; 32]>, SafeError>;

    async fn apply_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError>;

    async fn recover_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError>;

    async fn pending_crypto_requests(
        &self,
    ) -> Result<Vec<ExactMatrixRequest>, SafeError>;

    async fn apply_crypto_response(
        &mut self,
        request: &PendingMatrixRequest,
        response: &RawMatrixResponse,
    ) -> Result<CryptoAckProof, SafeError>;

    async fn rebind_saved_crypto_response(
        &mut self,
        saved: &SavedMatrixResponse,
    ) -> Result<RestartCryptoAck, SafeError>;
}
```

The traits do not accept `Store`; the later service owns transaction ordering. `MatrixSdkProcessor` may retain the in-memory SDK request ID only for the current process, but persistent recovery uses the saved request digest and fresh SDK enumeration.

## Task 1: Graduate the compile spike and freeze the adapter types

**Files:** `matrix_spike.rs`, `matrix.rs`, `lib.rs`, `matrix_sdk_compile.rs`, `matrix_adapter.rs`, `matrix_error_redaction.rs`, and dependency manifests.

- [ ] Add the pinned dependencies from section 2.
- [ ] Rename `matrix_spike.rs` to `matrix.rs` and `matrix_sdk_compile.rs` to `matrix_adapter.rs` with Git-aware moves.
- [ ] Replace every `matrix_spike` import with `matrix`; remove the old module export.
- [ ] Preserve all existing compile-spike functions and tests initially. Run `matrix_adapter` and `matrix_error_redaction`; they must remain green before adding behavior.
- [ ] Add the closed DTOs and ports from sections 3 and 4 with compile-fail/redaction tests.
- [ ] Write a failing move-semantics test that records the original response allocation pointer, consumes `FetchedMatrixSync`, and proves the exact body reaches `NewRawSyncInbox` without allocating a second body buffer. Implement only the crate-private `SecretBytes::into_vec` ownership API frozen in section 3.
- [ ] Run the two focused targets and doctests. Expected: all green.

Do not implement transport or SDK methods in this task. A private constructor may be used by later production modules and test fakes; no public unchecked constructor is permitted.

## Task 2: Implement bounded raw Matrix HTTP

**Files:** Create `matrix_http.rs`; modify `matrix.rs`, `lib.rs`, and `matrix_adapter.rs`.

Implement:

```rust
pub struct ReqwestMatrixTransport { /* private */ }

impl ReqwestMatrixTransport {
    pub fn new(
        homeserver_url: &str,
        access_token: SecretBytes,
        request_timeout: Duration,
        sync_timeout: Duration,
    ) -> Result<Self, SafeError>;
}
```

Constructor rules:

- HTTPS only in production. Permit `http://127.0.0.1:<port>` only under `cfg(test)` or through a crate-private test constructor.
- The base URL has no credentials, query, fragment, or non-root path.
- Disable redirects, proxies, cookies, referer, compression, and transparent retries.
- Use Rustls, a bounded connect timeout no larger than `request_timeout`, and per-request total deadlines.
- Store the access token only as `SecretBytes`; never place it in a debug-visible client wrapper.

`fetch_sync` rules:

1. Reject an empty/oversized/non-UTF-8 `since` before building the request.
2. Build Ruma v3 `/sync` with `since` from the caller and the configured long-poll timeout. Never read `BaseClient::sync_token` here.
3. Add Bearer authorization only to the in-memory request.
4. Reject redirects rather than following them.
5. Reject non-2xx responses without retaining or parsing their body text.
6. Reject empty bodies.
7. If a valid `Content-Length` exceeds 64 MiB, reject before streaming. Otherwise stream chunks with checked addition and stop before appending the byte that would exceed 64 MiB.
8. Parse the completed exact bytes as Ruma v3 `SyncResponse`, require a non-empty bounded `next_batch`, then drop the typed parse and retain the original body allocation.
9. Return `FetchedMatrixSync` with exact request token, exact next token, and exact body.

`send_crypto` rules:

1. Accept only the closed `PendingMatrixRequest`, whose body is canonical `/keys/query` JSON.
2. Build `POST /_matrix/client/v3/keys/query` with Bearer auth and `Content-Type: application/json`.
3. Use `request_timeout`, redirect rejection, the exact persisted request body, and the same streaming rules with `MAX_MATRIX_CRYPTO_RESPONSE_BYTES`.
4. Return `RawMatrixResponse::keys_query(exact_bytes)`; preserve exact bytes and never parse upstream error text.

Write tests before code for exact URL/method/query/auth/body, application token rather than SDK token, redirect rejection, connect/timeout failure, non-success redaction, empty response, declared oversize, streamed limit plus one, exact-limit acceptance without duplicate allocation, malformed sync/crypto JSON, and no credential/body leakage through every error formatter. Wiremock may bind localhost; no external DNS or network is allowed.

## Task 3: One-shot persistent E2EE bootstrap and offline restoration

**Files:** Modify `matrix.rs` and `matrix_adapter.rs`.

Add:

```rust
pub async fn bootstrap_matrix(
    homeserver_url: &str,
    matrix_user_id: &str,
    sdk_store_path: &Path,
    password: &SecretBytes,
    sdk_store_passphrase: &SecretBytes,
    state_store: &mut Store,
    bootstrapped_at: DateTime<Utc>,
) -> Result<(), SafeError>;

pub async fn restore_matrix_processor(
    homeserver_url: &str,
    expected_user_id: &str,
    sdk_store_path: &Path,
    sdk_store_passphrase: &SecretBytes,
    state_store: &Store,
) -> Result<MatrixSdkProcessor, SafeError>;
```

Bootstrap rules:

- Add `Store::matrix_room_lookup(&self, matrix_room_id: &str) ->
  Result<[u8; 32], SafeError>` as a crate-private delegation to the existing
  keyed registry function. Bootstrap uses this method for anchors, ensuring it
  cannot accidentally use a different keyring.
- Fail before network if the application store already has a Matrix session.
  Also inspect `sdk_store_path` with `symlink_metadata`: reject a symlink,
  reject any non-directory, and reject an existing non-empty directory. A
  missing or empty real directory is the only accepted uninitialized state.
  This deliberately leaves a partially initialized SDK directory intact after
  failure and requires operator cleanup rather than risking a second login.
- Build a high-level `Client` with the pinned SQLite store and passphrase.
- Log in exactly once as the configured full Matrix user ID, with fixed display name `communicator-matrix-gateway`; do not request or print a QR code, SSO URL, device token, or login response.
- Perform exactly one initial sync through the same concrete bounded raw
  transport used at runtime. Implement one private
  `fetch_sync_bytes(Option<&SecretBytes>)`; bootstrap passes `None`, while the
  public `MatrixTransport::fetch_sync` passes `Some(since)`. Do not use the
  SDK's high-level HTTP sync method, because it cannot prove the adapter's
  streaming 64 MiB allocation bound or exact transferred bytes.
- Parse the bounded initial response as the typed Ruma sync response, verify
  its token, and feed it once to the logged-in client so the persistent state
  and crypto stores reach the same initial position. The initial sync is
  bootstrap state, not replay input: do not call `append_fetched_sync` and do
  not emit its events.
- Reject any invited or left room.
- For each joined room, record the last timeline event ID as an encrypted room anchor if present. A joined room with no event creates no anchor. Derive the keyed room lookup through `state_store.matrix_room_lookup`.
- Serialize the `MatrixSession` using the existing protected wrapper. Store the same initial `next_batch` as committed and fetch tokens with `Store::initialize_bootstrap_state` in one transaction.
- Close SDK stores before returning. If application persistence fails, return a content-free error and leave the SDK store intact for operator diagnosis; never retry login automatically.

Restore rules:

- Read and decode the encrypted application session. Require configured user ID, session user ID, and SDK account user ID/device ID to agree exactly.
- Open `SqliteStateStore` and `SqliteCryptoStore` at the configured path with the passphrase and activate a public `BaseClient` with saved `SessionMeta`.
- Make no HTTP request and never fall back to login, device creation, store reset, or passphrase replacement.
- Wrong passphrase, missing store, mismatched account, corrupt session, and absent bootstrap all fail closed with stable codes.

Tests must prove one login/device, same token in both application positions, initial history discarded, joined anchors stored, invitation/left rejection, exact session restore after reopen, wrong passphrase failure, user/device mismatch failure, no automatic relogin, and zero network calls during restore.

## Task 4: Apply and recover journaled sync responses

**Files:** Modify `matrix.rs` and `matrix_adapter.rs`.

`apply_saved_sync`:

- Parse the exact encrypted `RawSyncInbox` response into Ruma `SyncResponse` without copying the body into an owned generic JSON tree.
- Require the typed `next_batch` digest to equal `RawSyncInbox::next_token_digest` before calling the SDK.
- Call `BaseClient::receive_sync_response` exactly once. The caller must already have durably appended the row; this method does not touch `Store`.
- Reject invited or left rooms before returning success.
- Extract every joined-room timeline and state event into `ObservedMatrixEvent`. Extract only `m.receipt` and `m.typing` from joined-room ephemeral events. Ignore account data and presence in this pilot.
- Mark a timeline event `unable_to_decrypt=true` only when the SDK returns the original `m.room.encrypted` event without decryption information. Never silently discard it.
- Emit one `LimitedTimelineGap` for every joined timeline with `limited=true`; require a non-empty bounded `prev_batch`.

`recover_saved_sync`:

- Use only when `Store::reconcile_sdk_position` proves the SDK has already applied this row or a later contiguous row.
- Parse the raw sync response. Do not call `receive_sync_response`, change the SDK sync token, or process its to-device section again.
- Return plaintext/state/receipt/typing events directly from the raw response.
- For each encrypted timeline event, call the restored `OlmMachine::decrypt_room_event` with `TrustRequirement::Untrusted`; emit the decrypted event on success and retain the original event with `unable_to_decrypt=true` on the specific missing-room-key failure.
- Any other decrypt/parse/membership inconsistency is `matrix_sdk_failed` or `matrix_response_invalid`; never include upstream text.
- Preserve source order within each room and deterministic room ordering by Matrix room ID bytes. Reject duplicate event IDs within one response.

Tests cover SDK at committed token, request token, response next token, a later contiguous token, and unknown token; replay suppression after persistent reopen; encrypted event recovery after a later to-device key; no second to-device application; plaintext/state/receipt/typing extraction; limited-gap output; invited/left rejection; duplicate event rejection; unknown room/malformed next token; unable-to-decrypt retention; and exact event order. All fixtures are local.

## Task 5: Enumerate, apply, and restart-rebind `/keys/query`

**Files:** Modify `matrix.rs` and `matrix_adapter.rs`.

`pending_crypto_requests`:

- Hold the Olm-machine guard for the complete enumeration and classification.
- Zero requests returns an empty vector.
- Exactly one `KeysQuery` is converted to canonical JSON using the existing canonicalizer, paired with the SDK transaction ID bytes, and returned as one `ExactMatrixRequest`.
- A `KeysUpload` returns `matrix_crypto_maintenance_required` without sending or acknowledging it.
- `KeysClaim`, to-device, verification, room-message, signing/signature, and backup requests return `matrix_crypto_kind_not_allowed`.
- More than one request of any combination fails closed. This receive-only phase never calls `get_missing_sessions`, key upload, room-key request, signing, backup, or message APIs.

`apply_crypto_response`:

- Require the saved response body to parse as Ruma v3 `get_keys::Response`.
- Require the in-memory SDK request ID and canonical body digest to match the supplied `PendingMatrixRequest`.
- Call `OlmMachine::mark_request_as_sent` exactly once with that request ID and typed response.
- Return `CryptoAckProof` only after the SDK call succeeds. Do not persist or complete the store row here.

`rebind_saved_crypto_response`:

1. Enumerate outgoing requests once before any other SDK application.
2. If exactly one current `KeysQuery` has the saved canonical request digest, parse and apply the saved response using the current SDK request ID and return `Rebound`.
3. If a different or forbidden request exists, return `Unrecoverable(matrix_crypto_ack_unrecoverable)` without applying anything.
4. If no request remains, verify that the saved response is already reflected in the restored crypto store. For every device-key entry, validate map user/device IDs, the device's Ed25519 self-signature, and equality of the signed device-key material with `OlmMachine::get_user_devices`. For master/self-signing/user-signing entries, require the corresponding restored identity keys and signatures to match. Ignore only the unsigned display-name field. Any response failure map, missing entity, extra stored match ambiguity, malformed signature, or unavailable public SDK proof returns `Unrecoverable`.
5. Return `AlreadyApplied` only when every response entry passes. Empty key maps do not prove acknowledgement and are unrecoverable.

The implementation must first add a compile-focused SDK proof test for step 4. If Matrix SDK `0.18.0` exposes no public API capable of verifying every required entity, stop this task with a precise compile/API blocker. Do not weaken the proof, use SDK internals, patch upstream code, or treat an absent request as acknowledgement.

Tests cover direct acknowledgement, replaced request ID with matching body, same ID with different body, multiple matches, forbidden/maintenance requests, malformed response, crash/reopen rebind, repeated rebind idempotency, already-applied full device/cross-signing proof, empty/partial/tampered response rejection, and content-free errors.

## Task 6: Phase validation and review

- [ ] Run focused targets: `matrix_adapter`, `matrix_error_redaction`, all crypto recovery/lifecycle/recording targets, and doctests.
- [ ] Run all targets while skipping only the unchanged resource-heavy `aggregate_cap_accepts_exact_256_mib_retry_and_rejects_new_rows` test.
- [ ] Run Clippy with `-D warnings`, formatting check, `git diff --check`, `git status --short`, and changed-file scope.
- [ ] Use localhost-network-enabled workspace-write sandboxing for test workers. No external DNS or network.
- [ ] Run independent specification and Rust/Matrix/security reviews in parallel. Reviewers must inspect exact-body preservation, redirect and decompression policy, allocation bounds, session and token privacy, no automatic login, SDK/application checkpoint separation, room membership and decryption behavior, crypto kind allowlist, acknowledgement/rebind proof, and absence of store mutations in the adapter.
- [ ] Consolidate findings into one writer pass, rerun affected focused tests and the full non-slow gate once, then obtain a targeted independent re-review.
- [ ] Parent reads every production diff and commits only allowed files with:

```bash
git commit -m "feat: add persistent matrix e2ee adapter"
```

## 5. Completion criteria

The phase is complete only when evidence proves:

- bootstrap creates one persistent device/session, stores one initial checkpoint pair and joined-room anchors, and discards initial history;
- normal restoration is offline and cannot relogin or reset stores;
- raw sync and `/keys/query` transport use exact application-owned bytes, reject redirects and decompression, enforce streaming bounds, and expose no credentials or bodies;
- the application can persist a fetched response before any SDK processing;
- applied and already-applied responses produce the same ordered joined-room observations without replaying to-device work;
- invited/left rooms, malformed tokens, duplicates, and unjournaled SDK positions fail closed;
- only one `/keys/query` may cross the crypto boundary; every other SDK request class pauses or fails closed;
- direct and restarted crypto acknowledgement use an actual current request or a complete restored-store proof, never an absent-ID assumption;
- all secret-bearing DTOs are closed, redacted, non-serializable, and zeroizing;
- all focused, full non-slow, doc, lint, format, diff, and independent-review gates pass.

This phase does not yet run the daemon loop, normalize events into tenant batches, deliver to Cloudflare, backfill room gaps, expose health/admin commands, or deploy. Those remain subsequent phases and use the adapter ports frozen here.
