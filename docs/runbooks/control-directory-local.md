# Communicator Control Directory: Local Verification

## Purpose

The Control Directory is the authoritative source for Communicator tenants, principals, memberships, identities, explicit operation grants, non-secret connection placement, audit events, and control-event outbox records. It answers which authenticated product caller may use which Human or Agent identity.

Conversation and message data do not belong in this database. A later tenant projection Durable Object is rebuildable state derived from authoritative control and messaging events; it must consult this directory before serving tenant-scoped data. This milestone creates neither that projection nor any other remote Cloudflare resource.

## Local reset and migration

The local Worker configuration uses the sentinel D1 UUID `00000000-0000-0000-0000-000000000001` and the local `CONTROL_DB` binding. Apply the checked-in migration locally with:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
```

The local database may be reset by removing only the generated `.wrangler/state/v3/d1` state for this worktree and applying the migration again. Never use a local reset command against a remote database.

## Test verification

Run the Worker tests in the Cloudflare-compatible workerd runtime, then the complete workspace checks and tests:

```bash
pnpm --filter @communicator/control-plane test:worker
pnpm check
pnpm test
```

The Worker suite applies migrations before each test file and uses deterministic, non-secret Human/Agent fixtures. No test contacts an OIDC provider, provider service, Matrix service, or Cloudflare API.

## Forbidden data

The directory schema, fixtures, logs, and test artifacts must not contain or print:

- message bodies or message content;
- Matrix access tokens or Matrix credentials;
- E2EE keys;
- bridge secrets or bridge sessions;
- provider credentials, provider passwords, or provider cookies;
- QR or login payloads;
- `message_body` columns;
- `matrix_access_token` columns;
- `e2ee_key` columns;
- `bridge_secret` columns;
- `provider_cookie` columns;
- `provider_password` columns; or
- `qr_payload` columns.

The public session response also omits normalized OIDC issuer and subject values, routing identifiers, and SQL or authorization details. D1 stores only the normalized issuer/subject needed for lookup in its private principal rows; these values are never returned by the public directory schema or HTTP endpoint.

## Deployment gate

This branch is local-only. The sentinel D1 UUID and `.invalid` OIDC issuer/JWKS values in `apps/control-plane/wrangler.jsonc` intentionally prohibit a meaningful deployment. Do not create a D1 database, select a live OIDC provider, configure Access, or deploy this Worker from this runbook.

## Live prerequisites

Before a later deployment milestone, obtain all of the following approvals and implementation prerequisites:

1. an approved OIDC issuer, audience, and JWKS URL;
2. separately created and named D1 databases for staging and production;
3. a tested backup and restore procedure for the authoritative directory;
4. an operator seed workflow with auditability and least privilege; and
5. an explicit review of environment bindings, access controls, migration order, and rollback handling.

## Next milestone

The next data-plane milestone should define the ordinary R2 archive and replay contract. Only after that contract is approved should the implementation add the rebuildable `TenantProjectionDO` and its guarded projection path.
