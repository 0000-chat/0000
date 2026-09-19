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

export function createPlatformClient(
  options: PlatformClientOptions,
): PlatformClient {
  const request = options.fetch ?? fetch;
  const authenticate = async (
    presentedCredential: string,
  ): Promise<AuthenticationResult> => {
    if (!presentedCredential) return { status: "invalid_credential" };

    let response: Response;
    try {
      response = await request(
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
    } catch {
      return { status: "authority_unavailable" };
    }

    if (response.status >= 500) return { status: "authority_unavailable" };

    let parsed: AuthenticationWireResult | null;
    try {
      parsed = parseAuthenticationResult(await response.json());
    } catch {
      return { status: "authority_unavailable" };
    }
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
  const request = options.fetch ?? fetch;

  async function post(
    path: string,
    body?: unknown,
  ): Promise<
    { response: Response; value: unknown } | { response: null; value: null }
  > {
    try {
      const response = await request(new URL(path, options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.guestGrantIssuer}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return { response: null, value: null };
      }
      return { response, value };
    } catch {
      return { response: null, value: null };
    }
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
