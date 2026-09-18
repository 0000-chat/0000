import {
  parseAuthenticationResult,
  parsePrincipal,
  type AuthenticationResult,
  type AuthenticationWireResult,
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

export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  const request = options.fetch ?? fetch;
  const authenticate = async (presentedCredential: string): Promise<AuthenticationResult> => {
    if (!presentedCredential) return { status: "invalid_credential" };

    let response: Response;
    try {
      response = await request(new URL("/internal/v1/authenticate", options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.serviceVerifier}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ credential: presentedCredential }),
      });
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
    if (parsed.status === "invalid_credential") return { status: "authority_unavailable" };
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
