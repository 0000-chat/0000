import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommunicatorIdSchema,
  HistoryImportAdvanceRequestSchema,
  HistoryImportDetailSchema,
  HistoryImportPageSchema,
  HistoryImportStartRequestSchema,
  ProviderCapabilitySchema,
  type HistoryImportDetail,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  isAdministratorSession,
  toGrantedAccountReadAuthorization,
} from "../read/authorization";
import {
  findHistoryAccount,
  getDetail,
  listCapabilities,
  listImports,
} from "./repository";
import {
  historyProviderFromEnv,
  type HistoryImportProvider,
} from "./provider";
import {
  createHistoryService,
  HistoryServiceError,
  type HistoryService,
  type HistoryServiceEnvironment,
} from "./service";
import { ensureDefaultCapabilities } from "./repository";

type HistoryRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

type HistoryRouteContext = Context<HistoryRouteEnv>;

type HistoryStartInput = z.infer<typeof HistoryImportStartRequestSchema>;
type HistoryAdvanceInput = z.infer<typeof HistoryImportAdvanceRequestSchema>;
type HistoryListInput = {
  identity_id: string;
  cursor?: string;
  limit?: number;
};
type HistoryIdentityInput = { identity_id: string };

export type HistoryRouteServices = {
  createProvider?: (env: Cloudflare.Env) => HistoryImportProvider;
  now?: () => Date;
  applyEvents?: Parameters<typeof createHistoryService>[0]["applyEvents"];
};

const boundedId = CommunicatorIdSchema.max(128);
const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const accountParams = z.object({ account_id: boundedId }).strict();
const importParams = z.object({ import_id: boundedId }).strict();
const identityQuery = z.object({ identity_id: boundedId }).strict();
const listQuery = z
  .object({
    identity_id: boundedId,
    cursor: z.string().trim().min(1).max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const detailResponses = (description: string) => ({
  200: {
    description,
    content: { "application/json": { schema: HistoryImportDetailSchema } },
  },
  400: { description: "Invalid request", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "History import not found", content: errorContent },
  409: { description: "History import conflict", content: errorContent },
  503: { description: "History import unavailable", content: errorContent },
});

export const historyImportStartRoute = createRoute({
  method: "post",
  path: "/api/v1/accounts/{account_id}/history-imports",
  security: [{ bearerAuth: [] }],
  request: {
    params: accountParams,
    headers: z
      .object({ "idempotency-key": z.string().trim().min(8).max(200) })
      .passthrough(),
    body: {
      content: { "application/json": { schema: HistoryImportStartRequestSchema } },
    },
  },
  responses: {
    ...detailResponses("Started account history import"),
    201: {
      description: "Started account history import",
      content: { "application/json": { schema: HistoryImportDetailSchema } },
    },
  },
});

export const historyImportListRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts/{account_id}/history-imports",
  security: [{ bearerAuth: [] }],
  request: { params: accountParams, query: listQuery },
  responses: {
    200: {
      description: "Account history imports",
      content: { "application/json": { schema: HistoryImportPageSchema } },
    },
    400: { description: "Invalid request", content: errorContent },
    403: { description: "Forbidden", content: errorContent },
    404: { description: "Account not found", content: errorContent },
    503: { description: "History import unavailable", content: errorContent },
  },
});

export const historyImportDetailRoute = createRoute({
  method: "get",
  path: "/api/v1/history-imports/{import_id}",
  security: [{ bearerAuth: [] }],
  request: { params: importParams, query: identityQuery },
  responses: detailResponses("History import status"),
});

export const historyImportAdvanceRoute = createRoute({
  method: "post",
  path: "/api/v1/history-imports/{import_id}/advance",
  security: [{ bearerAuth: [] }],
  request: {
    params: importParams,
    body: {
      content: {
        "application/json": { schema: HistoryImportAdvanceRequestSchema },
      },
    },
  },
  responses: detailResponses("Advanced account history import"),
});

export const providerCapabilitiesRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts/{account_id}/capabilities",
  security: [{ bearerAuth: [] }],
  request: { params: accountParams, query: identityQuery },
  responses: {
    200: {
      description: "Account provider capabilities and evidence",
      content: {
        "application/json": { schema: ProviderCapabilitySchema.array().max(20) },
      },
    },
    400: { description: "Invalid request", content: errorContent },
    403: { description: "Forbidden", content: errorContent },
    404: { description: "Account not found", content: errorContent },
    503: { description: "Capability directory unavailable", content: errorContent },
  },
});

const responseError = (
  context: HistoryRouteContext,
  status: 400 | 403 | 404 | 409 | 503,
  code: "invalid_request" | "forbidden" | "not_found" | "service_unavailable",
  message: string,
) =>
  context.json(
    ApiErrorResponseSchema.parse({ error: { code, message } }),
    status,
  );

const errorResponse = (context: HistoryRouteContext, error: unknown) => {
  if (error instanceof HistoryServiceError) {
    switch (error.code) {
      case "history_invalid":
        return responseError(context, 400, "invalid_request", "Invalid history import");
      case "history_not_found":
        return responseError(context, 404, "not_found", "History import not found");
      case "history_conflict":
        return responseError(context, 409, "invalid_request", "History import conflict");
      case "history_unavailable":
        return responseError(context, 503, "service_unavailable", "History import unavailable");
      default:
        return responseError(context, 503, "service_unavailable", "History provider unavailable");
    }
  }
  return responseError(context, 503, "service_unavailable", "History import unavailable");
};

const requireAdministrator = (
  context: HistoryRouteContext,
  identityId: string,
): Response | undefined => {
  const authorization = context.get("authorization");
  if (!isAdministratorSession(authorization))
    return responseError(context, 403, "forbidden", "Administrator permission required");
  const target = authorization.identities.find(
    (identity) => identity.identity_id === identityId,
  );
  if (target === undefined || !target.scopes.includes("connection.manage")) {
    return responseError(context, 403, "forbidden", "Connection management permission required");
  }
  return undefined;
};

const requireAccountRead = async (
  context: HistoryRouteContext,
  accountId: string,
  identityId: string,
): Promise<void> => {
  await toGrantedAccountReadAuthorization(
    context.env,
    context.get("authorization"),
    identityId,
    accountId,
    context.get("delegated"),
  );
};

const serviceFactory = (
  services: HistoryRouteServices,
): ((env: Cloudflare.Env) => HistoryService) => {
  let service: HistoryService | undefined;
  return (env) => {
    const dependencies: Parameters<typeof createHistoryService>[0] = {
      provider: (services.createProvider ?? historyProviderFromEnv)(env),
      ...(services.now === undefined ? {} : { now: services.now }),
      ...(services.applyEvents === undefined
        ? {}
        : { applyEvents: services.applyEvents }),
    };
    service ??= createHistoryService(dependencies);
    return service;
  };
};

export const createHistoryHandlers = (services: HistoryRouteServices = {}) => {
  const getService = serviceFactory(services);

  const start: Handler<
    HistoryRouteEnv,
    string,
    { out: { param: { account_id: string }; json: HistoryStartInput } }
  > = async (context) => {
    try {
      const params = context.req.valid("param");
      const body = context.req.valid("json");
      const denied = requireAdministrator(context, body.identity_id);
      if (denied) return denied;
      const detail = await getService(context.env).start({
        env: context.env as HistoryServiceEnvironment,
        tenantId: context.get("authorization").tenant.id,
        accountId: params.account_id,
        identityId: body.identity_id,
        idempotencyKey: context.req.header("Idempotency-Key") ?? "",
        startAt: body.start_at,
        endAt: body.end_at,
        maxEvents: body.max_events,
      });
      return context.json(detail, detail.import.status === "started" ? 201 : 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  const list: Handler<
    HistoryRouteEnv,
    string,
    { out: { param: { account_id: string }; query: HistoryListInput } }
  > = async (context) => {
    try {
      const params = context.req.valid("param");
      const query = context.req.valid("query");
      await requireAccountRead(context, params.account_id, query.identity_id);
      const page = await listImports(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
        params.account_id,
        query.limit,
        query.cursor,
      );
      return context.json(page, 200);
    } catch (error) {
      if (error instanceof Error && error.name === "ReadError")
        return responseError(context, 404, "not_found", "Account not found");
      return errorResponse(context, error);
    }
  };

  const detail: Handler<
    HistoryRouteEnv,
    string,
    { out: { param: { import_id: string }; query: HistoryIdentityInput } }
  > = async (context) => {
    try {
      const params = context.req.valid("param");
      const query = context.req.valid("query");
      const loaded = await getDetail(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
        params.import_id,
      );
      await requireAccountRead(context, loaded.import.account_id, query.identity_id);
      if (loaded.import.identity_id !== query.identity_id)
        return responseError(context, 404, "not_found", "History import not found");
      return context.json(loaded, 200);
    } catch (error) {
      if (error instanceof Error && error.name === "ReadError")
        return responseError(context, 404, "not_found", "History import not found");
      return errorResponse(context, error);
    }
  };

  const advance: Handler<
    HistoryRouteEnv,
    string,
    { out: { param: { import_id: string }; json: HistoryAdvanceInput } }
  > = async (context) => {
    try {
      const params = context.req.valid("param");
      const body = context.req.valid("json");
      const denied = requireAdministrator(context, body.identity_id);
      if (denied) return denied;
      const current = await getDetail(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
        params.import_id,
      );
      if (current.import.identity_id !== body.identity_id)
        return responseError(context, 404, "not_found", "History import not found");
      const loaded = await getService(context.env).advance({
        env: context.env as HistoryServiceEnvironment,
        tenantId: context.get("authorization").tenant.id,
        importId: params.import_id,
        accountId: current.import.account_id,
        identityId: body.identity_id,
        ...(body.range_id === undefined ? {} : { rangeId: body.range_id }),
      });
      return context.json(loaded, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  const capabilities: Handler<
    HistoryRouteEnv,
    string,
    { out: { param: { account_id: string }; query: HistoryIdentityInput } }
  > = async (context) => {
    try {
      const params = context.req.valid("param");
      const query = context.req.valid("query");
      await requireAccountRead(context, params.account_id, query.identity_id);
      const binding = await findHistoryAccount(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
        params.account_id,
        query.identity_id,
      );
      await ensureDefaultCapabilities(
        context.env.CONTROL_DB,
        binding,
        new Date().toISOString(),
      );
      const result = await listCapabilities(
        context.env.CONTROL_DB,
        binding.tenant_id,
        binding.account_id,
        binding.connection_id,
      );
      return context.json(result, 200);
    } catch (error) {
      if (error instanceof Error && error.name === "ReadError")
        return responseError(context, 404, "not_found", "Account not found");
      return errorResponse(context, error);
    }
  };

  return { start, list, detail, advance, capabilities };
};
