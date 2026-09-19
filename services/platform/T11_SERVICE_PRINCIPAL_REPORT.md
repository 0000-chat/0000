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
- shared-client audience denial and single-winner concurrent rotation.

The focused command passes:

```text
bunx vitest run --config vitest.worker.config.ts worker/test/service-principals.test.ts
2 tests passed
```

The existing agent regression passes:

```text
bunx vitest run --config vitest.worker.config.ts worker/test/agents.test.ts
2 tests passed
```

`bun run typecheck` and the focused Biome format check pass. The full Platform
Worker suite reaches 50 passing tests and one pre-existing account fixture
failure in `worker/test/account.test.ts`: after the account test's concurrent
provider unlink flow, the expected membership-recovery page is replaced by the
sign-in page. That fixture is outside this change and is owned by the parent
account correction work.

The OAuth refresh restart probe and the full repository check remain required
at the parent verification gate. No external provider HTTP or consumer
deployment is claimed here.
