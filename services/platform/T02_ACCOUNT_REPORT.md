# T02 human account implementation report

**Status:** Implementation checkpoints `4f94a09` and `f346e07` are on
`codex/platform-t02`. The full Platform check and root workspace check pass;
parent aggregate review remains pending. The root check validates workspace
manifests only and is not authentication integration evidence. This is not
production deployment or full-MVP acceptance.

## Implemented behavior

Platform now serves `/login` and `/account` from its Worker. Google and GitHub
complete Better Auth sign-in callbacks and create browser sessions. The account
page edits display name and an optional HTTPS avatar, shows the default
organization's current membership state, and lets the user link or unlink a
provider and sign out. User-controlled HTML is escaped. Account assets use
same-origin requests and security headers; browser code does not store
credentials or provider tokens.

Provider linking is deliberate. A matching email does not merge or link
accounts. The current active Platform session must complete the second
provider's callback, and it must belong to the same user who initiated linking;
linking different provider emails is allowed. The supported Better Auth
`user.validateUserInfo` hook reloads the session from D1 with cookie cache
disabled and rejects missing, disabled or different-user sessions before the
callback mutates provider-account rows. Unlinking requires a trusted origin and
a session within Better Auth's configured fresh window. The window is
explicitly shared with Better Auth as 24 hours, its installed default. The
Worker deletes an account only if another provider row still exists in the same
D1 delete statement, so concurrent unlinks cannot both remove the final login
method. Better Auth's original unlink path is also disabled, including its
trailing-slash normalization.

The first account landing creates or reuses the existing receipt-backed default
organization and owner membership. Removing that membership does not restore it;
the UI reports that access is gone even though the historical receipt remains.
Managed signup is open. Self-hosted mode defaults to open and can be changed to
invite-only; a new identity then needs a verified provider email matching a
pending, unexpired invitation to an active organization. Existing users can
still sign in, and guest bootstrap does not depend on signup policy. T02 does
not provide invitation-management UI.

Disabled users cannot create a new session or manage Platform through an
existing one. Suspended organizations cannot be used to issue credentials.
Profile and raw Better Auth update routes cannot set protected user fields, and
the raw organization update route cannot suspend an organization. OAuth client
and resource administrative privileges are explicitly denied pending an
approved operator flow. Logging out revokes only the current browser session;
existing human API credentials and guest grants remain usable.

Better Auth has provider token encryption enabled. The pinned callback uses its
token helper for access and refresh tokens, but assigns `idToken` directly; no
ID-token encryption is claimed here. The focused test asserts that the Google
access token stored in D1 differs from the synthetic raw response value. The
Worker and Better Auth share the same fresh-session age. Local setup uses
`http://localhost:8787`, matching Wrangler's development origin; see the
[Platform README](README.md#local-setup-and-operator-credentials).

## Verification and boundaries

`worker/test/account.test.ts` sends real requests through the Worker with
Workerd and D1. It exercises callbacks, session cookies and database writes. It
simulates only the provider HTTP boundary: Google token response and synthetic
ID-token claims, plus GitHub token, profile and email responses. It does not
prove live Google/GitHub credentials, provider-side email verification or a
deployed Worker configuration.

The test covers Google and GitHub sign-in, default-organization retries,
same-email non-linking, explicit different-email linking, safe profile updates,
invite-only signup outcomes, bad OAuth state and callbacks, origin rejection,
stale/foreign/concurrent unlink attempts, direct Better Auth unlink denial,
OAuth administration denial, disabled/suspended access, logout and survival
of unrelated credentials. It also checks that the account page and script do
not expose provider tokens and that the stored Google access token differs from
the synthetic raw value. It does not assert refresh-token or ID-token storage
format. The existing T01 callback fixtures now target `/account`, the actual
account landing page added in T02.

Callback authorization has three explicit denial cases. The first runtime run
before `f346e07` proved the gap: after link initiation and real sign-out, the
state-cookie-only callback succeeded (the expected error was absent). The
follow-up test now confirms that this callback returns
`link_session_required` and leaves every provider-account and token field
unchanged. It also keeps the D1 session row but marks the initiating user
disabled, then verifies that the public Worker denies the callback and a direct
Better Auth callback invocation is rejected by the `validateUserInfo` hook.
Finally, a different active user's session cannot finish the initiating user's
link state, and account/token snapshots remain unchanged. A callback with the
same active user still links successfully.

Checks completed at the code checkpoint:

- `sh scripts/format-check src worker/test/account.test.ts`
- `bun run typecheck`
- `bun x vitest run --config vitest.worker.config.ts worker/test/account.test.ts` — 1 file and 1 test passed.
- `bun run check` — passed: formatting, typecheck, all 3 Worker/D1 test files (3 tests), and persistent Miniflare D1 restart probe.
- `bun run check` from the monorepo root — passed the workspace scaffold check for 11 manifests; this does not run auth integration tests.
- `bun x wrangler d1 migrations apply platform-identity --local` — successfully applied local migrations `0001_better_auth.sql` and `0002_platform_authority.sql`.

The full Platform run prints existing non-fatal warnings for form-urlencoded
OAuth test requests, then exits successfully. The complete MVP also still
requires later organization and membership administration, API credential and
agent controls, production OAuth installation/consent lifecycle, consumer
adoption, service-owned resource behavior and managed deployment ownership.
OAuth authorization-server lifecycle and its concurrency guarantees remain
later work; this T02 change only blocks unapproved OAuth client/resource
administration endpoints and preserves the T01 probe.
