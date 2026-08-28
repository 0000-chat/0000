import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

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

export type TokenVerifier = {
  verify(token: string): Promise<VerifiedSubject>;
};

export function createOidcVerifier(
  config: OidcConfig,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwks_url)),
): TokenVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["ES256", "RS256"],
      });
      if (!payload.iss || !payload.sub) {
        throw new Error("verified token lacks required subject claims");
      }
      return {
        issuer: new URL(payload.iss).href,
        subject: payload.sub,
        ...(payload.jti ? { token_id: payload.jti } : {}),
      };
    },
  };
}
