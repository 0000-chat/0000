import type { SessionResponse } from "@communicator/contracts";
import type { MiddlewareHandler } from "hono";
import { parseAccessAssertion, parseBearerToken } from "./bearer";
import type { TokenVerifier } from "./oidc";
import { resolveAuthorization } from "../control-directory/authorization";

export type AuthorizationVariables = {
  authorization: SessionResponse;
};

type AuthorizationMiddlewareOptions = {
  getVerifier: (env: Cloudflare.Env) => TokenVerifier;
  getAccessVerifier: (env: Cloudflare.Env) => TokenVerifier;
};

function logAuthorizationFailure(status: number, requestId: string) {
  console.error({ event: "auth_denied", status, request_id: requestId });
}

export function createAuthorizationMiddleware(
  options: AuthorizationMiddlewareOptions,
): MiddlewareHandler<{
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables;
}> {
  return async (context, next) => {
    const requestId = crypto.randomUUID();
    const respond = (
      status: 400 | 401 | 404 | 503,
      code:
        | "unauthenticated"
        | "not_found"
        | "tenant_selection_required"
        | "service_unavailable",
      message: string,
    ) => {
      logAuthorizationFailure(status, requestId);
      return context.json({ error: { code, message } }, status);
    };

    try {
      const authorization = context.req.header("Authorization");
      const accessAssertion = context.req.header("Cf-Access-Jwt-Assertion");
      const subject =
        authorization !== undefined
          ? await options
              .getVerifier(context.env)
              .verify(parseBearerToken(authorization))
          : await options
              .getAccessVerifier(context.env)
              .verify(parseAccessAssertion(accessAssertion));
      const database = context.env.CONTROL_DB;
      if (!database)
        return respond(
          503,
          "service_unavailable",
          "Authorization service unavailable",
        );
      const tenantHint =
        context.req.header("X-Communicator-Tenant") ?? undefined;
      const result = await resolveAuthorization(database, subject, tenantHint);
      if (result.ok) {
        context.set("authorization", result.context);
        await next();
        return;
      }
      switch (result.code) {
        case "not_found":
          return respond(404, "not_found", "Resource not found");
        case "tenant_selection_required":
          return respond(
            400,
            "tenant_selection_required",
            "Select an authorized tenant",
          );
        case "directory_unavailable":
          return respond(
            503,
            "service_unavailable",
            "Authorization service unavailable",
          );
        case "unauthenticated":
          return respond(401, "unauthenticated", "Authentication required");
      }
    } catch {
      return respond(401, "unauthenticated", "Authentication required");
    }
  };
}
