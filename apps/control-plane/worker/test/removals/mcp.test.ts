import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { SessionResponse } from "@communicator/contracts";
import {
  RecordRemovalInputSchema,
  ScheduleRemovalExpiryInputSchema,
} from "../../../../../packages/contracts/src/removals";
import { beforeEach, describe, expect, it } from "vitest";
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

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
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
