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

The accepted Platform permission migration is present in this branch. Msg
chooses stable service-owned permission IDs `msg-owner`, `msg-public`, and
`msg-management` when it attests or renews grants; callers cannot select these
IDs. The local ACL records the returned grant ID and the DO checks that exact
ID together with its source and action, so public and management grants for the
same guest remain independently revocable.

The host-only `msg_guest_control` cookie is HttpOnly, Secure, SameSite=Lax and
Path=/; public room credentials use `msg_resource` at `/{room}` and management
credentials use `msg_management` at `/manage/{room}`. The CLI stores these
cookies in a private JSON jar with host, path, expiry, and Secure filtering,
manual redirect handling, and explicit `MSG_SERVICE_ORIGIN` self-hosting. Its
`wss:` lookup is normalized to HTTPS before matching Secure cookies, and each
write reloads under a private bakery lock and atomically replaces the mode-0600
file so two CLI processes merge rather than overwrite each other's state. Each
lock attempt publishes a PID-plus-unpredictable-UUID claim in
`${cookieFile}.locks`, chooses a bounded ready ticket, atomically replaces its
own choosing claim with complete ready metadata, and waits on the defined
post-ready snapshot ordered by `(ticket, UUID)`. A claim filename is never
reused; liveness errors including `EPERM` are treated as alive, unknown or
corrupt metadata fails closed, and cleanup unlinks only the exact dead claim
that was read. Release happens after cookie persistence and cannot remove a
different owner's claim. This protocol requires a coherent local filesystem;
NFS and other filesystems without local directory/rename coherence are not
supported. If a process crashes after the server commits but before the jar
persists the response cookie, one remote guest cannot be guaranteed; the
existing jar file remains intact. No Platform credential is put in a URL,
JavaScript storage, or a message author.
An invalid presented resource cookie remains a denial; an explicit `?recover=1`
request rechecks the current control and room link before replacing that cookie.
When the room already has an active local grant for that source, recovery renews
that exact Platform grant with its stable permission ID; it does not re-attest a
revoked local ACL or widen capabilities. The wrapped CLI fetch holds the jar
lock across a first-use request and its response, so concurrent processes share
one newly established control guest instead of merging credentials from
different guests.
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
  issued agent without the operator grant, guest, wrong-audience, revoked, and
  disabled operator are denied; an allowlisted issued agent also succeeds; and
  authority outage maps to `503`.

The accepted Platform permission discriminator now allows management access
after a public or owner grant without widening msg's local ACL. The actual
integration test receives a `200` management response, revokes that
`msg-management` grant, observes `401` on the management link, and continues
to read through the same guest's independent `msg-public` grant.

Commands and results on this branch:

- `bun run check:application` from `services/msg`: passed 192 Worker tests,
  17 tooling tests, 64 CLI tests, build, pack, typecheck, and lint. The
  existing `production-synthetic.ts:142` constant-condition warning remains.
- `bun test src/t09-platform.integration.test.ts` from `services/msg/worker`:
  passed 1 actual boundary test with 46 assertions, including D1 creation
  receipt replay/renewal, public and management recovery renewal, positive
  human and issued agent operator authentication, underprivileged agent
  denial, independent management/public revocation, and an actual CLI-cookie
  WebSocket handshake.
- `bun test src/auth.test.ts src/conversation-room.test.ts src/room-schema.test.ts src/worker.test.ts`:
  passed the focused Worker/DO/auth suite.
- `bun test src/operations.test.ts`:
  passed the guest-scoped D1 operation tests, including the persisted owner
  grant reference.
- `bun test src/cookie-jar.test.ts` from `services/msg/cli`: passed 11 tests
  covering persistence, path/Secure, redirect, `wss:` lookup, concurrent
  merge behavior, ticket/UUID acquisition order, a choosing entrant crossing
  the ready boundary, separate-process first-use bootstrap overlap, crash
  recovery with preserved jar state, a delayed live owner, and competing
  dead-owner reclaimers preserving a replacement owner.
  The choosing-entrant case uses the unset-by-default
  `T09_COOKIE_LOCK_BARRIER_DIR` test-only environment barrier at the actual
  choosing and ready publications, plus a waiting-path observation marker.
  As a negative proof, temporarily bypassing `waitForDefinedSnapshot` made
  that test time out waiting for the observation marker; the source was
  restored before this commit.
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
