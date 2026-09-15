# Communicator UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Cloudflare-compatible, protected backoffice shell that Don can test immediately with contract-valid simulated Human and Agent data, while establishing the production API, UI, test, and package boundaries used by later Durable Object work.

**Architecture:** Create a pnpm workspace with one same-origin React/Vite and Hono Worker package at `apps/control-plane`, shared Zod/OpenAPI schemas at `packages/contracts`, and deterministic non-secret scenarios at `packages/test-fixtures`. The browser talks only through an API client and realtime transport boundary; development and protected staging may inject simulated adapters, while production builds fail closed unless configured for live data. This phase does not create Durable Objects, Queues, R2 buckets, provider sessions, or live Cloudflare production resources.

**Tech Stack:** Node.js 24 LTS, pnpm 10, TypeScript, React, Vite, `@cloudflare/vite-plugin`, TanStack Router, TanStack Query, Tailwind CSS, shadcn/ui, Hono, `@hono/zod-openapi`, Zod, Mock Service Worker, Vitest, React Testing Library, `@cloudflare/vitest-plugin`, and Playwright.

---

## Scope and execution rules

This is the first independently testable phase of the system specification. It
delivers these browser routes:

```text
/
/connections
/conversations
/conversations/:conversationId
/activity
/system
```

The simulated pilot contains one tenant, two identities, two WhatsApp
connections, isolated conversations, connection-health variants, direct and
paced command examples, and synthetic attachment metadata. It contains
no copied production messages, credentials, provider cookies, QR payloads,
Matrix IDs, phone numbers, or personal data.

Every task follows red-green-refactor discipline. Do not combine tasks into one
commit. Do not deploy or create Cloudflare resources in Tasks 1-9. Task 10 may
deploy only a protected staging Worker after the operator confirms that the
Cloudflare Access application exists and the production route is not targeted.

## Locked file layout

```text
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.nvmrc
tsconfig.base.json
apps/
  control-plane/
    package.json
    components.json
    index.html
    vite.config.ts
    vitest.worker.config.ts
    vitest.ui.config.ts
    playwright.config.ts
    wrangler.jsonc
    tsconfig.json
    worker/
      app.ts
      index.ts
      routes/health.ts
      test/health.test.ts
    src/
      main.tsx
      app/providers.tsx
      app/router.tsx
      routeTree.gen.ts
      routes/__root.tsx
      routes/index.tsx
      routes/connections.tsx
      routes/conversations.index.tsx
      routes/conversations.$conversationId.tsx
      routes/activity.tsx
      routes/system.tsx
      components/layout/app-shell.tsx
      components/layout/environment-banner.tsx
      components/identity/identity-switcher.tsx
      components/ui/*
      features/connections/*
      features/conversations/*
      features/activity/*
      features/system/*
      lib/api/client.ts
      lib/api/query-keys.ts
      lib/config/runtime.ts
      lib/realtime/client.ts
      lib/realtime/simulated-client.ts
      mocks/browser.ts
      mocks/handlers.ts
      mocks/server.ts
      mocks/store.ts
      test/render-app.tsx
      test/setup.ts
packages/
  contracts/
    package.json
    tsconfig.json
    src/*.ts
    test/schemas.test.ts
  test-fixtures/
    package.json
    tsconfig.json
    src/pilot-scenario.ts
    test/pilot-scenario.test.ts
docs/runbooks/backoffice-staging.md
tests/test_repository_contract.py
```

## Specification traceability

| System-specification area | This phase |
|---|---|
| Canonical resources, capabilities, commands, realtime events | Task 2 freezes the browser subset |
| Public REST boundary | Tasks 3 and 5 prove same-origin Hono and typed client seams |
| Tenant and identity isolation | Tasks 2, 5, 6, 7, and 9 test it symmetrically |
| Backoffice UX | Tasks 4, 6, 7, 8, and 9 deliver the first usable surface |
| Product authentication | Task 10 provides only an outer Access gate for non-secret staging fixtures |
| D1 Control Directory | The next phase implements it; this phase does not provision or emulate authority |
| Durable Objects, Queue, R2, Matrix Gateway | Excluded from this phase and not faked as healthy infrastructure |
| Self-service provider linking | Connections UX states only; no credential or provisioning flow |
| Automation and Brain connector | Excluded from this phase |

The next phase replaces the simulated `/v1/me`, identities, and connections
reads with OIDC validation and the D1 Control Directory. This sequencing is
intentional: the UI can be evaluated now without using fixtures as an
authorization model.

## Task 1: Establish the pinned TypeScript workspace

**Files:**

- Modify: `.gitignore`
- Modify: `tests/test_repository_contract.py`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `pnpm-lock.yaml` through `pnpm install`

- [ ] **Step 1: Write the failing repository contract test**

Add `json` to the imports and these methods to
`RepositoryContractTests`:

```python
import json


def test_typescript_workspace_is_pinned(self):
    package = json.loads((ROOT / "package.json").read_text())
    self.assertTrue(package["private"])
    self.assertEqual("pnpm@10.14.0", package["packageManager"])
    self.assertEqual(">=24 <27", package["engines"]["node"])
    self.assertEqual("24", (ROOT / ".nvmrc").read_text().strip())
    workspace = (ROOT / "pnpm-workspace.yaml").read_text()
    for member in ("apps/*", "packages/*", "workers/*", "services/*"):
        self.assertIn(f"- '{member}'", workspace)

def test_generated_frontend_files_are_ignored(self):
    ignored = (ROOT / ".gitignore").read_text()
    for entry in ("playwright-report/", "test-results/", ".wrangler/"):
        self.assertIn(entry, ignored)
```

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
python3 -m unittest tests.test_repository_contract.RepositoryContractTests.test_typescript_workspace_is_pinned -v
```

Expected: `ERROR` with `FileNotFoundError` for `package.json`.

- [ ] **Step 3: Create the workspace files**

Create `.nvmrc`:

```text
24
```

Create `package.json`:

```json
{
  "name": "communicator",
  "private": true,
  "packageManager": "pnpm@10.14.0",
  "engines": {
    "node": ">=24 <27"
  },
  "scripts": {
    "build": "pnpm -r --if-present build",
    "check": "pnpm -r --if-present check",
    "test": "pnpm -r --if-present test",
    "test:python": "python3 -m unittest discover -s tests -v"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'workers/*'
  - 'services/*'
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  }
}
```

Append these lines to `.gitignore`:

```gitignore
.wrangler/
playwright-report/
test-results/
blob-report/
```

Run `pnpm install` to create the lockfile.

- [ ] **Step 4: Run the contract and baseline suites**

Run:

```bash
python3 -m unittest tests.test_repository_contract -v
python3 -m unittest discover -s tests -v
```

Expected: all repository-contract tests pass and the existing 40-test baseline
remains green.

- [ ] **Step 5: Commit the workspace foundation**

```bash
git add .gitignore .nvmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tests/test_repository_contract.py
git commit -m "build: establish communicator TypeScript workspace"
```

## Task 2: Freeze the browser-facing contracts and safe pilot fixtures

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/identity.ts`
- Create: `packages/contracts/src/connection.ts`
- Create: `packages/contracts/src/conversation.ts`
- Create: `packages/contracts/src/command.ts`
- Create: `packages/contracts/src/realtime.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/schemas.test.ts`
- Create: `packages/test-fixtures/package.json`
- Create: `packages/test-fixtures/tsconfig.json`
- Create: `packages/test-fixtures/src/pilot-scenario.ts`
- Create: `packages/test-fixtures/test/pilot-scenario.test.ts`

- [ ] **Step 1: Create package manifests and install dependencies**

Create `packages/contracts/package.json`:

```json
{
  "name": "@communicator/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "check": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Create `packages/test-fixtures/package.json`:

```json
{
  "name": "@communicator/test-fixtures",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/pilot-scenario.ts" },
  "scripts": {
    "check": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@communicator/contracts": "workspace:*"
  }
}
```

Create the same `tsconfig.json` in both packages:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vitest/globals"] },
  "include": ["src", "test"]
}
```

Install and lock dependencies:

```bash
pnpm --filter @communicator/contracts add zod @hono/zod-openapi
pnpm --filter @communicator/contracts add -D typescript vitest
pnpm --filter @communicator/test-fixtures add zod
pnpm --filter @communicator/test-fixtures add -D typescript vitest
```

- [ ] **Step 2: Write failing schema tests**

Create `packages/contracts/test/schemas.test.ts` with tests that require:

```ts
import { describe, expect, it } from "vitest";
import {
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  RealtimeEventSchema,
} from "../src/index";

describe("public schemas", () => {
  it("accepts opaque Communicator IDs and rejects Matrix IDs", () => {
    expect(IdentitySchema.safeParse({
      id: "identity_human",
      tenant_id: "tenant_pilot",
      kind: "human",
      display_name: "Human",
    }).success).toBe(true);
    expect(IdentitySchema.safeParse({
      id: "@human:communicator.0000.gold",
      tenant_id: "tenant_pilot",
      kind: "human",
      display_name: "Human",
    }).success).toBe(false);
  });

  it("keeps connection capabilities data-driven", () => {
    const parsed = ConnectionSchema.parse({
      id: "connection_human_whatsapp",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      provider: "whatsapp",
      display_label: "Personal WhatsApp",
      status: "ready",
      capabilities: ["message.send", "reaction.add", "typing.send"],
      last_synced_at: "2026-08-27T00:00:00.000Z",
    });
    expect(parsed.capabilities).toContain("typing.send");
  });

  it("requires command and realtime sequence identifiers", () => {
    expect(() => CommandSchema.parse({ operation: "message.send" })).toThrow();
    expect(() => RealtimeEventSchema.parse({ type: "command.updated" })).toThrow();
  });

  it("requires conversation ownership by identity and connection", () => {
    expect(ConversationSummarySchema.safeParse({
      id: "conversation_human_one",
      tenant_id: "tenant_pilot",
      title: "Example Contact",
    }).success).toBe(false);
  });
});
```

Run:

```bash
pnpm --filter @communicator/contracts test
```

Expected: failure because the exported schemas do not exist.

- [ ] **Step 3: Implement the minimal schemas**

Use `z.string().regex(/^[a-z]+_[a-z0-9_]+$/)` for all public IDs. Define and
export these exact enums and records:

```ts
export const IdentityKindSchema = z.enum(["human", "agent"]);
export const ProviderSchema = z.enum([
  "whatsapp",
  "telegram",
  "messenger",
  "linkedin",
]);
export const ConnectionStatusSchema = z.enum([
  "connected",
  "syncing",
  "ready",
  "attention_required",
  "disconnected",
  "revoked",
  "unlinked",
]);
export const CapabilitySchema = z.enum([
  "message.send",
  "message.edit",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "receipt.read",
  "typing.send",
  "attachment.send",
]);
export const DeliveryModeSchema = z.enum(["direct", "paced"]);
export const CommandStatusSchema = z.enum([
  "accepted",
  "scheduled",
  "reading",
  "typing",
  "submitted_to_matrix",
  "matrix_confirmed",
  "bridged",
  "delivered",
  "cancelled",
  "unsupported",
  "failed",
]);
```

Use these exact wire fields; factor the common ID and timestamp validators into
`ids.ts` and place each resource in its named file:

```ts
export const CommunicatorIdSchema = z
  .string()
  .regex(/^[a-z]+_[a-z0-9_]+$/);
export const TimestampSchema = z.string().datetime({ offset: true });

export const IdentitySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  kind: IdentityKindSchema,
  display_name: z.string().min(1).max(100),
}).strict();

export const ConnectionSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  provider: ProviderSchema,
  display_label: z.string().min(1).max(100),
  status: ConnectionStatusSchema,
  capabilities: z.array(CapabilitySchema),
  last_synced_at: TimestampSchema.nullable(),
  attention_code: z.string().max(100).optional(),
}).strict();

export const ConversationSummarySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  title: z.string().min(1).max(200),
  last_message_preview: z.string().max(280),
  last_activity_at: TimestampSchema,
  unread_count: z.number().int().nonnegative(),
}).strict();

export const MessageSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  direction: z.enum(["inbound", "outbound"]),
  sender_label: z.string().min(1).max(100),
  body: z.string().max(20_000),
  occurred_at: TimestampSchema,
  delivery_status: z.enum([
    "unknown",
    "accepted",
    "sent",
    "delivered",
    "read",
    "failed",
  ]),
  attachment_count: z.number().int().nonnegative(),
}).strict();

export const CommandSchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  operation: z.enum(["message.send"]),
  delivery_mode: DeliveryModeSchema,
  status: CommandStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  failure_code: z.string().max(100).optional(),
}).strict();

export const RealtimeEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum([
    "connection.updated",
    "message.created",
    "command.updated",
    "system.status.updated",
  ]),
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  occurred_at: TimestampSchema,
  data: z.record(z.string(), z.unknown()),
}).strict();
```

Export inferred TypeScript types and all schemas from `src/index.ts`. Do not
include Matrix room IDs, remote credentials, cookies, QR values, access tokens,
or E2EE fields.

Run:

```bash
pnpm --filter @communicator/contracts check
pnpm --filter @communicator/contracts test
```

Expected: both commands pass.

- [ ] **Step 4: Write the failing safe-fixture test**

Create `packages/test-fixtures/test/pilot-scenario.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PilotScenarioSchema } from "../src/pilot-scenario";
import { pilotScenario } from "../src/pilot-scenario";

describe("pilotScenario", () => {
  it("is contract-valid and identity-isolated", () => {
    const scenario = PilotScenarioSchema.parse(pilotScenario);
    const human = scenario.conversations.filter(
      (item) => item.identity_id === "identity_human",
    );
    const agent = scenario.conversations.filter(
      (item) => item.identity_id === "identity_agent",
    );
    expect(human.length).toBeGreaterThan(0);
    expect(agent.length).toBeGreaterThan(0);
    expect(human.some(
      (humanItem) => agent.some((agentItem) => agentItem.id === humanItem.id),
    )).toBe(false);
  });

  it("contains no real infrastructure or credential markers", () => {
    const serialized = JSON.stringify(pilotScenario);
    for (const forbidden of [
      "169.58.160.23",
      "communicator.0000.gold",
      "m.login",
      "access_token",
      "cookie",
      "@human:",
      "@agent:",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
```

Run `pnpm --filter @communicator/test-fixtures test` and expect import errors.

- [ ] **Step 5: Implement deterministic pilot fixtures**

Create `PilotScenarioSchema` from arrays of the shared schemas and export one
frozen `pilotScenario` with:

```text
tenant_pilot
identity_human -> connection_human_whatsapp -> two Human conversations
identity_agent -> connection_agent_whatsapp -> one Agent conversation
one ready connection, one attention_required variant selectable by scenario
at least two inbound and one outbound message per identity
one delivered direct command and one scheduled paced command
```

Use names such as `Example Contact`, `Example Customer`, and `Agent Test Chat`.
Use `+00000000000` only if a phone-shaped display field is required. Use fixed
UTC timestamps under `2026-08-27T00:00:00.000Z` so screenshots and tests are
repeatable.

Run:

```bash
pnpm --filter @communicator/test-fixtures check
pnpm --filter @communicator/test-fixtures test
```

Expected: both pass.

- [ ] **Step 6: Commit contracts and fixtures**

```bash
git add packages pnpm-lock.yaml
git commit -m "feat: define communicator UI contracts and fixtures"
```

## Task 3: Scaffold the same-origin React and Hono Cloudflare application

**Files:**

- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/index.html`
- Create: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/vite.config.ts`
- Create: `apps/control-plane/vitest.worker.config.ts`
- Create: `apps/control-plane/vitest.ui.config.ts`
- Create: `apps/control-plane/wrangler.jsonc`
- Create: `apps/control-plane/worker/app.ts`
- Create: `apps/control-plane/worker/index.ts`
- Create: `apps/control-plane/worker/routes/health.ts`
- Create: `apps/control-plane/worker/test/health.test.ts`
- Create: `apps/control-plane/src/main.tsx`

- [ ] **Step 1: Create the package and install the exact dependency families**

Create `apps/control-plane/package.json` with name
`@communicator/control-plane`, `private: true`, `type: module`, and scripts:

```json
{
  "scripts": {
    "build": "vite build",
    "check": "tsc -p tsconfig.json && vite build",
    "dev": "vite",
    "test": "pnpm test:worker && pnpm test:ui",
    "test:worker": "vitest run --config vitest.worker.config.ts",
    "test:ui": "vitest run --config vitest.ui.config.ts",
    "test:e2e": "playwright test",
    "types:worker": "wrangler types worker-configuration.d.ts"
  },
  "dependencies": {
    "@communicator/contracts": "workspace:*",
    "@communicator/test-fixtures": "workspace:*"
  }
}
```

Install:

```bash
pnpm --filter @communicator/control-plane add react react-dom hono @hono/zod-openapi zod @tanstack/react-query @tanstack/react-router react-hook-form @hookform/resolvers lucide-react
pnpm --filter @communicator/control-plane add -D typescript vite @vitejs/plugin-react @cloudflare/vite-plugin wrangler @cloudflare/vitest-plugin vitest @types/node @types/react @types/react-dom @tanstack/router-plugin msw tailwindcss @tailwindcss/vite @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom @playwright/test
```

- [ ] **Step 2: Write the failing Worker health test**

Create `worker/test/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import app from "../app";

describe("GET /api/v1/health", () => {
  it("returns a non-secret health document", async () => {
    const response = await app.request("http://example.test/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "communicator-control-plane",
      data_mode: "unconfigured",
    });
  });
});
```

Run `pnpm --filter @communicator/control-plane test` and expect an import
failure for `worker/app.ts`.

- [ ] **Step 3: Implement the Hono Worker and configuration**

Create `worker/routes/health.ts`:

```ts
import { createRoute, z } from "@hono/zod-openapi";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("communicator-control-plane"),
  data_mode: z.enum(["unconfigured", "simulated", "live"]),
}).strict();

export const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  responses: {
    200: {
      description: "Control-plane liveness and configured data mode",
      content: {
        "application/json": { schema: HealthResponseSchema },
      },
    },
  },
});
```

Create `worker/app.ts`:

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { healthRoute } from "./routes/health";

type Bindings = {
  COMMUNICATOR_DATA_MODE?: "simulated" | "live";
};

const app = new OpenAPIHono<{ Bindings: Bindings }>();

app.openapi(healthRoute, (context) => context.json({
  status: "ok",
  service: "communicator-control-plane",
  data_mode: context.env?.COMMUNICATOR_DATA_MODE ?? "unconfigured",
}, 200));

export default app;
```

Create `worker/index.ts`:

```ts
export { default } from "./app";
```

The response contains only the three fields asserted above.

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "communicator-control-plane",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-08-27",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "observability": { "enabled": true },
  "vars": {
    "COMMUNICATOR_ENV": "development",
    "COMMUNICATOR_DATA_MODE": "simulated"
  }
}
```

Create `vitest.worker.config.ts` using:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
  test: { include: ["worker/test/**/*.test.ts"] },
});
```

Create `vitest.ui.config.ts` using:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Create `vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  if (
    env.VITE_DEPLOYMENT_ENV === "production" &&
    env.VITE_DATA_MODE !== "live"
  ) {
    throw new Error("Simulated data is forbidden in production");
  }

  return {
    plugins: [
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      cloudflare(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
  };
});
```

Create `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "types": ["vite/client"]
  },
  "include": [
    "src",
    "worker",
    "worker-configuration.d.ts",
    "vite.config.ts",
    "vitest.*.config.ts"
  ]
}
```

Create `index.html` with one `<div id="root"></div>` and a module script for
`/src/main.tsx`. Create `src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <main>Communicator UI foundation</main>
  </StrictMode>,
);
```

- [ ] **Step 4: Generate Worker types and verify runtime compatibility**

Run:

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane test
pnpm --filter @communicator/control-plane check
```

Expected: health test passes and the Vite production build succeeds.

- [ ] **Step 5: Commit the application scaffold**

```bash
git add apps/control-plane pnpm-lock.yaml
git commit -m "feat: scaffold communicator Cloudflare control plane"
```

## Task 4: Build the accessible application shell and route structure

**Files:**

- Create: `apps/control-plane/components.json`
- Create: `apps/control-plane/src/styles.css`
- Create: `apps/control-plane/src/app/providers.tsx`
- Create: `apps/control-plane/src/app/router.tsx`
- Create: `apps/control-plane/src/routes/*.tsx`
- Create: `apps/control-plane/src/components/layout/app-shell.tsx`
- Create: `apps/control-plane/src/components/layout/environment-banner.tsx`
- Create: `apps/control-plane/src/components/identity/identity-switcher.tsx`
- Create: `apps/control-plane/src/test/setup.ts`
- Create: `apps/control-plane/src/test/render-app.tsx`
- Create: `apps/control-plane/src/components/layout/app-shell.test.tsx`
- Modify: `apps/control-plane/src/main.tsx`

- [ ] **Step 1: Configure Tailwind and install owned UI components**

Create `components.json` configured for TypeScript, Tailwind CSS variables,
the `new-york` style, neutral base color, and aliases under `@/components` and
`@/lib`. Add `@/*` path mapping to `tsconfig.json` and `vite.config.ts`.

From `apps/control-plane`, run:

```bash
pnpm dlx shadcn@latest add --yes button badge card dropdown-menu select separator sheet sidebar skeleton table tabs textarea tooltip alert-dialog progress
```

Create `src/styles.css` from the generated theme and import it from
`src/main.tsx`.

- [ ] **Step 2: Write the failing shell test**

The test renders `/connections` and asserts accessible navigation links named
`Overview`, `Connections`, `Conversations`, `Activity`, and `System`; a visible
`SIMULATED DATA` banner; an identity selector labelled `Active identity`; and a
main heading named `Connections`.

Run:

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.ui.config.ts src/components/layout/app-shell.test.tsx
```

Expected: failure because the shell and router do not exist.

- [ ] **Step 3: Implement providers, routes, and the shell**

Create one `QueryClient` with retries disabled in tests and at most one retry in
the browser. Build a TanStack file router with the six locked routes. Each route
initially renders its route title and a one-sentence empty-state description.

`AppShell` must provide:

```text
top bar: Communicator / environment banner / active identity
sidebar: Overview / Connections / Conversations / Activity / System
main: route outlet
mobile: Sheet-based navigation with the same accessible link names
```

The environment banner reads runtime configuration rather than hostname. In
simulated mode it always renders `SIMULATED DATA — no provider actions are
performed`.

- [ ] **Step 4: Verify shell behavior**

Run:

```bash
pnpm --filter @communicator/control-plane test
pnpm --filter @communicator/control-plane check
```

Expected: shell test, Worker health test, typecheck, and build pass.

- [ ] **Step 5: Commit the UI shell**

```bash
git add apps/control-plane pnpm-lock.yaml
git commit -m "feat: add communicator backoffice shell"
```

## Task 5: Add the contract-backed API and simulated realtime adapters

**Files:**

- Create: `apps/control-plane/src/lib/config/runtime.ts`
- Create: `apps/control-plane/src/lib/api/client.ts`
- Create: `apps/control-plane/src/lib/api/query-keys.ts`
- Create: `apps/control-plane/src/lib/realtime/client.ts`
- Create: `apps/control-plane/src/lib/realtime/simulated-client.ts`
- Create: `apps/control-plane/src/mocks/browser.ts`
- Create: `apps/control-plane/src/mocks/handlers.ts`
- Create: `apps/control-plane/src/mocks/server.ts`
- Create: `apps/control-plane/src/mocks/store.ts`
- Create: `apps/control-plane/src/mocks/handlers.test.ts`
- Create: `apps/control-plane/public/mockServiceWorker.js` through the MSW CLI
- Modify: `apps/control-plane/src/test/setup.ts`
- Modify: `apps/control-plane/src/main.tsx`

- [ ] **Step 1: Write failing adapter tests**

Test these requests against the MSW handlers:

```text
GET /api/v1/me
GET /api/v1/identities
GET /api/v1/connections?identity_id=identity_human
GET /api/v1/conversations?identity_id=identity_agent
GET /api/v1/conversations/conversation_agent_one/messages
GET /api/v1/commands?identity_id=identity_human
POST /api/v1/conversations/conversation_human_one/messages
POST /api/v1/testing/reset
```

Assert every response parses through the matching shared schema. Assert Human
queries never return Agent records and the reverse. Assert send requires an
`Idempotency-Key`, accepts only `direct` or `paced`, and returns a contract-valid
`202` command.

Run the focused test and expect failures because handlers are absent.

- [ ] **Step 2: Implement a resettable simulated store and handlers**

Clone `pilotScenario` on every `reset()` call. Filter all collections by the
explicit requested identity and reject unknown or unauthorized combinations
with this stable error shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "The requested resource is not available."
  }
}
```

Do not reveal whether a cross-identity ID exists. Cache idempotency keys in the
simulated store and return the original command for repeats. Add a
`/api/v1/health` handler that returns `passthrough()` so the System screen tests
the real local Hono Worker rather than a mock health response. Create an MSW
Node server for tests and start/reset/close it from `src/test/setup.ts`.

Generate the browser service worker from `apps/control-plane`:

```bash
pnpm exec msw init public --save
```

- [ ] **Step 3: Implement client boundaries and the production guard**

`ApiClient` exposes typed methods for the six simulated endpoints and validates
responses before returning them. `RealtimeClient` exposes `connect`,
`subscribe`, `lastSequence`, and `close`. The simulated implementation emits
deterministic command transitions through an injected clock; it performs no
network call.

Parse these build-time values in `runtime.ts`:

```text
VITE_DEPLOYMENT_ENV = local | staging | production
VITE_DATA_MODE = simulated | live
```

Development defaults to `local/simulated`; an optimized build defaults to
`production/live`. Explicit values override those defaults after strict enum
validation.

Throw during application startup when deployment environment is `production`
and data mode is not `live`. The matching guard in `vite.config.ts` makes the
invalid combination fail during the build itself. Render the data mode in the
persistent environment banner.

- [ ] **Step 4: Start MSW before rendering React in simulated mode**

`main.tsx` dynamically imports `mocks/browser.ts`, awaits `worker.start` with
`onUnhandledRequest: "error"`, and only then renders the router. The explicit
health passthrough remains allowed. Live mode must not import MSW into the
execution path.

Run:

```bash
VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm --filter @communicator/control-plane test
VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm --filter @communicator/control-plane check
VITE_DEPLOYMENT_ENV=production VITE_DATA_MODE=simulated pnpm --filter @communicator/control-plane build
```

Expected: tests and local build pass; the production/simulated build fails with
`Simulated data is forbidden in production`.

- [ ] **Step 5: Commit adapters and guards**

```bash
git add apps/control-plane pnpm-lock.yaml
git commit -m "feat: add safe simulated communicator adapters"
```

## Task 6: Make identity switching and Connections browser-testable

**Files:**

- Create: `apps/control-plane/src/features/connections/connection-card.tsx`
- Create: `apps/control-plane/src/features/connections/connections-page.tsx`
- Create: `apps/control-plane/src/features/connections/connections-page.test.tsx`
- Modify: `apps/control-plane/src/components/identity/identity-switcher.tsx`
- Modify: `apps/control-plane/src/routes/connections.tsx`

- [ ] **Step 1: Write failing user-visible tests**

Render the Connections route. Assert Human selection shows `Personal WhatsApp`
and not `Agent WhatsApp`. Switch to Agent using the labelled selector and assert
the inverse. Assert each connection card displays provider, status, last sync,
and capability badges. For an `attention_required` fixture, assert a visible
`Action required` callout and a disabled `Reconnect` control labelled
`Simulation only`.

Run the focused test and expect missing component failures.

- [ ] **Step 2: Implement identity context and query invalidation**

Keep the selected identity in route search state as `identity`, validated
against the authorized identities response. If the value is absent or invalid,
replace it with the first authorized identity. On a switch, invalidate only
identity-scoped connection and conversation query keys.

- [ ] **Step 3: Implement Connections cards and safe controls**

Use status badges with text in addition to color. Group capabilities under an
expandable `Capabilities` region. Render `Connect account`, `Reconnect`,
`Disconnect`, and `Unlink` as disabled simulation controls with explanatory
tooltips. Do not simulate credential forms or QR payloads in this phase.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @communicator/control-plane test
pnpm --filter @communicator/control-plane check
git add apps/control-plane
git commit -m "feat: add identity-scoped connections UI"
```

## Task 7: Build the inbox, timeline, and direct/paced composer

**Files:**

- Create: `apps/control-plane/src/features/conversations/conversation-list.tsx`
- Create: `apps/control-plane/src/features/conversations/message-timeline.tsx`
- Create: `apps/control-plane/src/features/conversations/message-composer.tsx`
- Create: `apps/control-plane/src/features/conversations/conversation-page.tsx`
- Create: `apps/control-plane/src/features/conversations/conversation-page.test.tsx`
- Modify: `apps/control-plane/src/routes/conversations.index.tsx`
- Modify: `apps/control-plane/src/routes/conversations.$conversationId.tsx`

- [ ] **Step 1: Write failing isolation and composer tests**

Assert the Human inbox contains only Human fixture titles. Navigate to a Human
conversation and assert chronological inbound/outbound messages, delivery
labels, timestamps, and attachment metadata. Switch to Agent and assert the old
Human conversation route becomes the generic not-found state.

For the composer, assert an empty message cannot submit. Enter `Hello from the
simulated Human identity`, select `Direct`, submit, and assert one accepted
command appears. Repeat with the same injected idempotency key and assert only
one command exists. Select `Human-paced` and assert the preview lists:

```text
Mark read (when supported)
Reading delay
Typing indicator
Send message
```

- [ ] **Step 2: Implement conversation queries and identity-safe routing**

Conversation list requests include the active identity selector. A detail route
must first find the conversation in that authorized list before requesting its
messages. Treat a missing or cross-identity conversation identically.

- [ ] **Step 3: Implement the message timeline and composer**

Use semantic ordered lists and sender labels. Do not render raw HTML from
message bodies. The composer sends plain text, delivery mode, and a generated
UUID idempotency key. Disable controls while the request is in flight. On
acceptance, invalidate the command activity query but do not invent a confirmed
message; display `Accepted — awaiting messaging confirmation`.

The paced preview explains planned phases but does not wait in the browser.
Scheduling remains a server responsibility in the later command-DO phase.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @communicator/control-plane test
pnpm --filter @communicator/control-plane check
git add apps/control-plane
git commit -m "feat: add simulated communicator inbox and composer"
```

## Task 8: Add Activity, System, and diagnostic test surfaces

**Files:**

- Create: `apps/control-plane/src/features/activity/command-timeline.tsx`
- Create: `apps/control-plane/src/features/activity/activity-page.tsx`
- Create: `apps/control-plane/src/features/system/system-page.tsx`
- Create: `apps/control-plane/src/features/system/system-page.test.tsx`
- Modify: `apps/control-plane/src/routes/activity.tsx`
- Modify: `apps/control-plane/src/routes/system.tsx`
- Modify: `apps/control-plane/src/routes/index.tsx`

- [ ] **Step 1: Write failing status-surface tests**

Assert Activity displays operation, identity, delivery mode, current phase,
timestamps, and failure reason code without rendering credentials or raw Matrix
identifiers. Assert System displays API health, data mode, realtime connection
state, last sequence, and fixture reset time. Assert Overview links to every
screen and summarizes connection and command counts for the active identity.

- [ ] **Step 2: Implement activity and diagnostics**

Render a phase list from the shared command status enum. Unknown intermediate
states use `Status unavailable`; they never display as delivered. System health
comes from `/api/v1/health`; simulated adapter status and realtime sequence are
separate rows so a green mock does not imply the real Matrix path is healthy.

- [ ] **Step 3: Add a development-only scenario reset**

Expose `Reset simulated scenario` only when data mode is simulated. It calls
the in-memory store reset endpoint, clears Query caches, resets the simulated
realtime sequence, and announces completion through an ARIA live region. The
control is absent from live bundles.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @communicator/control-plane test
pnpm --filter @communicator/control-plane check
git add apps/control-plane
git commit -m "feat: add communicator activity and system views"
```

## Task 9: Add browser acceptance and responsive checks

**Files:**

- Create: `apps/control-plane/playwright.config.ts`
- Create: `apps/control-plane/e2e/navigation.spec.ts`
- Create: `apps/control-plane/e2e/identity-isolation.spec.ts`
- Create: `apps/control-plane/e2e/send-command.spec.ts`
- Create: `apps/control-plane/e2e/responsive.spec.ts`
- Modify: `apps/control-plane/package.json`

- [ ] **Step 1: Configure Playwright against the simulated Vite server**

Use one Chromium project, `baseURL: http://127.0.0.1:4173`, trace on first
retry, screenshot on failure, and this web server command, which runs both the
SPA and local Worker through the Cloudflare Vite plugin:

```bash
VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm vite --host 127.0.0.1 --port 4173
```

- [ ] **Step 2: Write and run the browser journeys**

Use role- and label-based locators. Cover:

1. navigation to all five primary screens;
2. Human-to-Agent switching with symmetric conversation isolation;
3. a direct send accepted once under retry;
4. a paced-send preview and accepted command timeline;
5. an attention-required connection state;
6. scenario reset; and
7. desktop `1440x900` and mobile `390x844` navigation.

Run `pnpm --filter @communicator/control-plane test:e2e` and require all tests
to pass without retries.

- [ ] **Step 3: Run the complete local gate**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e
pnpm test:python
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Commit browser acceptance**

```bash
git add apps/control-plane pnpm-lock.yaml
git commit -m "test: cover communicator backoffice journeys"
```

## Task 10: Document and gate the protected staging preview

**Files:**

- Create: `docs/runbooks/backoffice-staging.md`
- Modify: `apps/control-plane/wrangler.jsonc`
- Modify: `tests/test_repository_contract.py`

- [ ] **Step 1: Write the failing staging safety contract**

Add a Python test that parses `wrangler.jsonc` after removing comment-only
lines and asserts:

```text
base Worker name is communicator-control-plane
staging Worker name is communicator-control-plane-staging
production environment has COMMUNICATOR_DATA_MODE=live
no route contains matrix.communicator.0000.gold
no secret, IP address, Matrix user, provider account, or credential appears
```

Run the focused test and expect failure because staging configuration is absent.

- [ ] **Step 2: Add explicit staging and production environments**

Configure staging with a distinct Worker name and
`COMMUNICATOR_DATA_MODE=simulated`. Configure production with a distinct Worker
name and `COMMUNICATOR_DATA_MODE=live`. Do not add production routes or custom
domains in this phase.

- [ ] **Step 3: Write the staging runbook**

The runbook must require, in order:

1. verify the Cloudflare account and Worker name;
2. verify a Cloudflare Access application protects the entire staging hostname;
3. verify the allowed identity list contains only the pilot operator;
4. run the complete local gate from Task 9;
5. build with
   `VITE_DEPLOYMENT_ENV=staging VITE_DATA_MODE=simulated pnpm --filter @communicator/control-plane build`,
   then deploy only with
   `pnpm --filter @communicator/control-plane exec wrangler deploy --env staging`;
6. open the staging hostname in a signed-out browser and require Access denial;
7. sign in, verify the persistent simulated-data banner, and execute the four
   Playwright-equivalent manual journeys;
8. inspect Worker logs for secret-free errors; and
9. delete the staging deployment if the Access denial or banner check fails.

The runbook must state that live Matrix, bridge, DO, Queue, R2, and provider
credentials are forbidden in this staging phase.

- [ ] **Step 4: Stop for operator approval before any Cloudflare mutation**

Report the proposed staging Worker name and required Access hostname. Do not
run `wrangler deploy` until the operator explicitly approves the deployment and
confirms Access protection is ready.

- [ ] **Step 5: Verify and commit the completed phase**

Run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e
python3 -m unittest discover -s tests -v
git diff --check
git status --short
```

Expected before commit: only the intended runbook, Wrangler configuration, and
repository-contract test are modified. Commit:

```bash
git add apps/control-plane/wrangler.jsonc docs/runbooks/backoffice-staging.md tests/test_repository_contract.py
git commit -m "docs: gate communicator staging backoffice"
```

Run `git status --short` again and require no output.

## Phase acceptance checkpoint

The phase is complete only when all of these are demonstrated:

1. Don can open the backoffice locally, or on the explicitly approved protected
   staging URL, and sees a persistent simulated-data warning.
2. Human and Agent identity switching is symmetric and does not leak the other
   identity's connection, conversation, or message fixtures.
3. Connections, inbox, timeline, direct send, paced-send preview, Activity, and
   System screens work through contract-valid adapters.
4. Retrying a simulated send with the same idempotency key creates one command.
5. Cross-identity route guesses return the same generic not-found state.
6. Production/simulated builds fail closed.
7. The browser application contains no Matrix, provider, or infrastructure
   credentials and performs no external messaging action.
8. Python, TypeScript, Worker-runtime, component, build, and Playwright gates
   all pass from a clean checkout with the committed lockfile.

After this checkpoint, write the next independent implementation plan for
product authentication, the authorization directory, and replacement of the
first simulated read endpoints. Do not begin Durable Object or live-message
work under this phase plan.
