import { createRoute, z } from "@hono/zod-openapi";
import {
  AccountGrantMutationSchema,
  AccountGrantPageSchema,
  AccountGrantSchema,
  AccountGrantUpdateSchema,
  ApiErrorResponseSchema,
  ConnectedAccountPageSchema,
  CommunicatorIdSchema,
  MAX_GRANT_PAGE_SIZE,
  PermissionRequestCreateSchema,
  PermissionRequestPageSchema,
  PermissionRequestSchema,
  type AccountGrantMutation,
  type AccountGrantUpdate,
  type PermissionRequestCreate,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  createAccountGrant,
  createPermissionRequest,
  GrantRepositoryError,
  listAccountGrants,
  listConnectedAccounts,
  listPermissionRequests,
  revokeAccountGrant,
  resolveAccountReadScope,
  updateAccountGrant,
} from "../control-directory/grants";

type GrantRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);
const optionalId = z.preprocess(
  (value) => Array.isArray(value) ? { invalid_query_value: true } : value,
  boundedId.optional(),
);
const optionalCursor = z.preprocess(
  (value) => Array.isArray(value) ? { invalid_query_value: true } : value,
  z.string().min(1).max(2_048).optional(),
);
const optionalLimit = z.preprocess(
  (value) => Array.isArray(value) ? { invalid_query_value: true } : value,
  z.coerce.number().int().min(1).max(MAX_GRANT_PAGE_SIZE).optional(),
);
const grantQuery = z.object({
  identity_id: optionalId,
  account_id: optionalId,
  status: z.enum(["active", "revoked"]).optional(),
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();
const accountQuery = z.object({
  identity_id: optionalId,
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();
const requestQuery = z.object({
  identity_id: optionalId,
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();

const grantResponses = (schema: z.ZodTypeAny, description: string) => ({
  200: { description, content: { "application/json": { schema } } },
  201: { description, content: { "application/json": { schema } } },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Administrator permission required", content: errorContent },
  404: { description: "Resource not found", content: errorContent },
  409: { description: "Grant mutation conflict", content: errorContent },
  503: { description: "Grant directory unavailable", content: errorContent },
});

export const grantsRoute = createRoute({
  method: "get",
  path: "/api/v1/grants",
  security: [{ bearerAuth: [] }],
  request: { query: grantQuery },
  responses: grantResponses(AccountGrantPageSchema, "Account and chat grants"),
});

export const createGrantRoute = createRoute({
  method: "post",
  path: "/api/v1/grants",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: AccountGrantMutationSchema } } } },
  responses: grantResponses(AccountGrantSchema, "Created account and chat grant"),
});

export const updateGrantRoute = createRoute({
  method: "patch",
  path: "/api/v1/grants/{grant_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ grant_id: boundedId }).strict(),
    body: { content: { "application/json": { schema: AccountGrantUpdateSchema } } },
  },
  responses: grantResponses(AccountGrantSchema, "Updated account and chat grant"),
});

export const revokeGrantRoute = createRoute({
  method: "delete",
  path: "/api/v1/grants/{grant_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ grant_id: boundedId }).strict(),
    headers: z.object({ "idempotency-key": z.string().trim().min(1).max(200) }).passthrough(),
  },
  responses: grantResponses(AccountGrantSchema, "Revoked account and chat grant"),
});

export const accountsRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts",
  security: [{ bearerAuth: [] }],
  request: { query: accountQuery },
  responses: grantResponses(ConnectedAccountPageSchema, "Paginated connected accounts"),
});

export const permissionRequestsRoute = createRoute({
  method: "get",
  path: "/api/v1/permission-requests",
  security: [{ bearerAuth: [] }],
  request: { query: requestQuery },
  responses: grantResponses(PermissionRequestPageSchema, "Permission requests"),
});

export const createPermissionRequestRoute = createRoute({
  method: "post",
  path: "/api/v1/permission-requests",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: PermissionRequestCreateSchema } } } },
  responses: grantResponses(PermissionRequestSchema, "Created permission request"),
});

const publicError = (
  context: Context<GrantRouteEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 503,
  code: "invalid_request" | "forbidden" | "not_found" | "service_unavailable",
  message: string,
) => context.json(ApiErrorResponseSchema.parse({ error: { code, message } }), status);

const grantFailure = (context: Context<GrantRouteEnv>, error: unknown) => {
  if (error instanceof GrantRepositoryError) {
    if (error.code === "grant_invalid") return publicError(context, 400, "invalid_request", "Invalid grant data");
    if (error.code === "grant_not_found") return publicError(context, 404, "not_found", "Grant not found");
    if (error.code === "grant_conflict") return publicError(context, 409, "invalid_request", "Grant mutation conflict");
  }
  return publicError(context, 503, "service_unavailable", "Grant directory unavailable");
};

const isAdministrator = (context: Context<GrantRouteEnv>): boolean => {
  const authorization = context.get("authorization");
  const role = authorization.membership.role;
  const principalType = authorization.principal.type;
  return (principalType === "human" || principalType === "operator")
    && (role === "owner" || role === "admin");
};

const requireAdministrator = (context: Context<GrantRouteEnv>): Response | undefined =>
  isAdministrator(context)
    ? undefined
    : publicError(context, 403, "forbidden", "Administrator permission required");

const ownIdentity = (
  context: Context<GrantRouteEnv>,
  identityId: string,
): boolean => context.get("authorization").identities.some((identity) => identity.identity_id === identityId);

export const grantsHandler: Handler<GrantRouteEnv, string, { out: { query: { identity_id?: string; account_id?: string; status?: "active" | "revoked"; cursor?: string; limit?: number } } }> = async (context) => {
  try {
    const query = context.req.valid("query");
    const admin = isAdministrator(context);
    if (!admin && query.identity_id !== undefined && !ownIdentity(context, query.identity_id)) {
      return publicError(context, 403, "forbidden", "An agent may inspect only its own grants");
    }
    const visibleIdentityId = admin
      ? query.identity_id
      : query.identity_id ?? context.get("authorization").identities[0]?.identity_id;
    if (!admin && visibleIdentityId === undefined) {
      return context.json({ items: [], next_cursor: null }, 200);
    }
    return context.json(await listAccountGrants(
      context.env.CONTROL_DB.withSession("first-primary"),
      {
        tenantId: context.get("authorization").tenant.id,
        ...(admin ? {} : { membershipId: context.get("authorization").membership.id }),
        ...(visibleIdentityId === undefined ? {} : { identityId: visibleIdentityId }),
        ...(query.account_id === undefined ? {} : { accountId: query.account_id }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
    ), 200);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const createGrantHandler: Handler<GrantRouteEnv, string, { out: { json: AccountGrantMutation } }> = async (context) => {
  const denied = requireAdministrator(context);
  if (denied) return denied;
  try {
    const body = context.req.valid("json");
    return context.json(await createAccountGrant(context.env.CONTROL_DB, {
      idempotencyKey: body.idempotency_key,
      tenantId: context.get("authorization").tenant.id,
      actorPrincipalId: context.get("authorization").principal.id,
      membershipId: body.membership_id,
      identityId: body.identity_id,
      accountId: body.account_id,
      operationScope: body.operation_scope,
      chatScope: body.chat_scope,
      chatIds: body.chat_ids,
      occurredAt: new Date().toISOString(),
    }), 201);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const updateGrantHandler: Handler<GrantRouteEnv, string, { out: { param: { grant_id: string }; json: AccountGrantUpdate } }> = async (context) => {
  const denied = requireAdministrator(context);
  if (denied) return denied;
  try {
    const body = context.req.valid("json");
    return context.json(await updateAccountGrant(context.env.CONTROL_DB, {
      idempotencyKey: body.idempotency_key,
      tenantId: context.get("authorization").tenant.id,
      actorPrincipalId: context.get("authorization").principal.id,
      grantId: context.req.valid("param").grant_id,
      operationScope: body.operation_scope,
      chatScope: body.chat_scope,
      chatIds: body.chat_ids,
      occurredAt: new Date().toISOString(),
    }), 200);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const revokeGrantHandler: Handler<GrantRouteEnv, string, { out: { param: { grant_id: string } } }> = async (context) => {
  const denied = requireAdministrator(context);
  if (denied) return denied;
  try {
    const key = context.req.header("Idempotency-Key");
    if (!key) return publicError(context, 400, "invalid_request", "Idempotency-Key is required");
    return context.json(await revokeAccountGrant(context.env.CONTROL_DB, {
      idempotencyKey: key,
      tenantId: context.get("authorization").tenant.id,
      actorPrincipalId: context.get("authorization").principal.id,
      grantId: context.req.valid("param").grant_id,
      occurredAt: new Date().toISOString(),
    }), 200);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const accountsHandler: Handler<GrantRouteEnv, string, { out: { query: { identity_id?: string; cursor?: string; limit?: number } } }> = async (context) => {
  try {
    const query = context.req.valid("query");
    const admin = isAdministrator(context);
    if (!admin && query.identity_id !== undefined && !ownIdentity(context, query.identity_id)) {
      return publicError(context, 403, "forbidden", "An agent may inspect only its own accounts");
    }
    const visibleIdentityId = query.identity_id ?? context.get("authorization").identities[0]?.identity_id;
    if (!admin && visibleIdentityId === undefined) {
      return context.json({ items: [], next_cursor: null }, 200);
    }
    const accountScope = admin || visibleIdentityId === undefined
      ? undefined
      : await resolveAccountReadScope(
        context.env.CONTROL_DB.withSession("first-primary"),
        context.get("authorization").tenant.id,
        context.get("authorization").membership.id,
        visibleIdentityId,
      );
    return context.json(await listConnectedAccounts(
      context.env.CONTROL_DB.withSession("first-primary"),
      {
        tenantId: context.get("authorization").tenant.id,
        ...(visibleIdentityId === undefined ? {} : { identityId: visibleIdentityId }),
        ...(accountScope === undefined ? {} : { accountIds: accountScope.allowedAccountIds }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
    ), 200);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const permissionRequestsHandler: Handler<GrantRouteEnv, string, { out: { query: { identity_id?: string; status?: "pending" | "approved" | "rejected" | "cancelled"; cursor?: string; limit?: number } } }> = async (context) => {
  try {
    const query = context.req.valid("query");
    const admin = isAdministrator(context);
    if (!admin && query.identity_id !== undefined && !ownIdentity(context, query.identity_id)) {
      return publicError(context, 403, "forbidden", "An agent may inspect only its own requests");
    }
    const visibleIdentityId = admin
      ? query.identity_id
      : query.identity_id ?? context.get("authorization").identities[0]?.identity_id;
    if (!admin && visibleIdentityId === undefined) {
      return context.json({ items: [], next_cursor: null }, 200);
    }
    return context.json(await listPermissionRequests(
      context.env.CONTROL_DB.withSession("first-primary"),
      {
        tenantId: context.get("authorization").tenant.id,
        ...(admin ? {} : { requesterMembershipId: context.get("authorization").membership.id }),
        ...(visibleIdentityId === undefined ? {} : { identityId: visibleIdentityId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
    ), 200);
  } catch (error) {
    return grantFailure(context, error);
  }
};

export const createPermissionRequestHandler: Handler<GrantRouteEnv, string, { out: { json: PermissionRequestCreate } }> = async (context) => {
  try {
    const body = context.req.valid("json");
    if (!ownIdentity(context, body.identity_id)) {
      return publicError(context, 403, "forbidden", "A principal may request access only for its own identity");
    }
    return context.json(await createPermissionRequest(context.env.CONTROL_DB, {
      idempotencyKey: body.idempotency_key,
      tenantId: context.get("authorization").tenant.id,
      requesterPrincipalId: context.get("authorization").principal.id,
      requesterMembershipId: context.get("authorization").membership.id,
      identityId: body.identity_id,
      accountId: body.account_id,
      operationScope: body.operation_scope,
      chatScope: body.chat_scope,
      chatIds: body.chat_ids,
      reason: body.reason,
      occurredAt: new Date().toISOString(),
    }), 201);
  } catch (error) {
    return grantFailure(context, error);
  }
};
