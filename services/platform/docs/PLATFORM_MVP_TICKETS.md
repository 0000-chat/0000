# Platform MVP ticket proposal

**Status:** Published as issues #55–#69. T01 is reviewed, integrated and verified on `codex/platform-mvp` at `fa17ad4`; T02 is reviewed, integrated and independently verified at `7152bcd`. The full MVP remains incomplete. The accepted scope is [issue #54](https://github.com/0000-chat/0000/issues/54).

| Slice | Published issue | Title | Label |
| --- | --- | --- | --- |
| T01 | [#55](https://github.com/0000-chat/0000/issues/55) | Trace runtime and resolve the first auth contracts | ready-for-agent |
| T02 | [#56](https://github.com/0000-chat/0000/issues/56) | Deliver social sign-in, default organization, profile and logout | ready-for-agent |
| T03 | [#57](https://github.com/0000-chat/0000/issues/57) | Administer organizations and memberships | ready-for-agent |
| T04 | [#58](https://github.com/0000-chat/0000/issues/58) | Register a consumer and use a scoped human API credential | ready-for-agent |
| T05 | [#59](https://github.com/0000-chat/0000/issues/59) | Add organization-owned agents across service audiences | ready-for-agent |
| T06 | [#60](https://github.com/0000-chat/0000/issues/60) | Authorize a personal harness with OAuth consent | needs-info |
| T07 | [#61](https://github.com/0000-chat/0000/issues/61) | Rotate and revoke OAuth installations | needs-info |
| T08 | [#62](https://github.com/0000-chat/0000/issues/62) | Create and renew per-client guest access through the verifier | needs-info |
| T09 | [#63](https://github.com/0000-chat/0000/issues/63) | Preserve msg guest access through the shared Platform path | ready-for-agent |
| T10 | [#64](https://github.com/0000-chat/0000/issues/64) | Claim msg guest resources atomically and idempotently | ready-for-agent |
| T11 | [#65](https://github.com/0000-chat/0000/issues/65) | Move Communicator human, machine and OAuth paths to Platform | needs-info |
| T12 | [#66](https://github.com/0000-chat/0000/issues/66) | Bound Platform endpoint work and audit safely | ready-for-agent |
| T13 | [#67](https://github.com/0000-chat/0000/issues/67) | Enforce msg anonymous quotas in managed and self-hosted deployments | ready-for-agent |
| T14 | [#68](https://github.com/0000-chat/0000/issues/68) | Prove reconnect authorization without building offline sync | ready-for-agent |
| T15 | [#69](https://github.com/0000-chat/0000/issues/69) | Make self-hosted and managed deployment setup reproducible | ready-for-agent |

T01 through T05 are reviewed and verified on the aggregate, including T02's recovery follow-up at `54fc212`; T14's focused reconnect proof is accepted at `166e54d`. T08's guest lifecycle contract is resolved and implementation dispatched from `10d31c8`. T06's isolated consent probe passes at `41cd96f`; production preparation must address the review findings before dispatch. Slice reports record exact evidence and limits. The ready-for-agent label does not assert completed dependencies or production adoption.

## Existing issue disposition

| Existing issue | Disposition |
| --- | --- |
| [#13](https://github.com/0000-chat/0000/issues/13) — closed | Prior art for OAuth remote MCP read authority. Retain its transport and local resource-ACL tests; Platform supersedes the local issuer. No duplicate ticket. |
| [#35](https://github.com/0000-chat/0000/issues/35) and [#36](https://github.com/0000-chat/0000/issues/36) — open | Live ChatGPT/Grok acceptance stays outstanding and is not a blocker for local Platform integration. No fixture replaces that acceptance. |
| [#48](https://github.com/0000-chat/0000/issues/48) — open | Keep the Database pilot separate. The auth fixture has no dependency on it. During eventual Database adoption, explicitly reconcile the older no-owner-credential/shared-slug/no-claim assumptions with Platform's owner credential and claim behavior. Do not duplicate or modify #48. |
| [#40](https://github.com/0000-chat/0000/issues/40) — closed | Its pilot comments describe the older no-owner-credential/shared-slug/no-claim model. Superseded for Platform-enabled composition; do not modify. Reconcile during eventual Database adoption. |
| [#54](https://github.com/0000-chat/0000/issues/54), [#11](https://github.com/0000-chat/0000/issues/11), [#37](https://github.com/0000-chat/0000/issues/37) | Protected parent or coordination issues. This proposal does not edit or publish to them. |

## Proposed tickets

### T01. Trace runtime and resolve the first auth contracts

**Readiness:** T01 investigation accepted after independent review and aggregate verification at `fa17ad4`. It is not the complete auth MVP or production acceptance.

**Blocked by (contract):** None; investigation scope is bounded by the accepted MVP.

**Change:** Implemented one runnable Worker/D1 trace from human sign-in and retry-safe default organization through a candidate shared verifier to a protected resource fixture. Added a Miniflare D1 restart probe and narrow OAuth lifecycle and guest-bootstrap-to-resource-grant probes. [T01_RUNTIME_REPORT.md](../T01_RUNTIME_REPORT.md) records the evidence, candidate decisions and unresolved production blockers; this does not claim production integration or freeze downstream public contracts.

**Existing pattern:** Worker/D1 runtime conventions, Communicator's human/install separation and msg's observable HTTP behavior. Platform now has an experimental test path, but no deployed identity service or production consumer path.

**Open decisions:** None for the investigation scope. Capture pinned runtime/component versions, principal/error/verifier/bootstrap/OAuth/guest grant-proof findings for parent review; no new user policy vote.

**Verification:** Parent aggregate checks passed for local Worker/D1 protected requests, membership/lifecycle/revocation denial, receipt-based organization retries, a persistent Miniflare runtime restart, sequential OAuth refresh reuse and stored-owner guest attestation. The report distinguishes proven behavior from unresolved concurrency, installation-binding and deployment work. T02's runtime gate is resolved; other tickets retain their specific dependency and contract gates.

### T02. Deliver social sign-in, default organization, profile and logout

**Readiness:** Initial T02 is reviewed and verified at `7152bcd`; interrupted-signup recovery implementation/fixes are integrated as `b9d1e63`, `382acf9`, `7209b4a`, `08cbfc2`. Parent combined checks at `54fc212` pass eight Worker/D1 files/twenty tests, guest/resource and human restart, format/typecheck and root manifests. Independent native and external review completed. The issue stays open; full MVP is not accepted.

**Blocked by (contract):** T01's accepted human principal, session and D1 behavior.

**Change:** Implemented Google/GitHub login, proof-based provider linking, Platform browser session, profile controls, retry-safe default organization with owner membership, managed open signup and configurable self-hosted open/invite-only signup. Logout revokes the browser session only. Better Auth's direct unlink endpoint is disabled; the Worker uses an atomic D1 conditional delete to preserve the last provider under concurrency. Explicit OAuth client/resource administration routes are denied until a later approved operator flow.

**Existing pattern:** Better Auth is selected; magic links are superseded and there are no Platform users to import.

**Open decisions:** None for T02; provider and callback authority behavior is implemented and verified.

**Verification:** [T02_ACCOUNT_REPORT.md](../T02_ACCOUNT_REPORT.md) records the exact boundary and evidence. The Worker/D1 tests exercise login/callback/session persistence, explicit linking, same-email non-linking, default-organization retries, signup gates, safe profile editing, stale/cross-origin/concurrent unlink, callback denial after logout/disablement or a different user's session, OAuth admin denial, logout and guest/human credential survival. Parent aggregate Platform checks and a separate Chromium login smoke pass at `7152bcd`. The passing root check validates workspace manifests, not auth integration. Provider HTTP remains simulated.

### T03. Administer organizations and memberships

**Readiness:** Reviewed, integrated and independently verified at aggregate `c51d285`, with acceptance checkpoint `b2e5802`. The organization authority boundary is available for dependent work; this does not close later recovery, OAuth or consumer gates.

**Blocked by (contract):** T02's signed-in human and organization-owner semantics.

**Change:** Deliver invitations, invitation acceptance, multi-organization membership selection, membership administration, suspension/disablement and concurrency-safe final-owner protection in Platform's account UI.

**Existing pattern:** Platform owns identity administration; Spaces remain outside this UI.

**Open decisions:** None; lifecycle behavior is settled.

**Verification:** Observe invitation acceptance, nonmember denial, suspension/disablement denial at the next check, and refusal of a change that would remove the last owner. No email-only account merge or premature organization hard-delete.

### T04. Register a consumer and use a scoped human API credential

**Readiness:** Reviewed, integrated and independently verified at aggregate `dc30cd4`. T04 supplies the scoped credential and registered verifier boundary for dependent preparation; this does not claim production consumer adoption.

**Blocked by (contract):** T01 principal, authority, audience, error and service-verifier contract; T02 supplies the human. This ticket defines the bearer source: a human issues a scoped opaque API credential in the Platform account UI.

**Change:** Register resource fixtures and narrowly scoped service verifiers with trusted local tooling; use the shared client/middleware for live protected requests across two exact audiences. Include API credential one-time display, 90-day default/configurable expiry, rotation, revocation and current catalog checks.

**Existing pattern:** Preserve Communicator's strict human/delegated separation; fixture is not production adoption.

**Open decisions:** Resolved from integrated evidence: opaque audience-specific credentials, current membership, verifier-bound shared-client transport and strict failure categories. Remote deployment, consumer migration and production operator ownership remain later adoption work.

**Verification:** [T04_CREDENTIAL_REPORT.md](../T04_CREDENTIAL_REPORT.md) records actual Worker/D1 issue/list/rotate/revoke, two-audience shared-client/resource requests, bounded lifetime, one-time secret display, live catalog narrowing/expansion, verifier rotation/disablement, concurrent rotation and rollback failure probes, Chromium UI evidence and local CLI register/update/rotate/disable/conflict checks. Wrong audience, expired, revoked, removed-membership and suspended/disabled authority deny at the next check; verifier credentials cannot issue user credentials or enumerate organizations; authority outage returns 503.

### T05. Add organization-owned agents across service audiences

**Readiness:** Reviewed implementation and fixes `0ed62d2`, `500db9b`, `6b88e21`, `034e853` integrated as `4e602f2`, `190ac68`, `14fe44f`, `10d31c8`. Parent aggregate checks pass seven Worker/D1 files/ten tests, restart, format/typecheck and root manifests; combined browser controls pass. Narrowing, coherent verification snapshots and exact replacement-INSERT rollback proofs are confirmed. Consumer adoption and remaining MVP gates are separate.

**Blocked by (contract):** T03 supplies current administrator/membership controls; T04 supplies credential and verifier flows; T01's agreed machine-principal/grant contract is prerequisite.

**Change:** Let an organization create and administer a stable agent identity with separate grants/credentials for two fixture service audiences. The agent survives creator departure and does not inherit creator rights.

**Existing pattern:** Communicator distinguishes installation authority from human authority.

**Open decisions:** None; org-agent lifecycle and no-admin-inheritance behavior are settled.

**Verification:** Observe one agent using two separately limited audiences, then remove its creator. The agent remains usable only for current grants and stays manageable by an authorized organization administrator.

### T06. Authorize a personal harness with OAuth consent

**Readiness:** Isolated probe `41cd96f` proves per-request auth construction, public PKCE consent/reference binding and separate concurrent browser flows; the parent rerun passes one Worker/D1 file with three tests. Independent review confirms the supported integration path but requires conditional current-authority activation, exact selection-race outcomes and rejection of malformed/unbound token responses. Production implementation remains undispatched, pending its complete brief and serialization after T08. The probe is not integrated or accepted as production auth.

**Blocked by (contract):** T01 OAuth feasibility/resource-binding result; T03 current membership; T04 live consumer verification.

**Change:** Complete an authorization-code/PKCE flow for a personal harness, with explicit consent, exact registered redirect and resource validation, and access to one selected fixture service. Cap authority at the member's current membership and explicit access.

**Existing pattern:** Retain #13's OAuth remote MCP read-authority behavior; issuer ownership moves to Platform.

**Open decisions:** T01's OAuth component and token-to-principal mapping only.

**Verification:** A valid consent reaches only the selected resource. Wrong client, redirect, issuer/resource or excessive access is denied; membership removal denies the next request. No administrator privilege is inherited.

### T07. Rotate and revoke OAuth installations

**Readiness:** Not ready; depends on T06 and T01's D1 transaction findings.

**Blocked by (contract):** T06's consent, installation and access-token binding; T01's refresh/reuse semantics.

**Change:** Add refresh-token rotation with reuse protection and account controls to revoke consent or disable an installation. Keep revocation live for each subsequent authenticated request.

**Existing pattern:** Preserve #13's completed transport and local resource-ACL tests.

**Open decisions:** None beyond T01's documented OAuth/D1 results; no access-token lifetime is invented here.

**Verification:** Observe successful first refresh, denial on reuse, and denial after consent or installation revocation. A rejected delegated token never retries the human verifier.

### T08. Create and renew per-client guest access through the verifier

**Readiness:** Reviewed and integrated as `556827d`, `06359cb` and `1d221bb`. Parent aggregate checks pass nine Worker/D1 files/twenty-two tests, format/typecheck and guest/resource restart. Independent Standards and Spec reviews accepted the final correction; an Astra high adversarial fallback found no additional authority defect. Grok was unauthenticated, so external model diversity was unavailable. The shared guest boundary is ready for msg adoption in T09; this fixture does not establish that adoption.

**Blocked by (contract):** T01 guest principal, bootstrap purpose/audience and resource-grant exchange; T04 shared verifier.

**Change:** Automatically persist a guest identity per client and obtain a resource-bound guest grant through the fixture. Support renewal while associated resources remain valid. Keep this separate from organization/API credentials and avoid cross-device correlation.

**Existing pattern:** Use the fixture's resource-owner behavior; msg is the real guest consumer in T09.

**Open decisions:** None. Guest control can recover a lost renewal response, revoked grant IDs cannot revive, and service ACLs remain final. The API-key 90-day default does not apply to guests or unrelated grants.

**Verification:** The same client resumes access to a still-valid resource after renewal; a different client is not linked; invalid guest proof cannot access the resource. Invalidating one resource grant leaves unrelated guest resources usable.

### T09. Move msg guest participation and owner controls to Platform auth

**Readiness:** Not ready; depends on T08.

**Blocked by (contract):** T08's guest identity/grant flow. #35/#36 external acceptance is not a blocker.

**Change:** Use the shared auth path for msg's authenticated owner/creator management and guest participation. A valid share link still permits immediate read/post without signup; participation is distinct from ownership. Retire any msg-local issuer in this path.

**Existing pattern:** Reuse msg public Worker room behavior and workerd/Miniflare HTTP and persistence-restart fixtures. Preserve existing share-link/resource ACL semantics.

**Open decisions:** None after T08's reviewed exchange contract.

**Verification:** Observe owner management and link-based participant actions through msg. A guest can read/post only through the valid link and cannot administer ownership from participation alone.

### T10. Transfer msg guest ownership atomically and idempotently

**Readiness:** Not ready; depends on T03 and T09.

**Blocked by (contract):** T03 organization authority and T09's service-recorded resource/guest grant.

**Change:** Require a guest ownership credential proof plus an authorized organization. Atomically transfer the msg resource, revoke the former guest-owner permission, preserve ID/data, keep share links unless explicitly opted out, and leave participant/unrelated grants separate. Add a focused Database-style fixture only; do not build Database.

**Existing pattern:** msg HTTP/persistence behavior is the resource-owning seam. The fixture has no #48 dependency.

**Open decisions:** None at product level; use T01's reviewed guest-proof exchange without trusting caller-supplied owner/resource claims.

**Verification:** Exact retries return the original success; a conflicting claimant is denied. Concurrent claims cannot double-transfer or restore old owner access. Default links, participants and unrelated guest resources remain accessible.

### T11. Move Communicator human, machine and OAuth paths to Platform

**Readiness:** Not ready; depends on T05 and T07.

**Blocked by (contract):** T05 agent and T07 OAuth principal/resource binding; T04 live verifier.

**Change:** Replace Communicator's local issuers for human, named-agent/machine and OAuth identity, consent and issuance paths with Platform. Keep Communicator's installation records and resource ACLs bound to Platform principals. OAuth identity, consent and issuance stay in Platform. Prevent Cloudflare Access or another issuer from becoming a competing authority/fallback. Never forward inbound Platform credentials to upstream providers.

**Existing pattern:** Retain #13's remote MCP read-authority and local ACL tests; do not duplicate them.

**Open decisions:** Confirm only T01-reviewed audience/client bindings; service resource policy is settled as local.

**Verification:** Existing human, machine and OAuth behaviors pass through Platform; wrong issuer/resource and forged client are denied; installation ACLs remain local; no rejected token retries another identity path and no local issuer remains.

### T12. Bound Platform endpoint work and audit safely

**Readiness:** Not ready; depends on T07 and T08.

**Blocked by (contract):** T07/T08 identify the OAuth, verification and guest-bootstrap operations to protect.

**Change:** Apply bounded deadlines and distributed limits to Platform login, recovery, issuance, verification and guest bootstrap. Audit identity/credential events without recording bearer tokens, OAuth secrets or cookies.

**Existing pattern:** Limits must work across Worker instances, not only process memory.

**Open decisions:** None; exact numerical budgets remain operator/configuration choices rather than new product policy.

**Verification:** Under repeated requests, observable endpoint limits hold across Worker instances; slow/unavailable verification fails closed; audit evidence supports lifecycle review and contains no secrets.

### T13. Enforce msg anonymous quotas in managed and self-hosted deployments

**Readiness:** Not ready; depends on T09.

**Blocked by (contract):** T09 guest participation and existing msg quota/config behavior.

**Change:** Enforce anonymous-operation quotas using msg's existing service policies. Managed allowances configure local enforcement; self-host operators can configure limits. A new guest ID alone cannot reset a quota.

**Existing pattern:** Keep anonymous action enforcement in the resource-owning service, not Platform or a request-time Cloud call.

**Open decisions:** None; do not invent numeric quotas or a new policy model.

**Verification:** Observe quota denial in msg at configured limits, including after a new guest identity is created. Managed and self-hosted configuration both affect local enforcement without a Cloud request per action.

### T14. Prove reconnect authorization without building offline sync

**Readiness:** Reviewed, integrated and independently verified at aggregate `166e54d` (worker `1b4d5ed`/`c4491b8`, aggregate `6ae1d24`/`166e54d`). Platform checks pass six Worker/D1 files/eight tests plus persistent restart; root manifest checks pass. This accepts the focused reconnect fixture, not product offline sync.

**Blocked by (contract):** T02 supplies human session and reauthentication; T04 verifies current state. This slice implements or proves Platform renewal where needed.

**Change:** Implement or prove Platform human-session renewal where needed, then use a focused client/fixture to exercise renewal and queued-operation submission. The application owns offline data and preserves its unsynced work; no full product sync feature is added.

**Existing pattern:** Exercise the service boundary through the same fixture path, not an absent full-product app.

**Open decisions:** None; server permission is checked when applying each queued operation.

**Verification:** An old revoked credential returns 401. A renewed human session whose organization membership was removed is denied at the resource check; the fixture client retains its unsynced change for user resolution.

### T15. Make self-hosted and managed deployment setup reproducible

**Readiness:** Not ready; release slice after T10–T14. Minimal local runtime configuration comes from T01/T02, so this is not a prerequisite loop.

**Blocked by (contract):** Tested runtime/configuration from T01 and implemented product path through T10–T14.

**Change:** Prove a clean local Workers/D1 setup and place managed configuration in its actual owning workspace. Keep self-hosted provider credentials operator-owned. No Docker runtime.

**Existing pattern:** Use current Worker local-development conventions; do not create a substitute Cloud service.

**Open decisions:** None; the private 0000-cloud operations repository identifies the owner of managed configuration. Do not add a runtime dependency.

**Verification:** From a clean setup, sign in, use a protected consumer and observe persistence across restart. Self-hosting works without 0000 Cloud; managed requests make no Cloud call for per-request authorization.

## Publication and execution

The breakdown is published. T01 is integrated and accepted at `fa17ad4`; T02 is integrated, reviewed and independently verified at `7152bcd`. Platform checks pass; the root command only checks workspace manifests. Dispatch any later ticket only when its listed dependencies and specific unresolved contracts are satisfied; ready-for-agent labels do not assert dependency completion. #35/#36 remain external acceptance work and #48 remains the Database pilot; neither is replaced by this plan.
