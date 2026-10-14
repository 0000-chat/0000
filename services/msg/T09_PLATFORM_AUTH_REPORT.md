---
repo: 0000-chat/0000
status: archived
---

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
When `MSG_AUTH_REQUIRED=1`, authenticated live sockets use the standard
WebSocket API (`accept()` plus event listeners). Their current credential and
room context stay in the DO's in-memory socket maps, are cleared on message,
close, and error, and are rechecked through Platform before every broadcast.
They are never serialized as a Durable Object attachment. The unauthenticated
legacy path retains hibernating sockets with a non-secret attachment containing
only guest, room, source, and cursor. Standard sockets can still be evicted by
normal Durable Object lifecycle behavior (Cloudflare documents an idle window
of roughly 70–140 seconds), so clients must reconnect and reauthenticate; this
keeps the live verification proof while using active DO duration and memory.
A revoked credential closes the socket before the next broadcast. Creation
receipts retain the owner grant reference so replay renews that grant with a
fresh local ACL check instead of re-attesting a conflicting permission.

The accepted Platform permission migration is present in this branch. Msg
chooses stable service-owned permission IDs `msg-owner`, `msg-public`, and
`msg-management` when it attests or renews grants; callers cannot select these
IDs. The local ACL records the returned grant ID and the DO checks that exact
ID together with its source and action, so public and management grants for the
same guest remain independently revocable.

The host-only `msg_guest_control` cookie is HttpOnly, Secure, SameSite=Lax and
Path=/; public room credentials use `msg_resource` at `/{room}` and management
credentials use `msg_management` at `/manage/{room}`. The browser keeps these
credentials in host-scoped cookies. No Platform credential is put in a URL,
JavaScript storage, or a message author.
An invalid presented resource cookie remains a denial; an explicit `?recover=1`
request rechecks the current control and room link before replacing that cookie.
When the room already has an active local grant for that source, recovery renews
that exact Platform grant with its stable permission ID; it does not re-attest a
revoked local ACL or widen capabilities.
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
- an actual allowlisted human operator succeeds, while an unlisted human,
  issued agent without the operator grant, guest, wrong-audience, revoked, and
  disabled operator are denied; an allowlisted issued agent also succeeds; and
  authority outage maps to `503`.

The accepted Platform permission discriminator now allows management access
after a public or owner grant without widening msg's local ACL. The actual
integration test receives a `200` management response, revokes that
`msg-management` grant, observes `401` on the management link, and continues
to read through the same guest's independent `msg-public` grant.

Commands and results on this branch:

- `bun run check:application` from `services/msg`: passed the Worker and
  tooling tests, typecheck, and lint.
  The existing `production-synthetic.ts:142` constant-condition warning
  remains.
- `bun test src/t09-platform.integration.test.ts` from `services/msg/worker`:
  passed 1 actual boundary test with 59 assertions, including D1 creation
  receipt replay/renewal, public and management recovery renewal, positive
  human and issued agent operator authentication, underprivileged agent
  denial, independent management/public revocation, and an authenticated
  WebSocket handshake. With `MSG_AUTH_REQUIRED=1`, that handshake takes the
  standard WebSocket registration path; an authorized owner post produces a
  real `message.created` frame before Platform revocation, then the next
  participant post closes the socket with `1008`. The outage and reconnect
  assertions therefore exercise the in-memory authenticated socket path rather
  than a fabricated attachment-only seam.
- `bun test src/auth.test.ts src/conversation-room.test.ts src/room-schema.test.ts src/worker.test.ts`:
  passed the focused Worker/DO/auth suite.
- `bun test src/operations.test.ts`:
  passed the guest-scoped D1 operation tests, including the persisted owner
  grant reference.
- The existing-control concurrent mutation test has a negative proof: restoring
  the old control-cookie lock bypass lets the second process enter while the
  first request is paused, and the focused test fails; the bypass was restored
  before this commit. The committed wrapper holds the same local bakery lock
  across request and response even when a control cookie already exists.
- `T09_PLAYWRIGHT_MODULE=/path/to/@playwright/test/index.mjs bun
  services/msg/worker/scripts/t09-platform-browser-smoke.mjs`: passed the real
  Chromium bridge against the actual Platform Worker/D1 and msg Worker/DO. It
  covers owner/participant create, read, post, reload/reconnect, positive
  management, revocation and live close, denied owner post with visible
  preserved draft, explicit recovery, and authority outage `503`; no uncaught
  page errors. The browser smoke is an optional harness and takes the
  installed Playwright module path explicitly.
- `bun install --frozen-lockfile` and `git diff --check`: passed. The lockfile
  change is limited to msg's two workspace client dependencies.

The parent-owned Platform permission commits are included as `620a317` and
`f930214` in this worktree; their native permission migration and lifecycle
tests remain separately attributable to Platform.

T10 still owns atomic ownership claim and former-owner/control revocation; this
branch only stores immutable creation ownership and source-separated ACL facts.
T13 still owns deployment and production rollout evidence, including the final
Platform grant registration once the management permission contract is updated.
