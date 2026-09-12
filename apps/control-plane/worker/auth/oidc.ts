import {
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type FetchImplementation,
  type JWK,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { customFetch, type RemoteJWKSet } from "jose";
import {
  INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS,
  INGESTION_TOKEN_MAX_TTL_SECONDS,
} from "../ingestion/config";

export type VerifiedSubject = {
  issuer: string;
  subject: string;
  token_id?: string;
};

export type OidcConfig = {
  issuer: string;
  audience: string;
  jwks_url: string;
};

export type OidcVerificationFailureCode = "invalid" | "unavailable";

const oidcVerificationCauses = new WeakMap<OidcVerificationError, unknown>();

/**
 * A stable, content-free OIDC verification failure. The original exception is
 * retained in a private weak map for diagnostics and is never serialised.
 */
export class OidcVerificationError extends Error {
  readonly code: OidcVerificationFailureCode;
  readonly classification: OidcVerificationFailureCode;
  readonly kind: OidcVerificationFailureCode;

  constructor(
    code: OidcVerificationFailureCode,
    cause?: unknown,
    message = "OIDC verification failed",
  ) {
    super(message);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "OidcVerificationError",
      writable: true,
    });
    this.code = code;
    this.classification = code;
    this.kind = code;
    if (cause !== undefined) oidcVerificationCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @internal Diagnostic-only access; never include this in a response/log. */
export function getOidcVerificationCause(
  error: OidcVerificationError,
): unknown {
  return oidcVerificationCauses.get(error);
}

export type TokenVerifier = {
  verify(token: string): Promise<VerifiedSubject>;
};

export type OidcVerifierOptions = {
  /** Require the stricter machine-token contract used by Matrix ingestion. */
  requireIngestionClaims?: boolean;
  /** A deterministic clock supplied by tests; production uses the wall clock. */
  currentDate?: Date;
  /** Injectable JWKS transport; production uses the Worker fetch primitive. */
  fetch?: FetchImplementation;
};

type JsonRecord = Record<string, unknown>;

type RemoteKeyState = {
  resolver: RemoteJWKSet;
  usable: boolean;
};

const allowedAlgorithms = ["ES256", "RS256"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "priv"] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function keyAlgorithm(key: JsonRecord): (typeof allowedAlgorithms)[number] | undefined {
  if (key.alg !== undefined && typeof key.alg !== "string") return undefined;
  if (key.alg !== undefined && !allowedAlgorithms.includes(key.alg as (typeof allowedAlgorithms)[number])) {
    return undefined;
  }
  if (key.kty === "EC" && (key.alg === undefined || key.alg === "ES256")) return "ES256";
  if (key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256")) return "RS256";
  return undefined;
}

/** Reject metadata that would make a remote public verification key unsafe. */
function isPotentialPublicVerificationKey(key: unknown): key is JsonRecord {
  if (!isRecord(key)) return false;
  if (typeof key.kty !== "string") return false;
  if (PRIVATE_JWK_MEMBERS.some((member) => Object.hasOwn(key, member))) return false;
  if (key.kid !== undefined && typeof key.kid !== "string") return false;
  if (key.use !== undefined && key.use !== "sig") return false;
  if (key.key_ops !== undefined) {
    if (
      !Array.isArray(key.key_ops) ||
      key.key_ops.length === 0 ||
      new Set(key.key_ops).size !== key.key_ops.length ||
      key.key_ops.some((operation) => operation !== "verify")
    ) {
      return false;
    }
  }

  const algorithm = keyAlgorithm(key);
  if (algorithm === "ES256") {
    return (
      key.crv === "P-256" &&
      typeof key.x === "string" &&
      BASE64URL.test(key.x) &&
      typeof key.y === "string" &&
      BASE64URL.test(key.y)
    );
  }
  if (algorithm === "RS256") {
    return (
      typeof key.n === "string" &&
      BASE64URL.test(key.n) &&
      typeof key.e === "string" &&
      BASE64URL.test(key.e)
    );
  }
  return false;
}

/**
 * Validate a fetched set enough to distinguish a broken key service from a
 * caller presenting an invalid JWT. JOSE verifies the selected key again.
 */
async function validateRemoteJwkSet(jwks: unknown): Promise<boolean> {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    return false;
  }

  const keyIds = new Set<string>();
  let usable = false;
  for (const rawKey of jwks.keys) {
    if (!isPotentialPublicVerificationKey(rawKey)) continue;
    const key = rawKey;
    if (typeof key.kid === "string") {
      if (keyIds.has(key.kid)) return false;
      keyIds.add(key.kid);
    }

    const algorithm = keyAlgorithm(key);
    if (algorithm === undefined) continue;
    try {
      const imported = await importJWK(key as JWK, algorithm, { extractable: false });
      if (!(imported instanceof Uint8Array)) usable = true;
    } catch {
      // A different valid key may still serve this set.
    }
  }
  return usable;
}

function isOidcVerificationError(
  value: unknown,
): value is OidcVerificationError {
  return value instanceof OidcVerificationError;
}

function joseCode(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.code !== "string") return undefined;
  return value.code;
}

function classifyFailure(
  error: unknown,
  remoteState: RemoteKeyState | undefined,
): OidcVerificationFailureCode {
  if (isOidcVerificationError(error)) return error.code;

  const code = joseCode(error);
  if (
    code === "ERR_JWK_INVALID" ||
    code === "ERR_JWKS_INVALID" ||
    code === "ERR_JWKS_TIMEOUT" ||
    code === "ERR_JOSE_GENERIC"
  ) {
    return "unavailable";
  }

  if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS") {
    if (remoteState && !remoteState.usable) return "unavailable";
    return "invalid";
  }

  // The guarded remote transport turns every fetch/parse/JWKS-health failure
  // into a typed unavailable error. Remaining JOSE errors are token failures,
  // even when a remote resolver is present.
  return "invalid";
}

function fail(
  error: unknown,
  remoteState: RemoteKeyState | undefined,
): OidcVerificationError {
  if (isOidcVerificationError(error)) return error;
  return new OidcVerificationError(classifyFailure(error, remoteState), error);
}

function validateVerifierConfig(config: OidcConfig): void {
  if (
    !config ||
    typeof config.issuer !== "string" ||
    config.issuer.length === 0 ||
    typeof config.audience !== "string" ||
    config.audience.length === 0 ||
    typeof config.jwks_url !== "string" ||
    config.jwks_url.length === 0
  ) {
    throw new OidcVerificationError("unavailable");
  }

  try {
    // Validate the URL at verifier construction time. The issuer remains the
    // exact configured string because JOSE performs the issuer comparison.
    new URL(config.jwks_url);
  } catch (error) {
    throw new OidcVerificationError("unavailable", error);
  }
}

function createRemoteResolver(
  config: OidcConfig,
  fetchImplementation?: FetchImplementation,
): RemoteKeyState {
  let remoteState: RemoteKeyState | undefined;
  const fetcher: FetchImplementation = fetchImplementation ?? ((url, options) => fetch(url, options));

  const guardedFetch: FetchImplementation = async (url, options) => {
    let response: Response;
    try {
      response = await fetcher(url, options);
    } catch (error) {
      const failure = new OidcVerificationError("unavailable", error);
      throw failure;
    }

    if (response.status !== 200) {
      const failure = new OidcVerificationError("unavailable");
      throw failure;
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      const failure = new OidcVerificationError("unavailable", error);
      throw failure;
    }
    if (!(await validateRemoteJwkSet(value))) {
      const failure = new OidcVerificationError("unavailable");
      throw failure;
    }
    if (remoteState) remoteState.usable = true;

    // createRemoteJWKSet reads response.json() itself. Return a fresh response
    // containing the already validated JSON and avoid handing it a consumed
    // body.
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const resolver = createRemoteJWKSet(new URL(config.jwks_url), {
      [customFetch]: guardedFetch,
    });
    remoteState = { resolver, usable: false };
    return remoteState;
  } catch (error) {
    throw new OidcVerificationError("unavailable", error);
  }
}

function assertIngestionTemporalClaims(
  payload: JWTPayload,
  currentDate: Date,
): void {
  const now = Math.floor(currentDate.getTime() / 1000);
  const { iat, exp, nbf } = payload;

  if (
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp)
  ) {
    throw new OidcVerificationError("invalid");
  }

  // The guard above establishes the NumericDate types for the arithmetic
  // below, but TypeScript does not narrow both properties through a compound
  // boolean expression.
  const issuedAt = iat as number;
  const expiresAt = exp as number;

  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > INGESTION_TOKEN_MAX_TTL_SECONDS ||
    issuedAt > now + INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS
  ) {
    throw new OidcVerificationError("invalid");
  }

  // JOSE has already checked exp/nbf with the same fixed tolerance. Keep the
  // explicit checks here as a defense-in-depth guarantee and to document that
  // tolerance never changes the signed lifetime calculation above.
  if (expiresAt <= now - INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS) {
    throw new OidcVerificationError("invalid");
  }
  if (
    nbf !== undefined &&
    (!Number.isSafeInteger(nbf) || nbf > now + INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS)
  ) {
    throw new OidcVerificationError("invalid");
  }
}

function resolveOptions(
  keysOrOptions: JWTVerifyGetKey | OidcVerifierOptions | undefined,
  options: OidcVerifierOptions | undefined,
): { keys?: JWTVerifyGetKey; options: OidcVerifierOptions } {
  if (typeof keysOrOptions === "function") {
    return { keys: keysOrOptions, options: options ?? {} };
  }
  return { options: keysOrOptions ?? options ?? {} };
}

export function createOidcVerifier(
  config: OidcConfig,
  keysOrOptions?: JWTVerifyGetKey | OidcVerifierOptions,
  options?: OidcVerifierOptions,
): TokenVerifier {
  validateVerifierConfig(config);
  const resolved = resolveOptions(keysOrOptions, options);
  let remoteState: RemoteKeyState | undefined;
  let keys: JWTVerifyGetKey;
  if (resolved.keys) {
    keys = resolved.keys;
  } else {
    remoteState = createRemoteResolver(config, resolved.options.fetch);
    keys = remoteState.resolver;
  }
  const requireIngestionClaims = resolved.options.requireIngestionClaims === true;
  const currentDate = resolved.options.currentDate;

  return {
    async verify(token) {
      try {
        const result = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: [...allowedAlgorithms],
          ...(requireIngestionClaims
            ? {
                requiredClaims: ["iat", "exp", "sub", "jti"],
                clockTolerance: INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS,
              }
            : {}),
          ...(currentDate === undefined ? {} : { currentDate }),
        });
        const payload = result.payload;

        if (typeof payload.iss !== "string" || typeof payload.sub !== "string" || payload.sub.length === 0) {
          throw new OidcVerificationError(
            "invalid",
            undefined,
            "verified token lacks required subject claims",
          );
        }

        const tokenId = payload.jti;
        if (requireIngestionClaims && (typeof tokenId !== "string" || tokenId.length === 0)) {
          throw new OidcVerificationError("invalid");
        }
        if (requireIngestionClaims) {
          assertIngestionTemporalClaims(payload, currentDate ?? new Date());
        }

        return {
          issuer: new URL(payload.iss).href,
          subject: payload.sub,
          ...(typeof tokenId === "string" && tokenId.length > 0
            ? { token_id: tokenId }
            : {}),
        };
      } catch (error) {
        throw fail(error, remoteState);
      }
    },
  };
}
