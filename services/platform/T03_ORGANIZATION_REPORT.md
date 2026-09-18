# T03 organization and lifecycle account slice

Date: 2026-09-19. Status: implemented and verified in the isolated
`codex/platform-t03` worktree; parent review and aggregate integration are
pending. This report does not claim full MVP acceptance, deployment readiness or
consumer adoption.

## Behavior

The account page lists current organizations and pending invitations for the
signed-in, verified email. Users can select an organization explicitly, create
one with an initial owner in the same D1 batch, rename it, manage members and
copy invitation links. Only owner, admin and member roles are accepted. Admins
cannot invite, promote, demote or remove owners. Members can view their own
membership and leave an active organization. The final owner cannot leave or be
demoted; guarded D1 mutations protect owner changes under concurrent requests.
Disabled user accounts remain visible to owner and admin member lists with an
explicit disabled status, and their retained memberships can still be role
managed or removed. Disabling a user does not restore a membership or any
credential after an operator later restores the account.

Better Auth's existing `organization`, `member` and `invitation` rows remain the
source of truth. Migration `0003_organization_authority.sql` adds unique current
membership enforcement and database checks for bounded roles and invitation
status transitions. Invitation acceptance uses one D1 batch to create or reuse
the membership and accept the invitation. It requires a current active user,
verified matching email, active organization and unexpired pending invitation.
Signup invite-only mode recognizes these same invitation rows but does not
silently accept them. Rejoining after removal creates a new membership ID, and
retrying an old accepted invitation does not recreate the removed membership or
restore credentials bound to it. No email is sent.

Tenant writes resolve current authority from the explicit target organization
and current D1 membership. The shared active-authority helper returns no
authority for suspended organizations; display-only reads use a separate
membership lookup so the account page can explain suspension. The human
credential endpoint now requires an explicit `organizationId` and checks the
current membership in both its read and insert predicate.

Operator lifecycle controls use the same Platform session and are separate
from organization roles. They appear only when the active user's stable ID
matches the explicitly configured `PLATFORM_OPERATOR_USER_ID`; its default is
empty. A configured operator can suspend/restore organizations and
disable/restore users. Organization members cannot use those controls, and an
operator can recover a suspended organization. The operator identity is not a
downstream service capability. Raw Better Auth organization paths and
`delete-user` return 404 after path normalization, so the replaced plugin
mutations cannot bypass the guarded routes.

The migration restart probe now uses Cloudflare's D1 migration reader so trigger
bodies are not split on semicolons. It applies all Platform and fixture
migrations once before its persistent Miniflare restart check.

## Verification

- `bun run check` in `services/platform` passed: formatting, TypeScript, all
  four real Worker/D1 test files (four tests), the persistent Miniflare restart
  probe and `git diff --check HEAD`. The run prints the existing non-fatal
  form-urlencoded OAuth test warnings.
- `bun x vitest run --config vitest.worker.config.ts worker/test/organizations.test.ts`
  passed the T03 end-to-end Worker/D1 test. It covers explicit tenant access,
  replaced plugin routes and alternate paths, invitation/signup outcomes,
  concurrent membership and invitation operations, failure injection,
  membership rejoin and credential invalidation, operator recovery, and
  suspension/disablement effects on existing credentials.
- `bun x vitest run --config vitest.worker.config.ts worker/test/account.test.ts`
  passed after updating its raw-organization-route and default-receipt copy
  expectations.
- `bun -e 'import {accountScript} from "./src/account-ui.ts"; new Function(accountScript)'`
  passed against the emitted account script. Parent-run Chromium smoke checks
  also passed for mobile login assets/CSP and the authenticated organization
  flow (create, invite, verified accept, role change, remove and reload).
- `bun x wrangler d1 migrations apply platform-identity --local --persist-to /tmp/platform-t03-migrations.69G40e`
  applied migrations `0001`, `0002` and `0003` successfully to a fresh local
  D1 database. The root `bun run check` passed its 11-workspace-manifest scaffold
  check only; it is not runtime or integration evidence.

The Worker tests simulate Google and GitHub provider HTTP. Chromium intercepted
provider navigation and used seeded Worker sessions for the organization flow;
neither check proves live provider callbacks, deployed Worker configuration or
remote D1 behavior. The account UI does not include the later credential
management, OAuth installation or agent controls. Aggregate integration and
independent parent review remain pending.

## Follow-up fixes

The fixed review follow-up on commit `2804448` exports one
`isOrganizationRole` validator and `OrganizationRole` type for Worker and
account UI callers. Organization detail loads use a request generation and
the current organization selector as a freshness check, so delayed responses
and errors cannot replace or report over a newer selection; rename refreshes
use the same guard. The disabled-member regression also asserts that an
ordinary tenant cannot use the operator lifecycle endpoint, that an owner can
manage and remove a disabled member, and that restoring the user leaves the
removed membership-bound credential invalid.

- `bunx vitest run --config vitest.worker.config.ts worker/test/organizations.test.ts` passed (1 file, 1 test).
- `bunx vitest run --config vitest.worker.config.ts worker/test/account.test.ts` passed (1 file, 1 test).
- `bun run typecheck` passed.
- `bun -e 'import {accountScript} from "./src/account-ui.ts"; new Function(accountScript)'` passed.
- Parent Chromium smoke passed with `--organizations --disabled-member --selection-race`, including disabled-member visibility/management/removal and delayed-selection response protection.
