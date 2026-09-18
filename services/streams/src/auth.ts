type AccessClaims = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
};

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

export async function authorizeAccess(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
  try {
    const header = decodeJson<{ alg?: string; kid?: string }>(encodedHeader);
    const claims = decodeJson<AccessClaims>(encodedPayload);
    if (
      header.alg !== "RS256" ||
      !header.kid ||
      !claims.exp ||
      claims.exp <= Date.now() / 1000
    )
      return false;
    const issuer = `https://${env.ACCESS_TEAM_NAME}.cloudflareaccess.com`;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== issuer ||
      !audience.includes(env.ACCESS_AUD) ||
      claims.email?.toLowerCase() !== env.DON_EMAIL.toLowerCase()
    )
      return false;
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!response.ok) return false;
    const { keys } = await response.json<{
      keys: Array<JsonWebKey & { kid?: string }>;
    }>();
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = decodeBase64Url(encodedSignature).slice().buffer;
    const signed = new TextEncoder()
      .encode(`${encodedHeader}.${encodedPayload}`)
      .slice().buffer;
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  } catch {
    return false;
  }
}

export function authorizeMcp(request: Request, env: Env): boolean {
  const authorization = request.headers.get("Authorization");
  return authorization === `Bearer ${env.MCP_AUTH_TOKEN}`;
}
