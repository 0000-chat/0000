import { SignJWT } from "jose";

export const oidcConfig = {
  issuer: "https://issuer.example/",
  audience: "communicator-api",
  jwks_url: "https://issuer.example/.well-known/jwks.json",
};

export type TestTokenClaims = {
  issuer?: string;
  audience?: string;
  subject?: string | null;
  token_id?: string;
  expiration_time?: number;
  issued_at?: number;
  kid?: string;
};

export async function signTestToken(
  privateKey: CryptoKey,
  claims: TestTokenClaims = {},
): Promise<string> {
  const token = new SignJWT({
    ...(claims.subject == null ? {} : { sub: claims.subject }),
    ...(claims.token_id === undefined ? {} : { jti: claims.token_id }),
  })
    .setProtectedHeader({ alg: "ES256", kid: claims.kid ?? "local-key" })
    .setIssuer(claims.issuer ?? oidcConfig.issuer)
    .setAudience(claims.audience ?? oidcConfig.audience)
    .setIssuedAt(claims.issued_at)
    .setExpirationTime(claims.expiration_time ?? "1h");

  return token.sign(privateKey);
}
