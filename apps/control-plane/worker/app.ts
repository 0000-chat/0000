import { OpenAPIHono } from "@hono/zod-openapi";
import { SessionResponseSchema } from "@communicator/contracts";
import { HTTPException } from "hono/http-exception";
import type { AuthorizationVariables } from "./auth/middleware";
import { createAuthorizationMiddleware } from "./auth/middleware";
import {
  createIngestionAuthorizationMiddleware,
  type IngestionAuthorizationVariables,
} from "./auth/ingestion-middleware";
import { createOidcVerifier, type TokenVerifier } from "./auth/oidc";
import { getIngestionOidcConfig } from "./ingestion/config";
import {
  createIngestionBatchHandler,
  type IngestionQueueSender,
} from "./ingestion/route";
import { healthRoute } from "./routes/health";
import {
  channelsRoute,
  channelsHandler,
  conversationRoute,
  conversationHandler,
  conversationsRoute,
  conversationsHandler,
  connectionsRoute,
  connectionsHandler,
  identitiesRoute,
  identitiesHandler,
  messagesRoute,
  messagesHandler,
  accountConversationsRoute,
  accountConversationsHandler,
} from "./routes/read";
import { sessionRoute } from "./routes/session";
import { realtimeTicketRoute } from "./routes/realtime";
import {
  accountsRoute,
  accountsHandler,
  grantTargetsRoute,
  grantTargetsHandler,
  createGrantRoute,
  createGrantHandler,
  createPermissionRequestRoute,
  createPermissionRequestHandler,
  grantsRoute,
  grantsHandler,
  permissionRequestsRoute,
  permissionRequestsHandler,
  revokeGrantRoute,
  revokeGrantHandler,
  updateGrantRoute,
  updateGrantHandler,
} from "./routes/grants";
import {
  realtimeTicketHandler,
  realtimeUpgradeHandler,
} from "./realtime/handlers";
import { ReadError, readErrorResponse } from "./read/errors";

const REALTIME_TICKET_PATH = "/api/v1/realtime/tickets";
const MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";

const decorateRealtimeTicketResponse = (response: Response): Response => {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};

export type AppServices = {
  createTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  createAccessTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  createIngestionTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  sendIngestionQueue?: IngestionQueueSender;
};

export function createApp(services: AppServices = {}) {
  const app = new OpenAPIHono<{
    Bindings: Cloudflare.Env;
    Variables: AuthorizationVariables & IngestionAuthorizationVariables;
  }>({
    defaultHook: (result, context) => {
      if (result.success) return;
      const error = readErrorResponse(new ReadError("invalid_request"));
      return context.json(error.body, error.status);
    },
  });
  app.onError((error, context) => {
    if (
      context.req.path === REALTIME_TICKET_PATH &&
      error instanceof HTTPException &&
      error.status === 400 &&
      error.message === MALFORMED_JSON_MESSAGE
    ) {
      return decorateRealtimeTicketResponse(context.json({
        error: { code: "invalid_request", message: "Invalid request" },
      }, 400));
    }
    if (error instanceof HTTPException) {
      const response = error.getResponse();
      return context.newResponse(response.body, response);
    }
    console.error({ event: "internal_server_error" });
    return context.text("Internal Server Error", 500);
  });
  let verifier: TokenVerifier | undefined;
  const getVerifier = (runtimeEnv: Cloudflare.Env) => {
    verifier ??= (services.createTokenVerifier ?? ((env) => createOidcVerifier({
      issuer: env.COMMUNICATOR_OIDC_ISSUER,
      audience: env.COMMUNICATOR_OIDC_AUDIENCE,
      jwks_url: env.COMMUNICATOR_OIDC_JWKS_URL,
    })))(runtimeEnv);
    return verifier;
  };

  let accessVerifier: TokenVerifier | undefined;
  const getAccessVerifier = (runtimeEnv: Cloudflare.Env) => {
    accessVerifier ??= (services.createAccessTokenVerifier ?? ((env) => createOidcVerifier({
      issuer: env.COMMUNICATOR_ACCESS_ISSUER,
      audience: env.COMMUNICATOR_ACCESS_AUDIENCE,
      jwks_url: env.COMMUNICATOR_ACCESS_JWKS_URL,
    })))(runtimeEnv);
    return accessVerifier;
  };

  let ingestionVerifier: TokenVerifier | undefined;
  const getIngestionVerifier = (runtimeEnv: Cloudflare.Env) => {
    ingestionVerifier ??= (
      services.createIngestionTokenVerifier ??
      ((env) => createOidcVerifier(getIngestionOidcConfig(env), {
        requireIngestionClaims: true,
      }))
    )(runtimeEnv);
    return ingestionVerifier;
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
  const productAuthorization = createAuthorizationMiddleware({
    getVerifier,
    getAccessVerifier,
  });
  app.use(REALTIME_TICKET_PATH, async (context, next) => {
    await next();
    if (context.finalized) decorateRealtimeTicketResponse(context.res);
  });
  app.use("/api/v1/session", productAuthorization);
  app.use(REALTIME_TICKET_PATH, productAuthorization);
  app.use("/api/v1/identities", productAuthorization);
  app.use("/api/v1/identities/*", productAuthorization);
  app.use("/api/v1/connections", productAuthorization);
  app.use("/api/v1/accounts", productAuthorization);
  app.use("/api/v1/accounts/*", productAuthorization);
  app.use("/api/v1/grant-targets", productAuthorization);
  app.use("/api/v1/grants", productAuthorization);
  app.use("/api/v1/grants/*", productAuthorization);
  app.use("/api/v1/permission-requests", productAuthorization);
  app.use("/api/v1/conversations/*", productAuthorization);
  app.openapi(sessionRoute, (context) => context.json(
    SessionResponseSchema.parse(context.get("authorization")),
    200,
  ));
  app.openapi(realtimeTicketRoute, realtimeTicketHandler);
  app.get("/api/v1/realtime", realtimeUpgradeHandler);

  app.openapi(identitiesRoute, identitiesHandler);
  app.openapi(connectionsRoute, connectionsHandler);
  app.openapi(channelsRoute, channelsHandler);
  app.openapi(conversationsRoute, conversationsHandler);
  app.openapi(conversationRoute, conversationHandler);
  app.openapi(messagesRoute, messagesHandler);
  app.openapi(accountConversationsRoute, accountConversationsHandler);
  app.openapi(accountsRoute, accountsHandler);
  app.openapi(grantTargetsRoute, grantTargetsHandler);
  app.openapi(grantsRoute, grantsHandler);
  app.openapi(createGrantRoute, createGrantHandler);
  app.openapi(updateGrantRoute, updateGrantHandler);
  app.openapi(revokeGrantRoute, revokeGrantHandler);
  app.openapi(permissionRequestsRoute, permissionRequestsHandler);
  app.openapi(createPermissionRequestRoute, createPermissionRequestHandler);

  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Communicator API", version: "1.0.0" },
  });

  app.use(
    "/internal/v1/ingestion/batches",
    createIngestionAuthorizationMiddleware({ getVerifier: getIngestionVerifier }),
  );
  app.post(
    "/internal/v1/ingestion/batches",
    createIngestionBatchHandler({
      ...(services.sendIngestionQueue === undefined
        ? {}
        : { sendIngestionQueue: services.sendIngestionQueue }),
    }),
  );

  return app;
}

export default createApp();
