# Communicator Control Directory and Product Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authoritative D1 tenant/identity directory and a fail-closed OIDC authorization boundary that exposes one authenticated `/api/v1/session` endpoint without yet replacing the simulated messaging UI.

**Architecture:** The same-origin Hono Worker verifies an OIDC bearer token with `jose`, resolves its normalized issuer/subject against an authoritative D1 directory, and constructs a narrow authorization context from active membership and explicit identity grants. D1 owns product tenancy and access; it contains no messages or provider/Matrix secrets. Transactional directory mutations write an idempotent outbox record for later projection synchronization, but this milestone deliberately does not create R2, Queue, or Durable Object resources.

**Tech Stack:** TypeScript 7, Hono, Zod 4, `jose`, Cloudflare Workers, D1, Wrangler JSONC, `@cloudflare/vitest-plugin` 1.x, Vitest 4, pnpm 10.

---

## Simple explanation

This milestone builds the locked address book that answers: “Who is this caller, which customer workspace do they belong to, and which Human or Agent identities may they use?” It does not store conversations. Later Workers consult this directory before they are allowed to call a tenant Durable Object.

At the end, a valid product token can call `GET /api/v1/session` and receive only its permitted identities and operations. Invalid tokens, revoked principals, inactive memberships, guessed tenants, and cross-identity access all fail closed. The existing backoffice remains visibly simulated until the later live-read API milestone.

## Technical boundaries

- D1 is authoritative for tenants, principals, memberships, identities, identity grants, non-secret connection placement, break-glass grants, audit events, and the control-event outbox.
- No table or log may contain message bodies, Matrix access tokens, E2EE keys, bridge secrets, QR/login payloads, provider cookies, or provider credentials.
- A tenant hint supplied in `X-Communicator-Tenant` selects among memberships; it never grants access.
- A normal authorization context is derived only from active D1 rows after JWT verification.
- Break-glass is represented with tenant/identity-safe constraints in this milestone, but no public route activates it yet. The later read API must validate the active grant, require an explicit grant ID and reason, and write an audit event before returning protected data.
- The D1 binding uses a deterministic local-only sentinel UUID in this plan. Do not deploy this branch. Live D1 creation and environment-specific OIDC values belong to the deployment milestone.
- R2 archive, `TenantProjectionDO`, ingestion Queue, WebSockets, Matrix Gateway, commands, and account linking are out of scope.

## File map

**Create**

- `packages/contracts/src/authorization.ts` — roles, scopes, grants, and authenticated-session response schemas.
- `packages/contracts/src/control-directory.ts` — non-secret tenant, principal, membership, and directory identity schemas.
- `apps/control-plane/migrations/0001_control_directory.sql` — complete authoritative D1 schema and indexes.
- `apps/control-plane/worker/auth/bearer.ts` — strict bearer-header parsing.
- `apps/control-plane/worker/auth/oidc.ts` — OIDC/JWKS verification and normalized verified subject.
- `apps/control-plane/worker/auth/middleware.ts` — Hono middleware that combines token verification and D1 authorization.
- `apps/control-plane/worker/control-directory/repository.ts` — focused D1 reads and transactional mutations.
- `apps/control-plane/worker/control-directory/authorization.ts` — fail-closed tenant and identity resolution.
- `apps/control-plane/worker/routes/session.ts` — OpenAPI route contract and handler.
- `apps/control-plane/worker/test/setup.ts` — apply D1 migrations before each Worker test.
- `apps/control-plane/worker/test/support/directory-fixtures.ts` — deterministic Human/Agent directory rows.
- `apps/control-plane/worker/test/support/tokens.ts` — deterministic local JWT signing and verification fixtures.
- `apps/control-plane/worker/test/control-directory-schema.test.ts` — migration, constraints, and forbidden-column tests.
- `apps/control-plane/worker/test/oidc.test.ts` — signature, issuer, audience, expiry, and bearer tests.
- `apps/control-plane/worker/test/authorization.test.ts` — tenant, principal, membership, grant, and break-glass isolation tests.
- `apps/control-plane/worker/test/directory-mutations.test.ts` — D1 batch atomicity, idempotency, audit, and outbox tests.
- `apps/control-plane/worker/test/session.test.ts` — authenticated HTTP integration tests.
- `docs/runbooks/control-directory-local.md` — local migration/test procedure and deployment prohibition.

**Modify**

- `packages/contracts/src/index.ts` — export the two new contract modules.
- `packages/contracts/test/schemas.test.ts` — verify strict public authorization contracts.
- `apps/control-plane/package.json` and `pnpm-lock.yaml` — add `jose`.
- `apps/control-plane/wrangler.jsonc` — add local D1 and non-secret OIDC configuration.
- `apps/control-plane/vitest.worker.config.ts` — run Worker tests in workerd and inject parsed migrations.
- `apps/control-plane/tsconfig.json` — include Worker test types.
- `apps/control-plane/worker-configuration.d.ts` — regenerate from Wrangler; never hand-edit.
- `apps/control-plane/worker/app.ts` — add an injectable app factory and mount the protected session route.
- `apps/control-plane/worker/index.ts` — keep the default export and export app-construction types only if required by tests.

## Locked public shapes

Use these exact enums and response fields throughout the plan:

```ts
type PrincipalType = "human" | "service" | "agent" | "operator";
type MembershipRole = "owner" | "admin" | "member";
type OperationScope =
  | "conversation.read"
  | "message.send"
  | "message.mutate"
  | "receipt.send"
  | "connection.read"
  | "connection.manage"
  | "export.create"
  | "replay.run"
  | "retention.manage"
  | "break_glass.inspect";

type AuthorizedIdentity = {
  identity_id: string;
  kind: "human" | "agent";
  display_name: string;
  scopes: OperationScope[];
};

type SessionResponse = {
  tenant: { id: string; slug: string; display_name: string };
  principal: { id: string; type: PrincipalType; display_name: string };
  membership: { id: string; role: MembershipRole };
  identities: AuthorizedIdentity[];
};
```

Errors use only these stable bodies in this milestone:

```json
{ "error": { "code": "unauthenticated", "message": "Authentication required" } }
{ "error": { "code": "not_found", "message": "Resource not found" } }
{ "error": { "code": "tenant_selection_required", "message": "Select an authorized tenant" } }
{ "error": { "code": "service_unavailable", "message": "Authorization service unavailable" } }
```

Do not include JWT error details, raw `iss`/`sub`, SQL text, table names, or existence hints in HTTP responses.

### Task 1: Configure the Worker-compatible test/runtime foundation

**Files:**
- Modify: `apps/control-plane/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/control-plane/wrangler.jsonc`
- Regenerate: `apps/control-plane/worker-configuration.d.ts`

- [ ] **Step 1: Add the Worker-compatible JWT library**

Run:

```bash
pnpm --filter @communicator/control-plane add jose
```

Expected: `jose` appears under `dependencies` and the lockfile changes. Do not manually pin a version different from the version resolved by pnpm.

- [ ] **Step 2: Add the local-only D1 binding and OIDC validation variables**

Add these top-level entries to `apps/control-plane/wrangler.jsonc`, preserving the existing assets, observability, and environment blocks:

```jsonc
"d1_databases": [
  {
    "binding": "CONTROL_DB",
    "database_name": "communicator-control-directory-local",
    "database_id": "00000000-0000-0000-0000-000000000001",
    "preview_database_id": "CONTROL_DB",
    "migrations_dir": "migrations"
  }
],
"vars": {
  "COMMUNICATOR_ENV": "development",
  "COMMUNICATOR_DATA_MODE": "simulated",
  "COMMUNICATOR_OIDC_ISSUER": "https://auth.local.invalid/",
  "COMMUNICATOR_OIDC_AUDIENCE": "communicator-api",
  "COMMUNICATOR_OIDC_JWKS_URL": "https://auth.local.invalid/.well-known/jwks.json"
}
```

Repeat the three `COMMUNICATOR_OIDC_*` keys inside the existing `staging.vars` and `production.vars` blocks with the same `.invalid` values. This is intentionally fail-closed and prevents a premature deployment from trusting an accidental issuer. Do not create a Cloudflare D1 database in this task.

- [ ] **Step 3: Generate binding types**

Run:

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane check
```

Expected: generated `Cloudflare.Env` contains `CONTROL_DB` and all three OIDC variables; the check passes. Never edit `worker-configuration.d.ts` by hand.

- [ ] **Step 4: Commit the foundation**

```bash
git add apps/control-plane/package.json apps/control-plane/wrangler.jsonc apps/control-plane/worker-configuration.d.ts pnpm-lock.yaml
git commit -m "build: configure control directory worker runtime"
```

### Task 2: Freeze authorization and directory contracts

**Files:**
- Create: `packages/contracts/src/authorization.ts`
- Create: `packages/contracts/src/control-directory.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Append tests that assert:

```ts
expect(SessionResponseSchema.parse({
  tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot" },
  principal: { id: "principal_human", type: "human", display_name: "Human" },
  membership: { id: "membership_human", role: "owner" },
  identities: [{
    identity_id: "identity_human",
    kind: "human",
    display_name: "Human",
    scopes: ["conversation.read", "message.send"],
  }],
})).toMatchObject({ identities: [{ identity_id: "identity_human" }] });

expect(AuthorizedIdentitySchema.safeParse({
  identity_id: "identity_human",
  kind: "human",
  display_name: "Human",
  scopes: ["root"],
}).success).toBe(false);

expect(DirectoryPrincipalSchema.safeParse({
  id: "principal_human",
  issuer: "https://issuer.example/",
  subject: "secret-subject-must-not-be-public",
  type: "human",
  display_name: "Human",
  status: "active",
}).success).toBe(false);
```

The last assertion locks the public directory schema against exposing normalized OIDC subjects.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
pnpm --filter @communicator/contracts test
```

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Create `authorization.ts`**

Use strict Zod objects and these exact definitions:

```ts
import { z } from "zod";
import { CommunicatorIdSchema } from "./ids";
import { IdentityKindSchema } from "./identity";

export const PrincipalTypeSchema = z.enum(["human", "service", "agent", "operator"]);
export const MembershipRoleSchema = z.enum(["owner", "admin", "member"]);
export const OperationScopeSchema = z.enum([
  "conversation.read",
  "message.send",
  "message.mutate",
  "receipt.send",
  "connection.read",
  "connection.manage",
  "export.create",
  "replay.run",
  "retention.manage",
  "break_glass.inspect",
]);

export const AuthorizedIdentitySchema = z.object({
  identity_id: CommunicatorIdSchema,
  kind: IdentityKindSchema,
  display_name: z.string().min(1).max(100),
  scopes: z.array(OperationScopeSchema),
}).strict();

export const SessionResponseSchema = z.object({
  tenant: z.object({
    id: CommunicatorIdSchema,
    slug: z.string().regex(/^[a-z0-9-]+$/).max(63),
    display_name: z.string().min(1).max(100),
  }).strict(),
  principal: z.object({
    id: CommunicatorIdSchema,
    type: PrincipalTypeSchema,
    display_name: z.string().min(1).max(100),
  }).strict(),
  membership: z.object({
    id: CommunicatorIdSchema,
    role: MembershipRoleSchema,
  }).strict(),
  identities: z.array(AuthorizedIdentitySchema),
}).strict();

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      "unauthenticated",
      "not_found",
      "tenant_selection_required",
      "service_unavailable",
    ]),
    message: z.string().min(1).max(100),
  }).strict(),
}).strict();

export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type OperationScope = z.infer<typeof OperationScopeSchema>;
export type AuthorizedIdentity = z.infer<typeof AuthorizedIdentitySchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
```

- [ ] **Step 4: Create `control-directory.ts`**

```ts
import { z } from "zod";
import { PrincipalTypeSchema, MembershipRoleSchema } from "./authorization";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";
import { IdentityKindSchema } from "./identity";

export const DirectoryStatusSchema = z.enum(["active", "disabled", "revoked"]);

export const DirectoryTenantSchema = z.object({
  id: CommunicatorIdSchema,
  slug: z.string().regex(/^[a-z0-9-]+$/).max(63),
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryPrincipalSchema = z.object({
  id: CommunicatorIdSchema,
  type: PrincipalTypeSchema,
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryMembershipSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  principal_id: CommunicatorIdSchema,
  role: MembershipRoleSchema,
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

export const DirectoryIdentitySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  kind: IdentityKindSchema,
  display_name: z.string().min(1).max(100),
  status: DirectoryStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();
```

Export inferred types for all four schemas.

- [ ] **Step 5: Export and verify**

Add both modules to `packages/contracts/src/index.ts`, then run:

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/contracts check
```

Expected: all contract tests and type checks pass.

- [ ] **Step 6: Commit contracts**

```bash
git add packages/contracts/src packages/contracts/test/schemas.test.ts
git commit -m "feat: define directory authorization contracts"
```

### Task 3: Create the authoritative D1 schema

**Files:**
- Create: `apps/control-plane/migrations/0001_control_directory.sql`

- [ ] **Step 1: Write the migration exactly once**

Create the migration with `PRAGMA foreign_keys = ON;` followed by these tables:

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service', 'agent', 'operator')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, principal_id)
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('human', 'agent')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE identity_grants (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'conversation.read', 'message.send', 'message.mutate', 'receipt.send',
    'connection.read', 'connection.manage', 'export.create', 'replay.run',
    'retention.manage', 'break_glass.inspect'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (membership_id, identity_id, operation_scope)
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'messenger', 'linkedin')),
  display_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'connected', 'syncing', 'ready', 'attention_required',
    'disconnected', 'revoked', 'unlinked'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE connection_routes (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  gateway_route_id TEXT NOT NULL,
  bridge_instance_id TEXT NOT NULL,
  matrix_user_id TEXT NOT NULL,
  matrix_room_namespace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE break_glass_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operator_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  identity_id TEXT,
  operation_scope TEXT NOT NULL CHECK (operation_scope = 'break_glass.inspect'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE revoked_tokens (
  issuer TEXT NOT NULL,
  token_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (issuer, token_id)
);

CREATE TABLE directory_mutations (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mutation_type TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TRIGGER directory_mutation_idempotency_conflict
BEFORE UPDATE OF request_hash ON directory_mutations
WHEN OLD.request_hash <> NEW.request_hash
BEGIN
  SELECT RAISE(ABORT, 'idempotency_key_conflict');
END;

CREATE TABLE control_event_outbox (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX memberships_principal_status_idx
  ON memberships(principal_id, status, tenant_id);
CREATE INDEX identities_tenant_status_idx
  ON identities(tenant_id, status, id);
CREATE INDEX identity_grants_membership_idx
  ON identity_grants(membership_id, identity_id, operation_scope);
CREATE INDEX connections_identity_status_idx
  ON connections(identity_id, status, id);
CREATE INDEX break_glass_active_idx
  ON break_glass_grants(operator_principal_id, tenant_id, expires_at, revoked_at);
CREATE INDEX revoked_tokens_principal_idx
  ON revoked_tokens(principal_id, revoked_at);
CREATE INDEX outbox_pending_idx
  ON control_event_outbox(delivered_at, created_at, event_id);
CREATE INDEX audit_tenant_time_idx
  ON audit_events(tenant_id, occurred_at, id);
```

Do not add cascade deletion from a tenant or principal. Product deletion will be an explicit audited workflow later.

- [ ] **Step 2: Validate migration parsing**

Run the real migration locally, then keep the existing health test green:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
pnpm --filter @communicator/control-plane test:worker
```

Expected: Wrangler reports migration `0001_control_directory.sql` applied to local D1, and the existing health test still passes.

- [ ] **Step 3: Commit the migration**

```bash
git add apps/control-plane/migrations/0001_control_directory.sql
git commit -m "feat: add authoritative control directory schema"
```

### Task 4: Apply migrations in isolated Worker tests and lock schema safety

**Files:**
- Modify: `apps/control-plane/vitest.worker.config.ts`
- Modify: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/worker/test/setup.ts`
- Create: `apps/control-plane/worker/test/control-directory-schema.test.ts`

- [ ] **Step 1: Convert Worker tests to the current Cloudflare Vitest plugin**

Replace `apps/control-plane/vitest.worker.config.ts` with:

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["worker/test/**/*.test.ts"],
      setupFiles: ["./worker/test/setup.ts"],
    },
  };
});
```

Change `apps/control-plane/tsconfig.json` so `compilerOptions.types` is:

```json
"types": ["vite/client", "@cloudflare/vitest-plugin/types"]
```

- [ ] **Step 2: Add the migration setup**

```ts
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  const testEnv = env as TestEnv;
  await applyD1Migrations(testEnv.CONTROL_DB, testEnv.TEST_MIGRATIONS);
});
```

Storage isolation is provided per test file by the current plugin. Tests within one file must delete their own fixture rows in `beforeEach` if they share state.

- [ ] **Step 3: Add schema tests**

The test must query `sqlite_master` and `PRAGMA table_info` and assert all twelve application tables exist. It must also assert this forbidden set has zero matches across every column name:

```ts
const forbiddenColumns = [
  "message_body",
  "matrix_access_token",
  "e2ee_key",
  "bridge_secret",
  "provider_cookie",
  "provider_password",
  "qr_payload",
];
```

Add constraint tests that:

1. reject duplicate `(issuer, subject)` principals;
2. reject an identity grant whose membership and identity belong to different tenants;
3. reject a connection whose identity belongs to another tenant;
4. reject a scoped break-glass grant whose identity belongs to another tenant;
5. reject break-glass reasons shorter than ten characters;
6. reject duplicate `(issuer, token_id)` revocations; and
7. reject invalid JSON in `control_event_outbox.payload_json`.

The cross-tenant grant test will initially expose that ordinary foreign keys do not enforce matching tenant ownership. Fix this by adding these composite uniqueness and reference rules to the migration before considering the task complete:

```sql
-- Change memberships to include:
UNIQUE (tenant_id, id)

-- Change identity_grants to include tenant_id and composite references:
tenant_id TEXT NOT NULL,
FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
PRIMARY KEY (tenant_id, membership_id, identity_id, operation_scope)
```

Remove the two single-column foreign keys from `identity_grants` when applying this correction. This red-green step is intentional: it proves cross-tenant grants are impossible at the database layer.

- [ ] **Step 4: Run schema tests**

```bash
pnpm --filter @communicator/control-plane test:worker -- control-directory-schema.test.ts
```

Expected: all schema, forbidden-column, JSON, and cross-tenant constraint tests pass.

- [ ] **Step 5: Commit test-locked schema**

```bash
git add apps/control-plane/migrations/0001_control_directory.sql apps/control-plane/vitest.worker.config.ts apps/control-plane/tsconfig.json apps/control-plane/worker/test/setup.ts apps/control-plane/worker/test/control-directory-schema.test.ts
git commit -m "test: lock control directory isolation constraints"
```

### Task 5: Verify bearer tokens and OIDC claims

**Files:**
- Create: `apps/control-plane/worker/auth/bearer.ts`
- Create: `apps/control-plane/worker/auth/oidc.ts`
- Create: `apps/control-plane/worker/test/support/tokens.ts`
- Create: `apps/control-plane/worker/test/oidc.test.ts`

- [ ] **Step 1: Write failing bearer and OIDC tests**

Cover these exact cases:

- no Authorization header;
- non-Bearer scheme;
- empty or whitespace-bearing token;
- valid signed token with matching issuer and audience;
- wrong issuer;
- wrong audience;
- expired token;
- unknown `kid`/wrong signature;
- missing `sub`;
- missing `jti` for a service or agent principal token.

Use `generateKeyPair("ES256")`, `exportJWK`, `createLocalJWKSet`, and `SignJWT` from `jose`; never make a network request in tests. Freeze time with Vitest fake timers for expiry tests.

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @communicator/control-plane test:worker -- oidc.test.ts
```

Expected: FAIL because the auth modules do not exist.

- [ ] **Step 3: Implement strict bearer parsing**

```ts
export class AuthenticationError extends Error {}

export function parseBearerToken(header: string | undefined): string {
  if (!header) throw new AuthenticationError("missing bearer token");
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match?.[1]) throw new AuthenticationError("invalid bearer token");
  return match[1];
}
```

Internal error messages are for structured server logs only; HTTP middleware maps every authentication failure to the locked generic body.

- [ ] **Step 4: Implement OIDC verification with an injectable key resolver**

```ts
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export type VerifiedSubject = {
  issuer: string;
  subject: string;
  token_id?: string;
};

export type OidcConfig = {
  issuer: string;
  audience: string;
  jwks_url: string;
};

export type TokenVerifier = {
  verify(token: string): Promise<VerifiedSubject>;
};

export function createOidcVerifier(
  config: OidcConfig,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwks_url)),
): TokenVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["ES256", "RS256"],
      });
      if (!payload.iss || !payload.sub) {
        throw new Error("verified token lacks required subject claims");
      }
      return {
        issuer: new URL(payload.iss).href,
        subject: payload.sub,
        ...(payload.jti ? { token_id: payload.jti } : {}),
      };
    },
  };
}
```

The D1 lookup in Task 7 enforces `jti` for stored principal types `service` and `agent`; the verifier cannot know the principal type before lookup.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @communicator/control-plane test:worker -- oidc.test.ts
git add apps/control-plane/worker/auth apps/control-plane/worker/test/oidc.test.ts apps/control-plane/worker/test/support/tokens.ts
git commit -m "feat: verify product OIDC bearer tokens"
```

### Task 6: Build deterministic Human/Agent directory fixtures

**Files:**
- Create: `apps/control-plane/worker/test/support/directory-fixtures.ts`

- [ ] **Step 1: Define one tenant and three principals**

Export `seedDirectory(db: D1Database)` that inserts, in one `db.batch()` call:

- tenant `tenant_pilot`;
- principal `principal_human`, issuer `https://issuer.example/`, subject `human-subject`, type `human`;
- principal `principal_agent`, same issuer, subject `agent-subject`, type `agent`;
- principal `principal_operator`, same issuer, subject `operator-subject`, type `operator`;
- active owner membership `membership_human`;
- active member membership `membership_agent`;
- active admin membership `membership_operator`;
- identities `identity_human` and `identity_agent`;
- Human grants only for `identity_human` with `conversation.read`, `message.send`, `receipt.send`, `connection.read`, and `connection.manage`;
- Agent grants only for `identity_agent` with `conversation.read`, `message.send`, and `connection.read`;
- Operator normal grants only for `identity_human` with `connection.read`;
- one Human WhatsApp and one Agent WhatsApp non-secret connection/route.

Use `2026-08-29T00:00:00.000Z` for every fixture timestamp. Prepared statements must bind every value; do not interpolate SQL.

- [ ] **Step 2: Add a cleanup helper**

Export `clearDirectory(db)` that deletes in foreign-key-safe order from `audit_events`, `control_event_outbox`, `directory_mutations`, `break_glass_grants`, `revoked_tokens`, `connection_routes`, `connections`, `identity_grants`, `identities`, `memberships`, `principals`, and `tenants`.

- [ ] **Step 3: Prove fixture isolation**

Add one test to `control-directory-schema.test.ts` that seeds the directory and asserts the Human membership has no Agent grant and the Agent membership has no Human grant.

- [ ] **Step 4: Commit fixtures**

```bash
git add apps/control-plane/worker/test/support/directory-fixtures.ts apps/control-plane/worker/test/control-directory-schema.test.ts
git commit -m "test: seed isolated pilot directory identities"
```

### Task 7: Resolve authenticated callers through D1

**Files:**
- Create: `apps/control-plane/worker/control-directory/repository.ts`
- Create: `apps/control-plane/worker/control-directory/authorization.ts`
- Create: `apps/control-plane/worker/test/authorization.test.ts`

- [ ] **Step 1: Write failing authorization tests**

Test all of the following against real D1:

1. Human resolves only `identity_human` and its scopes.
2. Agent resolves only `identity_agent` and its scopes.
3. An operator's normal context does not inherit Agent access.
4. Wrong tenant hint returns `not_found`.
5. No hint with exactly one active membership selects it.
6. No hint with two active memberships returns `tenant_selection_required`.
7. Disabled/revoked principal returns `not_found` after successful JWT verification.
8. Disabled/revoked tenant or membership returns `not_found`.
9. Disabled identity and its grants are omitted.
10. Stored `service` or `agent` principal plus a verified token lacking `jti` is rejected as `unauthenticated`.
11. A `jti` present in `revoked_tokens` is rejected as `unauthenticated`.
12. D1 failure returns an internal `directory_unavailable` result; it never falls back to token claims.

- [ ] **Step 2: Implement focused repository reads**

Expose only:

```ts
export type PrincipalRow = {
  id: string;
  principal_type: "human" | "service" | "agent" | "operator";
  display_name: string;
};

export type MembershipRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_display_name: string;
  role: "owner" | "admin" | "member";
};

export async function findActivePrincipal(
  db: D1DatabaseSession,
  issuer: string,
  subject: string,
): Promise<PrincipalRow | null>;

export async function listActiveMemberships(
  db: D1DatabaseSession,
  principalId: string,
  tenantHint?: string,
): Promise<MembershipRow[]>;

export async function listAuthorizedIdentities(
  db: D1DatabaseSession,
  membershipId: string,
  tenantId: string,
): Promise<AuthorizedIdentity[]>;

export async function isTokenRevoked(
  db: D1DatabaseSession,
  issuer: string,
  tokenId: string,
): Promise<boolean>;
```

Every query uses a prepared statement with bound parameters. `listAuthorizedIdentities` joins `identity_grants` to active `identities`, groups rows in TypeScript, sorts identities by ID and scopes by enum declaration order, and validates the result with `AuthorizedIdentitySchema`.

- [ ] **Step 3: Implement a discriminated authorization resolver**

```ts
export type AuthorizationFailureCode =
  | "unauthenticated"
  | "not_found"
  | "tenant_selection_required"
  | "directory_unavailable";

export type AuthorizationResult =
  | { ok: true; context: SessionResponse }
  | { ok: false; code: AuthorizationFailureCode };

export async function resolveAuthorization(
  db: D1Database,
  subject: VerifiedSubject,
  tenantHint?: string,
): Promise<AuthorizationResult>;
```

Resolution order is locked:

1. create `const session = db.withSession("first-primary")` so the first authorization read uses the most current primary state and later reads are sequentially consistent;
2. look up the active principal by normalized issuer/subject through that session;
3. require `subject.token_id` for agent/service principals;
4. reject a present token ID when `isTokenRevoked()` finds the normalized `(issuer, token_id)` pair;
5. list active memberships, filtered by the tenant hint when present;
6. return generic `not_found` for zero memberships;
7. return `tenant_selection_required` for more than one membership without a hint;
8. query explicit active identity grants through the same session;
9. build and Zod-validate `SessionResponse`;
10. catch D1 exceptions at the outer boundary and return `directory_unavailable`.

Never derive a tenant, role, identity, or operation scope from untrusted JWT custom claims in this milestone.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @communicator/control-plane test:worker -- authorization.test.ts
git add apps/control-plane/worker/control-directory apps/control-plane/worker/test/authorization.test.ts
git commit -m "feat: resolve tenant identity authorization from d1"
```

### Task 8: Add transactional, idempotent membership/grant mutations

**Files:**
- Modify: `apps/control-plane/worker/control-directory/repository.ts`
- Create: `apps/control-plane/worker/test/directory-mutations.test.ts`

- [ ] **Step 1: Write failing mutation tests**

Test `replaceIdentityGrants()` and `setMembershipStatus()` for:

- one successful mutation changes directory state, inserts one `directory_mutations` row, one audit event, and one pending outbox row;
- repeating the same idempotency key is harmless and leaves exactly one mutation/audit/outbox record;
- a replacement containing an identity from another tenant rolls back the entire D1 batch, preserving old grants and writing no mutation/audit/outbox rows;
- revoking a membership removes authorization immediately and writes an outbox event;
- payload JSON contains IDs/status/scopes only and no issuer, subject, message, route, or credential data.

- [ ] **Step 2: Implement `replaceIdentityGrants()` using one D1 batch**

Use this input contract:

```ts
type GrantReplacement = {
  idempotency_key: string;
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  grants: Array<{ identity_id: string; scopes: OperationScope[] }>;
  occurred_at: string;
};
```

Build the batch in this order:

1. `INSERT OR IGNORE` into `directory_mutations`;
2. delete existing grants for the exact `(tenant_id, membership_id)`;
3. insert every deduplicated grant with composite tenant foreign keys;
4. `INSERT OR IGNORE` audit ID `audit_${idempotency_key}`;
5. `INSERT OR IGNORE` outbox ID `control_${idempotency_key}` with event type `authorization.identity_grants.replaced`.

Serialize payloads with `JSON.stringify` from a Zod-validated object. Call `db.batch(statements)` exactly once. D1 documents that a failed statement rolls back the sequence; do not use raw `BEGIN` or `COMMIT`.

Before building statements, sort grants by identity ID, sort scopes by the locked enum order, and hash this canonical JSON with Web Crypto:

```ts
const canonicalRequest = JSON.stringify({
  tenant_id: input.tenant_id,
  actor_principal_id: input.actor_principal_id,
  membership_id: input.membership_id,
  grants: canonicalGrants,
  occurred_at: input.occurred_at,
});
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(canonicalRequest),
);
const requestHash = Array.from(new Uint8Array(digest), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
```

The first batch statement must use:

```sql
INSERT INTO directory_mutations (
  idempotency_key, tenant_id, actor_principal_id,
  mutation_type, request_hash, created_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(idempotency_key) DO UPDATE SET request_hash = excluded.request_hash
```

The migration trigger permits an identical retry and aborts the entire batch if the same key is reused for different input.

- [ ] **Step 3: Implement `setMembershipStatus()` using one D1 batch**

Accept `active | disabled | revoked`, set `revoked_at` only for `revoked`, and write event type `authorization.membership.updated`. Repeating the same idempotency key must converge on the same row values and keep one audit/outbox record.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @communicator/control-plane test:worker -- directory-mutations.test.ts authorization.test.ts
git add apps/control-plane/worker/control-directory/repository.ts apps/control-plane/worker/test/directory-mutations.test.ts
git commit -m "feat: transact directory authorization changes"
```

### Task 9: Add fail-closed Hono authentication middleware

**Files:**
- Create: `apps/control-plane/worker/auth/middleware.ts`
- Modify: `apps/control-plane/worker/app.ts`
- Modify: `apps/control-plane/worker/index.ts`

- [ ] **Step 1: Define injectable app services**

In `app.ts`, export:

```ts
export type AppServices = {
  createTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
};

export function createApp(services: AppServices = {}) {
  const app = new OpenAPIHono<{
    Bindings: Cloudflare.Env;
    Variables: AuthorizationVariables;
  }>();

  let verifier: TokenVerifier | undefined;
  const getVerifier = (env: Cloudflare.Env) => {
    verifier ??= (services.createTokenVerifier ?? ((runtimeEnv) =>
      createOidcVerifier({
        issuer: runtimeEnv.COMMUNICATOR_OIDC_ISSUER,
        audience: runtimeEnv.COMMUNICATOR_OIDC_AUDIENCE,
        jwks_url: runtimeEnv.COMMUNICATOR_OIDC_JWKS_URL,
      })))(env);
    return verifier;
  };

  app.openapi(healthRoute, (context) => context.json({
    status: "ok",
    service: "communicator-control-plane",
    data_mode: context.env?.COMMUNICATOR_DATA_MODE ?? "unconfigured",
  }, 200));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.use("/api/v1/session", createAuthorizationMiddleware({ getVerifier }));
  app.openapi(sessionRoute, (context) => context.json(
    SessionResponseSchema.parse(context.get("authorization")),
    200,
  ));

  return app;
}

export default createApp();
```

Production defaults to `createOidcVerifier` with the three generated env variables. Tests inject a local verifier; there is no environment flag that bypasses authentication. The app closure caches only the immutable verifier so `createRemoteJWKSet` can retain its key cache across requests. Do not cache request, token, subject, tenant, or authorization context in this closure.

- [ ] **Step 2: Implement middleware variables**

```ts
export type AuthorizationVariables = {
  authorization: SessionResponse;
};
```

The middleware must:

1. parse `Authorization` with `parseBearerToken`;
2. verify the token;
3. read optional `X-Communicator-Tenant`;
4. call `resolveAuthorization(context.env.CONTROL_DB, subject, tenantHint)`;
5. set `authorization` only for `ok: true`;
6. map authentication failures to 401 `unauthenticated`;
7. map directory `not_found` to 404;
8. map tenant selection to 400;
9. map D1 failure to 503;
10. log one structured object containing only `event`, `status`, and a generated `request_id`—never token, issuer, subject, SQL, or authorization header.

Use `crypto.randomUUID()` for `request_id`.

- [ ] **Step 3: Preserve the public health route**

`GET /api/v1/health` remains unauthenticated and non-secret. Apply middleware only to explicitly protected route registrations; do not use a wildcard that captures health or static assets.

- [ ] **Step 4: Type-check and commit**

```bash
pnpm --filter @communicator/control-plane check
git add apps/control-plane/worker/auth/middleware.ts apps/control-plane/worker/app.ts apps/control-plane/worker/index.ts
git commit -m "feat: enforce product authorization middleware"
```

### Task 10: Expose the authenticated session endpoint

**Files:**
- Create: `apps/control-plane/worker/routes/session.ts`
- Create: `apps/control-plane/worker/test/session.test.ts`
- Modify: `apps/control-plane/worker/app.ts`

- [ ] **Step 1: Write failing HTTP integration tests**

Use the real D1 binding, seeded directory, and injected local token verifier. Assert:

- valid Human token returns 200 and only Human identity;
- valid Agent token with `jti` returns 200 and only Agent identity;
- Human token plus `X-Communicator-Tenant: tenant_other` returns generic 404;
- missing, malformed, wrong-signature, wrong-issuer, wrong-audience, and expired tokens return identical 401 bodies;
- revoked principal/membership returns generic 404;
- health remains 200 without a token;
- response JSON validates with `SessionResponseSchema`;
- response text does not contain fixture subjects, issuer URLs, Matrix IDs, gateway routes, or bridge instance IDs.

- [ ] **Step 2: Define the OpenAPI route**

```ts
import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  SessionResponseSchema,
} from "@communicator/contracts";

const errorContent = {
  "application/json": { schema: ApiErrorResponseSchema },
};

export const sessionRoute = createRoute({
  method: "get",
  path: "/api/v1/session",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Authenticated tenant, principal, and identity authorization",
      content: { "application/json": { schema: SessionResponseSchema } },
    },
    400: { description: "Tenant selection required", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    404: { description: "Authorized tenant not found", content: errorContent },
    503: { description: "Authorization service unavailable", content: errorContent },
  },
});
```

Register an OpenAPI `bearerAuth` security scheme once on the app. The handler returns `context.get("authorization")` after validating it again with `SessionResponseSchema`; it performs no additional D1 query.

- [ ] **Step 3: Run integration tests**

```bash
pnpm --filter @communicator/control-plane test:worker -- session.test.ts health.test.ts
```

Expected: all protected-route, redaction, isolation, and health tests pass.

- [ ] **Step 4: Commit the endpoint**

```bash
git add apps/control-plane/worker/routes/session.ts apps/control-plane/worker/test/session.test.ts apps/control-plane/worker/app.ts
git commit -m "feat: expose authenticated session context"
```

### Task 11: Document local verification and the deployment gate

**Files:**
- Create: `docs/runbooks/control-directory-local.md`

- [ ] **Step 1: Write the runbook**

The runbook must include these exact sections:

1. **Purpose** — D1 authority versus rebuildable DO projection.
2. **Local reset and migration** — commands below.
3. **Test verification** — commands below.
4. **Forbidden data** — the complete forbidden column/content list from Task 4.
5. **Deployment gate** — state that the sentinel D1 UUID and `.invalid` issuer prohibit deployment.
6. **Live prerequisites** — an approved OIDC issuer/audience/JWKS URL, separately created D1 databases for staging/production, backup/restore procedure, and an operator seed workflow.
7. **Next milestone** — ordinary R2 archive/replay contract, followed by `TenantProjectionDO`.

Use these commands:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
pnpm --filter @communicator/control-plane test:worker
pnpm check
pnpm test
```

Do not document a production `wrangler deploy` command in this runbook.

- [ ] **Step 2: Commit documentation**

```bash
git add docs/runbooks/control-directory-local.md
git commit -m "docs: add control directory local runbook"
```

### Task 12: Final verification and handoff

**Files:**
- Verify all files changed by Tasks 1–11.

- [ ] **Step 1: Regenerate types and verify no diff drift**

```bash
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code apps/control-plane/worker-configuration.d.ts
```

Expected: no generated-type diff.

- [ ] **Step 2: Run focused and full verification**

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/control-plane test:worker
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e
python3 -m unittest discover -s tests -v
git diff --check
```

Expected:

- contract schemas pass;
- all Worker D1/auth tests pass in workerd;
- all existing UI tests pass unchanged;
- all Playwright tests pass using simulated data;
- Python infrastructure tests pass, except no pre-existing failure may be newly introduced or hidden;
- `git diff --check` prints nothing.

- [ ] **Step 3: Run the security scans**

```bash
rg -n 'matrix_access_token|e2ee_key|bridge_secret|provider_cookie|provider_password|qr_payload' apps/control-plane packages/contracts
rg -n 'console\.(log|error|warn).*?(token|issuer|subject|authorization|sql)' apps/control-plane/worker
rg -n '00000000-0000-0000-0000-000000000001|auth\.local\.invalid' apps/control-plane/wrangler.jsonc docs/runbooks/control-directory-local.md
```

Expected:

- the first command finds only explicit forbidden-data assertions/documentation;
- the second command finds no unsafe log statement;
- the third command finds the local sentinel plus the runbook warning, proving deployment remains gated.

- [ ] **Step 4: Inspect commit scope**

```bash
git status --short
git log --oneline --decorate -12
git diff main...HEAD --stat
```

Expected: only the files listed by this plan changed; no R2, Queue, DO, Matrix, bridge, or UI-live-data implementation appears.

- [ ] **Step 5: Commit any verification-only correction**

If verification required a correction, review `git diff --name-only`, confirm every path belongs to this plan, then commit tracked corrections with:

```bash
git add -u
git commit -m "fix: close control directory verification gaps"
```

If no correction was needed, do not create an empty commit.

## Phase acceptance checkpoint

The implementation session must report all of these as evidence before requesting review:

1. `GET /api/v1/health` remains public and non-secret.
2. `GET /api/v1/session` requires a cryptographically verified OIDC token.
3. Human and Agent sessions expose only their explicit identities and operations.
4. A tenant header is only a selection hint; a guessed tenant never creates access.
5. Revoked principals and memberships fail closed.
6. Agent/service tokens require a token ID suitable for revocation tracking.
7. Transactional grant and membership changes create one audit record and one pending outbox record per idempotency key.
8. A cross-tenant grant attempt rolls back completely.
9. The D1 schema and HTTP responses contain no messaging content or secret/provider authentication material.
10. Existing simulated UI behavior and browser tests still pass.
11. No Cloudflare production resource was created and no deployment occurred.

## Required implementation-session stopping conditions

Stop and ask the planner/user only if one of these occurs:

- a live OIDC provider must be selected or configured;
- a real staging/production D1 database must be created;
- a migration would delete or rewrite existing remote D1 data;
- the accepted public contract must change incompatibly;
- a Cloudflare API/package behavior contradicts the official 2026 documentation cited below;
- any test reveals existing Human/Agent data is not isolated by the proposed keys.

Routine package installation, local migrations, test fixture resets, code refactors within the listed files, and red-green test corrections do not require additional approval.

## Official references checked on 2026-08-29

- Cloudflare D1 `batch()` transaction semantics: <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- Cloudflare D1 Sessions and `first-primary`: <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- D1 migrations and custom migration directories: <https://developers.cloudflare.com/d1/reference/migrations/>
- Workers Vitest plugin configuration: <https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/>
- Workers Vitest D1 test APIs: <https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/>
- Current plugin rename to `@cloudflare/vitest-plugin`: <https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/>
- Workers JWT/JWKS validation pattern with `jose`: <https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/>
- Workers best practices: <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
