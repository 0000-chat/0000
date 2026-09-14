import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  ConnectionDisconnectRequestSchema,
  ConnectionLifecycleOperationSchema,
  ConnectionRelinkStartSchema,
  CommunicatorIdSchema,
  LinkSessionActionRequestSchema,
  LinkSessionSchema,
  LinkSessionStartSchema,
  type LinkSession,
  type LinkSessionActionRequest,
  type LinkSessionStart,
  type ConnectionRelinkStart,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  ConnectionGatewayError,
  gatewayFromEnv,
  type ConnectionGateway,
  type GatewayOwner,
  type GatewayPollResult,
} from "./gateway-client";
import {
  LINK_SESSION_TTL_MS,
  type LinkSessionOwner,
  type LinkSessionState,
} from "./session";
import { LinkingRepositoryError } from "./repository";
import {
  beginConnectionDisconnect,
  beginConnectionRelink,
  completeConnectionDisconnect,
  getLifecycleConnection,
  getLifecycleOperation,
  LifecycleRepositoryError,
  markLifecycleProviderPending,
  markLifecycleReconciliation,
} from "./lifecycle-repository";

type LinkingRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

type LinkingHandler = Handler<LinkingRouteEnv, string, any>;

type LinkingBindings = Cloudflare.Env & {
  LINK_SESSIONS: DurableObjectNamespace;
};

export type LinkingServices = {
  createConnectionGateway?: (env: Cloudflare.Env) => ConnectionGateway;
  now?: () => Date;
};

const boundedId = CommunicatorIdSchema.max(128);
const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };

export const linkSessionStartRoute = createRoute({
  method: "post",
  path: "/api/v1/identities/{identity_id}/link-sessions",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ identity_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
    body: {
      content: { "application/json": { schema: LinkSessionStartSchema } },
    },
  },
  responses: {
    200: {
      description: "Existing link session",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    201: {
      description: "Started link session",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    400: { description: "Invalid link request", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    409: { description: "Link session conflict", content: errorContent },
    503: { description: "Link provider unavailable", content: errorContent },
  },
});

export const linkSessionGetRoute = createRoute({
  method: "get",
  path: "/api/v1/link-sessions/{link_session_id}",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ link_session_id: boundedId }).strict() },
  responses: {
    200: {
      description: "Link session status",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    403: { description: "Link session owner required", content: errorContent },
    404: { description: "Link session not found", content: errorContent },
  },
});

export const linkSessionActionRoute = createRoute({
  method: "post",
  path: "/api/v1/link-sessions/{link_session_id}/actions",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ link_session_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
    body: {
      content: {
        "application/json": { schema: LinkSessionActionRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Link session action result",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    400: { description: "Invalid link action", content: errorContent },
    403: { description: "Link session owner required", content: errorContent },
    404: { description: "Link session not found", content: errorContent },
    409: { description: "Link session conflict", content: errorContent },
    503: { description: "Link provider unavailable", content: errorContent },
  },
});

export const linkSessionCancelRoute = createRoute({
  method: "delete",
  path: "/api/v1/link-sessions/{link_session_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ link_session_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
  },
  responses: {
    200: {
      description: "Cancelled link session",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    403: { description: "Link session owner required", content: errorContent },
    404: { description: "Link session not found", content: errorContent },
    409: { description: "Link session conflict", content: errorContent },
  },
});

export const connectionRelinkSessionStartRoute = createRoute({
  method: "post",
  path: "/api/v1/connections/{connection_id}/relink-sessions",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ connection_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
    body: {
      content: { "application/json": { schema: ConnectionRelinkStartSchema } },
    },
  },
  responses: {
    200: {
      description: "Existing relink session",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    201: {
      description: "Started relink session",
      content: { "application/json": { schema: LinkSessionSchema } },
    },
    400: { description: "Invalid relink request", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    404: { description: "Connection not found", content: errorContent },
    409: { description: "Relink conflict", content: errorContent },
    503: { description: "Link provider unavailable", content: errorContent },
  },
});

export const connectionDisconnectRoute = createRoute({
  method: "post",
  path: "/api/v1/connections/{connection_id}/disconnect",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ connection_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
    body: {
      content: {
        "application/json": { schema: ConnectionDisconnectRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Disconnect operation",
      content: {
        "application/json": { schema: ConnectionLifecycleOperationSchema },
      },
    },
    400: { description: "Invalid disconnect request", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    404: { description: "Connection not found", content: errorContent },
    409: { description: "Disconnect conflict", content: errorContent },
    503: {
      description: "Disconnect reconciliation required",
      content: errorContent,
    },
  },
});

export const connectionLifecycleOperationRoute = createRoute({
  method: "get",
  path: "/api/v1/connections/{connection_id}/lifecycle-operations/{operation_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z
      .object({ connection_id: boundedId, operation_id: boundedId })
      .strict(),
  },
  responses: {
    200: {
      description: "Connection lifecycle operation",
      content: {
        "application/json": { schema: ConnectionLifecycleOperationSchema },
      },
    },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    404: { description: "Operation not found", content: errorContent },
  },
});

class LinkingRouteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code:
      | "invalid_request"
      | "forbidden"
      | "not_found"
      | "service_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LinkingRouteError";
  }
}

const errorResponse = (
  context: Context<LinkingRouteEnv>,
  error: unknown,
): Response => {
  if (error instanceof LinkingRouteError) {
    return context.json(
      ApiErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
      error.status,
    );
  }
  if (error instanceof ConnectionGatewayError) {
    const status = error.code === "provider_error" ? 409 : 503;
    return context.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: status === 409 ? "invalid_request" : "service_unavailable",
          message:
            error.code === "provisioning_disabled"
              ? "Link provider provisioning is disabled"
              : error.code === "provider_error"
                ? "Link provider rejected the request"
                : "Link provider is unavailable",
        },
      }),
      status,
    );
  }
  if (error instanceof LinkingRepositoryError) {
    if (error.code === "duplicate_provider_identity") {
      return context.json(
        ApiErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Provider account requires relinking",
          },
        }),
        409,
      );
    }
    return context.json(
      ApiErrorResponseSchema.parse({
        error: {
          code:
            error.code === "invalid_link"
              ? "invalid_request"
              : "service_unavailable",
          message: error.message,
        },
      }),
      error.code === "invalid_link" ? 400 : 503,
    );
  }
  if (error instanceof LifecycleRepositoryError) {
    const status =
      error.code === "authorization_required"
        ? 403
        : error.code === "connection_not_found"
          ? 404
          : error.code === "stale_generation" ||
              error.code === "operation_conflict" ||
              error.code === "provider_identity_mismatch"
            ? 409
            : 503;
    return context.json(
      ApiErrorResponseSchema.parse({
        error: {
          code:
            status === 403
              ? "forbidden"
              : status === 404
                ? "not_found"
                : status === 409
                  ? "invalid_request"
                  : "service_unavailable",
          message: error.message,
        },
      }),
      status,
    );
  }
  return context.json(
    ApiErrorResponseSchema.parse({
      error: {
        code: "service_unavailable",
        message: "Link service unavailable",
      },
    }),
    503,
  );
};

const asBindings = (env: Cloudflare.Env): LinkingBindings =>
  env as LinkingBindings;

const sessionStub = (env: Cloudflare.Env, sessionId: string) => {
  const namespace = asBindings(env).LINK_SESSIONS;
  if (!namespace || typeof namespace.idFromName !== "function")
    throw new LinkingRouteError(
      503,
      "service_unavailable",
      "Link session service unavailable",
    );
  return namespace.get(namespace.idFromName(sessionId));
};

type SessionCommandResponse = {
  state: LinkSessionState;
  previous_gateway_ref?: string | null;
  created: boolean;
  commit_error?:
    | "authorization_required"
    | "invalid_link"
    | "duplicate_provider_identity"
    | "link_conflict"
    | "link_unavailable";
};

async function command(
  env: Cloudflare.Env,
  sessionId: string,
  payload: unknown,
): Promise<SessionCommandResponse> {
  const response = await sessionStub(env, sessionId).fetch(
    "https://link-session.internal/command",
    { method: "POST", body: JSON.stringify(payload) },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LinkingRouteError(
      503,
      "service_unavailable",
      "Link session service unavailable",
    );
  }
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "invalid";
    if (code === "not_found")
      throw new LinkingRouteError(404, "not_found", "Link session not found");
    if (code === "stale_session")
      throw new LinkingRouteError(
        409,
        "invalid_request",
        "Link session is stale",
      );
    if (code === "terminal_session")
      throw new LinkingRouteError(
        409,
        "invalid_request",
        "Link session is already complete",
      );
    throw new LinkingRouteError(
      503,
      "service_unavailable",
      "Link session service unavailable",
    );
  }
  return body as SessionCommandResponse;
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const ownerFor = (state: LinkSessionState): LinkSessionOwner => ({
  tenant_id: state.tenant_id,
  actor_principal_id: state.actor_principal_id,
  membership_id: state.membership_id,
  target_identity_id: state.target_identity_id,
  provider: state.provider,
});

const gatewayOwnerFor = (state: LinkSessionState): GatewayOwner => ({
  session_id: state.id,
  tenant_id: state.tenant_id,
  actor_principal_id: state.actor_principal_id,
  membership_id: state.membership_id,
  target_identity_id: state.target_identity_id,
  provider: state.provider,
  generation: state.generation,
  ...(state.connection_id && state.lifecycle_operation_id
    ? { connection_id: state.connection_id }
    : {}),
  ...(state.provider_login_id
    ? { provider_login_id: state.provider_login_id }
    : {}),
});

const publicSession = (
  state: LinkSessionState,
  qr: string | null = null,
): LinkSession =>
  LinkSessionSchema.parse({
    id: state.id,
    identity_id: state.target_identity_id,
    provider: state.provider,
    generation: state.generation,
    status: state.status,
    action: state.action,
    expires_at: state.expires_at,
    action_expires_at: state.action_expires_at,
    qr,
    connection_id: state.connection_id,
    account_id: state.account_id,
    provider_label: state.provider_label,
    error_code: state.error_code,
  });

const requireLinkAdministrator = (
  context: Context<LinkingRouteEnv>,
  identityId: string,
): void => {
  const authorization = context.get("authorization");
  const administrator =
    (authorization.principal.type === "human" ||
      authorization.principal.type === "operator") &&
    (authorization.membership.role === "owner" ||
      authorization.membership.role === "admin");
  const target = authorization.identities.find(
    (identity) => identity.identity_id === identityId,
  );
  if (
    !administrator ||
    !target ||
    target.kind !== "human" ||
    !target.scopes.includes("connection.manage")
  ) {
    throw new LinkingRouteError(
      403,
      "forbidden",
      "Administrator connection management is required",
    );
  }
};

const providerErrorCode = (
  result: GatewayPollResult,
): "expired" | "provider_error" =>
  result.status === "expired" ? "expired" : "provider_error";

async function cancelPrevious(
  gateway: ConnectionGateway,
  state: LinkSessionState,
  gatewayRef: string | null | undefined,
  generation: number,
): Promise<void> {
  if (!gatewayRef) return;
  try {
    await gateway.cancel({
      ...gatewayOwnerFor({ ...state, generation }),
      gateway_ref: gatewayRef,
    });
  } catch {
    // The new generation is authoritative even when cleanup is temporarily unavailable.
  }
}

async function startProvider(
  env: Cloudflare.Env,
  services: LinkingServices,
  state: LinkSessionState,
): Promise<{ state: LinkSessionState; qr: string }> {
  const gateway = (services.createConnectionGateway ?? gatewayFromEnv)(env);
  let result;
  try {
    result = await gateway.start(gatewayOwnerFor(state));
  } catch (error) {
    await command(env, state.id, {
      command: "set_provider_state",
      owner: ownerFor(state),
      generation: state.generation,
      status: "failed",
      action: "none",
      action_expires_at: null,
      error_code:
        error instanceof ConnectionGatewayError
          ? error.code
          : "provider_unavailable",
    });
    throw error;
  }
  const stored = await command(env, state.id, {
    command: "set_gateway",
    owner: ownerFor(state),
    generation: state.generation,
    gateway_ref: result.gateway_ref,
    action_expires_at: result.action_expires_at,
  });
  return { state: stored.state, qr: result.qr };
}

const getState = async (
  env: Cloudflare.Env,
  sessionId: string,
): Promise<LinkSessionState> =>
  (await command(env, sessionId, { command: "read" })).state;

export const createLinkSessionHandler =
  (services: LinkingServices = {}): LinkingHandler =>
  async (context) => {
    try {
      const { identity_id: identityId } = context.req.valid("param") as {
        identity_id: string;
      };
      const body = context.req.valid("json") as LinkSessionStart;
      const idempotencyKey = context.req.header("Idempotency-Key");
      if (!idempotencyKey)
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "Idempotency-Key is required",
        );
      requireLinkAdministrator(context, identityId);
      if (body.confirmed_identity_id !== identityId)
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "The selected identity must be confirmed",
        );
      if (body.provider !== "whatsapp")
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "This provider is not enabled for QR linking",
        );
      const authorization = context.get("authorization");
      const sessionDigest = await sha256Hex(
        `${authorization.tenant.id}\0${identityId}\0${body.provider}\0${idempotencyKey}`,
      );
      const sessionId = `link_${sessionDigest.slice(0, 48)}`;
      const clock = services.now ?? (() => new Date());
      const createdAt = clock();
      const initial: LinkSessionState = {
        id: sessionId,
        tenant_id: authorization.tenant.id,
        actor_principal_id: authorization.principal.id,
        membership_id: authorization.membership.id,
        target_identity_id: identityId,
        provider: body.provider,
        generation: 1,
        status: "created",
        action: "none",
        expires_at: new Date(
          createdAt.getTime() + LINK_SESSION_TTL_MS,
        ).toISOString(),
        action_expires_at: null,
        gateway_ref: null,
        connection_id: null,
        lifecycle_operation_id: null,
        provider_login_id: null,
        account_id: null,
        provider_label: null,
        error_code: null,
        request_key_digest: await sha256Hex(idempotencyKey),
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
      };
      const created = await command(context.env, sessionId, {
        command: "create",
        state: initial,
      });
      if (!created.created)
        return context.json(publicSession(created.state), 200);
      const started = await startProvider(context.env, services, created.state);
      return context.json(publicSession(started.state, started.qr), 201);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

/**
 * Start a generation-bound relink for one established connection. The
 * lifecycle row is written before this function calls the private gateway;
 * the existing LinkSessionDO then supplies the cancellation/late-callback
 * fence used by initial linking as well.
 */
export const createRelinkSessionHandler =
  (services: LinkingServices = {}): LinkingHandler =>
  async (context) => {
    try {
      const { connection_id: connectionId } = context.req.valid("param") as {
        connection_id: string;
      };
      const body = context.req.valid("json") as ConnectionRelinkStart;
      const idempotencyKey = context.req.header("Idempotency-Key");
      if (!idempotencyKey)
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "Idempotency-Key is required",
        );
      if (body.provider !== "whatsapp")
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "This provider is not enabled for QR relinking",
        );
      requireLinkAdministrator(context, body.confirmed_identity_id);
      const authorization = context.get("authorization");
      const clock = services.now ?? (() => new Date());
      const sessionId = `relink_${(
        await sha256Hex(
          `${authorization.tenant.id}\0${connectionId}\0${body.provider}\0${idempotencyKey}`,
        )
      ).slice(0, 48)}`;
      const begun = await beginConnectionRelink({
        db: context.env.CONTROL_DB,
        operation_id: `lifecycle_${sessionId}`,
        session_id: sessionId,
        tenant_id: authorization.tenant.id,
        actor_principal_id: authorization.principal.id,
        membership_id: authorization.membership.id,
        identity_id: body.confirmed_identity_id,
        connection_id: connectionId,
        provider: body.provider,
        idempotency_key: idempotencyKey,
        occurred_at: clock().toISOString(),
        ...(body.expected_session_generation === undefined
          ? {}
          : { expected_session_generation: body.expected_session_generation }),
      });
      const createdAt = clock();
      const initial: LinkSessionState = {
        id: sessionId,
        tenant_id: authorization.tenant.id,
        actor_principal_id: authorization.principal.id,
        membership_id: authorization.membership.id,
        target_identity_id: body.confirmed_identity_id,
        provider: body.provider,
        generation: 1,
        status:
          begun.operation.status === "reconciliation_required" ||
          begun.operation.status === "failed"
            ? "reconciliation_required"
            : begun.operation.status === "succeeded"
              ? "connected"
              : "created",
        action: "none",
        expires_at: new Date(
          createdAt.getTime() + LINK_SESSION_TTL_MS,
        ).toISOString(),
        action_expires_at: null,
        gateway_ref: null,
        connection_id: begun.connection.connection_id,
        lifecycle_operation_id: begun.operation.operation_id,
        provider_login_id: begun.connection.provider_login_id,
        account_id: begun.connection.account_id,
        provider_label: null,
        error_code:
          begun.operation.status === "reconciliation_required" ||
          begun.operation.status === "failed"
            ? "reconciliation_required"
            : null,
        request_key_digest: await sha256Hex(idempotencyKey),
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
      };
      const created = await command(context.env, sessionId, {
        command: "create",
        state: initial,
      });
      if (!created.created)
        return context.json(publicSession(created.state), 200);
      if (
        begun.operation.status === "succeeded" ||
        begun.operation.status === "reconciliation_required" ||
        begun.operation.status === "failed"
      ) {
        return context.json(publicSession(created.state), 200);
      }
      try {
        const started = await startProvider(
          context.env,
          services,
          created.state,
        );
        await markLifecycleProviderPending(
          context.env.CONTROL_DB,
          authorization.tenant.id,
          begun.operation.operation_id,
          clock().toISOString(),
        );
        return context.json(publicSession(started.state, started.qr), 201);
      } catch (error) {
        try {
          await markLifecycleReconciliation(
            context.env.CONTROL_DB,
            authorization.tenant.id,
            begun.operation.operation_id,
            error instanceof ConnectionGatewayError &&
              error.code === "provider_unavailable"
              ? "provider_unavailable"
              : "provider_error",
            clock().toISOString(),
          );
        } catch {
          // The operation row remains durable even if the status write is unavailable.
        }
        throw error;
      }
    } catch (error) {
      return errorResponse(context, error);
    }
  };

const publicLifecycleOperation = (
  operation: Awaited<ReturnType<typeof getLifecycleOperation>>,
) => {
  if (!operation) throw new LifecycleRepositoryError("connection_not_found");
  return ConnectionLifecycleOperationSchema.parse({
    operation_id: operation.operation_id,
    kind: operation.kind,
    connection_id: operation.connection_id,
    provider: operation.provider,
    status: operation.status,
    session_generation: operation.session_generation,
    replacement_connection_id: operation.replacement_connection_id,
    error_code: operation.error_code,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
  });
};

export const createConnectionDisconnectHandler =
  (services: LinkingServices = {}): LinkingHandler =>
  async (context) => {
    try {
      const { connection_id: connectionId } = context.req.valid("param") as {
        connection_id: string;
      };
      const body = context.req.valid("json") as {
        expected_session_generation?: string;
      };
      const idempotencyKey = context.req.header("Idempotency-Key");
      if (!idempotencyKey)
        throw new LinkingRouteError(
          400,
          "invalid_request",
          "Idempotency-Key is required",
        );
      const authorization = context.get("authorization");
      const connection = await getLifecycleConnection(
        context.env.CONTROL_DB,
        authorization.tenant.id,
        connectionId,
      );
      if (!connection)
        throw new LifecycleRepositoryError("connection_not_found");
      requireLinkAdministrator(context, connection.identity_id);
      const clock = new Date();
      const operationId = `lifecycle_disconnect_${(
        await sha256Hex(
          `${authorization.tenant.id}\0${connectionId}\0${idempotencyKey}`,
        )
      ).slice(0, 48)}`;
      const begun = await beginConnectionDisconnect({
        db: context.env.CONTROL_DB,
        operation_id: operationId,
        tenant_id: authorization.tenant.id,
        actor_principal_id: authorization.principal.id,
        membership_id: authorization.membership.id,
        identity_id: connection.identity_id,
        connection_id: connectionId,
        idempotency_key: idempotencyKey,
        occurred_at: clock.toISOString(),
        ...(body.expected_session_generation === undefined
          ? {}
          : { expected_session_generation: body.expected_session_generation }),
      });
      if (begun.operation.status !== "pending")
        return context.json(publicLifecycleOperation(begun.operation), 200);
      await markLifecycleProviderPending(
        context.env.CONTROL_DB,
        authorization.tenant.id,
        operationId,
        new Date().toISOString(),
      );
      try {
        const gateway = services.createConnectionGateway
          ? services.createConnectionGateway(context.env)
          : gatewayFromEnv(context.env);
        if (!gateway?.disconnect) {
          return context.json(
            publicLifecycleOperation(
              await markLifecycleReconciliation(
                context.env.CONTROL_DB,
                authorization.tenant.id,
                operationId,
                "provider_unavailable",
                new Date().toISOString(),
              ),
            ),
            200,
          );
        }
        const result = await gateway.disconnect({
          session_id: operationId,
          tenant_id: authorization.tenant.id,
          actor_principal_id: authorization.principal.id,
          membership_id: authorization.membership.id,
          target_identity_id: connection.identity_id,
          provider: connection.provider,
          generation: 1,
          connection_id: connection.connection_id,
          provider_login_id: connection.provider_login_id,
        });
        const completed = await completeConnectionDisconnect({
          db: context.env.CONTROL_DB,
          operation_id: operationId,
          actor: {
            tenant_id: authorization.tenant.id,
            actor_principal_id: authorization.principal.id,
            membership_id: authorization.membership.id,
            identity_id: connection.identity_id,
          },
          provider_login_id: result.provider_login_id,
          occurred_at: new Date().toISOString(),
        });
        return context.json(publicLifecycleOperation(completed), 200);
      } catch (error) {
        const reconciled = await markLifecycleReconciliation(
          context.env.CONTROL_DB,
          authorization.tenant.id,
          operationId,
          error instanceof ConnectionGatewayError &&
            error.code === "provider_unavailable"
            ? "provider_unavailable"
            : "provider_error",
          new Date().toISOString(),
        );
        return context.json(publicLifecycleOperation(reconciled), 200);
      }
    } catch (error) {
      return errorResponse(context, error);
    }
  };

export const getConnectionLifecycleOperationHandler: LinkingHandler = async (
  context,
) => {
  try {
    const { connection_id: connectionId, operation_id: operationId } =
      context.req.valid("param") as {
        connection_id: string;
        operation_id: string;
      };
    const authorization = context.get("authorization");
    const connection = await getLifecycleConnection(
      context.env.CONTROL_DB,
      authorization.tenant.id,
      connectionId,
    );
    if (!connection) throw new LifecycleRepositoryError("connection_not_found");
    requireLinkAdministrator(context, connection.identity_id);
    const operation = await getLifecycleOperation(
      context.env.CONTROL_DB,
      authorization.tenant.id,
      operationId,
    );
    if (!operation || operation.connection_id !== connectionId)
      throw new LifecycleRepositoryError("connection_not_found");
    return context.json(publicLifecycleOperation(operation), 200);
  } catch (error) {
    return errorResponse(context, error);
  }
};

const authorizedState = async (
  context: Context<LinkingRouteEnv>,
  sessionId: string,
): Promise<LinkSessionState> => {
  const state = await getState(context.env, sessionId);
  requireLinkAdministrator(context, state.target_identity_id);
  const authorization = context.get("authorization");
  if (
    state.tenant_id !== authorization.tenant.id ||
    state.actor_principal_id !== authorization.principal.id ||
    state.membership_id !== authorization.membership.id
  )
    throw new LinkingRouteError(
      403,
      "forbidden",
      "Link session owner required",
    );
  return state;
};

export const getLinkSessionHandler: LinkingHandler = async (context) => {
  try {
    const { link_session_id: sessionId } = context.req.valid("param") as {
      link_session_id: string;
    };
    return context.json(
      publicSession(await authorizedState(context, sessionId)),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const createLinkSessionActionHandler =
  (services: LinkingServices = {}): LinkingHandler =>
  async (context) => {
    try {
      const { link_session_id: sessionId } = context.req.valid("param") as {
        link_session_id: string;
      };
      const body = context.req.valid("json") as LinkSessionActionRequest;
      const state = await authorizedState(context, sessionId);
      const gateway = (services.createConnectionGateway ?? gatewayFromEnv)(
        context.env,
      );
      if (body.generation !== state.generation)
        throw new LinkingRouteError(
          409,
          "invalid_request",
          "Link session is stale",
        );
      if (body.action === "refresh") {
        const refreshed = await command(context.env, sessionId, {
          command: "refresh",
          owner: ownerFor(state),
          generation: state.generation,
        });
        await cancelPrevious(
          gateway,
          state,
          refreshed.previous_gateway_ref,
          state.generation,
        );
        const started = await startProvider(
          context.env,
          services,
          refreshed.state,
        );
        return context.json(publicSession(started.state, started.qr), 200);
      }
      if (
        state.status === "connected" ||
        state.status === "relink_required" ||
        state.status === "reconciliation_required"
      )
        return context.json(publicSession(state), 200);
      const begun = await command(context.env, sessionId, {
        command: "begin",
        owner: ownerFor(state),
        generation: body.generation,
      });
      if (!begun.state.gateway_ref)
        throw new LinkingRouteError(
          503,
          "service_unavailable",
          "Link provider session is unavailable",
        );
      const result = await gateway.poll({
        ...gatewayOwnerFor(begun.state),
        gateway_ref: begun.state.gateway_ref,
      });
      if (result.status === "awaiting_user") {
        const updated = await command(context.env, sessionId, {
          command: "set_provider_state",
          owner: ownerFor(begun.state),
          generation: body.generation,
          status: "awaiting_user",
          action: result.action,
          action_expires_at: result.action_expires_at,
          error_code: null,
        });
        return context.json(publicSession(updated.state, result.qr), 200);
      }
      if (result.status !== "connected") {
        const updated = await command(context.env, sessionId, {
          command: "set_provider_state",
          owner: ownerFor(begun.state),
          generation: body.generation,
          status: result.status === "expired" ? "expired" : "failed",
          action: "none",
          action_expires_at: null,
          error_code: providerErrorCode(result),
        });
        return context.json(publicSession(updated.state), 200);
      }
      const identity = result.provider_identity;
      if (!identity.user_login_id || identity.user_login_id.length > 256)
        throw new LinkingRouteError(
          409,
          "invalid_request",
          "Provider identity could not be verified",
        );
      // Re-check the caller before the serialized DO commit. The repository
      // repeats this check against current D1 rows inside the same boundary.
      requireLinkAdministrator(context, begun.state.target_identity_id);
      const committed = await command(context.env, sessionId, {
        command: "commit",
        owner: ownerFor(begun.state),
        generation: body.generation,
        provider_identity: identity,
        occurred_at: (services.now ?? (() => new Date()))().toISOString(),
      });
      if (committed.commit_error === "authorization_required")
        throw new LinkingRouteError(
          403,
          "forbidden",
          "Administrator connection management is required",
        );
      if (committed.commit_error)
        throw new LinkingRepositoryError(committed.commit_error);
      return context.json(publicSession(committed.state), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

export const createCancelLinkSessionHandler =
  (services: LinkingServices = {}): LinkingHandler =>
  async (context) => {
    try {
      const { link_session_id: sessionId } = context.req.valid("param") as {
        link_session_id: string;
      };
      const state = await authorizedState(context, sessionId);
      const gateway = (services.createConnectionGateway ?? gatewayFromEnv)(
        context.env,
      );
      const invalidated = await command(context.env, sessionId, {
        command: "invalidate",
        owner: ownerFor(state),
        generation: state.generation,
        status: "cancelled",
      });
      await cancelPrevious(
        gateway,
        state,
        invalidated.previous_gateway_ref,
        state.generation,
      );
      return context.json(publicSession(invalidated.state), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  };
