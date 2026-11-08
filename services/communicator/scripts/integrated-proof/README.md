---
repo: 0000-chat/0000
status: current
---

# Run the integrated local proof

Use this runner to check the local Platform, Communicator, and gateway
composition. It creates isolated state, drives production HTTP and durable
execution, and writes a body-free JSON evidence file. It does not send real
messages, pair accounts, deploy services, or authorize live-client acceptance.

## Prepare the public checkout

Install the monorepo dependencies and Communicator's nested pnpm dependencies
using their lockfiles. Install the pinned Rust toolchain and a Playwright
Chromium browser. Use Node 24 or 26, Bun, pnpm, Cargo, and a Linux host with
loopback networking. The runner obtains Miniflare and Wrangler through the
control-plane workspace's installed dependencies.

Run all commands below from `services/communicator` unless stated otherwise.
Do not supply production credentials or copy an operational environment file.
The fixture issues its own ephemeral Platform credentials and rejects unknown
outbound destinations.

## Execute the backend composition

Choose a new output path outside the checkout:

```sh
pnpm proof:integrated /tmp/communicator-proof.json
```

The runner refuses to overwrite an existing evidence file. Read `cases`,
`source`, `versions`, and `cleanup` in the result. Exit 0 means all executed
required local cases pass. Exit 1 means an executed defect or setup failure.
Exit 2 means local evidence remains incomplete without an executed defect.
`pilot_live_acceptance` always remains false. An `unsupported` or `unverified`
external claim is never converted to a local pass.

Keep the checkout unchanged until the runner finishes. The bundle hashes
tracked and new source files before and after execution. A changed source
identity fails local acceptance. Symbolic links contribute their link targets,
not the contents of another checkout.

The runner creates a private temporary directory, uses ephemeral local ports,
and reconstructs actual runtime processes against the same persistent state.
It removes the directory and stops owned processes on normal completion or a
caught failure. Do not treat an interrupted process or absent bundle as a pass.
Build output and runtime logs are private temporary diagnostics, not the public
evidence bundle. Review captured output before sharing it.

## Inspect essential UI states

Run the separate simulated-data browser check:

```sh
pnpm proof:ui
```

Set `COMMUNICATOR_PROOF_CHROME` to an existing Chromium executable if the
Playwright browser is unavailable. Set `COMMUNICATOR_PROOF_UI_DIR` to a new
directory for screenshots. Inspect the ready composer, uncertain acceptance,
accepted-but-not-delivered state, independently selected webhook deliveries,
and narrow-screen retry controls. The browser assertions exercise same-request
retry and cancelled or accepted webhook retry dialogs. These are MSW-backed UI
checks, not claims about the actual backend, a real provider, or an external
client.

Set `COMMUNICATOR_PROOF_RECORD=1` to record the browser interactions with a
visible pointer. The screenshots show the accepted state and narrow layout
more clearly than the recording. Native confirmation dialogs are answered by
Playwright and may not appear in its video.

## Run the owning checks

Run `bun run check` at the monorepo root. Then run these commands in this
service:

```sh
./scripts/check
pnpm check:application
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane test:ui
cargo test --workspace --all-features
cargo test --test t13_transport_policy
```

Record their commands, exit codes, and decisive summaries alongside the
composition evidence. These checks supplement the integrated run. Passing
isolated tests cannot replace any required composition observation.

## Read component boundaries correctly

- Platform runs its actual Worker and D1 schema. Human OAuth sessions,
  organization consent, agent credentials, and service authentication execute
  production code. Only the external GitHub identity endpoints are controlled.
- Communicator runs its production HTTP entry, middleware, D1, R2, and SQLite
  Durable Objects in workerd. Local fixture routes seed directory/provider
  state and drive explicit clocks through production lifecycle functions.
  They do not replace authorization, native parsers, dispatch, or evidence.
- The Rust sidecar uses `ProvisioningGatewayServer::new_with_matrix_runtime`,
  the actual private HTTP authority client, protected persistent Store, and
  actual SDK send, receipt, rename, history-decryption, and media paths.
  Its SDK authentication and joined-room sync are synthetic. Persistent SDK
  stores are real, but this is not production daemon login or restore proof.
- Controlled Matrix endpoints return encrypted Megolm events, encrypted media,
  and bounded bot observations. The loopback transport constructor exists only
  under tests or `loopback-test`. The normal transport still rejects HTTP.
- Eight finite local controlled-copy stores hold explicit fixture copies.
  Production HTTP inventory and cleanup adapters delete six stores' content
  and preserve two stores' synthetic auxiliary material. This is not a host
  Synapse, bridge database, or backup-infrastructure restoration.

## Review the acceptance matrix

The JSON case IDs cover these independently executed boundaries:

| Contract | Required observation |
| --- | --- |
| Authorized operations | Real human and managed-agent authentication, stored read, one real SDK send, replay without duplicate I/O |
| Encrypted context and files | Human-only import, actual Megolm decryption, stored text/media digests, binary authorized download, wrong-account and wrong-grant denial |
| Receipts and groups | No implicit read receipt, explicit receipt I/O and replay, denied actor/scope, actual rename plus fresh bot evidence, stale revision denial |
| Provider evidence | Caller cannot choose status, forged or wrong-reference observation conflicts, bridge acceptance stays separate, authenticated DM delivery persists |
| Authorization | Cross-tenant/account/chat denial, revoked credential, final claim after grant revocation or route/session rotation, explicit rejected outcome and zero Matrix I/O |
| Bootstrap lifecycle | Pristine tenant stays idle without implicit initialization, normal initialization and ingestion stay idle, legacy attempt-three target gets one bounded recheck |
| Recovery | Worker and gateway process reconstruction, provider rejection, lost actual gateway response, no automatic uncertain resend, explicit audited distinct resend |
| Offline confirmation | Four-hour boundary at −1 ms, exact, and +1 ms, original authority/deadline/account preserved, human decision and fail-closed stale epoch |
| Webhooks | Independent subscription cutover, stable discovery pages, automatic retry at 24 hours −1 ms, exact, and +1 ms, distinct explicit manual retry |
| Removal and restore | Old download grant denied, original R2 bytes and late SQLite edits suppressed, stale send and webhook blocked, production controlled-copy gate and projection activation |

Require the exact receipt room, `m.read` kind, and stored Matrix event ID.
Inspect the replacement resend's stored transaction and actual encrypted
Matrix tuple, not only its command ID or request count. Each four-hour offset
starts with a distinct waiting command so a previous transition cannot hide
a late-observation failure.

Four-hour stepping advances the lifecycle and executor clocks only. Platform's
original credential lifetime remains unchanged, and reconnect invalidates its
saved account-grant epoch. Do not claim successful four-hour execution or an
independently clock-stepped Platform expiry check.

Matrix acceptance is not WhatsApp delivery. An authenticated bot's matching
WhatsApp DM report is bridge-reported provider delivery, not a live contact
acknowledgment. Provider-read evidence remains unsupported. Real WhatsApp,
ChatGPT, Grok, signed release provenance, deployment, and extracted-daemon
session restoration need separate evidence and authorization.
