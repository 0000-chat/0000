# T10 guest-to-organization claim proof

Reviewed source checkpoint `1a438da` is integrated at `c54d884`. Parent
verification passes all 83 actual Platform/D1-to-msg/DO claim assertions,
the deterministic DO suite, and the full combined msg package checks.
Independent Standards and Spec reviews cleared the corrected implementation
and evidence. A bounded authenticated Grok 4.6 high adversarial review of claim,
receipt and link-revocation races found no confirmed defect. Current-authority
checks occur at request/next-frame boundaries; an already authorized in-flight
operation is not a cross-service atomic transaction. This does not establish
production deployment or Database adoption.

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

The test also runs a callable local SQLite tenant/resource fixture. Each
operation first uses the actual Platform client to verify the human credential
and resolve the actual guest-control credential, then performs an atomic local
resource transfer and action-bound receipt write. It proves missing and wrong
guest proof, foreign-tenant denial, exact retry and conflict, read/write
authorization, underprivileged and foreign-human denial, and that the stored
guest subject is the Platform-resolved guest ID rather than the cookie secret.
Receipt identity is scoped to `(resource_id, idempotency_key)`: reusing the A
receipt key against foreign B reaches B's tenant/owner denial, leaves B's
guest-owned row unchanged, and creates no B receipt. The fixture is
deliberately local contract evidence; it is not Database integration.

The boundary proof also advances a deterministic DO clock through expiry before
both a new claim and a receipt retry, pauses a real Platform guest-grant
renewal between proof and DO recording while `revoke_links` claims the room,
proves the stale record is rejected, removes a real Platform membership and
proves both read and claim denial for that removed member on a still
guest-owned room. The valid owner remains able to read it, and an active
claimant can then use the denied request's same idempotency key, proving the
denied request did not transfer the room or write a receipt. Two other rooms
receive owner grants before one is claimed; the original owner credential for
the unrelated room still reads successfully afterward. Public links remain
active for the default claim, while every stored management ACL is disabled
and `revoke_links` disables all public ACLs.

The T09 Platform integration assertions remain unchanged. Its bundling helper
and this test now share the child Bun Worker-bundle path so the actual boundary
tests do not use the intermittent in-process build path.

## Checks

Run from the repository root or `services/msg` as indicated:

```text
bun run check                         # services/msg: pass
bun run --cwd worker check:application # services/msg: pass
bun test worker/src/t10-claim.integration.test.ts # 1 pass, 83 assertions
bun scripts/check-workspace.mjs       # root: 11 workspace manifests pass
```

The service check includes the Worker tests (including the unchanged T09
actual Platform/D1 → msg Worker/DO assertions), 17 tooling tests, 66 CLI tests, and
CLI build/pack checks. It includes the pre-existing lint warning in
`worker/scripts/production-synthetic.ts:142` and otherwise passes lint,
TypeScript, Worker tests, tooling, CLI tests, build, and pack. The focused
integration test passes its actual Platform/D1 → msg Worker/DO boundary
assertions. No Platform or shared-package files changed.
