import { OpenAPIHono } from "@hono/zod-openapi";
import { SessionResponseSchema } from "@communicator/contracts";
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
} from "./routes/read";
import { sessionRoute } from "./routes/session";
import { ReadError, readErrorResponse } from "./read/errors";

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
  app.use("/api/v1/session", createAuthorizationMiddleware({
    getVerifier,
    getAccessVerifier,
  }));
  const readAuthorization = createAuthorizationMiddleware({
    getVerifier,
    getAccessVerifier,
  });
  app.use("/api/v1/identities", readAuthorization);
  app.use("/api/v1/identities/*", readAuthorization);
  app.use("/api/v1/connections", readAuthorization);
  app.use("/api/v1/conversations/*", readAuthorization);
  app.openapi(sessionRoute, (context) => context.json(
    SessionResponseSchema.parse(context.get("authorization")),
    200,
  ));

  app.openapi(identitiesRoute, identitiesHandler);
  app.openapi(connectionsRoute, connectionsHandler);
  app.openapi(channelsRoute, channelsHandler);
  app.openapi(conversationsRoute, conversationsHandler);
  app.openapi(conversationRoute, conversationHandler);
  app.openapi(messagesRoute, messagesHandler);

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
