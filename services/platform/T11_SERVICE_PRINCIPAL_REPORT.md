# T11 service-principal prerequisite report

Date: 2026-09-20. Scope: the bounded Platform runtime prerequisite for
organization-owned service principals. This report records Platform Worker/D1
and shared-client evidence only. It does not claim Communicator adoption,
browser account UI, deployed provisioning, or full T11 consumer acceptance.

## Implemented boundary

Service principals use the existing `platform_agent` and
`platform_agent_grant` lifecycle. Migration `0011_machine_kinds.sql` adds an
immutable `kind` column with `agent` as the default for existing rows. The
credential binding triggers require every non-OAuth machine credential to have
the same stored machine kind, subject and organization. OAuth installation
subjects remain synthetic agent subjects and retain the separate OAuth-origin
verification path; the existing installation collision guard covers every row
in the shared machine table.

The owner/admin account routes are fixed to the service kind and use the stable
`subjectId` field:

| Operation | Route | Method | Authority fields |
| --- | --- | --- | --- |
| List/create | `/api/account/service-principals` | `GET` / `POST` | `organizationId`, `subjectId` in results |
| Rename | `/api/account/service-principals/update` | `POST` | `organizationId`, `subjectId`, `name` |
| Disable/restore | `/api/account/service-principals/lifecycle` | `POST` | `organizationId`, `subjectId`, `action` |
| List/create grants | `/api/account/service-principals/grants` | `GET` / `POST` | `organizationId`, `subjectId`, `grantId` |
| Revoke grant | `/api/account/service-principals/grants/revoke` | `POST` | `organizationId`, `subjectId`, `grantId` |
| List/issue credentials | `/api/account/service-principals/credentials` | `GET` / `POST` | `organizationId`, `subjectId`, `grantId` |
| Rotate credential | `/api/account/service-principals/credentials/rotate` | `POST` | `organizationId`, `subjectId`, `credentialId` |
| Revoke credential | `/api/account/service-principals/credentials/revoke` | `POST` | `organizationId`, `subjectId`, `credentialId` |

The submitted body cannot select or convert the machine kind. Secrets are
returned only by issue and rotation responses. The shared verifier joins the
stored machine kind, current organization, enabled subject, current grant,
registered service, exact audience, catalog and credential state on every
request. The creator's membership is not part of machine verification, while
owner/admin management continues to require a current manager.

## Evidence

`worker/test/service-principals.test.ts` exercises registered browser-session
routes and D1 state for:

- creation with a forged body kind, stable subject identity across two exact
  service audiences, distinct grants, one-time credentials, and fixture
  resource authorization;
- current manager authorization after the creator leaves, member denial,
  agent/service route isolation, issuer separation, disabled and restored
  subjects, expiry, catalog narrowing, immutable kind and credential-kind
  binding;
- shared-client audience denial and single-winner concurrent rotation;
- registered rotation-route races with predecessor/successor lineage checks,
  replacement-insert rollback, no returned secret on failure, reverse
  agent/OAuth subject route isolation, wrong-organization and wrong-grant
  denial, suspended-organization verification, grant narrowing and credential
  revocation, and current-manager/runtime continuity after creator departure.

The focused command passes:

```text
bunx vitest run --config vitest.worker.config.ts worker/test/service-principals.test.ts
3 tests passed
```

The existing agent regression passes:

```text
bunx vitest run --config vitest.worker.config.ts worker/test/agents.test.ts
2 tests passed
```

`bun run typecheck` and the full Platform format check pass. The full Worker
suite reaches 50 passing tests in 13 files and one pre-existing account fixture
failure in `worker/test/account.test.ts`. After the concurrent provider unlink
flow can leave GitHub as the surviving account, the fixture still starts a
hard-coded Google login and expects `user_disabled`; the callback returns
`account_not_linked`. The parent-owned fixture correction is isolated in
`de7af31`; the remaining assertion is outside this change. The same run with
that account file excluded passes all 12 other files and 50 tests.

`bun run test:restart` passes the D1 persistence probe, and
`bun scripts/test-oauth-refresh-restart.mjs` passes the actual refresh restart
probe. No external provider HTTP or consumer deployment is claimed here.
