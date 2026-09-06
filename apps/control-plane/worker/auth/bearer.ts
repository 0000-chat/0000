export class AuthenticationError extends Error {}

export function parseBearerToken(header: string | undefined): string {
  if (!header) throw new AuthenticationError("missing bearer token");
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match?.[1]) throw new AuthenticationError("invalid bearer token");
  return match[1];
}
