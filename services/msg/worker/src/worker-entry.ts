export { ConversationRoom } from "./conversation-room";
import { D1OperationStore, type D1DatabaseLike } from "./operations";
import { DurableRoomService, type RoomNamespace } from "./room-service";
import { createMsgAuthenticator, parseOperatorAllowlist, unavailableMsgAuthenticator, type MsgAuthenticator, type MsgRoomAuthPort } from "./auth";
import { createWorker, type MsgEnvironment, type MsgRateLimit } from "./worker";
import { McpAuthService, McpAuthError, type McpThreadCapability } from "./mcp-auth";
import { D1McpAuthStore } from "./mcp-auth-store";
import type { McpAuthenticator } from "./mcp-events-handler";
import type { RoomService } from "./protocol";
import { createMcpWebhookDispatcherClient } from "./mcp-webhook-dispatcher-client";

export interface MsgProductionEnvironment extends MsgEnvironment {
  readonly MSG_TEST_MODE?: string;
  readonly MSG_CREATE_DISABLED?: string;
  readonly MSG_DATA_ENCRYPTION_KEY_V1?: string;
  readonly MSG_DB?: D1DatabaseLike;
  readonly MSG_PLATFORM_BASE_URL?: string;
  readonly MSG_PLATFORM_AUTHORITY?: string;
  readonly MSG_PLATFORM_AUDIENCE?: string;
  readonly MSG_PLATFORM_SERVICE_VERIFIER?: string;
  readonly MSG_PLATFORM_GUEST_GRANT_ISSUER?: string;
  readonly MSG_OPERATOR_ALLOWLIST?: string;
  readonly MSG_POST_DISABLED?: string;
  readonly MSG_PUBLIC_ORIGIN?: string;
  readonly MSG_MCP_WEBHOOK_DISPATCH_URL?: string;
  readonly MSG_MCP_WEBHOOK_DISPATCH_TOKEN?: string;
  readonly MSG_OPERATOR_TOKEN?: string;
  readonly MSG_RATE_LIMIT_CREATION?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_READS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_POSTS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_LIVE?: MsgRateLimit;
  readonly MSG_VAPID_PUBLIC_KEY?: string;
  readonly MSG_VAPID_PRIVATE_KEY?: string;
  readonly MSG_VAPID_SUBJECT?: string;
}

/**
 * Adapt the OAuth service's principal and per-Thread grants to the MCP
 * request boundary. The DO stores the principal and grant identifiers with
 * each subscription; grant checks remain server-side for every operation.
 */
export function createMcpAuthenticator(auth: McpAuthService, origin: string, roomService?: RoomService): McpAuthenticator {
  return {
    async authenticate(request) {
      let principal;
      try {
        principal = await auth.authenticateBearer(request);
      } catch (error) {
        if (error instanceof McpAuthError) return null;
        throw error;
      }
      return {
        grantId: principal.principalId,
        principalId: principal.principalId,
        scopes: principal.scopes,
        authorize: async (room: string, capability: McpThreadCapability) => {
          if (room === "*") return principal.scopes.includes("threads:monitor");
          let grant;
          try {
            grant = await auth.validateGrant(principal.principalId, `${origin}/${room}`, capability);
          } catch {
            return false;
          }
          if (!grant) return false;
          if (roomService?.roomStatus) {
            try {
              const status = await roomService.roomStatus({ room });
              if (!status.active || (status.public_grants_allowed === false && grant.source !== "explicit")) return false;
            } catch {
              return false;
            }
          }
          return true;
        },
      };
    },
  };
}

async function routeMcpAuthorization(request: Request, auth: McpAuthService, roomService: RoomService, rateLimit?: MsgRateLimit): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") return mcpAuthJson(auth.protectedResourceMetadata());
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return mcpAuthJson(auth.authorizationServerMetadata());
  if (["/register", "/authorize", "/token", "/revoke"].includes(url.pathname) && rateLimit) {
    const actor = request.headers.get("cf-connecting-ip");
    const key = actor !== null && /^(?:[0-9a-f:.]+)$/iu.test(actor) ? actor : "unknown";
    try {
      if (!(await rateLimit.limit({ key })).success) return mcpAuthJson({ error: "rate_limited" }, 429);
    } catch {
      return mcpAuthJson({ error: "rate_limited" }, 429);
    }
  }
  try {
    if (url.pathname === "/register") return await auth.registerClient(request);
    if (url.pathname === "/authorize") return await auth.authorize(request, {
      validateThread: async (threadUrl) => {
        try {
          const thread = new URL(threadUrl);
          if (thread.origin !== url.origin || !/^\/[^/]+$/u.test(thread.pathname) || !roomService.roomStatus) return null;
          const status = await roomService.roomStatus({ room: thread.pathname.slice(1) });
          return status.active && status.public_grants_allowed !== false ? { canonicalUrl: `${thread.origin}${thread.pathname}` } : null;
        } catch { return null; }
      },
    });
    if (url.pathname === "/token") return await auth.token(request);
    if (url.pathname === "/revoke") return await auth.revoke(request);
  } catch (error) {
    if (error instanceof McpAuthError) return mcpAuthJson({ error: error.code, error_description: error.message }, error.status);
    return mcpAuthJson({ error: "server_error" }, 500);
  }
  return undefined;
}

function mcpAuthJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

const unavailableRateLimit: MsgRateLimit = {
  async limit() {
    throw new Error("The required msg rate-limit binding is unavailable.");
  },
};

export default {
  fetch(request: Request, env: MsgProductionEnvironment): Promise<Response> {
    const publicOrigin = env.MSG_PUBLIC_ORIGIN ?? new URL(request.url).origin;
    const rateLimits = {
      creation: env.MSG_RATE_LIMIT_CREATION ?? unavailableRateLimit,
      live: env.MSG_RATE_LIMIT_LIVE ?? unavailableRateLimit,
      posts: env.MSG_RATE_LIMIT_POSTS ?? unavailableRateLimit,
      reads: env.MSG_RATE_LIMIT_READS ?? unavailableRateLimit,
    };
    const roomService = env.ROOM_SERVICE ?? (env.ConversationRoom ? new DurableRoomService(env.ConversationRoom as RoomNamespace, publicOrigin) : undefined);
    if (!roomService) return createWorker(
      { async create() { throw new Error("The room service is not available."); } },
      { assets: env.ASSETS, publicOrigin, rateLimits },
    ).fetch(request);
    const accessPort = roomService && roomService.proveLink && roomService.recordGrant && roomService.checkGrant && roomService.findGrant ? roomService as unknown as MsgRoomAuthPort : undefined;
    const platformAuth = env.MSG_TEST_MODE === "1"
      ? undefined
      : accessPort && env.MSG_PLATFORM_BASE_URL && env.MSG_PLATFORM_AUTHORITY && env.MSG_PLATFORM_AUDIENCE && env.MSG_PLATFORM_SERVICE_VERIFIER && env.MSG_PLATFORM_GUEST_GRANT_ISSUER
      ? createMsgAuthenticator({
        baseUrl: env.MSG_PLATFORM_BASE_URL,
        authority: env.MSG_PLATFORM_AUTHORITY,
        audience: env.MSG_PLATFORM_AUDIENCE,
        serviceVerifier: env.MSG_PLATFORM_SERVICE_VERIFIER,
        guestGrantIssuer: env.MSG_PLATFORM_GUEST_GRANT_ISSUER,
        operatorAllowlist: parseOperatorAllowlist(env.MSG_OPERATOR_ALLOWLIST),
      }, accessPort)
      : unavailableMsgAuthenticator();
    const mcpAuth = env.MSG_DB
      ? new McpAuthService({ issuer: publicOrigin, resource: `${publicOrigin}/mcp`, store: new D1McpAuthStore(env.MSG_DB) })
      : undefined;
    if (mcpAuth && roomService) {
      return routeMcpAuthorization(request, mcpAuth, roomService, env.MSG_RATE_LIMIT_READS).then((response) => {
        if (response) return response;
        return routeMsgRequest(request, env, publicOrigin, roomService, mcpAuth, platformAuth);
      });
    }
    return routeMsgRequest(request, env, publicOrigin, roomService, mcpAuth, platformAuth);
  },
  scheduled(_event: ScheduledEvent, env: MsgProductionEnvironment, ctx: ExecutionContext): void {
    if (!env.MSG_DB || !env.MSG_DATA_ENCRYPTION_KEY_V1) return;
    const operations = new D1OperationStore(env.MSG_DB, env.MSG_DATA_ENCRYPTION_KEY_V1);
    ctx.waitUntil((async () => {
      for (let batch = 0; batch < 10; batch += 1) {
        if (await operations.purgeExpired() === 0) return;
      }
    })());
  },
};

function routeMsgRequest(
  request: Request,
  env: MsgProductionEnvironment,
  publicOrigin: string,
  providedRoomService?: DurableRoomService | RoomService,
  providedAuth?: McpAuthService,
  providedPlatformAuth?: MsgAuthenticator,
): Promise<Response> {
  const roomService = providedRoomService ?? env.ROOM_SERVICE ?? (env.ConversationRoom ? new DurableRoomService(env.ConversationRoom as RoomNamespace, publicOrigin) : undefined);
  if (!roomService) return createWorker(
      { async create() { throw new Error("The room service is not available."); } },
      { assets: env.ASSETS, publicOrigin, rateLimits: {
        creation: env.MSG_RATE_LIMIT_CREATION ?? unavailableRateLimit,
        live: env.MSG_RATE_LIMIT_LIVE ?? unavailableRateLimit,
        posts: env.MSG_RATE_LIMIT_POSTS ?? unavailableRateLimit,
        reads: env.MSG_RATE_LIMIT_READS ?? unavailableRateLimit,
      } },
    ).fetch(request);
  const operations = env.MSG_DB && env.MSG_DATA_ENCRYPTION_KEY_V1
      ? new D1OperationStore(env.MSG_DB, env.MSG_DATA_ENCRYPTION_KEY_V1)
      : undefined;
  const pushConfigured = Boolean(env.MSG_VAPID_PUBLIC_KEY && env.MSG_VAPID_PRIVATE_KEY && env.MSG_VAPID_SUBJECT);
  const mcpAuth = providedAuth ?? (env.MSG_DB
      ? new McpAuthService({ issuer: publicOrigin, resource: `${publicOrigin}/mcp`, store: new D1McpAuthStore(env.MSG_DB) })
      : undefined);
  const mcpCallbackFetch = createDispatcherFetch(env);
  const rateLimits = {
    creation: env.MSG_RATE_LIMIT_CREATION ?? unavailableRateLimit,
    live: env.MSG_RATE_LIMIT_LIVE ?? unavailableRateLimit,
    posts: env.MSG_RATE_LIMIT_POSTS ?? unavailableRateLimit,
    reads: env.MSG_RATE_LIMIT_READS ?? unavailableRateLimit,
  };
  return createWorker(roomService, {
      assets: env.ASSETS,
      auth: providedPlatformAuth,
      createDisabled: env.MSG_CREATE_DISABLED === "1",
      operations,
      mcpAuth: mcpAuth ? createMcpAuthenticator(mcpAuth, publicOrigin, roomService) : undefined,
      mcpCallbackFetch,
      mcpOrigin: publicOrigin,
      mcpRateLimit: env.MSG_RATE_LIMIT_READS,
      operatorToken: env.MSG_OPERATOR_TOKEN,
      postDisabled: env.MSG_POST_DISABLED === "1",
      pushConfigured,
      pushVapidPublicKey: pushConfigured ? env.MSG_VAPID_PUBLIC_KEY : undefined,
      rateLimits,
  }).fetch(request);
}

function createDispatcherFetch(env: MsgProductionEnvironment): typeof fetch | undefined {
  if (!env.MSG_MCP_WEBHOOK_DISPATCH_URL || !env.MSG_MCP_WEBHOOK_DISPATCH_TOKEN) return undefined;
  try {
    return createMcpWebhookDispatcherClient({ endpoint: env.MSG_MCP_WEBHOOK_DISPATCH_URL, token: env.MSG_MCP_WEBHOOK_DISPATCH_TOKEN });
  } catch { return undefined; }
}
