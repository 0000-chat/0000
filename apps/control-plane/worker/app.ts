import { OpenAPIHono } from "@hono/zod-openapi";
import { SessionResponseSchema } from "@communicator/contracts";
import { HTTPException } from "hono/http-exception";
import type { AuthorizationVariables } from "./auth/middleware";
import { createAuthorizationMiddleware } from "./auth/middleware";
import { parseBearerToken } from "./auth/bearer";
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
  searchMessagesRoute,
  searchMessagesHandler,
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
import {
  registerOAuthRoutes,
  type OAuthHumanSession,
  type OAuthRouteServices,
  type OAuthUpstreamLoginInput,
} from "./oauth/routes";
import { completeConfiguredOAuthUpstreamLogin } from "./oauth/upstream";
import {
  createOAuthAccessTokenVerifier,
  getOAuthRuntimeConfig,
  type OAuthRuntimeConfig,
} from "./oauth/tokens";
import type { OAuthAccessTokenClaims } from "./oauth/tokens";
import { resolveAuthorization } from "./control-directory/authorization";
import { handleMcpGet, handleMcpRequest } from "./mcp";
import {
  createCancelLinkSessionHandler,
  createLinkSessionActionHandler,
  createLinkSessionHandler,
  getLinkSessionHandler,
  linkSessionActionRoute,
  linkSessionCancelRoute,
  linkSessionGetRoute,
  linkSessionStartRoute,
  type LinkingServices,
} from "./linking/routes";

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
  createOAuthAccessTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  createIngestionTokenVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  sendIngestionQueue?: IngestionQueueSender;
  resolveOAuthHumanSession?: (
    request: Request,
    env: Cloudflare.Env,
  ) => Promise<OAuthHumanSession | null>;
  completeOAuthUpstreamLogin?: (
    input: OAuthUpstreamLoginInput,
  ) => Promise<OAuthHumanSession | null>;
  oauthClock?: () => Date;
  oauthConfig?: (env: Cloudflare.Env) => OAuthRuntimeConfig;
  signOAuthAccessToken?: (
    env: Cloudflare.Env,
    config: OAuthRuntimeConfig,
    claims: OAuthAccessTokenClaims,
  ) => Promise<string>;
  /** Controlled fetch for the configured upstream token/JWKS exchange. */
  fetchOAuthUpstream?: typeof fetch;
  createConnectionGateway?: LinkingServices["createConnectionGateway"];
  linkingNow?: LinkingServices["now"];
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
      return decorateRealtimeTicketResponse(
        context.json(
          {
            error: { code: "invalid_request", message: "Invalid request" },
          },
          400,
        ),
      );
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
    verifier ??= (
      services.createTokenVerifier ??
      ((env) =>
        createOidcVerifier({
          issuer: env.COMMUNICATOR_OIDC_ISSUER,
          audience: env.COMMUNICATOR_OIDC_AUDIENCE,
          jwks_url: env.COMMUNICATOR_OIDC_JWKS_URL,
        }))
    )(runtimeEnv);
    return verifier;
  };

  let accessVerifier: TokenVerifier | undefined;
  const getAccessVerifier = (runtimeEnv: Cloudflare.Env) => {
    accessVerifier ??= (
      services.createAccessTokenVerifier ??
      ((env) =>
        createOidcVerifier({
          issuer: env.COMMUNICATOR_ACCESS_ISSUER,
          audience: env.COMMUNICATOR_ACCESS_AUDIENCE,
          jwks_url: env.COMMUNICATOR_ACCESS_JWKS_URL,
        }))
    )(runtimeEnv);
    return accessVerifier;
  };

  let oauthVerifier: TokenVerifier | undefined;
  const getOAuthVerifier = (runtimeEnv: Cloudflare.Env) => {
    oauthVerifier ??= (
      services.createOAuthAccessTokenVerifier ??
      ((env) =>
        createOAuthAccessTokenVerifier(
          (services.oauthConfig ?? getOAuthRuntimeConfig)(env),
          services.oauthClock ? { currentDate: services.oauthClock() } : {},
        ))
    )(runtimeEnv);
    return oauthVerifier;
  };

  const resolveOAuthHumanSession =
    services.resolveOAuthHumanSession ??
    (async (
      request: Request,
      env: Cloudflare.Env,
    ): Promise<OAuthHumanSession | null> => {
      const header = request.headers.get("Authorization");
      if (!header) return null;
      try {
        const token = parseBearerToken(header);
        // A valid local installation token is never a human login shortcut,
        // even when the upstream verifier configuration overlaps.
        try {
          await getOAuthVerifier(env).verify(token);
          return null;
        } catch {
          // Continue with the configured human verifier.
        }
        const subject = await getVerifier(env).verify(token);
        if (subject.installation_id) return null;
        const database = env.CONTROL_DB;
        if (!database || typeof database.withSession !== "function")
          return null;
        const tenantHint =
          request.headers.get("X-Communicator-Tenant") ?? undefined;
        const result = await resolveAuthorization(
          database,
          subject,
          tenantHint,
        );
        if (!result.ok) return null;
        if (
          result.context.principal.type !== "human" &&
          result.context.principal.type !== "operator"
        )
          return null;
        return {
          issuer: subject.issuer,
          subject: subject.subject,
          tenantId: result.context.tenant.id,
          membershipId: result.context.membership.id,
          principalId: result.context.principal.id,
        };
      } catch {
        return null;
      }
    });

  let ingestionVerifier: TokenVerifier | undefined;
  const getIngestionVerifier = (runtimeEnv: Cloudflare.Env) => {
    ingestionVerifier ??= (
      services.createIngestionTokenVerifier ??
      ((env) =>
        createOidcVerifier(getIngestionOidcConfig(env), {
          requireIngestionClaims: true,
        }))
    )(runtimeEnv);
    return ingestionVerifier;
  };

  app.openapi(healthRoute, (context) =>
    context.json(
      {
        status: "ok",
        service: "communicator-control-plane",
        data_mode: context.env?.COMMUNICATOR_DATA_MODE ?? "unconfigured",
      },
      200,
    ),
  );

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  const productAuthorization = createAuthorizationMiddleware({
    getVerifier,
    getAccessVerifier,
    getOAuthVerifier,
  });
  const oauthServices: OAuthRouteServices = {
    resolveHumanSession: resolveOAuthHumanSession,
  };
  if (services.oauthConfig) oauthServices.getConfig = services.oauthConfig;
  if (services.oauthClock) oauthServices.clock = services.oauthClock;
  if (services.completeOAuthUpstreamLogin) {
    oauthServices.completeUpstreamLogin = services.completeOAuthUpstreamLogin;
  } else {
    oauthServices.completeUpstreamLogin = async (input) => {
      let config: OAuthRuntimeConfig;
      try {
        config = (services.oauthConfig ?? getOAuthRuntimeConfig)(input.env);
      } catch {
        return null;
      }
      const verified = await completeConfiguredOAuthUpstreamLogin(
        input,
        config,
        services.fetchOAuthUpstream ?? fetch,
        services.oauthClock?.() ?? new Date(),
      );
      if (!verified) return null;
      const database = input.env.CONTROL_DB;
      if (!database || typeof database.withSession !== "function") return null;
      const result = await resolveAuthorization(
        database,
        { issuer: verified.issuer, subject: verified.subject },
        input.tenantHint,
      );
      if (!result.ok) return null;
      if (
        result.context.principal.type !== "human" &&
        result.context.principal.type !== "operator"
      ) {
        return null;
      }
      return {
        issuer: verified.issuer,
        subject: verified.subject,
        tenantId: result.context.tenant.id,
        membershipId: result.context.membership.id,
        principalId: result.context.principal.id,
      };
    };
  }
  if (services.signOAuthAccessToken)
    oauthServices.signAccessToken = services.signOAuthAccessToken;
  registerOAuthRoutes(app, oauthServices);
  app.use(REALTIME_TICKET_PATH, async (context, next) => {
    await next();
    if (context.finalized) decorateRealtimeTicketResponse(context.res);
  });
  app.use("/api/v1/session", productAuthorization);
  app.use("/mcp", productAuthorization);
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
  app.use("/api/v1/identities/*/link-sessions", productAuthorization);
  app.use("/api/v1/link-sessions/*", productAuthorization);
  app.use("/api/v1/search/*", productAuthorization);
  app.openapi(sessionRoute, (context) =>
    context.json(
      SessionResponseSchema.parse(context.get("authorization")),
      200,
    ),
  );
  app.openapi(realtimeTicketRoute, realtimeTicketHandler);
  app.get("/api/v1/realtime", realtimeUpgradeHandler);
  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", handleMcpGet);

  app.openapi(identitiesRoute, identitiesHandler);
  app.openapi(connectionsRoute, connectionsHandler);
  app.openapi(channelsRoute, channelsHandler);
  app.openapi(conversationsRoute, conversationsHandler);
  app.openapi(conversationRoute, conversationHandler);
  app.openapi(messagesRoute, messagesHandler);
  app.openapi(searchMessagesRoute, searchMessagesHandler);
  app.openapi(accountConversationsRoute, accountConversationsHandler);
  app.openapi(accountsRoute, accountsHandler);
  app.openapi(grantTargetsRoute, grantTargetsHandler);
  app.openapi(grantsRoute, grantsHandler);
  app.openapi(createGrantRoute, createGrantHandler);
  app.openapi(updateGrantRoute, updateGrantHandler);
  app.openapi(revokeGrantRoute, revokeGrantHandler);
  app.openapi(permissionRequestsRoute, permissionRequestsHandler);
  app.openapi(createPermissionRequestRoute, createPermissionRequestHandler);
  const linkingServices: LinkingServices = {};
  if (services.createConnectionGateway !== undefined)
    linkingServices.createConnectionGateway = services.createConnectionGateway;
  if (services.linkingNow !== undefined)
    linkingServices.now = services.linkingNow;
  app.openapi(linkSessionStartRoute, createLinkSessionHandler(linkingServices));
  app.openapi(linkSessionGetRoute, getLinkSessionHandler);
  app.openapi(
    linkSessionActionRoute,
    createLinkSessionActionHandler(linkingServices),
  );
  app.openapi(
    linkSessionCancelRoute,
    createCancelLinkSessionHandler(linkingServices),
  );

  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Communicator API", version: "1.0.0" },
  });

  app.use(
    "/internal/v1/ingestion/batches",
    createIngestionAuthorizationMiddleware({
      getVerifier: getIngestionVerifier,
    }),
  );
  app.post(
    "/internal/v1/ingestion/batches",
    createIngestionBatchHandler(services),
  );

  return app;
}

export default createApp();
