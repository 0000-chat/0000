import type { AuthenticatedPrincipal } from "@0000/contracts";
import {
  isSameOriginUnsafeBrowserRequest,
  selectBrowserCredential,
} from "@0000/platform-client";
import type { SessionResponse } from "@communicator/contracts";
import { decodeJwt } from "jose";
import type { MiddlewareHandler } from "hono";
import { parseAccessAssertion, parseBearerToken } from "./bearer";
import type { PlatformAuthenticator, PlatformAuthentication } from "./platform";
import type { TokenVerifier, VerifiedSubject } from "./oidc";
import {
  resolveAuthorization,
  resolveOAuthInstallationAuthorization,
  resolvePlatformAuthorization,
} from "../control-directory/authorization";
import type { ResolvedPlatformBinding } from "../control-directory/platform-bindings";

export type AuthorizationVariables = {
  authorization: SessionResponse;
  /** True only for a locally issued installation-bound OAuth access token. */
  delegated: boolean;
  /** Current opaque credential, retained only for trusted realtime handoff. */
  authorizationCredential?: string;
  /** Current Platform tuple, never derived from a browser claim. */
  platformPrincipal?: Exclude<AuthenticatedPrincipal, { kind: "guest" }>;
  platformCapabilities?: readonly string[];
  platformBinding?: ResolvedPlatformBinding;
};

type AuthorizationMiddlewareOptions = {
  /** Production path: shared Platform verification and local binding. */
  getPlatformAuthenticator?: (
    env: Cloudflare.Env,
  ) => PlatformAuthenticator | null;
  /** Legacy fixture seams retained only for imported component tests. */
  getVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  getAccessVerifier?: (env: Cloudflare.Env) => TokenVerifier;
  getOAuthVerifier?: (env: Cloudflare.Env) => TokenVerifier;
};

function logAuthorizationFailure(status: number, requestId: string) {
  console.error({ event: "auth_denied", status, request_id: requestId });
}

const isLegacyFixtureMode = (
  options: AuthorizationMiddlewareOptions,
): boolean =>
  options.getPlatformAuthenticator === undefined &&
  options.getVerifier !== undefined;

const isBindablePlatformPrincipal = (
  principal: AuthenticatedPrincipal,
): principal is Exclude<AuthenticatedPrincipal, { kind: "guest" }> =>
  principal.kind !== "guest";

const platformFailureStatus = (result: PlatformAuthentication): 401 | 503 =>
  result.status === "authority_unavailable" ? 503 : 401;

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

/**
 * Authenticate a Communicator request. In production the only accepted
 * authority is Platform; explicit Authorization always wins over the local
 * cookie, including malformed or empty Authorization values. The old
 * verifier branch is intentionally available only when a test supplies the
 * pre-adoption fixture seam.
 */
export function createAuthorizationMiddleware(
  options: AuthorizationMiddlewareOptions,
): MiddlewareHandler<{
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables;
}> {
  const legacyFixtures = isLegacyFixtureMode(options);
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
      const headers =
        status === 401
          ? {
              "WWW-Authenticate": `Bearer resource_metadata="${new URL(context.req.url).origin}/.well-known/oauth-protected-resource"`,
            }
          : undefined;
      return context.json({ error: { code, message } }, status, headers);
    };

    try {
      const database = context.env.CONTROL_DB;
      if (!database) {
        return respond(
          503,
          "service_unavailable",
          "Authorization service unavailable",
        );
      }
      const tenantHint =
        context.req.header("X-Communicator-Tenant") ?? undefined;

      if (!legacyFixtures) {
        const selection = selectBrowserCredential(context.req.raw);
        if (selection.status === "invalid" || selection.credential === null) {
          return respond(401, "unauthenticated", "Authentication required");
        }
        if (
          selection.source === "cookie" &&
          !isSameOriginUnsafeBrowserRequest(
            context.req.raw,
            new URL(context.req.url).origin,
          )
        ) {
          return respond(401, "unauthenticated", "Authentication required");
        }
        const authenticator = options.getPlatformAuthenticator?.(context.env);
        if (!authenticator) {
          return respond(
            503,
            "service_unavailable",
            "Authorization service unavailable",
          );
        }
        const authenticated = await authenticator.authenticate(
          selection.credential,
        );
        if (authenticated.status !== "authenticated") {
          const status = platformFailureStatus(authenticated);
          return respond(
            status,
            status === 503 ? "service_unavailable" : "unauthenticated",
            status === 503
              ? "Authorization service unavailable"
              : "Authentication required",
          );
        }
        const principal = authenticated.principal;
        if (!isBindablePlatformPrincipal(principal)) {
          return respond(401, "unauthenticated", "Authentication required");
        }
        const result = await resolvePlatformAuthorization(
          database,
          principal,
          tenantHint,
        );
        if (!result.ok) {
          switch (result.code) {
            case "not_found":
              return respond(404, "not_found", "Resource not found");
            case "directory_unavailable":
              return respond(
                503,
                "service_unavailable",
                "Authorization service unavailable",
              );
            case "tenant_selection_required":
              return respond(
                400,
                "tenant_selection_required",
                "Select an authorized tenant",
              );
            case "unauthenticated":
              return respond(401, "unauthenticated", "Authentication required");
          }
        }
        context.set("authorization", result.context);
        context.set("delegated", false);
        context.set("authorizationCredential", selection.credential);
        context.set("platformPrincipal", result.principal);
        context.set("platformCapabilities", result.capabilities);
        context.set("platformBinding", result.binding);
        await next();
        return;
      }

      // Imported unit tests provide a verifier seam and a local directory
      // fixture. This branch is never selected by the deployed app.
      const authorization = context.req.header("Authorization");
      const accessAssertion = context.req.header("Cf-Access-Jwt-Assertion");
      let delegated = false;
      let subject: VerifiedSubject;
      if (authorization !== undefined) {
        const token = parseBearerToken(authorization);
        let oauthError: unknown;
        if (options.getOAuthVerifier) {
          try {
            subject = await options.getOAuthVerifier(context.env).verify(token);
            delegated = true;
          } catch (error) {
            oauthError = error;
            // An installation-shaped credential is never retried through a
            // human verifier when its local OAuth validation fails.
            if (hasInstallationTokenShape(token)) throw error;
          }
        }
        if (!delegated) {
          try {
            subject = await options.getVerifier!(context.env).verify(token);
          } catch (error) {
            throw oauthError ?? error;
          }
        }
      } else {
        subject = await options.getAccessVerifier!(context.env).verify(
          parseAccessAssertion(accessAssertion),
        );
      }
      const result = delegated
        ? await resolveOAuthInstallationAuthorization(
            database,
            subject!,
            tenantHint,
          )
        : await resolveAuthorization(database, subject!, tenantHint);
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
