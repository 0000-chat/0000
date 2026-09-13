import type { SessionResponse } from "@communicator/contracts";
import { decodeJwt } from "jose";
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

/**
 * Local installation tokens carry a distinct signed claim shape. Decode is
 * used only to decide which verifier owns a token; the OAuth verifier still
 * validates the signature, issuer, audience, expiry, and installation claims.
 * A token that presents this shape is never retried through the human OIDC
 * verifier after OAuth validation fails.
 */
const hasInstallationTokenShape = (token: string): boolean => {
  try {
    const payload = decodeJwt(token);
    return [
      payload.iss,
      payload.sub,
      payload.jti,
      payload.installation_id,
      payload.client_id,
      payload.resource,
      payload.scope,
    ].every((value) => typeof value === "string" && value.length > 0);
  } catch {
    return false;
  }
};

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
      let subject: VerifiedSubject | undefined;
      if (authorization !== undefined) {
        const token = parseBearerToken(authorization);
        let oauthError: unknown;
        let oauthVerified = false;
        if (options.getOAuthVerifier) {
          try {
            subject = await options.getOAuthVerifier(context.env).verify(token);
            delegated = true;
            oauthVerified = true;
          } catch (error) {
            oauthError = error;
            // Never allow an invalid, expired, revoked, or mis-targeted local
            // installation token to fall through to a human verifier when the
            // verifier configurations happen to overlap.
            if (hasInstallationTokenShape(token)) throw error;
          }
        }
        if (!oauthVerified) {
          try {
            subject = await options.getVerifier(context.env).verify(token);
          } catch (humanError) {
            throw oauthError ?? humanError;
          }
        }
        if (!subject)
          throw new Error("authentication verifier returned no subject");
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
        ? await resolveOAuthInstallationAuthorization(
            database,
            subject,
            tenantHint,
          )
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
