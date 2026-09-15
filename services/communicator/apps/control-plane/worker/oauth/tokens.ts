import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { TokenVerifier, VerifiedSubject } from "../auth/oidc";
import { OidcVerificationError } from "../auth/oidc";

export type OAuthRuntimeConfig = {
  issuer: string;
  resource: string;
  signingSecret: string;
  accessTokenTtlSeconds: number;
  humanAuthorizeUrl?: string;
  humanClientId?: string;
  humanRedirectUri?: string;
  humanScope?: string;
  humanTokenUrl?: string;
  humanIssuer?: string;
  humanJwksUrl?: string;
  humanAudience?: string;
  humanClientSecret?: string;
};

const asRecord = (env: Cloudflare.Env): Record<string, unknown> =>
  env as unknown as Record<string, unknown>;

export function getOAuthRuntimeConfig(env: Cloudflare.Env): OAuthRuntimeConfig {
  const values = asRecord(env);
  const issuer = values.COMMUNICATOR_OAUTH_ISSUER;
  const resource = values.COMMUNICATOR_OAUTH_RESOURCE;
  const signingSecret = values.COMMUNICATOR_OAUTH_SIGNING_SECRET;
  if (
    typeof issuer !== "string" ||
    typeof resource !== "string" ||
    typeof signingSecret !== "string" ||
    issuer.length === 0 ||
    resource.length === 0 ||
    signingSecret.length < 32
  ) {
    throw new Error(
      "OAuth configuration requires COMMUNICATOR_OAUTH_ISSUER, COMMUNICATOR_OAUTH_RESOURCE, and a 32-character COMMUNICATOR_OAUTH_SIGNING_SECRET",
    );
  }
  try {
    new URL(issuer);
    new URL(resource);
  } catch {
    throw new Error("OAuth issuer and resource must be absolute URLs");
  }
  const configuredTtl = values.COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS;
  const accessTokenTtlSeconds =
    typeof configuredTtl === "string" && /^\d+$/.test(configuredTtl)
      ? Math.min(Math.max(Number(configuredTtl), 60), 3600)
      : 900;
  const humanAuthorizeUrl = values.COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL;
  const humanClientId = values.COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID;
  const humanRedirectUri = values.COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI;
  const humanScope = values.COMMUNICATOR_OAUTH_HUMAN_SCOPE;
  const humanTokenUrl = values.COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL;
  const humanIssuer = values.COMMUNICATOR_OAUTH_HUMAN_ISSUER;
  const humanJwksUrl = values.COMMUNICATOR_OAUTH_HUMAN_JWKS_URL;
  const humanAudience = values.COMMUNICATOR_OAUTH_HUMAN_AUDIENCE;
  const humanClientSecret = values.COMMUNICATOR_OAUTH_HUMAN_CLIENT_SECRET;
  return {
    issuer,
    resource,
    signingSecret,
    accessTokenTtlSeconds,
    ...(typeof humanAuthorizeUrl === "string" && humanAuthorizeUrl.length > 0
      ? { humanAuthorizeUrl }
      : {}),
    ...(typeof humanClientId === "string" && humanClientId.length > 0
      ? { humanClientId }
      : {}),
    ...(typeof humanRedirectUri === "string" && humanRedirectUri.length > 0
      ? { humanRedirectUri }
      : {}),
    ...(typeof humanScope === "string" && humanScope.length > 0
      ? { humanScope }
      : {}),
    ...(typeof humanTokenUrl === "string" && humanTokenUrl.length > 0
      ? { humanTokenUrl }
      : {}),
    ...(typeof humanIssuer === "string" && humanIssuer.length > 0
      ? { humanIssuer }
      : {}),
    ...(typeof humanJwksUrl === "string" && humanJwksUrl.length > 0
      ? { humanJwksUrl }
      : {}),
    ...(typeof humanAudience === "string" && humanAudience.length > 0
      ? { humanAudience }
      : {}),
    ...(typeof humanClientSecret === "string" && humanClientSecret.length > 0
      ? { humanClientSecret }
      : {}),
  };
}

const secretBytes = (secret: string): Uint8Array =>
  new TextEncoder().encode(secret);

export type OAuthAccessTokenClaims = {
  installationId: string;
  clientId: string;
  subject: string;
  scope: string;
  issuer: string;
  resource: string;
  tokenId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export async function signOAuthAccessToken(
  config: OAuthRuntimeConfig,
  claims: OAuthAccessTokenClaims,
): Promise<string> {
  const issuedAt = Math.floor(claims.issuedAt.getTime() / 1000);
  const expiresAt = Math.floor(claims.expiresAt.getTime() / 1000);
  return new SignJWT({
    installation_id: claims.installationId,
    client_id: claims.clientId,
    resource: claims.resource,
    scope: claims.scope,
    typ: "access_token",
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(claims.issuer)
    .setSubject(claims.subject)
    .setAudience(claims.resource)
    .setJti(claims.tokenId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretBytes(config.signingSecret));
}

const requiredString = (payload: JWTPayload, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OidcVerificationError("invalid");
  }
  return value;
};

export function createOAuthAccessTokenVerifier(
  config: OAuthRuntimeConfig,
  options: { currentDate?: Date } = {},
): TokenVerifier {
  return {
    async verify(token: string): Promise<VerifiedSubject> {
      try {
        const verified = await jwtVerify(
          token,
          secretBytes(config.signingSecret),
          {
            issuer: config.issuer,
            audience: config.resource,
            algorithms: ["HS256"],
            ...(options.currentDate === undefined
              ? {}
              : { currentDate: options.currentDate }),
          },
        );
        const payload = verified.payload;
        const subject = requiredString(payload, "sub");
        const tokenId = requiredString(payload, "jti");
        const installationId = requiredString(payload, "installation_id");
        const clientId = requiredString(payload, "client_id");
        const resource = requiredString(payload, "resource");
        const scope = requiredString(payload, "scope");
        if (
          resource !== config.resource ||
          !scope.split(" ").includes("communicator.read")
        ) {
          throw new OidcVerificationError("invalid");
        }
        return {
          issuer: config.issuer,
          subject,
          token_id: tokenId,
          installation_id: installationId,
          client_id: clientId,
          resource,
          scope: scope.split(" ").filter(Boolean),
        };
      } catch (error) {
        if (error instanceof OidcVerificationError) throw error;
        throw new OidcVerificationError("invalid", error);
      }
    },
  };
}
