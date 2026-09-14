import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
} from "jose";
import type { OAuthRuntimeConfig } from "./tokens";

export type VerifiedOAuthHuman = {
  issuer: string;
  subject: string;
};

export type OAuthUpstreamExchangeInput = {
  request: Request;
  env: Cloudflare.Env;
  authorizationCode: string;
  verifier: string;
  nonce: string;
  clientId: string;
  redirectUri: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const requiredUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * Complete the separate upstream OIDC client exchange used by Communicator's
 * browser login. The client verifier is sent to the upstream token endpoint;
 * only the upstream transaction's encrypted verifier is retained locally.
 */
export async function completeConfiguredOAuthUpstreamLogin(
  input: OAuthUpstreamExchangeInput,
  config: OAuthRuntimeConfig,
  fetcher: typeof fetch = fetch,
  currentDate = new Date(),
): Promise<VerifiedOAuthHuman | null> {
  const tokenUrl = requiredUrl(config.humanTokenUrl);
  const jwksUrl = requiredUrl(config.humanJwksUrl);
  if (!tokenUrl || !jwksUrl || !config.humanIssuer || !config.humanClientId) {
    return null;
  }
  const audience = config.humanAudience ?? config.humanClientId;

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    client_id: config.humanClientId,
    redirect_uri: config.humanRedirectUri ?? input.redirectUri,
    code_verifier: input.verifier,
  });
  if (config.humanClientSecret) {
    form.set("client_secret", config.humanClientSecret);
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher(tokenUrl.href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      // Workerd supports manual redirects. Reject the response below so a
      // credential-bearing token request is never followed to another host.
      redirect: "manual",
    });
  } catch {
    return null;
  }
  if (tokenResponse.status < 200 || tokenResponse.status >= 300) return null;

  let tokenBody: Record<string, unknown> | null;
  try {
    tokenBody = asRecord(await tokenResponse.json());
  } catch {
    return null;
  }
  const idToken = tokenBody?.id_token;
  if (typeof idToken !== "string" || idToken.length === 0) return null;

  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    const jwksFetcher: FetchImplementation = (url, options) =>
      fetcher(url, {
        method: options.method,
        headers: options.headers,
        redirect: options.redirect,
        signal: options.signal,
      });
    const keys = createRemoteJWKSet(jwksUrl, {
      [customFetch]: jwksFetcher,
    });
    verified = await jwtVerify(idToken, keys, {
      issuer: config.humanIssuer,
      audience,
      algorithms: ["ES256", "RS256"],
      requiredClaims: ["exp", "iat", "iss", "aud", "sub", "nonce"],
      currentDate,
    });
  } catch {
    return null;
  }

  if (verified.payload.nonce !== input.nonce) return null;
  const subject = verified.payload.sub;
  const issuer = verified.payload.iss;
  if (typeof subject !== "string" || subject.length === 0) return null;
  if (typeof issuer !== "string" || issuer.length === 0) return null;
  try {
    return { issuer: new URL(issuer).href, subject };
  } catch {
    return null;
  }
}
