import { OpenAPIHono } from "@hono/zod-openapi";
import { SessionResponseSchema } from "@communicator/contracts";
import type { AuthorizationVariables } from "./auth/middleware";
import { createAuthorizationMiddleware } from "./auth/middleware";
import { createOidcVerifier, type TokenVerifier } from "./auth/oidc";
import { healthRoute } from "./routes/health";
import { sessionRoute } from "./routes/session";

export type AppServices = {
  createTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
};

export function createApp(services: AppServices = {}) {
  const app = new OpenAPIHono<{
    Bindings: Cloudflare.Env;
    Variables: AuthorizationVariables;
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

  return app;
}

export default createApp();
