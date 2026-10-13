import {
  createPlatformClient,
  type PlatformClient,
} from "@0000/platform-client";
import type { AuthenticatedPrincipal } from "@0000/contracts";

/**
 * The only production credential verifier used by Communicator.  Platform is
 * the authority for credential validity; this service only supplies its
 * service verifier and then applies its own immutable binding and resource
 * ACLs.
 */
export type PlatformAuthenticator = {
  authenticate(credential: string): Promise<PlatformAuthentication>;
};

export type PlatformAuthentication =
  | {
      status: "authenticated";
      principal: Exclude<AuthenticatedPrincipal, { kind: "guest" }>;
    }
  | { status: "invalid_credential" }
  | { status: "authority_unavailable" };

export type PlatformRuntimeConfig = {
  baseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
};

type PlatformEnv = Record<string, unknown>;

const value = (env: Cloudflare.Env, key: string): string | undefined => {
  const candidate = (env as unknown as PlatformEnv)[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

export function getPlatformRuntimeConfig(
  env: Cloudflare.Env,
): PlatformRuntimeConfig | null {
  const baseUrl = value(env, "COMMUNICATOR_PLATFORM_BASE_URL");
  const authority = value(env, "COMMUNICATOR_PLATFORM_AUTHORITY");
  const audience = value(env, "COMMUNICATOR_PLATFORM_AUDIENCE");
  const serviceVerifier = value(env, "COMMUNICATOR_PLATFORM_SERVICE_VERIFIER");
  if (!baseUrl || !authority || !audience || !serviceVerifier) return null;
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) return null;
  } catch {
    return null;
  }
  return { baseUrl, authority, audience, serviceVerifier };
}

const nonGuest = (
  principal: AuthenticatedPrincipal,
): Exclude<AuthenticatedPrincipal, { kind: "guest" }> | null =>
  principal.kind === "guest" ? null : principal;

/** Create the configured production Platform verifier. */
export function createPlatformAuthenticator(
  env: Cloudflare.Env,
  fetcher: typeof fetch = fetch,
): PlatformAuthenticator | null {
  const config = getPlatformRuntimeConfig(env);
  if (!config) return null;
  let client: PlatformClient;
  try {
    client = createPlatformClient({ ...config, fetch: fetcher });
  } catch {
    return null;
  }
  return {
    async authenticate(credential: string): Promise<PlatformAuthentication> {
      const result = await client.authenticate(credential);
      if (result.status !== "authenticated") return result;
      const principal = nonGuest(result.principal);
      return principal
        ? { status: "authenticated", principal }
        : { status: "invalid_credential" };
    },
  };
}

/**
 * Build a configured client for a Durable Object's current revalidation.
 * Returning null is deliberate: callers fail closed when current authority
 * configuration is unavailable.
 */
export function createPlatformClientForRevalidation(
  env: Cloudflare.Env,
  fetcher: typeof fetch = fetch,
): PlatformClient | null {
  const config = getPlatformRuntimeConfig(env);
  if (!config) return null;
  try {
    return createPlatformClient({ ...config, fetch: fetcher });
  } catch {
    return null;
  }
}
