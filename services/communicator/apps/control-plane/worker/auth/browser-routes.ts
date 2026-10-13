import {
  createPlatformBrowserClient,
  type PlatformBrowserClient,
} from "@0000/platform-client";
import type { Hono } from "hono";
import { createBrowserOAuthTransactionStore } from "./browser-transaction-store";

type BrowserRouteEnv = { Bindings: Cloudflare.Env };
type RuntimeValues = Record<string, unknown>;

const read = (env: Cloudflare.Env, key: string): string | undefined => {
  const value = (env as unknown as RuntimeValues)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const scopes = (value: string): string[] =>
  value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);

function createBrowserClient(
  env: Cloudflare.Env,
  request: Request,
): PlatformBrowserClient | null {
  const baseUrl = read(env, "COMMUNICATOR_PLATFORM_BASE_URL");
  const authority = read(env, "COMMUNICATOR_PLATFORM_AUTHORITY");
  const audience = read(env, "COMMUNICATOR_PLATFORM_AUDIENCE");
  const serviceVerifier = read(env, "COMMUNICATOR_PLATFORM_SERVICE_VERIFIER");
  const clientId = read(env, "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID");
  const clientSecret = read(env, "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET");
  const redirectUri = read(env, "COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI");
  const resource = read(env, "COMMUNICATOR_PLATFORM_BROWSER_RESOURCE");
  const configuredScopes = read(env, "COMMUNICATOR_PLATFORM_BROWSER_SCOPES");
  if (
    !baseUrl ||
    !authority ||
    !audience ||
    !serviceVerifier ||
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !resource ||
    !configuredScopes
  ) {
    return null;
  }
  try {
    const requestOrigin = new URL(request.url).origin;
    const configuredRedirectOrigin = new URL(redirectUri).origin;
    if (requestOrigin !== configuredRedirectOrigin) return null;
    return createPlatformBrowserClient({
      baseUrl,
      authority,
      audience,
      serviceVerifier,
      clientId,
      clientSecret,
      redirectUri,
      resource,
      scopes: scopes(configuredScopes),
      returnOrigin: requestOrigin,
      transactionStore: createBrowserOAuthTransactionStore(env.CONTROL_DB),
    });
  } catch {
    return null;
  }
}

const browserConfigurationAvailable = (env: Cloudflare.Env): boolean => {
  const values = env as unknown as Record<string, unknown>;
  return [
    "COMMUNICATOR_PLATFORM_BASE_URL",
    "COMMUNICATOR_PLATFORM_AUTHORITY",
    "COMMUNICATOR_PLATFORM_AUDIENCE",
    "COMMUNICATOR_PLATFORM_SERVICE_VERIFIER",
    "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID",
    "COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET",
    "COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI",
    "COMMUNICATOR_PLATFORM_BROWSER_RESOURCE",
    "COMMUNICATOR_PLATFORM_BROWSER_SCOPES",
  ].every((key) => typeof values[key] === "string" && values[key].length > 0);
};

const noStore = (response: Response): Response => {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};

const redirectWithCookie = (
  target: string,
  cookie: string,
  extraCookie?: string,
): Response => {
  const response = new Response(null, {
    status: 302,
    headers: { Location: target },
  });
  response.headers.append("Set-Cookie", cookie);
  if (extraCookie) response.headers.append("Set-Cookie", extraCookie);
  return noStore(response);
};

export function registerPlatformBrowserRoutes<E extends BrowserRouteEnv>(
  app: Hono<E>,
): void {
  app.get("/auth/login", async (context) => {
    const client = createBrowserClient(context.env, context.req.raw);
    if (!client) return noStore(context.text("Browser login unavailable", 503));
    const returnTo =
      new URL(context.req.url).searchParams.get("return_to") ?? "/";
    const result = await client.start({ returnTo });
    if (result.status !== "started") {
      return noStore(
        context.text(
          result.status === "authority_unavailable"
            ? "Platform authorization unavailable"
            : "Invalid login request",
          result.status === "authority_unavailable" ? 503 : 400,
        ),
      );
    }
    return redirectWithCookie(result.authorizationUrl, result.setCookie);
  });

  app.get("/auth/callback", async (context) => {
    const client = createBrowserClient(context.env, context.req.raw);
    if (!client) return noStore(context.text("Browser login unavailable", 503));
    const result = await client.callback(context.req.raw);
    if (result.status === "authenticated") {
      return redirectWithCookie(
        new URL(result.returnTo, context.req.url).href,
        result.setCookie,
        result.clearBrowserBindingCookie,
      );
    }
    const returnTo = result.returnTo ?? "/";
    const status = result.status === "authority_unavailable" ? 503 : 400;
    const location = new URL(returnTo, context.req.url);
    location.searchParams.set(
      "login_error",
      result.status === "authority_unavailable"
        ? "authority_unavailable"
        : result.reason,
    );
    const response = new Response(null, {
      status: 302,
      headers: { Location: location.href },
    });
    if (result.clearBrowserBindingCookie) {
      response.headers.append("Set-Cookie", result.clearBrowserBindingCookie);
    }
    response.headers.set("X-Login-Status", String(status));
    return noStore(response);
  });

  app.post("/auth/logout", (context) => {
    const client = createBrowserClient(context.env, context.req.raw);
    if (!client)
      return noStore(context.text("Browser logout unavailable", 503));
    if (!client.isSameOriginUnsafeRequest(context.req.raw)) {
      return noStore(context.text("Invalid origin", 403));
    }
    const response = new Response(null, { status: 204 });
    response.headers.append("Set-Cookie", client.clearCredentialCookie());
    response.headers.append("Set-Cookie", client.clearBrowserBindingCookie());
    return noStore(response);
  });

  app.get("/.well-known/oauth-protected-resource", async (context, next) => {
    if (!browserConfigurationAvailable(context.env)) return next();
    const baseUrl = read(context.env, "COMMUNICATOR_PLATFORM_BASE_URL");
    const resource = read(
      context.env,
      "COMMUNICATOR_PLATFORM_BROWSER_RESOURCE",
    );
    if (!baseUrl || !resource)
      return noStore(context.text("Metadata unavailable", 503));
    return noStore(
      context.json({
        resource,
        authorization_servers: [baseUrl],
        scopes_supported: scopes(
          read(context.env, "COMMUNICATOR_PLATFORM_BROWSER_SCOPES") ?? "",
        ),
        resource_documentation: `${new URL(context.req.url).origin}/api/v1/openapi.json`,
      }),
    );
  });
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    async (context, next) => {
      if (!browserConfigurationAvailable(context.env)) return next();
      const baseUrl = read(context.env, "COMMUNICATOR_PLATFORM_BASE_URL");
      const resource = read(
        context.env,
        "COMMUNICATOR_PLATFORM_BROWSER_RESOURCE",
      );
      if (!baseUrl || !resource)
        return noStore(context.text("Metadata unavailable", 503));
      return noStore(
        context.json({
          resource,
          authorization_servers: [baseUrl],
          scopes_supported: scopes(
            read(context.env, "COMMUNICATOR_PLATFORM_BROWSER_SCOPES") ?? "",
          ),
          resource_documentation: `${new URL(context.req.url).origin}/api/v1/openapi.json`,
        }),
      );
    },
  );

  app.get("/.well-known/oauth-authorization-server", async (context, next) => {
    if (!browserConfigurationAvailable(context.env)) return next();
    const baseUrl = read(context.env, "COMMUNICATOR_PLATFORM_BASE_URL");
    const scopesValue = read(
      context.env,
      "COMMUNICATOR_PLATFORM_BROWSER_SCOPES",
    );
    if (!baseUrl || !scopesValue) {
      return noStore(context.text("Metadata unavailable", 503));
    }
    return noStore(
      context.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/api/auth/oauth2/authorize`,
        token_endpoint: `${baseUrl}/api/auth/oauth2/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: scopes(scopesValue),
      }),
    );
  });
}
