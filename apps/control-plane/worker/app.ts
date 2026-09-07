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
import { healthRoute } from "./routes/health";
import { sessionRoute } from "./routes/session";

export type AppServices = {
  createTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  createIngestionTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
};

export function createApp(services: AppServices = {}) {
  const app = new OpenAPIHono<{
    Bindings: Cloudflare.Env;
    Variables: AuthorizationVariables & IngestionAuthorizationVariables;
  }>();
  let verifier: TokenVerifier | undefined;
  const getVerifier = (runtimeEnv: Cloudflare.Env) => {
    verifier ??= (services.createTokenVerifier ?? ((env) => createOidcVerifier({
      issuer: env.COMMUNICATOR_OIDC_ISSUER,
      audience: env.COMMUNICATOR_OIDC_AUDIENCE,
      jwks_url: env.COMMUNICATOR_OIDC_JWKS_URL,
    })))(runtimeEnv);
    return verifier;
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
  app.use("/api/v1/session", createAuthorizationMiddleware({ getVerifier }));
  app.openapi(sessionRoute, (context) => context.json(
    SessionResponseSchema.parse(context.get("authorization")),
    200,
  ));

  app.use(
    "/internal/v1/ingestion/batches",
    createIngestionAuthorizationMiddleware({ getVerifier: getIngestionVerifier }),
  );

  return app;
}

export default createApp();
