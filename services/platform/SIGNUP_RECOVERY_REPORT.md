# Signup recovery proof

This change converts the reproduced interrupted social signup failure into a
request-scoped recovery path for GitHub and Google. The provider subject is
captured only from Better Auth's verified provider profile during user
creation. It is stored as two server-only fields on the new user. A later
verified profile reaches the supported asynchronous `mapProfileToUser` hook,
which conditionally inserts the missing account for the exact pending
provider/subject. Better Auth then performs its normal account lookup,
token update, session issuance, and default organization setup.

The migration adds a partial unique key for pending bindings and a unique
`(providerId, accountId)` key. SQLite triggers enforce the marker shape, reject
a marker that already has a matching account, reject an account insertion by a
different user while the marker is pending, and clear the matching marker when
the account is inserted. Recovery inserts only the minimal account row; it
does not store provider tokens or use an email match. The existing invitation
policy and explicit link-session checks remain in place. The recovery hook
reads Better Auth's supported request-scoped `getOAuthState()` and skips any
OAuth callback carrying the server-generated `state.link` continuation, so an
explicit link session is validated before it can affect a pending signup.

## Reproduced failure and repaired path

The pre-fix evidence at `e32e821` (based on `9a80311`) injected a D1 failure
for the account insert. The callback left one user, zero accounts, and zero
sessions. A fresh callback with the same provider identity then returned
`account_not_linked` and left the orphan unchanged. The earlier human-runtime
probe also passed signup, runtime disposal, restart against the same D1
directory, session and organization continuity, two-key authentication,
revocation, and logout; those controls remain in the dedicated
`HUMAN_RECOVERY_PROBE_REPORT.md`.

The repaired focused fixture exercises the real Worker and mocked provider
HTTP boundary. It passed ten tests:

- The injected failure leaves one pending GitHub marker. A fresh callback with
  the same subject creates the account for the original user, returns the
  account page, creates one session, clears the marker, and exposes no hidden
  marker fields in the session. `/api/me` returns the same user, default
  organization, and owner membership.
- The same injected-failure and retry sequence passes for Google using the
  exact OIDC `sub` value as the pending subject. The recovered session and
  account belong to the original pending user and the marker clears.
- A different GitHub subject with the same email returns
  `account_not_linked`, with no account or marker mutation. A stale state
  callback has no account or session side effect. An unsigned direct Google
  ID token is rejected with `401` before recovery. The correct original
  subject then recovers successfully.
- A forced recovery account-insert failure leaves the marker and no account.
  The disabled pending user remains denied with `account_not_linked`; after
  re-enabling the user, the same verified subject recovers and clears the
  marker.
- A pending orphan combined with a revoked explicit-link callback returns
  `link_session_required`; the callback leaves both the pending marker and
  provider account absent. A concurrent fresh retry and explicit-link claim
  with overlapping provider lookups leaves exactly one account owned by the
  pending user, proving the cross-table pending-owner guard.
- Two simultaneous fresh retries against the same pending marker both return
  the account page and create sessions for the same user. The conditional
  account insert leaves one account, one default organization, and one owner
  membership. The bounded provider barrier observed both lookups overlapping.
- After recovery, a second provider account is explicitly linked and the
  original account is deliberately unlinked. A later login for the unlinked
  provider returns `account_not_linked`; the marker stays null and the account
  is not revived.
- The existing explicit-link race observes two overlapping provider lookups,
  returns one successful callback and one
  `account_already_linked_to_different_user`, and finds exactly one account
  owner while both original sessions remain attached to their users.
- Two fresh signups with overlapping provider lookups for the same GitHub
  subject converge to one user and one account owner. A fresh retry returns
  the established user and the same `/api/me` organization and membership;
  there is one owner membership and no second user.

The concurrent fixture records the bounded provider barrier result and reports
the experiment inconclusive if the two lookups do not overlap. This run
observed `overlap: true` and `providerLookups: 2`. It does not claim to cover
every possible database scheduling interleaving.

When the explicit-link side wins the mixed race, the pinned Better Auth
callback does not translate the owner-guard trigger failure and returns a
server error. The account write is rejected, the pending user remains the
only owner, and a fresh signup retry completes normally. This is recorded as
the current error-shaping seam; no worker route change was made in this
bounded auth/schema scope.

## Verification

Commands run in this worktree:

- `bunx vitest run --config vitest.worker.config.ts worker/test/human-recovery.test.ts --reporter=verbose` — 1 file, 10 tests passed.
- `bun run typecheck` — passed.
- `bun run check` from `services/platform` — format check, typecheck, all 7
  Worker test files (18 tests), and the built-in restart probe passed.
- `bun scripts/test-human-recovery-restart.mjs` — passed actual signup against
  the mocked GitHub service, persistent D1/runtime restart without reapplying
  migrations, same session and default organization/member, both API keys,
  independent revocation, and logout behavior.
- `bun run check` from the repository root — workspace scaffold check passed
  for all 11 workspace manifests.

The proof uses local Miniflare/D1 and mocked provider responses. The positive
Google case exercises the OAuth callback/code-exchange seam with a mocked
token endpoint; the direct Google ID-token case is intentionally only tested
as an unsigned-token rejection. The injected database failure intentionally
produces a provider callback error while preserving the durable marker; the
subsequent valid retry is the recovery proof. No deployment or external write
was performed, and no T05-owned worker, account UI, agent-state, or `0005`
migration file was changed.
