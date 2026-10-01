import {
  copyPlatformRequestCorrelation,
  emitPlatformDiagnostic,
} from "./diagnostics";
import {
  PLATFORM_RATE_LIMIT_BINDING_NAMES,
  resolvePlatformRateLimitPolicy,
  type PlatformRateLimitGroup,
} from "./rate-limit-policy";

export const PLATFORM_DEFAULT_SERVER_DEADLINE_MS = 8_000;
export const PLATFORM_MAX_SERVER_DEADLINE_MS = 30_000;
export const PLATFORM_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export type PlatformProtectedRouteGroup = PlatformRateLimitGroup;

interface PlatformRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

type PlatformRateLimitBindingName =
  (typeof PLATFORM_RATE_LIMIT_BINDING_NAMES)[PlatformProtectedRouteGroup];

export type PlatformSafeguardEnv = Omit<
  Cloudflare.Env,
  | "PLATFORM_RATE_LIMIT_POLICY"
  | "PLATFORM_SERVER_DEADLINE_MS"
  | PlatformRateLimitBindingName
> & {
  PLATFORM_RATE_LIMIT_POLICY?: string;
  PLATFORM_SERVER_DEADLINE_MS?: string;
} & Partial<
    Record<
      (typeof PLATFORM_RATE_LIMIT_BINDING_NAMES)[PlatformProtectedRouteGroup],
      PlatformRateLimitBinding
    >
  >;

type PlatformProtectedHandler = (request: Request) => Promise<Response>;

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export function parsePlatformServerDeadlineMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return PLATFORM_DEFAULT_SERVER_DEADLINE_MS;
  }
  const serialized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof serialized !== "string" || !/^\d+$/u.test(serialized)) {
    return null;
  }
  const parsed = Number(serialized);
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= PLATFORM_MAX_SERVER_DEADLINE_MS
    ? parsed
    : null;
}

function isOAuthMetadataPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/api/auth/.well-known/oauth-authorization-server"
  );
}

function isGuestControlPath(pathname: string): boolean {
  return (
    pathname === "/internal/v1/guests" ||
    pathname === "/internal/v1/guests/resolve" ||
    pathname === "/internal/v1/guest-grants" ||
    /^\/internal\/v1\/guest-grants\/[^/]+\/(?:renew|revoke)$/u.test(pathname)
  );
}

/**
 * Classify supported protected endpoints before any body, provider or D1 work.
 * The caller deliberately supplies only the normalized pathname; no request
 * body, client id, guest id, OAuth state or caller correlation participates.
 */
export function classifyPlatformProtectedRoute(
  request: Request,
  pathname: string,
): PlatformProtectedRouteGroup | null {
  if (isOAuthMetadataPath(pathname)) return null;
  if (
    pathname === "/healthz" ||
    pathname === "/account.js" ||
    pathname === "/account.css"
  ) {
    return null;
  }

  if (pathname === "/internal/v1/authenticate" && request.method === "POST") {
    return "verification";
  }
  if (isGuestControlPath(pathname) && request.method === "POST") {
    return "guestControl";
  }

  if (
    pathname === "/oauth2/selection" ||
    pathname === "/oauth2/continue" ||
    pathname === "/consent" ||
    pathname === "/api/auth/oauth2/authorize" ||
    pathname === "/api/auth/oauth2/continue" ||
    pathname === "/api/auth/oauth2/consent" ||
    pathname === "/api/auth/oauth2/token" ||
    pathname === "/api/auth/oauth2/revoke"
  ) {
    return "issuance";
  }
  if (
    pathname === "/api/auth/oauth2/introspect" ||
    pathname === "/api/auth/oauth2/userinfo"
  ) {
    return "verification";
  }

  if (
    pathname === "/account" ||
    pathname === "/api/me" ||
    pathname.startsWith("/api/account/") ||
    pathname === "/api/credentials" ||
    pathname.startsWith("/api/credentials/")
  ) {
    return "management";
  }
  if (
    pathname === "/login" ||
    pathname === "/error" ||
    pathname === "/api/auth/error"
  ) {
    return "login";
  }
  if (pathname.startsWith("/api/auth/")) return "login";
  return null;
}

function trustedSourceKey(request: Request): string {
  const source = request.headers.get("cf-connecting-ip")?.trim();
  if (!source || source.length > 256 || /[\u0000-\u001f\u007f]/u.test(source)) {
    return "unknown";
  }
  return source;
}

function unavailableResponse(): Response {
  return json(503, { status: "authority_unavailable" });
}

function rateLimitedResponse(): Response {
  return json(
    429,
    { status: "rate_limited" },
    { "retry-after": String(PLATFORM_RATE_LIMIT_RETRY_AFTER_SECONDS) },
  );
}

function timeoutResponse(): Response {
  return unavailableResponse();
}

async function enforcePlatformRateLimit(
  request: Request,
  env: PlatformSafeguardEnv,
  group: PlatformProtectedRouteGroup,
): Promise<Response | null> {
  try {
    resolvePlatformRateLimitPolicy(env.PLATFORM_RATE_LIMIT_POLICY);
    const bindingName = PLATFORM_RATE_LIMIT_BINDING_NAMES[group];
    const binding = env[bindingName];
    if (!binding || typeof binding.limit !== "function") {
      emitPlatformDiagnostic("platform.authentication.outcome", "unavailable", {
        request,
      });
      return unavailableResponse();
    }
    const key = `${group}:${trustedSourceKey(request)}`;
    const outcome = await binding.limit({ key });
    if (!outcome || typeof outcome.success !== "boolean") {
      emitPlatformDiagnostic("platform.authentication.outcome", "unavailable", {
        request,
      });
      return unavailableResponse();
    }
    if (!outcome.success) {
      emitPlatformDiagnostic(
        "platform.authentication.outcome",
        "rate_limited",
        {
          request,
        },
      );
      return rateLimitedResponse();
    }
    return null;
  } catch {
    emitPlatformDiagnostic("platform.authentication.outcome", "unavailable", {
      request,
    });
    return unavailableResponse();
  }
}

async function readCompletedResponse(response: Response): Promise<Response> {
  // Consume a clone so the original response, including Set-Cookie headers,
  // remains available to the caller. This makes the deadline cover body reads
  // without changing Better Auth's protocol response shape.
  await response.clone().arrayBuffer();
  return response;
}

/** Execute a protected request with one deadline covering limiter and body. */
export async function executePlatformProtectedRequest(
  request: Request,
  env: PlatformSafeguardEnv,
  group: PlatformProtectedRouteGroup,
  handler: PlatformProtectedHandler,
): Promise<Response> {
  const deadlineMs = parsePlatformServerDeadlineMs(
    env.PLATFORM_SERVER_DEADLINE_MS,
  );
  if (deadlineMs === null) {
    emitPlatformDiagnostic("platform.authentication.outcome", "unavailable", {
      request,
    });
    return unavailableResponse();
  }

  const controller = new AbortController();
  let controlledRequest: Request;
  try {
    controlledRequest = new Request(request, { signal: controller.signal });
  } catch {
    controlledRequest = request;
  }
  copyPlatformRequestCorrelation(request, controlledRequest);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const work = (async (): Promise<Response> => {
    const limited = await enforcePlatformRateLimit(
      controlledRequest,
      env,
      group,
    );
    if (timedOut || controlledRequest.signal.aborted) return timeoutResponse();
    if (limited) return limited;
    if (timedOut || controlledRequest.signal.aborted) return timeoutResponse();
    return readCompletedResponse(await handler(controlledRequest));
  })();
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      emitPlatformDiagnostic("platform.request.timed_out", "timeout", {
        request,
      });
      resolve(timeoutResponse());
    }, deadlineMs);
  });

  try {
    const response = await Promise.race([work, timeout]);
    if (timedOut) return timeoutResponse();
    return response;
  } catch {
    emitPlatformDiagnostic("platform.authentication.outcome", "unavailable", {
      request,
    });
    return unavailableResponse();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A dependency can ignore AbortSignal and settle after the caller has
    // timed out. Observe that settlement so it cannot become an unhandled
    // rejection or publish a late response.
    void work.catch(() => undefined);
  }
}
