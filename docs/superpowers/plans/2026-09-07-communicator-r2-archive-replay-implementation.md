# Communicator R2 Archive and Deterministic Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before every completion claim. Execute one numbered task at a time. Do not skip red tests, broaden scope, deploy resources, or make architecture decisions that are not explicitly authorized here.

**Goal:** Freeze the canonical messaging-event contract and implement a tenant-isolated, batched, compressed, append-only ordinary-R2 archive with immutable commit manifests and deterministic, side-effect-free replay reads.

**Architecture:** A Worker-internal archive library validates and canonically serializes a bounded batch of normalized events, stores one gzip JSONL data object, and then stores one immutable JSON manifest as the commit marker. Data objects are never discovered directly; readers list tenant-scoped manifest keys and validate each manifest, data object, checksum, and event before returning a projection-only replay page. Failed or repeated writes are safe: an orphaned data object is invisible until its manifest exists, an identical retry completes or returns the prior commit, and a conflicting reuse of a batch key fails closed.

**Tech Stack:** TypeScript 7, Zod 4, Cloudflare Workers, ordinary R2, Web Streams `CompressionStream`/`DecompressionStream`, Web Crypto SHA-256, Wrangler 4, `@cloudflare/vitest-plugin` 1.x, Vitest 4, pnpm 10.

---

## Simple explanation

This phase builds the Communicator's integrity-checked filing cabinet. Messages are not saved as thousands of tiny R2 files. Instead, a small group of normalized events is written into one compressed file, and a second tiny manifest says that the file is complete and safe to replay. The checksum detects accidental corruption and inconsistent objects; it is not a cryptographic signature against an administrator who can rewrite both objects.

Nothing in this phase sends messages, changes WhatsApp/Telegram/Messenger/LinkedIn, updates a Durable Object, or exposes a new public endpoint. Replay only reads and validates archived events. Later phases will use those events to rebuild one tenant's query database.

At the end of this phase:

- every normalized event has one strict, versioned shape;
- one batch produces one compressed data object plus one commit manifest;
- tenants cannot read or write each other's archive prefixes;
- identical retries are harmless and conflicting retries are rejected;
- interrupted writes are recoverable;
- corrupt or inconsistent archives fail closed; and
- replaying the same committed archive repeatedly yields the same event sequence and performs no provider or automation action.

## Technical boundaries

- Synapse remains the operational messaging system of record.
- Ordinary R2 is the immutable/replayable raw-event archive. It does not back Durable Object SQLite.
- This phase uses no R2 Data Catalog and no Cloudflare Pipelines.
- This phase does not create `TenantProjectionDO`, Queue producers/consumers, public replay/export routes, Matrix event consumers, command dispatch, provider linking, deletion execution, media copying, or Brain integration.
- The R2 bucket is distinct from the existing restic/VPS-backup bucket.
- "Immutable" in this phase means application-level create-only writes with conflict detection. Cloudflare account administrators remain a storage trust boundary until an explicit bucket-lock policy is approved.
- No live Cloudflare resource is created, changed, or deployed in this phase. Wrangler names are fail-loud configuration targets for later provisioning.
- Retention periods and R2 bucket locks remain deferred. Do not enable an indefinite lock because later privacy/deletion workflows must remain possible.
- Archive code must never log event payloads, message bodies, access tokens, E2EE keys, bridge sessions, provider cookies, or credentials.
- Archive/replay functions are internal modules. Do not mount HTTP routes for them in this phase.
- Replay returns validated data only. It must not accept a command dispatcher, Queue sender, automation callback, Matrix client, or provider client.

## Orchestration contract

The primary agent owns architecture, reviews every diff, and decides whether a task may advance. Implementation and independent testing workers use exactly:

```text
model: gpt-5.6-luna
reasoning_effort: max
fork_turns: none
agent_type: worker
```

Each worker receives:

1. the absolute worktree path;
2. this plan path;
3. exactly one numbered task;
4. the current branch/HEAD;
5. an instruction to inspect existing code before editing;
6. an instruction to commit only that task; and
7. an instruction to report files, tests, commit, and any deviation.

Workers must not deploy, provision Cloudflare resources, touch the Contabo VPS, modify bridge/Synapse configuration, rewrite earlier commits, or merge branches. If a specified API is incompatible with the installed Cloudflare types, the worker stops with exact evidence instead of inventing a substitute architecture.

## Required working-copy setup

The implementation branch must start from the then-current `main` in a dedicated ignored worktree, for example:

```bash
cd /home/ubuntu/communicator
git fetch origin
git check-ignore -q .worktrees
git worktree add .worktrees/r2-archive-replay -b codex/r2-archive-replay origin/main
cd /home/ubuntu/communicator/.worktrees/r2-archive-replay
pnpm install --frozen-lockfile
```

Before Task 1, establish a green baseline:

```bash
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
python3 -m unittest discover -s tests -q
git status --short
```

Expected baseline at plan creation: `pnpm check` exits 0, 138 TypeScript tests pass, 106 Python tests pass, and the worktree is clean. The local `chmod` only normalizes a shared-filesystem checkout artifact; do not commit a permission relaxation or change the exact `0755` repository contract.

## File map

**Create**

- `packages/contracts/src/canonical-event.ts` — JSON-safe values, event types, sources, and the strict canonical event envelope.
- `packages/contracts/src/archive.ts` — archive manifest, replay cursor/page, and public error-independent data contracts.
- `packages/contracts/test/canonical-event.test.ts` — strict event acceptance/rejection tests.
- `packages/contracts/test/archive.test.ts` — strict manifest/cursor/page contract tests.
- `apps/control-plane/worker/archive/errors.ts` — narrow internal typed errors with safe codes and no payload content.
- `apps/control-plane/worker/archive/canonical-json.ts` — deterministic JSON serialization and byte helpers.
- `apps/control-plane/worker/archive/keys.ts` — tenant-scoped data/manifest key construction and validation.
- `apps/control-plane/worker/archive/codec.ts` — gzip, gunzip, SHA-256, JSONL encode/decode.
- `apps/control-plane/worker/archive/writer.ts` — create-only two-stage archive commit and idempotent retry behavior.
- `apps/control-plane/worker/archive/reader.ts` — manifest listing, cursor validation, committed-batch validation, and replay pages.
- `apps/control-plane/worker/test/archive/canonical-json.test.ts` — deterministic encoding tests.
- `apps/control-plane/worker/test/archive/keys.test.ts` — safe key/prefix tests.
- `apps/control-plane/worker/test/archive/codec.test.ts` — codec/checksum/corruption tests.
- `apps/control-plane/worker/test/archive/writer.test.ts` — happy path, retry, conflict, and partial-failure tests against workerd R2.
- `apps/control-plane/worker/test/archive/reader.test.ts` — pagination, isolation, validation, and deterministic replay tests.
- `apps/control-plane/worker/test/archive/support.ts` — bounded deterministic fixtures and R2 cleanup helpers.
- `docs/runbooks/r2-archive-local.md` — local verification, object layout, failure recovery, and deployment prohibition.

**Modify**

- `packages/contracts/src/index.ts` — export canonical-event and archive contracts.
- `apps/control-plane/wrangler.jsonc` — add separate ordinary-R2 archive bindings for local/staging/production names.
- `apps/control-plane/worker-configuration.d.ts` — regenerate with Wrangler; never hand-edit.
- `apps/control-plane/vitest.worker.config.ts` — only if required to expose an isolated R2 binding in workerd tests.

**Must not modify**

- `apps/control-plane/worker/app.ts` and `worker/index.ts` — no route or runtime entry-point wiring yet.
- UI source, mocks, or browser tests.
- D1 migrations or authorization behavior.
- Compose, Synapse, mautrix, backup/restore, bridge, or Contabo files.
- any live-resource IDs, API tokens, credentials, `.dev.vars`, or secret files.

## Locked canonical event contract

Implement the schemas with Zod and export inferred TypeScript types. Every object schema is `.strict()`.

### JSON-safe payload values

`CanonicalJsonValueSchema` recursively accepts only:

- `null`;
- booleans;
- strings;
- finite numbers;
- arrays of canonical JSON values; and
- objects whose string keys map to canonical JSON values.

Reject `undefined`, `NaN`, `Infinity`, `-Infinity`, bigint, functions, symbols, dates, maps, sets, class instances, cyclic values, sparse-array ambiguity, and the prototype-sensitive object keys `__proto__`, `prototype`, and `constructor` at any depth. Zod validation must reject invalid values before serialization. Rejecting those three keys is intentional: it avoids prototype pollution and avoids object-library behavior silently changing a payload before hashing.

Do not implement this with an unbounded `z.lazy` recursion followed by a depth refinement: a malicious deeply nested or cyclic value could overflow the call stack before the refinement runs. Implement one iterative, explicit-stack validator with a `WeakSet` for cycle detection and depth/node counters, wrap it in `z.custom<CanonicalJsonValue>()`, and export a root-object variant for `payload`. The custom predicate must catch its own inspection failures and make `safeParse()` return `{ success: false }`; it must never leak a `RangeError`. Plain objects may have only `Object.prototype` or `null` as their prototype. Arrays must have every integer index from `0` through `length - 1` as an own property. Inspect only own enumerable keys and reject the three prototype-sensitive names before copying or serialization.

### Event types

Use this exact enum:

```ts
type CanonicalEventType =
  | "message.created"
  | "message.edited"
  | "message.deleted"
  | "reaction.added"
  | "reaction.removed"
  | "receipt.read"
  | "receipt.delivered"
  | "typing.started"
  | "typing.stopped"
  | "attachment.observed"
  | "conversation.updated"
  | "participant.updated"
  | "command.updated"
  | "bridge.delivery.updated"
  | "replay.tombstone"
  | "correction.applied"
  | "deletion.tombstone";
```

### Event sources

Use this exact enum:

```ts
type CanonicalEventSource =
  | "live"
  | "backfill"
  | "command_result"
  | "replay"
  | "correction"
  | "deletion";
```

### Envelope

Use this exact field set:

```ts
type CanonicalEventEnvelope = {
  schema_version: 1;
  event_id: string;
  event_type: CanonicalEventType;
  event_source: CanonicalEventSource;
  tenant_id: string;
  identity_id: string;
  platform: "whatsapp" | "telegram" | "messenger" | "linkedin";
  account_id: string;
  conversation_id: string;
  matrix_room_id: string | null;
  matrix_event_id: string | null;
  remote_message_id: string | null;
  occurred_at: string;
  observed_at: string;
  payload: Record<string, CanonicalJsonValue>;
};
```

Validation rules:

- `schema_version` is the literal `1`.
- `event_id` is trimmed, 1–1024 characters, and may contain an opaque Matrix event ID such as `$abc:server`; do not apply `CommunicatorIdSchema` to it.
- `tenant_id`, `identity_id`, `account_id`, and `conversation_id` use `CommunicatorIdSchema` plus an explicit maximum of 128 ASCII characters. Define and export a derived `CanonicalResourceIdSchema`; do not change the shared `CommunicatorIdSchema` in this phase.
- `platform` reuses the existing `ProviderSchema`; do not duplicate a drifting provider enum.
- `matrix_room_id`, when non-null, is 1–1024 characters and starts with `!`.
- `matrix_event_id`, when non-null, is 1–1024 characters and starts with `$`.
- `remote_message_id`, when non-null, is trimmed and 1–1024 characters.
- `occurred_at` and `observed_at` use `TimestampSchema`, must include an offset, and are capped at 64 characters.
- Do not reject a backfilled event merely because `occurred_at` predates `observed_at` by months.
- `payload` is a strict JSON-safe record but remains event-family-specific only by convention in this milestone. Do not invent provider-specific payload schemas yet. Enforce maximum nesting depth 32, maximum 10,000 entries in any one array/object, maximum object-key length 256 characters, and maximum individual string length 1 MiB before canonical serialization; the 4 MiB encoded batch limit still applies across all payloads.
- Cap traversal at 50,000 JSON nodes per event. A node is each scalar, array, or object visited by the iterative validator.
- Unknown top-level fields are rejected.

`event_id` is the canonical projection idempotency key. Matrix and stable remote IDs remain separately queryable aliases.

## Locked archive contracts

### Key layout

For a sorted batch whose earliest `observed_at` is `2026-09-07T01:02:03.000Z` and whose batch ID is `batch_01abc`, construct exactly:

```text
events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz
manifests/tenant_pilot/2026/09/07/01/batch_01abc.json
```

Exports and media remain reserved but unimplemented:

```text
exports/{tenant}/{timestamp}.jsonl.gz
media/{tenant}/{content-hash}
```

Rules:

- Tenant IDs and batch IDs must pass `CanonicalResourceIdSchema` and therefore contain at most 128 ASCII characters.
- Batch IDs must begin with `batch_`.
- Derive all date components in UTC from the earliest sorted `observed_at`.
- Never accept a caller-supplied object key or prefix.
- Reject traversal characters, percent-encoded traversal, separators, control characters, and noncanonical timestamps through schema validation rather than string replacement.
- Tenant list prefix is exactly `manifests/{tenant_id}/`.
- Data and manifest keys are a pair; a manifest may reference only the data key derived from its own tenant, time partition, and batch ID.

### Product bounds

Use named constants, independent of current provider or Cloudflare maximums:

```ts
MAX_ARCHIVE_EVENTS = 500
MAX_EVENT_CANONICAL_BYTES = 1 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_COMPRESSED_BYTES = 5 * 1024 * 1024
MAX_ARCHIVE_MANIFEST_BYTES = 64 * 1024
MAX_ARCHIVE_KEY_CHARS = 512
MAX_ARCHIVE_ETAG_CHARS = 256
MAX_PRODUCER_VERSION_CHARS = 128
MAX_CHECKPOINT_KIND_CHARS = 64
MAX_CHECKPOINT_VALUE_CHARS = 512
DEFAULT_MANIFEST_PAGE_SIZE = 50
MAX_MANIFEST_PAGE_SIZE = 100
DEFAULT_REPLAY_PAGE_SIZE = 1
MAX_REPLAY_PAGE_EVENTS = 4 * MAX_ARCHIVE_EVENTS // 2,000
MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
```

Reject an empty batch, more than 500 events, any one canonical envelope larger than 1 MiB, canonical uncompressed JSONL larger than 4 MiB, compressed output larger than 5 MiB, or a manifest larger than 64 KiB before committing R2. Canonicalize rows one at a time while tracking UTF-8 bytes and abort immediately when an individual or cumulative bound is exceeded; do not first construct an unbounded joined string. On reads, reject an oversized compressed object or manifest from its R2 object size before loading its body. The later Queue phase may use smaller operational batches.

### Deterministic ordering and encoding

- Parse every event with `CanonicalEventEnvelopeSchema`.
- Require every event `tenant_id` to equal the trusted method argument.
- Reject duplicate `event_id` values inside one batch.
- Parse `observed_at` and `occurred_at` to finite epoch milliseconds. Sort a copied array by observed instant, then occurred instant, then exact `event_id` code-unit order; never compare timestamp strings and never mutate caller input.
- When two offset-bearing timestamp strings represent the same instant, treat their time keys as equal and continue to the next tie-breaker. Preserve the original validated timestamp strings in the envelope.
- Serialize each event with recursive `Object.keys(value).sort()` ordering (JavaScript's deterministic UTF-16 code-unit order); do not use locale-sensitive comparison.
- Preserve array order.
- Emit UTF-8 JSONL with exactly one `\n` after every event, including the last.
- Compute SHA-256 over the uncompressed canonical JSONL bytes and encode lowercase hexadecimal.
- Gzip only after size validation and hashing.
- Do not assume gzip byte output is stable across runtimes; idempotency compares the canonical uncompressed hash and validated decoded content.

### Manifest

Use this exact shape:

```ts
type ArchiveBatchManifest = {
  schema_version: 1;
  tenant_id: string;
  batch_id: string;
  data_key: string;
  compression: "gzip";
  content_type: "application/x-ndjson";
  event_count: number;
  uncompressed_bytes: number;
  compressed_bytes: number;
  canonical_sha256: string;
  data_etag: string;
  first_event_id: string;
  last_event_id: string;
  first_observed_at: string;
  last_observed_at: string;
  archived_at: string;
  producer: {
    service: "communicator-control-plane";
    version: string;
  };
  source_checkpoint: {
    kind: string;
    value: string;
  } | null;
};
```

Additional validation:

- `batch_id` uses `CanonicalResourceIdSchema` and begins `batch_`.
- `event_count` is 1–500.
- byte counts are positive safe integers within the locked 4 MiB/5 MiB limits; compressed bytes must equal the R2 object's size.
- `canonical_sha256` is exactly 64 lowercase hex characters.
- `data_key` is an exact derived-key shape capped at 512 ASCII characters.
- `data_etag` is trimmed, nonempty, and capped at 256 characters.
- producer version is trimmed, nonempty, and capped at 128 characters.
- checkpoint kind is trimmed, nonempty, and capped at 64 characters; checkpoint value is trimmed, nonempty, and capped at 512 characters.
- A checkpoint must not contain tokens or credentials; code treats it as opaque non-secret provenance.
- `archived_at` is supplied by an injected clock in tests; never hide nondeterminism behind `Date.now()` in core logic.
- Compare `first_observed_at` and `last_observed_at` as parsed instants and require first <= last; never compare their offset-bearing strings lexicographically.
- Manifest JSON itself is deterministic canonical JSON with a final newline.

R2 data-object metadata:

```text
httpMetadata.contentType = application/x-ndjson
httpMetadata.contentEncoding = gzip
customMetadata.schema-version = 1
customMetadata.tenant-id = tenant ID
customMetadata.batch-id = batch ID
customMetadata.canonical-sha256 = uncompressed JSONL SHA-256
```

Manifest-object metadata:

```text
httpMetadata.contentType = application/json
customMetadata.schema-version = 1
customMetadata.tenant-id = tenant ID
customMetadata.batch-id = batch ID
customMetadata.canonical-sha256 = the same SHA-256
```

### Commit protocol

`archiveCanonicalEventBatch` follows exactly this sequence:

1. validate the trusted tenant ID, batch ID, options, and every event;
2. verify tenant equality, uniqueness, bounds, and deterministic order;
3. create canonical JSONL, SHA-256, gzip bytes, derived data key, and derived manifest key;
4. create the data object using conditional create-only R2 `put` (`onlyIf` with wildcard no-existing-ETag semantics);
5. if data creation reports a failed condition, read the existing object, validate its metadata, gunzip it, recompute its canonical SHA-256, and require exact canonical content equality; otherwise throw `archive_conflict`;
6. build the manifest using the actual stored data object's ETag and size;
7. create the manifest object using the same conditional create-only behavior;
8. if manifest creation reports a failed condition, read and fully validate the existing manifest and referenced data; return `already_committed` only if it is exactly the same logical commit; otherwise throw `archive_conflict`;
9. after a new manifest write, read/validate the committed pair before returning `created`.

Never overwrite an existing data or manifest object. Never delete an orphan in the request path. A later recovery/retention phase may garbage-collect old unreferenced data after an explicit safe-age policy.

If the installed R2 type/API does not accept the exact create-only option described above, stop the task and report the installed signature and compiler error to the primary agent. Do not replace it with a racy unconditional `head`-then-`put` sequence.

### Internal errors

Internal archive code may throw only an `ArchiveError` whose safe code is one of:

```ts
type ArchiveErrorCode =
  | "archive_invalid"
  | "archive_tenant_mismatch"
  | "archive_too_large"
  | "archive_conflict"
  | "archive_not_found"
  | "archive_corrupt"
  | "archive_unavailable";
```

The error's public-safe message must not include an event payload, message body, raw JSONL, credential, token, R2 response body, or provider secret. A `cause` may be retained for internal tests but must not be serialized by default.

## Locked replay contracts

### Cursor

Use a versioned opaque-to-callers cursor encoded as base64url JSON:

```ts
type ArchiveReplayCursorPayload = {
  schema_version: 1;
  tenant_id: string;
  manifest_prefix: string;
  r2_cursor: string;
};
```

- Encoding uses deterministic canonical JSON and no padding.
- Decoding validates the schema and rejects malformed base64url, oversized input, unknown fields, another tenant, another prefix, an empty R2 cursor, or unsupported versions.
- Cap the encoded cursor at 4096 characters and the internal R2 cursor at 2048 characters.
- Cap `manifest_prefix` at 256 ASCII characters and require it to exactly equal the internally derived prefix; callers never supply a free-form prefix.
- The cursor is not an authorization token and is not exposed by a public route in this phase. Trusted tenant context is always a separate required argument.

### Listing

`listCommittedManifestPage`:

- derives `manifests/{tenant_id}/` internally;
- accepts only trusted tenant ID, optional wrapped cursor, and page size 1–100;
- calls R2 `list` with the derived prefix and decoded R2 cursor;
- preserves R2's lexicographic key order;
- derives continuation exclusively from `result.truncated` and `result.cursor`, never from returned object count;
- rejects `truncated: true` without a non-empty cursor as corrupt/unavailable behavior;
- ignores data objects because it never lists `events/`;
- validates every returned key as a manifest key for the trusted tenant; and
- reads/validates manifests rather than trusting list metadata.

### Committed batch read

`readCommittedArchiveBatch` receives a trusted tenant ID and a manifest key obtained from tenant-scoped listing. It must:

1. validate the key belongs to that tenant and parse its date/batch components;
2. get the manifest object, inspect its advertised R2 `size`, reject values above 64 KiB without consuming `body`, and only then read and parse the strict manifest; a separate `head` call is not required because `get` returns metadata plus a still-unconsumed body stream;
3. cross-check manifest tenant, batch ID, data key, partition, and metadata;
4. get the referenced data object;
5. cross-check ETag, byte size, HTTP metadata, and custom metadata;
6. reject compressed object size above 5 MiB before reading its body, then gunzip with a bounded 4 MiB decoded size;
7. recompute SHA-256 over decoded bytes;
8. require the manifest hash, object metadata hash, and computed hash to match;
9. parse nonempty newline-terminated JSONL;
10. validate each envelope, tenant, unique event ID, event count, deterministic order, first/last IDs, and first/last observed timestamps; and
11. return a frozen/copy-safe manifest and event array without executing callbacks.

Reject missing data, invalid gzip, invalid UTF-8/JSON, blank interior lines, missing final newline, unknown fields, wrong tenant, reordered rows, duplicate event IDs, count mismatch, hash mismatch, metadata mismatch, ETag mismatch, byte-size mismatch, and key/manifest disagreement as `archive_corrupt` (or `archive_not_found` only when the requested committed manifest itself is absent).

### Replay page

Use this exact result shape:

```ts
type ArchiveReplayPage = {
  schema_version: 1;
  replay_mode: "projection_only";
  tenant_id: string;
  manifests: ArchiveBatchManifest[];
  events: CanonicalEventEnvelope[];
  next_cursor: string | null;
};
```

`readReplayPage` lists at most the requested number of manifests, validates each committed batch, concatenates their already-deterministic event sequences in manifest-key order, and returns the wrapped continuation cursor. It performs R2 reads only.

The replay-page contract itself enforces at most 100 manifests and 2,000 events. `readReplayPage` defaults to one manifest and additionally enforces at most 8 MiB of uncompressed canonical JSONL across the materialized page. The list-only API keeps its default of 50 and maximum of 100 because listing metadata does not materialize event bodies.

The 8 MiB/2,000-event materialization limits preserve the ability to replay every valid single batch while retaining headroom under Cloudflare Workers' current 128 MB per-isolate memory limit, which is shared by concurrent requests. Treat the current platform limit as an externally verified design input, not as the product bound itself: <https://developers.cloudflare.com/workers/platform/limits/>.

Before fetching any data-object body, `readReplayPage` must validate all selected manifests and sum their declared `uncompressed_bytes` and `event_count`. If either total exceeds the replay-page cap, fail with `archive_too_large`, return no partial page, and do not advance the cursor; callers retry the same cursor with a smaller page size. While reading each accepted batch, pass the remaining page-byte budget into bounded decompression and require actual decoded bytes to equal the manifest value, so underreported metadata cannot bypass the cap. A page size of one is guaranteed to accommodate any individually valid archive batch. Do not redesign the cursor to represent a partially consumed R2 listing page.

Before passing `manifests` or `events` to Zod arrays, use descriptor-only array snapshotting: require `Array.prototype`, inspect the own `length` data descriptor, reject the value immediately when it exceeds its bound, require one own enumerable data descriptor for every index, reject holes/accessors/extra keys/symbols, catch Proxy inspection failures, and copy into a fresh plain array without invoking getters or `get` traps.

Applying the same page or complete archive twice is expected to present the same canonical `event_id` sequence to the later idempotent projection. This phase does not implement the projection.

---

### Task 1: Freeze JSON-safe canonical event contracts

**Files:**
- Create: `packages/contracts/src/canonical-event.ts`
- Create: `packages/contracts/test/canonical-event.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing contract tests**

Cover one valid example for every event type and source, Matrix-shaped opaque IDs, nullable Matrix/remote IDs, a three-month-old backfill timestamp, nested payload objects/arrays, and strict rejection of:

- unknown top-level fields;
- a missing required field;
- unsupported schema version/provider/event/source;
- malformed Communicator IDs;
- empty/oversized opaque IDs;
- resource IDs longer than 128 characters;
- invalid timestamps;
- invalid Matrix sigils;
- `undefined`, nonfinite numbers, bigint, date, map, set, function, class instance, and sparse array payload values;
- direct and indirect cyclic payloads, asserting `safeParse()` returns failure without throwing or leaking `RangeError`;
- `__proto__`, `prototype`, and `constructor` as own keys at root or nested levels, including a null-prototype fixture where `__proto__` is an ordinary own property;
- payload nesting deeper than 32, more than 50,000 total nodes, a collection with more than 10,000 entries, a key longer than 256 characters, and an individual string longer than 1 MiB.

The tests must assert that parsing returns plain JSON-safe values and does not mutate its input.

- [ ] **Step 2: Prove red**

```bash
pnpm --filter @communicator/contracts exec vitest run test/canonical-event.test.ts
```

Expected: fail because the new exports do not exist.

- [ ] **Step 3: Implement only the locked schemas**

Reuse `CommunicatorIdSchema`, `TimestampSchema`, and `ProviderSchema`. Keep recursive JSON schema construction in this module; do not add provider-specific payload contracts.

- [ ] **Step 4: Prove green and typecheck**

```bash
pnpm --filter @communicator/contracts exec vitest run test/canonical-event.test.ts
pnpm --filter @communicator/contracts check
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/canonical-event.ts packages/contracts/src/index.ts packages/contracts/test/canonical-event.test.ts
git commit -m "feat: freeze canonical messaging event contract"
```

### Task 2: Freeze archive manifest and replay contracts

**Files:**
- Create: `packages/contracts/src/archive.ts`
- Create: `packages/contracts/test/archive.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing tests**

Test exact valid manifest and replay-page examples. Test rejection of unknown fields, wrong versions/mode/compression/content type, malformed IDs/keys/hash, zero or excessive counts, unsafe byte counts, invalid ETags/timestamps, `first_observed_at` after `last_observed_at` as instants (including mixed-offset examples), oversized producer/checkpoint strings, tenant-mixed page contents, 101 manifests, and 2,001 events. Prove the exact 100-manifest and 2,000-event boundaries are accepted. Lock `DEFAULT_REPLAY_PAGE_SIZE = 1` and `MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024`. Prove replay arrays reject getters/holes/extra keys and safely snapshot or reject Proxies without invoking `get` traps or leaking inspection errors.

The cursor payload schema is exported for internal tooling tests, but the encoded cursor remains a Worker concern.

- [ ] **Step 2: Prove red**

```bash
pnpm --filter @communicator/contracts exec vitest run test/archive.test.ts
```

- [ ] **Step 3: Implement the exact locked contracts**

Factor reusable lowercase SHA-256 and archive-key string schemas only when that reduces duplication. Do not add public HTTP error schemas or routes.

- [ ] **Step 4: Prove green**

```bash
pnpm --filter @communicator/contracts exec vitest run test/archive.test.ts
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/contracts check
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/archive.ts packages/contracts/src/index.ts packages/contracts/test/archive.test.ts
git commit -m "feat: define archive manifest and replay contracts"
```

### Task 3: Configure a separate local ordinary-R2 archive binding

**Files:**
- Modify: `apps/control-plane/wrangler.jsonc`
- Regenerate: `apps/control-plane/worker-configuration.d.ts`
- Create: `docs/runbooks/r2-archive-local.md`

- [ ] **Step 1: Add the binding explicitly to every Wrangler environment**

Use binding name `EVENT_ARCHIVE`. Add these exact bucket targets:

```text
top-level/local: communicator-event-archive-local
staging:         communicator-event-archive-staging
production:      communicator-event-archive-production
```

Use `preview_bucket_name` only where accepted by the installed Wrangler schema. Because environment bindings are not assumed to inherit, repeat the `r2_buckets` block in staging and production. Do not add a bucket ID, jurisdiction, access key, secret, or restic bucket name.

- [ ] **Step 2: Add the runbook's deployment prohibition first**

The first section must say that names in Wrangler do not provision resources and that no `wrangler deploy`, `r2 bucket create`, or Cloudflare API mutation is authorized in this phase. Record that the event archive must be a separate bucket from encrypted VPS/restic backups.

- [ ] **Step 3: Regenerate and inspect types**

```bash
pnpm --filter @communicator/control-plane types:worker
rg -n "EVENT_ARCHIVE.*R2Bucket" apps/control-plane/worker-configuration.d.ts
pnpm --filter @communicator/control-plane check
```

Never hand-edit the generated type file.

- [ ] **Step 4: Verify local workerd sees an isolated empty R2 binding**

Add no application code. A later writer test will exercise the binding. Run the existing Worker suite to ensure D1 setup and auth remain green:

```bash
pnpm --filter @communicator/control-plane test:worker
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/wrangler.jsonc apps/control-plane/worker-configuration.d.ts docs/runbooks/r2-archive-local.md
git commit -m "build: configure ordinary R2 event archive"
```

### Task 4: Implement deterministic JSONL, hashing, gzip, and key derivation

**Files:**
- Create: `apps/control-plane/worker/archive/errors.ts`
- Create: `apps/control-plane/worker/archive/canonical-json.ts`
- Create: `apps/control-plane/worker/archive/keys.ts`
- Create: `apps/control-plane/worker/archive/codec.ts`
- Create: `apps/control-plane/worker/test/archive/canonical-json.test.ts`
- Create: `apps/control-plane/worker/test/archive/keys.test.ts`
- Create: `apps/control-plane/worker/test/archive/codec.test.ts`
- Create: `apps/control-plane/worker/test/archive/support.ts`

- [ ] **Step 1: Write failing unit tests**

Use deterministic fixtures. Assert:

- nested object keys serialize lexicographically while array order remains unchanged;
- two payloads with different insertion order produce identical bytes/hash;
- JSONL is sorted by the locked tuple and ends in one newline;
- timestamp sorting compares instants correctly when valid inputs use different UTC offsets, and UTC key partitioning uses the earliest instant rather than the lexicographically smallest string;
- duplicate event IDs, cross-tenant events, empty/excessive batches, a >1 MiB canonical event, and >4 MiB total content fail with the correct safe code before R2 exists;
- a valid timestamp produces exact data and manifest keys;
- invalid tenant/batch IDs and any caller-like path input are rejected;
- gzip→gunzip returns byte-identical canonical JSONL;
- checksum is lowercase 64-character SHA-256;
- invalid gzip, invalid UTF-8, blank/interior lines, absent final newline, malformed JSON, invalid envelopes, duplicate IDs, and decoded size overflow fail closed;
- direct/indirect cyclic inputs and prototype-sensitive keys fail with `archive_invalid` rather than a raw validator exception;
- error strings contain no fixture message body.

- [ ] **Step 2: Prove red**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/canonical-json.test.ts worker/test/archive/keys.test.ts worker/test/archive/codec.test.ts
```

- [ ] **Step 3: Implement pure helpers**

Use Web APIs available in workerd. Do not add Node-only `zlib`, Buffer-dependent serialization, or a new compression dependency. Stream accumulation must enforce the 4 MiB decoded limit while reading, not only after allocating an unbounded result.

- [ ] **Step 4: Prove green and check types**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/canonical-json.test.ts worker/test/archive/keys.test.ts worker/test/archive/codec.test.ts
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/archive apps/control-plane/worker/test/archive
git commit -m "feat: add deterministic archive codecs"
```

### Task 5: Implement create-only two-stage archive commits

**Files:**
- Create: `apps/control-plane/worker/archive/writer.ts`
- Create: `apps/control-plane/worker/test/archive/writer.test.ts`
- Modify: `apps/control-plane/worker/test/archive/support.ts`

- [ ] **Step 1: Write failing integration tests against the workerd R2 binding**

Tests must inspect actual objects and cover:

1. a two-event batch writes exactly two objects: one gzip JSONL data object and one JSON manifest;
2. metadata, keys, content types, encodings, counts, sizes, ETag, canonical hash, timestamps, producer, and checkpoint match;
3. no object is created per event;
4. input arrays/objects are unchanged;
5. same logical batch and batch ID returns `already_committed` and leaves object count/content unchanged;
6. same time partition and batch ID with changed payload/event set returns `archive_conflict` and overwrites nothing;
7. same batch ID with reordered identical input remains idempotent;
8. cross-tenant input, duplicate event ID, invalid batch ID, excessive count, and excessive bytes write zero objects;
9. injected data `put` failure writes no manifest;
10. injected manifest `put` failure leaves one orphan data object and no discoverable manifest;
11. retry after manifest failure reuses the verified data object and successfully commits the manifest;
12. an existing corrupted/mismatched data object causes `archive_conflict` and is not overwritten;
13. an existing corrupted/mismatched manifest causes `archive_conflict` and is not overwritten;
14. safe thrown messages do not contain the fixture body.

Use a very small forwarding `R2Bucket` test double only to inject failures or record calls; use the real workerd bucket for storage semantics. Do not reimplement R2 in a large fake.

- [ ] **Step 2: Prove red**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/writer.test.ts
```

- [ ] **Step 3: Implement the locked commit protocol**

Keep the API dependency-injected:

```ts
archiveCanonicalEventBatch({
  bucket,
  tenantId,
  batchId,
  events,
  archivedAt,
  producerVersion,
  sourceCheckpoint,
}): Promise<{
  status: "created" | "already_committed";
  manifestKey: string;
  manifest: ArchiveBatchManifest;
}>
```

Use conditional create-only `put`. Validate any preexisting object by content, not metadata alone. Wrap unexpected R2 failures as `archive_unavailable` without leaking content.

- [ ] **Step 4: Prove green plus regression**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/writer.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/archive/writer.ts apps/control-plane/worker/test/archive/writer.test.ts apps/control-plane/worker/test/archive/support.ts
git commit -m "feat: commit immutable R2 event batches"
```

### Task 6: Implement tenant-scoped manifest listing and committed-batch reads

**Files:**
- Create: `apps/control-plane/worker/archive/reader.ts`
- Create: `apps/control-plane/worker/test/archive/reader.test.ts`
- Modify: `apps/control-plane/worker/test/archive/support.ts`

- [ ] **Step 1: Write failing pagination and validation tests**

Seed committed batches through the real writer wherever possible. Cover:

- lexicographic listing of only the trusted tenant's manifest prefix;
- another tenant's manifests/data never appear;
- an orphan data object is invisible;
- page sizes 1, 50, and 100;
- rejection of 0, 101, noninteger, or nonfinite page sizes;
- list-only calls default to 50 manifests, while materialized replay calls default to one manifest;
- wrapped cursor round trip;
- rejection of malformed/oversized cursor, unsupported version, another tenant/prefix, and empty internal cursor;
- continuation is based on `truncated`, including a forwarding fake whose returned object count is lower than the requested limit;
- `truncated: true` without cursor fails closed;
- returned manifest keys outside the derived tenant prefix fail closed;
- a missing requested manifest yields `archive_not_found`;
- missing data, wrong key, tenant, batch, partition, ETag, sizes, metadata, gzip, JSONL, hash, count, event order, duplicate IDs, first/last IDs, or timestamps yields `archive_corrupt`;
- an R2 manifest object larger than 64 KiB is rejected before its body is read (use a forwarding test object whose body read throws or increments a counter to prove zero consumption);
- replay preflights selected manifests and accepts the exact 8 MiB/2,000-event aggregate boundaries;
- replay rejects 8 MiB + 1 or 2,001 aggregate events with `archive_too_large` before any data body is fetched, returns no partial page/cursor, and succeeds when the same input cursor is retried with a smaller page size;
- actual decompressed bytes are bounded by the remaining page budget and must equal each manifest's declared size, so underreported metadata fails closed;
- one individually valid 4 MiB/500-event batch always remains replayable with page size one;
- corrupt fixture bodies never appear in errors/logs.

- [ ] **Step 2: Prove red**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/reader.test.ts
```

- [ ] **Step 3: Implement cursor/list/read functions**

Export only:

```ts
encodeReplayCursor(payload)
decodeReplayCursor(cursor, expectedTenantId, expectedPrefix)
listCommittedManifestPage(bucket, tenantId, options?)
readCommittedArchiveBatch(bucket, tenantId, manifestKey)
readReplayPage(bucket, tenantId, options?)
```

The implementation may use private helpers but must not add an HTTP handler or action callback.

- [ ] **Step 4: Prove deterministic replay and read-only behavior**

Test two or more batches containing equal timestamps/tie-breakers. Read the full archive twice from a fresh first page and assert identical manifest-key and `event_id` sequences. Wrap the bucket to count calls and assert replay performs `list/get/head` reads only and zero `put/delete` calls.

- [ ] **Step 5: Prove green plus regression**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/archive/reader.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/worker/archive/reader.ts apps/control-plane/worker/test/archive/reader.test.ts apps/control-plane/worker/test/archive/support.ts
git commit -m "feat: read deterministic tenant archive pages"
```

### Task 7: Complete the local archive runbook and repository guardrails

**Files:**
- Modify: `docs/runbooks/r2-archive-local.md`
- Modify: `tests/test_repository_contract.py` only if a narrowly scoped repository guard is required

- [ ] **Step 1: Document the exact object and commit lifecycle**

Include:

- separate bucket purpose and names;
- data and manifest key examples;
- why manifests are commit markers;
- how identical/conflicting retries behave;
- why orphans are invisible and how a later phase may safely garbage-collect them;
- local commands to run Worker tests and inspect bindings;
- current product bounds;
- replay being projection-only/read-only;
- no public API, DO, Queue, Matrix, provider, media, export, deletion, Data Catalog, Pipeline, Brain, or deployment in this phase;
- redaction requirements;
- later provisioning checklist without executing it;
- retention/bucket-lock decision explicitly deferred to the deletion/privacy milestone.

- [ ] **Step 2: Add only stable repository guards**

If added, Python guards may assert:

- `EVENT_ARCHIVE` exists in each required Wrangler environment;
- archive bucket names do not equal or contain the known restic backup bucket reference;
- no checked-in credential-like fields appear in the new config/runbook; and
- no route imports the archive writer/reader yet.

Do not write brittle tests that pin generated line order, current total test counts, or prose paragraphs.

- [ ] **Step 3: Run focused documentation/repository checks**

```bash
python3 -m unittest tests.test_repository_contract -v
rg -n "access[_-]?key|secret[_-]?key|BEGIN .*PRIVATE KEY|token\s*=" apps/control-plane/wrangler.jsonc docs/runbooks/r2-archive-local.md apps/control-plane/worker/archive packages/contracts/src
git diff --check
```

Expected secret scan: zero real credentials. Test fixtures may contain clearly synthetic values only inside test paths.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/r2-archive-local.md tests/test_repository_contract.py
git commit -m "docs: add R2 archive operations contract"
```

If `tests/test_repository_contract.py` does not change, omit it from `git add`.

### Task 8: Full independent verification and scope audit

The implementation worker does not perform this task. Assign a fresh Luna/max/fork-none testing worker with no prior implementation context.

- [ ] **Step 1: Inspect scope before tests**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Fail if the branch changes UI, D1 migrations, app routes, Queue/DO code, Matrix/bridge/Compose/deployment files, or contains secrets/generated runtime state.

- [ ] **Step 2: Regenerate Worker types and require no diff**

```bash
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
```

- [ ] **Step 3: Run all project gates**

```bash
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e
chmod 0755 scripts/init-telegram-runtime.sh
python3 -m unittest discover -s tests -q
git diff --check
git status --short
```

Expected: all commands exit 0 and the worktree is clean. Record actual test totals; do not compare with stale totals in this plan.

- [ ] **Step 4: Perform adversarial archive audit**

The independent worker must explicitly report PASS/FAIL for:

1. canonical envelope covers all locked families and rejects non-JSON values;
2. no one-R2-object-per-message behavior;
3. two-stage commit and orphan invisibility;
4. conditional create-only writes, no overwrite fallback;
5. identical retry, conflicting retry, and partial-failure recovery;
6. tenant prefix derivation and cross-tenant cursor/key rejection;
7. pagination driven by `truncated` and opaque cursor;
8. checksum, metadata, ETag, count, ordering, and key cross-validation;
9. replay twice returns identical event IDs and performs no writes/actions;
10. bounded count, bytes, decoded data, cursor, and string inputs;
11. errors/logs redact content and secrets;
12. no HTTP route, Queue, DO, provider, deployment, Data Catalog, Pipeline, or Brain scope creep.

Any failure returns to the responsible implementation task with a new red regression test before a fix.

### Task 9: Primary-agent final review, PR, and merge

The primary agent—not an implementation worker—performs this task.

- [ ] **Step 1: Review every commit and final diff**

Verify the implementation matches this plan and the approved system specification. Pay special attention to conditional R2 semantics, cursor tenant binding, stream-size enforcement, untrusted metadata, replay side effects, and content leakage.

- [ ] **Step 2: Re-run proportional final checks**

At minimum:

```bash
pnpm check
pnpm test
git diff --check
git status --short
```

Reuse fresh independent browser/Python evidence only if no subsequent relevant change occurred.

- [ ] **Step 3: Push and open one PR**

Suggested title:

```text
feat: add immutable R2 event archive and replay
```

The PR body must state:

- canonical events and manifests added;
- two-object batched commit protocol;
- deterministic projection-only replay;
- test evidence;
- no live Cloudflare resources provisioned/deployed;
- no public API/DO/Queue/provider behavior added; and
- retention/deletion/media/export remain later milestones.

- [ ] **Step 4: Require mergeable, reviewed, green state**

Do not merge with unresolved findings, conflicts, a dirty worktree, missing generated types, failed checks, or unknown external-check status.

- [ ] **Step 5: Merge and fast-forward local main**

After merge:

```bash
cd /home/ubuntu/communicator
git pull --ff-only
git status --short --branch
```

Expected: local `main` equals `origin/main` and is clean.

## Phase acceptance checklist

This phase is complete only when all are true:

- [ ] canonical event and JSON-safe payload contracts are strict and versioned;
- [ ] all required event families/sources are representable;
- [ ] event IDs and provider/Matrix aliases remain distinct;
- [ ] batches are bounded, sorted, canonical JSONL, gzip compressed, and hashed;
- [ ] one batch writes one data object and one commit manifest, never one object per message;
- [ ] R2 writes are create-only and never overwrite committed keys;
- [ ] identical retries converge and conflicting retries fail closed;
- [ ] a manifest-write failure leaves an invisible, recoverable orphan;
- [ ] tenants, keys, cursors, manifests, and events are cross-validated;
- [ ] manifest listing paginates correctly using `truncated` and cursor;
- [ ] corrupt archives fail safely without content leakage;
- [ ] replay is deterministic, idempotency-key preserving, projection-only, and read-only;
- [ ] no public route, DO, Queue, Matrix/provider mutation, or automation execution exists;
- [ ] no Data Catalog/Pipelines/Brain coupling exists;
- [ ] no production/staging Cloudflare resource was created or deployed;
- [ ] runbook and deferred retention/deletion decisions are explicit;
- [ ] all TypeScript, Worker, UI, browser, Python, formatting, and generated-type checks pass;
- [ ] independent Luna verification reports no remaining findings;
- [ ] primary-agent review passes; and
- [ ] the PR is merged into clean, current `main`.

## Next phase after merge

Only after this phase is merged should the primary agent write a new detailed plan for Milestone 7: `TenantProjectionDO` SQLite schema, migrations, idempotent event application, query indexes, projection checkpoints, and rebuild-safe RPC. That next plan consumes `CanonicalEventEnvelope` and `ArchiveReplayPage`; it must not revise this archive contract casually or make the DO authoritative for raw history.
