# T05 organization-owned agent report

Date: 2026-09-19. This report records the bounded implementation and local
Worker/D1 evidence for T05 on branch `codex/platform-t05`. Parent review,
aggregate integration and the full Platform MVP acceptance decision remain
separate.

## Delivered behavior

- Migration `0005_agent_authority.sql` adds organization-owned agents and an
  append-only grant history with one current grant per agent/service. Agent
  organization and creator bindings are immutable; grant parent, service and
  audience bindings are checked by D1 triggers.
- Owner and admin sessions can create, list, rename, disable and re-enable an
  explicitly selected organization's agents. Members, removed or disabled
  users, foreign organizations, machine bearers and untrusted mutation origins
  are denied. Creator IDs are audit metadata only and are not used for agent
  verification or validity.
- Grants bind an agent to one registered service and exact audience. Existing
  grants can narrow; widening requires revocation and a new grant ID. Grant
  revocation also retires its agent credentials, and disabled agents deny
  otherwise current credentials until re-enabled.
- Agent credentials use the existing protected `platform_credential` table with
  `kind='agent'`, the stable agent ID as `subject_id`, organization and grant
  bindings, and `membership_id=NULL`. Secrets are returned once. Verification
  reads the current credential, agent, organization, grant and service catalog
  in one joined authority snapshot, checking finite expiry, revocation and
  capability subsets on every request. Human and guest verification use the
  same current credential plus authority snapshot pattern for their state.
- The Platform account UI exposes agent, grant and credential lifecycle controls
  for the selected organization and clears displayed secrets when the selected
  organization changes. Late agent UI results are scoped to the request's
  selected organization and view generation.

## Evidence

`worker/test/agents.test.ts` exercises real `SELF` Worker routes and D1 state
with simulated Google provider HTTP:

- two separately limited service audiences authenticate the same stable agent
  subject with distinct grant IDs, while wrong-audience authentication fails;
- grant narrowing invalidates a previously broader credential and widening is
  rejected until revocation and reauthorization;
- disabling and restoring the agent gates current credentials;
- concurrent credential rotation produces one winner and one conflict, then
  revocation is idempotent;
- grant revocation retires its credentials and reauthorization creates a new
  grant ID; current service-catalog narrowing denies without broadening stored
  credential capabilities;
- concurrent grant narrowing uses a stored-capability compare-and-set, so a
  stale request cannot reintroduce a capability under the same grant ID;
- deterministic verification interleavings start with an agent disabled or an
  organization suspended, revoke the credential while that authority remains
  unavailable, then restore the authority state; both requests remain invalid
  after the initial credential read observed an otherwise-live key;
- invalid lifetime configuration blocks issue and rotation while allowing
  metadata listing and revocation;
- shared-client requests through the real protected-resource fixture prove
  separate audience access, wrong audience, missing capability and foreign
  organization-owner denials; both current grants remain usable after creator
  departure;
- a temporary D1 `BEFORE INSERT` trigger aborting the targeted replacement row
  in the real rotation batch rolls back predecessor revocation and leaves the
  old bearer usable with no replacement row;
- an admin can manage an agent after its creator leaves, while member,
  foreign-tenant, machine-bearer and untrusted-origin administration fails.

The account browser smoke covering create, grant, issue, one-time display,
reload secrecy, rotate, revoke, disable/restore and grant revocation passes
against the local Worker. Its delayed issuance success and failure race also
passes: changing organizations clears the old secret and keeps old agent
controls disabled until the new page loads. This is review evidence for the
worker branch, not aggregate acceptance evidence.

Checks run on this branch:

- `sh scripts/format` passed;
- `bun run typecheck` passed;
- focused `bunx vitest run --config vitest.worker.config.ts worker/test/agents.test.ts`
  passed: 1 file, 2 tests;
- full `bun run check` passed: 6 Worker/D1 files, 9 tests, followed by the
  persistent Miniflare D1 restart probe;
- repository-root `bun run check` passed the 11 workspace manifest scaffold
  checks;
- standalone `sh scripts/lint` was attempted but cannot run in this frozen
  install because the optional `oxlint` executable is absent; `bun run check`
  does not invoke that script.
- root frozen dependencies were supplied by the parent baseline. Root manifest
  checks and aggregate Chromium checks remain parent-owned.

Provider responses are simulated at the Google/GitHub boundary. Registered
services and protected resources are local fixtures. No live provider,
production deployment, managed adoption or consumer-service migration is
claimed here. OAuth installation/consent remains T06/T07 work, and Database is
still a scaffold.
