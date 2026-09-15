import type { OidcConfig } from "../auth/oidc";

/** Maximum lifetime of a signed ingestion credential. */
export const INGESTION_TOKEN_MAX_TTL_SECONDS = 300 as const;

/** Clock skew allowed only when comparing NumericDate claims. */
export const INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS = 30 as const;

/**
 * Wrangler generates literal types for committed vars (the default is
 * "false"). Widen the value at this boundary before checking the runtime
 * switch so the check remains valid for an environment that is explicitly
 * enabled later.
 */
export function isIngressEnabled(value: unknown): boolean {
  return typeof value === "string" && value === "true";
}

export type IngestionOidcEnvironment = Pick<
  Cloudflare.Env,
  | "COMMUNICATOR_INGESTION_OIDC_ISSUER"
  | "COMMUNICATOR_INGESTION_OIDC_AUDIENCE"
  | "COMMUNICATOR_INGESTION_OIDC_JWKS_URL"
>;

/** Build the ingestion-only verifier configuration from ingestion vars. */
export function getIngestionOidcConfig(
  env: IngestionOidcEnvironment,
): OidcConfig {
  return {
    issuer: env.COMMUNICATOR_INGESTION_OIDC_ISSUER,
    audience: env.COMMUNICATOR_INGESTION_OIDC_AUDIENCE,
    jwks_url: env.COMMUNICATOR_INGESTION_OIDC_JWKS_URL,
  };
}
