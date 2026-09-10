export class AuthenticationError extends Error {}

export const MAX_AUTH_TOKEN_CHARS = 4_096;

export function parseBearerToken(header: string | undefined): string {
  if (!header) throw new AuthenticationError("missing bearer token");
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match?.[1]) throw new AuthenticationError("invalid bearer token");
  if (match[1].length > MAX_AUTH_TOKEN_CHARS) {
    throw new AuthenticationError("invalid bearer token");
  }
  return match[1];
}

export function parseAccessAssertion(assertion: string | undefined): string {
  if (!assertion) throw new AuthenticationError("missing Access assertion");
  if (assertion.length > MAX_AUTH_TOKEN_CHARS) {
    throw new AuthenticationError("invalid Access assertion");
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) {
    throw new AuthenticationError("invalid Access assertion");
  }
  return assertion;
}
