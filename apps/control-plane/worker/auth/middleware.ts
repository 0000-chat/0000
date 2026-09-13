import type { SessionResponse } from "@communicator/contracts";
import type { MiddlewareHandler } from "hono";
import { parseAccessAssertion, parseBearerToken } from "./bearer";
import type { TokenVerifier, VerifiedSubject } from "./oidc";
import {
  resolveAuthorization,
  resolveOAuthInstallationAuthorization,
} from "../control-directory/authorization";

export type AuthorizationVariables = {
  authorization: SessionResponse;
  /** True only for a locally issued installation-bound OAuth access token. */
  delegated: boolean;
};

type AuthorizationMiddlewareOptions = {
  getVerifier: (env: Cloudflare.Env) => TokenVerifier;
  getAccessVerifier: (env: Cloudflare.Env) => TokenVerifier;
  getOAuthVerifier?: (env: Cloudflare.Env) => TokenVerifier;
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
      let delegated = false;
      let subject: VerifiedSubject;
      if (authorization !== undefined) {
        const token = parseBearerToken(authorization);
        try {
          subject = await options.getVerifier(context.env).verify(token);
        } catch (humanError) {
          if (!options.getOAuthVerifier) throw humanError;
          subject = await options.getOAuthVerifier(context.env).verify(token);
          delegated = true;
        }
      } else {
        subject = await options
          .getAccessVerifier(context.env)
          .verify(parseAccessAssertion(accessAssertion));
      }
      const database = context.env.CONTROL_DB;
      if (!database)
        return respond(
          503,
          "service_unavailable",
          "Authorization service unavailable",
        );
      const tenantHint =
        context.req.header("X-Communicator-Tenant") ?? undefined;
      const result = delegated
        ? await resolveOAuthInstallationAuthorization(database, subject)
        : await resolveAuthorization(database, subject, tenantHint);
      if (result.ok) {
        context.set("authorization", result.context);
        context.set("delegated", delegated);
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
