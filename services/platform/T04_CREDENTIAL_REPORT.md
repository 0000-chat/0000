# T04 human credentials and registered service boundary

**Date:** 2026-09-19  
**Status:** implementation complete on `codex/platform-t04`; parent review and
aggregate integration are pending. This report records bounded local evidence,
not deployment or full MVP acceptance.

T04 adds personal opaque API credentials to the existing Platform account
experience. A signed-in member issues a key for an explicitly selected active
organization and one registered service audience. Platform stores only the
SHA-256 verifier and metadata: name, subject, organization, membership,
audience, capabilities, expiry and lifecycle links. The secret is returned from
issue or rotation once and is rendered in the page without putting it in a URL,
browser storage or a reloadable account response. Listing is metadata-only and
is restricted to the current user's current membership.

The maximum lifetime is the positive finite Worker variable
`PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS`, defaulting to `90`. Requested lifetime
is expressed in days and may only shorten that maximum. Omitted duration uses
the maximum; malformed, zero, negative, non-finite and over-limit values are
rejected. An invalid configuration makes issue and rotation unavailable. Date
values are bounded before D1 writes.

Rotation uses one conditional D1 batch: the predecessor is revoked only when
it is still active, current for the user, organization and membership, and
within the live service capability catalog; the replacement is inserted from
that predecessor in the same batch. A unique predecessor index and a post-batch
confirmation produce one winner for concurrent rotations. Revoke is an
idempotent current-owner mutation and takes effect on the next verification.
Removed memberships, disabled users, suspended organizations, expired or
revoked keys and disabled or rotated service verifiers fail closed. A service
verifier is accepted only at the internal authentication transport and cannot
authorize a browser lifecycle route.

Trusted service registration is provided by `scripts/provision-service.ts` and
the `provision:service` package script. It supports register, metadata update,
verifier rotation and disablement against an explicit `--local` or `--remote`
Wrangler D1 target. Registration validates bounded service IDs, exact HTTPS
audience URLs (including resource paths, without credentials, query or
fragment) and unique non-empty capabilities. Service ID and audience are
immutable; a repeat registration reports `service_conflict` without rotating
the existing verifier. Verifiers are generated randomly, hashed in the SQL,
and printed only after successful registration or rotation. Wrangler receives
an argument array, and update, rotation and disable operations assert their D1
mutation result before reporting success.

## Verification

The focused real Worker/D1 suite is:

```text
bun x vitest run --config vitest.worker.config.ts worker/test/credentials.test.ts
```

It passed 1 file and 3 tests. The suite signs in through the Worker with
synthetic GitHub HTTP, registers two services (`https://resource-one.0000.test`
and `https://resource-two.0000.test/mcp`), issues and lists a human key, checks
that the raw secret is absent from D1 and list/account responses, and sends
requests through the actual shared Platform client and resource fixture. The
first audience succeeds only for its own resource/action boundary; the second
audience, wrong audience, verifier bearer, and wrong resource return their
documented denial categories.

The same suite proves one-day narrowing and invalid lifetime rejection, invalid
configuration failure, concurrent rotation with exactly one `201` and one
`409`, predecessor/replacement links, idempotent revoke, immediate verifier
rotation and service disablement, catalog narrowing and expansion, and a
service verifier's inability to issue a human key. A D1 trigger injected before
the replacement insert proves that a failed rotation leaves the predecessor
active and unlinked. A concurrent rotation/revoke probe confirms that the
operation leaves no unexpected second active predecessor.

The compatibility suites were run together:

```text
bun x vitest run --config vitest.worker.config.ts \
  worker/test/auth-callback.test.ts worker/test/account.test.ts \
  worker/test/organizations.test.ts worker/test/credentials.test.ts
```

They passed 4 files and 6 tests. The callback caller was migrated to the
explicit organization-scoped revoke body. The organization suite retains the
membership removal/rejoin and suspended or disabled-authority checks that gate
old membership-bound credentials.

The browser key flow was run against a real Miniflare Worker/D1 runtime with
synthetic stored sessions and intercepted provider navigation:

```text
bun /tmp/platform-account-browser-smoke.mjs \
  /home/ubuntu/0000-full/worktrees/platform-t04/services/platform \
  --organizations --credentials
```

It passed key issue, one-time display, reload without plaintext recovery,
rotation, revoke and switching the credential form to a second organization.
The parent’s corrected browser harness also passed the combined organization,
disabled-member and selection-navigation flow, including clearing the old
secret and disabling old controls while navigation was held.

Local provisioning was exercised sequentially after applying the migrations:

```text
bun x wrangler d1 migrations apply platform-identity --local
bun run provision:service -- --local register --service-id t04-cli-final \
  --audience https://cli-final.0000.test/mcp --capability resource:read \
  --name 'CLI final service'
bun run provision:service -- --local update --service-id t04-cli-final \
  --capability resource:read --capability resource:write \
  --name 'CLI final updated'
bun run provision:service -- --local rotate-verifier --service-id t04-cli-final
bun run provision:service -- --local disable --service-id t04-cli-final
bun run provision:service -- --local disable --service-id t04-cli-final
```

The migration command reported no pending migrations after applying `0004`.
The provisioning commands reported `registered`, `updated`, `rotated`,
`disabled` and `already-disabled` respectively. The generated verifier values
were captured only for the local operation and are omitted from this report.
Argument and conflict checks also passed:

```text
bun run provision:service -- --local --remote register ...
  -> exit 1: Choose exactly one provisioning target
bun run provision:service -- --local register --service-id t04-cli-final ...
  -> exit 1: service_conflict; no verifier was rotated
bun run provision:service -- --local register --service-id bad/id ...
  -> exit 1: Invalid --service-id
```

## Checks

The following package checks passed on this branch:

```text
bun run typecheck
sh scripts/format .
git diff --check HEAD
```

`bun run check` additionally runs the complete Worker suite and persistent D1
restart probe. It passed 5 files and 7 tests, then reported `Miniflare D1
runtime restart persistence probe passed.` The run emits the existing
non-fatal OAuth form-urlencoded body warnings. The root check also passed:

```text
bun run check                         -> workspace scaffold check passed (11 workspace manifests)
```

The root command remains a workspace manifest scaffold check, not
authentication evidence.

## Limits

Provider HTTP is synthetic in Worker tests. The Chromium flow intercepts
provider navigation and seeds browser sessions, so it does not prove live
Google/GitHub callbacks, external provider policy or a deployed Worker. D1 and
service provisioning evidence is local; no remote target was invoked and no
deployment was performed. The resource service is a labeled fixture proving the
shared client and service-owned resource boundary, not production adoption by
Database, Communicator or another consumer. Agent credentials, OAuth
installation lifecycle, managed deployment ownership and full consumer
migration remain later slices, so this report does not claim full MVP
acceptance.
