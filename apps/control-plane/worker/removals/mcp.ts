import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionResponse } from "@communicator/contracts";
import {
  RecordRemovalInputSchema,
  ScheduleRemovalExpiryInputSchema,
} from "../../../../packages/contracts/src/removals";
import { isAdministratorSession } from "../read/authorization";
import {
  recordRemovalWithSuppression,
  removalStatusForTenant,
} from "./service";
import { scheduleRemovalExpiry } from "./ledger";

/** The authenticated context passed from the shared MCP transport. */
export type RemovalMcpContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
};

const FORBIDDEN_MESSAGE = "Administrator permission required";
const UNAVAILABLE_MESSAGE = "Removal authority unavailable";

const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: (value ?? {}) as Record<string, unknown>,
});

const errorResult = (code: "forbidden" | "service_unavailable") => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code,
          message:
            code === "forbidden" ? FORBIDDEN_MESSAGE : UNAVAILABLE_MESSAGE,
        },
      }),
    },
  ],
});

const databaseFor = (context: RemovalMcpContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new Error("removal authority unavailable");
  }
  return database;
};

const requireAdministrator = (
  context: RemovalMcpContext,
  tenantId?: string,
): void => {
  if (!isAdministratorSession(context.authorization)) {
    throw new RemovalMcpAuthorizationError();
  }
  if (tenantId !== undefined && tenantId !== context.authorization.tenant.id) {
    throw new RemovalMcpAuthorizationError();
  }
};

class RemovalMcpAuthorizationError extends Error {
  constructor() {
    super(FORBIDDEN_MESSAGE);
    this.name = "RemovalMcpAuthorizationError";
  }
}

const withRemovalErrors = async (operation: () => Promise<unknown>) => {
  try {
    return toolResult(await operation());
  } catch (error) {
    if (error instanceof RemovalMcpAuthorizationError) {
      return errorResult("forbidden");
    }
    console.error({
      event: "removal_authority_mcp_error",
      error: error instanceof Error ? error.name : "unknown",
    });
    return errorResult("service_unavailable");
  }
};

/**
 * Register the removal administration tools on the shared MCP server.
 *
 * The shared transport owns authentication and supplies the resolved session;
 * every tool still checks administrator role and tenant scope before opening
 * the durable authority binding. This function is deliberately independent
 * of mcp.ts so its registration can be composed once the shared owner lands
 * the thin import and call.
 */
export const registerRemovalMcpTools = (
  server: McpServer,
  context: RemovalMcpContext,
): void => {
  server.registerTool(
    "get_removal_status",
    {
      description:
        "Inspect active removal authority and incomplete suppression work",
    },
    () =>
      withRemovalErrors(async () => {
        requireAdministrator(context);
        return removalStatusForTenant(
          databaseFor(context),
          context.authorization.tenant.id,
        );
      }),
  );

  server.registerTool(
    "record_removal",
    {
      description:
        "Record administrator-authorized removal before active suppression",
      inputSchema: RecordRemovalInputSchema.shape,
    },
    (input) =>
      withRemovalErrors(async () => {
        const parsed = RecordRemovalInputSchema.parse(input);
        requireAdministrator(context, parsed.tenant_id);
        return recordRemovalWithSuppression(databaseFor(context), parsed);
      }),
  );

  server.registerTool(
    "schedule_removal_expiry",
    {
      description: "Schedule durable removal suppression at an expiry time",
      inputSchema: ScheduleRemovalExpiryInputSchema.shape,
    },
    (input) =>
      withRemovalErrors(async () => {
        const parsed = ScheduleRemovalExpiryInputSchema.parse(input);
        requireAdministrator(context, parsed.tenant_id);
        return scheduleRemovalExpiry(databaseFor(context), parsed);
      }),
  );
};
