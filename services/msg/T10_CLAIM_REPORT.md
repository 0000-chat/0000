# T10 guest-to-organization claim proof

This change adds the msg-side ownership claim boundary. It does not modify
Platform production code, the shared contracts/client packages, or Database.

`POST /{room}/claim` accepts only `revoke_links` in its JSON body. It requires
an `Idempotency-Key`, an explicit human Platform bearer carrying `msg:claim`,
and the existing `msg_guest_control` cookie. The Worker resolves the cookie
through the registered Platform guest issuer and never creates a replacement
guest for a claim. A guest, public grant, management grant, invalid bearer, or
missing control proof cannot claim a room.

The Durable Object schema keeps `creation_guest_id` immutable and stores the
current organization and claimant subject separately from `owner_guest_id`.
The `claim_receipts` table is keyed by the room's DO plus the idempotency key
and binds the request digest, original guest, claimant subject, destination
organization, and `revoke_links` choice. A transaction checks the current
guest owner and active owner ACL, changes the owner, disables the former owner
and management ACLs, and writes the receipt. Exact retries reauthenticate the
human and original control cookie and replay the receipt after the guest ACL is
inactive. Different claims have one winner. Creation receipts cannot restore a
former owner because owner renewal rechecks the current owner proof.

Organization contexts are discriminated from guest contexts. Ordinary room
read, post, export, and live routes with an explicit bearer verify the current
organization and action capability at both Worker and DO boundaries. The
`GET, DELETE /{room}/manage` route uses the same organization-owner check.
Guest link management remains at `/manage/{room}/{token}`. Invalid explicit
bearers do not fall back to cookies. `revoke_links` durably invalidates public
and management proof, recording, renewal, ACL, and live checks while leaving
the guest identity and unrelated rooms intact.

## Evidence

The focused integration test is
`worker/src/t10-claim.integration.test.ts`. It starts the actual Platform
Worker with D1 and the actual msg Worker with its ConversationRoom Durable
Object, registers the service and guest issuer, issues real human credentials,
and crosses the HTTP boundary. It proves:

- successful default transfer, message preservation, former-owner denial,
  management-link denial, and public participant preservation;
- exact receipt retry, changed options conflict, changed claimant conflict,
  malformed body rejection, guest/public/management-only rejection, missing
  control rejection, invalid explicit bearer rejection, and underprivileged
  human rejection;
- matching-organization read, write, export, organization management, and a
  standard authenticated live handshake/frame; foreign organization denial;
- two concurrent organization claims with exactly one winner;
- `revoke_links` denial for an existing participant, denial for a new link, and
  closure of a participant live socket after an owner post;
- receipt and organization access after a real msg runtime restart, plus the
  original creation-receipt retry remaining denied;
- an identity-authority outage response at the actual msg boundary.

The test also creates a local SQLite tenant/resource fixture populated with the
actual Platform-issued claimant organization, claimant credential, and
guest-control identity. It performs a local transaction that separates
immutable creation provenance from current owner and records an action-bound
receipt. This is a Database-style stored-owner/receipt contract fixture in the
msg harness; it is deliberately not described as Database integration.

The existing T09 Platform integration test remains unchanged.

## Checks

Run from the repository root or `services/msg` as indicated:

```text
bun run check                         # services/msg: pass
bun run --cwd worker check:application # services/msg: pass
bun test worker/src/t10-claim.integration.test.ts # 1 pass, 48 assertions
bun scripts/check-workspace.mjs       # root: 11 workspace manifests pass
```

The service check includes 193 Worker tests (including the unchanged T09
actual Platform/D1 → msg Worker/DO test), 17 tooling tests, 66 CLI tests, and
CLI build/pack checks. It includes the pre-existing lint warning in
`worker/scripts/production-synthetic.ts:142` and otherwise passes lint,
TypeScript, Worker tests, tooling, CLI tests, build, and pack. The focused
integration test passes its actual Platform/D1 → msg Worker/DO boundary
assertions. No Platform or shared-package files changed.
