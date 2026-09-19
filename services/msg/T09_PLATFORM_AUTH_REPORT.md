# T09 Platform authentication evidence

T09 wires msg through the accepted T08 shared clients. A production deployment
registers one Platform service with the exact audience `https://msg.0000.chat`,
the capabilities `msg:read`, `msg:write`, `msg:manage`, and
`msg:operator`, one active `guest:grant` issuer, and a service verifier. The
Worker receives `MSG_PLATFORM_BASE_URL`, `MSG_PLATFORM_AUTHORITY`,
`MSG_PLATFORM_AUDIENCE`, `MSG_PLATFORM_SERVICE_VERIFIER`, and
`MSG_PLATFORM_GUEST_GRANT_ISSUER`. `MSG_OPERATOR_ALLOWLIST` contains explicit
`kind`, `subjectId`, and `organizationId` tuples. An incomplete deployment
configuration fails closed with an identity-authority `503`.

Room schema version 5 adds immutable `owner_guest_id`, a separate `room_acl`
table, and the exact Platform `grant_id` recorded for each source ACL. New
creation resolves the Platform guest control before the
idempotency lookup, scopes plans and receipts by that guest, stores the owner
in the room DO, and records owner ACL capabilities. Existing rooms migrate
without assigning an owner; public and valid management links remain service
permission proofs. Every public read, post, export, management request, and
WebSocket handshake sends the shared Platform credential through the room
service boundary. The DO verifies the current Platform guest grant, exact
returned grant ID, and its current source/action ACL before returning data.
WebSocket attachments contain only guest, room, source, and cursor; raw
credentials remain volatile. A revoked credential closes the socket before the
next broadcast. Creation receipts retain the owner grant reference so replay
renews that grant with a fresh local ACL check instead of re-attesting a
conflicting permission.

The host-only `msg_guest_control` cookie is HttpOnly, Secure, SameSite=Lax and
Path=/; public room credentials use `msg_resource` at `/{room}` and management
credentials use `msg_management` at `/manage/{room}`. The CLI stores these
cookies in a private JSON jar with host, path, expiry, and Secure filtering,
manual redirect handling, and explicit `MSG_SERVICE_ORIGIN` self-hosting. Its
`wss:` lookup is normalized to HTTPS before matching Secure cookies, and each
write reloads under a lock and atomically replaces the mode-0600 file so two
CLI processes merge rather than overwrite each other's state. No Platform
credential is put in a URL, JavaScript storage, or a message author.
An invalid presented resource cookie remains a denial; an explicit `?recover=1`
request rechecks the current control and room link before replacing that cookie.
Operator routes authenticate an issued Platform human or agent bearer and then
require the configured local allowlist tuple; the old static
`MSG_OPERATOR_TOKEN` path is removed.

## Verification

The bounded actual-runtime test is
`services/msg/worker/src/t09-platform.integration.test.ts`. It bundles and
runs the actual Platform Worker against Miniflare D1, registers the msg
service and guest issuer through Platform's trusted registration helpers, and
bridges the actual msg Worker/SQLite Durable Object runtime to that Platform
Worker. It proves:

- a real guest creator and an independent public participant can read and post;
- an actual owner grant revocation denies the owner while the unrelated
  participant continues;
- an authenticated live socket closes with `1008` on the next post after
  Platform revocation;
- the room and participant ACL survive a fresh msg workerd restart;
- the CLI's actual WebSocket transport receives the persisted control and room
  cookies from a `wss:` lookup;
- an actual allowlisted human operator succeeds, while an unlisted human,
  guest, wrong-audience, revoked, and disabled operator are denied; and
  authority outage maps to `503`.

The same test deliberately records one current shared-contract blocker:
management access after a public or owner grant receives `403` on this branch.
The accepted shared Platform permission discriminator change is integrated
separately by the parent; this branch keeps management fail-closed until that
contract is adopted and the returned management grant is proven against the
local source ACL. A local msg capability widening would violate the intended
source-specific ACL boundary.

Commands and results on this branch:

- `bun run check` from `services/msg`: passed the workspace check, 190 Worker
  tests, 17 tooling tests, 57 CLI tests, build, pack, typecheck, and lint. The
  existing `production-synthetic.ts:142` constant-condition warning remains.
- `bun test src/t09-platform.integration.test.ts` from `services/msg/worker`:
  passed 1 actual boundary test with 33 assertions, including D1 creation
  receipt replay/renewal and an actual CLI-cookie WebSocket handshake.
- `bun test src/auth.test.ts src/conversation-room.test.ts src/room-schema.test.ts src/worker.test.ts`:
  passed the focused Worker/DO/auth suite.
- `bun test src/operations.test.ts`:
  passed the guest-scoped D1 operation tests, including the persisted owner
  grant reference.
- `bun test src/cookie-jar.test.ts` from `services/msg/cli`: passed 5 tests
  covering persistence, path/Secure, redirect, `wss:` lookup, and concurrent
  merge behavior.
- `bun services/msg/worker/scripts/t09-platform-browser-smoke.mjs`: passed the
  real Chromium bridge against the actual Platform Worker/D1 and msg
  Worker/DO. It covers owner/participant create, read, post, reload/reconnect,
  revocation and live close, denied owner post with visible preserved draft,
  explicit recovery, and authority outage `503`; no uncaught page errors.
- `bun install --frozen-lockfile` and `git diff --check`: passed. The lockfile
  change is limited to msg's two workspace client dependencies.

The management result above is a shared Platform contract limitation rather
than evidence of a completed management integration. Positive management
browser evidence remains pending the parent's accepted permission discriminator
integration and exact source association check.

T10 still owns atomic ownership claim and former-owner/control revocation; this
branch only stores immutable creation ownership and source-separated ACL facts.
T13 still owns deployment and production rollout evidence, including the final
Platform grant registration once the management permission contract is updated.
