import { Hono } from "hono";
import type { Context } from "hono";
import { MCPServer } from "mcp-use";
import { z } from "zod";
import {
  deniedToolCall,
  failedToolCall,
  GatewayOperations,
  isAgentPrincipal,
  isHumanPrincipal,
  type AgentPrincipal,
  type HumanPrincipal,
  type PlatformIdentityVerifier,
  type ProfileManagementAuthorizer,
  type ProfileGrantStore,
  type ServiceToolCatalog,
  type ServiceToolDeclaration,
} from "./access";
import type { ProfileGrantAdmin } from "./profile-store";
import {
  executeRestrictedProgram,
  RestrictedProgramError,
  serializeBoundedJson,
} from "./restricted-program";

export interface GatewayDependencies {
  readonly identityVerifier: PlatformIdentityVerifier;
  readonly profileGrantStore: ProfileGrantStore;
  readonly profileManagementAuthorizer: ProfileManagementAuthorizer;
  readonly serviceTools: readonly ServiceToolDeclaration[];
  readonly serviceToolCatalog?: ServiceToolCatalog;
}

interface ProtectedRequestScope {
  readonly principal: AgentPrincipal;
  readonly organizationId: string;
  readonly profileId: string;
  readonly verifyCurrentCredential: () => Promise<AgentPrincipal | null>;
}

const USE_TOOL_NAME = "use";
const USE_OPERATION_ID = "gateway.use";
const SEARCH_TOOL_NAME = "tools.search";
const MAX_DIRECT_CALL_MILLISECONDS = 5_000;
const MAX_DIRECT_OUTPUT_BYTES = 64 * 1024;

const useInputSchema = z.object({
  program: z
    .string()
    .min(1)
    .max(32 * 1024)
    .describe(
      "Restricted JavaScript subset. Discover with tools.search({query}), call a discovered operation directly, or use tools.call({name, arguments}) for an exact discovered name. Network, filesystem, globals, imports, loops, and dynamic code are unavailable.",
    ),
});

export function createGatewayApp(dependencies: GatewayDependencies) {
  const app = new Hono();
  const operations = new GatewayOperations(
    dependencies.serviceToolCatalog ?? dependencies.serviceTools,
    dependencies.profileGrantStore,
  );

  const publicMcp = new MCPServer({
    name: "0000-gateway",
    version: "0.0.0",
    basePath: "/mcp",
    logging: { enabled: false },
  });
  publicMcp.tool(
    {
      name: "gateway_info",
      description: "Return the Gateway service health status.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: "text", text: '{"status":"ok","service":"gateway"}' }],
    }),
  );

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "gateway" }, 200),
  );

  app.all("/mcp/profile/:profileId", async (context) => {
    if (!(await requestBodyWithinLimit(context.req.raw, 512 * 1024))) {
      return context.json({ error: "MCP request is too large." }, 413);
    }
    return handleProtectedMcp(
      context,
      operations,
      dependencies,
      undefined,
      context.req.param("profileId"),
    );
  });

  app.all("/mcp", async (context) => {
    if (!(await requestBodyWithinLimit(context.req.raw, 512 * 1024))) {
      return context.json({ error: "MCP request is too large." }, 413);
    }
    const credentialPresent =
      context.req.header("authorization") !== undefined ||
      context.req.header("cookie") !== undefined;
    if (!credentialPresent) return publicMcp.fetch(context.req.raw);
    let principal: AgentPrincipal | null;
    try {
      principal = await dependencies.identityVerifier.verifyAgentCredential(
        context.req.raw.clone(),
      );
    } catch {
      return context.json(
        { error: "Platform identity verification is unavailable." },
        503,
      );
    }
    if (!isAgentPrincipal(principal)) {
      return context.json(
        { error: "Verified agent credential required." },
        401,
      );
    }
    return dispatchProtectedMcp(
      context,
      operations,
      dependencies,
      principal,
      principal.organizationId,
      principal.profileId,
    );
  });
  app.all(
    "/mcp/organizations/:organizationId/profiles/:profileId",
    async (context) => {
      if (!(await requestBodyWithinLimit(context.req.raw, 512 * 1024))) {
        return context.json({ error: "MCP request is too large." }, 413);
      }
      return handleProtectedMcp(
        context,
        operations,
        dependencies,
        context.req.param("organizationId"),
        context.req.param("profileId"),
      );
    },
  );

  app.all("/internal/profiles/:organizationId/:profileId", async (context) => {
    if (context.req.method !== "POST") {
      return context.json({ error: "Method not allowed." }, 405);
    }
    const authorized = await authorizeProfileManagement(
      context.req.raw,
      dependencies,
      context.req.param("organizationId"),
      context.req.param("profileId"),
    );
    if (authorized instanceof Response) return authorized;
    const admin = profileAdmin(dependencies.profileGrantStore);
    if (!admin) return context.json({ error: "Gateway unavailable." }, 503);
    try {
      const created = await admin.createProfile(
        context.req.param("organizationId"),
        context.req.param("profileId"),
      );
      return context.json({ created }, 200);
    } catch {
      return context.json({ error: "Gateway profile operation failed." }, 400);
    }
  });
  app.all(
    "/internal/profiles/:organizationId/:profileId/grants",
    async (context) => {
      if (context.req.method !== "PUT") {
        return context.json({ error: "Method not allowed." }, 405);
      }
      const authorized = await authorizeProfileManagement(
        context.req.raw,
        dependencies,
        context.req.param("organizationId"),
        context.req.param("profileId"),
      );
      if (authorized instanceof Response) return authorized;
      const admin = profileAdmin(dependencies.profileGrantStore);
      if (!admin) return context.json({ error: "Gateway unavailable." }, 503);
      const body = await readJsonObject(context.req.raw, 16 * 1024);
      if (
        !body ||
        Object.keys(body).some((key) => key !== "operationIds") ||
        !Array.isArray(body.operationIds) ||
        body.operationIds.length > 128 ||
        body.operationIds.some(
          (id) => typeof id !== "string" || id.length === 0 || id.length > 128,
        )
      ) {
        return context.json(
          { error: "operationIds must be an array of strings." },
          400,
        );
      }
      try {
        await admin.setGrantedOperationIds(
          context.req.param("organizationId"),
          context.req.param("profileId"),
          body.operationIds,
        );
        return context.json({ updated: true }, 200);
      } catch {
        return context.json(
          { error: "Gateway profile operation failed." },
          400,
        );
      }
    },
  );
  app.all(
    "/internal/profiles/:organizationId/:profileId/grants/:operationId",
    async (context) => {
      if (context.req.method !== "DELETE") {
        return context.json({ error: "Method not allowed." }, 405);
      }
      const authorized = await authorizeProfileManagement(
        context.req.raw,
        dependencies,
        context.req.param("organizationId"),
        context.req.param("profileId"),
      );
      if (authorized instanceof Response) return authorized;
      const admin = profileAdmin(dependencies.profileGrantStore);
      if (!admin) return context.json({ error: "Gateway unavailable." }, 503);
      try {
        const revoked = await admin.revokeGrantedOperationId(
          context.req.param("organizationId"),
          context.req.param("profileId"),
          context.req.param("operationId"),
        );
        return context.json({ revoked }, 200);
      } catch {
        return context.json(
          { error: "Gateway profile operation failed." },
          400,
        );
      }
    },
  );

  app.mount("/", publicMcp.fetch);
  return app;
}

async function handleProtectedMcp(
  context: Context,
  operations: GatewayOperations,
  dependencies: GatewayDependencies,
  expectedOrganizationId: string | undefined,
  expectedProfileId: string,
): Promise<Response> {
  let principal: AgentPrincipal | null;
  try {
    principal = await dependencies.identityVerifier.verifyAgentCredential(
      context.req.raw.clone(),
    );
  } catch {
    return Response.json(
      { error: "Platform identity verification is unavailable." },
      { status: 503 },
    );
  }
  if (!isAgentPrincipal(principal)) {
    return Response.json(
      { error: "Verified agent credential required." },
      { status: 401 },
    );
  }
  const organizationId = expectedOrganizationId ?? principal.organizationId;
  if (
    principal.organizationId !== organizationId ||
    principal.profileId !== expectedProfileId
  ) {
    return Response.json(
      { error: "Credential profile binding mismatch." },
      { status: 403 },
    );
  }
  try {
    if (!(await operations.hasProfile(organizationId, expectedProfileId))) {
      return Response.json(
        { error: "Gateway profile not found." },
        { status: 404 },
      );
    }
  } catch {
    return Response.json(
      { error: "Gateway profile storage is unavailable." },
      { status: 503 },
    );
  }

  const protectedMcp = await createProtectedMcp(operations, {
    principal,
    organizationId,
    profileId: expectedProfileId,
    verifyCurrentCredential: () =>
      dependencies.identityVerifier.verifyAgentCredential(
        credentialOnlyRequest(context.req.raw),
      ),
  });
  const mcpRequest = new Request(
    new URL("/mcp", context.req.url),
    context.req.raw,
  );
  return protectedMcp.fetch(mcpRequest);
}

async function dispatchProtectedMcp(
  context: Context,
  operations: GatewayOperations,
  dependencies: GatewayDependencies,
  principal: AgentPrincipal,
  organizationId: string,
  profileId: string,
): Promise<Response> {
  try {
    if (!(await operations.hasProfile(organizationId, profileId))) {
      return Response.json(
        { error: "Gateway profile not found." },
        { status: 404 },
      );
    }
  } catch {
    return Response.json(
      { error: "Gateway profile storage is unavailable." },
      { status: 503 },
    );
  }
  const scope: ProtectedRequestScope = {
    principal,
    organizationId,
    profileId,
    verifyCurrentCredential: () =>
      dependencies.identityVerifier.verifyAgentCredential(
        credentialOnlyRequest(context.req.raw),
      ),
  };
  const protectedMcp = await createProtectedMcp(operations, scope);
  const mcpRequest = new Request(
    new URL("/mcp", context.req.url),
    context.req.raw,
  );
  return protectedMcp.fetch(mcpRequest);
}

async function createProtectedMcp(
  operations: GatewayOperations,
  scope: ProtectedRequestScope,
): Promise<MCPServer> {
  await operations.ensureCatalog();
  const server = new MCPServer({
    name: "0000-gateway",
    version: "0.0.0",
    basePath: "/mcp",
    logging: { enabled: false },
  });
  server.tool(
    {
      name: USE_TOOL_NAME,
      description:
        "Execute the restricted JavaScript subset. Discover with tools.search({query}), call a discovered operation directly, or use tools.call({name, arguments}) for an exact discovered name. Network, filesystem, globals, imports, loops, and dynamic code are unavailable; every host call is authorized again.",
      inputSchema: useInputSchema,
    },
    async ({ program }) => {
      try {
        const execution = await executeRestrictedProgram(program, {
          invoke: async (call, signal) => {
            const current = await currentPrincipal(scope);
            if (!current)
              return deniedToolCall("Credential is no longer valid.");
            if (call.name === "search") {
              return searchResult(
                await operations.searchForAgent(
                  current,
                  scope.organizationId,
                  scope.profileId,
                  typeof call.input.query === "string" ? call.input.query : "",
                ),
              );
            }
            if (call.name === "call") {
              const requestedName = call.input.name;
              const requestedInput = call.input.arguments;
              if (
                typeof requestedName !== "string" ||
                !isRecord(requestedInput)
              ) {
                return deniedToolCall("Invalid tools.call input.");
              }
              return operations.invokeForAgent(
                current,
                scope.organizationId,
                scope.profileId,
                requestedName,
                requestedInput,
                { operationId: USE_OPERATION_ID, signal },
              );
            }
            return operations.invokeForAgent(
              current,
              scope.organizationId,
              scope.profileId,
              call.name,
              call.input,
              { operationId: USE_OPERATION_ID, signal },
            );
          },
        });
        if (execution.directToolResult) return execution.directToolResult;
        const structuredContent = {
          calls: execution.calls,
          result: execution.result,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: serializeBoundedJson(
                structuredContent,
                MAX_DIRECT_OUTPUT_BYTES,
              ),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        const message =
          error instanceof RestrictedProgramError
            ? error.message
            : "Program execution failed.";
        return failedToolCall(message);
      }
    },
  );
  server.tool(
    {
      name: SEARCH_TOOL_NAME,
      description:
        "Search the active profile's deterministic Gateway tool catalog.",
      inputSchema: z.object({ query: z.string().max(200).default("") }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const current = await currentPrincipal(scope);
      if (!current) return deniedToolCall("Credential is no longer valid.");
      return searchResult(
        await operations.searchForAgent(
          current,
          scope.organizationId,
          scope.profileId,
          query,
        ),
      );
    },
  );
  for (const declaration of operations.catalog()) {
    server.tool(
      {
        name: declaration.name,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
      },
      async (input) => {
        const current = await currentPrincipal(scope);
        if (!current) return deniedToolCall("Credential is no longer valid.");
        return invokeDirectBounded(
          operations,
          current,
          scope.organizationId,
          scope.profileId,
          declaration,
          input,
        );
      },
    );
  }
  server.use("mcp:tools/list", async (_context, next) => {
    const current = await currentPrincipal(scope);
    if (!current) return [];
    const [listed, granted] = await Promise.all([
      next(),
      operations.discoverForAgent(
        current,
        scope.organizationId,
        scope.profileId,
      ),
    ]);
    const names = new Set([
      USE_TOOL_NAME,
      SEARCH_TOOL_NAME,
      ...granted.map((tool) => tool.name),
    ]);
    return listed.filter((tool) => names.has(tool.name));
  });
  return server;
}

async function currentPrincipal(
  scope: ProtectedRequestScope,
): Promise<AgentPrincipal | null> {
  try {
    const principal = await scope.verifyCurrentCredential();
    if (
      !isAgentPrincipal(principal) ||
      principal.organizationId !== scope.organizationId ||
      principal.profileId !== scope.profileId
    ) {
      return null;
    }
    return principal;
  } catch {
    return null;
  }
}

function searchResult(
  tools: readonly { operationId: string; name: string; description: string }[],
) {
  const structuredContent = { tools };
  return {
    content: [
      {
        type: "text" as const,
        text: serializeBoundedJson(structuredContent, 64 * 1024),
      },
    ],
    structuredContent,
  };
}

async function invokeDirectBounded(
  operations: GatewayOperations,
  principal: AgentPrincipal,
  organizationId: string,
  profileId: string,
  declaration: ServiceToolDeclaration,
  input: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MAX_DIRECT_CALL_MILLISECONDS,
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operations.invokeForAgent(
        principal,
        organizationId,
        profileId,
        declaration.name,
        input,
        { operationId: declaration.operationId, signal: controller.signal },
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("direct call timeout")),
          MAX_DIRECT_CALL_MILLISECONDS,
        );
      }),
    ]);
    serializeBoundedJson(result, MAX_DIRECT_OUTPUT_BYTES);
    return result;
  } catch {
    return failedToolCall("Tool execution failed.");
  } finally {
    clearTimeout(timeout);
    if (deadline !== undefined) clearTimeout(deadline);
    controller.abort();
  }
}

function credentialOnlyRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(request.url, { method: "GET", headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function authorizeProfileManagement(
  request: Request,
  dependencies: GatewayDependencies,
  organizationId: string,
  profileId: string,
): Promise<Response | HumanPrincipal> {
  let principal: HumanPrincipal | null;
  try {
    principal = await dependencies.identityVerifier.verifyHumanSession(
      request.clone(),
    );
  } catch {
    return Response.json(
      { error: "Platform identity verification is unavailable." },
      { status: 503 },
    );
  }
  if (!isHumanPrincipal(principal)) {
    return Response.json(
      { error: "Verified human session required." },
      { status: 401 },
    );
  }
  if (principal.organizationId !== organizationId) {
    return Response.json(
      { error: "Organization access denied." },
      { status: 403 },
    );
  }
  try {
    if (
      (await dependencies.profileManagementAuthorizer.canManageProfile(
        principal,
        organizationId,
        profileId,
        request.clone(),
      )) !== true
    ) {
      return Response.json(
        { error: "Profile management access denied." },
        { status: 403 },
      );
    }
  } catch {
    return Response.json(
      { error: "Profile management is unavailable." },
      { status: 503 },
    );
  }
  return principal;
}

function profileAdmin(store: ProfileGrantStore): ProfileGrantAdmin | null {
  if (
    typeof (store as Partial<ProfileGrantAdmin>).createProfile !== "function" ||
    typeof (store as Partial<ProfileGrantAdmin>).setGrantedOperationIds !==
      "function" ||
    typeof (store as Partial<ProfileGrantAdmin>).revokeGrantedOperationId !==
      "function"
  )
    return null;
  return store as ProfileGrantAdmin;
}

async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  try {
    const body = request.body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) return null;
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function requestBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) return false;
  if (!request.body) return true;
  const reader = request.clone().body?.getReader();
  if (!reader) return true;
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return true;
      total += next.value.byteLength;
      if (total > maxBytes) return false;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const unavailableDependencies: GatewayDependencies = {
  identityVerifier: {
    verifyAgentCredential: async () => null,
    verifyHumanSession: async () => null,
  },
  profileGrantStore: {
    getGrantedOperationIds: async () => null,
  },
  profileManagementAuthorizer: {
    canManageProfile: async () => false,
  },
  serviceTools: [],
};

export const app = createGatewayApp(unavailableDependencies);
export default app;
