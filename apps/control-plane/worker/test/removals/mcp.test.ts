import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import type {
  CanonicalEventEnvelope,
  SessionResponse,
} from "@communicator/contracts";
import {
  RemovalAuthoritySchema,
  RecordRemovalInputSchema,
  ScheduleRemovalExpiryInputSchema,
} from "../../../../../packages/contracts/src/removals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type { AuthorizationVariables } from "../../auth/middleware";
import type { IngestionAuthorizationVariables } from "../../auth/ingestion-middleware";
import {
  recordRemovalHandler,
  recordRemovalRoute,
  removalStatusHandler,
  removalStatusRoute,
  scheduleRemovalExpiryHandler,
  scheduleRemovalExpiryRoute,
} from "../../routes/removals";
import {
  registerRemovalMcpTools,
  type RemovalMcpContext,
} from "../../removals/mcp";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import {
  purgeRecordedRemoval,
  recordRemovalWithArchivePurge,
} from "../../archive/lifecycle";
import {
  cleanupArchiveTenant as cleanupArchiveObjects,
  makeEvent,
} from "../archive/support";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const archiveBucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const tenantId = "tenant_pilot";
const otherTenantId = "tenant_other";
const fixedNow = "2026-09-14T01:00:00.000Z";

const adminSession: SessionResponse = {
  tenant: { id: tenantId, slug: "pilot", display_name: "Pilot" },
  principal: {
    id: "principal_human",
    type: "human",
    display_name: "Human",
  },
  membership: { id: "membership_human", role: "owner" },
  identities: [
    {
      identity_id: "identity_human",
      kind: "human",
      display_name: "Human",
      scopes: ["conversation.read"],
    },
  ],
};

const memberSession: SessionResponse = {
  tenant: { id: tenantId, slug: "pilot", display_name: "Pilot" },
  principal: { id: "principal_agent", type: "agent", display_name: "Agent" },
  membership: { id: "membership_agent", role: "member" },
  identities: [
    {
      identity_id: "identity_agent",
      kind: "agent",
      display_name: "Agent",
      scopes: ["conversation.read"],
    },
  ],
};

type TestBindings = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const createRemovalApi = (authorization: SessionResponse) => {
  const app = new OpenAPIHono<TestBindings>();
  app.use("*", async (context, next) => {
    context.set("authorization", authorization);
    context.set("delegated", false);
    await next();
  });
  app.openapi(removalStatusRoute, removalStatusHandler);
  app.openapi(recordRemovalRoute, recordRemovalHandler);
  app.openapi(scheduleRemovalExpiryRoute, scheduleRemovalExpiryHandler);
  return app;
};

const apiRequest = async (
  authorization: SessionResponse,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  createRemovalApi(authorization).request(
    `https://communicator.example${path}`,
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

const createSharedApp = () =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        if (token === "agent-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        }
        throw new Error("invalid test token");
      },
    }),
    createOAuthAccessTokenVerifier: () => ({
      verify: async () => {
        throw new Error("not an OAuth installation token");
      },
    }),
  });

const sharedApiRequest = async (
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  app.request(
    `https://communicator.example${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

const countRows = async (
  table: "removal_authority" | "removal_expiry_schedule",
) =>
  (
    await workerEnv.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).first<{ count: number }>()
  )?.count ?? 0;

const recordInput = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: tenantId,
  resource_type: "message",
  resource_id: "message_mcp_admin",
  content_generation: "message_mcp_admin",
  account_id: "account_human",
  conversation_id: "conversation_mcp_admin",
  source_event_id: "event_mcp_admin_delete",
  source_object_key: null,
  reason: "requested",
  removed_at: fixedNow,
  ...overrides,
});

const scheduleInput = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: tenantId,
  resource_type: "message",
  resource_id: "message_mcp_expiry",
  content_generation: "message_mcp_expiry",
  account_id: "account_human",
  conversation_id: "conversation_mcp_expiry",
  source_event_id: "event_mcp_expiry",
  source_object_key: null,
  expires_at: "2026-09-15T01:00:00.000Z",
  ...overrides,
});

type TestMcp = {
  client: Client;
  close: () => Promise<void>;
};

const connectMcp = async (authorization: SessionResponse): Promise<TestMcp> => {
  const server = new McpServer({ name: "removal-test-server", version: "1" });
  const context: RemovalMcpContext = { env: workerEnv, authorization };
  registerRemovalMcpTools(server, context);
  const serverTransport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(serverTransport);

  const client = new Client({ name: "removal-test-client", version: "1" });
  const clientTransport = new StreamableHTTPClientTransport(
    new URL("https://communicator.example/mcp"),
    {
      requestInit: {
        headers: { Origin: "https://communicator.example" },
      },
      fetch: async (input, init) =>
        serverTransport.handleRequest(new Request(input, init)),
    },
  );
  await client.connect(
    clientTransport as unknown as Parameters<Client["connect"]>[0],
  );
  return {
    client,
    close: async () => {
      await client.close();
      await serverTransport.close();
      await server.close();
    },
  };
};

const connectSharedMcp = async (
  app: ReturnType<typeof createApp>,
  token: string,
): Promise<TestMcp> => {
  const client = new Client({
    name: "shared-removal-test-client",
    version: "1",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://communicator.example/mcp"),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://communicator.example",
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : input.toString();
        return app.request(url, init, workerEnv);
      },
    },
  );
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
};

const structured = (result: unknown): Record<string, unknown> => {
  const payload = result as { structuredContent?: Record<string, unknown> };
  return payload.structuredContent ?? {};
};

const text = (result: unknown): string => {
  const payload = result as { content?: Array<{ text?: string }> };
  return payload.content?.[0]?.text ?? "";
};

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
});

afterEach(async () => {
  await cleanupArchiveObjects(archiveBucket, tenantId);
});

const seedArchiveMessage = async (
  messageId: string,
  eventId: string,
  batchId: string,
): Promise<{ event: CanonicalEventEnvelope; dataKey: string }> => {
  const event = makeEvent({
    event_id: eventId,
    tenant_id: tenantId,
    account_id: "account_human",
    conversation_id: "conversation_mcp_admin",
    payload: { message_id: messageId, body: "archive status secret" },
  });
  const committed = await archiveCanonicalEventBatch({
    bucket: archiveBucket,
    tenantId,
    batchId,
    events: [event],
    archivedAt: fixedNow,
    producerVersion: "removal-mcp-test/1",
    sourceCheckpoint: null,
  });
  return { event, dataKey: committed.manifest.data_key };
};

describe("removal administrator API and MCP boundaries", () => {
  it("allows an administrator through the API and exposes status and expiry state", async () => {
    const record = await apiRequest(adminSession, "/api/v1/removals", {
      method: "POST",
      body: JSON.stringify(recordInput()),
    });
    expect(record.status).toBe(201);
    expect(await record.json()).toMatchObject({
      tenant_id: tenantId,
      resource_id: "message_mcp_admin",
      status: "active",
    });

    const status = await apiRequest(adminSession, "/api/v1/removals");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      tenant_id: tenantId,
      active_suppression: "enforced",
      physical_purge: "not_implemented",
      incomplete: [
        expect.objectContaining({ resource_id: "message_mcp_admin" }),
      ],
    });

    const schedule = await apiRequest(
      adminSession,
      "/api/v1/removal-expiries",
      { method: "POST", body: JSON.stringify(scheduleInput()) },
    );
    expect(schedule.status).toBe(201);
    expect(await schedule.json()).toMatchObject({
      tenant_id: tenantId,
      resource_id: "message_mcp_expiry",
      status: "scheduled",
    });
  });

  it("exposes completed archive purge through the registered REST and MCP status surfaces", async () => {
    await seedArchiveMessage(
      "message_rest_archive",
      "$rest-archive:server",
      "batch_rest_archive",
    );
    const record = await apiRequest(adminSession, "/api/v1/removals", {
      method: "POST",
      body: JSON.stringify(
        recordInput({
          resource_id: "message_rest_archive",
          content_generation: "message_rest_archive",
          conversation_id: "conversation_mcp_admin",
        }),
      ),
    });
    expect(record.status).toBe(201);
    const recordedAuthority = RemovalAuthoritySchema.parse(await record.json());

    const status = await apiRequest(adminSession, "/api/v1/removals");
    expect(await status.json()).toMatchObject({
      archive_purge: [
        expect.objectContaining({
          removal_id: expect.any(String),
          status: "pending_deletion",
        }),
      ],
    });
    await purgeRecordedRemoval(
      {
        database: workerEnv.CONTROL_DB,
        bucket: archiveBucket,
        safetyWindowMs: 0,
      },
      recordedAuthority,
      new Date("2026-09-16T00:00:00.000Z"),
    );
    const completedStatus = await apiRequest(adminSession, "/api/v1/removals");
    expect(await completedStatus.json()).toMatchObject({
      archive_purge: expect.arrayContaining([
        expect.objectContaining({
          removal_id: recordedAuthority.id,
          status: "complete",
        }),
      ]),
    });

    await seedArchiveMessage(
      "message_mcp_archive",
      "$mcp-archive:server",
      "batch_mcp_archive",
    );
    const mcp = await connectMcp(adminSession);
    try {
      const recordResult = await mcp.client.callTool({
        name: "record_removal",
        arguments: recordInput({
          resource_id: "message_mcp_archive",
          content_generation: "message_mcp_archive",
          conversation_id: "conversation_mcp_admin",
        }),
      });
      expect(recordResult.isError).not.toBe(true);
      const mcpAuthority = RemovalAuthoritySchema.parse(
        structured(recordResult),
      );
      await purgeRecordedRemoval(
        {
          database: workerEnv.CONTROL_DB,
          bucket: archiveBucket,
          safetyWindowMs: 0,
        },
        mcpAuthority,
        new Date("2026-09-16T00:00:00.000Z"),
      );
      const statusResult = await mcp.client.callTool({
        name: "get_removal_status",
        arguments: {},
      });
      expect(structured(statusResult)).toMatchObject({
        archive_purge: expect.arrayContaining([
          expect.objectContaining({
            removal_id: mcpAuthority.id,
            status: "complete",
          }),
        ]),
      });
    } finally {
      await mcp.close();
    }
  });

  it("shows incomplete archive work through REST and MCP while suppression stays active", async () => {
    const committed = await seedArchiveMessage(
      "message_archive_status_incomplete",
      "$archive-status-incomplete:server",
      "batch_archive_status_incomplete",
    );
    const delayedBucket = new Proxy(archiveBucket, {
      get(target, property, receiver) {
        if (property === "delete") {
          return async (key: string | string[]) => {
            if (key === committed.dataKey) return;
            return target.delete(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const authorityInput = RecordRemovalInputSchema.parse(
      recordInput({
        resource_id: "message_archive_status_incomplete",
        content_generation: "message_archive_status_incomplete",
        conversation_id: "conversation_mcp_admin",
      }),
    );
    await recordRemovalWithArchivePurge(
      {
        database: workerEnv.CONTROL_DB,
        bucket: delayedBucket,
        safetyWindowMs: 0,
      },
      authorityInput,
      new Date(fixedNow),
    );

    const restStatus = await apiRequest(adminSession, "/api/v1/removals");
    expect(await restStatus.json()).toMatchObject({
      archive_purge: [expect.objectContaining({ status: "incomplete" })],
      active_suppression: "enforced",
    });

    const mcp = await connectMcp(adminSession);
    try {
      const statusResult = await mcp.client.callTool({
        name: "get_removal_status",
        arguments: {},
      });
      expect(structured(statusResult)).toMatchObject({
        archive_purge: [expect.objectContaining({ status: "incomplete" })],
        active_suppression: "enforced",
      });
    } finally {
      await mcp.close();
    }
  });

  it("denies a nonadministrator before any API authority or expiry write", async () => {
    const beforeAuthorities = await countRows("removal_authority");
    const beforeSchedules = await countRows("removal_expiry_schedule");

    const status = await apiRequest(memberSession, "/api/v1/removals");
    expect(status.status).toBe(403);
    const record = await apiRequest(memberSession, "/api/v1/removals", {
      method: "POST",
      body: JSON.stringify(recordInput()),
    });
    expect(record.status).toBe(403);
    const schedule = await apiRequest(
      memberSession,
      "/api/v1/removal-expiries",
      { method: "POST", body: JSON.stringify(scheduleInput()) },
    );
    expect(schedule.status).toBe(403);

    await expect(countRows("removal_authority")).resolves.toBe(
      beforeAuthorities,
    );
    await expect(countRows("removal_expiry_schedule")).resolves.toBe(
      beforeSchedules,
    );
  });

  it("rejects cross-tenant API input before touching either durable table", async () => {
    const beforeAuthorities = await countRows("removal_authority");
    const beforeSchedules = await countRows("removal_expiry_schedule");

    const record = await apiRequest(adminSession, "/api/v1/removals", {
      method: "POST",
      body: JSON.stringify(recordInput({ tenant_id: otherTenantId })),
    });
    expect(record.status).toBe(403);
    const schedule = await apiRequest(
      adminSession,
      "/api/v1/removal-expiries",
      {
        method: "POST",
        body: JSON.stringify(scheduleInput({ tenant_id: otherTenantId })),
      },
    );
    expect(schedule.status).toBe(403);

    await expect(countRows("removal_authority")).resolves.toBe(
      beforeAuthorities,
    );
    await expect(countRows("removal_expiry_schedule")).resolves.toBe(
      beforeSchedules,
    );
  });

  it("registers the removal routes on the shared app authorization boundary", async () => {
    const app = createSharedApp();
    const unauthenticated = await app.request(
      "https://communicator.example/api/v1/removals",
      {},
      workerEnv,
    );
    expect(unauthenticated.status).toBe(401);

    const allowed = await sharedApiRequest(
      app,
      "human-token",
      "/api/v1/removals",
      {
        method: "POST",
        body: JSON.stringify(
          recordInput({ resource_id: "message_shared_api" }),
        ),
      },
    );
    expect(allowed.status).toBe(201);

    const status = await sharedApiRequest(
      app,
      "human-token",
      "/api/v1/removals",
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      tenant_id: tenantId,
      incomplete: [
        expect.objectContaining({ resource_id: "message_shared_api" }),
      ],
    });

    const beforeAuthorities = await countRows("removal_authority");
    const crossTenant = await sharedApiRequest(
      app,
      "human-token",
      "/api/v1/removals",
      {
        method: "POST",
        body: JSON.stringify(
          recordInput({
            tenant_id: otherTenantId,
            resource_id: "message_shared_cross_tenant",
          }),
        ),
      },
    );
    expect(crossTenant.status).toBe(403);
    await expect(countRows("removal_authority")).resolves.toBe(
      beforeAuthorities,
    );
  });

  it("registers all administrator MCP tools and drives the real authority services", async () => {
    const mcp = await connectMcp(adminSession);
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "get_removal_status",
          "record_removal",
          "schedule_removal_expiry",
        ]),
      );

      const record = await mcp.client.callTool({
        name: "record_removal",
        arguments: recordInput({
          resource_id: "message_mcp_allowed",
          content_generation: "message_mcp_allowed",
        }),
      });
      expect(record.isError).not.toBe(true);
      expect(structured(record)).toMatchObject({
        tenant_id: tenantId,
        resource_id: "message_mcp_allowed",
        status: "active",
      });

      const status = await mcp.client.callTool({
        name: "get_removal_status",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(structured(status)).toMatchObject({
        tenant_id: tenantId,
        active_suppression: "enforced",
        incomplete: [
          expect.objectContaining({ resource_id: "message_mcp_allowed" }),
        ],
      });

      const schedule = await mcp.client.callTool({
        name: "schedule_removal_expiry",
        arguments: scheduleInput({
          resource_id: "message_mcp_allowed_expiry",
          content_generation: "message_mcp_allowed_expiry",
        }),
      });
      expect(schedule.isError).not.toBe(true);
      expect(structured(schedule)).toMatchObject({
        tenant_id: tenantId,
        resource_id: "message_mcp_allowed_expiry",
        status: "scheduled",
      });
    } finally {
      await mcp.close();
    }
  });

  it("denies every MCP removal operation to a nonadministrator without writes", async () => {
    const beforeAuthorities = await countRows("removal_authority");
    const beforeSchedules = await countRows("removal_expiry_schedule");
    const mcp = await connectMcp(memberSession);
    try {
      const status = await mcp.client.callTool({
        name: "get_removal_status",
        arguments: {},
      });
      const record = await mcp.client.callTool({
        name: "record_removal",
        arguments: recordInput(),
      });
      const schedule = await mcp.client.callTool({
        name: "schedule_removal_expiry",
        arguments: scheduleInput(),
      });
      for (const result of [status, record, schedule]) {
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('"code":"forbidden"');
      }
    } finally {
      await mcp.close();
    }
    await expect(countRows("removal_authority")).resolves.toBe(
      beforeAuthorities,
    );
    await expect(countRows("removal_expiry_schedule")).resolves.toBe(
      beforeSchedules,
    );
  });

  it("rejects cross-tenant MCP writes before opening the authority services", async () => {
    const beforeAuthorities = await countRows("removal_authority");
    const beforeSchedules = await countRows("removal_expiry_schedule");
    const mcp = await connectMcp(adminSession);
    try {
      const record = await mcp.client.callTool({
        name: "record_removal",
        arguments: recordInput({ tenant_id: otherTenantId }),
      });
      const schedule = await mcp.client.callTool({
        name: "schedule_removal_expiry",
        arguments: scheduleInput({ tenant_id: otherTenantId }),
      });
      for (const result of [record, schedule]) {
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('"code":"forbidden"');
      }
    } finally {
      await mcp.close();
    }
    await expect(countRows("removal_authority")).resolves.toBe(
      beforeAuthorities,
    );
    await expect(countRows("removal_expiry_schedule")).resolves.toBe(
      beforeSchedules,
    );
  });

  it("registers removal tools through the shared MCP transport and keeps auth boundaries", async () => {
    const app = createSharedApp();
    const initializeRequest = {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "unauthorized-removal-test", version: "1" },
        },
      }),
    };
    const unauthenticated = await app.request(
      "https://communicator.example/mcp",
      initializeRequest,
      workerEnv,
    );
    expect(unauthenticated.status).toBe(401);

    const human = await connectSharedMcp(app, "human-token");
    try {
      const tools = await human.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "get_removal_status",
          "record_removal",
          "schedule_removal_expiry",
        ]),
      );
      const allowed = await human.client.callTool({
        name: "record_removal",
        arguments: recordInput({ resource_id: "message_shared_mcp" }),
      });
      expect(allowed.isError).not.toBe(true);

      const beforeAuthorities = await countRows("removal_authority");
      const crossTenant = await human.client.callTool({
        name: "record_removal",
        arguments: recordInput({
          tenant_id: otherTenantId,
          resource_id: "message_shared_mcp_cross_tenant",
        }),
      });
      expect(crossTenant.isError).toBe(true);
      expect(text(crossTenant)).toContain('"code":"forbidden"');
      await expect(countRows("removal_authority")).resolves.toBe(
        beforeAuthorities,
      );
    } finally {
      await human.close();
    }

    const agent = await connectSharedMcp(app, "agent-token");
    try {
      const beforeAuthorities = await countRows("removal_authority");
      const denied = await agent.client.callTool({
        name: "record_removal",
        arguments: recordInput({ resource_id: "message_shared_mcp_agent" }),
      });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain('"code":"forbidden"');
      await expect(countRows("removal_authority")).resolves.toBe(
        beforeAuthorities,
      );
    } finally {
      await agent.close();
    }
  });

  it("keeps the shared input schemas strict at the isolated boundary", () => {
    expect(
      RecordRemovalInputSchema.safeParse({ ...recordInput(), extra: true })
        .success,
    ).toBe(false);
    expect(
      ScheduleRemovalExpiryInputSchema.safeParse({
        ...scheduleInput(),
        extra: true,
      }).success,
    ).toBe(false);
  });
});
