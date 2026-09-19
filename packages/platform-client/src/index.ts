import {
  parseGuestCreateResult,
  parseGuestGrantResult,
  parseGuestResolveResult,
  parseAuthenticationResult,
  parsePrincipal,
  type AuthenticationResult,
  type AuthenticationWireResult,
  type GuestCreateResult,
  type GuestGrantAssertion,
  type GuestGrantResult,
  type GuestResolveResult,
} from "@0000/contracts";

export interface PlatformClientOptions {
  baseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  fetch?: typeof fetch;
  /** Request deadline in milliseconds. Accepted range: 1..60000. */
  timeoutMs?: number;
}

export interface PlatformClient {
  authenticate(presentedCredential: string): Promise<AuthenticationResult>;
}

export interface PlatformGuestClientOptions {
  baseUrl: string;
  authority: string;
  audience: string;
  guestGrantIssuer: string;
  fetch?: typeof fetch;
  /** Request deadline in milliseconds. Accepted range: 1..60000. */
  timeoutMs?: number;
}

export interface GuestGrantInput {
  bootstrapCredential: string;
  resourceId: string;
  capabilities: string[];
  assertion: GuestGrantAssertion;
}

export interface GuestRenewInput extends GuestGrantInput {
  grantId: string;
}

export interface PlatformGuestClient {
  createGuest(): Promise<GuestCreateResult>;
  resolveGuestControl(bootstrapCredential: string): Promise<GuestResolveResult>;
  attestGuestGrant(input: GuestGrantInput): Promise<GuestGrantResult>;
  renewGuestGrant(input: GuestRenewInput): Promise<GuestGrantResult>;
  revokeGuestGrant(
    grantId: string,
  ): Promise<
    | { status: "success"; revoked: true }
    | { status: "grant_denied" }
    | { status: "authority_unavailable" }
  >;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

type JsonTransportResult =
  | { response: Response; value: unknown }
  | { response: null; value: null };

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function unexpectedRedirect(response: Response, endpoint: URL): boolean {
  if (response.type === "opaqueredirect") return true;
  if (response.status >= 300 && response.status < 400) return true;
  if (response.redirected) return true;
  if (!response.url) return false;
  try {
    return new URL(response.url).origin !== endpoint.origin;
  } catch {
    return true;
  }
}

function createJsonTransport(
  request: typeof fetch,
  timeoutMs: number,
): (url: URL, init: RequestInit) => Promise<JsonTransportResult> {
  return (url, init) => {
    const controller =
      typeof AbortController === "undefined" ? null : new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    return new Promise<JsonTransportResult>((resolve) => {
      const complete = (result: JsonTransportResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      const expire = (): void => {
        if (settled) return;
        timedOut = true;
        try {
          controller?.abort();
        } catch {
          // Some injected transports expose an AbortController-like object
          // that can throw while aborting. The deadline still applies.
        }
        complete({ response: null, value: null });
      };

      const expired = (): boolean => timedOut || Date.now() >= deadline;

      timer = setTimeout(expire, timeoutMs);

      const run = async (): Promise<void> => {
        try {
          const response = await request(url, {
            ...init,
            // Cloudflare's edge fetch does not implement redirect:error.
            // Manual mode still prevents forwarding the request, and every
            // redirect response is rejected before its body is trusted.
            redirect: "manual",
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (expired()) {
            expire();
            return;
          }
          if (unexpectedRedirect(response, url)) {
            complete({ response: null, value: null });
            return;
          }
          const value = await response.json();
          if (expired()) {
            expire();
            return;
          }
          complete({ response, value });
        } catch {
          if (expired()) expire();
          else complete({ response: null, value: null });
        }
      };

      // Keep the operation observed after a timeout. A transport or body
      // parser may ignore abort and reject after the caller has completed.
      void run().catch(() => {
        if (expired()) expire();
        else complete({ response: null, value: null });
      });
    });
  };
}

export function createPlatformClient(
  options: PlatformClientOptions,
): PlatformClient {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const request = options.fetch ?? fetch;
  const transport = createJsonTransport(request, timeoutMs);
  const authenticate = async (
    presentedCredential: string,
  ): Promise<AuthenticationResult> => {
    if (!presentedCredential) return { status: "invalid_credential" };

    const result = await transport(
      new URL("/internal/v1/authenticate", options.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.serviceVerifier}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ credential: presentedCredential }),
      },
    );
    if (!result.response) return { status: "authority_unavailable" };

    const response = result.response;
    if (response.status >= 500) return { status: "authority_unavailable" };

    const parsed: AuthenticationWireResult | null =
      parseAuthenticationResult(result.value);
    if (!parsed) return { status: "authority_unavailable" };
    if (response.status === 401) {
      return parsed.status === "invalid_credential"
        ? { status: "invalid_credential" }
        : { status: "authority_unavailable" };
    }
    if (!response.ok) return { status: "authority_unavailable" };
    if (parsed.status === "invalid_credential")
      return { status: "authority_unavailable" };
    if (parsed.status !== "authenticated") return parsed;

    const principal = parsePrincipal(parsed.principal, {
      authority: options.authority,
      audience: options.audience,
    });
    return principal
      ? { status: "authenticated", principal }
      : { status: "authority_unavailable" };
  };

  return { authenticate };
}

function unavailable<T>(): T {
  return { status: "authority_unavailable" } as T;
}

export function createPlatformGuestClient(
  options: PlatformGuestClientOptions,
): PlatformGuestClient {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const request = options.fetch ?? fetch;
  const transport = createJsonTransport(request, timeoutMs);

  async function post(
    path: string,
    body?: unknown,
  ): Promise<JsonTransportResult> {
    return transport(new URL(path, options.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.guestGrantIssuer}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function statusFailure(
    response: Response,
    value: unknown,
  ): {
    status:
      | "invalid_guest_control"
      | "grant_denied"
      | "conflict"
      | "authority_unavailable";
  } {
    if (response.status >= 500) return { status: "authority_unavailable" };
    if (response.status === 401 && isStatus(value, "invalid_guest_control")) {
      return { status: "invalid_guest_control" };
    }
    if (response.status === 403 && isStatus(value, "grant_denied")) {
      return { status: "grant_denied" };
    }
    if (response.status === 409 && isStatus(value, "conflict")) {
      return { status: "conflict" };
    }
    return { status: "authority_unavailable" };
  }

  function isStatus(value: unknown, status: string): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { status?: unknown }).status === status
    );
  }

  async function grant(
    path: string,
    body: GuestGrantInput | GuestRenewInput,
  ): Promise<GuestGrantResult> {
    const result = await post(path, body);
    if (!result.response) return unavailable<GuestGrantResult>();
    if (!result.response.ok)
      return statusFailure(result.response, result.value);
    const parsed = parseGuestGrantResult(result.value, {
      authority: options.authority,
      audience: options.audience,
    });
    return parsed && parsed.status === "success"
      ? parsed
      : unavailable<GuestGrantResult>();
  }

  return {
    async createGuest(): Promise<GuestCreateResult> {
      const result = await post("/internal/v1/guests");
      if (!result.response) return unavailable<GuestCreateResult>();
      if (!result.response.ok)
        return statusFailure(result.response, result.value);
      const parsed = parseGuestCreateResult(result.value, {
        authority: options.authority,
        audience: options.audience,
      });
      return parsed && parsed.status === "success"
        ? parsed
        : unavailable<GuestCreateResult>();
    },
    async resolveGuestControl(
      bootstrapCredential: string,
    ): Promise<GuestResolveResult> {
      if (!bootstrapCredential) return { status: "invalid_guest_control" };
      const result = await post("/internal/v1/guests/resolve", {
        bootstrapCredential,
      });
      if (!result.response) return unavailable<GuestResolveResult>();
      if (!result.response.ok)
        return statusFailure(result.response, result.value);
      const parsed = parseGuestResolveResult(result.value, {
        authority: options.authority,
        audience: options.audience,
      });
      return parsed && parsed.status === "success"
        ? parsed
        : unavailable<GuestResolveResult>();
    },
    attestGuestGrant(input: GuestGrantInput): Promise<GuestGrantResult> {
      return grant("/internal/v1/guest-grants", input);
    },
    renewGuestGrant(input: GuestRenewInput): Promise<GuestGrantResult> {
      return grant(
        `/internal/v1/guest-grants/${encodeURIComponent(input.grantId)}/renew`,
        input,
      );
    },
    async revokeGuestGrant(grantId: string) {
      if (!grantId) return { status: "grant_denied" as const };
      const result = await post(
        `/internal/v1/guest-grants/${encodeURIComponent(grantId)}/revoke`,
      );
      if (!result.response) return { status: "authority_unavailable" as const };
      if (!result.response.ok) {
        const failure = statusFailure(result.response, result.value);
        return failure.status === "grant_denied"
          ? { status: "grant_denied" as const }
          : { status: "authority_unavailable" as const };
      }
      if (
        typeof result.value === "object" &&
        result.value !== null &&
        !Array.isArray(result.value) &&
        (result.value as { status?: unknown }).status === "success" &&
        (result.value as { revoked?: unknown }).revoked === true
      ) {
        return { status: "success" as const, revoked: true as const };
      }
      return { status: "authority_unavailable" as const };
    },
  };
}
